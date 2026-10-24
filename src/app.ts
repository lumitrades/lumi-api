/**
 * Request router. Runtime-agnostic: `createApp(env)` returns a fetch handler
 * used by the Worker entry (src/index.ts) and the Node server (src/node.ts).
 */

import { createOutcomes, parseOutcome, MemoryOutcomeStore, D1OutcomeStore, OUTCOME_FIELDS, OUTCOME_RETENTION_DAYS, OUTCOME_SUMMARY_RETENTION, type OutcomeStore } from "./trust/outcomes";
import { createBadges } from "./trust/badge";
import { setPrivateNames } from "./sanitize";
import { loadConfig, EXPLORERS, dropsToXrp, atomicToUsdc, LUMI_STELLAR_ADDRESS, stroopsToUsdc, type Config, type Env, type PaidRoute } from "./config";
import { STELLAR_HORIZON } from "./trust/verify";
import { DataSource, type DataFile } from "./data";
import { D1TrialStore, MemoryTrialStore, SIWX_HEADER, SIWX_KEY, TRIAL_LIMITS, trialHint, wantsTrial, decodeSiwx, siwxChallenge, trialEligible, trialIpHash, usdcBalance, verifySiwx, trialChains, xrplTrialAccount, type TrialStore } from "./trial";
import { makeReplayGuard, json, requirePayment, paymentRequiredResponse, staleRefusal, HEADER_PAYMENT_SIGNATURE, HEADER_X_PAYMENT, assetLabel, isEvmRequirement, isStellarRequirement, type PaywallDeps, type PaymentRequirements, type Quote, type Settlement } from "./x402";
import { PAID_ENDPOINTS } from "./catalog";
import { bazaarExtension, resourceDescription, serviceMeta } from "./bazaar";
import { indexDoc, indexHtml, openApi, skillMd, wellKnownX402, VERSION } from "./docs";
import { agentCard, handleA2a, A2A_CORS } from "./a2a";
import {
  coinList, resolveCoin, signalView, liveSignalView, levelsView, slateView, marketView, DISCLAIMER, SOURCE, type CoinRef,
} from "./views";
import { staleInputs, hasContent, fileMeta, withMeta, isoTimestamps, metaFrom, nextHalfHour } from "./freshness";
import { briefView, yenView, sentimentView, eventsView, tradesView } from "./products";
import { institutionalView } from "./institutional";
import { handleMcp, isOwnerKey, MCP_CORS, type McpDeps } from "./mcp";
import { createTrust, TRUST_POST_PATHS, REPORT_FRESH_MS, type Trust } from "./trust";
import { createCommerce, D1CommerceStore, MemoryCommerceStore, type Commerce } from "./commerce";
import type { CommerceStore } from "./commerce/store";
import { TEST_PRICE_USD } from "./commerce/plans";
import { VENDORS, vendorById } from "./vendors";
import { D1TrustStore, MemoryTrustStore, type TrustStore } from "./trust/store";
import { SEED_OBSERVATIONS } from "./trust/seed";
import { isStorageQuotaError, storageUnavailableBody } from "./trust/storage_errors";
import { D1CatalogStore, MemoryCatalogStore, type CatalogStore } from "./trust/catalog";
import { createCatalog, buyCandidate, type Catalog, type CatalogJob, type QueueLike } from "./trust/catalog_service";
import { D1EvidenceStore, MemoryEvidenceStore, type EvidenceStore } from "./trust/evidence";
import { D1ReceiptStore, MemoryReceiptStore, type ReceiptStore } from "./trust/receipts";
import { createContributors, D1ContributorStore, MemoryContributorStore, type ContributorStore, type Contributors, type ContribQueue } from "./trust/contributors";
import { productSample, sampleEntry, SAMPLE_ARGS, SAMPLE_LABEL } from "./samples";
import { applyRate, createXrpPricer, type XrpPricer } from "./pricing";
import { D1TrafficStore, MemoryTrafficStore, TRAFFIC_RETENTION_DAYS, TrafficBuffer, trafficRow, trafficSummary, type TrafficStore } from "./traffic";
import { D1FeedStore, MemoryFeedStore, FEEDS, dueFeed, refreshFeed, feedFresh, type FeedStore } from "./feeds";
import { liteView, scanView, fundingView, fearGreedView, fearGreedFromContext, events48View, trustVerdict } from "./quick";
import { lookupError } from "./trust/index";
import { signResponse, signingKeyFrom, keysDoc, type SigningKey } from "./trust/lumi_sign";
import { originPath, checkPayload, badgeDecision, CHECK_SIGNED_TTL_SEC, BADGE_SIGNED_TTL_SEC, BADGE_MIN_SCORE, BADGE_MIN_PAID_TESTS, BADGE_CACHE, earnedBadgeSvg, noBadgeSvg } from "./trust/check";
import { curatedByHost } from "./trust/badge";
import type { LookupQuery } from "./trust/catalog";
import { D1LiveStore, MemoryLiveStore, refreshLive, isFresh, LIVE_UNIVERSE, LIVE_MAX_AGE_MS, LIVE_CYCLE_MS, type LiveStore } from "./live";
import { mcpServerCard, agentsJson } from "./wellknown";
import { D1IdempotencyStore, MemoryIdempotencyStore, type IdempotencyStore } from "./idempotency";
import { D1SalesStore, MemorySalesStore, salesSummary, sendSaleAlert, toRow, alertEnabled, type SalesStore, type AlertConfig } from "./sales";

export interface AppOptions {
  fetch?: typeof fetch;
  log?: (event: Record<string, unknown>) => void;
  /** Clock (ms), injectable for tests. */
  now?: () => number;
  /** Tier-1 check outcome store override (tests). */
  outcomeStore?: OutcomeStore;
  /** Trust-layer store override (tests). Default: D1 (TRUST_DB) when bound, else in-memory seeded store. */
  trustStore?: TrustStore;
  /** Sales ledger override (tests). Default: D1 (TRUST_DB) when bound, else in-memory. */
  salesStore?: SalesStore;
  /** x402 catalog store override (tests). Default: D1 (TRUST_DB) when bound, else in-memory. */
  catalogStore?: CatalogStore;
  /** Free-evidence store override (tests). Default: D1 (TRUST_DB) when bound, else in-memory. */
  evidenceStore?: EvidenceStore;
  receiptStore?: ReceiptStore;
  /** Queue override (tests). Default: env.TRUST_QUEUE; absent = jobs run inline. */
  queue?: QueueLike;
  /** Private request log override (tests). Default: D1 (TRUST_DB) when bound, else in-memory. */
  trafficStore?: TrafficStore;
  /** Traffic flush window (ms) and max requests per batch; tests use 0 / 1 to flush every request. */
  trafficFlushMs?: number;
  trafficFlushMax?: number;
  /** Live signal store override (tests). Default: D1 (TRUST_DB) when bound, else in-memory (empty: site files are used). */
  liveStore?: LiveStore;
  feedStore?: FeedStore;
  /** Free-trial ledger override (tests). Default: D1 (TRUST_DB) when bound, else in-memory. */
  trialStore?: TrialStore;
  /** Seller-monitoring + feed store override (tests). Default: D1 (TRUST_DB) when bound, else in-memory. */
  commerceStore?: CommerceStore;
  /** Idempotent-retry cache override (tests). Default: D1 (TRUST_DB) when bound, else in-memory. */
  idempotencyStore?: IdempotencyStore;
  /** Lumi Check contributor store override (tests). Default: D1 (TRUST_DB) when bound, else in-memory. */
  contributorStore?: ContributorStore;
  /** Contributions write queue override (tests). Default: env.CONTRIB_QUEUE; absent = writes inline. */
  contribQueue?: ContribQueue | null;
}

/** Lumi's own Base wallets (receiving + test-buyer). Addresses only. */
const DEFAULT_EVM_BUYERS = ["0x5E617bac19912e6d212CB303ae84655E9E203532", "0x7722DfAE6bbed2Fd02Dc07455c2f5BF14bE25E4a"];

/** The subset of the Workers ExecutionContext the app uses. */
export interface WaitUntil {
  waitUntil(p: Promise<unknown>): void;
}

const DEFAULT_XRPL_RPC: Record<string, string[]> = {
  "xrpl:0": ["https://xrplcluster.com/", "https://s1.ripple.com/", "https://s2.ripple.com/"],
  "xrpl:1": ["https://s.altnet.rippletest.net:51234/"],
  "xrpl:2": ["https://s.devnet.rippletest.net:51234/"],
};

export type Prepared =
  | { ok: true; route: PaidRoute; coin?: CoinRef; body: Record<string, unknown>; onPaid?: () => Promise<unknown> }
  | { ok: false; status: number; error: Record<string, unknown>; headers?: Record<string, string> };

export interface App {
  fetch(request: Request, ctx?: WaitUntil): Promise<Response>;
  /** Cron entry: free, unpaid 402-quote probes of the trust allowlist + the x402 catalog slice. */
  scheduled(): Promise<{ probes: unknown; catalog: unknown; commerce?: unknown }>;
  /** One-minute cron: recompute live signals for the stalest slice of the top-50 universe. */
  liveRefresh(): Promise<unknown>;
  live: LiveStore;
  feeds: FeedStore;
  /** Queue consumer: one catalog ingest page or quote-check batch. */
  queue(job: CatalogJob): Promise<unknown>;
  config: Config;
  pricer: XrpPricer;
  trust: Trust;
  catalog: Catalog;
  commerce: Commerce;
  sales: SalesStore;
  traffic: TrafficStore;
  /** Best-effort private request log (hashed IPs only); call once per request from the Worker entry point. */
  logTraffic(request: Request, response: Response, ctx?: WaitUntil): void;
  /** Write this isolate's buffered traffic counts now. */
  flushTraffic(): Promise<void>;
  /** Lumi Check contributions (keys, submissions, credits). */
  contributors: Contributors;
  /** Queue consumer for lumi-contrib-writes: batched contribution writes. */
  contribQueue(bodies: unknown[]): Promise<number>;
  /** Free public "Tested by Lumi" badge + result page (read-only, no D1 writes). Null for other paths. */
  badge(request: Request): Promise<Response | null>;
}

/** Persist the last-known XRP/USD fallback rate at most this often (D1 write budget). */
export const XRP_MEMO_MS = 30 * 60_000;

/** The scan is sold only when at least this many live signals are fresh. */
const SCAN_MIN = 40;
const NEEDS: Record<PaidRoute, DataFile[]> = {
  signal: ["signals", "prices"],
  levels: ["analysis", "prices"],
  slate: ["trades"],
  market: ["analysis", "signals", "prices", "context"],
  brief: ["prices", "context", "analysis", "signals", "trades"],
  yen: ["context", "analysis", "prices"],
  sentiment: ["context", "prices", "signals"],
  events: ["analysis"],
  trades: ["trades"],
  institutional: ["institutional_brief"],
  vendor_report: [], // trust-layer data (D1), checked in prepare()
  scan: [], // live_signals (D1), checked in prepare()
  lite: ["signals", "prices"], // via the signal route (live row first)
  trust_check: [], // trust catalog (D1)
  funding: [], // live_feeds (D1)
  fear_greed: [], // live_feeds (D1), context.json fallback in prepare()
  events_48h: ["events"],
};
/** Inputs that enrich a product but whose absence does not block it (the field is simply omitted). */
const OPTIONAL: Partial<Record<PaidRoute, DataFile[]>> = {
  brief: ["events", "brief"],
  yen: ["events"],
  events: ["events"],
  events_48h: ["analysis"],
};
/** Paid paths without a {coin} parameter. */
const FIXED: Record<string, PaidRoute> = {
  "/v1/slate": "slate",
  "/v1/market": "market",
  "/v1/brief": "brief",
  "/v1/macro/yen": "yen",
  "/v1/sentiment": "sentiment",
  "/v1/events": "events",
  "/v1/trades": "trades",
  "/v1/institutional": "institutional",
  "/v1/scan": "scan",
  "/v1/funding": "funding",
  "/v1/fear-greed": "fear_greed",
  "/v1/events/next48h": "events_48h",
  "/v1/trust/check": "trust_check",
};

/** Unfilled path placeholders in any common style: {coin}, {{coin}}, :coin, <coin>, [coin], ${coin}, $coin. */
const PATH_TEMPLATE_RE = /^(?:\{\{?\s*|:|<|\[|\$\{?)(?:coin|id|symbol|ticker|asset|vendor|vendor_?id|vendorId)(?:\s*\}\}?|>|\])?$/i;

export function createApp(env: Env, opts: AppOptions = {}): App {
  const config = loadConfig(env);
  setPrivateNames(env.PRIVATE_NAMES);
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = opts.now ?? (() => Date.now());
  const data = new DataSource(config.dataBaseUrl, config.dataTtlMs, doFetch);
  const deps: PaywallDeps = {
    fetch: doFetch,
    replay: makeReplayGuard({ durableObject: env.INVOICE_GUARD, kv: env.USED_INVOICES }),
    idempotency: opts.idempotencyStore ?? (env.TRUST_DB ? new D1IdempotencyStore(env.TRUST_DB) : new MemoryIdempotencyStore()),
    log: opts.log ?? ((e) => console.log(JSON.stringify(e))),
  };

  const split = (v?: string) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const sales: SalesStore = opts.salesStore ?? (env.TRUST_DB ? new D1SalesStore(env.TRUST_DB) : new MemorySalesStore());
  const traffic: TrafficStore = opts.trafficStore ?? (env.TRUST_DB ? new D1TrafficStore(env.TRUST_DB) : new MemoryTrafficStore());
  const trafficOn = env.TRAFFIC_LOG !== "0";
  const trafficBuf = new TrafficBuffer(traffic, { flushMs: opts.trafficFlushMs, maxRequests: opts.trafficFlushMax });
  const trafficErr = (e: unknown) => console.error(JSON.stringify({ event: "traffic_log_error", error: String(e).slice(0, 200) }));
  const trials: TrialStore = opts.trialStore ?? (env.TRUST_DB ? new D1TrialStore(env.TRUST_DB) : new MemoryTrialStore());
  const trialsOn = env.TRIALS !== "0";
  const live: LiveStore = opts.liveStore ?? (env.TRUST_DB ? new D1LiveStore(env.TRUST_DB) : new MemoryLiveStore());
  const feeds: FeedStore = opts.feedStore ?? (env.TRUST_DB ? new D1FeedStore(env.TRUST_DB) : new MemoryFeedStore());
  const alertCfg: AlertConfig = {
    webhookUrl: env.SALES_WEBHOOK_URL || undefined,
    email: env.SALES_ALERT_EMAIL || undefined,
    emailFrom: env.SALES_ALERT_FROM || undefined,
    emailBinding: env.SALES_EMAIL,
    includeTests: env.SALES_ALERT_TESTS === "1",
  };
  const extraTestWallets = split(env.SALES_TEST_WALLETS);
  /** Per-request paywall deps: records the sale, then alerts in the background (waitUntil) when configured. */
  const paywallDeps = (ctx?: WaitUntil): PaywallDeps => ({
    ...deps,
    onSale: async (sale) => {
      const row = toRow(sale, now(), extraTestWallets);
      const inserted = await sales.insert(row).catch((e) => {
        deps.log?.({ event: "sale_record_error", tx: row.tx, error: String(e) });
        return true;
      });
      if (inserted && alertEnabled(alertCfg)) {
        const p = sendSaleAlert(alertCfg, row, doFetch).then((sent) => sent.length && deps.log?.({ event: "sale_alert_sent", tx: row.tx, via: sent }));
        if (ctx) ctx.waitUntil(p);
        else await p;
      }
    },
  });
  const xrplRpc = split(env.XRPL_RPC_URLS).length ? split(env.XRPL_RPC_URLS) : DEFAULT_XRPL_RPC[config.network] ?? DEFAULT_XRPL_RPC["xrpl:0"];
  const baseRpc = env.BASE_RPC_URL ?? "https://mainnet.base.org";
  const trialRpcs = [
    ...(env.BASE_RPC_URL ? [env.BASE_RPC_URL] : []),
    ...(config.evm?.network === "eip155:84532" ? ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"] : ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.drpc.org"]),
  ];
  const xrplBuyers = split(env.TRUST_BUYER_ADDRESSES).length ? split(env.TRUST_BUYER_ADDRESSES) : [config.payTo];
  const catalogStore = opts.catalogStore ?? (env.TRUST_DB ? new D1CatalogStore(env.TRUST_DB) : new MemoryCatalogStore());
  /**
   * The persisted rate is only a last-known fallback (used when every live source fails, valid 7 days), so it is
   * stored at most every XRP_MEMO_MS across isolates: each isolate refreshes every 5 minutes and used to write a
   * meta row each time (~3.5k D1 rows/day).
   */
  let xrpMemoAt = 0;
  const memoXrpRate = async (v: string) => {
    const t = now();
    if (t - xrpMemoAt < XRP_MEMO_MS) return;
    xrpMemoAt = t;
    try {
      const old = JSON.parse((await catalogStore.getMeta("xrp_usd_rate")) ?? "null");
      if (old && Number.isFinite(Number(old.at)) && t - Number(old.at) < XRP_MEMO_MS) return;
    } catch { /* overwrite unreadable value */ }
    await catalogStore.setMeta("xrp_usd_rate", v);
  };
  /** Live XRP/USD rate (only used when XRP_PRICING=live); last known rate persisted in catalog meta. */
  const pricer = createXrpPricer({
    fetch: doFetch,
    fallback: config.xrpUsdFallback,
    now,
    log: (e) => deps.log?.(e),
    memo: { get: () => catalogStore.getMeta("xrp_usd_rate"), set: (v) => memoXrpRate(v) },
    extraSources: [{ name: "lumitrades", url: `${config.dataBaseUrl}/prices.json`, pick: (j: any) => j?.assets?.ripple?.price ?? j?.ripple?.price ?? j?.XRP?.price }],
  });
  const trustStore: TrustStore = opts.trustStore ?? (env.TRUST_DB ? new D1TrustStore(env.TRUST_DB) : new MemoryTrustStore(SEED_OBSERVATIONS));
  const receiptStore: ReceiptStore = opts.receiptStore ?? (env.TRUST_DB ? new D1ReceiptStore(env.TRUST_DB) : new MemoryReceiptStore());
  const evmBuyers = split(env.TRUST_BUYER_EVM).length ? split(env.TRUST_BUYER_EVM) : DEFAULT_EVM_BUYERS;
  const stellarBuyers = split(env.TRUST_BUYER_STELLAR).length ? split(env.TRUST_BUYER_STELLAR) : [LUMI_STELLAR_ADDRESS];
  const stellarHorizon = (env.STELLAR_HORIZON_URL || STELLAR_HORIZON).replace(/\/+$/, "");
  const evidenceStore = opts.evidenceStore ?? (env.TRUST_DB ? new D1EvidenceStore(env.TRUST_DB) : new MemoryEvidenceStore());
  const commerceStore: CommerceStore = opts.commerceStore ?? (env.TRUST_DB ? new D1CommerceStore(env.TRUST_DB) : new MemoryCommerceStore());
  const ownerReq = async (request: Request) => {
    const m = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
    return isOwnerKey(m?.[1], env.OWNER_MCP_KEY);
  };
  const catalog = createCatalog({
    store: catalogStore,
    curatedBuys: async (since) => (await Promise.all(VENDORS.map((v) => trustStore.observations(v.id, since)))).flat(),
    fetch: doFetch,
    now,
    log: (e) => deps.log?.(e),
    queue: opts.queue ?? (env.TRUST_QUEUE as QueueLike | undefined),
    xrplRpc,
    baseRpc,
    receipts: receiptStore,
    evidence: evidenceStore,
    onStatusChanges: (changes) => commerceStore.addChanges(changes),
    baseRpcs: split(env.BASE_INDEX_RPCS).length ? split(env.BASE_INDEX_RPCS) : ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://gateway.tenderly.co/public/base"],
    buyers: { xrpl: xrplBuyers, evm: split(env.TRUST_BUYER_EVM).length ? split(env.TRUST_BUYER_EVM) : DEFAULT_EVM_BUYERS, stellar: stellarBuyers },
    stellarHorizon,
    self: {
      name: "Lumi Trades API",
      url: config.publicBaseUrl || "https://api.lumitrades.io",
      domains: ["lumitrades.io", "api.lumitrades.io"],
      pay_to: [config.payTo, ...(config.evm ? [config.evm.payTo] : []), ...(config.stellar ? [config.stellar.payTo] : []), ...DEFAULT_EVM_BUYERS],
    },
    isOwner: async (request) => {
      const m = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
      return isOwnerKey(m?.[1], env.OWNER_MCP_KEY);
    },
  });
  // Lumi Check tier-1 anonymous delivery outcomes (aggregate counters only; never a scoring input).
  const outcomes = createOutcomes(opts.outcomeStore ?? (env.TRUST_DB ? new D1OutcomeStore(env.TRUST_DB) : new MemoryOutcomeStore()), now);
  const outcomeHits = new Map<string, { t: number; n: number }>();
  /** Per-isolate, in-memory only: 120 outcome reports per minute per connecting IP. The IP is never stored or logged. */
  const outcomeLimited = (request: Request) => {
    const ip = request.headers.get("CF-Connecting-IP") ?? "local", t = now(), h = outcomeHits.get(ip);
    if (outcomeHits.size > 20_000) outcomeHits.clear();
    if (!h || t - h.t > 60_000) { outcomeHits.set(ip, { t, n: 1 }); return false; }
    return ++h.n > 120;
  };
  const contributors = createContributors({
    store: opts.contributorStore ?? (env.TRUST_DB ? new D1ContributorStore(env.TRUST_DB) : new MemoryContributorStore()),
    fetch: doFetch,
    now,
    ownerKey: env.OWNER_MCP_KEY,
    adminKey: env.CONTRIB_ADMIN_KEY,
    creditsEnabled: env.CONTRIB_CASH_BOUNTIES_ENABLED === "true",
    checkCreditsPerReceipt: env.CONTRIB_CHECK_CREDITS_PER_RECEIPT,
    checkCreditPrices: env.CONTRIB_CHECK_CREDIT_PRICES,
    // Free Lumi Check credits buy the same body as the x402 route. onPaid (Lumi's own follow-up test-buy) is NOT run for credits.
    redeem: async (product, input, base) => {
      const p = product === "trust_check" ? await prepareTrustCheck(new URLSearchParams(input).toString(), base) : await prepareVendorReport(String(input.vendor_id ?? input.id ?? ""), base);
      return p.ok ? { ok: true as const, body: p.body } : { ok: false as const, status: p.status, error: p.error };
    },
    // Contributed receipts are mainnet-only (xrpl:0), whatever network this deployment sells on.
    xrplRpc: split(env.XRPL_RPC_URLS).length && config.network === "xrpl:0" ? split(env.XRPL_RPC_URLS) : DEFAULT_XRPL_RPC["xrpl:0"],
    baseRpc,
    stellarHorizon,
    catalogStore,
    receipts: receiptStore,
    self: {
      domains: ["lumitrades.io", "api.lumitrades.io"],
      pay_to: [config.payTo, ...xrplBuyers, ...(config.evm ? [config.evm.payTo] : []), ...(config.stellar ? [config.stellar.payTo] : []), ...evmBuyers, ...stellarBuyers],
    },
    ignoreFunders: split(env.CONTRIB_FUNDER_IGNORE),
    baseExplorer: env.CONTRIB_BASE_EXPLORER_API || undefined,
    rateLimiter: env.CONTRIB_RATE_LIMITER,
    queue: opts.contribQueue === null ? undefined : opts.contribQueue ?? (env.CONTRIB_QUEUE ? { send: (b: unknown) => env.CONTRIB_QUEUE!.send(b) } : undefined),
    log: (e) => deps.log?.(e),
    credits: env.CONTRIB_CREDITS,
    caps: env.CONTRIB_CAPS,
    minKit: env.CONTRIB_KIT_MIN_VERSION,
    retiredKits: env.CONTRIB_KIT_RETIRED,
  });
  const trust = createTrust({
    store: trustStore,
    fetch: doFetch,
    now,
    ownerKey: env.OWNER_MCP_KEY,
    ipSecret: config.invoiceSecret,
    log: (e) => deps.log?.(e),
    xrplRpc,
    baseRpc,
    buyers: xrplBuyers,
    catalog,
    cache: { get: (k) => catalogStore.getMeta(k), set: (k, v) => catalogStore.setMeta(k, v) },
    publicBase: config.publicBaseUrl || undefined,
    receipts: receiptStore,
    evmBuyers,
    stellarBuyers,
    stellarHorizon,
    annotate: (doc, payTos) => commerce.annotate(doc, payTos),
  });
  const badges = createBadges({
    now,
    latestObservations: (ids, n) => trustStore.latestObservations(ids, n),
    buysByDomain: (d, n) => catalogStore.buysByDomain(d, n),
    // Read-only disclosure lookup; page/JSON only, never the SVG.
    relationships: async (payTos) => {
      const d = await commerce.annotate({}, payTos);
      return Array.isArray(d.commercial_relationship) ? (d.commercial_relationship as Record<string, unknown>[]) : [];
    },
    selfDomains: ["lumitrades.io", "www.lumitrades.io", "api.lumitrades.io", ...(config.publicBaseUrl ? [new URL(config.publicBaseUrl).hostname] : [])],
    log: (e) => deps.log?.(e),
  });

  // Lumi Check v0: dedicated ed25519 response-signing key (Worker secret LUMI_CHECK_SIGNING_KEY; never logged).
  let signKeyMemo: Promise<SigningKey | null> | undefined;
  const signKey = () => (signKeyMemo ??= signingKeyFrom(env.LUMI_CHECK_SIGNING_KEY));

  /** Live score summary for a host or vendor id (curated vendors only; everything else is "not_scored"). */
  async function liveScore(keyOrHost: string) {
    const k = keyOrHost.toLowerCase();
    const ids = vendorById(k) ? [k] : curatedByHost(k).map((v) => v.id);
    if (ids.length !== 1) return null;
    return trust.vendorScore(ids[0]);
  }
  const scoreView = (s: Awaited<ReturnType<typeof liveScore>>, tier: unknown) => s
    ? { scored: true, vendor_id: s.vendor_id, value: s.score.value, confidence: s.score.confidence, tier: tier ?? null, paid_test_buys: s.score.samples.paid_test_buys }
    : { scored: false, value: null, confidence: null, tier: tier ?? null, note: "Numeric scores exist for curated vendors only; the tier comes from the catalog." };

  async function checkVerdict(input: { url: string; payTo?: string; amountUsd?: number; network?: string }, base: string, free: boolean) {
    const exact = (await trust.lookup({ url: input.url } as LookupQuery, base, free ? { free: true } : undefined)) as any;
    const hasExact = !!exact?.self || (exact?.catalog?.entries?.length ?? 0) > 0;
    const host = new URL(input.url).hostname.toLowerCase();
    const dom = hasExact ? null : ((await trust.lookup({ domain: host } as LookupQuery, base, free ? { free: true } : undefined)) as any);
    return { verdict: trustVerdict(input, exact, dom, base) as Record<string, any>, exact, host };
  }

  /** payTo-only verdict (MCP tool payments): who is this address, per the catalog and Lumi's curated vendors. */
  async function payToVerdict(input: { payTo: string; amountUsd?: number; network?: string }, base: string) {
    const doc = (await trust.lookup({ payTo: input.payTo } as LookupQuery, base, { free: true })) as any;
    const first = doc?.catalog?.entries?.[0]?.resource as string | undefined;
    const cur = doc?.curated?.[0]?.id as string | undefined;
    let host: string | null = cur ?? null;
    if (!host && first) { try { host = new URL(first).hostname.toLowerCase(); } catch { host = null; } }
    const verdict = trustVerdict({ url: first ?? "", ...input } as any, doc, null, base) as Record<string, any>;
    if (verdict.matched) verdict.matched.exact = false;
    return { verdict, exact: doc, host };
  }

  async function freeCheck(request: Request, url: URL, base: string): Promise<Response> {
    const noStore = { "Cache-Control": "no-store" };
    const sp = url.searchParams;
    const raw = sp.get("url")?.trim() ?? "";
    const clean = originPath(raw);
    const payTo = sp.get("payTo")?.trim() || sp.get("pay_to")?.trim() || undefined;
    const amountRaw = sp.get("amount")?.trim();
    const amountUsd = amountRaw ? Number(amountRaw.replace(/^\$/, "")) : undefined;
    const bad = (detail: string) => json(400, { error: "invalid_query", detail, example: `${base}/v1/check?url=https://api.example.com/v1/data&payTo=0x...&amount=0.01` }, noStore);
    // payTo-only checks exist for MCP tool payments, whose resource is mcp://tool/<name> rather than an http(s) URL.
    if (!clean && !(payTo && !raw)) return bad("url is required (or payTo alone for MCP tool payments): the absolute http(s) x402 resource URL you are about to pay (query strings are ignored).");
    const lerr = lookupError({ ...(clean ? { url: clean } : {}), ...(payTo ? { payTo } : {}) }, { url: !!clean, payTo: payTo !== undefined }, "check");
    if (lerr) return json(400, lerr, noStore);
    if (amountRaw && !(amountUsd !== undefined && Number.isFinite(amountUsd) && amountUsd >= 0 && amountUsd < 1e6)) return bad("amount must be a USD number, e.g. 0.01.");
    // Contributors with a verified receipt (signed request) get a higher per-key limit instead of the anonymous IP limit.
    const perk = await contributors.checkPerk(request);
    if (perk && !perk.ok) return perk.res;
    const limit = perk ? null : await trust.freeLimit(request, "lookup");
    if (limit) return limit;
    const network = sp.get("network")?.slice(0, 40) || undefined;
    const { verdict, host } = clean ? await checkVerdict({ url: clean, payTo, amountUsd, network }, base, true) : await payToVerdict({ payTo: payTo!, amountUsd, network }, base);
    const score = host ? scoreView(await liveScore(host), verdict.matched?.tier) : null;
    const link = host ? `${base}/trust/v/${encodeURIComponent(host)}` : `${base}/v1/trust/vendors?payTo=${encodeURIComponent(payTo!)}`;
    const payload = checkPayload({ query: { url: clean, payTo, amountUsd, network }, verdict, score, link, paid: false });
    const t = now();
    const receipt = await signResponse("lumi_check", payload, await signKey(), t, CHECK_SIGNED_TTL_SEC);
    return json(200, {
      kind: "lumi_check", ...payload, receipt,
      detail: clean ? `${base}/v1/trust/check?url=${encodeURIComponent(clean)} (x402, adds reason details and next steps)` : `${base}/v1/trust/vendors?payTo=${encodeURIComponent(payTo!)}`,
      note: "Free pre-pay check. Paying Lumi (checks, monitoring, reports) never changes a score, tier, ranking or badge. Only origin + path of the URL is used; nothing about the query is stored.",
    }, noStore);
  }

  /** Earned-only "Tested by Lumi" badge: decision from the live score only, signed and short-lived. */
  async function earnedBadge(key: string, ext: "json" | "svg", base: string): Promise<Response> {
    const s = await liveScore(key);
    const d = s ? badgeDecision({ score: s.score, last_conclusive: s.last_conclusive, status: s.status }) : { earned: false as const, reason: "not_scored" };
    const live = `${base}/trust/v/${encodeURIComponent(s?.vendor_id ?? key)}`;
    const headers = { "Cache-Control": BADGE_CACHE, "Access-Control-Allow-Origin": "*" };
    if (ext === "svg") {
      const svg = d.earned && s ? earnedBadgeSvg(s.score.value!, new Date(now()).toISOString().slice(0, 10)) : noBadgeSvg(d.reason === "not_scored" ? "not scored" : "no badge");
      return new Response(svg, { status: 200, headers: { ...headers, "Content-Type": "image/svg+xml; charset=utf-8", Link: `<${live}>; rel="related"` } });
    }
    const payload = {
      subject: s ? { vendor_id: s.vendor_id, name: s.name } : { key: key.slice(0, 200) },
      earned: d.earned, reason: d.reason,
      score: s ? { value: s.score.value, confidence: s.score.confidence, paid_test_buys: s.score.samples.paid_test_buys } : null,
      threshold: { min_score: BADGE_MIN_SCORE, min_paid_test_buys: BADGE_MIN_PAID_TESTS, latest_test_buy: "delivered" },
      live_report: live,
      embed: d.earned ? `<a href="${live}"><img src="${base}/v1/badge/${encodeURIComponent(s?.vendor_id ?? key)}.svg" alt="Tested by Lumi (live score)"></a>` : null,
      purchasable: false,
    };
    const signed = await signResponse("tested_badge", payload, await signKey(), now(), BADGE_SIGNED_TTL_SEC);
    return json(200, { kind: "tested_badge_verdict", ...payload, signed, note: "Earned only, never sold. Re-evaluated from the live score on every request and removed automatically when it drops below the threshold. Check the signature and expires_at; a copied image proves nothing." }, headers);
  }
  const ownHosts = new Set(["api.lumitrades.io", ...(config.publicBaseUrl ? [new URL(config.publicBaseUrl).hostname] : [])]);
  const commerce = createCommerce({
    store: commerceStore,
    cfg: config,
    fetch: doFetch,
    // A Worker cannot fetch its own route: Lumi's own endpoints are answered in-process.
    endpointFetch: (u, init) => (ownHosts.has(new URL(u).hostname) ? handle(new Request(u, init)) : doFetch(u, init)),
    now,
    isOwner: ownerReq,
    xrplRpc,
    catalogStore,
    evidence: evidenceStore,
    receipts: receiptStore,
    paywall: (ctx) => paywallDeps(ctx),
    email: { from: alertCfg.emailFrom, binding: alertCfg.emailBinding },
    extraTestWallets,
    testPriceUsd: TEST_PRICE_USD,
    reportSigners: [config.payTo],
    log: (e) => deps.log?.(e),
  });

  /** Free samples of every paid product, rebuilt at most every 10 minutes per isolate. */
  let samplesCache: { at: number; base: string; body: Record<string, unknown> } | undefined;
  async function samplesDoc(base: string): Promise<Record<string, unknown>> {
    if (samplesCache && samplesCache.base === base && now() - samplesCache.at < 600_000) return samplesCache.body;
    const products = await Promise.all(
      PAID_ENDPOINTS.map(async (e) => {
        const entry = sampleEntry(config, base, e.route);
        try {
          const prep = await prepare(e.route, SAMPLE_ARGS[e.route], base);
          if (!prep.ok) return { ...entry, available: false, reason: String((prep.error as any)?.error ?? prep.status) };
          return { ...entry, available: true, ...productSample(e.route, prep.body) };
        } catch {
          return { ...entry, available: false, reason: "unavailable" };
        }
      }),
    );
    const body = {
      kind: "samples",
      is_sample: true,
      label: SAMPLE_LABEL,
      generated_at: new Date(now()).toISOString(),
      note: "Each entry is a truncated preview of the paid response (lists cut to 2 entries, long text clipped). It may be up to 10 minutes old. Free, no payment.",
      count: products.length,
      products,
      disclaimer: DISCLAIMER,
    };
    samplesCache = { at: now(), base, body };
    return body;
  }

  /** Lumi's site coins (coins.json): full coverage including levels, slate and trades. */
  async function siteCoins(): Promise<CoinRef[]> {
    try {
      return coinList(await data.get("coins"));
    } catch {
      return coinList(undefined);
    }
  }
  /** Site coins first, then the rest of the live top-50 universe (signals only). */
  async function coins(): Promise<CoinRef[]> {
    const site = await siteCoins();
    const have = new Set(site.map((c) => c.id));
    return [...site, ...LIVE_UNIVERSE.filter((c) => !have.has(c.id)).map((c) => ({ id: c.id, symbol: c.symbol, name: c.name, group: "top50" }))];
  }

  /**
   * Load, validate (present, non-empty, fresh) and build the paid body for a route, without any payment step.
   * Shared by the x402 REST paywall and the remote MCP endpoint, so both enforce the same freshness rule:
   * a failure here is never charged.
   */
  async function prepare(route: PaidRoute, coinArg?: string, base = config.publicBaseUrl ?? "https://api.lumitrades.io"): Promise<Prepared> {
    const p = await prepareRaw(route, coinArg, base);
    if (p.ok) p.body = ensureFreshness(p.body, now());
    return p;
  }

  async function prepareRaw(route: PaidRoute, coinArg?: string, base = config.publicBaseUrl ?? "https://api.lumitrades.io"): Promise<Prepared> {
    if (route === "vendor_report") return prepareVendorReport(coinArg ?? "", base);
    if (route === "trust_check") return prepareTrustCheck(coinArg ?? "", base);
    if (route === "scan") return prepareScan();
    if (route === "funding" || route === "fear_greed") return prepareFeed(route);
    if (route === "lite") {
      const p = await prepare("signal", coinArg, base);
      if (!p.ok) return p;
      const b = p.body as Record<string, unknown>;
      const meta = Object.fromEntries(["as_of", "data_age_seconds", "next_update", "stale_after"].filter((k) => k in b).map((k) => [k, b[k]]));
      return { ok: true, route, coin: p.coin, body: isoTimestamps(withMeta(liteView(b) as Record<string, unknown>, meta as any)) };
    }
    let coin: CoinRef | undefined;
    if (coinArg !== undefined) {
      coin = resolveCoin(await coins(), coinArg);
      if (!coin) {
        return {
          ok: false,
          status: 404,
          error: { error: "unknown_coin", coin: coinArg, supported: (await coins()).map((c) => c.symbol), note: "Not charged." },
        };
      }
    }
    // Signals: computed live (refreshed about every 13 min) when a fresh row exists; else the site file (site coins only).
    if (route === "signal" && coin) {
      const t0 = now();
      const row = await live.get(coin.id).catch(() => null);
      if (isFresh(row, t0)) {
        const meta = metaFrom(row.computed_at, row.computed_at + LIVE_MAX_AGE_MS, row.computed_at + LIVE_CYCLE_MS, t0);
        return { ok: true, route, coin, body: isoTimestamps(withMeta(liveSignalView(coin, row) as Record<string, unknown>, meta)) };
      }
      if (!(await siteCoins()).some((c) => c.id === coin!.id)) {
        return notForSale("stale_data", `the live ${coin.symbol} signal is not fresh right now`, 120, ageSeconds((row as { computed_at?: number } | null)?.computed_at, t0));
      }
    }
    if (route === "levels" && coin && !(await siteCoins()).some((c) => c.id === coin!.id)) {
      return { ok: false, status: 404, error: { error: "no_data_for_coin", coin: coin.symbol, detail: "levels cover Lumi's watchlist and majors; signals cover every coin in GET /v1/coins", levels_coins: (await siteCoins()).map((c) => c.symbol), note: "Not charged." } };
    }
    // Load (cached) data before asking for money, so a payment is never
    // settled when the upstream data is unavailable.
    let loaded: Record<string, unknown>;
    try {
      loaded = { ...(await data.getOptional(OPTIONAL[route] ?? [])), ...(await data.getMany(NEEDS[route])) };
    } catch (err) {
      return notForSale("data_unavailable", String((err as Error).message), 30, null);
    }
    const t = now();
    const stale = staleInputs(loaded, NEEDS[route], t, config.dataMaxAgeHours);
    if (stale.length) {
      const asOfs = stale.map((x) => Date.parse(String(x.as_of ?? ""))).filter((v) => Number.isFinite(v));
      return notForSale("stale_data", "Lumi's published data is missing or out of date, so this call is not for sale right now.", 300, asOfs.length ? ageSeconds(Math.min(...asOfs), t) : null, { inputs: stale });
    }
    // Optional inputs that are stale are dropped (their fields are omitted), never served as current.
    for (const f of OPTIONAL[route] ?? []) if (staleInputs(loaded, [f], t, config.dataMaxAgeHours).length) delete loaded[f];
    const list = await siteCoins();
    const body = buildBody(route, coin, loaded, list, t);
    if (body && !hasContent(route, body)) {
      return notForSale("data_unavailable", `the ${route} data is empty right now`, 300, null);
    }
    if (!body) {
      return coin
        ? { ok: false, status: 404, error: { error: "no_data_for_coin", coin: coin.symbol, note: "Not charged." } }
        : notForSale("data_unavailable", `no ${route} data published right now`, 300, null);
    }
    const meta = fileMeta(loaded, NEEDS[route], t, config.dataMaxAgeHours);
    return { ok: true, route, coin, body: isoTimestamps(withMeta(body as Record<string, unknown>, meta)) };
  }

  /** All-coins scan: every fresh live row; sold only when at least SCAN_MIN coins are fresh. Freshness = the oldest row. */
  async function prepareScan(): Promise<Prepared> {
    const t = now();
    const all = await live.all().catch(() => []);
    const rows = all.filter((r) => isFresh(r, t) && r.label);
    if (rows.length < SCAN_MIN) {
      // Data age = the age of the SCAN_MIN-th freshest coin (the scan needs that many).
      const byAge = all.filter((r) => r.label && r.computed_at).map((r) => r.computed_at).sort((a, b) => b - a);
      return notForSale("stale_data", `only ${rows.length} of ${LIVE_UNIVERSE.length} live signals are fresh right now`, 120, byAge.length ? ageSeconds(byAge[Math.min(SCAN_MIN, byAge.length) - 1], t) : null);
    }
    const oldest = Math.min(...rows.map((r) => r.computed_at));
    const meta = metaFrom(oldest, oldest + LIVE_MAX_AGE_MS, Math.max(t + 60_000, oldest + LIVE_CYCLE_MS), t);
    return { ok: true, route: "scan", body: isoTimestamps(withMeta(scanView(rows, await coins()) as Record<string, unknown>, meta)) };
  }

  /** Funding / Fear & Greed from the cron-cached feeds (Fear & Greed falls back to the site's CMC snapshot). */
  async function prepareFeed(route: "funding" | "fear_greed"): Promise<Prepared> {
    const t = now();
    const row = await feeds.get(route).catch(() => null);
    if (feedFresh(row, t)) {
      const body = route === "funding" ? fundingView(row.doc) : fearGreedView(row.doc);
      if (body) {
        const meta = metaFrom(row.fetched_at, row.fetched_at + FEEDS[route].stale_ms, Math.max(t + 60_000, row.fetched_at + FEEDS[route].every_ms), t);
        return { ok: true, route, body: isoTimestamps(withMeta(body as Record<string, unknown>, meta)) };
      }
    }
    if (route === "fear_greed") {
      try {
        const loaded = await data.getMany(["context"]);
        if (!staleInputs(loaded, ["context"], t, config.dataMaxAgeHours).length) {
          const body = fearGreedFromContext(loaded.context);
          if (body) return { ok: true, route, body: isoTimestamps(withMeta(body as Record<string, unknown>, fileMeta(loaded, ["context"], t, config.dataMaxAgeHours))) };
        }
      } catch { /* fall through */ }
    }
    return notForSale("stale_data", `the ${route === "funding" ? "funding-rate" : "Fear & Greed"} feed is not fresh right now`, 300, ageSeconds(row?.fetched_at, t));
  }

  /** "Should I pay this x402 URL?" Validated before any quote; the verdict reads the trust catalog (same data as the free lookup). */
  async function prepareTrustCheck(qs: string, base: string): Promise<Prepared> {
    const sp = new URLSearchParams(qs);
    const url = sp.get("url")?.trim() ?? "";
    const payTo = sp.get("payTo")?.trim() || sp.get("pay_to")?.trim() || undefined;
    const amountRaw = sp.get("amount")?.trim();
    const amountUsd = amountRaw ? Number(amountRaw.replace(/^\$/, "")) : undefined;
    const bad = (detail: string) => ({ ok: false as const, status: 400, error: { error: "invalid_query", detail, example: `${base}/v1/trust/check?url=https://api.example.com/v1/data&payTo=0x...&amount=0.01`, note: "Not charged." } });
    if (!url) return bad("url is required: the x402 resource URL you are about to pay.");
    const err = lookupError({ url, ...(payTo ? { payTo } : {}) }, { url: true, payTo: payTo !== undefined }, "check");
    if (err) return { ok: false, status: 400, error: { ...err, note: "Not charged." } };
    if (amountRaw && !(amountUsd !== undefined && Number.isFinite(amountUsd) && amountUsd >= 0 && amountUsd < 1e6)) return bad("amount must be a USD number, e.g. 0.01.");
    let host = "";
    try { host = new URL(url).hostname.toLowerCase(); } catch { return bad("url must be an absolute http(s) URL."); }
    try {
      const clean = originPath(url) ?? url;
      const network = sp.get("network") ?? undefined;
      const { verdict: body, exact } = await checkVerdict({ url: clean, payTo, amountUsd, network }, base, false);
      const t = now();
      const payload = checkPayload({ query: { url: clean, payTo, amountUsd, network }, verdict: body, score: scoreView(await liveScore(host), (body as any).matched?.tier), link: `${base}/trust/v/${encodeURIComponent(host)}`, paid: true });
      (body as any).lumi_receipt = await signResponse("trust_check", payload, await signKey(), t, CHECK_SIGNED_TTL_SEC);
      const meta = metaFrom(t, t + 86_400_000, t + 30 * 60_000, t);
      const cand = buyCandidate(body as any, exact);
      return { ok: true, route: "trust_check", body: isoTimestamps(withMeta(body as Record<string, unknown>, meta)), ...(cand ? { onPaid: () => catalog.queueBuy(cand) } : {}) };
    } catch (e) {
      return notForSale("data_unavailable", "the trust catalog is unavailable right now", 60, null);
    }
  }

  /** Paid vendor report: unknown vendor -> 404, no observation in 48 h -> 503; both before any 402 and never charged. */
  async function prepareVendorReport(id: string, base: string): Promise<Prepared> {
    const r = await trust.vendorReport(id.trim().toLowerCase(), base);
    if (r.ok) {
      return hasContent("vendor_report", r.doc)
        ? { ok: true, route: "vendor_report", body: isoTimestamps(withMeta({ kind: "vendor_report", timestamp: new Date(now()).toISOString(), source: "api.lumitrades.io trust layer", ...r.doc, disclaimer: DISCLAIMER }, vendorMeta(r.doc))) }
        : notForSale("data_unavailable", "no observations for this vendor yet", 1800, null);
    }
    if (r.reason === "unknown_vendor") {
      return { ok: false, status: 404, error: { error: "unknown_vendor", vendor_id: id.slice(0, 64), vendors: VENDORS.map((v) => v.id), note: "Not charged." } };
    }
    return notForSale(
      "stale_data",
      `Lumi has no observation of this vendor (probe or paid test-buy) in the last ${REPORT_FRESH_MS / 3_600_000} h, so the report is not for sale right now.`,
      1800,
      ageSeconds(Date.parse(String(r.last_observed_at ?? "")), now()),
      { last_observed_at: r.last_observed_at },
    );
  }

  /** Vendor report freshness: the newest observation binds; sold only within 48 h of it. */
  function vendorMeta(doc: Record<string, any>) {
    const c = doc?.coverage ?? {};
    const last = Math.max(Date.parse(c.last_probe_at ?? "") || 0, Date.parse(c.last_paid_test_buy_at ?? "") || 0);
    if (!last) return null;
    const t = now();
    return metaFrom(last, last + REPORT_FRESH_MS, nextHalfHour(t), t);
  }

  const mcpDeps: Omit<McpDeps, "quote"> = {
    config,
    ownerKey: env.OWNER_MCP_KEY,
    coins,
    prepare,
    trust,
    log: (e) => deps.log?.(e),
  };

  async function handle(request: Request, ctx?: WaitUntil): Promise<Response> {
    const url = new URL(request.url);
    const base = config.publicBaseUrl ?? url.origin;
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: path === "/mcp" || path.startsWith("/mcp/")
          ? MCP_CORS
          : path === "/a2a"
          ? A2A_CORS
          : TRUST_POST_PATHS.includes(path) || commerce.postPaths.includes(path)
          ? {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Lumi-Key",
              "Access-Control-Max-Age": "86400",
            }
          : {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, OPTIONS",
              "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, X-PAYMENT, SIGN-IN-WITH-X, X-Lumi-Trial, Idempotency-Key, Content-Type",
              "Access-Control-Max-Age": "86400",
            },
      });
    }
    // Remote MCP (Streamable HTTP): /mcp, or /mcp/<owner key> for connector UIs that cannot set headers.
    if (path === "/mcp" || path.startsWith("/mcp/")) {
      return handleMcp(request, base, path === "/mcp" ? undefined : path.slice(5), {
        ...mcpDeps,
        quote: async (p: string) => {
          const r = await handle(new Request(url.origin + p, { headers: { Accept: "application/json" } }));
          const t = await r.text();
          let body: unknown = t;
          try { body = JSON.parse(t); } catch { /* text */ }
          return { status: r.status, body };
        },
      });
    }
    // A2A JSON-RPC (A2A 1.0 `SendMessage` and 0.3 `message/send`): free skills answered inline, paid skills return x402 terms.
    if (path === "/a2a") {
      return handleA2a(request, base, {
        config,
        coins,
        trust,
        samples: () => samplesDoc(base),
        quote: async (p: string) => {
          const r = await handle(new Request(url.origin + p, { headers: { Accept: "application/json" } }));
          const t = await r.text();
          let body: unknown = t;
          try { body = JSON.parse(t); } catch { /* text */ }
          return { status: r.status, body };
        },
        log: (e) => deps.log?.(e),
      });
    }
    // Literal /v1/trust/vendors/{id} (or :id, <id>, ...) gets the same helpful template 400 as the paid template paths.
    {
      const tv = (request.method === "GET" || request.method === "HEAD") && path.match(/^\/v1\/trust\/vendors\/([^/]{1,64})$/);
      const arg = tv ? safeDecode(tv[1]) : undefined;
      if (arg !== undefined && PATH_TEMPLATE_RE.test(arg)) {
        return json(400, {
          error: "path_template_not_filled",
          detail: `Replace ${arg} with a real value. Vendor ids: GET /v1/trust/vendors (free).`,
          example: `${base}/v1/trust/vendors/printmoneylab`,
          openapi: `${base}/openapi.json`,
          note: "Not charged.",
        });
      }
    }
    // Lumi Check tier 1: anonymous delivery outcome (seller host or vendor id + delivered yes/no + coarse status class only).
    if (path === "/v1/check/outcome" && request.method === "POST") {
      const noStore = { "Cache-Control": "no-store" };
      if (outcomeLimited(request)) return json(429, { error: "rate_limited", retry_after_s: 60 }, { ...noStore, "Retry-After": "60" });
      const text = await request.text().catch(() => "");
      if (text.length > 512) return json(413, { error: "body_too_large", max_bytes: 512 }, noStore);
      let body: unknown; try { body = JSON.parse(text); } catch { body = null; }
      const p = parseOutcome(body);
      if (!p.ok) return json(400, { ...p, allowed: OUTCOME_FIELDS, note: "Tier 1 accepts only an anonymous delivery outcome. Nothing was stored." }, noStore);
      const status = outcomes.record(p);
      if (ctx && outcomes.due()) ctx.waitUntil(outcomes.flush().catch(() => 0));
      return json(202, { ok: true, status, stored: "aggregate_counter_only", note: "Not linked to you; not a scoring input. Turn off with LUMI_CHECK_TELEMETRY=off or `lumi-scan telemetry off`." }, noStore);
    }
    // Lumi Check v0: free signed pre-pay check, signing keys, earned-only signed badge.
    if (request.method === "GET" || request.method === "HEAD") {
      if (path === "/v1/check") return freeCheck(request, url, base);
      if (path === "/v1/check/keys" || path === "/.well-known/lumi-keys.json") return json(200, keysDoc(await signKey(), base), { "Cache-Control": "public, max-age=3600" });
      const eb = /^\/v1\/badge\/([^/]{1,200})\.(json|svg)$/.exec(path);
      if (eb) { const k = safeDecode(eb[1]); if (k) return earnedBadge(k, eb[2] as "json" | "svg", base); }
    }
    // Seller monitoring + data licence feed (free docs/signup, x402 plans, keyed feed, owner routes).
    {
      const r = await commerce.handle(request, path, base, ctx);
      if (r) return r;
    }
    // Trust layer: free GETs, rate-limited public POSTs, owner-only ingest.
    if (path.startsWith("/v1/trust") || path === "/v1/reports" || path === "/v1/tips") {
      const r = await trust.handle(request, path, base);
      if (r) return r;
    }
    // Lumi Check v0 (DRAFT, branch scanner-kit-v0): contributor-signed receipts + owner key management.
    if (path.startsWith("/v1/contrib/") || path === "/v1/owner/contributors" || path.startsWith("/v1/owner/contributors/")) {
      const r = await contributors.handle(request, path);
      if (r) return r;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(405, { error: "method_not_allowed" }, { Allow: "GET, OPTIONS" });
    }
    // Owner-only private traffic summary (Authorization: Bearer <OWNER_MCP_KEY>): hashed IPs only.
    if (path === "/v1/owner/traffic") {
      const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1]?.trim();
      if (!bearer || !(await isOwnerKey(bearer, env.OWNER_MCP_KEY))) {
        return json(401, { error: "owner_key_required", hint: "Authorization: Bearer <OWNER_MCP_KEY>" }, { "Cache-Control": "no-store", "WWW-Authenticate": "Bearer" });
      }
      const days = Number(url.searchParams.get("days") ?? "7");
      return json(200, { ...(await trafficSummary(traffic, now(), days)), logging: trafficOn }, { "Cache-Control": "no-store" });
    }
    // Owner-only tier-1 delivery outcome aggregates (counters per day per seller host).
    if (path === "/v1/owner/check-outcomes") {
      if (!(await ownerReq(request))) return json(401, { error: "owner_key_required" }, { "Cache-Control": "no-store", "WWW-Authenticate": "Bearer" });
      await outcomes.flush();
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") ?? "7") || 7));
      const sdays = Math.min(3650, Math.max(1, Number(url.searchParams.get("summary_days") ?? "30") || 30));
      const since = (n: number) => new Date(now() - n * 86_400_000).toISOString().slice(0, 10);
      return json(200, {
        kind: "lumi_check_outcomes", retention_days: OUTCOME_RETENTION_DAYS, summaries_kept: OUTCOME_SUMMARY_RETENTION,
        rows: await outcomes.store.list(since(days), 1000), summaries: await outcomes.store.summaries(since(sdays), 5000),
      }, { "Cache-Control": "no-store" });
    }
    // Owner-only sales ledger summary (Authorization: Bearer <OWNER_MCP_KEY>). Excludes Lumi's own test wallets.
    if (path === "/v1/owner/sales") {
      const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1]?.trim();
      if (!bearer || !(await isOwnerKey(bearer, env.OWNER_MCP_KEY))) {
        return json(401, { error: "owner_key_required", hint: "Authorization: Bearer <OWNER_MCP_KEY>" }, { "Cache-Control": "no-store", "WWW-Authenticate": "Bearer" });
      }
      const summary = await salesSummary(sales, now(), {
        includeTests: url.searchParams.get("include_tests") === "1",
        recent: Math.min(200, Math.max(0, Number(url.searchParams.get("recent") ?? 20) || 0)),
      });
      return json(200, { ...summary, alert: { webhook: Boolean(alertCfg.webhookUrl), email: Boolean(alertCfg.email && alertCfg.emailFrom && alertCfg.emailBinding) } }, { "Cache-Control": "no-store" });
    }

    // ---------------- free
    switch (path) {
      case "/":
        if (prefersHtml(request.headers.get("accept"))) {
          return new Response(indexHtml(config, base, await coins()), {
            headers: { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300", Vary: "Accept" },
          });
        }
        {
          const r = json(200, indexDoc(config, base, await coins()));
          r.headers.set("Vary", "Accept");
          return r;
        }
      case "/favicon.ico":
      case "/favicon.png":
        return new Response(null, { status: 301, headers: { Location: "https://lumitrades.io/assets/favicon-32.png", "Cache-Control": "public, max-age=86400" } });
      case "/apple-touch-icon.png":
        return new Response(null, { status: 301, headers: { Location: "https://lumitrades.io/assets/apple-touch-icon.png", "Cache-Control": "public, max-age=86400" } });
      case "/robots.txt":
        return new Response(`User-agent: *\nAllow: /\nDisallow: /v1/owner/\nDisallow: /mcp/\n\nSitemap: ${base}/sitemap.xml\n`, {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
        });
      case "/sitemap.xml":
        return new Response(sitemapXml(base), { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
      case "/health":
        return json(200, {
          status: "ok",
          version: VERSION,
          network: config.network,
          pay_to: config.payTo,
          facilitator: config.facilitatorUrl,
          ...(config.evm
            ? {
                evm: {
                  network: config.evm.network,
                  pay_to: config.evm.payTo,
                  asset: config.evm.asset,
                  facilitator: config.evm.cdp ? config.evm.cdp.url : config.evm.facilitatorUrl,
                  ...(config.evm.cdp ? { facilitator_name: "Coinbase CDP", fallback_facilitator: config.evm.facilitatorUrl } : {}),
                },
              }
            : {}),
          timestamp: new Date().toISOString(),
        });
      case "/skill.md":
      case "/SKILL.md":
      case "/llms.txt":
        return new Response(skillMd(config, base, await coins()), {
          headers: { "Content-Type": "text/markdown; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
        });
      case "/.well-known/agent-card.json":
      case "/.well-known/agent.json":
        return json(200, agentCard(config, base), { "Cache-Control": "public, max-age=300" });
      case "/.well-known/x402":
        return json(200, wellKnownX402(config, base), { "Cache-Control": "public, max-age=300" });
      case "/.well-known/mcp/server-card.json":
      case "/.well-known/mcp.json":
        return json(200, mcpServerCard(base), { "Cache-Control": "public, max-age=300" });
      case "/.well-known/agents.json":
        return json(200, agentsJson(base), { "Cache-Control": "public, max-age=300" });
      case "/openapi.json":
        return json(200, openApi(config, base, await coins()), { "Cache-Control": "public, max-age=300" });
      case "/v1/samples":
        return json(200, await samplesDoc(base), { "Cache-Control": "public, max-age=600" });
      case "/v1/coins": {
        const list = await coins();
        const site = new Set((await siteCoins()).map((c) => c.id));
        return json(200, {
          kind: "coins",
          timestamp: new Date().toISOString(),
          source: SOURCE,
          count: list.length,
          coverage: "signal: every coin (computed live from public 1h/1d exchange candles, refreshed about every 13 minutes). levels, slate and trades: Lumi's watchlist and majors (group watchlist or majors).",
          coins: list.map((c) => ({
            ...c,
            signal: `${base}/v1/signal/${c.symbol}`,
            levels: site.has(c.id) ? `${base}/v1/levels/${c.symbol}` : null,
          })),
          disclaimer: DISCLAIMER,
        });
      }
    }

    // ---------------- paid
    const vr = path.match(/^\/v1\/trust\/vendors\/([^/]{1,64})\/report$/);
    const m = vr ? [path, "vendor_report", vr[1]] : path.match(/^\/v1\/(signal|levels|lite)\/([^/]+)$/) ?? (FIXED[path] ? [path, FIXED[path]] : null);
    if (!m) return json(404, { error: "not_found", hint: `See ${base}/ for the endpoint list.` });
    const route = m[1] as PaidRoute;

    // An unfilled path template (/v1/signal/{coin}, /v1/signal/:coin, /v1/trust/vendors/%7Bid%7D/report, ...):
    // - the literal OpenAPI template ({coin} / {id}) without a payment header: the normal 402 price quote for the route (same
    //   accepts/prices/payTo as a concrete value), because discovery crawlers (x402scan / @agentcash/discovery, Bazaar) request
    //   the template URL verbatim and only list routes that answer 402; the quote carries a note to fill the placeholder;
    // - any other placeholder style (:coin, <coin>, ${coin}, ...), or any template with a payment header: 400, never charged.
    const rawArg = m[2] !== undefined ? safeDecode(m[2]) : undefined;
    if (rawArg !== undefined && PATH_TEMPLATE_RE.test(rawArg)) {
      const isReport = route === "vendor_report";
      const example = isReport ? `${base}/v1/trust/vendors/printmoneylab/report` : `${base}/v1/${route}/xrp`;
      const hasPayment = !!(request.headers.get(HEADER_PAYMENT_SIGNATURE) || request.headers.get(HEADER_X_PAYMENT));
      if (!hasPayment && rawArg === (isReport ? "{id}" : "{coin}")) {
        const endpoint = PAID_ENDPOINTS.find((e) => e.route === route)!;
        return paymentRequiredResponse(config, {
          routeKey: `${route}:template`,
          amountDrops: config.pricesDrops[route],
          ...(config.xrpPricing === "live" ? { liveDrops: true } : {}),
          xrpUsd: config.xrpRate?.usd ?? config.xrpUsdFallback,
          samplesUrl: `${base}/v1/samples`,
          amountsIou: Object.fromEntries(config.ious.map((o) => [o.symbol, o.prices[route]])),
          amountEvm: config.evm?.amounts[route],
          amountStellar: config.stellar?.amounts[route],
          description: resourceDescription(route, `Lumi API ${endpoint.template}: ${endpoint.summary}`, { usd: config.evm?.prices[route] ?? config.ious.find((o) => o.symbol === "RLUSD")?.prices[route] }),
          resourceUrl: `${base}${path}`,
          bazaar: bazaarExtension(route, isReport ? "printmoneylab" : "xrp", undefined, config.evm?.prices[route]),
          service: serviceMeta(route),
          note: `Replace ${rawArg} with ${isReport ? "a vendor id, e.g. printmoneylab (GET /v1/trust/vendors, free)" : "a coin, e.g. xrp (GET /v1/coins, free)"} and request that URL for a fresh quote before paying: ${example}. A payment sent to this placeholder URL is refused and not charged.`,
        }, "PAYMENT-SIGNATURE header is required");
      }
      return json(400, {
        error: "path_template_not_filled",
        detail: `Replace ${rawArg} with a real value. ${isReport ? "Vendor ids: GET /v1/trust/vendors (free)." : "Coins: GET /v1/coins (free)."}`,
        example,
        openapi: `${base}/openapi.json`,
        note: "Not charged.",
      });
    }

    // /v1/trust/check probed bare (no query string at all, as x402scan and other discovery crawlers do): the normal 402 price
    // quote, so the paywall is visible. A query without a usable url, or any request with a payment header and no url, is
    // refused below (400, nothing verified or settled).
    if (route === "trust_check" && !url.search.replace(/^\?/, "") && !(request.headers.get(HEADER_PAYMENT_SIGNATURE) || request.headers.get(HEADER_X_PAYMENT))) {
      const endpoint = PAID_ENDPOINTS.find((e) => e.route === route)!;
      const usd = config.evm?.prices[route] ?? config.ious.find((o) => o.symbol === "RLUSD")?.prices[route];
      const example = `${base}/v1/trust/check?url=https://api.example.com/v1/data&payTo=0x...&amount=0.01`;
      return paymentRequiredResponse(config, {
        routeKey: `${route}:probe`,
        amountDrops: config.pricesDrops[route],
        ...(config.xrpPricing === "live" ? { liveDrops: true } : {}),
        xrpUsd: config.xrpRate?.usd ?? config.xrpUsdFallback,
        samplesUrl: `${base}/v1/samples`,
        amountsIou: Object.fromEntries(config.ious.map((o) => [o.symbol, o.prices[route]])),
        amountEvm: config.evm?.amounts[route],
          amountStellar: config.stellar?.amounts[route],
        description: resourceDescription(route, `Lumi API ${endpoint.template}: ${endpoint.summary}`, { usd }),
        resourceUrl: `${base}${path}`,
        bazaar: bazaarExtension(route, undefined, { url: "https://api.example.com/v1/data" }, usd),
        service: serviceMeta(route),
        note: `Add ?url=<the x402 resource URL you are about to pay> (optional payTo, amount) and request that URL for a fresh quote before paying: ${example}. A payment sent without url is refused and not charged.`,
      }, "PAYMENT-SIGNATURE header is required");
    }

    const prep = await prepare(route, route === "trust_check" ? url.search : m[2], base);
    if (!prep.ok) return json(prep.status, prep.error, prep.headers);
    const { coin, body } = prep;
    // Owner key (Authorization: Bearer <OWNER_MCP_KEY>) reads the vendor report at no charge.
    if (route === "vendor_report") {
      const auth = request.headers.get("Authorization") ?? "";
      const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
      if (bearer && (await isOwnerKey(bearer, env.OWNER_MCP_KEY))) {
        return json(200, { ...body, access: { mode: "owner", charged: false } }, { "Cache-Control": "no-store" });
      }
    }
    const vendorId = route === "vendor_report" ? String(body.id) : undefined;
    const wantsMarkdown =
      (route === "brief" || route === "institutional") && (/^(md|markdown|text)$/i.test(url.searchParams.get("format") ?? "") || /text\/markdown/i.test(request.headers.get("Accept") ?? ""));

    if ((route === "brief" || route === "institutional") && url.searchParams.has("format") && !/^(json|md|markdown|text)$/i.test(url.searchParams.get("format") ?? "")) {
      return json(400, { error: "invalid_format", detail: "format must be json or md. Not charged." });
    }
    const endpoint = PAID_ENDPOINTS.find((e) => e.route === route)!;
    const quote: Quote = {
      routeKey: coin ? `${route}:${coin.symbol}` : vendorId ? `${route}:${vendorId}` : route,
      amountDrops: config.pricesDrops[route],
      ...(config.xrpPricing === "live" ? { liveDrops: true } : {}),
      xrpUsd: config.xrpRate?.usd ?? config.xrpUsdFallback,
      samplesUrl: `${base}/v1/samples`,
      amountsIou: Object.fromEntries(config.ious.map((o) => [o.symbol, o.prices[route]])),
      amountEvm: config.evm?.amounts[route],
          amountStellar: config.stellar?.amounts[route],
      description: resourceDescription(
        route,
        `Lumi API ${endpoint.template}: ${endpoint.summary}`,
        { subject: coin?.symbol ?? vendorId, usd: config.evm?.prices[route] ?? config.ious.find((o) => o.symbol === "RLUSD")?.prices[route] },
      ),
      resourceUrl: `${base}${path}`,
      bazaar: bazaarExtension(
        route,
        coin?.symbol ?? vendorId,
        route === "trust_check" ? Object.fromEntries(url.searchParams) : wantsMarkdown && url.searchParams.has("format") ? { format: "md" } : undefined,
        config.evm?.prices[route] ?? config.ious.find((o) => o.symbol === "RLUSD")?.prices[route],
      ),
      service: serviceMeta(route),
      // Remaining validity of the data, on the wall clock the paywall uses (the app clock is injectable for tests).
      ...(typeof body.stale_after === "string" ? { staleAfterMs: Date.now() + (Date.parse(body.stale_after) - now()) } : {}),
      ...(typeof body.as_of === "string" && Number.isFinite(Date.parse(body.as_of)) ? { asOfMs: Date.now() + (Date.parse(body.as_of) - now()) } : {}),
    };

    // Free trial (x402 sign-in-with-x): eligible 402s carry a one-time challenge; a valid SIGN-IN-WITH-X retry (and no payment
    // header, which always wins) is served free within the caps. See src/trial.ts.
    const usdPrice = Number(config.evm?.prices[route] ?? config.ious.find((o) => o.symbol === "RLUSD")?.prices[route]);
    if (trialsOn && trialEligible(route, usdPrice)) {
      const trialUri = `${url.origin}${path}${url.search}`;
      const siwxHeader = request.headers.get(SIWX_HEADER);
      const hasPayment = !!(request.headers.get(HEADER_PAYMENT_SIGNATURE) || request.headers.get(HEADER_X_PAYMENT));
      // The SIWX challenge is opt-in (X-Lumi-Trial: 1, or a SIGN-IN-WITH-X retry): a plain unauthenticated 402 stays a standard
      // x402 payment quote, because discovery scanners (x402scan / @agentcash/discovery) classify any 402 carrying
      // extensions["sign-in-with-x"] as an identity-only free route. The plain 402 advertises the trial in a top-level `trial` field.
      if (wantsTrial(request) || siwxHeader) {
        quote.extensions = { [SIWX_KEY]: await siwxChallenge(config.invoiceSecret, trialUri, now(), trialChains(config.evm?.network, config.network)) };
      } else {
        quote.trial = trialHint();
      }
      if (siwxHeader && !hasPayment) {
        const stale = staleRefusal(quote);
        if (stale) return stale;
        const r = await runTrial(request, siwxHeader, trialUri, route);
        if (r.ok) {
          deps.log?.({ event: "trial_call", route, wallet: r.wallet, used: r.used });
          const access = { mode: "trial", charged: false, wallet: r.wallet, trial_calls_used: r.used, trial_calls_remaining: Math.max(0, TRIAL_LIMITS.perWallet - r.used) };
          if (wantsMarkdown) {
            const md = String((body as { markdown?: string }).markdown ?? "");
            return new Response(`${md}\n_Free trial call ${r.used} of ${TRIAL_LIMITS.perWallet}, not charged_\n`, {
              status: 200,
              headers: { "Content-Type": "text/markdown; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
            });
          }
          return json(200, { ...body, access }, { "Cache-Control": "no-store" });
        }
        quote.trial = { granted: false, reason: r.reason, detail: "Free trial not granted for this request; pay with any accepts[] option instead. Not charged." };
      }
    }

    return requirePayment(request, config, paywallDeps(ctx), quote, (s: Settlement, paid: PaymentRequirements) => {
      if (prep.onPaid) {
        // Demand-driven test-buys: a paid trust/check only queues the resource for the daily routine (caps apply there).
        const p = prep.onPaid().catch((e) => deps.log?.({ event: "buy_queue_error", error: String(e) }));
        if (ctx) ctx.waitUntil(p);
      }
      const evm = isEvmRequirement(paid);
      const payment = isStellarRequirement(paid)
        ? {
            transaction: s.transaction,
            network: s.network,
            payer: s.payer ?? null,
            asset: "USDC",
            amount: stroopsToUsdc(paid.amount),
            amount_atomic: paid.amount,
            token: paid.asset,
            explorer: s.transaction && config.stellar ? `${config.stellar.explorer}${s.transaction}` : null,
          }
        : evm
        ? {
            transaction: s.transaction,
            network: s.network,
            payer: s.payer ?? null,
            asset: "USDC",
            amount: atomicToUsdc(paid.amount),
            amount_atomic: paid.amount,
            token: paid.asset,
            explorer: s.transaction ? `${config.evm!.explorer}${s.transaction}` : null,
          }
        : {
            transaction: s.transaction,
            network: s.network,
            payer: s.payer ?? null,
            asset: assetLabel(paid),
            amount: paid.asset === "XRP" ? dropsToXrp(paid.amount) : paid.amount,
            ...(paid.asset === "XRP" ? { amount_drops: paid.amount } : { issuer: paid.extra?.issuer }),
            explorer: s.transaction ? `${EXPLORERS[config.network]}${s.transaction}` : null,
          };
      if (wantsMarkdown) {
        const md = String((body as { markdown?: string }).markdown ?? "");
        return new Response(`${md}\n_Paid: ${payment.amount} ${payment.asset}, tx ${payment.explorer ?? payment.transaction}_\n`, {
          status: 200,
          headers: { "Content-Type": "text/markdown; charset=utf-8", "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "PAYMENT-RESPONSE" },
        });
      }
      return json(200, { ...body, payment });
    });
  }

  /** Verify a SIGN-IN-WITH-X trial attempt and atomically record it against the caps. */
  async function runTrial(request: Request, header: string, uri: string, route: PaidRoute): Promise<{ ok: true; wallet: string; used: number } | { ok: false; reason: string }> {
    const payload = decodeSiwx(header);
    if (!payload) return { ok: false, reason: "invalid_sign_in_with_x_header" };
    const v = await verifySiwx(config.invoiceSecret, payload, uri, now(), trialChains(config.evm?.network, config.network));
    if (!v.ok) return v;
    // One trial per wallet: Base and XRPL wallets share the same ledger and caps (wallet column: 0x lowercase or r-address).
    if ((await trials.usedByWallet(v.wallet).catch(() => 0)) >= TRIAL_LIMITS.perWallet) return { ok: false, reason: "wallet_trial_used_up" };
    if (v.chain === "xrpl") {
      const acct = await xrplTrialAccount(doFetch, xrplRpc, v.wallet, v.signingKeyAddress!);
      if (!acct.ok) return acct;
    } else {
      const bal = await usdcBalance(doFetch, trialRpcs, config.evm!.asset, v.wallet);
      if (bal === null) return { ok: false, reason: "balance_check_unavailable" };
      if (bal < TRIAL_LIMITS.minUsdcAtomic) return { ok: false, reason: "wallet_needs_0.01_usdc_on_base" };
    }
    const ts = now();
    const day = new Date(ts).toISOString().slice(0, 10);
    const ipHash = await trialIpHash(request, env.TRAFFIC_SALT || config.invoiceSecret, day);
    const c = await trials.claim({ nonce: v.nonce, wallet: v.wallet, ip_hash: ipHash, day, route, ts }).catch((e) => {
      deps.log?.({ event: "trial_store_error", error: String(e) });
      return { ok: false as const, reason: "trial_store_unavailable" };
    });
    return c.ok ? { ok: true, wallet: v.wallet, used: c.used } : { ok: false, reason: c.reason };
  }

  return {
    config,
    pricer,
    trust,
    contributors,
    contribQueue: (bodies: unknown[]) => contributors.consume(bodies),
    sales,
    catalog,
    commerce,
    traffic,
    logTraffic(request: Request, response: Response, ctx?: WaitUntil) {
      if (!trafficOn || request.method === "OPTIONS") return;
      const p = trafficRow(request, response, env.TRAFFIC_SALT || env.INVOICE_SECRET || undefined, now())
        .then((row) => trafficBuf.add(row, now()))
        .catch(trafficErr);
      if (ctx) ctx.waitUntil(p);
    },
    flushTraffic: () => Promise.all([trafficBuf.flush().catch(trafficErr), outcomes.flush().catch(() => 0)]).then(() => undefined),
    live,
    feeds,
    async liveRefresh() {
      // A run that refreshes a due feed does only that (CPU budget); otherwise the stalest coin slice.
      const t = now();
      const due = dueFeed(await feeds.ages().catch(() => ({})), t);
      if (due) {
        const r = await refreshFeed(feeds, doFetch, due, t).catch((e) => ({ feed: due, ok: false, error: String((e as Error).message).slice(0, 200) }));
        // On failure keep the old data and its fetched_at; attempt_at backs the feed off for 5 minutes.
        if (!r.ok) await feeds.get(due).then((old) => feeds.put({ id: due, fetched_at: old?.fetched_at ?? 0, doc: { ...(old?.doc ?? {}), attempt_at: t - FEEDS[due].every_ms + 5 * 60_000 } })).catch(() => {});
        deps.log?.({ event: "feed_refresh", ...r });
        return r;
      }
      const r = await refreshLive(live, doFetch, t);
      deps.log?.({ event: "live_refresh", ...r });
      return r;
    },
    async scheduled() {
      // Contributor retention purge: once a day (03:07 UTC tick of the per-minute cron).
      const d = new Date(now());
      const nightly = d.getUTCHours() === 3 && d.getUTCMinutes() === 7;
      const contribPurge = nightly ? contributors.purge().catch(() => {}) : Promise.resolve();
      const prune = Promise.all([trafficBuf.flush().catch(trafficErr), (nightly ? outcomes.nightly().then((r) => deps.log?.({ event: "check_outcomes_nightly", ...r, rolled: r.rolled.length, rerolled: r.rerolled.length, purged_days: r.purged_days.length })) : outcomes.flush()).catch(() => {}), traffic.prune(now() - TRAFFIC_RETENTION_DAYS * 86_400_000).catch(() => {}), contribPurge]);
      const [probes, cat, , com] = await Promise.allSettled([trust.runProbes(), catalog.cron(), prune, commerce.cron(config.publicBaseUrl ?? "https://api.lumitrades.io")]);
      return {
        probes: probes.status === "fulfilled" ? probes.value : { error: String(probes.reason) },
        catalog: cat.status === "fulfilled" ? cat.value : { error: String(cat.reason) },
        commerce: com.status === "fulfilled" ? com.value : { error: String(com.reason) },
      };
    },
    queue: async (job: CatalogJob) => {
      const r = await catalog.consume(job);
      console.log(JSON.stringify({ event: "catalog_job", kind: job.kind, ...(job.kind === "ingest" ? { offset: job.offset } : job.kind === "probe" ? { after: job.after } : {}), ...r }));
      return r;
    },
    badge: (request: Request) => badges.handle(request, config.publicBaseUrl || "https://api.lumitrades.io"),
    async fetch(request: Request, ctx?: WaitUntil): Promise<Response> {
      try {
        // Badge paths first: no pricer (its memo can write D1), no rate limiter, no other D1 work.
        if (request.method === "GET" || request.method === "HEAD") {
          const b = await badges.handle(request, config.publicBaseUrl || "https://api.lumitrades.io");
          if (b) return b;
        }
        if (config.xrpPricing === "live") {
          const rate = await pricer.rate(ctx ? (p) => ctx.waitUntil(p) : undefined);
          applyRate(config, rate);
        }
        return await handle(request, ctx);
      } catch (err) {
        console.error(JSON.stringify({ event: "unhandled_error", error: String(err) }));
        if (isStorageQuotaError(err)) {
          const su = storageUnavailableBody(Date.now());
          return json(503, su.body, { "Retry-After": String(su.retryAfter) });
        }
        return json(500, { error: "internal_error" });
      }
    },
  };
}

function buildBody(route: PaidRoute, coin: CoinRef | undefined, d: Record<string, any>, coins: CoinRef[], now: number) {
  switch (route) {
    case "signal":
      return signalView(coin!, d.signals, d.prices);
    case "levels":
      return levelsView(coin!, d.analysis, d.prices);
    case "slate":
      return slateView(d.trades, coins);
    case "market":
      return marketView(d.analysis, d.signals, d.prices, d.context, coins);
    case "brief":
      return briefView(d as any, coins, now);
    case "yen":
      return yenView(d.context, d.analysis, d.events, d.prices, now);
    case "sentiment":
      return sentimentView(d.context, d.prices, d.signals, coins);
    case "events":
      return eventsView(d.events, d.analysis, coins, now);
    case "trades":
      return tradesView(d.trades, coins);
    case "institutional":
      return institutionalView(d.institutional_brief);
    case "events_48h":
      return events48View(d.events, d.analysis, coins, now);
    default:
      return null; // vendor_report, scan, lite, trust_check, funding, fear_greed: built in prepare()
  }
}

/** Seconds since a millisecond timestamp, or null when unknown. */
function ageSeconds(ms: number | null | undefined, t: number): number | null {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.max(0, Math.round((t - ms) / 1000)) : null;
}

/**
 * 503 "not for sale" body, never charged: {error: "stale_data" | "data_unavailable", detail, data_age_seconds (null when
 * unknown), retry_after_seconds, retryable, note} plus a matching Retry-After header.
 */
export function notForSale(code: "stale_data" | "data_unavailable", detail: string, retryAfter: number, dataAge: number | null, extra: Record<string, unknown> = {}): Prepared {
  return {
    ok: false,
    status: 503,
    error: { error: code, detail, data_age_seconds: dataAge, retry_after_seconds: retryAfter, retryable: true, ...extra, note: "Not charged." },
    headers: { "Retry-After": String(retryAfter) },
  };
}

/** Every paid body carries as_of, data_age_seconds and next_update (derived from as_of / timestamp / stale_after when a view lacks them). */
export function ensureFreshness(body: Record<string, unknown>, t: number): Record<string, unknown> {
  if (typeof body.data_age_seconds === "number" && "next_update" in body) return body;
  const asOfMs = Date.parse(String(body.as_of ?? body.timestamp ?? "")) || t;
  return {
    ...body,
    as_of: body.as_of ?? new Date(asOfMs).toISOString(),
    data_age_seconds: typeof body.data_age_seconds === "number" ? body.data_age_seconds : Math.max(0, Math.round((t - asOfMs) / 1000)),
    next_update: body.next_update ?? body.stale_after ?? null,
  };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** True when the Accept header ranks text/html (or xhtml) above JSON, using q-values; ties go to whichever is listed first. */
export function prefersHtml(accept: string | null | undefined): boolean {
  if (!accept) return false;
  let html = -1, json = -1, htmlPos = Infinity, jsonPos = Infinity;
  accept.split(",").forEach((part, i) => {
    const [type, ...params] = part.trim().toLowerCase().split(";").map((x) => x.trim());
    const qp = params.find((p) => p.startsWith("q="));
    const q = qp ? Math.max(0, Math.min(1, Number(qp.slice(2)) || 0)) : 1;
    if (type === "text/html" || type === "application/xhtml+xml") { if (q > html) { html = q; htmlPos = i; } }
    else if (type === "application/json" || type === "application/*" || type.endsWith("+json")) { if (q > json) { json = q; jsonPos = i; } }
  });
  if (html <= 0) return false;
  return html > json || (html === json && htmlPos < jsonPos);
}

/** API sitemap: the human and machine-readable entry points (paid routes are listed in /openapi.json, not here). */
export function sitemapXml(base: string): string {
  const paths = ["/", "/llms.txt", "/skill.md", "/openapi.json", "/.well-known/x402", "/.well-known/agent-card.json", "/.well-known/mcp/server-card.json", "/.well-known/agents.json", "/v1/samples", "/v1/coins", "/v1/trust/vendors", "/v1/trust/methodology", "/v1/trust/catalog", "/badge", "/v1/monitor", "/v1/monitor/sellers", "/v1/monitor/corrections", "/v1/feed", "/v1/feed/license"];
  const day = new Date().toISOString().slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    paths.map((p) => `  <url><loc>${base}${p}</loc><lastmod>${day}</lastmod><changefreq>daily</changefreq></url>`).join("\n") +
    `\n</urlset>\n`;
}
