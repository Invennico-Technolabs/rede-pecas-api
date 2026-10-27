import { resolveLocale } from './customer.service.js';
import { humanize, HumanizeOptions, INTERACTIVE_BODY_LIMIT, TEXT_BODY_LIMIT } from './humanize.service.js';
import { sendWhatsAppMessage, sendWhatsAppButtons, sendWhatsAppList, sendWhatsAppLocationRequest } from './whatsapp.service.js';
import { saveActivePromptId } from './session.service.js';


export type ReplyOptions = Omit<HumanizeOptions, 'locale' | 'phone' | 'maxLength'>;

/**
 * Resolves the customer's locale and runs a canned message body through
 * the humanize layer with the given body-size limit before it's sent.
 */
async function rewrite(
  phone: string,
  body: string,
  limit: number,
  opts?: ReplyOptions
): Promise<string> {
  return humanize(body, {
    ...opts,
    phone,
    locale: await resolveLocale(phone),
    maxLength: limit,
  });
}

/**
 * Sends a plain text WhatsApp message to a customer, humanizing the body
 * text first.
 */
export async function sendReply(phone: string, text: string, opts?: ReplyOptions): Promise<any> {
  return sendWhatsAppMessage(phone, await rewrite(phone, text, TEXT_BODY_LIMIT, opts));
}

/**
 * Sends a WhatsApp interactive button message to a customer, humanizing
 * the body first, and remembers the sent message's id as the active prompt
 * for this phone. `media` optionally attaches an image/document header
 * (e.g. the final invoice PDF alongside the Order Status button) without
 * bypassing the dedupe/active-prompt tracking a raw whatsapp.service.ts call would.
 */
export async function sendReplyButtons(
  phone: string,
  body: string,
  buttons: string[],
  ids?: string[],
  media?: { type: 'image' | 'document'; id: string; filename?: string },
  opts?: ReplyOptions
): Promise<any> {
  const res = await sendWhatsAppButtons(phone, await rewrite(phone, body, INTERACTIVE_BODY_LIMIT, opts), buttons, ids, media);
  await saveActivePromptId(phone, res?.messages?.[0]?.id);
  return res;
}

/**
 * Sends WhatsApp's native "Send location" request to a customer, humanizing
 * the body first. Not tracked as the active prompt: the reply is a
 * `location` message, which the stale-tap check never applies to.
 */
export async function sendReplyLocationRequest(phone: string, body: string, opts?: ReplyOptions): Promise<any> {
  return sendWhatsAppLocationRequest(phone, await rewrite(phone, body, INTERACTIVE_BODY_LIMIT, opts));
}

/**
 * Sends a WhatsApp List Message to a customer, humanizing the body first,
 * and remembers the sent message's id as the active prompt for this phone.
 */
export async function sendReplyList(
  phone: string,
  body: string,
  buttonText: string,
  rows: { id: string; title: string; description?: string }[],
  opts?: ReplyOptions
): Promise<any> {
  const res = await sendWhatsAppList(phone, await rewrite(phone, body, INTERACTIVE_BODY_LIMIT, opts), buttonText, rows);
  await saveActivePromptId(phone, res?.messages?.[0]?.id);
  return res;
}
