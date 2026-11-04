# Shelvin API contract

The app ships an in-memory mock of exactly this contract (`app/src/api/mock/`), which it uses in mock (demo) mode.
The TypeScript source of truth is `app/src/api/types.ts`; the client is `app/src/api/http.ts`. Field names below are
fixed. You may **add** fields; don't rename or remove them.

Identification (barcode or photo → product) runs **in the app**; the backend has no `/identify`. Page search runs **on
the backend** (`POST /search`). For the whole picture (what to build, search, scrapers, persistence, cost,
acceptance), read [`backend-spec.md`](backend-spec.md). To check a server against this contract, run
[`tools/contract-check`](../tools/contract-check/README.md) (`BASE_URL=… TOKEN=… npm run check`).

To point the app at your server, set these in `app/.env`:

```bash
EXPO_PUBLIC_API_MODE=live
EXPO_PUBLIC_API_BASE_URL=https://<host>   # or http://<lan-ip>:<port> on one Wi-Fi network
EXPO_PUBLIC_API_TOKEN=<team token>
```

## Conventions

- JSON in and out, `Content-Type: application/json`, UTF-8 (Spanish text with accents is normal).
- **Auth:** every request except `GET /health` sends `Authorization: Bearer <token>`. It is one shared team token,
  which the app reads from `EXPO_PUBLIC_API_TOKEN`. A missing or wrong token gets `401` with the error body below.
  Use HTTPS outside your own network.
- CORS: not needed for Expo Go on a phone. To test on the web preview, allow the Expo web dev origin (for example
  `http://localhost:8081`) and the `Authorization` and `Content-Type` headers.
- Times are ISO 8601 UTC strings (`2026-10-28T18:30:00.000Z`). Prices are numbers in major units with an ISO currency (`{ "amount": 21.5, "currency": "MXN" }`).
- Region is always `"MX"`.
- IDs are opaque strings chosen by the server. `ProductIdentity.id` is made by the app (`productIdFor` in `app/src/services/identify/gtin.ts`, the source of truth): `gtin-` + the GTIN-14 when the product has a valid barcode (`7315122013887`, `07315122013887` and `007315122013887` all give `gtin-07315122013887`; UPC-A and EAN-8 are left-padded with zeros), else a stable slug of brand + name + size like `doritos-incognita-62g`. An edit keeps the id while the barcode is unchanged. Keep it as the product key. The backend stores the product under a canonical id (the same barcode, or the same brand + name + size, is one product) and records the id the app sent as an alias, so `POST /search` answers with the id the app sent and every later call with that id (`/scrape`, `/scrapers/build`, `GET /products/:id`, `GET /products/:id/listings`) reaches the same product. `GET /scans` and `GET /products/:id` show the canonical id.
- The app gives up on a plain request after 20 s (aim for 2 s; [`backend-spec.md` §2](backend-spec.md#2-connection-rules), "Timeouts"). Anything slower must be a **job** (below).

### Errors

Every non-2xx response has this body:

```json
{ "error": "Product doritos-incognita-62-g not found", "code": "not_found" }
```

`error` is a **string** and is shown to the user, so keep it short and human. `code` is optional. Suggested codes:
`invalid_request` (400), `invalid_url` (400), `unauthorized` (401), `not_found` (404), `too_large` (413),
`rate_limited` / `over_budget` (429), `internal` (500), `upstream_failed` (502).

Keep the body flat: the app's client reads `error` as a string, so a nested `{ "error": { "code", "message" } }` would
show "[object Object]".

### Jobs (slow operations)

`POST /search`, `POST /scrapers/build` and `POST /scrape` return a `Job` immediately (HTTP 202 or 200).
`POST /scrapers/build-batch` returns one build job per site.
The app polls `GET /jobs/:jobId` **every 1 s** until `status` is `succeeded` or `failed`.

```ts
interface Job<T> {
  jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progress?: { step: string; message: string; percent?: number };
  result?: T;      // present when succeeded
  error?: string;  // present when failed; shown to the user
  agentRun?: AgentRun;  // build jobs: the builder's record; agentRun.access is set when the site refused
  sites?: ScrapeSite[]; // scrape jobs: each page's progress
}
```

`progress.step` should use these ids, in order. The app draws the whole list up front and ticks off steps as `step` advances; `message` may be more specific than the default label.

| Job | Steps (`step` → default label) |
|---|---|
| search | `search` "Searching the web" → `verify` "Checking each page" → `rank` "Ranking official pages and retailers" |
| scraper build | `probe` "Checking the site" → `build` "Building the scraper" → `gate` "Testing it on the page" → `merge` "Making it live". A failed gate goes back to `build` for the next attempt. |
| scrape | `scrape` "Scraping the pages" → `taxonomy` "Mapping categories" → `save` "Saving listings" |

An unknown `step` leaves the app on its first step. When a job succeeds, `step: "done"` is fine. After the search job,
the app draws one more step of its own, "Looking up scrapers", while it calls `POST /scrapers/match`.

A job that ends in a business failure (search provider down, page blocked) is `status: "failed"` with `error`; it is not an HTTP error on `GET /jobs/:id`. Unknown `jobId` → 404.

Example while running:

```json
{ "jobId": "search_k9x2", "status": "running", "progress": { "step": "verify", "message": "Checking 9 pages", "percent": 45 } }
```

## Shared types

### ProductIdentity (identified in the app; it sends the confirmed one with each search)

```json
{
  "id": "doritos-incognita-62g",
  "brand": "Doritos",
  "productName": "Doritos Incógnita",
  "variant": "Incógnita",
  "size": "62 g",
  "barcode": "7500000000017",
  "manufacturer": "Sabritas (PepsiCo México)",
  "categoryGuess": "Botanas > Totopos",
  "imageUrl": "https://images.openfoodfacts.org/images/products/750/047/801/2138/front_es.7.400.jpg",
  "imageSource": "openfoodfacts",
  "confidence": 0.95,
  "source": "claude",
  "alternatives": [{ "brand": "Doritos", "productName": "Doritos Nacho", "variant": "Nacho", "size": "62 g", "confidence": 0.31 }]
}
```

Optional: `variant`, `size`, `barcode`, `manufacturer`, `categoryGuess`, `imageUrl`, `imageSource`, `alternatives`. The app fills `imageUrl` for the identified product only (Confirm card, Home, saved product header); it is not used for listings. `source` is `mock | claude | openfoodfacts | user_edited`. `imageSource` says where `imageUrl` comes from: `openfoodfacts` (CC BY-SA, credit Open Food Facts), `user_photo` (the user's own photo of the pack, a local URI) or `retailer` (a store's product image).

### SourcePage (a page that lists the product)

```json
{
  "id": "pg-dor-walmart",
  "url": "https://super.walmart.com.mx/ip/botana-doritos-incognita-62-g/00750000000017",
  "domain": "super.walmart.com.mx",
  "retailerName": "Walmart Súper",
  "sourceType": "third_party",
  "title": "Botana Doritos Incógnita 62 g",
  "matchType": "exact",
  "verification": { "status": "verified", "confidence": 0.96, "reason": "Same name, size and barcode" },
  "scraper": { "status": "available", "scraperId": "scr-walmart" },
  "thumbnailUrl": null,
  "access": { "status": "allowed", "code": "allowed", "reason": "robots.txt allows this page" }
}
```

- `sourceType`: `first_party` (the brand's own site) or `third_party` (retailers, marketplaces).
- `matchType`: `exact`, or `similar` with `similarProductId` set to a `SimilarProduct.id`.
- `verification.status`: `verified` | `uncertain` | `rejected` | `user_added`. Rejected pages are shown with their `reason` and are not selectable.
- `scraper.status`: `available` | `missing` | `building` | `failed`. Only `available` pages can be scraped.
- `access` (optional; missing means not checked, treated as allowed): whether the site lets us collect the page,
  from robots.txt and its rule for AI agents (the scraper kit's `robots.access()`). A refused page is never built or
  scraped, and its `scraper.status` is not `available`. The app shows it as **BLOCKED** with the reason and the
  `alternative` (an official API, open data), and offers no Build button and no way around it:

  ```json
  { "status": "refused", "code": "ai_opt_out", "label": "Blocks AI agents",
    "reason": "robots.txt blocks AI agents (ClaudeBot, GPTBot)",
    "alternative": "Amazon's Creators API (needs an Amazon Associates México account)" }
  ```

### Failure and access codes

`PageAccess.code` and the optional `ScrapeResult.failures[].code` (a string, so new codes stay legal) are
machine-readable; `error` / `reason` stay the human text. The app groups failures under **Blocked by the site** (no
retry) or **Couldn't fetch** (try again). A code it doesn't know is shown with its `error` under Couldn't fetch.

| `code` | Where | Meaning | App group |
|---|---|---|---|
| `ai_opt_out` | `access`, `failures` | robots.txt disallows the page for a named AI agent (ClaudeBot, Claude-User, anthropic-ai, GPTBot, ChatGPT-User, PerplexityBot, Perplexity-User) | Blocked by the site |
| `robots_disallow` | `access`, `failures` | robots.txt (2xx) disallows our user agent | Blocked by the site |
| `robots_unavailable` | (not sent) | Reserved; the app still groups it. A robots.txt that answers a non-2xx sets no rules (`access.code: no_robots`), and the site is collected; only rules a site wrote refuse it | Blocked by the site |
| `blocked` | `access`, `failures` | the scraper stopped on 401 or 403, or a redirect off the site; in `access` when a scraper build was blocked that way | Blocked by the site |
| `robots_unreachable` | `failures` | robots.txt couldn't be fetched (network). In `access` it is `no_robots` (allowed): a site that is down fails when collected | Couldn't fetch |
| `rate_limited` | `failures` | the site answered 429 (too many requests): temporary, try again later | Couldn't fetch |
| `no_scraper` | `failures` | the site has no scraper | Couldn't fetch |
| `unreachable` | `failures` | the page couldn't be loaded (timeout, network) | Couldn't fetch |
| `parse_failed` | `failures` | the page loaded but the scraper couldn't read it | Couldn't fetch |
| `not_in_catalog` | `failures` | a brand site's catalog doesn't have the product | Couldn't fetch |
| `not_listed` | `failures` | the store's page loads, but its catalog no longer lists the product (delisted) | Couldn't fetch |
| `allowed`, `no_robots` | `access` | allowed (robots.txt allows, or there is none) | — |

### SimilarProduct

```json
{ "id": "takis-fuego-56g", "brand": "Takis", "productName": "Takis Fuego", "variant": "Fuego", "relation": "competitor", "reason": "Competing spicy corn snack (Barcel)", "imageUrl": null }
```

`relation`: `same_brand` (other flavors) or `competitor`.

### Listing (a scraped result)

```json
{
  "id": "lst-8f2",
  "pageId": "pg-dor-walmart",
  "url": "https://super.walmart.com.mx/ip/botana-doritos-incognita-62-g/00750000000017",
  "domain": "super.walmart.com.mx",
  "retailerName": "Walmart Súper",
  "title": "Botana Doritos Incógnita 62 g",
  "imageUrl": null,
  "price": { "amount": 21.5, "currency": "MXN" },
  "categoryPath": ["Despensa", "Botanas", "Papas y totopos"],
  "standardTaxonomy": {
    "system": "Google Product Taxonomy",
    "path": ["Food, Beverages & Tobacco", "Food Items", "Snack Foods", "Chips"],
    "code": "2392"
  },
  "fields": { "net_weight": "62 g", "availability": "in_stock", "rating": 4.6, "review_count": 128, "sku": "00750000000017", "promo": "3x$55" },
  "scrapedAt": "2026-10-28T18:30:00.000Z"
}
```

- `categoryPath` is the retailer's own breadcrumb, as on the site.
- `standardTaxonomy` is your mapping to a standard taxonomy (Google Product Taxonomy suggested; `code` optional).
- `fields` holds **everything else** the scraper found. Values must be `string | number | boolean | null` (no nested objects). The app shows every key generically (`net_weight` → "Net weight"), so add whatever you have.
- Optional: `title`, `imageUrl`, `price`, `categoryPath`, `standardTaxonomy`.
- `imageUrl` is the product image **as the scraped page shows it** (the retailer's or brand's own image), supplied by the backend. The app never invents or copies a listing image (not the identified product's photo either); leave it `null` when the page has none, and the app shows a placeholder.

## Endpoints

### `GET /health` → `{ ok: true, version? }` (synchronous, no token)

```json
{ "ok": true, "version": "1.4.0" }
```

Answers within 1 s with no upstream calls. Used to check the base URL and by the checker.

### `POST /identify`: not needed

Identification runs in the app (see [`backend-spec.md` §6](backend-spec.md#6-identification-in-the-app-not-on-the-backend)).
The backend first sees a product in the body of `POST /search`.

### `POST /search` → `Job<SearchResult>`

Find pages that list the product (and similar products if asked): the brand's site first, then Mexican retailers.
Verify each, and attach scraper status and `access`. This runs on the backend in
`backend/server/search.py` (recorded searches, or a web search by the configured provider). While `EXPO_PUBLIC_API_MODE` is `mock`, the
app can run its own Claude search instead; in live mode it always calls this endpoint.

Request:

```json
{
  "product": { "id": "doritos-incognita-62g", "brand": "Doritos", "productName": "Doritos Incógnita", "variant": "Incógnita", "size": "62 g", "barcode": "7500000000017", "confidence": 0.95, "source": "claude" },
  "scanType": "both",
  "includeSimilar": true,
  "region": "MX"
}
```

- `scanType`: `first_party` (brand pages only), `third_party` (retailers only), `both`.
- `includeSimilar`: also return `similar` pages and `similarProducts` (same brand **and** competitors).

`result` when succeeded:

```json
{
  "searchId": "srch_abc",
  "product": { "...": "the product as received" },
  "pages": [ { "...": "SourcePage" } ],
  "similarProducts": [ { "...": "SimilarProduct" } ]
}
```

Include rejected pages too (with `reason`); the app shows them in a collapsed "Rejected" list. Retailers we care about: Walmart Súper, Soriana, Chedraui, La Comer, Bodega Aurrera, Amazon México, Mercado Libre, plus the brand's own site.

### `POST /scrapers/match` → `{ matches: ScraperMatch[] }` (synchronous)

Which of these URLs already have a scraper.

```json
// request
{ "urls": ["https://www.chedraui.com.mx/doritos-incognita-62g-3456789/p", "https://www.soriana.com/doritos-incognita-62g/7500000000017.html"] }
// response
{ "matches": [
  { "url": "https://www.chedraui.com.mx/doritos-incognita-62g-3456789/p", "domain": "www.chedraui.com.mx", "status": "missing" },
  { "url": "https://www.soriana.com/doritos-incognita-62g/7500000000017.html", "domain": "www.soriana.com", "status": "available", "scraperId": "scr-soriana" }
] }
```

One match per input URL, same order.

### `POST /scrapers/build` → `Job<BuildScraperResult>`

Build a scraper for a page's site. Used for pages with `scraper.status: "missing"` and for pages the user adds by URL.

```json
// request
{ "url": "https://www.chedraui.com.mx/doritos-incognita-62g-3456789/p", "productId": "doritos-incognita-62g", "pageId": "pg-..." }
// result when succeeded
{
  "scraperId": "chedraui_mx",
  "domain": "chedraui.com.mx",
  "page": { "...": "SourcePage for this URL with scraper.status 'available'; verification.status 'user_added' if the URL was typed by the user" },
  "agentRun": { "...": "AgentRun, final" }
}
```

Invalid URL → HTTP 400 `invalid_url` on the POST itself. Scraper test failed → job `failed` with `error` (the app offers Retry, which POSTs again).
The site refuses collection → job `failed` with `error` and `agentRun.state: "refused"` with `agentRun.access`; the
app then shows the page as blocked, with no Retry.
One build per site at a time: a second POST for a site that is building returns the running job.

While it runs, the job carries `agentRun`, the build's record:

```ts
interface AgentRun {
  buildId: string;
  provider: 'devin' | 'claude_code' | 'scripted' | 'mock';
  url: string; domain: string; kind: 'first_party' | 'third_party';
  state: 'queued' | 'running' | 'building' | 'fixing' | 'passed' | 'exists' | 'failed' | 'refused' | 'blocked' | 'unreachable' | 'needs_person';
  stage: string;      // the builder's stage: probing, writing, capturing, testing, gate, fixing, merging, done
  note: string;       // the latest line, shown as is
  source?: string; sessionUrl?: string; prUrl?: string; branch?: string;
  access?: PageAccess;
  attempt: number; maxAttempts: number;
  attempts: { n: number; verdict?: 'pass' | 'fail' | 'unreachable'; passed: number; total: number;
              failed: { name: string; detail: string }[]; sentBack: boolean; outcome?: string; notes?: string }[];
  events: { at: string; kind: 'system' | 'agent' | 'agent_gate' | 'gate'; stage: string; message: string; attempt: number }[];
  cost?: { usd?: number; acus?: number };
  startedAt: string; endedAt?: string;
}
```

### `POST /scrapers/build-batch` → `{ builds, skipped, parallel }` (synchronous)

One build per missing site among the pages, all started at once (the backend runs up to `parallel` builder
sessions together). The app polls each `jobId` as for `/scrapers/build`.

```json
// request
{ "productId": "takis-fuego-56g", "pageIds": ["pg-1", "pg-2", "pg-3"] }
// response
{ "builds": [{ "pageId": "pg-1", "domain": "chedraui.com.mx", "jobId": "build_1a2" }],
  "skipped": [{ "pageId": "pg-3", "domain": "amazon.com.mx", "code": "ai_opt_out", "reason": "robots.txt blocks AI agents (ClaudeBot)" }],
  "parallel": 4 }
```

`skipped[].code` is the page's access code (`ai_opt_out`, `robots_disallow`, …), `has_scraper` or `unknown_page`;
`reason` is the human text.

### `POST /scrape` → `Job<ScrapeResult>`

Scrape the selected pages and **save** the listings server-side (shared by the whole team).

```json
// request
{ "searchId": "srch_abc", "productId": "doritos-incognita-62g", "pageIds": ["pg-dor-brand", "pg-dor-walmart", "pg-dor-bodega"] }
// result when succeeded
{
  "runId": "run_xyz",
  "saved": true,
  "savedAt": "2026-10-28T18:31:04.000Z",
  "listings": [ { "...": "Listing" } ],
  "failures": [
    { "pageId": "pg-dor-bodega", "url": "https://despensa.bodegaaurrera.com.mx/ip/doritos-incognita-62-g/00750000000017", "error": "Timed out loading the page", "code": "unreachable" },
    { "pageId": "pg-dor-amazon", "url": "https://www.amazon.com.mx/dp/B0EXAMPLE", "error": "Not collected: robots.txt blocks AI agents (ClaudeBot, GPTBot)", "code": "ai_opt_out", "retailerName": "Amazon México" }
  ],
  "catalogs": [ { "pageId": "pg-brand", "domain": "barcel.com.mx", "retailerName": "Barcel", "source": "barcel_mx", "count": 39, "scrapedAt": "...", "listings": [ { "...": "Listing" } ] } ]
}
```

A brand site (`first_party`) is read as its whole catalog: the matched product is its `listing`, and every product
is in `catalogs`. While the job runs it carries `sites`: `{ pageId, domain, retailerName, state: queued | fetching
| done | failed | refused | blocked, message, rows }`.

Each failure is `{ pageId, url, error, code?, retailerName? }` (codes above; `retailerName` names the store on screens
that don't have the search's pages). A refused page that is requested anyway is a failure with its access `code` and
`error: "Not collected: <reason>"`. Partial success is still `succeeded`: put the pages that failed in `failures`. `saved: false` means nothing was persisted (the app shows a warning). Re-scraping a page replaces its previous listing for that product.

### `GET /scans` → `{ scans: ScanSummary[] }`

Recent products for the home screen, newest first.

```json
{ "scans": [
  { "product": { "...": "ProductIdentity" }, "lastScrapedAt": "2026-10-28T18:31:04.000Z", "listingCount": 5 }
] }
```

### `GET /products/:productId/listings` → `{ product, listings }`

All saved listings for a product (latest per page). `product.imageUrl` may be the product photo the app sent with the
search, or one the backend has from the scraped pages; each listing's `imageUrl` is the one its page showed.

```json
{ "product": { "...": "ProductIdentity" }, "listings": [ { "...": "Listing" } ], "failures": [ { "...": "failure, as in ScrapeResult" } ] }
```

`failures` is optional: the pages of this product whose latest scrape failed and that have no listing since. Saved
listings shows them under Blocked by the site / Couldn't fetch.

Unknown product → 404 `not_found`.

### `POST /products` → `{ product }` (synchronous)

Save a product the user confirmed (an upsert by canonical id; posting it again updates it, and the response's
`product.id` is the id to keep). The body is the
`ProductIdentity`, bare or as `{ "product": ProductIdentity }`. `POST /search` also saves its product, so this is
only needed for products saved without a search.

```json
// request
{ "product": { "id": "doritos-incognita-62g", "brand": "Doritos", "productName": "Doritos Incógnita", "size": "62 g", "barcode": "7500000000017", "confidence": 0.95, "source": "claude" } }
// response
{ "product": { "id": "doritos-incognita-62g", "brand": "Doritos", "productName": "Doritos Incógnita", "size": "62 g", "barcode": "7500000000017", "confidence": 0.95, "source": "claude" } }
```

No `id`, or neither `brand` nor `productName` → 400 `invalid_request`.

### `GET /products` → `{ products, total, limit, offset }`

Saved products, most recently updated first. Query: `q` (matches brand or product name, case-insensitive),
`barcode` (leading zeros ignored: `0750103042453` finds `750103042453`), `limit` (1–200, default 50), `offset`.

```json
// GET /products?q=takis&limit=20
{ "products": [ { "...": "ProductIdentity" } ], "total": 1, "limit": 20, "offset": 0 }
```

### `GET /products/:productId` → `{ product, pages, listings }`

The saved product, every page found for it (`SourcePage`, with the latest scraper status) and the latest listing
per page (as `GET /products/:productId/listings`). Unknown product → 404 `not_found`.

### `GET /builds` → `BuildHistory` (synchronous)

Every scraper build the backend has recorded, newest first, and a tally per site, so the app can show how each
site's builds went over time. Query: `domain`, `state` (a `BuildState`), `limit` (1–200, default 50). The tally
and totals always count every build, whatever the filter.

```ts
interface BuildHistory {
  builds: AgentRun[];          // newest first; each with its attempts and only its last 5 events
  sites: BuildSite[];          // every host ever built, most recent activity first, then installed sources never built here
  totals: { builds: number; passed: number; failed: number; refused: number; running: number };
  running: number;             // builder sessions running
  parallel: number;            // the most the backend runs at once
}
interface BuildSite {
  domain: string;
  builds: number;
  passed: number;              // state passed
  failed: number;              // states failed, needs_person, blocked, unreachable
  refused: number;             // state refused
  lastState: BuildState;       // "exists" for a source installed in the kit that this backend never built
  lastBuildId: string | null;  // null when no build ran here
  lastAt: string | null;
  source?: string | null;      // the source that collects it (a passed build, or the kit's source for the host)
  installed?: boolean;         // a source in the kit collects this host
}
```

`AgentRun` also carries `productId` and `pageId` (both may be null).

### `GET /builds/:buildId` → `BuildDetail` (synchronous)

One build's whole recording: `AgentRun` with **every** event (oldest first) and `gates`, where `gates[i]` is the
backend's gate report on `attempts[i]`, or `null` when that attempt never reached the gate. Unknown build → 404.

```ts
interface BuildDetail extends AgentRun { events: AgentEvent[]; gates: (GateReport | null)[] }
interface GateReport {
  source: string | null;
  verdict: "pass" | "fail" | "unreachable";
  rows?: number;
  checks: { name: string; passed: boolean; detail: string }[];
}
```

With `DATABASE_URL` set, both read Postgres (`builds`, `build_attempts`, `build_events`), written on every event of
every build; without it, the JSON store under `DATA_DIR`.

## Typical flow

1. The app identifies the product on the phone (barcode or photo → Open Food Facts + Claude), and the user confirms or
   edits it. No backend call.
2. `POST /search` with the confirmed product → poll `GET /jobs/:id` → pages, each with `scraper` and `access`.
3. `POST /scrapers/match` with the page URLs (lets the server re-check scrapers that changed meanwhile).
4. Optional: `POST /scrapers/build` for missing scrapers or user-added URLs → poll (`probe` → `build` → `gate` → `merge`).
5. `POST /scrape` with the selected page ids → poll → results screen.
6. Home: `GET /scans`; saved product screen: `GET /products/:id/listings` (or `GET /products/:id` for the pages too).
7. Anywhere: `POST /products` to save a confirmed product, `GET /products?q=` / `?barcode=` to find saved ones.

## What the mock does (so you can compare)

Search takes 4–6 s; scraper builds 3 s (Chedraui succeeds, La Comer fails once then succeeds); scrape 3–4 s
with Bodega Aurrera failing (`unreachable`) and HEB México stopped by a 403 (`blocked`, in the mock only). Amazon and
Mercado Libre come back with `access` refused (`ai_opt_out`, as the scraper kit's robots check reports for those
sites), and building a scraper for either fails with `agentRun.access`. Fixtures: `app/src/api/mock/fixtures.ts` (fictional barcodes, illustrative URLs).
