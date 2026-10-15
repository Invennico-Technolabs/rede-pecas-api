# Meta WhatsApp Cloud API — setup & troubleshooting reference

Everything we learned getting the real Rede Peças number live (2026-10-15). Use this first when "the bot isn't replying".

> **No secrets in this file.** Tokens, the app secret, the verify-token value and the number's registration PIN live only in `.env` / Railway variables / a password manager. Never paste them here.

---

## 1. How the pieces fit

```
Customer's WhatsApp ──► Meta Cloud API ──► webhook POST ──► rede-pecas-api (/v1/webhook/whatsapp)
                                                                   │
Customer's WhatsApp ◄── Meta Cloud API ◄── Graph API send ◄────────┘  (uses WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID)
```

- **Inbound** goes to whatever callback URL Meta has for the app (or a per-WABA / per-number override — see §7).
- **Outbound replies** are always sent *from* the single number in `WHATSAPP_PHONE_NUMBER_ID` of the server that handled the message. Wrong ID = replies come from the wrong number or fail.

| Thing | Value |
|---|---|
| Meta business portfolio | **Rede Peças** — ID `1014277798426295` — **business verified** |
| Meta app | **Mr. Rede Peças** — app ID `888870674069104` — **Published (Live)** |
| Developer dashboard | developers.facebook.com → My Apps → Mr. Rede Peças → Use cases → Connect on WhatsApp |

**There is only one app.** The dashboard's "Step 1. Try it out" (test number) and "Step 2. Production setup" (real number) are two pages of the *same* app — not a test app and a production app. Same app ⇒ same app secret for both numbers.

---

## 2. WhatsApp Business Accounts (WABAs) — the confusing part

Business Settings → Accounts → WhatsApp accounts shows three entries, the app dashboard shows a fourth ID. What they actually are:

| WABA ID | Name | What it is | Numbers | Use |
|---|---|---|---|---|
| `1202305438726808` | Rede Pecas WhatsApp Business Account | **Meta's auto-created test WABA.** Test WABAs can never hold a real number — that's why "add number" doesn't work on it. Normal. | Test number **+1 555-190-3242**, phone number ID `990019714192993` | Local dev / testing |
| `2607140696475379` (Business Settings) **=** `1881511786153810` (app dashboard / API) | Rede Pecas - Xico Pecas | **The production WABA.** Same account, shown under two IDs — verified via API: both return the same number. Owned by Rede Peças. | Real number **+244 923 363 400**, phone number ID `1362318333633478` | Production / staging live traffic |
| `2047905259324024` | Rede Peças | Empty spare WABA (EUR, Europe/Lisbon). | none | **Don't add numbers here** — a number in two places is what caused the confusion. Can be deleted later. |

- All four IDs: `owner_business_info` = Rede Peças (`1014277798426295`), review status APPROVED.
- App **Mr. Rede Peças is subscribed** to `1202305438726808`, `1881511786153810`, `2607140696475379` (added 2026-10-15 via API) and `2047905259324024`.

---

## 3. Current status (as of 2026-10-15)

**Real number +244 923 363 400** (`1362318333633478`)
- `status: CONNECTED`, `code_verification_status: VERIFIED`, `platform_type: CLOUD_API`, `account_mode: LIVE`
- Display name "Rede Pecas - Xico Pecas" — `name_status: PENDING_REVIEW` (usually 1–2 days). **Does not block messaging**; customers see the number instead of the name until approved. If rejected, resubmit with a name clearly matching the business (e.g. "Rede Peças").

**Test number +1 555-190-3242** (`990019714192993`) — CONNECTED, quality GREEN, tier 250, name "Test Number".

**App** — Published. **Business** — verified (so the "2 phone numbers per business" limit no longer applies; up to 20).

---

## 4. Environment variables

| Var | What | Where to get it | Value per environment |
|---|---|---|---|
| `WHATSAPP_TOKEN` | Bearer token for every Graph API call | System User token (see §5) | Same System User token everywhere (it has access to both WABAs) |
| `WHATSAPP_PHONE_NUMBER_ID` | The number replies are sent **from** | Use cases → Step 1 (test) / Step 2 (real) → Phone Number ID | **Railway staging (live): `1362318333633478`** · Local dev: `990019714192993` |
| `WHATSAPP_VERIFY_TOKEN` | Shared string for the webhook GET handshake | You choose it; must match App → WhatsApp → Configuration → Verify token | Same everywhere the callback can point |
| `WHATSAPP_APP_SECRET` | Verifies `X-Hub-Signature-256` on every webhook POST | App settings → Basic → App secret | Same everywhere (one app). **Required when `NODE_ENV=production`** — the API refuses to boot without it. Unset locally ⇒ check skipped with a boot warning. |
| `WHATSAPP_GRAPH_API_URL` | Graph base URL incl. version | — | `https://graph.facebook.com/v25.0` (code default is the outdated v19.0 — always set it) |
| ~~`WHATSAPP_BUSINESS_ACCOUNT_ID`~~ | — | — | **Not read by the code.** Remove it from `.env` files. |

`.env` caution: `dotenv` keeps the **last** occurrence of a duplicated key. Three uncommented dev/staging/prod sections in one `.env` silently means "production values everywhere". Keep exactly one active section, or (recommended) use separate files / host env vars.

---

## 5. Access token

**What broke:** the old `WHATSAPP_TOKEN` was a personal user-session token. It died with
`OAuthException code 190, error_subcode 460 — "session has been invalidated because the user changed their password"`. Every send failed, on every number.

**What we use now:** a **System User** token — `type: SYSTEM_USER`, app Mr. Rede Peças, **`expires_at: 0` (never expires)**, scopes `whatsapp_business_messaging`, `whatsapp_business_management`, `business_management` (+ `manage_app_solution`, `whatsapp_business_manage_events`).

**To regenerate:** business.facebook.com → Settings → Users → **System users** → (system user, Admin role) →
1. **Assign assets:** app *Mr. Rede Peças* (full control), WABA *Rede Pecas - Xico Pecas* (full control), test WABA `1202305438726808`.
2. **Generate token:** app Mr. Rede Peças, expiry **Never**, scopes `whatsapp_business_messaging` + `whatsapp_business_management`.
3. Update `WHATSAPP_TOKEN` in Railway (and local `.env`). Railway redeploys on save.

**Never** use the "Generate token" button in Step 1 for anything but a quick 24h test.

**Security to-do:** an old commented-out token from a previous dev account was in `.env` and got exposed in a chat log — revoke it in that Meta app if still valid, and delete the line.

---

## 6. Go-live checklist (what actually made the real number work)

1. **Register the number** — Use cases → Step 2 → *Register* on +244 923 363 400, set a 6-digit PIN. Status goes Pending → **Connected**. **Keep the PIN** (password manager) — it becomes the number's two-step verification PIN, needed to re-register or migrate. The number must not be logged in on the WhatsApp / WhatsApp Business phone app.
2. **Subscribe webhooks** — the *Subscribe webhooks* toggle on the WABA card in Step 2 (= `POST /{WABA_ID}/subscribed_apps`). The test WABA had this automatically; the real one didn't — no inbound messages arrive without it.
3. **Publish the app** — App settings → Basic, then *Publish*:
   - Privacy Policy URL → website page `/privacy-policy` (`rede-pecas-website/src/app/privacy-policy`) — must be public HTTPS, no login (a `*.vercel.app` URL is accepted).
   - Terms of Service URL → `/terms-conditions` (optional).
   - App icon → `rede-pecas-website/src/app/icon.png` (1024×1024).
   - Category → **Messaging** (Shopping also fine; doesn't affect behavior).
   - Contact email → a shared company inbox.
   - In Development mode the app does not get production message webhooks.
4. **System User token** (§5).
5. **Railway variables** — staging: `WHATSAPP_TOKEN` = System User token, `WHATSAPP_PHONE_NUMBER_ID=1362318333633478`; app secret + verify token unchanged.
6. Customer-facing profile photo is separate from the app icon: WhatsApp Manager → Phone numbers → +244 923 363 400 → Profile (square, ≥ 640×640, same logo).

---

## 7. Webhook

**Current callback (app default):** `https://rede-pecas-api-staging.up.railway.app/v1/webhook/whatsapp` — active.
Subscribed fields: `messages`, `account_alerts`, `account_review_update`, `account_update`, `calls`, `message_template_quality_update`, `message_template_status_update`, `phone_number_name_update`, `phone_number_quality_update`, `security`. **`messages` is the one that matters.**
Both numbers currently deliver here (`webhook_configuration.application` = that URL for each).

**How our endpoint behaves** (`src/routes/v1/whatsapp.route.ts` → `whatsappSignature.ts` → `whatsapp.controller.ts`):
- `GET` handshake: correct `hub.verify_token` → echoes `hub.challenge`; wrong → **403**.
- `POST`: HMAC-SHA256 of the raw body with `WHATSAPP_APP_SECRET` must match `X-Hub-Signature-256`, else bare **401**. Then 200 immediately, then async processing.
- Duplicate deliveries of the same message id are dropped (24h, `inboundMsg:<id>`).
- Messages from one phone are processed one at a time, in order (single instance only).

Verified 2026-10-15 against staging: bad verify token → 403, unsigned POST → 401, POST signed with the real app secret → 200.

**"Can we only have one webhook URL?"** — One **default per app**, but Meta supports **overrides**; the most specific wins (phone number > WABA > app):

| Level | How |
|---|---|
| App default | App → WhatsApp → Configuration |
| Per WABA | `POST /{WABA_ID}/subscribed_apps` with `override_callback_uri` + `verify_token` |
| Per phone number | `POST /{PHONE_NUMBER_ID}` with `{"webhook_configuration": {"override_callback_uri": "...", "verify_token": "..."}}` |

Override URLs must be public HTTPS and pass the same verify-token handshake; signatures use the same app secret.

**Recommended split once a production server exists:** real number `1362318333633478` → per-number override to **production**; test number → app default (**staging**) or an override to an **ngrok** URL for local dev. While the callback points at staging, local `npm run dev` receives nothing.

---

## 8. Who can the bot message?

- **Allowed-recipient list ("To" numbers in Step 1) applies to the test number only.** The live number has no list — it can reply to anyone who messages it.
- **Admin phones are ignored for plain text.** Any phone in `admin_users` (seed: `917987760774`) hits the admin short-circuit: only button taps are handled. **Test as a customer from a phone that is not an admin.** Check the phone stored in `admin_users` on the **staging DB** (it may differ from seed).

---

## 9. The 24-hour customer service window (affects admin alerts)

- A business may send **free-form** messages (text, buttons, images) to someone only **within 24h of that person's last message to the business**. Outside it, only **pre-approved templates** — anything else fails with error **`131047`** (re-engagement message).
- **Customers:** unaffected — they always write first, the bot always replies inside the window.
- **Admins:** affected. All admin WhatsApp pushes are free-form today (the code has **no** template sends):
  - stock confirmation needed (`t.admin.stockConfirmationNeeded`)
  - in-person payment requested (`t.admin.inPersonPaymentRequested`)
  - payment proof received — interactive with proof header + Approve/Reject buttons (`admin_approve_payment_<order>` / `admin_reject_payment_<order>`)
  These only arrive if that admin phone messaged +244 923 363 400 in the last 24h; otherwise they fail (error in server logs only). **Nothing is lost** — the admin panel feed (`admin_alerts`, `GET /v1/admin/alerts`) still records every event.
- **Workaround until templates exist:** each admin sends any message ("hi") to +244 923 363 400 once a day. The bot ignores it but the window opens.

---

## 10. Utility templates — the proper fix (planned, NOT implemented)

**Pricing** (per-message since July 2025; check Meta's current rate card for exact figures — they change):

| Message | Cost |
|---|---|
| Service reply inside the 24h window (all customer bot replies) | Free |
| **Utility template inside an open window** | **Free** |
| **Utility template outside the window** | **Charged**, by **recipient's** country code (India +91 for `917987760774`; Angola +244 = "Rest of Africa") — fractions of a US cent to ~1¢ each |
| Marketing template | Always charged (we don't use these) |

Rough volume: 2–3 alerts × admins per order → a few USD/day at most at moderate volume.
**A payment method is required** on the production WABA (WhatsApp Manager → Payment settings) or every chargeable template is rejected.

**Meta side:** WhatsApp Manager → Message templates → Create
- Category **Utility**, language **English** (admin messages are English in our code).
- Body with variables, e.g. *"Payment proof received for order {{1}} from {{2}}, total {{3}} Kz. Review it below."*
- Optional header: image/document (payment proof). Up to 3 **Quick reply** buttons (Approve / Reject).
- Approval is usually minutes–hours. **Promotional wording gets recategorized as Marketing** (always paid) — keep it transactional.
- Three templates needed: stock confirmation needed, in-person payment requested, payment proof received (with buttons).

**Our side (decided approach):** always send admin alerts as templates — same cost as switching between free-form and templates (utility inside the window is free), and no 24h window state to track.
1. New `sendWhatsAppTemplate(phone, name, lang, params, buttonPayloads)` in `src/services/whatsapp.service.ts` (same `/messages` endpoint, `type: "template"`).
2. Switch the three admin pushes in `payment.service.ts` / `product.service.ts`; keep the existing button payload ids.
3. **Gotcha:** template quick-reply taps arrive as `message.type === "button"` with the id in **`message.button.payload`** — not `interactive.button_reply.id`. The admin short-circuit in `whatsapp.controller.ts` must read both or Approve/Reject taps are silently ignored.
4. Proof media in the template header: reuse the inbound media id — **needs testing** that Meta accepts it.
5. On template failure: log it; the `admin_alerts` feed still has the event.

**Order of work:** add payment method → submit 3 templates → code on a branch once approved → test on staging with the admin window **open and closed**.

---

## 11. Troubleshooting runbook

| Symptom | Check | Fix |
|---|---|---|
| Graph errors `code 190` (`subcode 460` / 463 / "Session has expired") | `debug_token` (below) → `is_valid` | Token dead → new System User token (§5), update Railway |
| Nothing arrives at the server at all | Railway logs show no POST; `GET /{WABA_ID}/subscribed_apps` | Subscribe the app to the WABA; check callback URL / overrides (§7); `messages` field ticked; app Published |
| Railway logs show webhook **401** | Signature mismatch | `WHATSAPP_APP_SECRET` on the server must equal App settings → Basic → App secret of **this** app |
| Meta "Verify and save" fails / **403** | GET handshake | `WHATSAPP_VERIFY_TOKEN` on the server must equal the dashboard Verify token; server must be reachable over HTTPS |
| Number shows **Pending** / "Not registered" | `GET /{PHONE_NUMBER_ID}?fields=status` | Register (§6.1) — `POST /{PHONE_NUMBER_ID}/register` `{"messaging_product":"whatsapp","pin":"<PIN>"}` |
| Inbound works, customer gets no reply | Railway logs show Graph send error | `WHATSAPP_PHONE_NUMBER_ID` must be the number the customer wrote to (`1362318333633478` for live); token must cover that WABA |
| Reply comes from +1 555 test number | — | Server still has the test number ID |
| Error **`131030`** recipient not in allowed list | Sending from the test number | Add recipient in Step 1 "To" list, or use the live number |
| Error **`131047`** re-engagement | Recipient hasn't messaged in 24h (admin alerts) | Admin messages the number, or utility templates (§10) |
| Payment / `131042` errors on templates | — | Add payment method to the WABA |
| "Bot ignores me" when testing | Sender is in `admin_users` | Test from a non-admin phone |
| Customer sees number, not "Rede Pecas" name | `name_status` | Display name still in review / rejected (§3) |
| API won't boot in production | Logs: missing `WHATSAPP_APP_SECRET` | Set it in the host env |

**Read-only diagnostics** (run from the api repo root; loads `.env`, never prints the token):

```bash
node --input-type=module -e "
import 'dotenv/config';
const T = process.env.WHATSAPP_TOKEN, B = process.env.WHATSAPP_GRAPH_API_URL;
const get = async (p) => (await fetch(B + '/' + p, { headers: { Authorization: 'Bearer ' + T } })).json();
const d = (await get('debug_token?input_token=' + T)).data ?? {};
console.log('token', { type: d.type, valid: d.is_valid, expires_at: d.expires_at, app: d.application });
console.log(await get(process.env.WHATSAPP_PHONE_NUMBER_ID + '?fields=display_phone_number,status,code_verification_status,name_status,platform_type,account_mode,webhook_configuration'));
console.log(JSON.stringify(await get('1881511786153810/subscribed_apps')));
"
```

Signed probe against a deployed webhook (empty entry list — processes nothing, sends nothing; expect **200**, or 401 if the server's app secret differs):

```bash
node -e "
require('dotenv').config();
const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
const sig = 'sha256=' + require('crypto').createHmac('sha256', process.env.WHATSAPP_APP_SECRET).update(body).digest('hex');
fetch('https://rede-pecas-api-staging.up.railway.app/v1/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body })
  .then((r) => console.log('status', r.status));
"
```

Don't fake a real inbound message against a deployed server — the bot will send a real WhatsApp reply to whatever phone is in it.

---

## 12. Open items

- [ ] Confirm the first live round-trip: "Olá" from a non-admin phone to +244 923 363 400 → registration prompt.
- [ ] Display name "Rede Pecas - Xico Pecas" review outcome.
- [ ] Add a payment method to the production WABA.
- [ ] Utility templates for admin alerts (§10).
- [ ] Production server + per-number webhook override for `1362318333633478` (§7); keep staging on the test number.
- [ ] Revoke the old leaked dev-account token; remove it from `.env`.
- [ ] Remove `WHATSAPP_BUSINESS_ACCOUNT_ID` from `.env` files; sort out dev/staging/prod `.env` layout (last-key-wins).
- [ ] Verify the admin phone(s) in `admin_users` on the staging DB.
- [ ] Optionally delete the empty spare WABA `2047905259324024`.
