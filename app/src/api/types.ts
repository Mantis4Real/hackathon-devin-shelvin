// API contract between the app and the backend. See docs/api-contract.md.
// Names here are the contract: add fields if needed, never rename.

export type Region = 'MX';
export type ScanType = 'first_party' | 'third_party' | 'both';

export type ScanInput =
  | { kind: 'barcode'; code: string; format?: string }
  | { kind: 'manual'; code: string }
  | { kind: 'photo'; uri: string; base64: string; mimeType: 'image/jpeg' | 'image/png' };

export interface ProductIdentity {
  id: string;
  brand: string;
  productName: string;
  variant?: string;
  size?: string;
  barcode?: string;
  manufacturer?: string;
  categoryGuess?: string;
  imageUrl?: string;
  /** Where `imageUrl` comes from. Open Food Facts images are CC BY-SA (credit "Open Food Facts"). */
  imageSource?: 'openfoodfacts' | 'user_photo' | 'retailer';
  /** 0..1 */
  confidence: number;
  source: 'mock' | 'claude' | 'openfoodfacts' | 'user_edited';
  alternatives?: ProductAlternative[];
}

export type ProductAlternative = Pick<ProductIdentity, 'brand' | 'productName' | 'variant' | 'size'> & {
  confidence: number;
};

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface JobProgress {
  step: string;
  message: string;
  percent?: number;
}

export interface Job<T> {
  jobId: string;
  status: JobStatus;
  progress?: JobProgress;
  result?: T;
  error?: string;
  /** Build jobs: the builder session's live record. */
  agentRun?: AgentRun;
  /** Scrape jobs: each page's progress. */
  sites?: ScrapeSite[];
}

/** Whether the site lets us collect the page: robots.txt and its rule for AI agents, checked by the backend. */
export interface PageAccess {
  status: 'allowed' | 'refused';
  /** allowed | no_robots | ai_opt_out | robots_disallow | robots_unavailable | robots_unreachable */
  code: string;
  reason: string;
  /** Short chip text for a refusal, e.g. "Blocks AI agents". */
  label?: string;
  /** Where to get the data instead, e.g. an official API. */
  alternative?: string | null;
}

export type AgentProvider = 'devin' | 'claude_code' | 'scripted' | 'mock';
export type BuildState =
  | 'queued'
  | 'running'
  | 'building'
  | 'fixing'
  | 'passed'
  | 'exists'
  | 'failed'
  | 'refused'
  | 'blocked'
  | 'unreachable'
  | 'needs_person'
  | 'stopped';

/** One builder attempt and the gate's verdict on it. */
export interface GateAttempt {
  n: number;
  startedAt: string;
  endedAt?: string | null;
  /** What the builder reported, e.g. built_no_pr, pr_opened, kit_gap. */
  outcome?: string | null;
  verdict?: 'pass' | 'fail' | 'unreachable' | null;
  passed: number;
  total: number;
  failed: { name: string; detail: string }[];
  /** The gate's report went back to the same session for the next attempt. */
  sentBack: boolean;
  notes?: string | null;
}

export interface AgentEvent {
  at: string;
  /**
   * system: the backend · agent: the builder's own progress · agent_gate: the builder ran the gate · gate: the backend's
   * gate · person: someone in the console (a message to the builder, a stop, a gate run, another attempt) · decision: a
   * choice that shapes the source, recorded by the builder or settled by a person (`decision` holds it)
   */
  kind: 'system' | 'agent' | 'agent_gate' | 'gate' | 'person' | 'decision';
  stage: string;
  message: string;
  attempt: number;
  /**
   * The gate's summary. `manual`: a run someone asked for in the console (it checks, never merges), with every check.
   */
  gate?: { source: string | null; verdict: string; passed: number; total: number; manual?: boolean; checks?: GateCheck[] };
  /** person events: who acted ("Acting as" in the console). */
  by?: string;
  /** person events: what the message was about, when it was sent from a trace line, a gate check or a diff line. */
  context?: NoteContext;
  /** decision events: the decision as it stands after this event (every version is kept, newest last). */
  decision?: DecisionCard;
}

/** A choice that shapes a scraper source: what the builder picked, why, and what it turned down. */
export interface DecisionCard {
  /** reader, endpoint, product_id, price, availability, coverage, pacing, ... */
  topic: string;
  choice: string;
  why: string;
  alternatives: string[];
  /** proposed: the builder's own · confirmed: a person agreed · changed: a person picked another choice */
  status: 'proposed' | 'confirmed' | 'changed';
  /** "Devin", or the person who settled it. */
  by: string;
}

/** A decision with the build it belongs to: GET /builds/:id (decisions, reused) and GET /decisions. */
export interface Decision extends DecisionCard {
  at: string;
  buildId: string;
  domain: string;
  source?: string | null;
  /** The kit reader the build used (vtex, shopify, jsonld, ...): similar builds share it. */
  reader?: string | null;
  /** The build's state now: a decision from a passed build is the one reused first. */
  outcome?: BuildState;
}

export interface GateCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** What a console message is about: it is quoted to the builder ahead of the message. */
export type NoteContext =
  | { kind: 'event'; at: string; message: string }
  | { kind: 'check'; name: string; detail: string }
  | { kind: 'line'; path: string; line: number; text: string };

/** A scraper build: the backend manages it, a builder session (Devin) does the work, the gate decides. */
export interface AgentRun {
  buildId: string;
  provider: AgentProvider;
  url: string;
  domain: string;
  kind: 'first_party' | 'third_party';
  state: BuildState;
  /** The builder's current stage: probing, writing, capturing, testing, gate, fixing, merging, done. */
  stage: string;
  note: string;
  source?: string | null;
  sessionUrl?: string | null;
  prUrl?: string | null;
  branch?: string | null;
  access?: PageAccess | null;
  attempt: number;
  maxAttempts: number;
  attempts: GateAttempt[];
  /** The latest events, oldest first. */
  events: AgentEvent[];
  cost?: { usd?: number; acus?: number };
  startedAt: string;
  endedAt?: string | null;
  productId?: string | null;
  pageId?: string | null;
  /** The builder asked a question and is waiting for a person: its words. Null once someone answers or it moves on. */
  question?: string | null;
  /** Another attempt someone started in the console: the build it continues. */
  continues?: string | null;
  /** True while this backend is running the build. A build left in an active state but not live was cut off by a restart. */
  live?: boolean;
}

/** GET /builds?domain=&state=&limit= : every recorded build, newest first, and a per-site tally. */
export interface BuildHistory {
  /** Newest first; each with its attempts and only its last 5 events. */
  builds: AgentRun[];
  /** Every host ever built, most recent activity first. */
  sites: BuildSite[];
  totals: { builds: number; passed: number; failed: number; refused: number; running: number };
  /** Builder sessions working now, and the most the backend runs at once. */
  running: number;
  parallel: number;
}

export interface BuildSite {
  domain: string;
  builds: number;
  /** state passed */
  passed: number;
  /** states failed, needs_person, blocked, unreachable */
  failed: number;
  /** state refused */
  refused: number;
  lastState: BuildState;
  /** null for a source installed in the kit that this backend never built (merged from a PR, built elsewhere). */
  lastBuildId: string | null;
  lastAt: string | null;
  source?: string | null;
  /** A source in the kit collects this host now. */
  installed?: boolean;
}

/** One gate run on one attempt: every check, as the backend's gate wrote it. */
export interface GateReport {
  source: string | null;
  verdict: 'pass' | 'fail' | 'unreachable';
  rows?: number;
  checks: GateCheck[];
}

/** GET /builds/:buildId : the whole recording of one build. */
export interface BuildDetail extends AgentRun {
  /** All events, oldest first (AgentRun.events elsewhere holds only the latest). */
  events: AgentEvent[];
  /** gates[i] is the gate's report on attempts[i], or null when that attempt never reached the gate. */
  gates: (GateReport | null)[];
  /** What the console may do to this build now, as the backend decides; `why` says why not. */
  controls?: BuildControls;
  /** The build's decisions as they stand (the latest version of each topic). */
  decisions?: Decision[];
  /** Decisions from similar builds (same reader) that the builder was given to start from. */
  reused?: Decision[];
}

export type BuildControl = 'message' | 'stop' | 'retry' | 'gate' | 'changes' | 'insights' | 'decide';

/**
 * POST /builds/:buildId/decisions : confirm a decision, or change it to another choice. A change on a live build is sent
 * to the builder too, which redoes what depends on it.
 */
export interface DecisionRequest {
  topic: string;
  action: 'confirm' | 'change';
  /** For a change: the new choice (one of the alternatives, or anything typed). */
  choice?: string;
  why?: string;
  by?: string;
}

export interface DecisionResult {
  decision: Decision;
  /** The change went to the builder session. */
  sentToBuilder: boolean;
}

/** GET /decisions?reader= : the saved decisions every next similar build starts from, and whether reusing them pays. */
export interface DecisionLibrary {
  /** The decision a next build with that reader would be given, per reader and topic, with how many builds made it. */
  decisions: (Decision & { uses: number })[];
  performance: ReaderPerformance[];
}

/** Builds per reader, split by whether they started from saved decisions. */
export interface ReaderPerformance {
  reader: string;
  fresh: BuildStats;
  reused: BuildStats;
}

export interface BuildStats {
  builds: number;
  passed: number;
  /** Passed the gate on attempt 1. */
  firstTry: number;
  avgAttempts: number | null;
  avgAcus: number | null;
  avgMinutes: number | null;
}
export type BuildControls = Record<BuildControl, { ok: boolean; why?: string }>;

/** POST /builds/:buildId/messages : a message to the build's builder session (Devin), quoted with its context. */
export interface BuildMessageRequest {
  message: string;
  by?: string;
  context?: NoteContext;
}

/** POST /builds/:buildId/retry : another attempt with a person's note. */
export interface BuildRetryRequest {
  message: string;
  by?: string;
}

/**
 * The new build. `sameSession`: it continues the same builder session (the backend still held it), so the builder keeps
 * its context; otherwise it is a fresh build whose prompt carries the note.
 */
export interface BuildRetryResult {
  buildId: string;
  jobId: string;
  sameSession: boolean;
}

/** GET /builds/:buildId/changes : what the builder changed in its two paths, against the base it started from. */
export interface BuildChanges {
  source: string | null;
  /** The branch or workspace the diff was read from, e.g. "source/walmart_mx" or "workspace". */
  head: string | null;
  base: string | null;
  files: ChangedFile[];
}

export interface ChangedFile {
  /** Kit-relative, e.g. "sources/walmart_mx.py" or "fixtures/walmart_mx/expected.json". */
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  /** Too big to show (a capture): only the counts. */
  truncated?: boolean;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  /** Line number in the old file (del, ctx) and in the new file (add, ctx). */
  old?: number;
  new?: number;
  text: string;
}

/** GET /builds/:buildId/insights (and POST to generate): Devin's own analysis of the build's session. */
export interface SessionInsights {
  sessionUrl: string | null;
  /** null: never generated · started: Devin is analysing · completed · failed */
  status: 'started' | 'completed' | 'failed' | null;
  /** Devin's session size: xs, s, m, l, xl. */
  size?: string | null;
  acus?: number | null;
  messages?: { user: number; devin: number };
  issues: { label: string; title: string; issue: string; impact: string }[];
  actionItems: { type: string; item: string }[];
  /** How the session used the repo's skills (build-source): what went well and what didn't. */
  skillUsage: { good: { skill: string; reason: string }[]; bad: { skill: string; reason: string }[] };
  suggestedPrompt?: { original: string; suggested: string; feedback: { summary: string; details: string }[] } | null;
  timeline: { title: string; description: string }[];
}

export interface BuildQuery {
  domain?: string;
  state?: BuildState;
  limit?: number;
}

export interface ScrapeSite {
  pageId: string;
  domain: string;
  retailerName: string;
  state: 'queued' | 'fetching' | 'done' | 'failed' | 'refused' | 'blocked';
  message: string;
  rows: number;
}

export interface SearchRequest {
  product: ProductIdentity;
  scanType: ScanType;
  includeSimilar: boolean;
  region: Region;
}

export type VerificationStatus = 'verified' | 'uncertain' | 'rejected' | 'user_added';
export type ScraperStatus = 'available' | 'missing' | 'building' | 'failed';

export interface SourcePage {
  id: string;
  url: string;
  domain: string;
  retailerName: string;
  sourceType: 'first_party' | 'third_party';
  title: string;
  matchType: 'exact' | 'similar';
  similarProductId?: string;
  verification: { status: VerificationStatus; confidence: number; reason: string };
  scraper: { status: ScraperStatus; scraperId?: string };
  thumbnailUrl?: string;
  /** Missing means not checked (older backends): treat as allowed. */
  access?: PageAccess;
}

export interface SimilarProduct {
  id: string;
  brand: string;
  productName: string;
  variant?: string;
  relation: 'same_brand' | 'competitor';
  reason: string;
  imageUrl?: string;
}

export interface SearchResult {
  searchId: string;
  product: ProductIdentity;
  pages: SourcePage[];
  similarProducts: SimilarProduct[];
}

export interface ScraperMatch {
  url: string;
  domain: string;
  status: ScraperStatus;
  scraperId?: string;
  /** Set while a build for that site is running. */
  buildJobId?: string;
}

export interface BuildScraperRequest {
  url: string;
  productId?: string;
  pageId?: string;
}

export interface BuildScraperResult {
  scraperId: string;
  domain: string;
  page: SourcePage;
  agentRun?: AgentRun;
}

/** POST /scrapers/build-batch: one build per missing site, run in parallel. */
export interface BuildBatchRequest {
  productId?: string;
  pageIds: string[];
}

export interface BuildBatchResult {
  /** `duplicate`: another page on the same site, sharing that site's build job. */
  builds: { pageId: string; domain: string; jobId: string; duplicate?: boolean }[];
  /** Pages no build was started for, and why ("already has a scraper", the site's refusal, "unknown page"). */
  skipped: { pageId: string; domain: string | null; reason: string; code?: string }[];
  /** How many builder sessions the backend runs at once. */
  parallel: number;
}

/** GET /health. `agent` is the builder the backend runs: devin, claude_code or scripted. */
export interface Health {
  ok: boolean;
  version?: string;
  agent?: AgentProvider;
  /** Who searches for pages: fixtures (recorded searches only), claude, devin or agent. */
  search?: string;
  /** Whether the backend asks for the team token. */
  auth?: boolean;
  sources?: string[];
}

export interface ScrapeRequest {
  searchId: string;
  productId: string;
  pageIds: string[];
}

export interface Listing {
  id: string;
  pageId: string;
  url: string;
  domain: string;
  retailerName: string;
  title?: string;
  /** The image on the scraped page, from the backend. The app never fills it (not with the product photo either). */
  imageUrl?: string;
  price?: { amount: number; currency: string };
  /** The retailer's own breadcrumb. */
  categoryPath?: string[];
  standardTaxonomy?: { system: string; path: string[]; code?: string };
  /** Everything else the backend returns, shown generically. */
  fields: Record<string, string | number | boolean | null>;
  /** ISO timestamp */
  scrapedAt: string;
}

/**
 * `ScrapeResult.failures[].code` values the app knows. The refusal codes are `PageAccess` codes (scraper kit
 * `robots.access()`); `blocked` means the kit stopped on 401/403/429 or a redirect off the site. `rate_limited`
 * (a 429 told apart from a refusal, if the backend sends it) is temporary: retryable, not blocked. A code the app
 * doesn't know is shown with `error`, as a page that couldn't be fetched.
 */
export type FetchFailureCode =
  | 'ai_opt_out'
  | 'robots_disallow'
  | 'robots_unavailable'
  | 'robots_unreachable'
  | 'no_scraper'
  | 'blocked'
  | 'rate_limited'
  | 'unreachable'
  | 'parse_failed'
  | 'not_in_catalog'
  | 'not_listed';

export interface ScrapeFailure {
  pageId: string;
  url: string;
  error: string;
  /** A `FetchFailureCode`, as a string so newer codes stay legal. */
  code?: string;
  /** The store's name, for screens that don't have the search's pages (Saved listings). */
  retailerName?: string;
}

export interface ScrapeResult {
  runId: string;
  saved: boolean;
  savedAt?: string;
  listings: Listing[];
  failures: ScrapeFailure[];
  /** A brand site is read as its whole catalog. */
  catalogs?: BrandCatalog[];
  sites?: ScrapeSite[];
}

export interface BrandCatalog {
  pageId: string;
  domain: string;
  retailerName: string;
  source: string;
  count: number;
  scrapedAt: string;
  listings: Listing[];
}

export interface ScanSummary {
  product: ProductIdentity;
  lastScrapedAt?: string;
  listingCount: number;
}

export interface ProductListings {
  product: ProductIdentity;
  listings: Listing[];
  /** Pages of this product whose latest scrape failed and that have no listing since. */
  failures?: ScrapeFailure[];
}

/** GET /products: `q` matches brand or product name (case-insensitive); `barcode` ignores leading zeros. */
export interface ProductQuery {
  q?: string;
  barcode?: string;
  limit?: number;
  offset?: number;
}

export interface ProductList {
  products: ProductIdentity[];
  total: number;
  limit: number;
  offset: number;
}

/** GET /products/:productId: the saved product, its pages and the latest listing per page. */
export interface ProductDetail {
  product: ProductIdentity;
  pages: SourcePage[];
  listings: Listing[];
}
