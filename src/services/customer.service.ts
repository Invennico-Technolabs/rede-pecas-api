import {
  getAndUpdateCustomer,
  getCustomerByPhone,
  createCustomerPreRegistration,
  updateCustomer,
  Customer
} from '../models/customer.model.js';
import { sendReply, sendReplyButtons, sendReplyList } from './reply.service.js';
import { extractBoldTerms } from './humanize.service.js';
import { sendWhatsAppMessage, sendWhatsAppButtons } from './whatsapp.service.js';
import {
  saveLocale,
  saveActivePromptId,
  markSessionActive,
  markPartPromptSent,
  markVehicleIdChoiceShown,
  clearChosenVehicle,
  clearPendingVehicleChoice,
  clearDeferredPartRequest,
  getLocale,
  saveCustomerName,
  incrementValidationAttempts,
  clearValidationAttempts
} from './session.service.js';
import { capitalize } from '../utils/helpers.js';
import { getMessages, DEFAULT_LOCALE } from '../i18n/messages.js';
import { isPlausibleName, flagForReview, MAX_VALIDATION_ATTEMPTS } from './validation.service.js';

export type { Customer };

/**
 * Resolves the locale for a phone's customer-facing replies: the customer's
 * explicitly chosen `customers.locale` (cached in the session so every send
 * in a turn doesn't hit the DB), else the default Angolan Portuguese. Never
 * inferred from message text — an isolated "Hi" must not flip the language.
 */
export async function resolveLocale(phone: string): Promise<'pt' | 'en'> {
  const cached = await getLocale(phone);
  if (cached) return cached;

  const customer = await getCustomerByPhone(phone);
  const locale = customer?.locale === 'en' || customer?.locale === 'pt' ? customer.locale : DEFAULT_LOCALE;
  await saveLocale(phone, locale);
  return locale;
}

/**
 * Persists a customer's explicit language choice and refreshes the session cache.
 */
async function setCustomerLocale(phone: string, locale: 'pt' | 'en'): Promise<void> {
  await updateCustomer(phone, { locale });
  await saveLocale(phone, locale);
}

// Id of the "🌐 English / 🌐 Português" option — a button on the first
// welcome, a row in the main menu list. Routed in whatsapp.controller.ts.
export const SWITCH_LANGUAGE_ID = 'lang_switch';

/**
 * Sends the first-contact welcome (which ends by asking the customer's name)
 * with a button to switch the conversation language. Sent raw, not
 * humanized, like before — it's the fixed brand introduction.
 */
async function sendWelcome(phone: string): Promise<void> {
  const messages = await resolveMessages(phone);
  const res = await sendWhatsAppButtons(
    phone,
    messages.onboarding.welcome(),
    [messages.onboarding.switchLanguageOption()],
    [SWITCH_LANGUAGE_ID]
  );
  await saveActivePromptId(phone, res?.messages?.[0]?.id);
}

/**
 * Resolves the full localized message bundle for a phone number, based on
 * its currently resolved locale.
 */
export async function resolveMessages(phone: string) {
  return getMessages(await resolveLocale(phone));
}

/**
 * Loads an existing customer by phone, caching their first name into the
 * session, or starts pre-registration and sends the welcome message for a brand-new one.
 */
export async function getOrCreateCustomer(phone: string): Promise<Customer | null> {
  const customer = await getAndUpdateCustomer(phone);
  if (customer) {
    if (customer.name) await saveCustomerName(phone, customer.name.split(' ')[0]);
    return customer;
  }

  await createCustomerPreRegistration(phone, 'awaiting_name');
  await markSessionActive(phone);
  await sendWelcome(phone);
  return null;
}

/**
 * Advances the profile-registration state machine (name → complete) based on
 * the customer's current status and their latest reply. NIF/address/
 * customer_type are no longer collected here — they're captured per order,
 * once the customer has confirmed what they're buying (see
 * orderProfile.service.ts), not at first contact.
 */
export async function processCustomerRegistration(phone: string, customer: Customer, reply: string, _buttonReplyId?: string | null): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const r = reply.trim();
  const status = customer.registration_status;

  if (status === 'awaiting_name') {
    const name = capitalize(r);

    if (!isPlausibleName(name)) {
      const attempts = await incrementValidationAttempts(phone, 'name');
      if (attempts < MAX_VALIDATION_ATTEMPTS) {
        await sendReply(phone, messages.validation.invalidName());
        return true;
      }
      await flagForReview('customer', phone, 'name', `Failed format check after ${MAX_VALIDATION_ATTEMPTS} attempts: "${name}"`);
    } else {
      await clearValidationAttempts(phone, 'name');
    }

    await updateCustomer(phone, { name, registration_status: 'complete' });

    await sendReplyButtons(phone, messages.onboarding.askVehicleIdBody(name), messages.onboarding.askVehicleIdButtons);
    await markVehicleIdChoiceShown(phone);
    return true;
  }

  return false;
}

/**
 * Re-sends the appropriate registration prompt for a returning customer
 * whose profile is still incomplete — only 'awaiting_name' remains today.
 */
export async function sendResumeRegistrationPrompt(phone: string, customer: Customer): Promise<void> {
  const messages = await resolveMessages(phone);
  await sendReply(phone, messages.onboarding.resumeRegistration());

  if (customer.registration_status === 'awaiting_name') {
    const askName = messages.onboarding.askNameOnly();
    await sendReply(phone, askName, { preserve: extractBoldTerms(askName) });
  }
}

/**
 * Sends the returning-customer greeting menu as a List Message (Search parts
 * / Order status / Add vehicle / 🌐 switch language) instead of jumping
 * straight to a vehicle question. Row ids use the `menu_` prefix (routed in
 * whatsapp.controller.ts), except the language row, which shares
 * SWITCH_LANGUAGE_ID with the welcome button. Starts a fresh intent: the
 * session's chosen vehicle and any half-asked vehicle choice are forgotten,
 * so the next request asks which vehicle again, and free text typed after
 * the menu is treated as a part search.
 */
export async function sendMainMenu(phone: string, firstName: string): Promise<void> {
  await clearChosenVehicle(phone);
  await clearPendingVehicleChoice(phone);
  await clearDeferredPartRequest(phone);
  await markPartPromptSent(phone);

  const messages = await resolveMessages(phone);
  const rows = messages.onboarding.mainMenuRows;
  await sendReplyList(
    phone,
    messages.onboarding.mainMenuBody(firstName),
    messages.onboarding.mainMenuListButton(),
    [
      { id: 'menu_search_parts', title: rows.searchParts },
      { id: 'menu_order_status', title: rows.orderStatus },
      { id: 'menu_add_vehicle', title: rows.addVehicle },
      { id: SWITCH_LANGUAGE_ID, title: messages.onboarding.switchLanguageOption() },
    ],
    { contextual: true }
  );
}

/**
 * Handles the 🌐 language option (welcome button or menu row): flips the
 * customer's saved language between Portuguese and English, confirms in the
 * new language, then re-sends what they were looking at — the welcome (still
 * asking their name) during registration, otherwise the main menu.
 */
export async function switchLanguage(phone: string, customer: Customer): Promise<void> {
  const next = (await resolveLocale(phone)) === 'pt' ? 'en' : 'pt';
  await setCustomerLocale(phone, next);
  await sendWhatsAppMessage(phone, getMessages(next).onboarding.languageSwitched());

  if (customer.registration_status !== 'complete') {
    await sendWelcome(phone);
    return;
  }
  await sendMainMenu(phone, customer.name?.split(' ')[0] || 'Cliente');
}

/**
 * Stamps a customer's registered_at timestamp and sends the combined
 * welcome/onboarding-complete message the first time they get a confirmed vehicle on file.
 */
export async function completeOnboardingIfNeeded(
  phone: string,
  customer: Customer,
  vehicleSummary: string
): Promise<boolean> {
  if (customer.registered_at) return false;

  const messages = await resolveMessages(phone);
  await updateCustomer(phone, { registered_at: new Date() });

  const name = customer.name?.split(' ')[0] || 'Cliente';
  await sendReplyButtons(
    phone,
    messages.onboarding.onboardingComplete(name, vehicleSummary),
    [messages.vehicleConfirm.addVehicleButton()]
  );
  await markPartPromptSent(phone);
  return true;
}
