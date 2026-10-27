import { logger } from '../config/logger.js';
import { config } from '../config/config.js';
import { capitalize } from '../utils/helpers.js';
import {
  getCustomerVehicles,
  getMostRecentVehicle,
  saveVehicleSession,
  clearVehicleSession,
  getActiveManualCollection,
  updateManualCollection,
  startManualCollection,
  getNhtsaVehicle,
  saveNhtsaVehicle,
  VehicleSession,
} from '../models/vehicle.model.js';
import { downloadWhatsAppMedia, sendWhatsAppButtons } from './whatsapp.service.js';
import { saveDocument } from './storage.service.js';
import { sendReply, sendReplyButtons } from './reply.service.js';
import { extractBoldTerms } from './humanize.service.js';
import { extractDataWithClaudeVision, extractVehicleDetails, VisionData } from './ai.service.js';
import { completeOnboardingIfNeeded, resolveMessages, Customer } from './customer.service.js';
import { beginPartTypeChoice } from './product.service.js';
import {
  markPartPromptSent,
  savePendingVehicleChoice,
  getPendingVehicleChoice,
  clearPendingVehicleChoice,
  saveChosenVehicle,
  getChosenVehicle,
  saveDeferredPartRequest,
  getDeferredPartRequest,
  clearDeferredPartRequest,
  markVehicleIdChoiceShown,
  clearVehicleIdChoiceShown,
  markVinDuplicateChoiceShown,
  clearVinDuplicateChoice,
  markDocumentRetryChoiceShown,
  clearDocumentRetryChoice,
  markVehicleConfirmShown,
  wasVehicleConfirmShown,
  clearVehicleConfirmShown,
  markVinDecodeFailedShown,
  getVinDecodeFailedVin,
  clearVinDecodeFailedChoice,
  saveActivePromptId,
  incrementValidationAttempts,
  clearValidationAttempts,
} from './session.service.js';
import {
  validateFreeText,
  isPlausibleYear,
  isPlausibleEngineNumber,
  isPlausibleLicensePlate,
  isValidVinChecksum,
  flagForReview,
  MAX_VALIDATION_ATTEMPTS,
} from './validation.service.js';

export { getActiveManualCollection, startManualCollection };

/**
 * Sends the numbered "which vehicle is this for?" menu (even for a single
 * vehicle, so the customer can say it's for a different car) and holds the
 * list as the pending choice for resolvePendingVehicleChoice.
 */
async function sendVehicleChoicePrompt(phone: string, vehicles: VehicleSession[], greeting?: { name: string }): Promise<void> {
  const messages = await resolveMessages(phone);
  await savePendingVehicleChoice(phone, vehicles.map(v => ({ id: v.id, make: v.make, model: v.model, year: v.year })));
  const chooseBody = messages.vehicleConfirm.chooseVehiclePrompt(vehicles, greeting?.name);
  // The "➕ Add vehicle" button means a customer whose query is for a car not
  // in the list isn't stuck re-typing a number — the tap is caught by the
  // add-vehicle check (isAddVehicleRequest) before resolvePendingVehicleChoice
  // ever sees it.
  await sendReplyButtons(
    phone,
    chooseBody,
    [messages.vehicleConfirm.addVehicleButton()],
    undefined,
    undefined,
    { preserve: extractBoldTerms(chooseBody) }
  );
}

/**
 * Starts a part search for a customer with a confirmed vehicle on file by
 * first asking which vehicle it's for — the "what part do you need" prompt
 * follows the pick (resolvePendingVehicleChoice).
 */
export async function sendAskPartPrompt(phone: string, greeting?: { name: string }): Promise<boolean> {
  const vehicles = await getCustomerVehicles(phone);
  if (!vehicles.length) return false;

  await sendVehicleChoicePrompt(phone, vehicles, greeting);
  return true;
}

/**
 * Asks which vehicle a typed part request is for when none has been picked
 * yet this session, holding the request so the search resumes right after
 * the pick. Returns false (nothing sent) when a vehicle is already chosen or
 * the customer has none on file.
 */
export async function askVehicleChoiceForRequest(
  phone: string,
  customerText: string,
  customerName: string,
  productNames: string[] | null
): Promise<boolean> {
  if (await getChosenVehicle(phone)) return false;
  const vehicles = await getCustomerVehicles(phone);
  if (!vehicles.length) return false;

  await saveDeferredPartRequest(phone, { customerText, customerName, productNames });
  await sendVehicleChoicePrompt(phone, vehicles);
  return true;
}

/**
 * Resolves a customer's reply to the "which vehicle is this for?" prompt,
 * remembering the chosen vehicle, then either resuming the part request
 * that was waiting on this choice or sending the part-search prompt.
 */
export async function resolvePendingVehicleChoice(phone: string, reply: string): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const pending = await getPendingVehicleChoice(phone);
  if (!pending) return false;

  const idx = parseInt(reply.trim(), 10) - 1;
  const chosen = pending[idx];
  if (!chosen) {
    const notFoundBody = messages.vehicleConfirm.vehicleChoiceNotFound();
    await sendReply(phone, notFoundBody, { preserve: extractBoldTerms(notFoundBody) });
    return true;
  }

  await clearPendingVehicleChoice(phone);
  await saveChosenVehicle(phone, chosen.id);

  const deferred = await getDeferredPartRequest(phone);
  if (deferred) {
    await clearDeferredPartRequest(phone);
    await markPartPromptSent(phone);
    await beginPartTypeChoice(phone, deferred.customerText, deferred.customerName, deferred.productNames);
    return true;
  }

  await sendReplyButtons(
    phone,
    messages.vehicleConfirm.confirmedAskPart(chosen.make, chosen.model, chosen.year),
    [messages.vehicleConfirm.addVehicleButton()]
  );
  await markPartPromptSent(phone);
  return true;
}

/**
 * Reports whether a customer has at least one confirmed vehicle on file.
 */
export async function hasVehicleOnFile(phone: string): Promise<boolean> {
  return (await getCustomerVehicles(phone)).length > 0;
}

const ADD_VEHICLE_TRIGGERS = ['outro carro', 'add vehicle', 'novo carro', 'adicionar carro'];

/**
 * Checks whether a free-text message is a customer asking to add another
 * vehicle to their account.
 */
export function isAddVehicleRequest(text: string): boolean {
  const r = text.trim().toLowerCase();
  return ADD_VEHICLE_TRIGGERS.some((trigger) => r.includes(trigger));
}

/**
 * Re-shows the vehicle-ID entry option buttons (VIN/photo/manual) for a
 * customer adding another vehicle to their account.
 */
export async function startAddVehicleFlow(phone: string): Promise<void> {
  // Drop any unanswered "which vehicle is this for?" menu — otherwise its
  // pending choice would intercept the new vehicle's Sim/Não confirmation
  // as an invalid vehicle number and re-ask forever. A typed request that was
  // waiting on that choice is dropped too — it was for a car not on file.
  await clearPendingVehicleChoice(phone);
  await clearDeferredPartRequest(phone);
  const messages = await resolveMessages(phone);
  await sendReplyButtons(phone, messages.vehicleConfirm.addVehicleBody(), messages.onboarding.askVehicleIdButtons);
  await markVehicleIdChoiceShown(phone);
}

const NHTSA_URL = config.nhtsa.apiUrl;

export interface VINInfo {
  vin: string;
  make: string;
  model: string | null;
  year: string;
  vehicle_type?: string | null;
  engine?: string | null;
  fuel_type?: string | null;
  manufacture_country?: string | null;
}

/**
 * Checks whether a string is a syntactically valid 17-character VIN
 * (excluding the letters I, O, and Q).
 */
export function isVIN(text: string): boolean {
  const vin = text.trim().toUpperCase();
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
}

/**
 * Loosely checks whether a string looks like an attempted VIN (10-20
 * alphanumeric characters), used to decide whether a failed strict VIN match
 * still deserves VIN-specific handling.
 */
export function looksLikeVinAttempt(text: string): boolean {
  return /^[A-Za-z0-9]{10,20}$/.test(text.trim());
}

/**
 * Resolves a VIN to vehicle details, serving a cached NHTSA lookup when
 * available or querying the NHTSA decode API and caching a successful
 * result, returning null if the VIN can't be decoded.
 */
export async function decodeVIN(vin: string): Promise<VINInfo | null> {
  const vinClean = vin.toUpperCase();

  const cached = await getNhtsaVehicle(vinClean);
  if (cached) {
    logger.info(`[NHTSA] Cache hit for VIN ${vinClean}`);
    return {
      vin: cached.vin,
      make: cached.make,
      model: cached.model,
      year: cached.year,
      vehicle_type: cached.vehicle_type,
      engine: cached.engine,
      fuel_type: cached.fuel_type,
      manufacture_country: cached.manufacture_country,
    };
  }

  try {
    const res = await fetch(
      `${NHTSA_URL}/${vinClean}?format=json`,
      { signal: AbortSignal.timeout(8000) }
    );

    const data = await res.json() as any;
    if (!data?.Results) return null;

    const extract = (variable: string) =>
      data.Results.find((r: any) => r.Variable === variable)?.Value || null;

    const make = extract("Make");
    const model = extract("Model");
    const year = extract("Model Year");
    const vehicleType = extract("Body Class");
    const displacement = extract("Displacement (L)");
    const fuelType = extract("Fuel Type - Primary");
    const country = extract("Plant Country");
    const errors = extract("Error Text");

    if (!make || !year || errors?.includes("No candidates")) {
      logger.warn(`[NHTSA] No match for VIN ${vin}${errors ? `: ${errors}` : ''}`);
      return null;
    }

    logger.info(`[NHTSA] Decoded VIN ${vin}: ${make} ${model || '(model unresolved)'} ${year}`);

    const result: VINInfo = {
      vin: vinClean,
      make: capitalize(make),
      model: model ? capitalize(model) : null,
      year: year,
      vehicle_type: vehicleType || null,
      engine: displacement ? `${displacement}L` : null,
      fuel_type: translateFuelType(fuelType),
      manufacture_country: country || null,
    };

    if (result.model) {
      await saveNhtsaVehicle(result.vin, result as { model: string } & VINInfo);
    }

    return result;

  } catch (error: any) {
    logger.error(`[VIN] Error decoding chassis ${vin}: ${error.message}`);
    return null;
  }
}

/**
 * Translates an NHTSA fuel-type string into its Portuguese equivalent,
 * leaving unrecognized values unchanged.
 */
function translateFuelType(fuelType: string | null): string | null {
  if (!fuelType) return null;
  const map: { [key: string]: string } = {
    "Gasoline": "Gasolina",
    "Diesel": "Diesel",
    "Electric": "Eléctrico",
    "Hybrid": "Híbrido",
    "Flex Fuel": "Flex (gasolina/etanol)",
    "Natural Gas": "Gás Natural",
  };
  return map[fuelType] || fuelType;
}

/**
 * Handles a customer's tap on the vehicle-ID entry option buttons,
 * routing them into the VIN prompt, photo prompt, or manual-collection wizard.
 */
export async function processVehicleIdOptionChoice(phone: string, reply: string): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const r = reply.toLowerCase();

  if (r.includes('vin')) {
    await sendReply(phone, messages.vin.askVinPrompt());
    return true;
  }

  if (r.includes('foto') || r.includes('photo') || r.includes('documento')) {
    await sendReply(phone, messages.document.askPhotoPrompt());
    return true;
  }

  if (r.includes('manual')) {
    await clearVehicleIdChoiceShown(phone);
    await startManualCollection(phone, 'awaiting_make');
    const askMake = messages.manual.askMakePrompt();
    await sendReply(phone, askMake, { preserve: extractBoldTerms(askMake) });
    return true;
  }

  return false;
}

/**
 * Handles a customer's reply to the "this VIN is already registered"
 * prompt, routing them to a part search or into adding a different vehicle,
 * or re-asking if the reply doesn't match either option.
 */
export async function processVinDuplicateChoice(phone: string, reply: string): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const r = reply.toLowerCase();

  if (r.includes('procurar') || r.includes('search') || r.includes('peça') || r.includes('part') || r === '1' || r.includes('btn_0')) {
    await clearVinDuplicateChoice(phone);
    await clearVehicleIdChoiceShown(phone);
    await sendAskPartPrompt(phone);
    return true;
  }

  if (r.includes('diferente') || r.includes('different') || r.includes('adicionar') || r.includes('add') || r === '2' || r.includes('btn_1')) {
    await clearVinDuplicateChoice(phone);
    await startAddVehicleFlow(phone);
    return true;
  }

  const alreadyRegisteredRes = await sendWhatsAppButtons(phone, messages.common.notUnderstood(), messages.vin.alreadyRegisteredButtons);
  await saveActivePromptId(phone, alreadyRegisteredRes?.messages?.[0]?.id);
  await markVinDuplicateChoiceShown(phone);
  return true;
}

type ManualVehicleField = 'make' | 'model' | 'year';
type ManualVehicleDetails = Record<ManualVehicleField, string | null>;

const MANUAL_VEHICLE_FIELDS: ManualVehicleField[] = ['make', 'model', 'year'];

const MANUAL_STEP_FIELD: Record<string, ManualVehicleField> = {
  awaiting_make: 'make',
  awaiting_model: 'model',
  awaiting_year: 'year',
};

const MANUAL_FIELD_VALIDATION_KEY: Record<ManualVehicleField, 'vehicleMake' | 'vehicleModel' | 'vehicleYear'> = {
  make: 'vehicleMake',
  model: 'vehicleModel',
  year: 'vehicleYear',
};

/**
 * Normalizes and validates one manual-entry vehicle field. Returns the clean
 * value to store, or null to drop it. Only the field the current step asked
 * for is strict — an invalid value is re-asked (up to MAX_VALIDATION_ATTEMPTS,
 * then flagged and accepted, as before) and `'reask'` is returned; a bonus
 * field the customer volunteered early is silently dropped when invalid,
 * since its own step will ask for it anyway.
 */
async function validateManualVehicleField(
  phone: string,
  collectionId: number,
  field: ManualVehicleField,
  rawValue: string,
  details: ManualVehicleDetails,
  isStepField: boolean
): Promise<string | null | 'reask'> {
  const messages = await resolveMessages(phone);
  const value = field === 'year' ? rawValue.replace(/\D/g, '') : capitalize(rawValue);

  if (field === 'year' && !isPlausibleYear(value)) {
    if (!isStepField) return null;
    await sendReply(phone, messages.manual.invalidYear());
    return 'reask';
  }

  // Only what's known so far — "Mercedes Benz 2014" has no model yet, and a
  // literal "null" in the context made the year check reject a valid year.
  const context = field === 'model' ? details.make ?? undefined
    : field === 'year' ? [details.make, details.model].filter(Boolean).join(' ') || undefined
    : undefined;
  const validationKey = MANUAL_FIELD_VALIDATION_KEY[field];
  const result = await validateFreeText(validationKey, value, context);

  if (result.valid) {
    if (isStepField) await clearValidationAttempts(phone, validationKey);
    return value;
  }
  if (!isStepField) return null;

  const attempts = await incrementValidationAttempts(phone, validationKey);
  if (attempts < MAX_VALIDATION_ATTEMPTS) {
    const invalidMessage = field === 'make' ? messages.validation.invalidMake()
      : field === 'model' ? messages.validation.invalidModel()
      : messages.validation.invalidYear();
    await sendReply(phone, invalidMessage);
    return 'reask';
  }
  await flagForReview('vehicle', collectionId, field, result.reason || `Failed plausibility check after ${MAX_VALIDATION_ATTEMPTS} attempts: "${value}"`);
  return value;
}

/**
 * Handles a reply at the make / model / year step. The reply is run through
 * `extractVehicleDetails` first, so a customer who types the whole vehicle at
 * once ("Toyota Corolla ano 2009 motor 2ZR") has every field filled and the
 * steps they already answered skipped, instead of the whole sentence being
 * stored as the make. Only the missing fields are then asked for, in order
 * ("Mercedes Benz 2014" → only the model is asked; "Hilux 2012" → only the
 * make). The current step's field takes the extracted value; other fields
 * are only filled while still empty. If extraction fails or finds nothing
 * at all, the raw reply is the current step's field, as before.
 */
async function processManualVehicleDetails(
  phone: string,
  collection: any,
  reply: string,
  stepField: ManualVehicleField
): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const extracted = await extractVehicleDetails(reply);
  const candidates: ManualVehicleDetails = {
    make: extracted?.make ?? null,
    model: extracted?.model ?? null,
    year: extracted?.year ?? null,
  };
  // Raw-reply fallback only when nothing was extracted — if other fields
  // were found ("Hilux 2012" at the make step), keep them and just ask for
  // the missing one, rather than validating the whole reply as the make.
  if (!MANUAL_VEHICLE_FIELDS.some((field) => candidates[field])) candidates[stepField] = reply;

  const details: ManualVehicleDetails = {
    make: collection.make ?? null,
    model: collection.model ?? null,
    year: collection.year ?? null,
  };

  // make → model → year order matters: each one is validated in the context
  // of the fields before it (a model against its make, a year against both).
  for (const field of MANUAL_VEHICLE_FIELDS) {
    const candidate = candidates[field];
    const isStepField = field === stepField;
    if (!candidate || (!isStepField && details[field])) continue;

    const value = await validateManualVehicleField(phone, collection.id, field, candidate, details, isStepField);
    if (value === 'reask') return true;
    if (value) details[field] = value;
  }

  const nextStatus = !details.make ? 'awaiting_make'
    : !details.model ? 'awaiting_model'
    : !details.year ? 'awaiting_year'
    : 'awaiting_engine_number';
  await updateManualCollection(collection.id, { ...details, status: nextStatus });

  const prompt = nextStatus === 'awaiting_make' ? messages.manual.askMakePrompt()
    : nextStatus === 'awaiting_model' ? messages.manual.askModel(details.make!)
    : nextStatus === 'awaiting_year' ? messages.manual.askYear(details.make!, details.model!)
    : messages.manual.askEngineNumber(details.make!, details.model!, details.year!);
  await sendReply(phone, prompt, { preserve: extractBoldTerms(prompt) });
  return true;
}

/**
 * Advances the manual vehicle-entry step machine (make → model → year →
 * engine number) based on the collection's current status, skipping any
 * step the customer already answered, and saves the vehicle and completes
 * onboarding once all steps are done.
 */
export async function processManualCollectionStep(
  phone: string,
  collection: any,
  reply: string,
  customer: Customer
): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const r = reply.trim();

  const stepField = MANUAL_STEP_FIELD[collection.status];
  if (stepField) return processManualVehicleDetails(phone, collection, r, stepField);

  if (collection.status === 'awaiting_engine_number') {
    // Strip straight/curly apostrophes so "don't know" and "dont know" both
    // match — the en prompt itself tells the customer to type "don't know",
    // which the old pt-only skip-phrase list never recognized, so it fell
    // through to engine-number validation and got rejected as invalid.
    const normalized = r.toLowerCase().replace(/['’]/g, '').trim();
    const SKIP_PHRASES = new Set([
      'não sei', 'nao sei', 'não', 'nao', 'n', 'skip',
      'dont know', 'do not know', 'idk', 'unknown', 'not sure',
    ]);
    const skipped = SKIP_PHRASES.has(normalized);

    let engineNumber: string | null = null;
    if (!skipped) {
      const candidate = r.toUpperCase();
      if (!isPlausibleEngineNumber(candidate)) {
        const attempts = await incrementValidationAttempts(phone, 'engineNumber');
        if (attempts < MAX_VALIDATION_ATTEMPTS) {
          await sendReply(phone, messages.validation.invalidEngineNumber());
          return true;
        }
        await flagForReview('vehicle', collection.id, 'engine_number', `Failed format check after ${MAX_VALIDATION_ATTEMPTS} attempts: "${candidate}"`);
        engineNumber = candidate;
      } else {
        await clearValidationAttempts(phone, 'engineNumber');
        engineNumber = candidate;
      }
    }

    await saveVehicleSession(phone, {
      make: collection.make,
      model: collection.model,
      year: collection.year,
      engine_number: engineNumber,
    }, collection.id);

    // Unlike the VIN/photo paths, manual entry completes directly with no
    // Sim/Não confirm step (where saveChosenVehicle is normally called) — so
    // without this, a customer adding a 2nd+ vehicle via manual entry kept
    // searching against whichever vehicle was chosen before, not the one
    // they just finished adding.
    await saveChosenVehicle(phone, collection.id);

    const summary = [
      `🚗 *${collection.make} ${collection.model} ${collection.year}*`,
      engineNumber ? messages.manual.engineLabel(engineNumber) : null,
    ].filter(Boolean).join('\n');

    await clearVehicleIdChoiceShown(phone);

    const completedOnboarding = await completeOnboardingIfNeeded(phone, customer, summary);
    if (!completedOnboarding) {
      await sendReplyButtons(phone, messages.manual.collectionComplete(summary), [messages.vehicleConfirm.addVehicleButton()]);
      await markPartPromptSent(phone);
    }
    return true;
  }

  return false;
}

/**
 * Handles a detected 17-character VIN: short-circuits to the
 * already-registered flow if it matches an existing vehicle, otherwise decodes
 * it via NHTSA and either asks the customer to confirm the result or offers
 * the decode-failed fallback.
 */
export async function processVIN(phone: string, vin: string): Promise<void> {
  const messages = await resolveMessages(phone);
  const vinClean = vin.trim().toUpperCase();

  const existing = (await getCustomerVehicles(phone)).find((v) => v.vin === vinClean);
  if (existing) {
    const description = [
      `${existing.make} ${existing.model} ${existing.year}`,
      existing.engine_size || null,
      existing.fuel_type || null,
    ].filter(Boolean).join(' · ');

    await sendReplyButtons(phone, messages.vin.alreadyRegistered(description), messages.vin.alreadyRegisteredButtons);
    await saveChosenVehicle(phone, existing.id);
    await markVinDuplicateChoiceShown(phone);
    return;
  }

  await sendReply(phone, messages.vin.identifying());

  const vehicle = await decodeVIN(vinClean);

  if (!vehicle) {
    await sendReplyButtons(phone, messages.vin.decodeFailed(), messages.vin.decodeFailedButtons);
    await markVinDecodeFailedShown(phone, vinClean);
    return;
  }

  await saveVehicleSession(phone, {
    vin: vinClean,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    fuel_type: vehicle.fuel_type,
    engine_size: vehicle.engine,
  });

  if (!isValidVinChecksum(vinClean)) {
    // NHTSA still resolved this VIN, so we don't block the customer — the
    // check digit isn't reliably populated on non-US-market VINs — but we
    // flag it so staff can double-check for a transcription error.
    const saved = await getMostRecentVehicle(phone);
    if (saved) {
      await flagForReview('vehicle', saved.id, 'vin', `NHTSA decoded this VIN, but it failed the ISO 3779 check-digit verification: "${vinClean}"`);
    }
  }

  const description = [
    vehicle.model
      ? `${vehicle.make} ${vehicle.model} ${vehicle.year}`
      : `${vehicle.make} ${vehicle.year}`,
    vehicle.model ? null : messages.vin.modelUnknownNote(),
    vehicle.engine ? `${vehicle.engine}` : null,
    vehicle.fuel_type ? `${vehicle.fuel_type}` : null,
    vehicle.vehicle_type ? `${vehicle.vehicle_type}` : null,
  ].filter(Boolean).join(' · ');

  await sendReplyButtons(phone, messages.vin.confirmBody(description), messages.vin.confirmButtons);
  await markVehicleConfirmShown(phone);
}

/**
 * Handles a customer's reply to the VIN-decode-failed prompt, routing
 * them into manual collection or back to the vehicle-ID choice buttons, or
 * re-asking if the reply doesn't match either option.
 */
export async function processVinDecodeFailedChoice(phone: string, reply: string): Promise<boolean> {
  const attemptedVin = await getVinDecodeFailedVin(phone);
  if (attemptedVin === null) return false;

  const messages = await resolveMessages(phone);
  const r = reply.toLowerCase();

  if (r.includes('manual') || r === '2' || r.includes('btn_1')) {
    await clearVinDecodeFailedChoice(phone);
    await clearVehicleIdChoiceShown(phone);
    await startManualCollection(phone, 'awaiting_make', attemptedVin);
    const askMake = messages.manual.askMakePrompt();
    await sendReply(phone, askMake, { preserve: extractBoldTerms(askMake) });
    return true;
  }

  if (r.includes('tentar') || r.includes('try again') || r.includes('novamente') || r === '1' || r.includes('btn_0')) {
    await clearVinDecodeFailedChoice(phone);
    await sendReplyButtons(phone, messages.vin.restartChoiceBody(), messages.onboarding.askVehicleIdButtons);
    await markVehicleIdChoiceShown(phone);
    return true;
  }

  const decodeFailedRes = await sendWhatsAppButtons(phone, messages.common.notUnderstood(), messages.vin.decodeFailedButtons);
  await saveActivePromptId(phone, decodeFailedRes?.messages?.[0]?.id);
  await markVinDecodeFailedShown(phone, attemptedVin);
  return true;
}

/**
 * Sends a document-processing failure message along with retry/manual
 * buttons and marks that choice as shown.
 */
async function sendRetryOrManualPrompt(phone: string, body: string): Promise<void> {
  const messages = await resolveMessages(phone);
  await sendReplyButtons(phone, body, messages.document.retryButtons);
  await markDocumentRetryChoiceShown(phone);
}

/**
 * Downloads a vehicle document/VIN photo and runs it through Claude
 * Vision, cross-checking any extracted VIN against NHTSA, then either bounces
 * back a retry/manual prompt on failure or asks the customer to confirm the extracted vehicle.
 */
export async function processVehicleDocument(phone: string, mediaId: string): Promise<void> {
  const messages = await resolveMessages(phone);
  await sendReply(phone, messages.document.received());

  const imageBase64 = await downloadWhatsAppMedia(mediaId);
  if (!imageBase64) {
    await sendRetryOrManualPrompt(phone, messages.document.downloadFailed());
    return;
  }

  // Persist the photo locally (never kept before this) so it's still
  // reachable after Meta's ~30-day media id/URL expiry, without a second
  // Graph API round trip. WhatsApp photo uploads are always JPEG.
  await saveDocument(phone, 'vehicle_photo', Buffer.from(imageBase64, 'base64'), 'image/jpeg', null, mediaId);

  let extracted: VisionData | null;
  try {
    extracted = await extractDataWithClaudeVision(imageBase64);
  } catch (error: any) {
    logger.error(`[VISION] Error processing document for ${phone}: ${error.message}`);
    await sendRetryOrManualPrompt(phone, messages.document.processingError());
    return;
  }

  if (!extracted) {
    await sendRetryOrManualPrompt(phone, messages.document.notRecognized());
    return;
  }

  let make = extracted.make || null;
  let model = extracted.model || null;
  let year = extracted.year || null;
  let fuelType = extracted.fuel_type || null;
  let engineSize = extracted.engine_size || null;
  let nhtsaConfirmed = false;
  let chassisChecksumValid: boolean | null = null;

  if (extracted.chassis_number && isVIN(extracted.chassis_number)) {
    chassisChecksumValid = isValidVinChecksum(extracted.chassis_number);
    const decoded = await decodeVIN(extracted.chassis_number.toUpperCase());
    if (decoded) {
      // NHTSA wins for every field it actually resolved, but a partial
      // decode must not erase what was read off the document — non-US-market
      // VINs (e.g. Kia Sportage KNAP…, Toyota JP, VW DE) often come back as
      // make + year with a null model, which used to wipe the livrete's
      // "SPORTAGE" and fail with missingEssentialData every time.
      make = decoded.make || make;
      model = decoded.model || model;
      year = decoded.year || year;
      fuelType = decoded.fuel_type || fuelType;
      engineSize = decoded.engine || engineSize;
      nhtsaConfirmed = true;
    }
  }

  if (!extracted.valid && !nhtsaConfirmed) {
    logger.info(`[VISION] Document extraction invalid for ${phone}: ${extracted.reason || 'no reason given'}`);
    await sendRetryOrManualPrompt(phone, messages.document.invalid());
    return;
  }

  if (!make || !model) {
    logger.info(
      `[VISION] Missing make/model for ${phone}: vision make="${extracted.make}" model="${extracted.model}" ` +
      `chassis="${extracted.chassis_number}" nhtsaDecoded=${nhtsaConfirmed} -> make="${make}" model="${model}"`
    );
    await sendRetryOrManualPrompt(phone, messages.document.missingEssentialData());
    return;
  }

  // Non-essential extracted fields are discarded (not retried) when
  // implausible, same treatment as a missing field — there's no
  // photo-retry loop for a single bad field once make/model are in hand.
  if (year && !isPlausibleYear(year)) {
    logger.info(`[VISION] Implausible year extracted for ${phone}, discarding: "${year}"`);
    year = null;
  }

  let engineNumber = extracted.engine_number || null;
  if (engineNumber && !isPlausibleEngineNumber(engineNumber)) {
    logger.info(`[VISION] Implausible engine number extracted for ${phone}, discarding: "${engineNumber}"`);
    engineNumber = null;
  }

  let licensePlate = extracted.license_plate || null;
  if (licensePlate && !isPlausibleLicensePlate(licensePlate)) {
    logger.info(`[VISION] Implausible license plate extracted for ${phone}, discarding: "${licensePlate}"`);
    licensePlate = null;
  }

  await saveVehicleSession(phone, {
    vin: extracted.chassis_number || null,
    make,
    model,
    year: year || null,
    fuel_type: fuelType,
    engine_size: engineSize,
    engine_number: engineNumber,
    license_plate: licensePlate,
  });

  if (nhtsaConfirmed && chassisChecksumValid === false) {
    // Same non-blocking treatment as the VIN-entry path — NHTSA already
    // confirmed this vehicle, so we flag rather than reject.
    const saved = await getMostRecentVehicle(phone);
    if (saved) {
      await flagForReview('vehicle', saved.id, 'vin', `NHTSA decoded this chassis number, but it failed the ISO 3779 check-digit verification: "${extracted.chassis_number}"`);
    }
  }

  const description = [
    `${make} ${model}${year ? ` ${year}` : ''}`,
    engineSize || null,
    fuelType || null,
    licensePlate ? messages.document.licensePlateLabel(licensePlate) : null,
    extracted.chassis_number ? messages.document.chassisLabel(extracted.chassis_number.toUpperCase()) : null,
  ].filter(Boolean).join(' · ');

  await sendReplyButtons(phone, messages.document.confirmBody(description), messages.vin.confirmButtons);
  await markVehicleConfirmShown(phone);
}

/**
 * Handles a customer's reply to the document-processing retry prompt,
 * routing them into manual collection or back to the photo-upload prompt, or
 * re-asking if the reply doesn't match either option.
 */
export async function processDocumentRetryChoice(phone: string, reply: string): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const r = reply.toLowerCase();

  if (r.includes('manual') || r === '2' || r.includes('btn_1')) {
    await clearDocumentRetryChoice(phone);
    await clearVehicleIdChoiceShown(phone);
    await startManualCollection(phone, 'awaiting_make');
    const askMake = messages.manual.askMakePrompt();
    await sendReply(phone, askMake, { preserve: extractBoldTerms(askMake) });
    return true;
  }

  if (r.includes('tentar') || r.includes('try again') || r.includes('novamente') || r === '1' || r.includes('btn_0')) {
    await clearDocumentRetryChoice(phone);
    await sendReply(phone, messages.document.askPhotoPrompt());
    return true;
  }

  const retryRes = await sendWhatsAppButtons(phone, messages.common.notUnderstood(), messages.document.retryButtons);
  await saveActivePromptId(phone, retryRes?.messages?.[0]?.id);
  await markDocumentRetryChoiceShown(phone);
  return true;
}

/**
 * Handles a customer's Sim/Não reply confirming a decoded/extracted
 * vehicle: on yes, saves the vehicle as chosen and completes onboarding or
 * moves to the part-search prompt; on no, deletes only that rejected vehicle
 * and restarts manual collection; otherwise re-asks the same confirmation.
 */
export async function processVehicleConfirmation(phone: string, reply: string, customer: Customer): Promise<boolean> {
  if (!(await wasVehicleConfirmShown(phone))) return false;

  const messages = await resolveMessages(phone);
  const r = reply.toLowerCase();

  if (r.includes('sim') || r.includes('yes') || r.includes('✅') || r === '1' || r.includes('btn_0')) {
    const v = await getMostRecentVehicle(phone);
    if (!v) return false;

    await saveChosenVehicle(phone, v.id);

    await clearVehicleIdChoiceShown(phone);
    await clearVehicleConfirmShown(phone);

    const summary = `🚗 *${v.make} ${v.model} ${v.year}*`;
    const completedOnboarding = await completeOnboardingIfNeeded(phone, customer, summary);
    if (!completedOnboarding) {
      await sendReplyButtons(
        phone,
        messages.vehicleConfirm.confirmedAskPart(v.make, v.model, v.year),
        [messages.vehicleConfirm.addVehicleButton()]
      );
      await markPartPromptSent(phone);
    }
    return true;
  }

  if (r.includes('não') || r.includes('nao') || r.includes('❌') || r === '2' || r.includes('btn_1')) {
    const rejected = await getMostRecentVehicle(phone);
    if (rejected) await clearVehicleSession(rejected.id);

    await clearVehicleIdChoiceShown(phone);
    await clearVehicleConfirmShown(phone);

    await startManualCollection(phone, 'awaiting_make');
    const askMake = messages.manual.askMakePrompt();
    await sendReply(phone, askMake, { preserve: extractBoldTerms(askMake) });
    return true;
  }

  const pending = await getMostRecentVehicle(phone);
  if (!pending) return false;
  const description = [pending.make, pending.model, pending.year].filter(Boolean).join(' ');
  const confirmRetryRes = await sendWhatsAppButtons(
    phone,
    `${messages.common.notUnderstood()}\n\n🚗 *${description}*`,
    messages.vin.confirmButtons
  );
  await saveActivePromptId(phone, confirmRetryRes?.messages?.[0]?.id);
  await markVehicleConfirmShown(phone);
  return true;
}
