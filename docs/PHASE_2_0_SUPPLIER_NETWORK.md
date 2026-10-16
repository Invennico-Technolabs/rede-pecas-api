# Phase 2.0 — Supplier Network, Geolocation & Order Allocation

> Status: **Design / not started** · Owner: Rede Peças core team · Last updated: 2026-10-16
> Repos affected: `rede-pecas-api` (most work), `rede-pecas-admin` (operator dashboard).
> Naming note: `docs/WEB_CHAT_DESIGN.md` (branch `docs/web-chat-design`) also calls itself "Phase 2". The two are independent and can ship in either order; this doc uses **2.0** to keep them apart.

## 1. Goal

Today, every part search returns the cheapest offers regardless of where the supplier is, how long delivery takes, what delivery costs, or how likely the supplier really has the stock. Phase 2.0 turns Rede Peças from "cheapest price wins" into a **location-aware marketplace** that picks the best supplier for each customer and each order, and lets an operator see and override that choice.

### In scope

| # | Feature | One-line summary |
|---|---|---|
| 1 | Supplier management & geolocation | Suppliers become first-class records with a map location, hours and delivery settings, managed from the admin panel. |
| 2 | Supplier inventory & stock confidence | Each offer carries a confidence score (how fresh the stock data is + how often this supplier actually confirms). |
| 3 | Customer geolocation | Capture a delivery point per customer via WhatsApp location pin (primary) or address/municipality (fallback). |
| 4 | Geographic supplier search | Only consider suppliers that can serve the customer's location. |
| 5 | Distance & ETA calculation | Road distance and delivery time estimate per candidate supplier. |
| 6 | Delivery cost calculation | A deterministic delivery fee per supplier → customer pair, shown before ordering and printed on the proforma. |
| 7 | Supplier scoring & ranking | One explainable score combining price, delivery cost, ETA, stock confidence and reliability. |
| 8 | Customer preferences | *Fastest / Lowest cost / Best balance* — changes the ranking weights. |
| 9 | Operator dashboard & override | Admins see ranked candidates with the score breakdown and can override the chosen supplier, with a reason. |
| 10 | Order allocation | A recorded, auditable decision of which supplier fulfils each order item, with automatic fallback to the next-best supplier on rejection. |

### Out of scope (unchanged from SOW)

- Live courier tracking / driver app.
- Payment gateway integration, refunds as a status (still message-only).
- Supplier self-service portal (suppliers still managed by Rede Peças staff; see §13 for the API-sync option).

## 2. Current state (what we are building on)

| Area | Today | File(s) |
|---|---|---|
| Suppliers | `suppliers` table: `name, phone, email, nif, province, rating, api_key, active`. No coordinates, hours or delivery data. Created implicitly by inventory import (`getOrCreateSupplierByName`). No admin UI. | `db/schema.sql`, `src/models/supplier.model.ts` |
| Offers | `product_suppliers` = one row per (product, supplier): `price, quantity, delivery_time` (free text), `active`. Already supports "same part, many suppliers". | `db/schema.sql` |
| Search ranking | `searchProductsInInventory` → `ORDER BY ps.price ASC, s.rating DESC`, top 3 after vehicle-fit filter. | `src/models/product.model.ts` |
| Customer location | `customers.address` free text, captured per order by the order-profile wizard. No coordinates. WhatsApp `location` messages are not handled by the pipeline. | `src/services/orderProfile.service.ts`, `src/controllers/whatsapp.controller.ts` |
| Supplier choice | Implicit: the customer picks a row from the results list, and that row *is* a `product_suppliers.id`. No allocation record, no fallback; if the admin marks stock unavailable, the customer is offered alternatives manually. | `src/services/product.service.ts` |
| Delivery fee | None. Totals are part price + optional service price. | `src/services/pdf.service.ts`, `payment.service.ts` |
| Unused hook | `suppliers.api_key` exists but nothing reads it. | — |

## 3. Key design decisions

| Decision | Choice | Why |
|---|---|---|
| Geo storage | Plain `latitude`/`longitude` `NUMERIC(9,6)` columns + a SQL haversine function, **not PostGIS** (yet). | Supplier count is in the tens/hundreds; a bounding-box prefilter + haversine is fast enough and avoids a new Postgres extension in every environment. Revisit if suppliers exceed ~5,000 or we need polygon delivery zones. |
| Road distance & ETA | Two-stage: haversine × road factor for **all** candidates, then a routing API only for the **top N (≤5)**, cached. | Straight-line distance underestimates Luanda road travel badly, but calling a routing API for every candidate on every search is slow and costly. |
| Routing provider | Google Distance Matrix API behind a `RoutingProvider` interface (OSRM self-hosted as an alternative). | Best traffic-aware coverage of Angola today; the interface keeps us swappable. **Needs budget sign-off** (see §13). |
| Customer location input | WhatsApp **location pin** first, municipality list fallback. | Angolan addresses are informal (bairro, landmark); free-text geocoding is unreliable. A pin is exact; a municipality is "good enough" for zone pricing. |
| Delivery pricing | Deterministic formula with per-supplier overrides (§7). No AI. | Prices shown to customers must be reproducible and auditable, consistent with the rest of the app. |
| Ranking | Weighted, normalised score with stored breakdown (§8). No AI. | Operators must be able to see *why* a supplier won, and override it. |
| Allocation unit | **Per order item**, not per order. | Baskets already hold multiple items (`orders.items` JSONB); different items may be best served by different suppliers. |
| Rollout | Behind `ALLOCATION_ENABLED` flag; current price-first ranking stays as the fallback. | Lets us ship data/UI pieces before switching customer-facing ranking. |

## 4. Data model changes

All changes go in `db/schema.sql` **and** `db/schema.dbml` **and** `db/seed.sql` (project rule), as idempotent `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`.

### 4.1 `suppliers` (extend)

```sql
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS address            TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS municipality       TEXT;           -- e.g. 'Talatona', 'Viana'
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS latitude           NUMERIC(9,6);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS longitude          NUMERIC(9,6);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS service_radius_km  NUMERIC(6,2) DEFAULT 25;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS prep_time_minutes  INT DEFAULT 60;  -- time to pick/pack before dispatch
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS opening_hours      JSONB;           -- {"mon":["08:00","18:00"], ..., "sun":null}
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS delivery_base_fee  NUMERIC(12,2);   -- NULL = use global default
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS delivery_per_km    NUMERIC(12,2);   -- NULL = use global default
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS offers_pickup      BOOLEAN DEFAULT false;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_suppliers_geo ON suppliers (latitude, longitude) WHERE active = true;
```

A supplier with `latitude IS NULL` is **not eligible** for geo-ranked search (it still appears in the fallback price-first search until located). The dashboard flags these as "needs location".

### 4.2 `product_suppliers` (extend — stock confidence inputs)

```sql
ALTER TABLE product_suppliers ADD COLUMN IF NOT EXISTS stock_updated_at  TIMESTAMPTZ DEFAULT NOW(); -- last time quantity was asserted (import, API, admin confirm)
ALTER TABLE product_suppliers ADD COLUMN IF NOT EXISTS stock_source      TEXT DEFAULT 'import';     -- 'import' | 'api' | 'admin_confirmed'
```

`delivery_time` (free text) is kept for display but **no longer used for ETA**; ETA comes from §6.

### 4.3 `supplier_stats` (new — reliability, maintained by code)

```sql
CREATE TABLE IF NOT EXISTS supplier_stats (
  supplier_id           INT PRIMARY KEY REFERENCES suppliers(id),
  confirm_requests      INT NOT NULL DEFAULT 0,   -- stock confirmations asked of this supplier
  confirmed_available   INT NOT NULL DEFAULT 0,   -- ... answered "available"
  avg_confirm_minutes   NUMERIC(8,2),             -- admin/supplier response speed
  on_time_deliveries    INT NOT NULL DEFAULT 0,
  late_deliveries       INT NOT NULL DEFAULT 0,
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
```

Updated wherever stock confirmation is decided today (`processAdminStockReply`, `processAdminItemStockReply`, `POST /orders/:number/confirm/stock`).

### 4.4 `customer_locations` (new)

A customer can have several delivery points (home, workshop, office).

```sql
CREATE TABLE IF NOT EXISTS customer_locations (
  id            SERIAL PRIMARY KEY,
  customer_phone TEXT NOT NULL REFERENCES customers(phone) ON DELETE CASCADE,
  label         TEXT,                          -- 'Casa', 'Oficina' ...
  address       TEXT,
  municipality  TEXT,
  latitude      NUMERIC(9,6),
  longitude     NUMERIC(9,6),
  source        TEXT NOT NULL,                 -- 'whatsapp_pin' | 'municipality' | 'admin'
  is_default    BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_customer_locations_phone ON customer_locations (customer_phone);
```

`source = 'municipality'` rows store the municipality centroid (from `municipalities`, below) and are treated as lower precision (wider ETA range, zone pricing).

### 4.5 `municipalities` (new — reference data)

```sql
CREATE TABLE IF NOT EXISTS municipalities (
  id         SERIAL PRIMARY KEY,
  province   TEXT NOT NULL,
  name       TEXT NOT NULL,
  latitude   NUMERIC(9,6) NOT NULL,   -- centroid
  longitude  NUMERIC(9,6) NOT NULL,
  UNIQUE (province, name)
);
```

Seeded with Luanda province municipalities first, other provinces later. **Confirm the list with the client before seeding**: Angola's 2024 administrative reform redrew Luanda's municipalities (and split off Icolo e Bengo as its own province), so older lists found online are out of date. A WhatsApp list holds at most 10 rows per section, so a longer list needs multiple sections.

### 4.6 `customers` (extend — preference)

```sql
ALTER TABLE customers ADD COLUMN IF NOT EXISTS delivery_preference TEXT DEFAULT 'balanced'; -- 'fastest' | 'lowest_cost' | 'balanced'
```

### 4.7 `order_allocations` (new — the allocation record)

```sql
CREATE TABLE IF NOT EXISTS order_allocations (
  id                 SERIAL PRIMARY KEY,
  order_number       TEXT NOT NULL REFERENCES orders(number) ON DELETE CASCADE,
  item_id            INT,                         -- orders.items[].itemId; NULL for legacy single-product orders
  offer_id           INT NOT NULL REFERENCES product_suppliers(id),
  supplier_id        INT NOT NULL REFERENCES suppliers(id),
  rank               INT NOT NULL,                -- 1 = top candidate at allocation time
  score              NUMERIC(6,4) NOT NULL,
  score_breakdown    JSONB NOT NULL,              -- see §8.3
  distance_km        NUMERIC(8,2),
  eta_minutes_min    INT,
  eta_minutes_max    INT,
  delivery_fee       NUMERIC(12,2) NOT NULL DEFAULT 0,
  preference         TEXT NOT NULL,               -- preference used for this ranking
  status             TEXT NOT NULL,               -- 'active' | 'superseded' | 'rejected_by_supplier'
  decided_by         TEXT NOT NULL,               -- 'system' | admin email
  override_reason    TEXT,                        -- required when decided_by != 'system' and rank != 1
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_allocations_order ON order_allocations (order_number);
```

Every change (auto-allocation, operator override, fallback after rejection) **inserts a new row** and marks the previous one `superseded` / `rejected_by_supplier`, so the full decision history is kept.

### 4.8 `orders` (extend)

```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee          NUMERIC(12,2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_location_id  INT REFERENCES customer_locations(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfilment            TEXT DEFAULT 'delivery'; -- 'delivery' | 'pickup'
```

For basket orders, each entry in `orders.items` gains `deliveryFee`, `etaMinutesMin`, `etaMinutesMax` (mirrored from its active allocation), keeping the existing JSONB pattern.

## 5. Customer geolocation (WhatsApp flow)

### 5.1 When we ask

Lazily, **the first time a location is actually needed**: right after the part-type choice and before the search runs (pipeline step 16 today), if the customer has no default `customer_locations` row. Returning customers are never asked again; they can change it any time by sending a new pin or typing "mudar morada" / "change address".

### 5.2 How we ask

1. Body: *"Para calcular o prazo e o custo de entrega, envia a tua localização 📍"* with a **Location Request message** (WhatsApp `interactive.type = "location_request_message"`, which shows a native "Send location" button).
2. Reply buttons alongside (separate message, ≤3 buttons, labels ≤20 chars):
   - `📍 Enviar localização` (re-sends the request)
   - `🏘️ Meu município` → list message of municipalities (≤10 rows per section; Luanda province fits in one section)
   - `🏪 Vou levantar` (pickup, only if at least one candidate supplier `offers_pickup`)

### 5.3 Pipeline changes (`processMessageFlow`)

- **New message type**: `location` (`msg.location.latitude/longitude/name/address`). Today it falls through unhandled.
- **New step, between current steps 15 and 16**: "pending location request" (session flag `pendingLocationRequest:<phone>`, 4h TTL, via a one-line wrapper in `session.service.ts` on top of `cache.service.ts`). Accepts a `location` message, a municipality list reply, or the pickup button; anything else re-asks (same "button-driven choice re-asks" rule as 2026-07-20).
- A location message received **outside** that pending state updates the customer's default location and replies with a confirmation. It must be placed before the payment-proof media routing (step 11) so it is never mistaken for media.
- Validation: reject coordinates outside Angola's bounding box (lat −18.1 to −4.3, lng 11.6 to 24.1) with a re-ask.

### 5.4 Messages

All new customer-facing strings go into `src/i18n/messages.ts` in **both** `pt` and `en`, follow the existing `resolveMessages(phone)` locale flow, and **every button/list label is checked against WhatsApp limits** (buttons/list button ≤20, row title ≤24, row description ≤72). The `clampLabel` safety net in `whatsapp.service.ts` stays, but must never be relied on.

## 6. Distance & ETA

### 6.1 Stage 1 — straight-line prefilter (all candidates, in SQL)

```sql
-- in searchProductsInInventory, when a customer location is known
AND s.latitude BETWEEN $lat - $dLat AND $lat + $dLat      -- bounding box from max radius
AND s.longitude BETWEEN $lng - $dLng AND $lng + $dLng
AND haversine_km(s.latitude, s.longitude, $lat, $lng) <= s.service_radius_km
```

`haversine_km` is a new `IMMUTABLE` SQL function in `schema.sql`. Estimated road distance = `haversine_km × ROAD_FACTOR` (config, default **1.4** for Luanda; tune from real routing data after launch).

### 6.2 Stage 2 — routing API (top N only)

- After scoring with stage-1 estimates, take the **top 5** candidates and call the routing provider once (a single Distance Matrix call: 5 origins × 1 destination).
- Cache per `(supplier_id, round(lat,3), round(lng,3), hour-of-week bucket)` in Redis for 24h (`route:*` keys, via `cache.service.ts`). ~100 m precision is plenty for ETA.
- Re-score those 5 with real values; the final top 3 go to the customer.
- **Fails open**: on timeout (3s) or error, keep stage-1 estimates, log a warning, and mark the ETA as approximate. Same "AI/external calls never block the flow" principle as the Claude call sites.

### 6.3 ETA formula

```
eta_min = prep_time_minutes(supplier, adjusted for opening hours) + travel_minutes
eta_max = eta_min × 1.5   (or × 2 when the customer location source is 'municipality')
```

- If the supplier is **closed now**, prep starts at the next opening time (from `opening_hours`).
- Shown to customers as a range rounded to friendly units: "~1–2 h", "hoje até às 17h", "amanhã de manhã".

## 7. Delivery cost

```
fee = max(MIN_FEE, base_fee + per_km × road_km)
fee = min(fee, MAX_FEE)
fee = round_up_to(fee, 500)      -- Kz, avoids odd amounts
pickup → fee = 0
```

- `base_fee` / `per_km` come from the supplier row, else global config (`DELIVERY_BASE_FEE`, `DELIVERY_PER_KM`, `DELIVERY_MIN_FEE`, `DELIVERY_MAX_FEE` read through `config.ts`, never `process.env` directly).
- **Basket consolidation**: items allocated to the **same supplier** pay **one** delivery fee (the highest of their computed fees), not one per item.
- The fee appears as its own line on the proforma (`generateProformaPDF`) and final invoice (`generateInvoicePDF`), and is included in the payment total and payment-proof validation amount.
- The fee is **frozen** on the allocation row at order creation; later config changes never alter an existing order's price.

## 8. Supplier scoring & ranking

### 8.1 Hard filters (pass/fail, before scoring)

Active supplier and offer · quantity > 0 · vehicle fit (existing `anyFitMatches`) · part type (existing soft filter) · within `service_radius_km` (or pickup chosen) · stock confidence ≥ `MIN_STOCK_CONFIDENCE` (default 0.3).

### 8.2 Score components (each normalised to 0–1 across the candidate set, 1 = best)

| Component | Raw input | Normalisation |
|---|---|---|
| `price` | `offer.price + delivery_fee` (landed cost) | min-max, inverted |
| `speed` | `eta_minutes_max` | min-max, inverted |
| `confidence` | stock confidence (§8.4) | already 0–1 |
| `reliability` | `confirmed_available / confirm_requests` (Bayesian-smoothed, prior 0.8 with weight 5) blended with `rating / 5` | already 0–1 |

`score = Σ weight_i × component_i`

### 8.3 Weights by customer preference

| Preference | price | speed | confidence | reliability |
|---|---|---|---|---|
| `lowest_cost` | 0.55 | 0.10 | 0.20 | 0.15 |
| `fastest` | 0.10 | 0.55 | 0.20 | 0.15 |
| `balanced` (default) | 0.35 | 0.30 | 0.20 | 0.15 |

Weights live in one config object (`src/config/ranking.ts`) so they can be tuned without touching logic. The breakdown stored in `order_allocations.score_breakdown`:

```json
{ "preference": "balanced",
  "weights":    { "price": 0.35, "speed": 0.30, "confidence": 0.20, "reliability": 0.15 },
  "raw":        { "landedCost": 18500, "etaMax": 95, "confidence": 0.82, "reliability": 0.91 },
  "normalised": { "price": 0.74, "speed": 0.60, "confidence": 0.82, "reliability": 0.91 } }
```

### 8.4 Stock confidence

```
freshness  = exp(-hours_since(stock_updated_at) / HALF_LIFE_HOURS)   -- default half-life 72h
source_w   = admin_confirmed 1.0 | api 0.9 | import 0.7
confidence = source_w × (0.6 × freshness + 0.4 × supplier_confirm_rate)
```

`stock_updated_at` is bumped on every inventory import/API push, and set with `stock_source = 'admin_confirmed'` whenever an admin confirms that offer as available.

### 8.5 Tie-breaks

Equal score (to 4 dp) → lower landed cost → higher reliability → lower `product_suppliers.id` (deterministic).

### 8.6 Where it lives

A new pure module `src/services/ranking.service.ts` (no DB, no I/O: input candidates + location + preference → ranked list with breakdowns), so it can be unit-tested in isolation. `product.model.ts` fetches candidates, `routing.service.ts` enriches with distance/ETA, `ranking.service.ts` scores. This is the first good place to introduce a test runner (see §12).

## 9. Customer preference (WhatsApp)

- Asked **once**, the first time a geo-ranked search runs, as a 3-button message:
  `⚡ Mais rápido` · `💰 Mais barato` · `⚖️ Equilibrado` (en: `⚡ Fastest` · `💰 Lowest cost` · `⚖️ Best balance`), all ≤20 chars.
- Saved to `customers.delivery_preference`; later searches use it silently. The results-list body states it ("Ordenado por: mais rápido") and the customer can type "mais barato" / "mais rápido" etc. to re-rank the current results (deterministic keyword match, like `ORDER_STATUS_PATTERN`).
- Results list rows change to show delivery info within WhatsApp limits:
  - title (≤24): product name (existing truncate)
  - description (≤72): `12 500 Kz + 2 000 entrega • ~1–2h • Talatona`

## 10. Order allocation

### 10.1 Lifecycle

1. **Customer picks a result** → an `order_allocations` row is written for that offer with `decided_by = 'system'`, the rank/score it had, and the frozen delivery fee/ETA. (The customer's pick *is* the allocation; it's normally rank 1–3.)
2. **Stock confirmation** (existing `awaiting_stock_confirmation`) is requested for the allocated supplier, as today.
3. **Supplier/admin says unavailable** → instead of immediately asking the customer to pick an alternative, the system **auto-falls back** to the next-ranked candidate for the same product **if** its landed cost is ≤ the original + `FALLBACK_MAX_PRICE_DELTA` (default 10%) and its ETA is not more than one band worse. A new allocation row is written, the previous marked `rejected_by_supplier`, and the new supplier is asked to confirm. The customer is told: *"O fornecedor X não tinha stock, já encontrámos noutro sítio: novo prazo ~2–3h, mesmo preço."*
4. If no candidate passes that rule → **today's alternative-resolution flow** (`awaiting_alternative_resolution`) runs unchanged.
5. Max **2 automatic fallbacks** per item, then hand to an operator.

### 10.2 Operator override

- From the dashboard (§11), an admin can pick any eligible candidate **before payment approval**. A reason is required when choosing anything other than rank 1.
- If the override changes the landed cost, the customer gets a new proforma and must accept (Sim/Não buttons) before the order proceeds; a cheaper-or-equal override proceeds with a notice only.
- After payment approval, allocation is locked (changing it would be a refund/re-charge, out of scope).

### 10.3 Basket orders

Allocation and fallback run **per item** (`order_allocations.item_id`). Delivery fee consolidation (§7) is recomputed whenever any item's allocation changes.

## 11. Operator dashboard (`rede-pecas-admin`)

### 11.1 New pages

| Page | Contents |
|---|---|
| **Suppliers** (`/suppliers`) | Grid (existing `components/Grid`) with name, municipality, location status, active offers, confirm rate, avg response time, rating. Detail/edit modal: contact, address, **map pin picker**, service radius, prep time, opening hours editor, delivery fee overrides, pickup toggle, active toggle. "Needs location" filter. |
| **Supplier map** (`/suppliers/map`) | All suppliers on a map with radius circles, to spot coverage gaps. |
| **Allocation panel** (inside the existing Order detail modal) | Per item: the allocated supplier + ranked candidates table (score, landed cost, delivery fee, distance, ETA, confidence, reliability, expandable score breakdown). "Allocate to this supplier" action with reason field. Allocation history timeline. |

Map library: **Leaflet + OpenStreetMap tiles** (free, no key) for display/pin picking; the routing provider is only used server-side.

Follows existing admin conventions: one `store/suppliers/` service+slice pair, page + `types.ts` + `adapters.ts`, English UI text with `pt` translations in `lib/i18n/translations/`.

### 11.2 New API endpoints (`/v1/admin`, JWT, Joi-validated, standard envelope, `/`-nested paths)

| Method | Path | Purpose |
|---|---|---|
| GET | `/suppliers` | List (filters: `active`, `needsLocation`, `municipality`, search) |
| GET | `/suppliers/:id` | Detail incl. `supplier_stats` |
| POST | `/suppliers` | Create |
| PATCH | `/suppliers/:id` | Update (incl. location, hours, fees) |
| PATCH | `/suppliers/:id/status` | Activate/deactivate (mirrors `/customers/:phone/status`) |
| GET | `/orders/:number/allocation` | Current allocation + ranked candidates + history, per item |
| POST | `/orders/:number/allocation` | Override: body `{ itemId?, offerId, reason }` |
| GET | `/municipalities` | Reference list for pickers |

`getOrCreateSupplierByName` in the inventory import stays, but newly auto-created suppliers have no location and show up under "needs location".

## 12. Testing

- **First automated tests in this repo**: add Vitest, starting with `ranking.service.ts` (pure), delivery fee calculation, ETA/opening-hours logic and `haversine_km` parity (SQL vs TS). These are deterministic, money-affecting rules: exactly where tests pay off most.
- Extend `TESTING.md` with the manual WhatsApp matrix: location pin, municipality fallback, pickup, each preference, auto-fallback, operator override (cheaper vs dearer), basket with two suppliers.
- Seed data: 5–8 suppliers across Luanda municipalities with coordinates, overlapping offers for the same seeded parts, and varied `stock_updated_at`, so every ranking path is reproducible locally.

## 13. Open questions (need answers before build)

| # | Question | Why it matters |
|---|---|---|
| 1 | **Who delivers?** Supplier's own drivers, a Rede Peças courier, or a third party? | Drives whether delivery fee goes to the supplier or Rede Peças, and who confirms "delivered" (needed for `on_time_deliveries`). |
| 2 | **Delivery pricing owner**: one Rede Peças tariff, or per-supplier tariffs? | Default design supports both; confirms which fields the dashboard exposes. |
| 3 | **Routing API budget**: approve Google Distance Matrix spend, or self-host OSRM? | Cost vs ETA accuracy (OSRM has no live traffic). |
| 4 | **Supplier data collection**: who gathers coordinates/hours for existing suppliers, and by when? | Geo-ranking only works for located suppliers. |
| 5 | **Supplier stock sync**: keep CSV imports only, or let suppliers push stock via an API using the existing `suppliers.api_key`? | Biggest lever on stock confidence. |
| 6 | **Pickup**: do we offer "collect from supplier" at launch? | Adds a fulfilment branch to messages, PDFs and allocation. |
| 7 | **Coverage outside Luanda**: launch Luanda-only? | Determines municipality seed data and default radius. |
| 8 | **Auto-fallback consent**: is a ≤10% price increase acceptable without asking the customer, or must any increase be confirmed? | Default design proceeds silently only for equal-or-cheaper; confirm the threshold. |

## 14. Phased rollout

| Phase | Deliverable | Customer-visible? |
|---|---|---|
| **2.0a: Data foundation** | Schema (§4), municipalities seed, supplier CRUD API + admin Suppliers pages + map, `supplier_stats` tracking from existing stock confirmations. | No |
| **2.0b: Customer location** | WhatsApp location pin / municipality / pickup capture (§5), `customer_locations`. | Yes (one new question) |
| **2.0c: Ranking engine** | `haversine_km`, routing service + cache, delivery fee, stock confidence, `ranking.service.ts` + Vitest. Run in **shadow mode**: compute and log rankings alongside today's price-first results without changing them. | No |
| **2.0d: Geo-ranked search** | Flip `ALLOCATION_ENABLED`: ranked results, delivery info in list rows, preference question, delivery fee on proforma/invoice/payment total. | Yes |
| **2.0e: Allocation & dashboard** | `order_allocations`, auto-fallback on rejection, operator allocation panel + override endpoints. | Yes |

Shadow mode in 2.0c is the key risk control: we compare "what the new ranking would have offered" against what customers actually bought, and tune weights/road factor on real data before any customer sees it.

## 15. Risks

| Risk | Mitigation |
|---|---|
| Suppliers without coordinates silently vanish from results | They stay in the fallback price-first search until located; dashboard "needs location" filter; launch gate = ≥90% of active offers' suppliers located. |
| ETA promises we can't keep | Show ranges, never exact times; widen for municipality-precision locations; track `late_deliveries` and feed into reliability. |
| Routing API cost/latency spikes | Top-5-only calls, 24h cache, 3s timeout, haversine fallback. |
| Customers confused by an extra question | Asked once, lazily, with a one-tap native "send location" button. |
| Delivery fee changes the payment amount the proof validator expects | `extractPaymentProofData` amount check and admin push use the new total (part + service + delivery). |
| WhatsApp label limits (cf. the 2026-10-16 `Escolher tipo de peça` incident) | Every new label checked against limits in both locales in code review; `clampLabel` logs any overflow. |
