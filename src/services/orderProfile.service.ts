import { getCustomerByPhone, updateCustomer } from '../models/customer.model.js';
import { getLatestOrderByStatus, updateOrderStatus } from '../models/order.model.js';
import { logger } from '../config/logger.js';
import { sendReply, sendReplyButtons, sendReplyLocationRequest } from './reply.service.js';
import { extractBoldTerms } from './humanize.service.js';
import { resolveMessages } from './customer.service.js';
import { sendProformaAndAskPayment } from './product.service.js';
import {
  markSessionActive,
  savePendingOrderProfileShortcut,
  clearPendingOrderProfileShortcut,
  saveOrderProfileStage,
  clearOrderProfileStage,
  incrementValidationAttempts,
  clearValidationAttempts,
  PendingOrderProfileShortcut,
  OrderProfileStage
} from './session.service.js';
import { isPlausibleNif, validateFreeText, flagForReview, MAX_VALIDATION_ATTEMPTS } from './validation.service.js';

/**
 * Kicks off (or shortcuts) the individual/company + NIF + address capture
 * for an order whose stock the supplier has just confirmed — the proforma
 * and payment follow once it completes. See CLAUDE.md's message pipeline for
 * where this replaces the old registration-time NIF/address stages.
 */
export async function startOrderProfileCapture(phone: string, orderNumber: string): Promise<void> {
  await updateOrderStatus(orderNumber, 'awaiting_customer_details');
  // Admin can confirm stock hours after the customer's last message — keep
  // the session alive so their tap on the prompt below isn't taken as a
  // fresh-session opener (which answers with the main menu instead).
  await markSessionActive(phone);

  const messages = await resolveMessages(phone);
  const customer = await getCustomerByPhone(phone);
  const firstName = customer?.name?.split(' ')[0] || 'Cliente';

  const hasSavedProfile =
    !!customer?.customer_type &&
    !!customer?.address &&
    (customer.customer_type === 'individual' || !!customer.nif);

  if (hasSavedProfile && customer) {
    await savePendingOrderProfileShortcut(phone, { orderNumber });
    await sendReplyButtons(
      phone,
      messages.orderProfile.savedProfileSummary(firstName, customer.address!, customer.customer_type as 'individual' | 'company', customer.nif),
      [messages.orderProfile.savedProfileUseButton(), messages.orderProfile.savedProfileEditButton()],
      ['order_profile_use_saved', 'order_profile_edit']
    );
    return;
  }

  await saveOrderProfileStage(phone, { orderNumber, stage: 'awaiting_type' });
  await sendReplyButtons(
    phone,
    messages.orderProfile.askCustomerTypeBody(firstName),
    messages.orderProfile.askCustomerTypeButtons,
    ['customer_type_individual', 'customer_type_company']
  );
}

/**
 * Handles the customer's reply to the saved-profile shortcut: "use saved"
 * proceeds straight to the proforma and payment, "edit" drops into the fresh
 * wizard (overwriting the saved profile), anything else re-sends the
 * identical prompt rather than guessing.
 */
export async function processProfileShortcutReply(
  phone: string,
  buttonReplyId: string | null,
  pending: PendingOrderProfileShortcut
): Promise<boolean> {
  if (buttonReplyId === 'order_profile_use_saved') {
    await clearPendingOrderProfileShortcut(phone);
    await sendProformaAndAskPayment(phone, pending.orderNumber);
    return true;
  }

  if (buttonReplyId === 'order_profile_edit') {
    await clearPendingOrderProfileShortcut(phone);
    const messages = await resolveMessages(phone);
    const customer = await getCustomerByPhone(phone);
    const firstName = customer?.name?.split(' ')[0] || 'Cliente';
    await saveOrderProfileStage(phone, { orderNumber: pending.orderNumber, stage: 'awaiting_type' });
    await sendReplyButtons(
      phone,
      messages.orderProfile.askCustomerTypeBody(firstName),
      messages.orderProfile.askCustomerTypeButtons,
      ['customer_type_individual', 'customer_type_company']
    );
    return true;
  }

  const messages = await resolveMessages(phone);
  await sendReplyButtons(
    phone,
    messages.orderProfile.savedProfileNotUnderstood(),
    [messages.orderProfile.savedProfileUseButton(), messages.orderProfile.savedProfileEditButton()],
    ['order_profile_use_saved', 'order_profile_edit']
  );
  return true;
}

/**
 * Commits the captured customer_type/nif/address to the customer's profile
 * (last-known values, reused as the saved-profile shortcut on future orders)
 * and proceeds to the proforma and payment for this order.
 */
async function finalizeOrderProfile(
  phone: string,
  orderNumber: string,
  customerType: 'individual' | 'company',
  nif: string | null,
  address: string | null,
  coords: { lat: number | null; lng: number | null } = { lat: null, lng: null }
): Promise<void> {
  // Save first, clear the wizard after: if the DB write throws, the stage
  // survives and the customer's retry still lands in the wizard, instead of
  // the order being stranded at awaiting_customer_details with its state gone.
  await updateCustomer(phone, { customer_type: customerType, nif, address, address_lat: coords.lat, address_lng: coords.lng });
  await clearOrderProfileStage(phone);
  await sendProformaAndAskPayment(phone, orderNumber);
}

// How far back an unfinished order may be resumed — the session TTL, so a
// days-old abandoned order is never dragged back into the conversation.
const RESUMABLE_ORDER_MAX_AGE_MS = 4 * 60 * 60 * 1000;

/**
 * Restarts the profile capture (individual/company + NIF + address) for the
 * customer's latest order still at `awaiting_customer_details` — stock
 * confirmed, but the proforma never sent — when its wizard state was lost
 * (session expiry, restart, a failed step). Returns false when there's no
 * such recent order.
 */
export async function resumeOrderProfileCapture(phone: string): Promise<boolean> {
  const order = await getLatestOrderByStatus(phone, ['awaiting_customer_details']);
  if (!order || Date.now() - new Date(order.created_at).getTime() > RESUMABLE_ORDER_MAX_AGE_MS) return false;
  logger.info(`[ORDER PROFILE] ${phone} resuming lost profile capture for order ${order.number}`);
  await startOrderProfileCapture(phone, order.number);
  return true;
}

/**
 * Asks for the delivery address as WhatsApp's native location request —
 * "📍 Send location" is the primary path, a typed address still works.
 */
async function askDeliveryAddress(phone: string, body: string): Promise<void> {
  await sendReplyLocationRequest(phone, body, { preserve: extractBoldTerms(body) });
}

const ADDRESS_STAGES: OrderProfileStage['stage'][] = ['awaiting_individual_address', 'awaiting_company_address'];

export interface SharedLocation {
  latitude: number;
  longitude: number;
  name?: string | null;
  address?: string | null;
}

/**
 * Moves the wizard past the address step once a readable address is in hand
 * (typed, a named WhatsApp place, or pin + landmark): company orders already
 * have their NIF and finalize; individual orders go on to the optional NIF
 * question, carrying the address and any coordinates in the stage.
 */
async function continueAfterLocationAddress(
  phone: string,
  stage: OrderProfileStage,
  address: string,
  coords: { lat: number | null; lng: number | null }
): Promise<void> {
  if (stage.customerType === 'company') {
    await finalizeOrderProfile(phone, stage.orderNumber, 'company', stage.nif ?? null, address, coords);
    return;
  }
  const messages = await resolveMessages(phone);
  await saveOrderProfileStage(phone, {
    ...stage,
    stage: 'awaiting_individual_nif_choice',
    address,
    addressLat: coords.lat,
    addressLng: coords.lng,
  });
  await sendReplyButtons(phone, messages.orderProfile.askIndividualNifBody(), messages.orderProfile.askIndividualNifButtons, ['order_nif_yes', 'order_nif_no']);
}

/**
 * Handles a shared WhatsApp location while the wizard is waiting for the
 * delivery address. When WhatsApp attached a place name/address (the
 * customer picked a named place), that's already readable — save it with the
 * coordinates and move on. A bare "current location" pin has no text at all,
 * so only then ask for one landmark (stage awaiting_address_landmark), since
 * coordinates alone can't be read by staff or a courier. Returns false when
 * the wizard isn't at an address step.
 */
export async function processOrderProfileLocation(phone: string, location: SharedLocation, stage: OrderProfileStage): Promise<boolean> {
  if (!ADDRESS_STAGES.includes(stage.stage)) return false;

  const messages = await resolveMessages(phone);
  const place = [location.name, location.address].map((s) => s?.trim()).filter(Boolean).join(', ') || null;
  await clearValidationAttempts(phone, 'address');

  if (place) {
    await continueAfterLocationAddress(phone, stage, place, { lat: location.latitude, lng: location.longitude });
    return true;
  }

  await saveOrderProfileStage(phone, {
    ...stage,
    stage: 'awaiting_address_landmark',
    addressLat: location.latitude,
    addressLng: location.longitude,
    addressPlace: place,
  });
  const askLandmark = messages.orderProfile.askAddressLandmark();
  await sendReply(phone, askLandmark, { preserve: extractBoldTerms(askLandmark) });
  return true;
}

const NIF_YES_PATTERN = /\b(sim|yes)\b|✅|^s$|^y$|^1$/i;
const NIF_NO_PATTERN = /\b(n[ãa]o|no|nope)\b|❌|^n$|^2$/i;

/**
 * Advances the in-progress individual/company + NIF + address wizard one
 * step, branching by path: company asks NIF first (required, validated,
 * re-asked on failure) then address; individual asks address first, then an
 * optional NIF yes/no, then the NIF number only if yes. The final step of
 * either path commits the profile and moves on to the proforma and payment.
 */
export async function processOrderProfileStep(
  phone: string,
  customerText: string,
  buttonReplyId: string | null,
  stage: OrderProfileStage
): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const r = customerText.trim();

  if (stage.stage === 'awaiting_type') {
    if (buttonReplyId === 'customer_type_individual') {
      const customer = await getCustomerByPhone(phone);
      const firstName = customer?.name?.split(' ')[0] || 'Cliente';
      await saveOrderProfileStage(phone, { ...stage, stage: 'awaiting_individual_address', customerType: 'individual' });
      await askDeliveryAddress(phone, messages.orderProfile.askIndividualAddressBody(firstName));
      return true;
    }
    if (buttonReplyId === 'customer_type_company') {
      await saveOrderProfileStage(phone, { ...stage, stage: 'awaiting_company_nif', customerType: 'company' });
      const askCompanyNif = messages.orderProfile.askCompanyNifBody();
      await sendReply(phone, askCompanyNif, { preserve: extractBoldTerms(askCompanyNif) });
      return true;
    }
    await sendReplyButtons(phone, messages.common.notUnderstood(), messages.orderProfile.askCustomerTypeButtons, ['customer_type_individual', 'customer_type_company']);
    return true;
  }

  if (stage.stage === 'awaiting_company_nif') {
    const nif = r.replace(/\s/g, '').toUpperCase();
    if (!isPlausibleNif(nif)) {
      const attempts = await incrementValidationAttempts(phone, 'nif');
      if (attempts < MAX_VALIDATION_ATTEMPTS) {
        await sendReply(phone, messages.orderProfile.askCompanyNifInvalid());
        return true;
      }
      await flagForReview('customer', phone, 'nif', `Failed format check after ${MAX_VALIDATION_ATTEMPTS} attempts: "${nif}"`);
    } else {
      await clearValidationAttempts(phone, 'nif');
    }

    const customer = await getCustomerByPhone(phone);
    const firstName = customer?.name?.split(' ')[0] || 'Cliente';
    await saveOrderProfileStage(phone, { ...stage, stage: 'awaiting_company_address', nif });
    await askDeliveryAddress(phone, messages.orderProfile.askCompanyAddressBody(firstName));
    return true;
  }

  if (stage.stage === 'awaiting_address_landmark') {
    // Any non-empty text is accepted as the landmark — it's a courier hint,
    // not a field with a checkable format. Readable address = place + landmark.
    const address = [stage.addressPlace, `${messages.orderProfile.landmarkLabel()} ${r}`].filter(Boolean).join(' · ');
    await continueAfterLocationAddress(phone, stage, address, stageCoords(stage));
    return true;
  }

  if (stage.stage === 'awaiting_company_address') {
    const result = await validateFreeText('address', r);
    if (!result.valid) {
      const attempts = await incrementValidationAttempts(phone, 'address');
      if (attempts < MAX_VALIDATION_ATTEMPTS) {
        await askDeliveryAddress(phone, messages.validation.invalidAddress());
        return true;
      }
      await flagForReview('customer', phone, 'address', result.reason || `Failed plausibility check after ${MAX_VALIDATION_ATTEMPTS} attempts: "${r}"`);
    } else {
      await clearValidationAttempts(phone, 'address');
    }

    await finalizeOrderProfile(phone, stage.orderNumber, 'company', stage.nif ?? null, r);
    return true;
  }

  if (stage.stage === 'awaiting_individual_address') {
    const result = await validateFreeText('address', r);
    if (!result.valid) {
      const attempts = await incrementValidationAttempts(phone, 'address');
      if (attempts < MAX_VALIDATION_ATTEMPTS) {
        await askDeliveryAddress(phone, messages.validation.invalidAddress());
        return true;
      }
      await flagForReview('customer', phone, 'address', result.reason || `Failed plausibility check after ${MAX_VALIDATION_ATTEMPTS} attempts: "${r}"`);
    } else {
      await clearValidationAttempts(phone, 'address');
    }

    await saveOrderProfileStage(phone, { ...stage, stage: 'awaiting_individual_nif_choice', address: r });
    await sendReplyButtons(phone, messages.orderProfile.askIndividualNifBody(), messages.orderProfile.askIndividualNifButtons, ['order_nif_yes', 'order_nif_no']);
    return true;
  }

  if (stage.stage === 'awaiting_individual_nif_choice') {
    const noNif = buttonReplyId === 'order_nif_no' || NIF_NO_PATTERN.test(r);
    const yesNif = buttonReplyId === 'order_nif_yes' || NIF_YES_PATTERN.test(r);

    if (noNif) {
      await finalizeOrderProfile(phone, stage.orderNumber, 'individual', null, stage.address ?? null, stageCoords(stage));
      return true;
    }
    if (yesNif) {
      await saveOrderProfileStage(phone, { ...stage, stage: 'awaiting_individual_nif_number' });
      const askIndividualNifNumber = messages.orderProfile.askIndividualNifNumberBody();
      await sendReply(phone, askIndividualNifNumber, { preserve: extractBoldTerms(askIndividualNifNumber) });
      return true;
    }
    await sendReplyButtons(phone, messages.common.notUnderstood(), messages.orderProfile.askIndividualNifButtons, ['order_nif_yes', 'order_nif_no']);
    return true;
  }

  if (stage.stage === 'awaiting_individual_nif_number') {
    const nif = r.replace(/\s/g, '').toUpperCase();
    if (!isPlausibleNif(nif)) {
      const attempts = await incrementValidationAttempts(phone, 'nif');
      if (attempts < MAX_VALIDATION_ATTEMPTS) {
        await sendReply(phone, messages.validation.invalidNif());
        return true;
      }
      await flagForReview('customer', phone, 'nif', `Failed format check after ${MAX_VALIDATION_ATTEMPTS} attempts: "${nif}"`);
    } else {
      await clearValidationAttempts(phone, 'nif');
    }

    await finalizeOrderProfile(phone, stage.orderNumber, 'individual', nif, stage.address ?? null, stageCoords(stage));
    return true;
  }

  return false;
}

/**
 * The wizard's shared-location coordinates, or nulls for a typed address.
 */
function stageCoords(stage: OrderProfileStage): { lat: number | null; lng: number | null } {
  return { lat: stage.addressLat ?? null, lng: stage.addressLng ?? null };
}
