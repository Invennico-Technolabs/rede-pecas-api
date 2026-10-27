import { Request, Response } from 'express';
import { logger } from '../config/logger.js';
import * as customerService from '../services/customer.service.js';
import * as vehicleService from '../services/vehicle.service.js';
import * as productService from '../services/product.service.js';
import * as orderProfileService from '../services/orderProfile.service.js';
import * as orderStatusService from '../services/orderStatus.service.js';
import * as paymentService from '../services/payment.service.js';
import * as sessionService from '../services/session.service.js';
import { sendReply, sendReplyButtons } from '../services/reply.service.js';
import { sendWhatsAppButtons, sendTypingIndicator, sendWhatsAppMessage } from '../services/whatsapp.service.js';
import { getAdminByPhone, getAllAdmins } from '../models/adminUser.model.js';
import { config } from '../config/config.js';
import { GREETING_PATTERN, isCourtesyMessage, isBareReply } from '../utils/greeting.js';
import { extractProductNames } from '../services/ai.service.js';
import { extractBoldTerms } from '../services/humanize.service.js';
import { runSerialized } from '../utils/keyedQueue.js';

const HUMAN_HANDOFF_PATTERN = /\b(atendente|humano|falar com (algu[eé]m|pessoa)|operador|suporte humano|human|agent|representative)\b/i;

const ORDER_STATUS_PATTERN = /\b(estado do (meu )?pedido|onde est[áa] (o meu )?pedido|order status|where('?s| is) my order)\b/i;

/**
 * Backs the GET webhook verification handshake required by Meta — echoes back
 * the challenge string if the request's verify token matches the configured one, otherwise responds 403.
 */
export async function verifyWebhook(req: Request, res: Response): Promise<void> {
  const verifyToken = config.whatsapp.verifyToken;
  if (
    req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === verifyToken
  ) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
}

/**
 * Backs the POST webhook message intake — responds 200 to Meta immediately
 * (its 5-second rule), then extracts the inbound message's text/media/button/list-reply fields and hands them off to `processMessageFlow` asynchronously.
 */
export async function receiveWebhookMessage(req: Request, res: Response): Promise<void> {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const msg = change?.value?.messages?.[0];
    if (!msg) return;

    // Meta can deliver the same message more than once (retries on a slow
    // ack, occasional duplicates) — running the state machine twice would
    // double-advance flows and send duplicate replies.
    if (!(await sessionService.claimInboundMessage(msg.id))) {
      logger.info(`[${msg.from}] Duplicate webhook delivery for message ${msg.id} — ignored`);
      return;
    }

    await sendTypingIndicator(msg.id);

    const phone = msg.from;
    const customerText =
      msg.type === 'text' ? msg.text?.body :
      msg.type === 'interactive' ? (msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title) :
      msg.type === 'button' ? msg.button?.text :
      null;
    const listReplyId: string | null = msg.type === 'interactive' ? (msg.interactive?.list_reply?.id || null) : null;
    const buttonReplyId: string | null = msg.type === 'interactive' ? (msg.interactive?.button_reply?.id || null) : null;
    const contextMessageId: string | null = msg.context?.id || null;
    const mediaType = msg.type;
    const mediaId = msg.image?.id || msg.document?.id || null;
    // A shared WhatsApp location (📍) — the delivery address step asks for one.
    const location: orderProfileService.SharedLocation | null =
      msg.type === 'location' && typeof msg.location?.latitude === 'number' && typeof msg.location?.longitude === 'number'
        ? { latitude: msg.location.latitude, longitude: msg.location.longitude, name: msg.location.name ?? null, address: msg.location.address ?? null }
        : null;

    logger.info(`[${phone}] Webhook type: ${mediaType}, text: ${customerText}`);

    // One customer's messages are processed strictly in arrival order —
    // concurrent runs would race on the same session/order state.
    await runSerialized(phone, () =>
      processMessageFlow(phone, customerText, mediaType, mediaId, listReplyId, buttonReplyId, contextMessageId, location)
    );
  } catch (error: any) {
    logger.error('Error in WhatsApp webhook processing', error);
  }
}

/**
 * Routes a single inbound WhatsApp message through the full conversation pipeline
 * — admin short-circuit, locale detection, registration/vehicle-ID state machines, payment flow, product search,
 * and human handoff — in strict priority order, stopping at whichever stage handles the message first.
 */
async function processMessageFlow(
  phone: string,
  customerText: string | null,
  mediaType: string,
  mediaId: string | null,
  listReplyId: string | null = null,
  buttonReplyId: string | null = null,
  contextMessageId: string | null = null,
  location: orderProfileService.SharedLocation | null = null
): Promise<void> {
  const admin = await getAdminByPhone(phone);
  if (admin) {
    logger.info(`[ADMIN] Inbound message from admin ${phone} (${admin.name}) routed to admin handler, buttonReplyId=${buttonReplyId}`);
    // The entire admin reply surface is button-driven (stock confirm/
    // unavailable, payment approve/reject, item stock) — there's no
    // free-text admin flow. Without this guard, any plain message an admin
    // sends (e.g. testing with "hi", no pending order at all) fell through
    // to processAdminStockReply's default branch and got the confusing
    // "use the buttons on the stock-confirmation message" nudge regardless
    // of whether one was ever sent.
    if (!buttonReplyId) return;

    if (buttonReplyId.startsWith('admin_approve_payment_') || buttonReplyId.startsWith('admin_reject_payment_')) {
      await paymentService.processAdminPaymentReply(phone, buttonReplyId);
    } else if (buttonReplyId.startsWith('admin_item_')) {
      await productService.processAdminItemStockReply(phone, buttonReplyId);
    } else {
      await productService.processAdminStockReply(phone, buttonReplyId);
    }
    return;
  }

  // No language detection from message text — the conversation stays in
  // Angolan Portuguese unless the customer explicitly picks English (🌐
  // option, routed below). See customerService.resolveLocale.
  if (customerText) {
    await sessionService.saveLastMessage(phone, customerText);
  }

  const chatLogText = customerText || (mediaId ? `[${mediaType}]` : null);
  if (chatLogText) {
    await sessionService.appendChatMessage(phone, 'in', chatLogText);
  }

  const customer = await customerService.getOrCreateCustomer(phone);
  if (!customer) return;

  const messages = await customerService.resolveMessages(phone);

  if (customer.active === false) {
    await sendReply(phone, messages.common.accountInactive());
    if (await sessionService.claimInactiveCustomerAlert(phone)) {
      const admins = await getAllAdmins();
      const custName = customer.name || 'Cliente';
      for (const admin of admins) {
        await sendWhatsAppMessage(admin.phone, messages.admin.inactiveCustomerAttempt(custName, phone));
      }
    }
    return;
  }

  const firstName = customer.name?.split(' ')[0] || 'Cliente';

  // The final invoice's "Order status" button belongs to a finished order,
  // so it's answered whatever the session state — approval resets the
  // session (resetSearchSession) and a tap hours later finds it expired, and
  // the fresh-session check below would otherwise turn the tap into the main
  // menu. Deliberately runs before markSessionActive, so the customer's next
  // message is still a fresh session (greeting/tap → main menu).
  if (buttonReplyId?.startsWith('order_status_')) {
    await orderStatusService.processOrderStatusButton(phone, buttonReplyId);
    return;
  }

  const freshSession = await sessionService.isNewSession(phone);
  await sessionService.markSessionActive(phone);

  const activeCollection = await vehicleService.getActiveManualCollection(phone);
  const needsVehicleId = customer.registration_status === 'complete' && !activeCollection
    ? !(await vehicleService.hasVehicleOnFile(phone))
    : false;

  if (freshSession && customer.registration_status === 'complete' && !needsVehicleId) {
    const isGreeting = !!customerText && GREETING_PATTERN.test(customerText.trim());
    if (!mediaId && !activeCollection && (isGreeting || mediaType === 'interactive')) {
      // A greeting (or a tap on a prompt from a previous session) gets the
      // main menu — no vehicle question until the customer says what they want.
      await customerService.sendMainMenu(phone, firstName);
      return;
    }
    // A thank-you as the session's first message (typically right after the
    // final invoice — approval resets the session) gets only the courtesy
    // reply further down, not a "welcome back" stacked in front of it.
    if (!customerText || !isCourtesyMessage(customerText)) {
      await sendReply(phone, messages.onboarding.welcomeBack(firstName), { contextual: true });
    }
    // A real request as the session's first message (e.g. "engine oil") is
    // processed below instead of being dropped — the vehicle question comes
    // from the search fallback. Media (e.g. a payment proof) falls through as before.
    if (!mediaId) await sessionService.markPartPromptSent(phone);
  }

  if (freshSession && needsVehicleId) {
    const firstName = customer.name?.split(' ')[0] || 'Cliente';
    await sendReplyButtons(phone, messages.onboarding.resumeVehicleIdBody(firstName), messages.onboarding.askVehicleIdButtons);
    return;
  }

  if (freshSession && customer.registration_status !== 'complete') {
    await customerService.sendResumeRegistrationPrompt(phone, customer);
    return;
  }

  if (mediaType === 'interactive' && contextMessageId) {
    const activePromptId = await sessionService.getActivePromptId(phone);
    if (activePromptId && activePromptId !== contextMessageId) {
      await sendReply(phone, messages.common.alreadyAnswered());
      return;
    }
  }

  // 🌐 language option — a button on the first welcome or a row in the main
  // menu. Routed before registration so it's never taken as the customer's name.
  if (buttonReplyId === customerService.SWITCH_LANGUAGE_ID || listReplyId === customerService.SWITCH_LANGUAGE_ID) {
    await customerService.switchLanguage(phone, customer);
    return;
  }

  // Main-menu list taps (customerService.sendMainMenu) — only ever shown to a
  // customer with a complete profile and a vehicle on file.
  if (listReplyId?.startsWith('menu_') && customer.registration_status === 'complete' && !needsVehicleId) {
    if (listReplyId === 'menu_search_parts') {
      await vehicleService.sendAskPartPrompt(phone);
    } else if (listReplyId === 'menu_order_status') {
      await orderStatusService.handleOrderStatusRequest(phone, customer);
    } else if (listReplyId === 'menu_add_vehicle') {
      await vehicleService.startAddVehicleFlow(phone);
    }
    return;
  }

  // Shared WhatsApp location: the delivery-address answer while the order
  // profile wizard is at its address step; anywhere else, a polite "not
  // needed now" — it has no text, so it used to be silently dropped below.
  if (location) {
    const stage = await sessionService.getOrderProfileStage(phone);
    if (stage && await orderProfileService.processOrderProfileLocation(phone, location, stage)) return;
    await sendReply(phone, messages.common.locationNotNeeded());
    return;
  }

  if (customer.registration_status !== 'complete') {
    if (!customerText) return;
    const handled = await customerService.processCustomerRegistration(phone, customer, customerText, buttonReplyId);
    if (handled) return;
  }

  if (!needsVehicleId && customerText && vehicleService.isAddVehicleRequest(customerText)) {
    await vehicleService.startAddVehicleFlow(phone);
    return;
  }

  // Supplier inquiry details (customer said "yes, check with suppliers" after
  // a zero-results search): the next part photo or typed reference goes to
  // the team. Must run before image routing below, or the photo would be
  // taken as a vehicle document / payment proof. Greetings, courtesies and
  // button/list taps aren't details — they fall through as usual.
  const supplierInquiry = await sessionService.getAwaitingSupplierInquiryDetails(phone);
  if (supplierInquiry) {
    const isPhoto = mediaType === 'image' && !!mediaId;
    const isDetailsText = mediaType !== 'interactive' && !!customerText
      && !GREETING_PATTERN.test(customerText.trim()) && !isCourtesyMessage(customerText);
    if (isPhoto || isDetailsText) {
      await productService.submitSupplierInquiry(phone, firstName, supplierInquiry, {
        text: customerText,
        imageMediaId: isPhoto ? mediaId : null,
      });
      return;
    }
  }

  const documentRetryChoiceShown = await sessionService.wasDocumentRetryChoiceShown(phone);
  if (documentRetryChoiceShown && customerText) {
    const handled = await vehicleService.processDocumentRetryChoice(phone, customerText);
    if (handled) return;
  }

  const vinDecodeFailedChoiceShown = await sessionService.wasVinDecodeFailedShown(phone);
  if (vinDecodeFailedChoiceShown && customerText) {
    const handled = await vehicleService.processVinDecodeFailedChoice(phone, customerText);
    if (handled) return;
  }

  const vehicleIdChoiceShown = await sessionService.wasVehicleIdChoiceShown(phone);

  if ((needsVehicleId || vehicleIdChoiceShown) && customerText) {
    const handled = await vehicleService.processVehicleIdOptionChoice(phone, customerText);
    if (handled) return;
  }

  const awaitingVehicleId = needsVehicleId || !!activeCollection || vehicleIdChoiceShown;

  if (mediaType === 'image' && mediaId && awaitingVehicleId) {
    await vehicleService.processVehicleDocument(phone, mediaId);
    return;
  }

  if (mediaType === 'image' || mediaType === 'document') {
    if (mediaId) {
      const proofFirstName = customer.name?.split(' ')[0] || 'Cliente';
      const handled = await paymentService.processPaymentProof(phone, mediaId, mediaType, proofFirstName);
      if (handled) return;
    }
  }

  if (!customerText) return;

  if (activeCollection) {
    const handled = await vehicleService.processManualCollectionStep(phone, activeCollection, customerText, customer);
    if (handled) return;
  }

  if (vehicleService.isVIN(customerText)) {
    await vehicleService.processVIN(phone, customerText);
    return;
  }

  const vehicleChoiceHandled = await vehicleService.resolvePendingVehicleChoice(phone, customerText);
  if (vehicleChoiceHandled) return;

  const vinDuplicateChoiceShown = await sessionService.wasVinDuplicateChoiceShown(phone);
  if (vinDuplicateChoiceShown) {
    const handled = await vehicleService.processVinDuplicateChoice(phone, customerText);
    if (handled) return;
  }

  const pendingPartTypeChoice = await sessionService.getPendingPartTypeChoice(phone);
  if (pendingPartTypeChoice) {
    const handled = await productService.processPartTypeChoice(phone, listReplyId, pendingPartTypeChoice);
    if (handled) return;
  }

  const pendingWaitlistOffer = await sessionService.getPendingWaitlistOffer(phone);
  if (pendingWaitlistOffer) {
    const handled = await productService.processWaitlistOptIn(phone, customerText, pendingWaitlistOffer);
    if (handled) return;
  }

  const pendingBasketWaitlistOffer = await sessionService.getPendingBasketWaitlistOffer(phone);
  if (pendingBasketWaitlistOffer) {
    const handled = await productService.processBasketWaitlistOptIn(phone, customerText, pendingBasketWaitlistOffer);
    if (handled) return;
  }

  const pendingSupplierInquiryOffer = await sessionService.getPendingSupplierInquiryOffer(phone);
  if (pendingSupplierInquiryOffer) {
    const handled = await productService.processSupplierInquiryOffer(phone, customerText, pendingSupplierInquiryOffer);
    if (handled) return;
  }

  const pendingServiceOffer = await sessionService.getPendingServiceOffer(phone);
  if (pendingServiceOffer) {
    const handled = await productService.processServiceSelection(phone, customerText, listReplyId, pendingServiceOffer);
    if (handled) return;
  }

  const pendingStockUnavailableOffer = await sessionService.getPendingStockUnavailableOffer(phone);
  if (pendingStockUnavailableOffer) {
    const stockUnavailableFirstName = customer.name?.split(' ')[0] || 'Cliente';
    const handled = await productService.processStockUnavailableChoice(phone, customerText, pendingStockUnavailableOffer, stockUnavailableFirstName);
    if (handled) return;
  }

  const pendingOrderProfileShortcut = await sessionService.getPendingOrderProfileShortcut(phone);
  if (pendingOrderProfileShortcut) {
    const handled = await orderProfileService.processProfileShortcutReply(phone, buttonReplyId, pendingOrderProfileShortcut);
    if (handled) return;
  }

  const orderProfileStage = await sessionService.getOrderProfileStage(phone);
  if (orderProfileStage) {
    const handled = await orderProfileService.processOrderProfileStep(phone, customerText, buttonReplyId, orderProfileStage);
    if (handled) return;
  }

  const pendingRestockOrderOffer = await sessionService.getPendingRestockOrderOffer(phone);
  if (pendingRestockOrderOffer) {
    const handled = await productService.processRestockOrderChoice(phone, customerText, pendingRestockOrderOffer);
    if (handled) return;
  }

  const confirmedVehicle = await vehicleService.processVehicleConfirmation(phone, customerText, customer);
  if (confirmedVehicle) return;

  if (needsVehicleId || vehicleIdChoiceShown) {
    if (GREETING_PATTERN.test(customerText.trim())) {
      if (needsVehicleId) {
        const firstName = customer.name?.split(' ')[0] || 'Cliente';
        await sendReplyButtons(phone, messages.onboarding.resumeVehicleIdBody(firstName), messages.onboarding.askVehicleIdButtons);
        return;
      }
      await sessionService.clearVehicleIdChoiceShown(phone);
    } else {
      const trimmed = customerText.trim();
      if (vehicleService.looksLikeVinAttempt(trimmed)) {
        await sendReplyButtons(phone, messages.vin.invalidLength(trimmed.length), messages.onboarding.askVehicleIdButtons);
      } else {
        const notUnderstoodRes = await sendWhatsAppButtons(phone, messages.common.notUnderstood(), messages.onboarding.askVehicleIdButtons);
        await sessionService.saveActivePromptId(phone, notUnderstoodRes?.messages?.[0]?.id);
      }
      await sessionService.markVehicleIdChoiceShown(phone);
      return;
    }
  }

  const latestOrder = await paymentService.getPendingPaymentOrder(phone);

  if (latestOrder) {
    const handled = latestOrder.status === 'awaiting_payment_method'
      ? await paymentService.processMethodChoice(phone, customerText)
      : await paymentService.processMethodSubtype(phone, customerText);
    if (handled) return;
  }

  const isGreeting = GREETING_PATTERN.test(customerText.trim());
  if (isGreeting && await vehicleService.hasVehicleOnFile(phone)) {
    await customerService.sendMainMenu(phone, firstName);
    return;
  }

  // Payment chosen/sent but not yet approved: free text is almost always
  // about that payment ("já paguei", "quando chega?"), so a message that
  // isn't a part request gets the order's status instead of the part-search
  // prompts. A real part request still goes on to a normal search, reusing
  // this extraction. Taps, handoff, courtesy and status keywords keep their
  // own handling below.
  let extractedProductNames: string[] | null | undefined;
  if (
    mediaType !== 'interactive' &&
    !HUMAN_HANDOFF_PATTERN.test(customerText) &&
    !isCourtesyMessage(customerText) &&
    !ORDER_STATUS_PATTERN.test(customerText.trim())
  ) {
    const postPaymentOrder = await paymentService.getPostPaymentOrder(phone);
    if (postPaymentOrder) {
      extractedProductNames = isBareReply(customerText) ? [] : await extractProductNames(customerText);
      if (extractedProductNames && extractedProductNames.length === 0) {
        logger.info(`[FLOW] ${phone} sent "${customerText}" while order ${postPaymentOrder.number} is ${postPaymentOrder.status} — sending its status.`);
        await paymentService.sendPostPaymentStatus(phone, postPaymentOrder, firstName);
        return;
      }
    }
  }

  const invitedToAskForPart = await sessionService.wasPartPromptSent(phone);
  if (!invitedToAskForPart && mediaType !== 'interactive') {
    const asked = await vehicleService.sendAskPartPrompt(phone);
    if (asked) return;
  }

  const pendingProductOptions = await sessionService.getPendingOptions(phone);
  if (pendingProductOptions) {
    const alternativeOffer = await sessionService.getPendingAlternativeOffer(phone);
    if (alternativeOffer) {
      const handled = await productService.processAlternativeSelection(phone, customerText, listReplyId, pendingProductOptions, alternativeOffer);
      if (handled) return;
    } else {
      const basket = await sessionService.getPendingBasket(phone);
      if (basket) {
        const handled = await productService.processBasketProductSelection(phone, customerText, listReplyId, pendingProductOptions, basket);
        if (handled) return;
      }
    }
  }

  // A button/list tap nothing above claimed is an answer to a question that
  // was already answered (e.g. a second payment-method tap after one was
  // chosen — the bot's reply was plain text, so that prompt is still the
  // "latest" and step 4 can't flag it) or whose state was lost. Its title
  // ("✅ Yes, I have a NIF") is never a part name, so it must not reach the
  // search fallback below — and it must not reset anything either: the
  // conversation simply continues from where it is. Only an order stuck
  // before stock confirmation (wizard state lost) is actively resumed.
  if (mediaType === 'interactive') {
    logger.info(`[FLOW] ${phone} tapped an option with no active flow ("${customerText}") — already answered, continuing.`);
    if (await orderProfileService.resumeOrderProfileCapture(phone)) return;
    await sendReply(phone, messages.common.alreadyAnswered());
    return;
  }

  if (HUMAN_HANDOFF_PATTERN.test(customerText)) {
    await sendReply(phone, messages.agent.transferToHuman(), { contextual: true });
    logger.info(`[SUPPORT] Customer ${phone} requested human support.`);
    return;
  }

  // "Thank you for the support" / "ok obrigado" — e.g. after a "not in
  // stock" reply — is never a part search. One polite reply, throttled so a
  // thanks -> "you're welcome" -> "ok" chain doesn't keep answering itself.
  if (isCourtesyMessage(customerText)) {
    logger.info(`[PRODUCT SEARCH] ${phone} sent a courtesy message ("${customerText}") — not treating it as a search.`);
    if (await sessionService.claimCourtesyReply(phone)) {
      await sendReply(phone, messages.common.courtesyReply(), { contextual: true });
    }
    // A thank-you right after a "nothing found" reply closes that search: the
    // next message starts a fresh conversation (new session → main menu on a
    // greeting) instead of being read against the old search state.
    if (pendingSupplierInquiryOffer) {
      await sessionService.resetSearchSession(phone);
    }
    return;
  }

  if (ORDER_STATUS_PATTERN.test(customerText.trim())) {
    await orderStatusService.handleOrderStatusRequest(phone, customer);
    return;
  }

  // Search fallback — only for an actual part request. A bare yes/no/number
  // (typically a reply to a prompt whose state expired) is rejected
  // deterministically; anything else goes to Claude, which returns [] when
  // the message isn't asking for a part (a question, a name/NIF/address,
  // small talk). Neither ever starts a search. null = extraction failed →
  // fail open and search the raw text, so an API outage never blocks a request.
  const productNames = extractedProductNames !== undefined
    ? extractedProductNames
    : isBareReply(customerText) ? [] : await extractProductNames(customerText);
  if (productNames && productNames.length === 0) {
    logger.info(`[PRODUCT SEARCH] ${phone} message isn't a part request ("${customerText}") — not searching.`);
    const notAPartRequest = messages.agent.notAPartRequest();
    await sendReply(phone, notAPartRequest, { preserve: extractBoldTerms(notAPartRequest) });
    return;
  }

  // Ask which vehicle this request is for (if none picked yet this session)
  // before anything else — the request resumes right after the pick.
  if (await vehicleService.askVehicleChoiceForRequest(phone, customerText, firstName, productNames)) return;

  await productService.beginPartTypeChoice(phone, customerText, firstName, productNames);
}
