# Web Chat Channel — Design (Phase 2)

> Status: **design, not implemented**. Written 2026-10-15 on branch `docs/web-chat-design`.
> Companion doc: [`META_WHATSAPP_SETUP.md`](./META_WHATSAPP_SETUP.md) (Meta account, templates, 24h window).

## 1. Goal and scope

The client wants the same "Xico Peças" conversation that runs on WhatsApp to also run inside the
website (`rede-pecas-website`). Same bot, same flows: registration, vehicle ID, part search, basket,
proforma, payment, order status.

**Principle: one bot brain, two channels.** The message pipeline (`processMessageFlow`) stays the
single source of truth. We add a second *transport* next to WhatsApp. We do not fork the flow and
do not write a second bot.

Out of scope:
- Rewriting the pipeline order or any state machine.
- Introducing a conversational AI agent. The five single-shot Claude calls stay as they are.
- Admin panel changes, except optional follow-ups listed in §14.

### Decisions already taken

| Topic | Decision |
|---|---|
| Web identity | **Phone number + one-time code (OTP)** sent over WhatsApp. A verified web user *is* the existing customer row: same profile, vehicles, orders. |
| Async messages (approval, invoice, stock, restock…) for a web customer | **Web chat history + WhatsApp fallback.** Always written to the web history; also sent on WhatsApp. |
| Doc location | This file, API repo. The website widget spec is §9. |

## 2. Why the current flow "breaks" on the web: coupling map

The pipeline assumes WhatsApp in four places. Every one of these must be handled; use this list as
the implementation checklist.

### 2.1 Identity = WhatsApp sender phone
- `receiveWebhookMessage` sets `phone = msg.from` (`src/controllers/whatsapp.controller.ts:63`).
- `customers.phone TEXT PRIMARY KEY`. `vehicles.phone`, `customer_documents.phone`,
  `orders.customer_phone` (`db/schema.sql:452`), and `waitlist_requests.customer_phone` (`:597`) all key off it.
- Every session key in `session.service.ts` is `<prefix>:<phone>`.
- `runSerialized(phone, …)` (`src/utils/keyedQueue.ts`) serializes per phone.
- `getAdminByPhone(phone)` decides the admin short-circuit.

**Consequence:** the web has no phone, so nothing works without one. That is why we chose phone + OTP:
once verified, *everything above works unchanged*. No schema change to the identity key.

### 2.2 Outbound sending is WhatsApp-only
- `src/services/whatsapp.service.ts`:
  - `sendWhatsAppMessage` (`:22`), `sendWhatsAppButtons` (`:118`, max 3, optional media header),
    `sendWhatsAppList` (`:176`, max 10 rows)
  - `sendTypingIndicator` (`:57`), `downloadWhatsAppMedia` (`:86`)
  - private `clampBody` (`:13`)
  - Each send also appends to the `chatlog:<phone>` transcript.
- `src/services/reply.service.ts`: `sendReply` / `sendReplyButtons` / `sendReplyList`. These humanize
  the text, then call the WhatsApp functions, and save the active prompt id. **About 110 customer-facing
  call sites already go through here**, which is the main reason this project is feasible.
- **Customer-facing direct calls that bypass `reply.service`** must move onto it (or onto the transport):

  | Location | What it sends |
  |---|---|
  | `src/services/customer.service.ts:54` | welcome message |
  | `src/services/payment.service.ts:192` | payment instructions |
  | `src/services/pdf.service.ts:300` | invoice notification |
  | `src/services/pdf.service.ts` `sendProformaWhatsApp` (`:211`) | raw Graph `fetch`: media upload + document message |
  | `src/services/pdf.service.ts` `sendFinalInvoiceWhatsApp` (`:270`) | raw Graph `fetch`: media upload |
  | `src/services/vehicle.service.ts` `:308`, `:554`, `:712`, `:768` | not-understood re-ask buttons, with active prompt saved by hand |
  | `src/controllers/whatsapp.controller.ts:325` | vehicle-ID re-ask buttons, with active prompt saved by hand |

- **Admin and supplier sends stay WhatsApp-only** and are not touched. These are:
  - `payment.service.ts` `:308` `:329` `:339` `:346` `:352` `:450` `:466`
  - `product.service.ts` `:549` `:582` `:645` `:681` `:1116` `:1126` `:1132` `:1136` `:1171`
  - `orderStatus.service.ts:58`
  - `adminAuth.service.ts:210`
  - `whatsapp.controller.ts:145`

### 2.3 Meta ids inside the flow
- **Stale-button check**:
  - `sendReplyButtons`/`sendReplyList` store Meta's returned `messages[0].id` via `saveActivePromptId`
    (`session.service.ts`).
  - The controller compares the tapped message's `context.id` with `getActivePromptId`
    (`whatsapp.controller.ts:182`). On a mismatch it replies `common.alreadyAnswered()`.
- **Inbound media**: `mediaId = msg.image?.id || msg.document?.id`.
  - The id is downloaded from Meta in `processVehicleDocument` (vehicle.service) and
    `processPaymentProof` (payment.service).
  - Files are saved under `storage/<phone>/` via `storage.service.ts` `saveDocument` / `getDocument`, keyed
    by `(phone, kind, media_id)`.
- **Payment proof id** is stored in `orders.payment_proof_media_id` (`db/schema.sql:498`). It is reused:
  - as the admin WhatsApp push header (`payment.service.ts:308`)
  - by `GET /v1/admin/orders/:number/payment/proof`, which serves the local copy first and then Meta
  - by `has_proof` in `order.model.ts`
- **Dedupe** uses the Meta message id: `claimInboundMessage(msg.id)` → `inboundMsg:<id>`.
- **Message types**: the controller branches on WhatsApp strings `'interactive'`, `'image'`, `'document'`, `'button'`.

### 2.4 Messages not triggered by an inbound customer message
Admin actions and background jobs do this. There is no "current request" to reply to:
1. **Courtesy sweep.** Every 60s (`src/index.ts:22`), `sendStockConfirmationCourtesyMessages` sends a message to
   customers whose stock check is overdue by 20 minutes or more.
2. **Admin approves** (panel `POST /orders/:number/review` or WhatsApp button): `approveOrder` →
   invoice PDF + `sendFinalInvoiceWhatsApp`.
3. **Admin rejects**: rejection message to the customer.
4. **Stock confirmed / unavailable** (panel or admin button): the outcome depends on the case.
   - Confirmed: proforma PDF via `confirmStockAndFinalizeOrder`.
   - Unavailable: alternatives via `markStockUnavailableAndOfferAlternative`.
   - Multi-item basket: `finalizeMultiItemOrderIfComplete`.
5. **In-person payment confirmed**: `confirmInPersonPayment` → `approveOrder`.
6. **Waitlist restock**: inventory import → `notifyWaitlistedCustomers` (buttons + pending restock offer).

A web customer may have closed the tab when any of these fire, so the design needs stored history and the
WhatsApp fallback (§8).

## 3. Core idea: a channel/transport abstraction

```
             ┌────────────── inbound ──────────────┐
  Meta webhook ─► WhatsApp adapter ─┐                │
                                    ├─► InboundMessage ─► runSerialized(phone) ─► processMessageFlow
  Web chat API ─► Web adapter ──────┘                                              │
                                                                                   ▼
                                                     reply.service (humanize, active prompt)
                                                                                   │
                                                          getTransport(channel) ◄──┘
                                                         ┌──────────┴──────────┐
                                                  WhatsAppTransport       WebTransport
                                                 (whatsapp.service)   (webchat_messages + SSE)
```

### 3.1 Types (new `src/channels/`)

```ts
export type Channel = 'whatsapp' | 'web';

export interface InboundMessage {
  channel: Channel;
  phone: string;                  // verified identity on both channels
  messageId: string;              // Meta msg.id | web clientMessageId (dedupe)
  kind: 'text' | 'interactive' | 'image' | 'document';
  text: string | null;            // text body, or the tapped button/row title
  buttonReplyId: string | null;
  listReplyId: string | null;
  contextMessageId: string | null; // prompt the tap belongs to (stale check)
  mediaId: string | null;          // Meta media id | 'web_<uuid>'
}

export interface ChannelTransport {
  sendText(phone: string, body: string): Promise<SentMessage>;
  sendButtons(phone: string, body: string, buttons: string[], ids?: string[], media?: MediaRef): Promise<SentMessage>;
  sendList(phone: string, body: string, buttonText: string, rows: ListRow[]): Promise<SentMessage>;
  sendDocument(phone: string, file: LocalFile, caption?: string): Promise<SentMessage>;
  downloadMedia(phone: string, mediaId: string): Promise<string | null>; // base64, same as today
  markTyping(inbound: InboundMessage): Promise<void>;
}

export interface SentMessage { messageId: string | null }
```

### 3.2 How the channel reaches `reply.service` without touching 110 call sites
- An `AsyncLocalStorage<{ channel: Channel }>` (`src/channels/context.ts`) is entered once per inbound message,
  around the `runSerialized(phone, …)` call.
- `reply.service` reads the channel from the context and picks the transport. **Call sites keep the same
  signatures** (`sendReply(phone, text)` etc.).
- With **no context** (sweeps, admin actions, restock), `reply.service` uses the async delivery policy (§8).
- The active-prompt save stays in `reply.service`; it simply takes `SentMessage.messageId` from whichever transport sent.

### 3.3 Refactor steps (no behaviour change for WhatsApp)
1. `WhatsAppTransport` wraps the existing `whatsapp.service.ts` functions. The Meta media upload currently
   duplicated inside `pdf.service.ts` moves into `whatsapp.service.ts` as `uploadWhatsAppMedia(file)`.
2. `receiveWebhookMessage` maps Meta's object → `InboundMessage`, enters the channel context, then calls
   `processMessageFlow(inbound)`.
3. `processMessageFlow` takes the `InboundMessage` instead of seven positional args. The WhatsApp string checks
   (`'interactive'`, `'image'`, `'document'`) become `inbound.kind` checks.
4. Move the direct customer sends in §2.2 onto `reply.service`. The vehicle/controller re-asks were calling
   `sendWhatsAppButtons` + `saveActivePromptId` by hand. They become `sendReplyButtons(..., { raw: true })` or
   similar, and must stay **un-humanized** where they currently are.
5. Add `sendReplyDocument` (proforma/invoice) to `reply.service`. `sendProformaWhatsApp` /
   `sendFinalInvoiceWhatsApp` call it instead of raw `fetch`.
6. `appendChatMessage` moves out of `whatsapp.service.ts` and into `reply.service`/the inbound adapter, so the
   transcript records both channels (with a `channel` field).

**Phase P1 is exactly this refactor, WhatsApp-only, shippable on its own.** Test it against the full
`TESTING.md` matrix before any web code lands.

## 4. Identity: phone + OTP login

### 4.1 Flow
1. The widget asks for the phone number. It is normalized to digits only, and `244` is prepended when the
   customer types a local 9-digit Angolan number (`9XX XXX XXX`). The result is the same format Meta's
   `msg.from` uses, so it matches the existing `customers.phone` rows.
2. `POST /v1/webchat/otp/request { phone }`:
   - Generate a 6-digit code. Store only its **hash** under `webotp:<phone>`, with a 5 min TTL.
   - Send it to that number on WhatsApp using an **Authentication template** (copy-code button). A plain
     free-form message is not used: it fails outside the 24h window (error 131047) and most web visitors
     will not have an open window.
   - Respond `200` the same way whether or not the phone is a known customer, so the endpoint can't be used to
     check which numbers are customers.
3. `POST /v1/webchat/otp/verify { phone, code }`:
   - At most 5 attempts per code (`webotp:attempts:<phone>`).
   - On success, delete the code and issue a **web-chat JWT** `{ phone, type: 'webchat' }` (e.g. 7-day expiry).
   - A new customer row is **not** created here. The pipeline's existing customer lookup/create (step 2) does
     that on the first chat message, exactly like WhatsApp.
4. Every `/v1/webchat/*` route except the two OTP routes requires that JWT (`webchatAuth` middleware).
   - `authMiddleware` (admin) must reject `type: 'webchat'` tokens, as it already rejects `type: 'refresh'`.
   - `webchatAuth` rejects anything that is not `type: 'webchat'`.

### 4.2 Rules and limits
- **Admin phones are blocked.** `getAdminByPhone(phone)` → `403` at OTP request. The admin short-circuit
  ignores plain admin text, so an admin would otherwise get a silent chat. Admins test with a non-admin phone,
  same as on WhatsApp.
- **Rate limits**, all via `cache.service` `claimKey`/`setString`:
  - OTP requests: 1 per 60s per phone, 5 per hour per phone, 20 per hour per IP.
  - Each OTP costs money (authentication template), so this is also cost protection.
- Inactive customers (`customers.active = false`) can log in. The pipeline already answers them with
  `accountInactive` and alerts admins, so behaviour is consistent with WhatsApp.
- **Dev/test:** with the Meta **test** number, authentication templates still require the recipient in the
  allowed-recipient list. Optionally add `WEBCHAT_OTP_DEV_BYPASS` (only honoured when `NODE_ENV !== 'production'`)
  that logs the code instead of sending it.

## 5. Web transport and API

### 5.1 Endpoints (`src/routes/v1/webchat.route.ts`, mounted at `/v1/webchat`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/otp/request` | none + rate limit | Send the login code |
| POST | `/otp/verify` | none + rate limit | Return the web-chat JWT |
| POST | `/messages` | webchat JWT | Customer sends text, a button tap, or a list pick |
| POST | `/media` | webchat JWT | Upload an image/PDF (vehicle document or payment proof) |
| GET | `/history?after=<id>` | webchat JWT | Messages after an id (reload + polling fallback) |
| GET | `/stream` | webchat JWT | SSE live stream of new outbound messages |
| GET | `/files/:id` | webchat JWT | Download a proforma/invoice PDF belonging to this phone |

**Joi schemas** go in `src/validations/webchat.validation.ts`. `POST /messages` body:

```json
{ "clientMessageId": "uuid", "text": "string|null", "buttonId": "string|null",
  "listRowId": "string|null", "title": "string|null", "contextId": "string|null" }
```

- Exactly one of `text` / `buttonId` / `listRowId` is required.
- `title` is the tapped button/row label. WhatsApp passes it as `customerText` today, and several stages
  match on it.

**Response envelope.** These are customer endpoints, not admin ones, but use the same `{ success, message, code, data, meta }` envelope
for consistency with the codebase. SSE and file download are the exceptions, like the webhook and the
payment-proof stream.

### 5.2 Inbound processing (mirror of `receiveWebhookMessage`)
1. Validate, then `claimInboundMessage('web:' + clientMessageId)`. Duplicates (double click, retry) are
   dropped.
2. Persist the inbound row in `webchat_messages` (direction `in`), so history shows what the customer sent.
3. Respond `202` immediately. Replies arrive via SSE/history, not in the HTTP response, which keeps one model
   for both "reply now" and "reply later".
4. `runSerialized(phone, () => withChannel('web', () => processMessageFlow(inbound)))`.
   - The **same key as WhatsApp**: if one customer types on both channels at once, the messages are still
     processed one at a time.
   - Each reply goes to the channel the triggering message came from.

### 5.3 Storage: `webchat_messages` table

```sql
CREATE TABLE IF NOT EXISTS webchat_messages (
  id          BIGSERIAL PRIMARY KEY,
  phone       TEXT NOT NULL REFERENCES customers(phone) ON DELETE CASCADE,
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  kind        TEXT NOT NULL,         -- text | buttons | list | document | image
  payload     JSONB NOT NULL,        -- body, buttons[{id,title}], rows, file ref, contextId…
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webchat_messages_phone_id ON webchat_messages (phone, id);
```

- Postgres and not Redis because history must survive Redis eviction/restarts and needs a strict order. The
  `BIGSERIAL id` doubles as the cursor for `?after=` and as the **prompt message id** for the stale-button
  check (`messageId = 'web_' + id`).
- The `REFERENCES customers` foreign key means a web message can only be stored after the customer row exists.
  The pipeline creates it on the first inbound message. Insert the inbound row *after* the
  `getOrCreateCustomer` step, or drop the foreign key and keep the plain index. **Decide in P2.**
- Update `db/schema.sql`, `db/seed.sql` (no seed rows needed) and `db/schema.dbml` together (repo rule).
  `db/clear.js` must wipe it too.
- Retention: keep 90 days. Later, add a daily cleanup in the existing sweep style.

### 5.4 Live delivery: SSE, with polling fallback
- `GET /stream` keeps an open `text/event-stream` response.
- An in-process `Map<phone, Set<Response>>` (`src/channels/web/hub.ts`) pushes each new outbound row as an
  event with `id: <row id>`.
- On reconnect the browser sends `Last-Event-ID`, and the server replays from `webchat_messages`, so nothing is
  lost between reconnects.
- A heartbeat comment every 25s keeps Railway / proxies from closing the idle connection.
- **Why SSE, not socket.io/WebSockets:**
  - Pushes are one-way (customer → server is a plain POST).
  - No new dependency; works through Railway's proxy.
  - Auto-reconnect is built into `EventSource`.
- **Auth caveat:** browser `EventSource` cannot set an `Authorization` header. Options:
  - Pass the JWT in a query string (avoid: it ends up in logs).
  - **Use `fetch()` streaming with the header (recommended)**, e.g. via `@microsoft/fetch-event-source` on the website.
  - Use a short-lived single-use stream ticket.
- **Fallback:** if streaming fails, the widget polls `GET /history?after=` every 3s while the panel is open.
- **Scaling caveat:** the hub is in-process, the same constraint as `runSerialized` and the sweeps.
  Multiple API instances would need Redis pub/sub for the hub (and a shared lock for `runSerialized`).

### 5.5 `WebTransport` behaviour
- `sendText` / `sendButtons` / `sendList`: insert an `out` row, push it to the hub, and return
  `{ messageId: 'web_' + id }`.
- `markTyping`: hub-only `typing` event, not persisted.
- `downloadMedia(phone, 'web_<uuid>')`: read from `storage.service` `getDocument`. No Meta call.
- Limits: the WhatsApp caps (3 buttons, 10 rows, 20-char button titles, 1024-char body via `clampBody`)
  are **kept on the web too**. The flows were designed around them, and keeping them means a message renders
  the same on both channels.

## 6. Interactive parity (buttons, lists, stale taps)
- The widget renders `buttons` rows as up to 3 tappable chips and `list` rows as an expandable list (the
  "button text" opens it). Interactive elements are only active on the **latest** prompt.
- A tap sends `{ buttonId | listRowId, title, contextId: <the prompt's messageId> }`.
- The controller's existing check compares `contextId` with `getActivePromptId(phone)`. It works unchanged
  because `reply.service` saved the web `messageId` as the active prompt.
- **Cross-channel stale taps:** the active prompt is per phone, not per channel. If the customer answers a prompt on
  WhatsApp, an older web prompt becomes stale too, and vice versa. That is the correct behaviour (one
  conversation state).
- Free-typed digits ("1", "2") for list picks work as today, since they are just text.

## 7. Media and PDFs

### 7.1 Customer uploads (vehicle document, payment proof)
- `POST /v1/webchat/media` takes multipart (add `multer` with memory storage).
  - Allowed: `image/jpeg`, `image/png`, `application/pdf`. Max 10 MB. Check the file's magic bytes, not
    just the client-sent MIME type.
- The server saves the file through `storage.service` `saveDocument` with id `web_<uuid>`, then processes
  it as an inbound message: `kind: 'image' | 'document'`, `mediaId: 'web_<uuid>'`.
- From there the pipeline is unchanged. State-aware routing (vehicle document vs payment proof) and the Claude
  Vision calls already take base64, which `WebTransport.downloadMedia` returns from local storage.
- `orders.payment_proof_media_id` can hold either kind of id; `has_proof` keeps working. The admin proof endpoint
  already serves the local copy first.
- **Admin WhatsApp push with a web proof:** the payment-proof admin message uses the proof as a Meta media header
  (`payment.service.ts:308`). For a `web_` id, upload the local file to Meta first (`uploadWhatsAppMedia`,
  §3.3) and use the returned id. Don't overwrite the stored `web_` id.

### 7.2 Proforma and invoice PDFs
- They are still generated by `generateProformaPDF` / `generateInvoicePDF`, which do not depend on the channel.
- On the web, `sendDocument` records the generated file (the `customer_documents` row already written by
  `recordGeneratedDocument`) and posts a `document` message. That message shows a download card linking to
  `GET /v1/webchat/files/:id`.
  - The endpoint checks that the file belongs to the JWT's phone and streams it with `application/pdf`.
- `sendFinalInvoiceWhatsApp` currently sends the invoice as a *header* of an Order Status button message. The
  web transport renders a header document plus buttons the same way.

## 8. Messages with no inbound context: web + WhatsApp fallback

### 8.1 Policy (agreed)
When `reply.service` is called **outside** a channel context (sweeps, admin panel actions, admin WhatsApp
buttons, restock):
1. **Always write to the web history.** This only applies when the customer has used web chat:
   `customers.web_chat_enabled_at IS NOT NULL`, or simply "any `webchat_messages` row exists". Then push it
   over SSE if the customer is connected.
2. **Always send on WhatsApp too**, as today.
   - **Inside the 24h window** (the customer messaged us on WhatsApp in the last 24h): normal free-form message.
     The existing behaviour is unchanged.
   - **Outside the window:** free-form fails with `131047`, so this needs a **Utility template** per async
     message type (order approved/invoice ready, order rejected, stock confirmed/proforma ready, stock
     unavailable, back in stock).
   - **Until those templates exist**, the WhatsApp copy fails outside the window. Log it at warn level and
     rely on the web history. Do not crash the business action.

For a customer who **never** used web chat, nothing changes: WhatsApp only, exactly as today.

### 8.2 Tracking the window and the last channel
- `lastInbound:<phone>:whatsapp` is a session key set on every WhatsApp inbound message, with a 24h TTL. If it
  exists, the window is open. It is cheaper and more reliable than reacting to the 131047 error after the fact.
- `lastChannel:<phone>` is informational. It is used to word messages ("continue here or on WhatsApp") and in
  admin debugging.
- Optionally add `orders.channel TEXT` ('whatsapp' | 'web'), set at order creation, for reporting in the admin
  panel. If added, update `schema.sql` / `schema.dbml` / the model together.

### 8.3 Interaction with the admin-alert template work
`META_WHATSAPP_SETUP.md` already plans utility templates for **admin** alerts (same 24h problem). Build one
`sendWhatsAppTemplate(phone, name, lang, components)` in `whatsapp.service.ts` and use it for both. Template
button taps arrive as `message.type === 'button'` with `button.payload`, so the inbound adapter must map those to
`buttonReplyId` (today only `button.text` is read).

## 9. Website widget (`rede-pecas-website`)

The current state:
- Next 16 App Router, Tailwind v4, English only.
- No chat UI, no backend calls, no env vars.
- `WHATSAPP_URL = "https://wa.me/"` is a placeholder with no number (`src/lib/constants.ts:4`).
- The "Talk to Xico Peças" CTAs appear in:
  - Header (desktop and mobile)
  - Hero
  - MeetXicoPecas (its copy already promises chatting on the site)
  - WhyRedePecas
  - Footer

### 9.1 Components (all `"use client"`)
- `ChatProvider`: context with open/close state and session (JWT, phone). Mounted in `src/app/layout.tsx`.
- `ChatLauncher`: a floating bottom-right button on every page.
- `ChatPanel`: two screens.
  1. **Login**: phone input (+244 default) → code input (6 digits, resend after 60s) → stores the token.
  2. **Thread**: message list (bubbles, the bot's bold `*text*` rendered), button chips, list picker, document
     card, typing dots, composer with text input + attach (image/PDF) + send. "Continue on WhatsApp" link
     once `WHATSAPP_URL` holds the real number.
- `ChatButton`: an `onClick` variant of the existing `Button` (`src/components/ui/Button.tsx` only takes `href`).
  It replaces the `WHATSAPP_URL` links on the CTAs so they open the panel.

### 9.2 Data flow
- `NEXT_PUBLIC_API_URL` (e.g. `https://rede-pecas-api-staging.up.railway.app/v1`) is the only new env var.
- The token is kept in memory + `sessionStorage`, closed with the tab.
  - `localStorage` would keep the customer logged in across visits (nicer UX, slightly weaker on shared
    computers). **Recommend `localStorage` with the 7-day JWT expiry and a visible "Log out" option.**
- On open: `GET /history` (last 50) → open the stream → render.
- Send: optimistic bubble → `POST /messages` with a `crypto.randomUUID()` `clientMessageId`.
- Upload: `POST /media` with progress; reject >10 MB or a wrong type client-side too.
- CORS is left as is (`origin: true, credentials: true`, `src/app.ts`).

### 9.3 Content and legal
- Update `/privacy-policy`: it covers WhatsApp but not chat history stored for the website, phone verification
  codes, or uploads via the site.
- Fill the real number into `WHATSAPP_URL`. It is still a placeholder.
- The bot replies in PT or EN depending on what the customer writes (§10), while the site chrome is English
  only. The widget's own labels (login, placeholders) should follow `navigator.language` (pt/en) until the
  site gets proper i18n.

## 10. Locale
No change. `detectMessageLocale` runs per inbound message regardless of channel and caches via `saveLocale`.
The widget may send `locale: navigator.language` once at login. That seeds `saveLocale` only when nothing has
been detected yet, so the very first canned prompt (before any customer text) is in the right language instead of the
`DEFAULT_LOCALE` 'pt'.

## 11. Security checklist
- **OTP**:
  - Stored hashed, 5 min TTL, 5 attempts, request rate limits per phone and IP (§4.2).
  - Same response for known and unknown numbers.
  - Never log the code.
- **JWT**:
  - `type: 'webchat'` is scoped to `/v1/webchat/*` only, and the admin `authMiddleware` rejects it.
  - Logout revokes the token via the existing `sessionService.revokeToken`.
- **Ownership**: every history/file/media query is filtered by the JWT's phone. A customer can never fetch
  another phone's file by guessing an id.
- **Uploads**: type allow-list + magic-byte check + 10 MB cap. Files are stored outside any static-served path
  (they already are: `storage/`).
- **Input**: Joi validation on every route. Text length capped (e.g. 1000 chars) before it reaches the
  pipeline or Claude.
- **Abuse/cost**:
  - Per-token message rate limit (e.g. 20/min).
  - Each message can trigger Claude calls (`extractProductNames`, humanize, validation), so an
    unthrottled web endpoint is a direct Anthropic cost risk.
- **Logs**: keep the existing `[phone]` log prefix style. No tokens or codes.

## 12. Cost and Meta dependencies
| Item | Needed for | Status |
|---|---|---|
| Payment method on the WABA | Any paid template (auth, utility) | Open (see `META_WHATSAPP_SETUP.md`) |
| **Authentication template** (OTP, copy-code button) | Web login (§4) | New: create in WhatsApp Manager, category *Authentication* |
| Utility templates for async customer messages | WhatsApp fallback outside 24h (§8) | New. Shares the mechanism with the planned admin-alert templates |
| Real number live + display name approved | Customers trust the OTP sender | Number live; display name in review |

Pricing is per delivered template message, by recipient country (Angola falls under Meta's "Rest of Africa"
rate). Authentication is typically the cheapest paid category. Check Meta's current rate card before
estimating.

## 13. Phased rollout
Each phase is its own branch off `development` and its own PR.

| Phase | Repo | Scope | Done when |
|---|---|---|---|
| **P1** `refactor/channel-transport` | api | §3.3 refactor, WhatsApp only. `InboundMessage`, transports, channel context, direct sends moved, `uploadWhatsAppMedia`, `sendReplyDocument` | Full `TESTING.md` pass on WhatsApp with **no behaviour change** |
| **P2** `feat/webchat-api` | api | `webchat_messages` table, OTP (dev bypass first), JWT + middleware, `/messages`, `/history`, `/stream`, `WebTransport` | Full text/button/list conversation via curl/Postman + SSE |
| **P3** `feat/web-chat-widget` | website | §9 widget, `NEXT_PUBLIC_API_URL`, CTA rewiring | Register → vehicle → search → order on the website against staging |
| **P4** `feat/webchat-media-async` | api | `/media` uploads, PDFs via `/files/:id`, async policy §8, auth template live, `sendWhatsAppTemplate`, utility templates | Proof upload, proforma/invoice on web; admin approval reaches web + WhatsApp |
| **P5** `chore/webchat-hardening` | both | Rate limits tuned, retention cleanup, privacy policy, `TESTING.md` web column, CLAUDE.md update | QA sign-off |

P1 lowers risk on its own and should go first even if the web timeline slips.

## 14. Risks and open questions
- **Single instance assumption**: `runSerialized`, the SSE hub and the sweeps are in-process. Fine on the current
  Railway deployment; scaling out needs Redis pub/sub + a shared lock (BullMQ or Redis lock keyed by phone).
- **Template approval lead time**: the authentication template is required before web login works in
  production. Submit it early (can be done during P1/P2).
- **Guest mode?** Should visitors be able to browse/search parts before verifying their phone? Not in this
  design; the pipeline needs a customer row. Possible later as a read-only search page instead of the bot.
- **Website language**: the site is English only, while customers are mostly Portuguese-speaking. The bot
  handles both, but the site chrome does not.
- **Admin panel visibility**: show web vs WhatsApp per order (`orders.channel`) and/or a web-chat transcript
  viewer? Not required for launch.
- **Human handoff on web**: `HUMAN_HANDOFF_PATTERN` today tells the customer staff will contact them on
  WhatsApp. That still works (we have their verified phone), but the wording may need a web variant.
- **Copy that says "WhatsApp"**: some canned messages in `src/i18n/messages.ts` may mention WhatsApp explicitly.
  Audit them in P2 and make them channel-neutral where needed.
