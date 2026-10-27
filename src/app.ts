/**
 * Request router. Runtime-agnostic: `createApp(env)` returns a fetch handler
 * used by the Worker entry (src/index.ts) and the Node server (src/node.ts).
 */

import { testBuyWalletsDoc } from "./trust/wallets";
import { createOutcomes, parseOutcome, MemoryOutcomeStore, D1OutcomeStore, OUTCOME_FIELDS, OUTCOME_RETENTION_DAYS, OUTCOME_SUMMARY_RETENTION, type OutcomeStore } from "./trust/outcomes";
import { createBadges } from "./trust/badge";
import { setPrivateNames } from "./sanitize";
import { loadConfig, verdictPaid, EXPLORERS, dropsToXrp, atomicToUsdc, LUMI_STELLAR_ADDRESS, stroopsToUsdc, type Config, type Env, type PaidRoute } from "./config";
import { STELLAR_HORIZON } from "./trust/verify";
import { DataSource, type DataFile } from "./data";
import { D1TrialStore, MemoryTrialStore, SIWX_HEADER, SIWX_KEY, TRIAL_LIMITS, trialHint, wantsTrial, decodeSiwx, siwxChallenge, trialEligible, trialIpHash, usdcBalance, verifySiwx, trialChains, xrplTrialAccount, type TrialStore } from "./trial";
import { makeReplayGuard, json, oversizePaymentHeader, requirePayment, paymentRequiredResponse, staleRefusal, HEADER_PAYMENT_SIGNATURE, HEADER_X_PAYMENT, assetLabel, isEvmRequirement, isStellarRequirement, type PaywallDeps, type PaymentRequirements, type Quote, type Settlement } from "./x402";
import { PAID_ENDPOINTS, endpointFor } from "./catalog";
import { bazaarExtension, resourceDescription, serviceMeta } from "./bazaar";
import { indexDoc, indexHtml, openApi, skillMd, wellKnownX402, vendorReportHtml, VERSION } from "./docs";
import { agentCard, handleA2a, A2A_CORS } from "./a2a";
import {
  coinList, resolveCoin, DISCLAIMER, SOURCE, type CoinRef,
} from "./views";
import { staleInputs, hasContent, DAILY_ROUTE_MAX_AGE_HOURS, fileMeta, withMeta, isoTimestamps, metaFrom, nextHalfHour } from "./freshness";
import { handleMcp, isOwnerKey, MCP_CORS, type McpDeps } from "./mcp";
import { createSanctionsScreen, type KVLike, type SanctionsDoc } from "./sanctions";
import { createTrust, TRUST_POST_PATHS, REPORT_FRESH_MS, type Trust } from "./trust";
import { createCommerce, D1CommerceStore, MemoryCommerceStore, type Commerce } from "./commerce";
import type { CommerceStore } from "./commerce/store";
import { TEST_PRICE_USD } from "./commerce/plans";
import { VENDORS, vendorById } from "./vendors";
import { D1TrustStore, MemoryTrustStore, type TrustStore } from "./trust/store";
import { SEED_OBSERVATIONS } from "./trust/seed";
import { isStorageQuotaError, storageUnavailableBody } from "./trust/storage_errors";
import { D1CatalogStore, MemoryCatalogStore, excludingStore, type CatalogStore } from "./trust/catalog";
import { createCatalog, buyCandidate, PRIORITY_DAILY_CAP, type Catalog, type CatalogJob, type QueueLike } from "./trust/catalog_service";
import { D1EvidenceStore, MemoryEvidenceStore, type EvidenceStore } from "./trust/evidence";
import { D1ReceiptStore, MemoryReceiptStore, type ReceiptStore } from "./trust/receipts";
import { createContributors, D1ContributorStore, MemoryContributorStore, type ContributorStore, type Contributors, type ContribQueue } from "./trust/contributors";
import { productSample, sampleEntry, SAMPLE_ARGS, SAMPLE_LABEL } from "./samples";
import { applyRate, createXrpPricer, type XrpPricer } from "./pricing";
import { D1TrafficStore, MemoryTrafficStore, TRAFFIC_RETENTION_DAYS, TrafficBuffer, trafficRow, trafficSummary, type TrafficStore } from "./traffic";
import { D1FeedStore, MemoryFeedStore, FEEDS, dueFeed, refreshFeed, feedFresh, type FeedStore } from "./feeds";
import { fundingView, fearGreedView, fearGreedFromContext, trustVerdict } from "./quick";
import { lookupError, withSafety } from "./trust/index";

/**
 * Warn-level reasons that are safety findings: an address that differs from the record, a price jump, and recent paid checks
 * that failed (also while a person reviews them before checks_failed is shown). Every block reason is one too.
 */
const SAFETY_WARN_CODES = new Set(["pay_to_unrecognised", "quoted_price_differs", "paid_no_data", "xrpl_paid_no_data", "recent_buy_failed", "checks_failed_pending_review"]);
import { signResponse, signingKeyFrom, keysDoc, type SigningKey } from "./trust/lumi_sign";
import { signingSecretSeparate } from "./trust/lumi_keys";
import { originPath, checkPayload, badgeDecision, badgeThresholds, CHECK_SIGNED_TTL_SEC, BADGE_SIGNED_TTL_SEC, BADGE_CACHE, BADGE_WINDOW_DAYS, earnedBadgeSvg, noBadgeSvg, testedBadgeRules, utcDay } from "./trust/check";
import { curatedByHost, badgeDocs } from "./trust/badge";
import type { LookupQuery } from "./trust/catalog";
import { D1LiveStore, MemoryLiveStore, isFresh, LIVE_UNIVERSE, LIVE_MAX_AGE_MS, LIVE_CYCLE_MS, type LiveStore } from "./live";
import { mcpServerCard, agentsJson } from "./wellknown";
import { TRUST_DISCLAIMER } from "./lines";
import { isRetiredPath, retiredResponse, RETIRED_ON } from "./retired";
import { D1IdempotencyStore, MemoryIdempotencyStore, type IdempotencyStore } from "./idempotency";
import { labelFor, LABELS, DEFINITION, FAILED_RULE, testBuyEvidence, thresholdsDoc, verdictThresholds, VERDICT_KIND, VERDICT_RULES_VERSION, DISPUTE_URL, CHECK_NOTE } from "./trust/verdict";
import { createReviewGate, D1ReviewStore, MemoryReviewStore, appealUntil, type ReviewStore } from "./trust/reviews";
import { relationshipConfig, relationshipFor, relationshipTag } from "./trust/relationship";
import { D1ProbeStore, MemoryProbeStore, parseProbeRow, probeRowPublic, probeScope, PROBE_MAX_ROWS_PER_LOAD, type ProbeStore } from "./trust/probe_checked";
import { registrableDomain } from "./trust/catalog";
import { liveProbe, liveAlertView, LIVE_ALERT_PREFIX, LIVE_CHECK_NOTE, type LiveBaseline } from "./trust/live_check";
import { createActivity, activityPublic, activityOwnerView, activityFlags, qualifyOrganicPayers, D1ActivityStore, MemoryActivityStore, type ActivityStore } from "./trust/activity";
import { CONTACT_EMAIL } from "./trust/index";
import { D1SalesStore, MemorySalesStore, salesSummary, sendSaleAlert, toRow, alertEnabled, insertWithRetry, DEFERRED_ALERT_ROUTES, DEFERRED_ALERT_WAIT_MS, REFUSED_ALERT_NOTE, type SalesStore, type AlertConfig, type SaleOutcome } from "./sales";

export interface AppOptions {
  /** OFAC SDN address snapshot override (tests); default = bundled data/ofac_sdn_addresses.json (+ optional SANCTIONS_KV). */
  sanctions?: SanctionsDoc;
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
  /** Seller customer-activity store override (tests). Default: D1 (TRUST_DB) when bound, else in-memory. */
  activityStore?: ActivityStore;
  probeStore?: ProbeStore;
  /** checks_failed review queue + re-test requests override (tests). Default: D1 (TRUST_DB) when bound, else in-memory. */
  reviewStore?: ReviewStore;
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

/** /.well-known/trustline-merchant.txt body: Lumi's XRPL receiving wallet(s), one `xrpl:<r-address>` per line. No signature. */
export function trustlineMerchantTxt(cfg: { payTo: string }): string {
  return `xrpl:${cfg.payTo}\n`;
}

/** /.well-known/security.txt (RFC 9116) for the API host. Same contact as the site; Expires within a year. */
export const API_SECURITY_TXT = [
  "Contact: mailto:hello@lumitrades.io",
  "Expires: 2027-10-24T00:00:00.000Z",
  "Preferred-Languages: en",
  "Canonical: https://api.lumitrades.io/.well-known/security.txt",
  "Policy: https://lumitrades.io/privacy/",
  "# Lumi Trades is an x402 seller trust service. It is not a broker, never asks for deposits and never holds user funds.",
  "# Official Lumi email comes from @lumitrades.io addresses. Contacts: https://lumitrades.io/contact/",
  "",
].join("\n");

export function priorityCap(v: string | undefined): number {
  const n = v == null || v.trim() === "" ? NaN : Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : PRIORITY_DAILY_CAP;
}

export type Prepared =
  | { ok: true; route: PaidRoute; coin?: CoinRef; body: Record<string, unknown>; onServed?: () => Promise<unknown>; /** Runs only once the call is paid (or a trial/owner call is granted): adds fields such as the live check. Never before payment. */ enrich?: () => Promise<Record<string, unknown>> }
  | { ok: false; status: number; error: Record<string, unknown>; headers?: Record<string, string> };

export interface App {
  fetch(request: Request, ctx?: WaitUntil): Promise<Response>;
  /** Cron entry: free, unpaid 402-quote probes of the trust allowlist + the x402 catalog slice. */
  scheduled(): Promise<{ probes: unknown; catalog: unknown; commerce?: unknown }>;
  /** One-minute cron: refresh the most overdue market-data feed (per-coin signal recompute retired 2026-10-25). */
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
  /** Lumi Check contributions (keys, submissions, badges). */
  contributors: Contributors;
  /** Queue consumer for lumi-contrib-writes: batched contribution writes. */
  contribQueue(bodies: unknown[]): Promise<number>;
  /** Free public "Tested by Lumi" badge + result page (read-only, no D1 writes). Null for other paths. */
  badge(request: Request): Promise<Response | null>;
}

/** Persist the last-known XRP/USD fallback rate at most this often (D1 write budget). */
export const XRP_MEMO_MS = 30 * 60_000;

const NEEDS: Record<PaidRoute, DataFile[]> = {
  vendor_report: [], // trust-layer data (D1), checked in prepare()
  trust_check: [], // trust catalog (D1)
  verdict: [], // trust catalog + seller_activity (D1), same lookup as /v1/check
  receipts: [], // trust catalog purchases + signed receipt store (D1)
  batch_check: [], // trust catalog (D1), same check core as /v1/check
};
/** Inputs that enrich a product but whose absence does not block it (the field is simply omitted). */
const OPTIONAL: Partial<Record<PaidRoute, DataFile[]>> = {};
/** Paid paths without a path parameter. Every non-trust data route was retired on 2026-10-25: 410 Gone, see src/retired.ts. */
const FIXED: Record<string, PaidRoute> = {
  "/v1/trust/check": "trust_check",
  "/v1/verdict": "verdict",
  "/v1/trust/receipts": "receipts",
  "/v1/check/batch": "batch_check",
};
/** Paid routes whose input is the query string (validated in prepare(), refused with 400 and never charged when malformed). */
const QUERY_ROUTES: PaidRoute[] = ["trust_check", "verdict", "receipts", "batch_check"];
/** GET /v1/check/batch: at most this many URLs or domains per call. */
export const BATCH_MAX = 10;
/** GET /v1/trust/receipts: at most this many receipts per answer (newest first). */
export const RECEIPTS_MAX = 50;

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
  const paidByCtx = new WeakMap<object, boolean>();
  /** Deferred sale alerts waiting for their handler's outcome, by tx (per isolate; the request holds them via waitUntil). */
  const pendingAlerts = new Map<string, (o: SaleOutcome) => void>();
  const saleOutcome = (tx: string, o: SaleOutcome) => pendingAlerts.get(tx)?.(o);
  const paywallDeps = (ctx?: WaitUntil): PaywallDeps => ({
    ...deps,
    onSale: async (sale) => {
      const row = toRow(sale, now(), extraTestWallets);
      // Lets the request log tag this request's paid call as Lumi's own test (ctx is per request).
      if (ctx) paidByCtx.set(ctx, row.isTest);
      const inserted = await insertWithRetry(sales, row).catch((e) => {
        // Both attempts failed: log the whole row (public addresses only, no IP) so it can be backfilled from Workers Logs.
        deps.log?.({ event: "sale_record_error", tx: row.tx, error: String(e), row });
        return true;
      });
      if (inserted && alertEnabled(alertCfg) && DEFERRED_ALERT_ROUTES.has(row.route) && ctx) {
        // Founder pack: the place is claimed after settlement and can still be refused, so the alert waits for the
        // handler's outcome (saleOutcome) and says so when the payment was refused; no outcome in time = "outcome unknown".
        const p = new Promise<SaleOutcome>((resolve) => {
          const timer = setTimeout(() => resolve({ kind: "unknown" }), DEFERRED_ALERT_WAIT_MS);
          pendingAlerts.set(row.tx, (o) => { clearTimeout(timer); resolve(o); });
        }).then((o) => {
          pendingAlerts.delete(row.tx);
          const note = o.kind === "refused" ? `${REFUSED_ALERT_NOTE} (${o.reason})` : o.kind === "unknown" ? "outcome unknown, check owner packs review" : undefined;
          return sendSaleAlert(alertCfg, row, doFetch, note);
        }).then((sent) => sent.length && deps.log?.({ event: "sale_alert_sent", tx: row.tx, via: sent, deferred: true }));
        ctx.waitUntil(p);
      } else if (inserted && alertEnabled(alertCfg)) {
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
  // OFAC SDN screen: bundled snapshot Set per isolate (+ optional KV copy); no D1 reads.
  const sanctions = createSanctionsScreen({ doc: opts.sanctions, kv: env.SANCTIONS_KV as KVLike | undefined, now, log: (e) => deps.log?.(e) });
  // permanent seller exclusions (trust/excluded.ts) wrap every catalog read and write
  const catalogStore = excludingStore(opts.catalogStore ?? (env.TRUST_DB ? new D1CatalogStore(env.TRUST_DB) : new MemoryCatalogStore()));
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
  // Per-seller customer activity (information only; never a score input). Optional: absent table = no activity block.
  // Lumi's own sellers and wallets are never ingested (payments from Lumi's wallets are already excluded upstream).
  const lumiSelf = { domains: ["lumitrades.io"], pay_to: [config.payTo, ...xrplBuyers, ...(config.evm ? [config.evm.payTo] : []), ...(config.stellar ? [config.stellar.payTo] : []), ...evmBuyers, ...stellarBuyers] };
  const activity = createActivity(opts.activityStore ?? (env.TRUST_DB ? new D1ActivityStore(env.TRUST_DB) : new MemoryActivityStore()), now, lumiSelf);
  // Free probe-checked tier ("Checked, not test-bought"): display + check_first wording only; never verified, never checks_passed.
  const probeStore: ProbeStore = opts.probeStore ?? (env.TRUST_DB ? new D1ProbeStore(env.TRUST_DB) : new MemoryProbeStore());
  const verdictTh = verdictThresholds(env as unknown as Record<string, string | undefined>);
  const relCfg = relationshipConfig(env as unknown as Record<string, string | undefined>);
  const reviewStore: ReviewStore = opts.reviewStore ?? (env.TRUST_DB ? new D1ReviewStore(env.TRUST_DB) : new MemoryReviewStore());
  const reviewGate = createReviewGate(reviewStore, now, (e) => deps.log?.(e));
  const verdictIsPaid = verdictPaid(env);
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
    priorityDailyCap: priorityCap(env.TRUST_PRIORITY_DAILY_CAP),
    xrplRpc,
    baseRpc,
    receipts: receiptStore,
    evidence: evidenceStore,
    onStatusChanges: (changes) => commerceStore.addChanges(changes),
    sanctions,
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
  // LUMI_CHECK_SIGNING_KEY signs answers; CONTRIB_ADMIN_KEY (else OWNER_MCP_KEY) is the separate admin credential. If one
  // secret is reused for both, fail closed: no signing with it and no contributor admin routes.
  const secretReused = !signingSecretSeparate(env);
  const contributors = createContributors({
    store: opts.contributorStore ?? (env.TRUST_DB ? new D1ContributorStore(env.TRUST_DB) : new MemoryContributorStore()),
    fetch: doFetch,
    now,
    ownerKey: secretReused ? undefined : env.OWNER_MCP_KEY,
    adminKey: secretReused ? undefined : env.CONTRIB_ADMIN_KEY,
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
    // Free lookups by exact URL feed the same test-buy priority signal as the paid trust/check (payment never changes the order).
    safetyFor: (q, base) => safetyFindings(q.url ? { url: q.url, payTo: q.payTo } : q.domain ? { url: `https://${q.domain}/`, payTo: q.payTo } : { payTo: q.payTo }, base),
    onFreeCheck: (q, base) => (q.url ? checkSignal({ url: q.url, ...(q.payTo ? { payTo: q.payTo } : {}) }, base, "free_lookup") : Promise.resolve(null)),
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
  const signKey = () => (signKeyMemo ??= secretReused ? Promise.resolve(null) : signingKeyFrom(env.LUMI_CHECK_SIGNING_KEY));

  /** Live score summary for a host or vendor id (curated vendors only; everything else is "not_scored"). */
  async function liveScore(keyOrHost: string) {
    const k = keyOrHost.toLowerCase();
    const ids = vendorById(k) ? [k] : curatedByHost(k).map((v) => v.id);
    if (ids.length !== 1) return null;
    return trust.vendorScore(ids[0]);
  }
  const scoreView = (s: Awaited<ReturnType<typeof liveScore>>, tier: unknown) => s
    ? {
        scored: s.score.value != null,
        status: s.score.status,
        ...(s.score.reason ? { reason: s.score.reason } : {}),
        vendor_id: s.vendor_id,
        value: s.score.value,
        confidence: s.score.confidence,
        tier: tier ?? null,
        paid_test_buys: s.score.samples.paid_test_buys,
      }
    : { scored: false, status: "not_scored" as const, value: null, confidence: null, tier: tier ?? null, note: "Numeric scores exist for curated vendors only, and only after a conclusive Lumi test-buy; the tier comes from the catalog." };

  async function checkVerdict(input: { url: string; payTo?: string; amountUsd?: number; network?: string }, base: string, free: boolean) {
    const exact = (await trust.lookup({ url: input.url } as LookupQuery, base, free ? { free: true } : undefined)) as any;
    const hasExact = !!exact?.self || (exact?.catalog?.entries?.length ?? 0) > 0;
    const host = new URL(input.url).hostname.toLowerCase();
    const dom = hasExact ? null : ((await trust.lookup({ domain: host } as LookupQuery, base, free ? { free: true } : undefined)) as any);
    await sanctions.ready();
    return finishCheck(trustVerdict(input, exact, dom, base, sanctions, now()) as Record<string, any>, exact, dom, host);
  }

  /**
   * The rest of the ONE check core, shared by /v1/check, /v1/trust/check and /v1/verdict: human review / re-test gate, then the
   * shared label. The relationship disclosure is computed here but only attached for display: labelFor() never sees it.
   */
  /** payTos Lumi has on record for a seller (catalog listing + curated vendor), never the quoted payTo. */
  const recordedPayTos = (exact: any, dom: any): string[] => [
    ...((exact?.catalog?.entries?.[0]?.pay_to ?? dom?.catalog?.entries?.[0]?.pay_to ?? []) as any[]).map((p) => String(p?.pay_to ?? p ?? "")),
    ...VENDORS.filter((v) => [...(exact?.curated ?? []), ...(dom?.curated ?? [])].some((c: any) => c?.id === v.id)).flatMap((v) => [...v.pay_to.xrpl, ...(v.pay_to.evm ?? [])]),
  ].filter(Boolean);

  /** Endpoints Lumi test-bought with delivery for this seller: delivered purchases on record plus curated test_buy endpoints. */
  const boughtEndpoints = (exact: any, dom: any): string[] => {
    const curatedIds = new Set([...(exact?.curated ?? []), ...(dom?.curated ?? [])].map((c: any) => c?.id));
    const fromBuys = [exact?.catalog?.entries?.[0], dom?.catalog?.entries?.[0], ...(exact?.curated ?? []), ...(dom?.curated ?? [])]
      .flatMap((e: any) => (Array.isArray(e?.purchases) ? e.purchases : []))
      .filter((b: any) => b?.data_returned !== false && typeof b?.endpoint === "string").map((b: any) => String(b.endpoint));
    const fromCurated = VENDORS.filter((v) => curatedIds.has(v.id)).flatMap((v) => v.endpoints.filter((e: any) => e.test_buy).map((e) => e.url));
    return [...new Set([...fromBuys, ...fromCurated])];
  };

  /**
   * Safety findings that are never withheld, even when the free limit is hit: an address that differs from the record, a
   * price jump, a TLS failure or other live-check safety change, a sanctions match, and "Recent checks failed". Built from the
   * same check core as /v1/check; a free-limit 429 carries this instead of the normal answer. Never throws.
   */
  async function safetyFindings(input: { url?: string; payTo?: string; amountUsd?: number; network?: string }, base: string): Promise<Record<string, unknown>> {
    const t = now();
    try {
      let clean: string | null = null;
      if (input.url) { try { clean = originPath(input.url); } catch { clean = null; } }
      if (!clean && !input.payTo) return { checked: false, active: false, findings: [], note: "No URL or payTo to check." };
      const { verdict: v } = clean ? await checkVerdict({ url: clean, payTo: input.payTo, amountUsd: input.amountUsd, network: input.network }, base, false) : await payToVerdict({ payTo: input.payTo!, amountUsd: input.amountUsd, network: input.network }, base);
      const findings: { code: string; detail: string }[] = [];
      for (const r of (v?.reasons ?? []) as any[]) if (r?.severity === "block" || SAFETY_WARN_CODES.has(r?.code)) findings.push({ code: String(r.code), detail: String(r.detail ?? "") });
      for (const c of ((v?.live_alert as any)?.changes ?? []) as any[]) findings.push({ code: `live_${c.field}_change`, detail: String(c.text ?? "") });
      if (v?.label === "checks_failed" && !findings.some((f) => f.code === "paid_no_data")) findings.push({ code: "checks_failed", detail: LABELS.checks_failed });
      return {
        checked: true, active: findings.length > 0, as_of: new Date(t).toISOString(),
        findings, live_alert: v?.live_alert ?? null,
        note: "Safety findings are never withheld: they are shown even when the free limit is reached. Only the normal answer waits for the limit to reset.",
      };
    } catch (e) {
      deps.log?.({ event: "safety_on_limit_error", error: String(e) });
      return { checked: false, active: null, findings: [], note: "Lumi could not read the safety record right now; this is not an all-clear. Retry after the limit resets." };
    }
  }

  /** How old the evidence behind a cached answer is (newest of: last delivered test-buy, last free probe, last catalog quote check). */
  const dataAge = (ts: (number | null)[], t: number) => {
    const xs = ts.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    const at = xs.length ? Math.max(...xs) : null;
    return { cached: true, as_of: at == null ? null : new Date(at).toISOString(), age_seconds: at == null ? null : Math.max(0, Math.round((t - at) / 1000)), live_check: "/v1/trust/check (x402, $0.02) contacts the seller now and returns signed fresh evidence" };
  };

  async function finishCheck(v: Record<string, any>, exact: any, dom: any, host: string | null) {
    const commercial = ((exact?.commercial_relationship ?? dom?.commercial_relationship ?? null) as unknown[] | null);
    const relationship = relationshipFor(host, commercial, relCfg);
    const gate = host ? await reviewGate(v, exact ?? dom, host, relationshipTag(relationship)) : { review: null, retest: null };
    // organic_payers is qualified (never a label input) when the seller's activity row is flagged self_funded_loop.
    if (Array.isArray(v.reasons) && v.reasons.some((r: any) => r?.code === "organic_payers")) {
      try {
        const row = await activity.lookup(host, recordedPayTos(exact, dom));
        if (row) v.reasons = qualifyOrganicPayers(v.reasons, activityFlags(row, verdictTh));
      } catch { /* activity is optional */ }
    }
    const tests = testBuyEvidence(exact, dom);
    const reg = host ? registrableDomain(host) : null;
    const probeRow = reg ? await probeStore.get(reg).catch(() => null) : null;
    const scope = probeScope(probeRow, boughtEndpoints(exact, dom), tests.last_delivered_at ? 1 : 0);
    const liveAlert = host ? liveAlertView(await catalogStore.getMeta(LIVE_ALERT_PREFIX + host).catch(() => null), now()) : null;
    const lab = labelFor({ check: { decision: String(v.verdict), reasons: v.reasons ?? [] }, tests, now: now(), th: verdictTh, probe: probeRow, probeScope: scope, liveAlert: !!liveAlert });
    v.live_alert = liveAlert;
    v.data_age = dataAge([tests.last_delivered_at ? Date.parse(tests.last_delivered_at) : null, probeRow?.checked_at ?? null, Date.parse(exact?.catalog?.entries?.[0]?.quote_checks?.last_checked_at ?? dom?.catalog?.entries?.[0]?.quote_checks?.last_checked_at ?? "")], now());
    v.free_checks = probeRowPublic(probeRow, tests.last_delivered_at ? 1 : 0, scope);
    v.label = lab.label;
    v.label_text = LABELS[lab.label];
    v.relationship = relationship;
    v.commercial_relationship = commercial ?? [];
    return { verdict: v, exact, dom, host, tests, lab, gate, relationship };
  }

  /** payTo-only verdict (MCP tool payments): who is this address, per the catalog and Lumi's curated vendors. */
  async function payToVerdict(input: { payTo: string; amountUsd?: number; network?: string }, base: string) {
    const doc = (await trust.lookup({ payTo: input.payTo } as LookupQuery, base, { free: true })) as any;
    const first = doc?.catalog?.entries?.[0]?.resource as string | undefined;
    const cur = doc?.curated?.[0]?.id as string | undefined;
    let host: string | null = cur ?? null;
    if (!host && first) { try { host = new URL(first).hostname.toLowerCase(); } catch { host = null; } }
    await sanctions.ready();
    const verdict = trustVerdict({ url: first ?? "", ...input } as any, doc, null, base, sanctions, now()) as Record<string, any>;
    if (verdict.matched) verdict.matched.exact = false;
    return finishCheck(verdict, doc, null, host);
  }

  async function freeCheck(request: Request, url: URL, base: string, ctx?: WaitUntil): Promise<Response> {
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
    // One free limit for everyone: contributors get no rate-limit or other perk.
    const network = sp.get("network")?.slice(0, 40) || undefined;
    const limit = await trust.freeLimit(request, "lookup");
    if (limit) return withSafety(limit, await safetyFindings({ url: clean || undefined, payTo, amountUsd, network }, base));
    // One check core for /v1/check, /v1/trust/check and /v1/verdict: the same full catalog lookup and the same trustVerdict, so
    // the free check, the paid check and the verdict can never disagree for the same seller at the same time. Only the
    // response shape differs (checkPayload is answer-only).
    const { verdict, host, exact } = clean ? await checkVerdict({ url: clean, payTo, amountUsd, network }, base, false) : await payToVerdict({ payTo: payTo!, amountUsd, network }, base);
    if (verdict?.verdict === "block" && verdict?.reasons?.[0]?.code === "sanctioned_address") {
      const hit = sanctions.check(payTo);
      if (hit) sanctions.refuse("free_check", hit, host ? { url_host: host } : {});
    }
    if (clean) {
      // Free pre-pay checks send the same test-buy priority signal as paid checks (one path; abuse limits in catalog.queueBuy).
      const p = prioritySignal(verdict, exact, "free_check").catch((e) => { deps.log?.({ event: "buy_queue_error", source: "free_check", error: String(e) }); return null; });
      if (ctx) ctx.waitUntil(p); else await p;
    }
    const score = host ? scoreView(await liveScore(host), verdict.matched?.tier) : null;
    const link = host ? `${base}/trust/v/${encodeURIComponent(host)}` : `${base}/v1/trust/vendors?payTo=${encodeURIComponent(payTo!)}`;
    const payload = checkPayload({ query: { url: clean, payTo, amountUsd, network }, verdict, score, link, paid: false });
    const t = now();
    const receipt = await signResponse("lumi_check", payload, await signKey(), t, CHECK_SIGNED_TTL_SEC);
    return json(200, {
      kind: "lumi_check", ...payload, receipt,
      detail: clean ? `${base}/v1/trust/check?url=${encodeURIComponent(clean)} (x402, adds reason details and next steps)` : `${base}/v1/trust/vendors?payTo=${encodeURIComponent(payTo!)}`,
      note: CHECK_NOTE,
    }, noStore);
  }

  /** Earned-only "Tested by Lumi" badge: decision from the live score only, signed and short-lived. */
  async function earnedBadge(key: string, ext: "json" | "svg", base: string): Promise<Response> {
    const s = await liveScore(key);
    const th = badgeThresholds(env);
    const d = s ? badgeDecision({ score: s.score, last_conclusive: s.last_conclusive, status: s.status }, th) : { earned: false as const, reason: "not_scored" };
    const live = `${base}/trust/v/${encodeURIComponent(s?.vendor_id ?? key)}`;
    const headers = { "Cache-Control": BADGE_CACHE, "Access-Control-Allow-Origin": "*" };
    if (ext === "svg") {
      // Dated by Lumi's latest conclusive test-buy (delivered whenever the badge is earned), never the render date.
      const svg = d.earned && s && s.last_conclusive_at != null ? earnedBadgeSvg(s.score.value!, utcDay(s.last_conclusive_at)) : noBadgeSvg(d.reason === "not_scored" ? "not scored" : "no badge");
      return new Response(svg, { status: 200, headers: { ...headers, "Content-Type": "image/svg+xml; charset=utf-8", Link: `<${live}>; rel="related"` } });
    }
    const payload = {
      subject: s ? { vendor_id: s.vendor_id, name: s.name } : { key: key.slice(0, 200) },
      earned: d.earned, reason: d.reason,
      score: s ? { value: s.score.value, status: s.score.status, ...(s.score.reason ? { reason: s.score.reason } : {}), confidence: s.score.confidence, paid_test_buys: s.score.samples.paid_test_buys } : null,
      last_test_buy: s?.last_conclusive_at != null ? { at: new Date(s.last_conclusive_at).toISOString(), date: utcDay(s.last_conclusive_at), result: s.last_conclusive } : null,
      ...(d.earned && s?.last_conclusive_at != null ? { lapses_at: new Date(s.last_conclusive_at + BADGE_WINDOW_DAYS * 86_400_000).toISOString() } : {}),
      threshold: { min_score: th.minScore, min_paid_test_buys: th.minPaidTests, window_days: BADGE_WINDOW_DAYS, latest_test_buy: "delivered" },
      rules: testedBadgeRules(th),
      live_report: live,
      embed: d.earned ? `<a href="${live}"><img src="${base}/v1/badge/${encodeURIComponent(s?.vendor_id ?? key)}.svg" alt="Lumi test-buy badge: live status"></a>` : null,
      purchasable: false,
    };
    const signed = await signResponse("tested_badge", payload, await signKey(), now(), BADGE_SIGNED_TTL_SEC);
    return json(200, { kind: "tested_badge_verdict", ...payload, signed, note: "Earned only, never sold. Re-evaluated from the live score on every request; removed automatically when a rule above stops holding (score drop, failed latest test-buy, or no conclusive Lumi test-buy for 30 days). Check the signature and expires_at; a copied image proves nothing." }, headers);
  }
  const ownHosts = new Set(["api.lumitrades.io", ...(config.publicBaseUrl ? [new URL(config.publicBaseUrl).hostname] : [])]);
  const commerce = createCommerce({
    sanctions,
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
    saleOutcome,
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

  /** Lumi's site coins (coins.json): full coverage including levels and slate. */
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
    if (route === "verdict") return prepareVerdict(coinArg ?? "", base);
    if (route === "receipts") return prepareReceipts(coinArg ?? "", base);
    if (route === "batch_check") return prepareBatch(coinArg ?? "", base);
    // Every paid route is a seller check; all other data routes were retired on 2026-10-25 (src/retired.ts).
    return { ok: false, status: 404, error: { error: "not_found", route, note: "Not charged." } };
  }

  /** What Lumi had on record for this seller before a live check (catalog listing, curated vendor, last free probe). */
  async function liveBaseline(exact: any, dom: any, host: string, url: string): Promise<LiveBaseline> {
    const entry = exact?.catalog?.entries?.[0] ?? dom?.catalog?.entries?.[0];
    const qc = entry?.quote_checks;
    const reg = registrableDomain(host);
    const probe = reg ? await probeStore.get(reg).catch(() => null) : null;
    const quoteOk = qc?.last_valid_quote ?? (probe ? probe.outcome === "pass" : null);
    return {
      pay_tos: [...new Set(recordedPayTos(exact, dom))].slice(0, 12),
      price_usd: entry?.listed_price_usd ?? null,
      quote_ok: quoteOk ?? null,
      https: quoteOk === true ? url.startsWith("https://") : null,
      as_of: qc?.last_checked_at ?? (probe?.checked_at ? new Date(probe.checked_at).toISOString() : null),
      source: entry ? "catalog listing and Lumi's last quote check" : probe ? "Lumi's last free probe" : "curated vendor record",
    };
  }

  /** The paid live part of /v1/trust/check: one unpaid request to the seller now, compared with the record, signed. */
  async function liveCheck(url: string, host: string, exact: any, dom: any, query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const baseline = await liveBaseline(exact, dom, host, url);
    const live = await liveProbe((u, init) => (ownHosts.has(host) ? handle(new Request(u as string, init)) : doFetch(u as any, init)), url, baseline, now);
    const key = LIVE_ALERT_PREFIX + host;
    try {
      if (live.safety_change) await catalogStore.setMeta(key, JSON.stringify({ checked_at: live.checked_at, url, changes: live.changes }));
      else if (live.outcome === "unchanged") {
        // Clear only an alert raised for this same URL (another endpoint of the host may still differ).
        const prev = await catalogStore.getMeta(key);
        if (prev && (() => { try { return JSON.parse(prev).url === url; } catch { return true; } })()) await catalogStore.setMeta(key, "");
      }
    } catch (e) { deps.log?.({ event: "live_alert_store_error", error: String(e) }); }
    const evidence = await signResponse("live_check", { query, live }, await signKey(), now(), CHECK_SIGNED_TTL_SEC);
    return { live, live_evidence: evidence, live_note: LIVE_CHECK_NOTE };
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
      const { verdict: body, exact, dom } = await checkVerdict({ url: clean, payTo, amountUsd, network }, base, false);
      if ((body as any)?.verdict === "block" && (body as any)?.reasons?.[0]?.code === "sanctioned_address") {
        const hit = sanctions.check(payTo) ?? sanctions.checkAny(((exact?.catalog?.entries?.[0]?.pay_to ?? dom?.catalog?.entries?.[0]?.pay_to ?? []) as any[]).map((p) => String(p?.pay_to ?? "")));
        if (hit) sanctions.refuse("trust_check", hit, { url_host: host });
      }
      const t = now();
      const payload = checkPayload({ query: { url: clean, payTo, amountUsd, network }, verdict: body, score: scoreView(await liveScore(host), (body as any).matched?.tier), link: `${base}/trust/v/${encodeURIComponent(host)}`, paid: true });
      (body as any).lumi_receipt = await signResponse("trust_check", payload, await signKey(), t, CHECK_SIGNED_TTL_SEC);
      const meta = metaFrom(t, t + 86_400_000, t + 30 * 60_000, t);
      // Runs once the check is served, paid or free trial: the same priority signal either way.
      return {
        ok: true, route: "trust_check", body: isoTimestamps(withMeta(body as Record<string, unknown>, meta)), onServed: () => prioritySignal(body, exact, "trust_check"),
        enrich: () => liveCheck(clean, host, exact, dom, { url: clean, payTo, amountUsd, network }),
      };
    } catch (e) {
      return notForSale("data_unavailable", "the trust catalog is unavailable right now", 60, null);
    }
  }

  /**
   * GET /v1/verdict: the shared label (checks_passed | check_first | checks_failed | no_data) on top of the SAME check core as
   * the free /v1/check (same lookup, same reasons, same review gate, same signing key). The embedded check_receipt is exactly
   * what /v1/check signs at the same moment. Free alias by default; paid ($0.01) when VERDICT_PRICING = "paid".
   * Never an input: monitoring/commercial status, relationship flags, payment for this call, observed on-chain payments.
   */
  type VerdictOut = { ok: true; body: Record<string, unknown>; t: number; onServed: () => Promise<unknown>; live: () => Promise<Record<string, unknown>> } | { ok: false; status: number; error: Record<string, unknown> };
  async function buildVerdict(qs: string, base: string, paid: boolean): Promise<VerdictOut> {
    const sp = new URLSearchParams(qs);
    let raw = sp.get("url")?.trim() || sp.get("domain")?.trim() || "";
    const payTo = sp.get("payTo")?.trim() || sp.get("pay_to")?.trim() || undefined;
    const amountRaw = sp.get("amount")?.trim();
    const amountUsd = amountRaw ? Number(amountRaw.replace(/^\$/, "")) : undefined;
    const notCharged = paid ? { note: "Not charged." } : {};
    const bad = (detail: string) => ({ ok: false as const, status: 400, error: { error: "invalid_query", detail, example: `${base}/v1/verdict?url=https://api.example.com/v1/data`, ...notCharged } });
    if (!raw) return bad("url is required: the x402 resource URL (or the seller's domain) you are about to pay.");
    // A bare domain is accepted and checked as https://<domain>/ (domain-level evidence only).
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(raw)) raw = `https://${raw}`;
    const err = lookupError({ url: raw, ...(payTo ? { payTo } : {}) }, { url: true, payTo: payTo !== undefined }, "check");
    if (err) return { ok: false, status: 400, error: { ...err, ...notCharged } };
    if (amountRaw && !(amountUsd !== undefined && Number.isFinite(amountUsd) && amountUsd >= 0 && amountUsd < 1e6)) return bad("amount must be a USD number, e.g. 0.01.");
    let host = "";
    try { host = new URL(raw).hostname.toLowerCase(); } catch { return bad("url must be an absolute http(s) URL or a domain."); }
    const clean = originPath(raw) ?? raw;
    const network = sp.get("network")?.slice(0, 40) || undefined;
    const r = await checkVerdict({ url: clean, payTo, amountUsd, network }, base, false);
    const { verdict: check, exact, dom, tests, lab, gate, relationship } = r;
    if (check?.verdict === "block" && check?.reasons?.[0]?.code === "sanctioned_address") {
      const hit = sanctions.check(payTo) ?? sanctions.checkAny(((exact?.catalog?.entries?.[0]?.pay_to ?? dom?.catalog?.entries?.[0]?.pay_to ?? []) as any[]).map((p) => String(p?.pay_to ?? "")));
      if (hit) sanctions.refuse("verdict", hit, { url_host: host });
    }
    const t = now();
    const link = `${base}/trust/v/${encodeURIComponent(host)}`;
    const score = scoreView(await liveScore(host), check.matched?.tier);
    // Identical to what GET /v1/check signs for this query at this moment (paid: false: the check itself is free).
    const checkBody = checkPayload({ query: { url: clean, payTo, amountUsd, network }, verdict: check, score, link, paid: false });
    const key = await signKey();
    const checkReceipt = await signResponse("lumi_check", checkBody, key, t, CHECK_SIGNED_TTL_SEC);
    // Observed on-chain payments: keys are the host and the payTos Lumi has on record (never the quoted payTo). Display only.
    const recorded = recordedPayTos(exact, dom);
    const act = activityPublic(await activity.lookup(host, recorded), t, verdictTh);
    // Seller replies: a re-test request's reply text (email / contact form, entered by the owner) and verified curated-vendor replies.
    const curatedId = [...(exact?.curated ?? []), ...(dom?.curated ?? [])][0]?.id as string | undefined;
    const [appeal, vendorReplies] = await Promise.all([
      reviewStore.appealFor(host).catch(() => null),
      curatedId ? trust.vendorReplies(curatedId).catch(() => []) : Promise.resolve([]),
    ]);
    const replies = [
      ...(appeal?.reply ? [{ replied_at: new Date(appeal.opened_at).toISOString(), via: appeal.source, text: appeal.reply }] : []),
      ...vendorReplies.slice(0, 3).map((x: any) => ({ replied_at: new Date(x.ts).toISOString(), via: x.via, text: x.text })),
    ];
    const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);
    const reasonCodes = (check.reasons ?? []).filter((x: any) => x.severity !== "info" || ["not_observed", "not_quote_checked", "lumi_itself"].includes(x.code)).map((x: any) => String(x.code));
    const payload = {
      label: lab.label,
      label_text: LABELS[lab.label],
      reason: lab.reason,
      reason_code: lab.reason_code,
      reason_codes: reasonCodes,
      as_of: day(new Date(t).toISOString()),
      evidence_window: { from: day(tests.window_from), to: day(tests.window_to), test_buy_rule_days: FAILED_RULE.windowDays },
      n_conclusive: tests.conclusive,
      last_delivered_at: tests.last_delivered_at,
      last_failed_at: tests.last_failed_at,
      review: gate.review ? { state: gate.review.state } : null,
      retest: gate.retest,
      seller_replies: replies,
      score: score.value,
      score_status: score.status,
      observed_onchain_payments: act,
      free_checks: check.free_checks ?? null,
      relationship,
      commercial_relationship: check.commercial_relationship ?? [],
      check: { decision: checkBody.decision, label: checkBody.label, reasons: checkBody.reasons, matched: checkBody.matched ?? null },
      subject: { url: clean, host },
      evidence: link,
      reply_url: DISPUTE_URL,
      appeal: { url: DISPUTE_URL, email: CONTACT_EMAIL, api: `${base}/v1/trust/replies`, note: "Sellers can reply or ask for a re-test at any time. A re-test request pauses checks_failed for up to 72 hours while Lumi re-buys, and the reply is shown here." },
      definition: DEFINITION,
      rules_version: VERDICT_RULES_VERSION,
      rules: `${base}/v1/verdict/rules`,
      paid,
    };
    const receipt = await signResponse(VERDICT_KIND, payload, key, t, CHECK_SIGNED_TTL_SEC);
    const body = {
      kind: VERDICT_KIND, ...payload, receipt,
      check_receipt: { ...checkBody, receipt: checkReceipt },
      note: "Same data, label and signing key as the free GET /v1/check. Paying for this, or paying Lumi for monitoring or reports, never changes a score, tier, ranking, label or 'Tested by Lumi' result. Observed on-chain payments are information only (ranges; no payer addresses, no seller income).",
    };
    // Paid verdict only (after payment): the one-word version of the live check. label stays the signed record-based label;
    // label_live is the same word after the live comparison (a safety change turns checks_passed / no_data into check_first).
    const live = async () => {
      const r = await liveCheck(clean, host, exact, dom, { url: clean, payTo, amountUsd, network });
      const lv = r.live as any;
      const word = lv?.safety_change && lab.label !== "checks_failed" ? "check_first" : lab.label;
      return { label_live: word, live: { outcome: lv?.outcome, safety_change: !!lv?.safety_change, changes: lv?.changes ?? [], checked_at: lv?.checked_at }, live_evidence: r.live_evidence };
    };
    return { ok: true, body, t, onServed: () => prioritySignal(check, exact, "verdict"), live };
  }

  async function prepareVerdict(qs: string, base: string): Promise<Prepared> {
    try {
      const r = await buildVerdict(qs, base, true);
      if (!r.ok) return r;
      const meta = metaFrom(r.t, r.t + 86_400_000, r.t + 30 * 60_000, r.t);
      return { ok: true, route: "verdict", body: isoTimestamps(withMeta(r.body, meta)), onServed: r.onServed, enrich: r.live };
    } catch {
      return notForSale("data_unavailable", "the trust catalog is unavailable right now", 60, null);
    }
  }

  /**
   * GET /v1/trust/receipts?seller=<domain | resource URL | payTo>: Lumi's own test-buys of one seller, newest first, each with
   * its signed receipt when Lumi holds one (counterparty_delivery_receipt, verifiable free at /v1/trust/receipts/verify).
   * Read-only: the same purchase rows a full lookup returns. 400 / 404 / 503 happen before any payment (never charged).
   */
  async function prepareReceipts(qs: string, base: string): Promise<Prepared> {
    const sp = new URLSearchParams(qs);
    const raw = (sp.get("seller") ?? sp.get("domain") ?? sp.get("url") ?? sp.get("payTo") ?? sp.get("pay_to") ?? "").trim();
    const bad = (detail: string) => ({ ok: false as const, status: 400, error: { error: "invalid_query", detail, example: `${base}/v1/trust/receipts?seller=api.example.com`, note: "Not charged." } });
    if (!raw) return bad("seller is required: a domain (api.example.com), an x402 resource URL or a payTo address.");
    let q: LookupQuery;
    if (/^(0x[0-9a-fA-F]{40}|r[1-9A-HJ-NP-Za-km-z]{24,34}|G[A-Z2-7]{55})$/.test(raw)) q = { payTo: raw } as LookupQuery;
    else {
      let host = "";
      try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase(); } catch { /* invalid */ }
      if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return bad("seller must be a domain, an absolute http(s) URL or a payTo address.");
      q = { domain: host } as LookupQuery;
    }
    const err = lookupError(q, {}, "lookup");
    if (err) return { ok: false, status: 400, error: { ...err, note: "Not charged." } };
    try {
      const doc = (await trust.lookup(q, base)) as any;
      const rows: any[] = [];
      for (const e of [...(doc?.catalog?.entries ?? []), ...(doc?.curated ?? [])]) {
        for (const b of (Array.isArray(e?.purchases) ? e.purchases : []) as any[]) {
          if (!b?.tx_hash) continue;
          rows.push({
            at: b.at ?? null, endpoint: b.endpoint ?? e.resource ?? null, network: b.network ?? null, amount: b.amount ?? null, asset: b.asset ?? null,
            tx_hash: b.tx_hash, explorer: b.explorer ?? null, http_status: b.http_status ?? null, delivery: b.delivery ?? null,
            ...(b.inconclusive_reason ? { inconclusive_reason: b.inconclusive_reason } : {}),
            ...(b.corrected_at ? { corrected_at: b.corrected_at, corrections: b.corrections } : {}),
            receipt: b.receipt ?? null,
          });
        }
      }
      const seen = new Set<string>();
      const receipts = rows.filter((r) => (seen.has(r.tx_hash) ? false : (seen.add(r.tx_hash), true)))
        .sort((a, b) => (Date.parse(b.at ?? "") || 0) - (Date.parse(a.at ?? "") || 0)).slice(0, RECEIPTS_MAX);
      if (!receipts.length) {
        return { ok: false, status: 404, error: { error: "not_found", detail: "Lumi has no test-buy of this seller yet. No test-buy is not a negative finding.", free_check: q.domain ? `${base}/v1/check?url=${encodeURIComponent(`https://${q.domain}/`)}` : `${base}/v1/trust/vendors?payTo=${encodeURIComponent(raw)}`, note: "Not charged." } };
      }
      const t = now();
      const count = (d: string) => receipts.filter((r) => r.delivery === d).length;
      const payload = {
        query: { seller: raw },
        count: receipts.length,
        delivered: count("delivered"),
        not_delivered: count("not_delivered"),
        inconclusive: receipts.length - count("delivered") - count("not_delivered"),
        receipts: receipts.map(({ receipt, ...r }) => ({ ...r, receipt_hash: receipt?.receipt_hash ?? null })),
      };
      const signed = await signResponse("lumi_seller_receipts", payload, await signKey(), t, CHECK_SIGNED_TTL_SEC);
      const body = {
        kind: "lumi_seller_receipts", ...payload,
        signed_receipts: receipts.filter((r) => r.receipt).map((r) => r.receipt),
        lumi_receipt: signed,
        verify: `${base}/v1/trust/receipts/verify`,
        wallets: `${base}/v1/check/wallets`,
        note: "Lumi's own test-buys only: Lumi paid the seller and recorded whether data came back. Paying for this never changes a score, label or 'Tested by Lumi' result. Observations, not a guarantee.",
      };
      const meta = metaFrom(t, t + 86_400_000, t + 30 * 60_000, t);
      return { ok: true, route: "receipts", body: isoTimestamps(withMeta(body as Record<string, unknown>, meta)) };
    } catch {
      return notForSale("data_unavailable", "the trust catalog is unavailable right now", 60, null);
    }
  }

  /**
   * GET /v1/check/batch?urls=<u1>,<u2>,...: up to BATCH_MAX record-based labels in one signed answer, from the same check core as
   * the free /v1/check (same lookup, same review gate, same label). No live contact with the sellers. Bad input is a 400 before
   * any quote is paid (never charged).
   */
  async function prepareBatch(qs: string, base: string): Promise<Prepared> {
    const sp = new URLSearchParams(qs);
    const list = [...sp.getAll("urls"), ...sp.getAll("url")].flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
    const bad = (detail: string) => ({ ok: false as const, status: 400, error: { error: "invalid_query", detail, example: `${base}/v1/check/batch?urls=https://api.example.com/v1/data,data.example.org`, note: "Not charged." } });
    if (!list.length) return bad(`urls is required: 1 to ${BATCH_MAX} comma-separated x402 resource URLs or seller domains.`);
    const uniq = [...new Set(list)];
    if (uniq.length > BATCH_MAX) return bad(`At most ${BATCH_MAX} URLs or domains per call (got ${uniq.length}).`);
    const items: { input: string; url: string; host: string }[] = [];
    for (const x of uniq) {
      const raw = !/^[a-z][a-z0-9+.-]*:\/\//i.test(x) && /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(x) ? `https://${x}` : x;
      if (lookupError({ url: raw }, { url: true }, "check")) return bad(`Not an absolute http(s) URL or a domain: ${x.slice(0, 200)}`);
      let host = "";
      try { host = new URL(raw).hostname.toLowerCase(); } catch { return bad(`Not an absolute http(s) URL or a domain: ${x.slice(0, 200)}`); }
      items.push({ input: x, url: originPath(raw) ?? raw, host });
    }
    try {
      const results: Record<string, unknown>[] = [];
      for (const it of items) {
        const r = await checkVerdict({ url: it.url }, base, false);
        const { verdict: check, tests, lab } = r;
        if (check?.verdict === "block" && check?.reasons?.[0]?.code === "sanctioned_address") {
          const hit = sanctions.checkAny(((r.exact?.catalog?.entries?.[0]?.pay_to ?? r.dom?.catalog?.entries?.[0]?.pay_to ?? []) as any[]).map((p) => String(p?.pay_to ?? "")));
          if (hit) sanctions.refuse("batch_check", hit, { url_host: it.host });
        }
        results.push({
          input: it.input,
          url: it.url,
          host: it.host,
          label: lab.label,
          label_text: LABELS[lab.label],
          reason_code: lab.reason_code,
          reason_codes: (check.reasons ?? []).filter((x: any) => x.severity !== "info" || ["not_observed", "not_quote_checked", "lumi_itself"].includes(x.code)).map((x: any) => String(x.code)),
          decision: String(check.verdict),
          n_conclusive: tests.conclusive,
          last_delivered_at: tests.last_delivered_at,
          last_failed_at: tests.last_failed_at,
          evidence: `${base}/trust/v/${encodeURIComponent(it.host)}`,
        });
      }
      const t = now();
      const payload = { as_of: new Date(t).toISOString().slice(0, 10), count: results.length, results, rules_version: VERDICT_RULES_VERSION, rules: `${base}/v1/verdict/rules` };
      const signed = await signResponse("lumi_batch_check", payload, await signKey(), t, CHECK_SIGNED_TTL_SEC);
      const body = {
        kind: "lumi_batch_check", ...payload, receipt: signed,
        note: "Same check core, labels and signing key as the free GET /v1/check, from Lumi's record (no live contact with the sellers; GET /v1/verdict adds the live check for one URL). Paying for this never changes a score, label or 'Tested by Lumi' result. Observations, not a guarantee.",
      };
      const meta = metaFrom(t, t + 86_400_000, t + 30 * 60_000, t);
      return { ok: true, route: "batch_check", body: isoTimestamps(withMeta(body as Record<string, unknown>, meta)) };
    } catch {
      return notForSale("data_unavailable", "the trust catalog is unavailable right now", 60, null);
    }
  }

  /** Free alias (VERDICT_PRICING = "free", the default): same body, same free limit as /v1/check, no 402. */
  async function freeVerdict(request: Request, url: URL, base: string, ctx?: WaitUntil): Promise<Response> {
    const noStore = { "Cache-Control": "no-store" };
    const limit = await trust.freeLimit(request, "lookup");
    if (limit) {
      const sp = url.searchParams;
      const amt = Number((sp.get("amount") ?? "").replace(/^\$/, ""));
      return withSafety(limit, await safetyFindings({ url: sp.get("url")?.trim() || undefined, payTo: sp.get("payTo")?.trim() || sp.get("pay_to")?.trim() || undefined, amountUsd: sp.get("amount") && Number.isFinite(amt) ? amt : undefined }, base));
    }
    try {
      const r = await buildVerdict(url.search, base, false);
      if (!r.ok) return json(r.status, r.error, noStore);
      const p = r.onServed().catch((e) => { deps.log?.({ event: "buy_queue_error", source: "verdict", error: String(e) }); return null; });
      if (ctx) ctx.waitUntil(p); else await p;
      return json(200, isoTimestamps(r.body), noStore);
    } catch {
      return json(503, { error: "data_unavailable", detail: "the trust catalog is unavailable right now", retry_after_s: 60 }, { ...noStore, "Retry-After": "60" });
    }
  }

  /**
   * Test-buy priority signal: ONE path for paid and free checks. A never-test-bought Base seller with an objective signal
   * (BUY_SIGNALS) moves to the front of the next day's Base test-buy list, within the abuse limits in catalog.queueBuy (one
   * slot per seller per PRIORITY_SELLER_DAYS = 30 days, TRUST_PRIORITY_DAILY_CAP sellers per day). `source` is only logged; it never changes the outcome.
   */
  async function prioritySignal(body: Record<string, unknown>, exact: unknown, source: string) {
    // A failed test-buy below the checks_failed bar asks for a confirming re-buy (at most once per seller per 24 h).
    if ((body as any)?.confirm_rebuy) await confirmRebuy(exact, "confirm_rebuy", source);
    const cand = buyCandidate(body as any, exact, now());
    if (!cand) return null;
    const r = await catalog.queueBuy(cand);
    deps.log?.({ event: "buy_priority", source, resource: cand.resource, ...r });
    return r;
  }

  /** Queue a confirming / re-test buy of the catalog entry in a lookup doc (Base only; once per seller per 24 h). */
  async function confirmRebuy(doc: unknown, why: string, source: string) {
    const e = (doc as any)?.catalog?.entries?.[0];
    if (!e?.resource) return { queued: false, reason: "no_catalog_entry" };
    const nets: string[] = (e.pay_to ?? []).map((p: any) => String(p.network));
    const r = await catalog.queueConfirmBuy({ resource: String(e.resource), network: nets.includes("eip155:8453") ? "eip155:8453" : nets[0] ?? null, price_usd: Number(e.listed_price_usd) || null, why });
    deps.log?.({ event: "confirm_rebuy", source, resource: e.resource, ...r });
    return r;
  }

  /** Free check surfaces (lookup by URL; scanner-kit's /v1/check): build the verdict server-side and send the same signal. */
  async function checkSignal(input: { url: string; payTo?: string }, base: string, source: string) {
    try {
      const { verdict: body, exact } = await checkVerdict(input, base, false);
      return await prioritySignal(body, exact, source);
    } catch (e) {
      deps.log?.({ event: "buy_queue_error", source, error: String(e) });
      return null;
    }
  }

  /** Paid vendor report: unknown vendor -> 404, no observation in 48 h -> 503; both before any 402 and never charged. */
  async function prepareVendorReport(id: string, base: string): Promise<Prepared> {
    const r = await trust.vendorReport(id.trim().toLowerCase(), base);
    if (r.ok) {
      // Observed on-chain payments (ranges only, information only; null when Lumi has no row for this vendor).
      const v = vendorById(id.trim().toLowerCase());
      let act: unknown = null;
      if (v) { try { act = activityPublic(await activity.lookup(new URL(v.homepage).hostname, [...v.pay_to.xrpl, ...(v.pay_to.evm ?? [])]), now(), verdictTh); } catch { act = null; } }
      return hasContent("vendor_report", r.doc)
        ? { ok: true, route: "vendor_report", body: isoTimestamps(withMeta({ kind: "vendor_report", timestamp: new Date(now()).toISOString(), source: "api.lumitrades.io seller trust checks", ...r.doc, observed_onchain_payments: act, disclaimer: TRUST_DISCLAIMER }, vendorMeta(r.doc))) }
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
          : path === "/.well-known/trustline-merchant.txt"
          ? { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Max-Age": "86400" }
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
    // Retired 2026-10-25: trade-idea, reading, levels and coin-list routes. 410 Gone before any paywall, template check or
    // payment-header handling, so they never quote, never verify and never settle (any method, any payment header).
    if (isRetiredPath(path)) {
      deps.log?.({ event: "retired_route", path: path.slice(0, 80) });
      return retiredResponse(path, base, { "Access-Control-Allow-Origin": "*" });
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
      if (path === "/v1/check") return freeCheck(request, url, base, ctx);
      if (path === "/v1/verdict/rules") return json(200, { kind: "lumi_verdict_rules", pricing: verdictIsPaid ? "paid" : "free", ...thresholdsDoc(verdictTh) }, { "Cache-Control": "public, max-age=3600" });
      // VERDICT_PRICING = "free" (default): a free alias of /v1/check with the shared label. "paid": falls through to x402.
      if (path === "/v1/verdict" && !verdictIsPaid) return freeVerdict(request, url, base, ctx);
      if (path === "/v1/check/wallets" || path === "/.well-known/lumi-test-buy-wallets.json") return json(200, testBuyWalletsDoc(base, { xrpl: xrplBuyers, evm: evmBuyers, stellar: stellarBuyers }), { "Cache-Control": "public, max-age=3600" });
      if (path === "/v1/check/keys" || path === "/.well-known/lumi-keys.json") return json(200, keysDoc(await signKey(), base, { secretReused }), { "Cache-Control": "public, max-age=3600" });
      if (path === "/v1/badge") return json(200, badgeDocs(base, badgeThresholds(env)), { "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" });
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
      const r = await trust.handle(request, path, base, ctx);
      if (r) return r;
    }
    // Lumi Check v0 (DRAFT, not deployed): contributor-signed receipts + owner key management.
    if (path.startsWith("/v1/contrib/") || path === "/v1/owner/contributors" || path.startsWith("/v1/owner/contributors/")) {
      const r = await contributors.handle(request, path);
      if (r) return r;
    }
    // Owner-only (Authorization: Bearer <OWNER_MCP_KEY>): observed on-chain payments ingest / read, checks_failed review queue.
    if (path === "/v1/owner/probe-checked") {
      const noStore = { "Cache-Control": "no-store" };
      if (!(await ownerReq(request))) return json(401, { error: "owner_key_required", hint: "Authorization: Bearer <OWNER_MCP_KEY>" }, { ...noStore, "WWW-Authenticate": "Bearer" });
      if (request.method === "GET") {
        const s = url.searchParams.get("seller")?.trim().toLowerCase().slice(0, 253);
        return json(200, s ? { row: await probeStore.get(s) } : { rows: await probeStore.count() }, noStore);
      }
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "GET, POST" });
      const text = await request.text().catch(() => "");
      if (text.length > 2_000_000) return json(413, { error: "body_too_large", max_bytes: 2_000_000 }, noStore);
      let body: any = null; try { body = JSON.parse(text); } catch { /* invalid */ }
      const rows = Array.isArray(body?.rows) ? body.rows : null;
      if (!rows) return json(400, { error: "rows_required" }, noStore);
      if (rows.length > PROBE_MAX_ROWS_PER_LOAD) return json(400, { error: "too_many_rows", max: PROBE_MAX_ROWS_PER_LOAD }, noStore);
      const ok: any[] = []; let skippedSelf = 0; const rejected: { index: number; error: string }[] = [];
      rows.forEach((x: any, i: number) => { const r = parseProbeRow(x); if (typeof r === "string") rejected.push({ index: i, error: r }); else if (r.seller !== "lumitrades.io") ok.push(r); else skippedSelf++; });
      const written = await probeStore.put(ok);
      return json(200, { ok: true, received: rows.length, valid: ok.length, skipped_self: skippedSelf, written, rejected: rejected.slice(0, 50) }, noStore);
    }
    if (path === "/v1/owner/activity" || path === "/v1/owner/reviews") {
      const noStore = { "Cache-Control": "no-store" };
      if (!(await ownerReq(request))) return json(401, { error: "owner_key_required", hint: "Authorization: Bearer <OWNER_MCP_KEY>" }, { ...noStore, "WWW-Authenticate": "Bearer" });
      const readBody = async (max: number) => {
        const text = await request.text().catch(() => "");
        if (text.length > max) return { tooLarge: true as const };
        try { return { body: JSON.parse(text) as any }; } catch { return { body: null }; }
      };
      if (path === "/v1/owner/activity") {
        if (request.method === "POST") {
          const b = await readBody(2_000_000);
          if ("tooLarge" in b) return json(413, { error: "body_too_large", max_bytes: 2_000_000 }, noStore);
          const r = await activity.ingest(b.body);
          return "error" in r ? json(400, r, noStore) : json(200, { ok: true, ...r }, noStore);
        }
        if (request.method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET, POST" });
        const seller = url.searchParams.get("seller")?.trim().slice(0, 200);
        const host = url.searchParams.get("host")?.trim().toLowerCase().slice(0, 253);
        const row = seller ? await activity.store.get(seller) : host ? await activity.lookup(host, []) : null;
        if (seller || host) return row ? json(200, activityOwnerView(row, now(), verdictTh), noStore) : json(404, { error: "not_found" }, noStore);
        return json(200, { rows: await activity.store.count(), thresholds: { min_payer_groups: verdictTh.activityMinPayerGroups, max_age_days: verdictTh.activityMaxAgeDays, concentration_pct: verdictTh.concentrationPct } }, noStore);
      }
      if (request.method === "GET") {
        const state = url.searchParams.get("state") ?? "pending";
        if (!["pending", "approved", "rejected", "all"].includes(state)) return json(400, { error: "invalid_state", allowed: ["pending", "approved", "rejected", "all"] }, noStore);
        return json(200, { reviews: await reviewStore.list(state, 200), appeals: await reviewStore.appeals(50) }, noStore);
      }
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "GET, POST" });
      const b = await readBody(8_000);
      if ("tooLarge" in b) return json(413, { error: "body_too_large", max_bytes: 8_000 }, noStore);
      const x = b.body ?? {};
      const host = typeof x.host === "string" ? x.host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").slice(0, 253) : "";
      if (!host) return json(400, { error: "host_required" }, noStore);
      const t = now();
      if (x.action === "approve" || x.action === "reject") {
        if (typeof x.evidence !== "string" || !x.evidence) return json(400, { error: "evidence_required", hint: "the evidence key from GET /v1/owner/reviews" }, noStore);
        const ok = await reviewStore.decide(host, x.evidence, x.action === "approve" ? "approved" : "rejected", typeof x.note === "string" ? x.note.slice(0, 500) : null, t);
        return ok ? json(200, { ok: true, host, evidence: x.evidence, state: x.action === "approve" ? "approved" : "rejected" }, noStore) : json(404, { error: "review_not_found" }, noStore);
      }
      if (x.action === "appeal") {
        // Re-test request: pause checks_failed for 72 h, show "re-test requested" and the seller's reply, and re-buy.
        const reply = typeof x.reply === "string" && x.reply.trim() ? x.reply.trim().slice(0, 1000) : null;
        const source = typeof x.source === "string" ? x.source.slice(0, 40) : "email";
        await reviewStore.openAppeal({ host, opened_at: t, until_at: appealUntil(t), source, reply, rebuy: null });
        let rebuy: { queued: boolean; reason: string } = { queued: false, reason: "no_catalog_entry" };
        try {
          const target = typeof x.url === "string" && x.url ? x.url : `https://${host}/`;
          const doc = await trust.lookup(typeof x.url === "string" && x.url ? { url: target } : { domain: host }, base);
          rebuy = await confirmRebuy(doc, "retest_requested", "appeal");
        } catch (e) { deps.log?.({ event: "confirm_rebuy_error", error: String(e) }); }
        await reviewStore.setRebuy(host, rebuy.queued ? "queued" : rebuy.reason);
        return json(200, { ok: true, host, paused_until: new Date(appealUntil(t)).toISOString(), rebuy }, noStore);
      }
      return json(400, { error: "invalid_action", allowed: ["approve", "reject", "appeal"] }, noStore);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(405, { error: "method_not_allowed" }, { Allow: "GET, HEAD, OPTIONS" });
    }
    // Owner-only private traffic summary (Authorization: Bearer <OWNER_MCP_KEY>): hashed IPs only.
    if (path === "/v1/owner/traffic") {
      const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1]?.trim();
      if (!bearer || !(await isOwnerKey(bearer, env.OWNER_MCP_KEY))) {
        return json(401, { error: "owner_key_required", hint: "Authorization: Bearer <OWNER_MCP_KEY>" }, { "Cache-Control": "no-store", "WWW-Authenticate": "Bearer" });
      }
      const days = Number(url.searchParams.get("days") ?? "7");
      return json(200, { ...(await trafficSummary(traffic, now(), days, sales)), logging: trafficOn }, { "Cache-Control": "no-store" });
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
      const refusedTx = (await commerceStore.packRefusals(500).catch(() => [])).map((r) => r.paid_tx);
      const summary = await salesSummary(sales, now(), {
        refusedTx,
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
      case "/.well-known/security.txt":
        return new Response(API_SECURITY_TXT, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
      case "/.well-known/trustline-merchant.txt":
        // t54 Trustline merchant file (t54 / XRPL AI Hub convention): one `xrpl:<r-address>` line per receiving wallet.
        // Plain text, no signature. Mainnet only: a testnet deployment has no Hub listing to bind.
        if (config.network !== "xrpl:0") return json(404, { error: "not_found" });
        return new Response(trustlineMerchantTxt(config), {
          headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
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
    }

    // ---------------- paid
    const vr = path.match(/^\/v1\/trust\/vendors\/([^/]{1,64})\/report$/);
    const m = vr ? [path, "vendor_report", vr[1]] : (FIXED[path] ? [path, FIXED[path]] : null);
    if (!m) return json(404, { error: "not_found", hint: `See ${base}/ for the endpoint list.` });
    const route = m[1] as PaidRoute;

    // An unfilled path template (/v1/trust/vendors/%7Bid%7D/report, /v1/trust/vendors/:id/report, ...):
    // - the literal OpenAPI template ({coin} / {id}) without a payment header: the normal 402 price quote for the route (same
    //   accepts/prices/payTo as a concrete value), because discovery crawlers (x402scan / @agentcash/discovery, Bazaar) request
    //   the template URL verbatim and only list routes that answer 402; the quote carries a note to fill the placeholder;
    // - any other placeholder style (:coin, <coin>, ${coin}, ...), or any template with a payment header: 400, never charged.
    const rawArg = m[2] !== undefined ? safeDecode(m[2]) : undefined;
    // A person opening a vendor report link in a browser (Accept ranks text/html first, GET, no payment header): a small page
    // explaining the $0.02 x402 call, with links to the free summary and the docs. Agents (JSON or */* Accept) still get the 402.
    if (route === "vendor_report" && request.method === "GET" && rawArg !== undefined && !PATH_TEMPLATE_RE.test(rawArg)
      && prefersHtml(request.headers.get("accept")) && !(request.headers.get(HEADER_PAYMENT_SIGNATURE) || request.headers.get(HEADER_X_PAYMENT))) {
      const v = VENDORS.find((x) => x.id === rawArg.toLowerCase()) ?? null;
      return new Response(vendorReportHtml(config, base, v?.id ?? rawArg.slice(0, 64), v?.name ?? null), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300", Vary: "Accept", "X-Robots-Tag": "noindex" },
      });
    }
    if (rawArg !== undefined && PATH_TEMPLATE_RE.test(rawArg)) {
      const isReport = route === "vendor_report";
      const example = isReport ? `${base}/v1/trust/vendors/<vendor-id>/report` : `${base}/v1/${route}/xrp`;
      const hasPayment = !!(request.headers.get(HEADER_PAYMENT_SIGNATURE) || request.headers.get(HEADER_X_PAYMENT));
      if (!hasPayment && rawArg === (isReport ? "{id}" : "{coin}")) {
        const endpoint = endpointFor(route);
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
          bazaar: bazaarExtension(route, isReport ? "example-vendor" : "xrp", undefined, config.evm?.prices[route]),
          service: serviceMeta(route),
          note: `Replace ${rawArg} with ${isReport ? "a vendor id from GET /v1/trust/vendors (free)" : "a real value"} and request that URL for a fresh quote before paying: ${example}. A payment sent to this placeholder URL is refused and not charged.`,
        }, "PAYMENT-SIGNATURE header is required");
      }
      return json(400, {
        error: "path_template_not_filled",
        detail: `Replace ${rawArg} with a real value. ${isReport ? "Vendor ids: GET /v1/trust/vendors (free)." : "See /openapi.json."}`,
        example,
        openapi: `${base}/openapi.json`,
        note: "Not charged.",
      });
    }

    // /v1/trust/check probed bare (no query string at all, as x402scan and other discovery crawlers do): the normal 402 price
    // quote, so the paywall is visible. A query without a usable url, or any request with a payment header and no url, is
    // refused below (400, nothing verified or settled).
    if (QUERY_ROUTES.includes(route) && !url.search.replace(/^\?/, "") && !(request.headers.get(HEADER_PAYMENT_SIGNATURE) || request.headers.get(HEADER_X_PAYMENT))) {
      const endpoint = endpointFor(route);
      const usd = config.evm?.prices[route] ?? config.ious.find((o) => o.symbol === "RLUSD")?.prices[route];
      const example = route === "verdict" ? `${base}/v1/verdict?url=https://api.example.com/v1/data`
        : route === "receipts" ? `${base}/v1/trust/receipts?seller=api.example.com`
        : route === "batch_check" ? `${base}/v1/check/batch?urls=https://api.example.com/v1/data,data.example.org`
        : `${base}/v1/trust/check?url=https://api.example.com/v1/data&payTo=0x...&amount=0.01`;
      const probeQuery: Record<string, string> = route === "receipts" ? { seller: "api.example.com" } : route === "batch_check" ? { urls: "https://api.example.com/v1/data,data.example.org" } : { url: "https://api.example.com/v1/data" };
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
        bazaar: bazaarExtension(route, undefined, probeQuery, usd),
        service: serviceMeta(route),
        note: route === "receipts"
          ? `Add ?seller=<domain, resource URL or payTo> and request that URL for a fresh quote before paying: ${example}. A payment sent without seller is refused and not charged.`
          : route === "batch_check"
          ? `Add ?urls=<1 to ${BATCH_MAX} comma-separated resource URLs or domains> and request that URL for a fresh quote before paying: ${example}. A payment sent without urls is refused and not charged.`
          : `Add ?url=<the x402 resource URL you are about to pay> (optional payTo, amount) and request that URL for a fresh quote before paying: ${example}. A payment sent without url is refused and not charged.`,
      }, "PAYMENT-SIGNATURE header is required");
    }

    const prep = await prepare(route, QUERY_ROUTES.includes(route) ? url.search : m[2], base);
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
    const endpoint = endpointFor(route);
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
        QUERY_ROUTES.includes(route) ? Object.fromEntries(url.searchParams) : undefined,
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
          if (prep.onServed) {
            // A free trial trust/check sends exactly the same priority signal as a paid one.
            const p = prep.onServed().catch((e) => deps.log?.({ event: "buy_queue_error", error: String(e) }));
            if (ctx) ctx.waitUntil(p); else await p;
          }
          const access = { mode: "trial", charged: false, wallet: r.wallet, trial_calls_used: r.used, trial_calls_remaining: Math.max(0, TRIAL_LIMITS.perWallet - r.used) };
          const extra = prep.enrich ? await prep.enrich().catch((e) => ({ live: null, live_error: String((e as Error)?.message ?? e) })) : {};
          return json(200, { ...body, ...extra, access }, { "Cache-Control": "no-store" });
        }
        quote.trial = { granted: false, reason: r.reason, detail: "Free trial not granted for this request; pay with any accepts[] option instead. Not charged." };
      }
    }

    return requirePayment(request, config, paywallDeps(ctx), quote, async (s: Settlement, paid: PaymentRequirements) => {
      const extra = prep.enrich ? await prep.enrich().catch((e) => ({ live: null, live_error: String((e as Error)?.message ?? e) })) : {};
      if (prep.onServed) {
        // Demand-driven test-buys: a served trust/check only queues the resource for the daily routine (caps apply there).
        const p = prep.onServed().catch((e) => deps.log?.({ event: "buy_queue_error", error: String(e) }));
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
      return json(200, { ...body, ...extra, payment });
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
        .then((row) => trafficBuf.add(ctx && row.paid && paidByCtx.get(ctx) ? { ...row, paid_test: true } : row, now()))
        .catch(trafficErr);
      if (ctx) ctx.waitUntil(p);
    },
    flushTraffic: () => Promise.all([trafficBuf.flush().catch(trafficErr), outcomes.flush().catch(() => 0)]).then(() => undefined),
    live,
    feeds,
    async liveRefresh() {
      // Market feeds (funding, Fear & Greed) and per-coin readings were retired on 2026-10-25 (see src/retired.ts):
      // the per-minute tick does no external fetch any more.
      const r = { skipped: "market_feeds_retired", retired_on: RETIRED_ON };
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
        // Retired routes answer 410 before any payment-header check, pricing or D1 work (see handle()).
        {
          const u = new URL(request.url);
          const rp = u.pathname.replace(/\/+$/, "") || "/";
          if (request.method !== "OPTIONS" && isRetiredPath(rp)) return retiredResponse(rp, config.publicBaseUrl ?? u.origin, { "Access-Control-Allow-Origin": "*" });
        }
        // Oversize payment headers (PAYMENT-SIGNATURE, X-PAYMENT, SIGN-IN-WITH-X) are refused before any decoding, pricing or D1 work.
        const tooLarge = oversizePaymentHeader(request);
        if (tooLarge) return tooLarge;
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
  const paths = ["/", "/llms.txt", "/skill.md", "/openapi.json", "/.well-known/x402", "/.well-known/agent-card.json", "/.well-known/mcp/server-card.json", "/.well-known/agents.json", "/v1/samples", "/v1/check", "/v1/trust/vendors", "/v1/trust/methodology", "/v1/trust/catalog", "/v1/badge", "/v1/monitor", "/v1/monitor/sellers", "/v1/monitor/corrections", "/v1/feed", "/v1/feed/license"];
  const day = new Date().toISOString().slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    paths.map((p) => `  <url><loc>${base}${p}</loc><lastmod>${day}</lastmod><changefreq>daily</changefreq></url>`).join("\n") +
    `\n</urlset>\n`;
}

