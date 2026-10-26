import { createHash } from 'crypto';
import { Product } from '../models/product.model.js';
import { Service } from '../models/service.model.js';
import {
  SESSION_TTL,
  setString,
  getString,
  setJSON,
  getJSON,
  setFlag,
  hasKey,
  claimKey,
  getTTL,
  setStringKeepTTL,
  deleteKey,
  deleteByPrefix,
} from './cache.service.js';

// Re-exported so existing `import { redisReady } from './session.service.js'`
// call sites keep working — the client itself now lives in cache.service.ts.
export { redisReady } from './cache.service.js';

// Per-phone conversational state. Every function here is a thin, typed
// wrapper over cache.service.ts's Redis-with-memory-fallback store — the key
// prefix, TTL and value shape are the only things that differ between them.
// Keys and value encodings are unchanged from before that helper existed, so
// data already in Redis stays readable across the refactor.

const VEHICLE_ID_CHOICE_TTL = SESSION_TTL;

// --- Pending product search-results list -----------------------------------

/**
 * Stores the product search-results list a customer was just shown, so a
 * subsequent list-tap or typed digit can be resolved back to a specific product.
 */
export const savePendingOptions = (phone: string, options: any[]): Promise<void> => setJSON(`options:${phone}`, options);

/**
 * Retrieves the pending product search-results list for a phone, if any is still cached.
 */
export const getPendingOptions = (phone: string): Promise<any[] | null> => getJSON(`options:${phone}`);

/**
 * Removes the pending product search-results list once it's been resolved or superseded.
 */
export const clearPendingOptions = (phone: string): Promise<void> => deleteKey(`options:${phone}`);

// --- Multi-product basket ---------------------------------------------------

export interface BasketItemDraft {
  product: Product;
  service: { name: string; price: number } | null;
}

export interface UnmatchedBasketItem {
  query: string;                  // the raw phrase that didn't match any in-stock product
  candidateId: number | null;     // an out-of-stock (zero-qty) product that matched, if any — waitlist-eligible
  candidateName: string | null;
}

export interface PendingBasket {
  queue: string[];           // product-name phrases not yet searched/resolved
  items: BasketItemDraft[];  // resolved so far
  // The one part-type choice (OEM/Aftermarket/New/Second Hand) for this
  // order, asked once before search and applied to every item in it — never
  // asked again per item. Empty string until the part-type step resolves it.
  partType: string;
  // Phrases that found no in-stock match while working through the queue —
  // accumulated silently (no per-item message) so the customer gets one
  // consolidated notice/waitlist-offer once the whole queue is drained,
  // instead of a repeated back-and-forth per failed item.
  unmatched: UnmatchedBasketItem[];
}

/**
 * Stores the in-progress multi-product "basket" for a phone — the remaining
 * product-name phrases still to be searched/resolved, plus the items already
 * picked — while the customer works through a multi-product search one item at a time.
 */
export const savePendingBasket = (phone: string, basket: PendingBasket): Promise<void> => setJSON(`basket:${phone}`, basket);

/**
 * Retrieves the in-progress multi-product basket for a phone, if one is still being built.
 */
export const getPendingBasket = (phone: string): Promise<PendingBasket | null> => getJSON(`basket:${phone}`);

/**
 * Removes the in-progress multi-product basket once it's been confirmed or cancelled.
 */
export const clearPendingBasket = (phone: string): Promise<void> => deleteKey(`basket:${phone}`);

// --- Part-type choice (OEM/Aftermarket/New/Second Hand) --------------------

export interface PendingPartTypeChoice {
  productNames: string[] | null; // Claude-extracted part phrases (2+ = basket); null if extraction failed
  customerText: string;          // original free text — search fallback when productNames is null
  customerName: string;
}

/**
 * Stores the identified part(s) awaiting a one-time-per-order part-type
 * choice (OEM/Aftermarket/New/Second Hand) before any search runs.
 */
export const savePendingPartTypeChoice = (phone: string, pending: PendingPartTypeChoice): Promise<void> =>
  setJSON(`partTypeChoice:${phone}`, pending);

/**
 * Retrieves the pending part-type choice for a phone, if one is still awaiting a reply.
 */
export const getPendingPartTypeChoice = (phone: string): Promise<PendingPartTypeChoice | null> => getJSON(`partTypeChoice:${phone}`);

/**
 * Removes the pending part-type choice for a phone once resolved.
 */
export const clearPendingPartTypeChoice = (phone: string): Promise<void> => deleteKey(`partTypeChoice:${phone}`);

// --- Order-profile capture (individual/company + NIF + address) ------------

export interface PendingOrderProfileShortcut {
  orderNumber: string;
}

/**
 * Stores which order is waiting on a returning customer's "use my saved
 * details" reply (individual/company + NIF + address already on file).
 */
export const savePendingOrderProfileShortcut = (phone: string, pending: PendingOrderProfileShortcut): Promise<void> =>
  setJSON(`orderProfileShortcut:${phone}`, pending);

/**
 * Retrieves the pending order-profile shortcut for a phone, if one is still awaiting a reply.
 */
export const getPendingOrderProfileShortcut = (phone: string): Promise<PendingOrderProfileShortcut | null> =>
  getJSON(`orderProfileShortcut:${phone}`);

/**
 * Removes the pending order-profile shortcut for a phone once resolved.
 */
export const clearPendingOrderProfileShortcut = (phone: string): Promise<void> => deleteKey(`orderProfileShortcut:${phone}`);

export type OrderProfileStageName =
  | 'awaiting_type'
  | 'awaiting_company_nif'
  | 'awaiting_company_address'
  | 'awaiting_individual_address'
  // After a shared WhatsApp location: one landmark ("ponto de referência")
  // turns the coordinates into an address a courier can read.
  | 'awaiting_address_landmark'
  | 'awaiting_individual_nif_choice'
  | 'awaiting_individual_nif_number';

export interface OrderProfileStage {
  orderNumber: string;
  stage: OrderProfileStageName;
  // Accumulated across steps, only committed to `customers` on the final
  // step — an abandoned wizard never leaves a half-updated profile.
  customerType?: 'individual' | 'company';
  nif?: string | null;
  address?: string | null;
  // Set only when the address came from a shared WhatsApp location.
  addressLat?: number | null;
  addressLng?: number | null;
  addressPlace?: string | null; // place name/address WhatsApp attached to the pin, if any
}

/**
 * Stores the in-progress individual/company + NIF + address wizard for an order, one step at a time.
 */
export const saveOrderProfileStage = (phone: string, stage: OrderProfileStage): Promise<void> => setJSON(`orderProfileStage:${phone}`, stage);

/**
 * Retrieves the in-progress order-profile wizard stage for a phone, if one is still active.
 */
export const getOrderProfileStage = (phone: string): Promise<OrderProfileStage | null> => getJSON(`orderProfileStage:${phone}`);

/**
 * Removes the order-profile wizard stage for a phone once it completes.
 */
export const clearOrderProfileStage = (phone: string): Promise<void> => deleteKey(`orderProfileStage:${phone}`);

// --- Alternatives for unavailable multi-item order lines -------------------

export interface PendingAlternativeOffer {
  orderNumber: string;
  itemId: number;
}

/**
 * Stores which order/item an alternative-products list currently on screen
 * belongs to, so the customer's list-tap/typed-digit reply resolves back to
 * the right unavailable line item on an existing multi-item order.
 */
export const savePendingAlternativeOffer = (phone: string, offer: PendingAlternativeOffer): Promise<void> =>
  setJSON(`altOffer:${phone}`, offer);

/**
 * Retrieves the pending alternative-products offer for a phone, if one is still awaiting a reply.
 */
export const getPendingAlternativeOffer = (phone: string): Promise<PendingAlternativeOffer | null> => getJSON(`altOffer:${phone}`);

/**
 * Removes the pending alternative-products offer for a phone once it's been resolved.
 */
export const clearPendingAlternativeOffer = (phone: string): Promise<void> => deleteKey(`altOffer:${phone}`);

export interface PendingAlternativeResolution {
  orderNumber: string;
  queue: number[]; // itemIds still needing an alternative offered
}

/**
 * Stores the queue of an existing multi-item order's rejected line items
 * still waiting to be offered alternatives, one at a time, after admin
 * marks some items unavailable.
 */
export const savePendingAlternativeResolution = (phone: string, resolution: PendingAlternativeResolution): Promise<void> =>
  setJSON(`altResolution:${phone}`, resolution);

/**
 * Retrieves the in-progress alternative-resolution queue for a phone, if one is still active.
 */
export const getPendingAlternativeResolution = (phone: string): Promise<PendingAlternativeResolution | null> =>
  getJSON(`altResolution:${phone}`);

/**
 * Removes the alternative-resolution queue for a phone once every rejected
 * item has been offered an alternative (picked or skipped).
 */
export const clearPendingAlternativeResolution = (phone: string): Promise<void> => deleteKey(`altResolution:${phone}`);

// --- Session activity / prompts ---------------------------------------------

/**
 * Reports whether a phone has no active session marker yet, i.e. this is effectively a fresh conversation.
 */
export const isNewSession = async (phone: string): Promise<boolean> => !(await hasKey(`active:${phone}`));

/**
 * Marks a phone's conversation session as active for the standard TTL.
 */
export const markSessionActive = (phone: string): Promise<void> => setFlag(`active:${phone}`);

/**
 * Reports whether the "what part do you need" prompt was already sent
 * this session, gating whether free text may be treated as a product search.
 */
export const wasPartPromptSent = (phone: string): Promise<boolean> => hasKey(`partPrompt:${phone}`);

/**
 * Marks that the "what part do you need" prompt has been sent for this phone's session.
 */
export const markPartPromptSent = (phone: string): Promise<void> => setFlag(`partPrompt:${phone}`);

/**
 * Caches the WhatsApp message id of the most recent interactive prompt sent to a phone, if one was provided.
 */
export async function saveActivePromptId(phone: string, messageId?: string | null): Promise<void> {
  if (!messageId) return;
  await setString(`activePrompt:${phone}`, messageId);
}

/**
 * Retrieves the cached message id of the most recent interactive prompt sent to a phone.
 */
export const getActivePromptId = (phone: string): Promise<string | null> => getString(`activePrompt:${phone}`);

// --- Vehicle selection / identification flags ------------------------------

type VehicleChoice = { id: number; make: string; model: string; year: string };

/**
 * Stores the list of vehicles a customer with 2+ vehicles is being asked
 * to choose between before a product search proceeds.
 */
export const savePendingVehicleChoice = (phone: string, vehicles: VehicleChoice[]): Promise<void> =>
  setJSON(`vehicleChoice:${phone}`, vehicles);

/**
 * Retrieves the pending "which vehicle is this for?" choice list for a phone, if one is still awaiting a reply.
 */
export const getPendingVehicleChoice = (phone: string): Promise<VehicleChoice[] | null> => getJSON(`vehicleChoice:${phone}`);

/**
 * Removes the pending "which vehicle is this for?" choice list for a phone once it's been resolved.
 */
export const clearPendingVehicleChoice = (phone: string): Promise<void> => deleteKey(`vehicleChoice:${phone}`);

/**
 * Records which of a customer's multiple vehicles they picked, so subsequent searches this session are scoped to it.
 */
export const saveChosenVehicle = (phone: string, vehicleId: number): Promise<void> => setString(`chosenVehicle:${phone}`, String(vehicleId));

/**
 * Retrieves the id of the vehicle a customer previously chose for searches this session, if any.
 */
export async function getChosenVehicle(phone: string): Promise<number | null> {
  const data = await getString(`chosenVehicle:${phone}`);
  return data ? parseInt(data, 10) : null;
}

/**
 * Forgets the session's chosen vehicle, so the next request asks "which vehicle is this for?" again.
 */
export const clearChosenVehicle = (phone: string): Promise<void> => deleteKey(`chosenVehicle:${phone}`);

export interface DeferredPartRequest {
  customerText: string;
  customerName: string;
  productNames?: string[] | null; // already extracted by Claude, reused after the vehicle pick
}

/**
 * Holds a typed part request while the customer is asked which vehicle it's
 * for, so the search can continue once they pick without them retyping it.
 */
export const saveDeferredPartRequest = (phone: string, request: DeferredPartRequest): Promise<void> =>
  setJSON(`deferredPartRequest:${phone}`, request);

/**
 * Retrieves the part request waiting on a vehicle choice, if any.
 */
export const getDeferredPartRequest = (phone: string): Promise<DeferredPartRequest | null> =>
  getJSON(`deferredPartRequest:${phone}`);

/**
 * Removes the part request waiting on a vehicle choice.
 */
export const clearDeferredPartRequest = (phone: string): Promise<void> => deleteKey(`deferredPartRequest:${phone}`);

/**
 * Marks that the vehicle-ID entry option buttons (VIN/photo/manual) were just shown to this phone.
 */
export const markVehicleIdChoiceShown = (phone: string): Promise<void> => setFlag(`vehicleIdChoice:${phone}`, VEHICLE_ID_CHOICE_TTL);

/**
 * Reports whether the vehicle-ID entry option buttons were shown to this phone within the current session.
 */
export const wasVehicleIdChoiceShown = (phone: string): Promise<boolean> => hasKey(`vehicleIdChoice:${phone}`);

/**
 * Clears the vehicle-ID entry option buttons' shown flag for this phone.
 */
export const clearVehicleIdChoiceShown = (phone: string): Promise<void> => deleteKey(`vehicleIdChoice:${phone}`);

/**
 * Marks that the "this VIN is already registered" choice buttons were just shown to this phone.
 */
export const markVinDuplicateChoiceShown = (phone: string): Promise<void> => setFlag(`vinDuplicateChoice:${phone}`, VEHICLE_ID_CHOICE_TTL);

/**
 * Reports whether the "VIN already registered" choice buttons were shown to this phone within the current session.
 */
export const wasVinDuplicateChoiceShown = (phone: string): Promise<boolean> => hasKey(`vinDuplicateChoice:${phone}`);

/**
 * Clears the "VIN already registered" choice buttons' shown flag for this phone.
 */
export const clearVinDuplicateChoice = (phone: string): Promise<void> => deleteKey(`vinDuplicateChoice:${phone}`);

/**
 * Marks that the vehicle Sim/Não confirmation buttons were just shown to
 * this phone, gating the confirm-reply matcher.
 */
export const markVehicleConfirmShown = (phone: string): Promise<void> => setFlag(`vehicleConfirm:${phone}`, VEHICLE_ID_CHOICE_TTL);

/**
 * Reports whether the vehicle Sim/Não confirmation buttons were shown to this phone within the current session.
 */
export const wasVehicleConfirmShown = (phone: string): Promise<boolean> => hasKey(`vehicleConfirm:${phone}`);

/**
 * Clears the vehicle Sim/Não confirmation buttons' shown flag for this phone.
 */
export const clearVehicleConfirmShown = (phone: string): Promise<void> => deleteKey(`vehicleConfirm:${phone}`);

/**
 * Marks that the manual-entry fallback message was shown after a VIN
 * decode failed, caching the attempted VIN as the flag's value.
 */
export const markVinDecodeFailedShown = (phone: string, attemptedVin: string): Promise<void> =>
  setString(`vinDecodeFailed:${phone}`, attemptedVin, VEHICLE_ID_CHOICE_TTL);

/**
 * Reports whether a VIN-decode-failed fallback message was shown to this phone within the current session.
 */
export const wasVinDecodeFailedShown = (phone: string): Promise<boolean> => hasKey(`vinDecodeFailed:${phone}`);

/**
 * Retrieves the VIN that failed to decode for this phone, if the decode-failed flag is still active.
 */
export const getVinDecodeFailedVin = (phone: string): Promise<string | null> => getString(`vinDecodeFailed:${phone}`);

/**
 * Clears the VIN-decode-failed flag and cached VIN for this phone.
 */
export const clearVinDecodeFailedChoice = (phone: string): Promise<void> => deleteKey(`vinDecodeFailed:${phone}`);

/**
 * Marks that the "try again" document-processing retry button was just shown to this phone.
 */
export const markDocumentRetryChoiceShown = (phone: string): Promise<void> =>
  setFlag(`documentRetryChoice:${phone}`, VEHICLE_ID_CHOICE_TTL);

/**
 * Reports whether the document-processing retry button was shown to this phone within the current session.
 */
export const wasDocumentRetryChoiceShown = (phone: string): Promise<boolean> => hasKey(`documentRetryChoice:${phone}`);

/**
 * Clears the document-processing retry button's shown flag for this phone.
 */
export const clearDocumentRetryChoice = (phone: string): Promise<void> => deleteKey(`documentRetryChoice:${phone}`);

// --- Waitlist / restock / service / stock-unavailable offers ---------------

type WaitlistOffer = { productId: number; productName: string; query?: string };

/**
 * Stores the out-of-stock product a customer was just offered to join the waitlist for, awaiting their yes/no reply.
 */
export const savePendingWaitlistOffer = (phone: string, offer: WaitlistOffer): Promise<void> => setJSON(`waitlist:${phone}`, offer);

/**
 * Retrieves the pending waitlist offer for a phone, if one is still awaiting a reply.
 */
export const getPendingWaitlistOffer = (phone: string): Promise<WaitlistOffer | null> => getJSON(`waitlist:${phone}`);

/**
 * Removes the pending waitlist offer for a phone once the customer has replied.
 */
export const clearPendingWaitlistOffer = (phone: string): Promise<void> => deleteKey(`waitlist:${phone}`);

export interface PendingBasketWaitlistOffer {
  candidates: { productId: number; productName: string }[];
}

/**
 * Stores the set of out-of-stock products a customer was just offered a
 * single consolidated waitlist opt-in for, after every item in a multi-part
 * search came back unavailable — see product.service.ts's advanceBasket.
 */
export const savePendingBasketWaitlistOffer = (phone: string, offer: PendingBasketWaitlistOffer): Promise<void> =>
  setJSON(`basketWaitlist:${phone}`, offer);

/**
 * Retrieves the pending consolidated basket-waitlist offer for a phone, if one is still awaiting a reply.
 */
export const getPendingBasketWaitlistOffer = (phone: string): Promise<PendingBasketWaitlistOffer | null> =>
  getJSON(`basketWaitlist:${phone}`);

/**
 * Removes the pending consolidated basket-waitlist offer for a phone once the customer has replied.
 */
export const clearPendingBasketWaitlistOffer = (phone: string): Promise<void> => deleteKey(`basketWaitlist:${phone}`);

type RestockOrderOffer = { productId: number; productName: string };

/**
 * Stores the restocked product a waitlisted customer was just offered to order, awaiting their yes/no reply.
 */
export const savePendingRestockOrderOffer = (phone: string, offer: RestockOrderOffer): Promise<void> =>
  setJSON(`restockOrder:${phone}`, offer);

/**
 * Retrieves the pending restock-order offer for a phone, if one is still awaiting a reply.
 */
export const getPendingRestockOrderOffer = (phone: string): Promise<RestockOrderOffer | null> => getJSON(`restockOrder:${phone}`);

/**
 * Removes the pending restock-order offer for a phone once the customer has replied.
 */
export const clearPendingRestockOrderOffer = (phone: string): Promise<void> => deleteKey(`restockOrder:${phone}`);

export interface PendingServiceOffer {
  // Set when the order already exists (the restock-reorder path, which
  // creates its order immediately since the product was already fully
  // resolved by the earlier restock notification — see
  // product.service.ts's startOrderForProduct/processRestockOrderChoice).
  // Absent while building a search-results-driven basket (single- or
  // multi-item — see PendingBasket), where no order exists yet and a
  // selection is appended to the basket instead.
  orderNumber?: string;
  product: Product;
  services: Service[];
}

/**
 * Stores the add-on services list offered alongside a newly ordered product, awaiting the customer's selection or skip.
 */
export const savePendingServiceOffer = (phone: string, offer: PendingServiceOffer): Promise<void> =>
  setJSON(`serviceOffer:${phone}`, offer);

/**
 * Retrieves the pending service-offer for a phone, if one is still awaiting a selection.
 */
export const getPendingServiceOffer = (phone: string): Promise<PendingServiceOffer | null> => getJSON(`serviceOffer:${phone}`);

/**
 * Removes the pending service-offer for a phone once the customer has made a selection.
 */
export const clearPendingServiceOffer = (phone: string): Promise<void> => deleteKey(`serviceOffer:${phone}`);

export interface PendingStockUnavailableOffer {
  orderNumber: string;
  productId: number;
  productName: string;
}

/**
 * Stores the order whose stock just turned out to be unavailable,
 * awaiting the customer's choice between an alternative search or the waitlist.
 */
export const savePendingStockUnavailableOffer = (phone: string, offer: PendingStockUnavailableOffer): Promise<void> =>
  setJSON(`stockUnavailable:${phone}`, offer);

/**
 * Retrieves the pending stock-unavailable offer for a phone, if one is still awaiting a reply.
 */
export const getPendingStockUnavailableOffer = (phone: string): Promise<PendingStockUnavailableOffer | null> =>
  getJSON(`stockUnavailable:${phone}`);

/**
 * Removes the pending stock-unavailable offer for a phone once the customer has replied.
 */
export const clearPendingStockUnavailableOffer = (phone: string): Promise<void> => deleteKey(`stockUnavailable:${phone}`);

// --- Locale and humanize-layer context --------------------------------------

/**
 * Caches the detected conversation locale for a phone, so subsequent
 * customer-facing replies this session use the same language.
 */
export const saveLocale = (phone: string, locale: 'pt' | 'en'): Promise<void> => setString(`locale:${phone}`, locale);

/**
 * Retrieves the cached conversation locale for a phone, or null if none has been detected yet this session.
 */
export async function getLocale(phone: string): Promise<'pt' | 'en' | null> {
  const data = await getString(`locale:${phone}`);
  return data === 'pt' || data === 'en' ? data : null;
}

/**
 * Caches the customer's most recent inbound message text, used as context for the humanize layer's contextual rewrites.
 */
export const saveLastMessage = (phone: string, text: string): Promise<void> => setString(`lastmsg:${phone}`, text);

/**
 * Retrieves the customer's most recently cached inbound message text.
 */
export const getLastMessage = (phone: string): Promise<string | null> => getString(`lastmsg:${phone}`);

/**
 * Caches a customer's first name, used as context for the humanize layer's contextual rewrites.
 */
export const saveCustomerName = (phone: string, name: string): Promise<void> => setString(`custname:${phone}`, name);

/**
 * Retrieves a customer's cached first name.
 */
export const getCustomerName = (phone: string): Promise<string | null> => getString(`custname:${phone}`);

const HUMANIZE_CACHE_TTL = 60 * 60 * 24;

/**
 * Retrieves a previously cached Claude-humanized rewrite by its cache key.
 */
export const getHumanized = (key: string): Promise<string | null> => getString(key);

/**
 * Caches a Claude-humanized rewrite under its cache key for 24 hours, so repeat inputs skip a fresh API call.
 */
export const saveHumanized = (key: string, value: string): Promise<void> => setString(key, value, HUMANIZE_CACHE_TTL);

/**
 * Clears all cached humanized rewrites from both stores.
 */
export const clearHumanizeCache = (): Promise<void> => deleteByPrefix('humanized:');

// --- Validation retry counters ----------------------------------------------

/**
 * Retrieves how many consecutive times a customer's reply has failed
 * validation for a given field this session (0 if none yet).
 */
export async function getValidationAttempts(phone: string, field: string): Promise<number> {
  const data = await getString(`valattempts:${field}:${phone}`);
  return data ? parseInt(data, 10) : 0;
}

/**
 * Increments and returns the consecutive-failed-validation count for a
 * phone/field, used to cap retries before accepting the value with a
 * needs_review flag instead of re-asking forever.
 */
export async function incrementValidationAttempts(phone: string, field: string): Promise<number> {
  const next = (await getValidationAttempts(phone, field)) + 1;
  await setString(`valattempts:${field}:${phone}`, String(next));
  return next;
}

/**
 * Resets the consecutive-failed-validation count for a phone/field, called
 * once a reply passes validation or the field is accepted with a flag.
 */
export const clearValidationAttempts = (phone: string, field: string): Promise<void> => deleteKey(`valattempts:${field}:${phone}`);

// --- Auth token revocation --------------------------------------------------

/**
 * Builds the cache key for a revoked-token blacklist entry, hashing the
 * raw token so it's never stored in plain text.
 */
function revokedTokenKey(token: string): string {
  return `revokedToken:${createHash('sha1').update(token).digest('hex')}`;
}

/**
 * Blacklists a JWT (access or refresh) for the remainder of its natural
 * lifetime, so a logged-out token can no longer be used.
 */
export async function revokeToken(token: string, ttlSeconds: number): Promise<void> {
  if (ttlSeconds <= 0) return;
  await setFlag(revokedTokenKey(token), ttlSeconds);
}

/**
 * Checks whether a JWT has been blacklisted via revokeToken.
 */
export const isTokenRevoked = (token: string): Promise<boolean> => hasKey(revokedTokenKey(token));

// --- Webhook idempotency ----------------------------------------------------

// Meta retries a webhook delivery it didn't see acknowledged in time, and can
// occasionally deliver the same message twice regardless. A day comfortably
// covers its retry window without the keyspace growing unbounded.
const INBOUND_MESSAGE_DEDUPE_TTL = 60 * 60 * 24;

/**
 * Atomically records an inbound WhatsApp message id as processed. Returns
 * true the first time a given id is seen, false for any duplicate delivery —
 * the caller should drop duplicates without running the pipeline again.
 */
export const claimInboundMessage = (messageId: string): Promise<boolean> =>
  claimKey(`inboundMsg:${messageId}`, INBOUND_MESSAGE_DEDUPE_TTL);

// --- Admin alert throttling -------------------------------------------------

// A deactivated customer often keeps messaging; without a throttle every
// single message pushed a WhatsApp alert to every admin.
const INACTIVE_CUSTOMER_ALERT_TTL = 60 * 60 * 6;

/**
 * Returns true at most once per INACTIVE_CUSTOMER_ALERT_TTL window per
 * phone — gates the "inactive customer tried to message" admin push.
 */
export const claimInactiveCustomerAlert = (phone: string): Promise<boolean> =>
  claimKey(`inactiveAlert:${phone}`, INACTIVE_CUSTOMER_ALERT_TTL);

// --- Supplier inquiry (zero-results fallback) ---------------------------------

export interface SupplierInquiry {
  query: string; // what the customer searched for, forwarded to the admins
}

/**
 * Stores the "should our team check with suppliers?" offer sent after a
 * search found nothing at all.
 */
export const savePendingSupplierInquiryOffer = (phone: string, inquiry: SupplierInquiry): Promise<void> =>
  setJSON(`supplierInquiryOffer:${phone}`, inquiry);

/**
 * Retrieves the pending supplier-inquiry offer, if any.
 */
export const getPendingSupplierInquiryOffer = (phone: string): Promise<SupplierInquiry | null> =>
  getJSON(`supplierInquiryOffer:${phone}`);

/**
 * Removes the pending supplier-inquiry offer once answered.
 */
export const clearPendingSupplierInquiryOffer = (phone: string): Promise<void> =>
  deleteKey(`supplierInquiryOffer:${phone}`);

/**
 * Marks that the customer accepted the offer and the bot is waiting for a
 * part photo or reference to forward to the team.
 */
export const saveAwaitingSupplierInquiryDetails = (phone: string, inquiry: SupplierInquiry): Promise<void> =>
  setJSON(`supplierInquiryDetails:${phone}`, inquiry);

/**
 * Retrieves the inquiry still waiting for its photo/reference, if any.
 */
export const getAwaitingSupplierInquiryDetails = (phone: string): Promise<SupplierInquiry | null> =>
  getJSON(`supplierInquiryDetails:${phone}`);

/**
 * Clears the waiting-for-details state once the inquiry was forwarded.
 */
export const clearAwaitingSupplierInquiryDetails = (phone: string): Promise<void> =>
  deleteKey(`supplierInquiryDetails:${phone}`);

// Search-related session state wiped by resetSearchSession. Deliberately
// excludes anything tied to an order already in progress (orderProfile*,
// altOffer/altResolution, stockUnavailable, restockOrder) and the
// conversation-wide keys (locale, custname, lastmsg, chatlog, activePrompt).
const SEARCH_SESSION_KEYS = [
  'active', 'partPrompt', 'chosenVehicle', 'vehicleChoice', 'deferredPartRequest',
  'options', 'basket', 'partTypeChoice', 'waitlist', 'basketWaitlist', 'serviceOffer',
  'supplierInquiryOffer', 'supplierInquiryDetails',
];

/**
 * Ends the current search conversation — e.g. after a "nothing found" reply
 * the customer closed with a thank-you — so their next message starts fresh:
 * with the `active:` key gone it's handled as a new session (a greeting gets
 * the main menu, a real request is processed from scratch), and no stale
 * offer, results list or chosen vehicle from the old search can catch it.
 */
export async function resetSearchSession(phone: string): Promise<void> {
  await Promise.all(SEARCH_SESSION_KEYS.map((prefix) => deleteKey(`${prefix}:${phone}`)));
}

// A "thanks" -> "You're welcome" -> "ok" chain must not keep answering
// itself, but a thank-you after a later, separate exchange deserves a reply.
const COURTESY_REPLY_TTL = 60 * 10;

/**
 * Returns true at most once per COURTESY_REPLY_TTL window per phone — gates
 * the "You're welcome" reply to a pure courtesy message (thanks / okay).
 */
export const claimCourtesyReply = (phone: string): Promise<boolean> =>
  claimKey(`courtesyReply:${phone}`, COURTESY_REPLY_TTL);

// --- Chat transcript --------------------------------------------------------

export interface ChatLogEntry {
  direction: 'in' | 'out';
  text: string;
  at: string;
}

const CHAT_LOG_TTL = 60 * 60 * 25;

/**
 * Appends a message (inbound customer text or outbound bot reply) to the
 * phone's chat transcript. The 25h TTL is a fixed window from the FIRST
 * message that started it, not a sliding one — later messages in the same
 * window are appended without touching the expiry, so the whole log expires
 * exactly 25h after it started regardless of how active the conversation
 * stays. Once it expires, the next message starts a brand-new 25h window.
 */
export async function appendChatMessage(phone: string, direction: 'in' | 'out', text: string): Promise<void> {
  const key = `chatlog:${phone}`;
  const entry: ChatLogEntry = { direction, text, at: new Date().toISOString() };

  // -2 = key missing, -1 = no TTL (shouldn't happen) — either way, start a fresh window.
  if ((await getTTL(key)) < 0) {
    await setJSON(key, [entry], CHAT_LOG_TTL);
    return;
  }

  const messages = (await getJSON<ChatLogEntry[]>(key)) ?? [];
  messages.push(entry);
  await setStringKeepTTL(key, JSON.stringify(messages), CHAT_LOG_TTL);
}

/**
 * Retrieves the phone's rolling 25h chat transcript, oldest first, or an
 * empty array if there's none yet or it's expired.
 */
export async function getChatLog(phone: string): Promise<ChatLogEntry[]> {
  return (await getJSON<ChatLogEntry[]>(`chatlog:${phone}`)) ?? [];
}
