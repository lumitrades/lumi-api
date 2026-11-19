/**
 * Runtime configuration. Every value comes from the environment (wrangler.toml
 * [vars], `wrangler secret`, `.dev.vars`, or process.env when run under Node),
 * so the same code runs on Cloudflare Workers, `wrangler dev` and plain Node.
 */

import { CDP_FACILITATOR_URL, type CdpCredentials } from "./cdp";

export type XrplNetwork = "xrpl:0" | "xrpl:1" | "xrpl:2";

export interface Env {
  /** Optional KV namespace holding a fresher OFAC SDN address set (key "ofac_sdn_addresses", JSON from scripts/ofac_refresh.py). Unset = bundled snapshot only. */
  SANCTIONS_KV?: unknown;
  /** CAIP-2 XRPL network id: xrpl:0 mainnet, xrpl:1 testnet, xrpl:2 devnet. */
  XRPL_NETWORK?: string;
  /** Classic address that receives payments. */
  PAY_TO?: string;
  /** x402 facilitator base URL (verifies + settles the presigned Payment). */
  FACILITATOR_URL?: string;
  /** HMAC key for stateless invoice ids. Set with `wrangler secret put INVOICE_SECRET`. */
  INVOICE_SECRET?: string;
  /** XRPL SourceTag stamped on every payment to this API (on-ledger usage metrics). */
  SOURCE_TAG?: string;
  /** Per-product XRPL DestinationTag rollout: "" / unset = off, "all", or a comma list of product keys (routeKey prefixes). */
  XRPL_DEST_TAG_ROUTES?: string;
  /** SourceTag on quotes that carry a destinationTag: "none" (default, omit extra.sourceTag) or a uint32 to state explicitly. */
  XRPL_DEST_TAG_SOURCE_TAG?: string;
  /** Any PRICE_<ROUTE>_<XRP|RLUSD|USDC> override (decimal strings), e.g. PRICE_VERDICT_XRP. */
  [price: `PRICE_${string}`]: string | undefined;
  /** Accept RLUSD (Ripple USD, XRPL issued token) as a second asset. "false" disables. Default on. */
  ACCEPT_RLUSD?: string;
  /** RLUSD issuer override. Defaults to Ripple's official issuer for the network (docs.ripple.com). */
  RLUSD_ISSUER?: string;
  /** Accept Circle USDC (XRPL issued token) as a third asset. "false" disables. Default on. */
  ACCEPT_USDC?: string;
  /** USDC issuer override. Defaults to Circle's official issuer for the network (developers.circle.com). */
  USDC_ISSUER?: string;
  /** Where Lumi's published JSON lives. */
  DATA_BASE_URL?: string;
  /** Cache TTL for upstream data, seconds. */
  DATA_TTL_SECONDS?: string;
  /** Max age (hours) of published data before it counts as stale. Default 12. */
  DATA_MAX_AGE_HOURS?: string;
  /** Seconds a 402 quote (invoice) stays payable. */
  INVOICE_TTL_SECONDS?: string;
  /** Comma-separated private names to scrub from paid responses. Set with `wrangler secret put PRIVATE_NAMES`. */
  PRIVATE_NAMES?: string;
  /** Owner access key for the remote MCP endpoint (/mcp): paid tools return data free. `wrangler secret put OWNER_MCP_KEY`. */
  OWNER_MCP_KEY?: string;
  /** Fleet guard (src/fleet_guard.ts): exactly "on" enables /v1/fleet/*; anything else = off (routes not handled, not listed; owner /v1/fleet/admin/* still works). Committed in wrangler.toml [vars], default "off". */
  FLEET_GUARD?: string;
  /** Fleet guard keyed-HMAC secret (>= 32 chars) for payer / member / IP hashes. `wrangler secret put FLEET_GUARD_HMAC_SECRET`. Unset = 503, never charged. */
  FLEET_GUARD_HMAC_SECRET?: string;
  /** Previous fleet guard HMAC secret during a rotation (>= 32 chars). Lookups, overrides and deletions also match hashes made with it. Remove 90 days after rotating. */
  FLEET_GUARD_HMAC_SECRET_PREV?: string;
  /** Fleet guard pack/plan key-derivation secret (>= 32 chars, different from FLEET_GUARD_HMAC_SECRET). `wrangler secret put FLEET_GUARD_KEY_SECRET`. Unset = packs and plans 503, never charged. */
  FLEET_GUARD_KEY_SECRET?: string;
  /** Fleet guard flat monthly plan ($49 / 30 days, fair-use cap): exactly "on" offers it; default off (owner decision). */
  FLEET_GUARD_MONTHLY?: string;
  /** Lumi Check v0: ed25519 seed (64 hex) that signs check responses and badge verdicts. Not a wallet key and not an admin credential (must differ from CONTRIB_ADMIN_KEY / OWNER_MCP_KEY). Its PUBLIC key must be pinned in src/trust/lumi_keys.ts. Set at deploy time with `wrangler secret put LUMI_CHECK_SIGNING_KEY` (docs/lumi-check-keys.md). Unset = unsigned (signature null). */
  LUMI_CHECK_SIGNING_KEY?: string;
  /** Tested-by-Lumi badge thresholds. Defaults (approved): score 80 and 3 conclusive paid Lumi test-buys. */
  BADGE_MIN_SCORE?: string;
  BADGE_MIN_PAID_TESTS?: string;
  /** /v1/verdict pricing: "free" (alias of /v1/check) or "paid" (x402 at DEFAULT_PRICES.verdict, $0.01; owner approved 2026-10-25). Default VERDICT_PRICING below. */
  VERDICT_PRICING?: string;
  /** First high-value check refund offer (first-customer plan 2026-10-30): "on" announces it in the high-value 402 and enables
   *  the owner-only list GET /v1/owner/refunds/first-high-value. Default OFF. Nothing in the code ever sends money: the list
   *  is computed from the sales ledger and refunds are paid by hand by the operator. See docs/first-hv-refund.md. */
  FIRST_HV_REFUND?: string;
  /** Label thresholds (src/trust/verdict.ts VERDICT_DEFAULTS): checks_passed needs a delivered test-buy within N days (default 30);
   * observed on-chain payments: fewest payer groups shown (default 5, never lower), concentration flag at top-payer share >= N%
   * (default 60), rows older than N days are marked stale (default 14). */
  VERDICT_PAY_MAX_AGE_DAYS?: string;
  VERDICT_ACTIVITY_MIN_GROUPS?: string;
  VERDICT_CONCENTRATION_PCT?: string;
  /** Extra competitor domains (comma-separated) and Lumi-customer seller domains for the relationship disclosure (never a label input). */
  VERDICT_COMPETITOR_DOMAINS?: string;
  VERDICT_CUSTOMER_DOMAINS?: string;
  VERDICT_ACTIVITY_MAX_AGE_DAYS?: string;
  /** Lumi Check v0: separate admin credential for the owner contributor routes (/v1/owner/contributors*); never the signing key. Falls back to OWNER_MCP_KEY when unset. Set at deploy time with `wrangler secret put CONTRIB_ADMIN_KEY`. */
  CONTRIB_ADMIN_KEY?: string;
  /** Public base URL used in docs/discovery (e.g. https://api.lumitrades.io). */
  PUBLIC_BASE_URL?: string;
  /** EVM (Base) receiving address for USDC over x402 (address only, never a key). Unset = Base payments off. */
  EVM_PAY_TO?: string;
  /** CAIP-2 EVM network: eip155:8453 (Base mainnet, default) or eip155:84532 (Base Sepolia). */
  EVM_NETWORK?: string;
  /** x402 facilitator for the EVM option. Defaults: PayAI on Base mainnet, x402.org on Base Sepolia. */
  EVM_FACILITATOR_URL?: string;
  /** "false" disables the Base USDC option even when EVM_PAY_TO is set. Default on. */
  ACCEPT_BASE_USDC?: string;
  /** CDP secret API key id + Ed25519 secret (`wrangler secret put`). When both are set, Base verify/settle goes to the
   *  Coinbase CDP facilitator (x402 Bazaar indexing) and EVM_FACILITATOR_URL becomes the automatic fallback. */
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  /** "cdp" (default when the CDP key is set) or "fallback" to send Base payments straight to EVM_FACILITATOR_URL. */
  EVM_FACILITATOR?: string;
  /** Override for the CDP facilitator base URL (default https://api.cdp.coinbase.com/platform/v2/x402). */
  CDP_FACILITATOR_URL?: string;
  /** Paid routes whose Base payments settle ONLY through Coinbase CDP, never the keyless fallback (PayAI on mainnet).
   *  Comma-separated route names; default CDP_ONLY_ROUTES (every trust/verdict route); "none" turns the rule off (testnet). */
  EVM_CDP_ONLY_ROUTES?: string;
  /** Stellar (pubnet) receiving G-address for USDC over x402 (address only, never a key). Unset = Stellar payments off. */
  STELLAR_PAY_TO?: string;
  /** CAIP-2 Stellar network: stellar:pubnet (default) or stellar:testnet. */
  STELLAR_NETWORK?: string;
  /** x402 facilitator for the Stellar option (default: OpenZeppelin Channels, https://channels.openzeppelin.com/x402). */
  STELLAR_FACILITATOR_URL?: string;
  /** Bearer API key for the Stellar facilitator (`wrangler secret put STELLAR_FACILITATOR_API_KEY`). Required to offer Stellar. */
  STELLAR_FACILITATOR_API_KEY?: string;
  /** "false" disables the Stellar USDC option even when STELLAR_PAY_TO is set. Default on. */
  ACCEPT_STELLAR_USDC?: string;
  /** Horizon base URL used to verify Stellar test-buy transactions (default https://horizon.stellar.org). */
  STELLAR_HORIZON_URL?: string;
  /** Durable Object namespace for the strongly-consistent invoice replay guard (recommended). */
  INVOICE_GUARD?: DurableObjectNamespaceLike;
  /** Optional KV namespace used as a weaker (eventually consistent) replay guard. */
  USED_INVOICES?: KVLike;
  /** D1 database for the trust layer (probes, test-buy observations, reports, replies, private tips). */
  TRUST_DB?: D1Like;
  /** XRPL JSON-RPC endpoints (comma-separated) used to verify report/observation transactions. */
  XRPL_RPC_URLS?: string;
  /** Base JSON-RPC endpoint used to verify Base USDC report transactions. */
  BASE_RPC_URL?: string;
  /** Comma-separated public Base RPCs for the forward USDC index (rotated). */
  BASE_INDEX_RPCS?: string;
  /** Free trial calls via x402 sign-in-with-x ("0" disables). See src/trial.ts. */
  TRIALS?: string;
  /** Comma-separated XRPL addresses whose payments count as Lumi test-buys (default: PAY_TO). Addresses only. */
  TRUST_BUYER_ADDRESSES?: string;
  /** Comma-separated Base (EVM) addresses whose payments count as Lumi test-buys (default: Lumi's two Base wallets). */
  TRUST_BUYER_EVM?: string;
  /** Comma-separated Stellar G-addresses whose payments count as Lumi test-buys (default: Lumi's Stellar wallet). */
  TRUST_BUYER_STELLAR?: string;
  /** Max sellers per UTC day that trust checks (free or paid, same rule) move to the front of the Base test-buy queue (default 5). */
  TRUST_PRIORITY_DAILY_CAP?: string;
  /** Cloudflare Queue producer for catalog ingest / quote-check jobs (Workers Free: fan-out keeps each invocation small). */
  TRUST_QUEUE?: { sendBatch(messages: { body: unknown }[]): Promise<unknown> };
  /** Lumi Check contributions write queue (lumi-contrib-writes). Absent = writes inline. */
  CONTRIB_QUEUE?: { send(body: unknown): Promise<unknown> };
  CONTRIB_CAPS?: string;
  /** Oldest accepted scanner-kit version (semver), and comma-separated retired versions. */
  CONTRIB_KIT_MIN_VERSION?: string;
  CONTRIB_KIT_RETIRED?: string;
  /** Comma-separated funder addresses ignored when grouping contributor wallets by funding source (exchange hot wallets). */
  CONTRIB_FUNDER_IGNORE?: string;
  /** Etherscan-compatible explorer API for Base first-funder lookups (default https://base.blockscout.com/api). */
  CONTRIB_BASE_EXPLORER_API?: string;
  /** Workers Rate Limiting binding for contributor requests (wrangler.toml [[unsafe.bindings]] type "ratelimit"; not bound by default). */
  CONTRIB_RATE_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  /** Sales alert (optional, off unless set): incoming-webhook URL (Slack/Discord/generic JSON POST). */
  SALES_WEBHOOK_URL?: string;
  /** Sales alert by email (optional): recipient; needs the SALES_EMAIL send_email binding and SALES_ALERT_FROM. */
  SALES_ALERT_EMAIL?: string;
  /** Sender address on a domain with Cloudflare Email Routing enabled, e.g. sales-bot@lumitrades.io. */
  SALES_ALERT_FROM?: string;
  /** Cloudflare send_email binding used for the email alert. */
  SALES_EMAIL?: { send(message: unknown): Promise<void> };
  /** "1" = also alert on test-wallet sales. */
  SALES_ALERT_TESTS?: string;
  /** Extra comma-separated wallets whose payments are marked is_test. */
  SALES_TEST_WALLETS?: string;
  /** "live" prices XRP options from a live XRP/USD rate (cached 5 min, multi-source); anything else = fixed PRICE_<R>_XRP. */
  XRP_PRICING?: string;
  /** Static XRP/USD rate used only when every live source and the last-known rate are unavailable. */
  XRP_USD_FALLBACK?: string;
  /** Private request log (D1 table `traffic`): "0" turns it off. IPs are stored only as salted daily hashes. */
  TRAFFIC_LOG?: string;
  /** Optional key for the private traffic log's IP hash (falls back to INVOICE_SECRET). Secret. */
  TRAFFIC_SALT?: string;
  /** HMAC-SHA256 key (>= 32 chars) for customer wallet matching after raw addresses are nulled. `wrangler secret put PAYER_HMAC_SECRET`. Missing or short = feed-key bind/signup returns 503 (not charged); sales still record. */
  PAYER_HMAC_SECRET?: string;
  /** Previous PAYER_HMAC_SECRET during a rotation (>= 32 chars). Lookups and owner access/deletion also match hashes made with it. Keep this set as long as any purged row still carries an HMAC made with the old secret. A rotation without PREV resets trial caps and wallet-to-key lookup for those rows. */
  PAYER_HMAC_SECRET_PREV?: string;
  /** Days to keep a raw customer wallet after the later of the last payment or key/plan expiry. Default 90. Integer 1..3650. */
  PAYER_RETENTION_DAYS?: string;
  /** Exactly "on" nulls raw wallets on the nightly tick. Committed default is "off": backfill/re-hash only, plus a dry-run would-purge count. */
  PAYER_PURGE?: string;
  /** Optional cap on payer-retention writes (backfill + rotate + null) per nightly tick. Default 500, integer 1..10000. */
  PAYER_PURGE_MAX_ROWS?: string;
}

/** Minimal Cloudflare D1 surface used by the trust store. */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface D1Like {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown>;
}

/** Minimal Durable Object namespace surface we use. */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

/** Minimal subset of Cloudflare KV we use (keeps tests and Node runtime simple). */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

/**
 * Paid routes: x402 seller checks only. Every non-trust data route was retired on 2026-10-25 (v1.2.0 retired the last
 * three): they answer 410 Gone (see src/retired.ts) and are never quoted.
 */
export type PaidRoute = "vendor_report" | "high_value_check" | "verdict" | "receipts" | "batch_check";

/**
 * Default prices per route: XRP and USD-stablecoin (RLUSD/USDC). Override with PRICE_<ROUTE>_XRP / _RLUSD / _USDC
 * (e.g. PRICE_VERDICT_XRP). XRP ~= $1.33 (Oct 2026).
 */
export const DEFAULT_PRICES: Record<PaidRoute, { xrp: string; usd: string }> = {
  // Paid detailed x402 vendor report (trust layer): $0.02. Stablecoins exactly 0.02; XRP fixed from XRP ~= $1.32 on
  // Oct 22 2026 (0.02 / 1.32 = 0.0152 -> 0.015 XRP), not live-repriced unless XRP_PRICING=live.
  vendor_report: { xrp: "0.015", usd: "0.02" },
  // GET /v1/trust/check/high-value: the paid high-value check (owner approved building 2026-10-28 8:34 AM CT, branch
  // pricing-free-paid-2026-10-28). Priced per call at HIGH_VALUE.rate of the stated payment amount, between HIGH_VALUE.minUsd
  // and HIGH_VALUE.maxUsd (highValuePriceUsd). This entry is the floor, used where one static price is listed ("from $0.005").
  // The basic GET /v1/trust/check is free and rate-limited (FREE_TRUST_CHECK_LIMITS); it was a $0.02 paid route until then.
  high_value_check: { xrp: "0.0038", usd: "0.005" },
  // GET /v1/verdict: $0.01 per call (owner approved 2026-10-25: "Ship the verdict at $0.01 a call").
  // VERDICT_MAX_USD caps env overrides; test/verdict.test.ts checks it.
  verdict: { xrp: "0.0075", usd: "0.01" },
  // GET /v1/trust/receipts: Lumi's signed test-buy receipts for one seller, $0.005 (owner approved 2026-10-26 11:06 AM CT
  // for release). XRP fixed from XRP ~= $1.32: 0.005 / 1.32 = 0.0038.
  receipts: { xrp: "0.0038", usd: "0.005" },
  // GET /v1/check/batch: up to 10 record-based labels in one signed answer, $0.008 (owner approved 2026-10-26 11:06 AM CT
  // for release). XRP fixed from XRP ~= $1.32: 0.008 / 1.32 = 0.0061 -> 0.006.
  batch_check: { xrp: "0.006", usd: "0.008" },
};
/**
 * ONE-LINE SWITCH: "free" = GET /v1/verdict is a free, rate-limited alias of /v1/check (no 402, not listed
 * as a paid resource); "paid" = sold over x402 at DEFAULT_PRICES.verdict. Env VERDICT_PRICING overrides per deployment.
 */
export const VERDICT_PRICING: "free" | "paid" = "paid";
export const VERDICT_MAX_USD = 0.01;
/** First high-value check refund: at most this much per buyer (the high-value price cap), once per payer address. */
export const FIRST_HV_REFUND_CAP_USD = 0.25;
/** Only the exact value "on" enables the offer; unset, empty, "off" or anything else keeps it off. */
export const firstHvRefundOn = (env: { FIRST_HV_REFUND?: string } = {}) => (env.FIRST_HV_REFUND ?? "").trim().toLowerCase() === "on";
export const FIRST_HV_REFUND_TEXT = `Your first paid high-value check is refunded, up to $${FIRST_HV_REFUND_CAP_USD.toFixed(2)}, once per payer address, to the address that paid (sent by hand within 7 days; Lumi's own test wallets excluded). The verdict, label and score are the same either way.`;
export const verdictPaid = (env: { VERDICT_PRICING?: string } = {}) => ((env.VERDICT_PRICING ?? "").trim().toLowerCase() || VERDICT_PRICING) === "paid";
export const PAID_ROUTES = Object.keys(DEFAULT_PRICES) as PaidRoute[];

/**
 * High-value check pricing: a small share of the payment being protected, with a floor and a cap.
 * 0.5% of the stated amount, at least $0.005, at most $0.25 (reached at a $50 payment). Prices are rounded UP to $0.0001.
 * Paying (any amount) never changes a score, label or verdict: the check core is the same as the free check.
 */
export const HIGH_VALUE = { rate: 0.005, minUsd: 0.005, maxUsd: 0.25, maxAmountUsd: 1_000_000 } as const;

/** Decimal USD price string for a high-value check of a payment of amountUsd (assumed validated: finite, > 0). */
export function highValuePriceUsd(amountUsd: number): string {
  // Integer units of $0.0001, no float drift in the string: 0.5% of $3.33 = $0.01665 -> 167 units -> "0.0167".
  const units = Math.ceil(amountUsd * HIGH_VALUE.rate * 10_000 - 1e-9);
  const clamped = Math.min(Math.round(HIGH_VALUE.maxUsd * 10_000), Math.max(Math.round(HIGH_VALUE.minUsd * 10_000), units));
  const whole = Math.floor(clamped / 10_000);
  const frac = String(clamped % 10_000).padStart(4, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * Free basic trust check (GET /v1/trust/check): per hashed IP and per hashed client key/wallet header, per UTC day, plus a
 * short burst limit. Counted in the InvoiceGuard Durable Object (src/invoice-guard.ts /quota), never in D1, so the free
 * check adds no D1 writes. globalPerDay is a whole-service ceiling (split across the DO shards).
 */
export const FREE_TRUST_CHECK_LIMITS = { perDay: 100, perMinute: 20, globalPerDay: 20_000 } as const;
/** Free wallet check (GET /v1/wallet/check): same 100 a day per IP and per key as the free trust check, its own counter. */
export const FREE_WALLET_CHECK_LIMITS = { perDay: 100, perMinute: 10, globalPerDay: 5_000 } as const;

export interface Config {
  network: XrplNetwork;
  networkName: "mainnet" | "testnet" | "devnet";
  payTo: string;
  facilitatorUrl: string;
  invoiceSecret: string;
  invoiceSecretIsDevDefault: boolean;
  sourceTag: number;
  /** Products (routeKey prefixes) whose XRPL accepts carry extra.destinationTag instead of extra.sourceTag; "all" = every product. */
  xrplDestTagRoutes?: "all" | string[];
  /** extra.sourceTag on destination-tagged quotes: undefined = omitted (the facilitator then expects its default tag). */
  xrplDestTagSourceTag?: number;
  pricesDrops: Record<PaidRoute, string>;
  /** Accepted XRPL issued-token (IOU) stablecoins, offered after XRP in every 402. */
  ious: IouOption[];
  dataBaseUrl: string;
  dataTtlMs: number;
  dataMaxAgeHours: number;
  invoiceTtlSeconds: number;
  publicBaseUrl?: string;
  /** Base USDC option (x402 `exact`, EIP-3009), offered after every XRPL option. Undefined = off. */
  evm?: EvmOption;
  /** Stellar USDC option (x402 `exact`, SEP-41 transfer, facilitator-sponsored fees), offered after Base. Undefined = off. */
  stellar?: StellarOption;
  /** GET /v1/verdict sold over x402 (VERDICT_PRICING = "paid"); false = free alias of /v1/check, not listed as a paid resource. */
  verdictPaid?: boolean;
  /** FIRST_HV_REFUND === "on" (default off). */
  firstHvRefund?: boolean;
  /** USD list price per route (the stablecoin price); live XRP pricing targets exactly this. */
  usdPrices: Record<PaidRoute, string>;
  /** fixed = PRICE_<R>_XRP; live = usdPrices / live XRP-USD rate (pricesDrops is updated in place per request). */
  xrpPricing: "fixed" | "live";
  xrpUsdFallback: number;
  /** The rate behind the current pricesDrops when xrpPricing is live. */
  xrpRate?: { usd: number; source: string; as_of: string };
  /** Set only when PAYER_HMAC_SECRET is present and at least 32 characters. */
  payerHmacSecret?: string;
  /** Previous payer HMAC secret during a rotation. */
  payerHmacSecretPrev?: string;
  /** Raw-wallet retention window in days (default 90). */
  payerRetentionDays: number;
  /** True only when PAYER_PURGE is exactly "on". */
  payerPurge: boolean;
  /** Max payer-retention writes per nightly tick (default 500). */
  payerPurgeMaxRows: number;
  /** True when PAYER_HMAC_SECRET (or PREV) equals INVOICE_SECRET or a FLEET_GUARD_* secret. */
  payerHmacSecretReused: boolean;
}

export type EvmNetwork = "eip155:8453" | "eip155:84532";
export interface EvmOption {
  network: EvmNetwork;
  networkName: "Base" | "Base Sepolia";
  payTo: string;
  /** USDC token contract. */
  asset: string;
  /** EIP-712 domain of the token (x402 `extra.name` / `extra.version`). */
  eip712: { name: string; version: string };
  decimals: 6;
  /** Keyless facilitator (PayAI on mainnet); the fallback when `cdp` is set. */
  facilitatorUrl: string;
  /** Primary facilitator: Coinbase CDP with JWT auth (set when the CDP key is configured). */
  cdp?: { url: string; credentials: CdpCredentials };
  /** Routes (Quote.routeKey prefix) that settle Base USDC through CDP only: no fallback facilitator, and no Base option at
   *  all when CDP is not configured. See CDP_ONLY_ROUTES. */
  cdpOnlyRoutes: string[];
  explorer: string;
  /** Decimal USDC prices per route (same as the XRPL stablecoin prices). */
  prices: Record<PaidRoute, string>;
  /** Atomic USDC amounts (6 decimals) per route, as sent in accepts[].amount. */
  amounts: Record<PaidRoute, string>;
}

/** Circle USDC on Base (https://developers.circle.com/stablecoins/usdc-contract-addresses), with its EIP-712 domain. */
export const EVM_NETWORKS: Record<EvmNetwork, Omit<EvmOption, "payTo" | "prices" | "amounts" | "facilitatorUrl" | "cdp" | "cdpOnlyRoutes"> & { facilitatorUrl: string }> = {
  "eip155:8453": {
    network: "eip155:8453",
    networkName: "Base",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    eip712: { name: "USD Coin", version: "2" },
    decimals: 6,
    facilitatorUrl: "https://facilitator.payai.network",
    explorer: "https://basescan.org/tx/",
  },
  "eip155:84532": {
    network: "eip155:84532",
    networkName: "Base Sepolia",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    eip712: { name: "USDC", version: "2" },
    decimals: 6,
    facilitatorUrl: "https://x402.org/facilitator",
    explorer: "https://sepolia.basescan.org/tx/",
  },
};

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type StellarNetwork = "stellar:pubnet" | "stellar:testnet";
export interface StellarOption {
  network: StellarNetwork;
  networkName: "Stellar" | "Stellar testnet";
  payTo: string;
  /** SEP-41 contract (C...) of Circle USDC (the Stellar Asset Contract). */
  asset: string;
  decimals: 7;
  facilitatorUrl: string;
  /** Bearer key for the facilitator (secret; never logged or echoed). */
  apiKey: string;
  explorer: string;
  /** Decimal USDC prices per route (same USD list prices as Base USDC). */
  prices: Record<PaidRoute, string>;
  /** Atomic USDC amounts (7 decimals) per route, as sent in accepts[].amount. */
  amounts: Record<PaidRoute, string>;
}

/** Lumi's Stellar wallet (payTo + test-buyer). Public address only. */
export const LUMI_STELLAR_ADDRESS = "GCKTH26VNR4H4WLCXS5DX6563XRQQXWP5QKQWFD6CHOGTZJ2N5GKBU2L";
/** Circle USDC on Stellar: classic issuer and its Stellar Asset Contract (SEP-41). */
export const STELLAR_NETWORKS: Record<StellarNetwork, { networkName: StellarOption["networkName"]; asset: string; issuer: string; explorer: string; horizon: string }> = {
  "stellar:pubnet": {
    networkName: "Stellar",
    asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    explorer: "https://stellar.expert/explorer/public/tx/",
    horizon: "https://horizon.stellar.org",
  },
  "stellar:testnet": {
    networkName: "Stellar testnet",
    asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    explorer: "https://stellar.expert/explorer/testnet/tx/",
    horizon: "https://horizon-testnet.stellar.org",
  },
};
export const STELLAR_FACILITATOR_URL = "https://channels.openzeppelin.com/x402";
const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;

/** Decimal USDC ("0.015") to Stellar atomic units with 7 decimals ("150000"), no floats. */
export function usdcToStroops(v: string): string {
  const s = iouValue(v);
  const [whole, frac = ""] = s.split(".");
  return (BigInt(whole) * 10_000_000n + BigInt((frac + "0000000").slice(0, 7))).toString();
}

export function stroopsToUsdc(a: string): string {
  const d = BigInt(a);
  const frac = (d % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${d / 10_000_000n}.${frac}` : (d / 10_000_000n).toString();
}

function stellarConfig(env: Env): StellarOption | undefined {
  const e = env as Record<string, string | undefined>;
  const payTo = (env.STELLAR_PAY_TO || "").trim();
  const apiKey = (env.STELLAR_FACILITATOR_API_KEY || "").trim();
  if (!payTo || !apiKey || (env.ACCEPT_STELLAR_USDC ?? "true").trim().toLowerCase() === "false") return undefined;
  if (!STELLAR_ADDRESS.test(payTo)) throw new Error("STELLAR_PAY_TO must be a Stellar G-address");
  const network = (env.STELLAR_NETWORK || "stellar:pubnet").trim() as StellarNetwork;
  const net = STELLAR_NETWORKS[network];
  if (!net) throw new Error(`unsupported STELLAR_NETWORK: ${network} (use stellar:pubnet or stellar:testnet)`);
  const prices = {} as Record<PaidRoute, string>;
  const amounts = {} as Record<PaidRoute, string>;
  for (const r of PAID_ROUTES) {
    const R = r.toUpperCase();
    prices[r] = iouValue(e[`PRICE_${R}_STELLAR_USDC`] || e[`PRICE_${R}_BASE_USDC`] || e[`PRICE_${R}_USDC`] || DEFAULT_PRICES[r].usd);
    amounts[r] = usdcToStroops(prices[r]);
  }
  return {
    network,
    networkName: net.networkName,
    payTo,
    asset: net.asset,
    decimals: 7,
    facilitatorUrl: (env.STELLAR_FACILITATOR_URL || STELLAR_FACILITATOR_URL).replace(/\/+$/, ""),
    apiKey,
    explorer: net.explorer,
    prices,
    amounts,
  };
}

/** Decimal USDC string ("0.015") to atomic units with 6 decimals ("15000"), no floats. */
export function usdcToAtomic(v: string): string {
  const s = iouValue(v);
  const [whole, frac = ""] = s.split(".");
  return (BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6))).toString();
}

export function atomicToUsdc(a: string): string {
  const d = BigInt(a);
  const frac = (d % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${d / 1_000_000n}.${frac}` : (d / 1_000_000n).toString();
}

function evmConfig(env: Env): EvmOption | undefined {
  const e = env as Record<string, string | undefined>;
  const payTo = (env.EVM_PAY_TO || "").trim();
  if (!payTo || (env.ACCEPT_BASE_USDC ?? "true").trim().toLowerCase() === "false") return undefined;
  if (!EVM_ADDRESS.test(payTo) || /^0x0{40}$/.test(payTo)) throw new Error("EVM_PAY_TO must be a 0x EVM address");
  const network = (env.EVM_NETWORK || "eip155:8453").trim() as EvmNetwork;
  const net = EVM_NETWORKS[network];
  if (!net) throw new Error(`unsupported EVM_NETWORK: ${network} (use eip155:8453 or eip155:84532)`);
  const prices = {} as Record<PaidRoute, string>;
  const amounts = {} as Record<PaidRoute, string>;
  for (const r of PAID_ROUTES) {
    const R = r.toUpperCase();
    prices[r] = iouValue(e[`PRICE_${R}_BASE_USDC`] || e[`PRICE_${R}_USDC`] || DEFAULT_PRICES[r].usd);
    amounts[r] = usdcToAtomic(prices[r]);
  }
  const keyId = (env.CDP_API_KEY_ID || "").trim();
  const keySecret = (env.CDP_API_KEY_SECRET || "").trim();
  const useCdp = keyId && keySecret && (env.EVM_FACILITATOR || "cdp").trim().toLowerCase() === "cdp";
  return {
    ...net,
    payTo,
    facilitatorUrl: (env.EVM_FACILITATOR_URL || net.facilitatorUrl).replace(/\/+$/, ""),
    ...(useCdp ? { cdp: { url: (env.CDP_FACILITATOR_URL || CDP_FACILITATOR_URL).replace(/\/+$/, ""), credentials: { keyId, keySecret } } } : {}),
    cdpOnlyRoutes: parseCdpOnlyRoutes(env.EVM_CDP_ONLY_ROUTES),
    prices,
    amounts,
  };
}

/**
 * Trust and verdict routes settle Base USDC ONLY through the Coinbase CDP facilitator (owner approved 2026-10-28 1:07 PM CT,
 * branch only; Lumi Legal "stay but limit" on PayAI, notes/cleanup_2026-10-28/payai_terms_review.md).
 * For these routes the keyless fallback (PayAI on mainnet) is never called: no verify, no settle, so the route's payload
 * and bazaar declaration never reach PayAI. A CDP outage returns 503 facilitator_unavailable (reason cdp_unavailable)
 * with payment_help instead of falling back. Low-risk routes (feed credits, monitor packs) keep the PayAI fallback.
 * docs/facilitator-routing.md.
 */
export const CDP_ONLY_ROUTES: readonly PaidRoute[] = ["high_value_check", "verdict", "receipts", "batch_check", "vendor_report"];

function parseCdpOnlyRoutes(raw: string | undefined): string[] {
  const v = (raw ?? "").trim();
  if (!v) return [...CDP_ONLY_ROUTES];
  if (v.toLowerCase() === "none") return [];
  const list = v.split(",").map((x) => x.trim()).filter(Boolean);
  const bad = list.filter((x) => !(PAID_ROUTES as string[]).includes(x));
  if (bad.length) throw new Error(`EVM_CDP_ONLY_ROUTES: unknown route(s) ${bad.join(", ")} (use ${PAID_ROUTES.join(", ")} or "none")`);
  return list;
}

export type IouSymbol = "RLUSD" | "USDC";
export interface IouOption {
  symbol: IouSymbol;
  /** Canonical XRPL currency code (40-hex for these). */
  currency: string;
  issuer: string;
  /** IOU value strings per route. */
  prices: Record<PaidRoute, string>;
}

export const MAINNET_PAY_TO = "rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM";
export const DEFAULT_SOURCE_TAG = 5864; // "LUMI" on a phone keypad
export const FACILITATORS: Record<XrplNetwork, string> = {
  "xrpl:0": "https://xrpl-facilitator-mainnet.t54.ai",
  "xrpl:1": "https://xrpl-facilitator-testnet.t54.ai",
  "xrpl:2": "https://xrpl-facilitator-testnet.t54.ai",
};
export const EXPLORERS: Record<XrplNetwork, string> = {
  "xrpl:0": "https://livenet.xrpl.org/transactions/",
  "xrpl:1": "https://testnet.xrpl.org/transactions/",
  "xrpl:2": "https://devnet.xrpl.org/transactions/",
};

/** RLUSD currency code: 40-hex form of "RLUSD". */
export const RLUSD_CURRENCY = "524C555344000000000000000000000000000000";
/** Official RLUSD issuers (https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl). */
export const RLUSD_ISSUERS: Record<XrplNetwork, string | undefined> = {
  "xrpl:0": "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
  "xrpl:1": "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
  "xrpl:2": undefined,
};

/** Circle USDC currency code: 40-hex form of "USDC". */
export const USDC_CURRENCY = "5553444300000000000000000000000000000000";
/** Official USDC issuers (https://developers.circle.com/stablecoins/usdc-contract-addresses). */
export const USDC_ISSUERS: Record<XrplNetwork, string | undefined> = {
  "xrpl:0": "rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE",
  "xrpl:1": "rHuGNhqTG32mfmAvWA8hUyWRLV3tCSwKQt",
  "xrpl:2": undefined,
};

/** Normalise an IOU value ("0.010" -> "0.01"); positive, ≤ 6 decimals, no floats. */
export function iouValue(v: string): string {
  const s = v.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`invalid RLUSD amount: ${v}`);
  let [whole, frac = ""] = s.split(".");
  whole = whole.replace(/^0+(?=\d)/, "");
  frac = frac.replace(/0+$/, "");
  if (/^0*$/.test(whole + frac)) throw new Error(`price must be positive: ${v}`);
  return frac ? `${whole}.${frac}` : whole;
}

/** Dev-only fallback; refused on mainnet. */
const DEV_INVOICE_SECRET = "lumi-api-dev-only-invoice-secret-do-not-use-on-mainnet";

const DROPS_PER_XRP = 1_000_000n;

/** Convert a decimal XRP string ("0.02") to an integer drops string ("20000") without floats. */
export function xrpToDrops(xrp: string): string {
  const s = xrp.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`invalid XRP amount: ${xrp}`);
  const [whole, frac = ""] = s.split(".");
  const drops = BigInt(whole) * DROPS_PER_XRP + BigInt((frac + "000000").slice(0, 6));
  if (drops <= 0n) throw new Error(`price must be positive: ${xrp}`);
  return drops.toString();
}

export function dropsToXrp(drops: string): string {
  const d = BigInt(drops);
  const whole = d / DROPS_PER_XRP;
  const frac = (d % DROPS_PER_XRP).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export function loadConfig(env: Env): Config {
  const network = (env.XRPL_NETWORK || "xrpl:1") as XrplNetwork;
  if (!(network in FACILITATORS)) throw new Error(`unsupported XRPL_NETWORK: ${network}`);
  const networkName = network === "xrpl:0" ? "mainnet" : network === "xrpl:1" ? "testnet" : "devnet";

  const payTo = (env.PAY_TO || (network === "xrpl:0" ? MAINNET_PAY_TO : "")).trim();
  if (!CLASSIC_ADDRESS.test(payTo)) {
    throw new Error("PAY_TO must be set to an XRPL classic address (r...)");
  }

  let invoiceSecret = env.INVOICE_SECRET || "";
  const invoiceSecretIsDevDefault = !invoiceSecret;
  if (!invoiceSecret) {
    if (network === "xrpl:0") throw new Error("INVOICE_SECRET is required on mainnet");
    invoiceSecret = DEV_INVOICE_SECRET;
  }

  const sourceTag = env.SOURCE_TAG ? Number(env.SOURCE_TAG) : DEFAULT_SOURCE_TAG;
  if (!Number.isInteger(sourceTag) || sourceTag < 0 || sourceTag > 0xffffffff) {
    throw new Error("SOURCE_TAG must be a uint32");
  }

  const dtRaw = (env.XRPL_DEST_TAG_ROUTES ?? "").trim();
  const xrplDestTagRoutes: "all" | string[] = dtRaw.toLowerCase() === "all" ? "all" : dtRaw.split(",").map((x) => x.trim()).filter(Boolean);
  const dtSt = (env.XRPL_DEST_TAG_SOURCE_TAG ?? "").trim().toLowerCase();
  let xrplDestTagSourceTag: number | undefined;
  if (dtSt && dtSt !== "none") {
    xrplDestTagSourceTag = Number(dtSt);
    if (!Number.isInteger(xrplDestTagSourceTag) || xrplDestTagSourceTag < 0 || xrplDestTagSourceTag > 0xffffffff) {
      throw new Error("XRPL_DEST_TAG_SOURCE_TAG must be \"none\" or a uint32");
    }
  }

  return {
    verdictPaid: verdictPaid(env as any),
    firstHvRefund: firstHvRefundOn(env as any),
    network,
    networkName,
    payTo,
    facilitatorUrl: (env.FACILITATOR_URL || FACILITATORS[network]).replace(/\/+$/, ""),
    invoiceSecret,
    invoiceSecretIsDevDefault,
    sourceTag,
    xrplDestTagRoutes,
    ...(xrplDestTagSourceTag !== undefined ? { xrplDestTagSourceTag } : {}),
    pricesDrops: Object.fromEntries(
      PAID_ROUTES.map((r) => {
        const x = (env as Record<string, string | undefined>)[`PRICE_${r.toUpperCase()}_XRP`] || DEFAULT_PRICES[r].xrp;
        // A fixed XRP verdict price above the default (~$0.01) falls back to the default.
        return [r, xrpToDrops(r === "verdict" && !(Number(x) <= Number(DEFAULT_PRICES.verdict.xrp)) ? DEFAULT_PRICES.verdict.xrp : x)];
      }),
    ) as Record<PaidRoute, string>,
    ious: [
      iouConfig(env, network, "RLUSD", RLUSD_CURRENCY, RLUSD_ISSUERS),
      iouConfig(env, network, "USDC", USDC_CURRENCY, USDC_ISSUERS),
    ].filter((x): x is IouOption => x !== null),
    dataBaseUrl: (env.DATA_BASE_URL || "https://lumitrades.io/data").replace(/\/+$/, ""),
    dataTtlMs: Number(env.DATA_TTL_SECONDS || 60) * 1000,
    dataMaxAgeHours: Number(env.DATA_MAX_AGE_HOURS || 12) > 0 ? Number(env.DATA_MAX_AGE_HOURS || 12) : 12,
    invoiceTtlSeconds: Number(env.INVOICE_TTL_SECONDS || 300),
    publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/+$/, "") || undefined,
    evm: evmConfig(env),
    stellar: stellarConfig(env),
    usdPrices: Object.fromEntries(
      PAID_ROUTES.map((r) => {
        const R = r.toUpperCase();
        const e = env as Record<string, string | undefined>;
        const v = iouValue(e[`PRICE_${R}_BASE_USDC`] || e[`PRICE_${R}_USDC`] || e[`PRICE_${R}_RLUSD`] || DEFAULT_PRICES[r].usd);
        // The verdict is never sold above VERDICT_MAX_USD, whatever the env says.
        return [r, r === "verdict" && !(Number(v) <= VERDICT_MAX_USD) ? DEFAULT_PRICES.verdict.usd : v];
      }),
    ) as Record<PaidRoute, string>,
    xrpPricing: (env.XRP_PRICING || "").trim().toLowerCase() === "live" ? "live" : "fixed",
    xrpUsdFallback: Number(env.XRP_USD_FALLBACK) > 0 ? Number(env.XRP_USD_FALLBACK) : 1.32,
    payerHmacSecret: (() => { const s = (env.PAYER_HMAC_SECRET || "").trim(); return s.length >= 32 ? s : undefined; })(),
    payerHmacSecretPrev: (() => { const s = (env.PAYER_HMAC_SECRET_PREV || "").trim(); return s.length >= 32 ? s : undefined; })(),
    payerRetentionDays: (() => {
      const n = env.PAYER_RETENTION_DAYS == null || String(env.PAYER_RETENTION_DAYS).trim() === "" ? NaN : Number(env.PAYER_RETENTION_DAYS);
      return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : 90;
    })(),
    payerPurge: (env.PAYER_PURGE || "").trim() === "on",
    payerPurgeMaxRows: (() => {
      const n = env.PAYER_PURGE_MAX_ROWS == null || String(env.PAYER_PURGE_MAX_ROWS).trim() === "" ? NaN : Number(env.PAYER_PURGE_MAX_ROWS);
      return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 500;
    })(),
    payerHmacSecretReused: (() => {
      const same = (a?: string, b?: string) => !!(a && b && a.trim().length >= 32 && a.trim() === b.trim());
      const p = (env.PAYER_HMAC_SECRET || "").trim();
      const prev = (env.PAYER_HMAC_SECRET_PREV || "").trim();
      const others = [env.INVOICE_SECRET, invoiceSecret, env.FLEET_GUARD_HMAC_SECRET, env.FLEET_GUARD_HMAC_SECRET_PREV, env.FLEET_GUARD_KEY_SECRET];
      return others.some((o) => same(p, o) || same(prev, o));
    })(),
  };
}

function iouConfig(
  env: Env,
  network: XrplNetwork,
  symbol: IouSymbol,
  currency: string,
  issuers: Record<XrplNetwork, string | undefined>,
): IouOption | null {
  const e = env as Record<string, string | undefined>;
  if ((e[`ACCEPT_${symbol}`] ?? "true").trim().toLowerCase() === "false") return null;
  const issuer = (e[`${symbol}_ISSUER`] || issuers[network] || "").trim();
  if (!issuer) return null;
  if (!CLASSIC_ADDRESS.test(issuer)) throw new Error(`${symbol}_ISSUER must be an XRPL classic address`);
  const prices = {} as Record<PaidRoute, string>;
  for (const r of PAID_ROUTES) {
    prices[r] = iouValue(e[`PRICE_${r.toUpperCase()}_${symbol}`] || DEFAULT_PRICES[r].usd);
  }
  return { symbol, currency, issuer, prices };
}

/**
 * Real, working example values for discovery metadata (/.well-known/x402, OpenAPI, Bazaar extensions, A2A card, 402 notes).
 * Never a literal placeholder such as {id} or {coin}: crawlers and agents request example URLs verbatim.
 * printmoneylab is a curated vendor Lumi test-buys (src/vendors.ts); the URL is its test-bought endpoint.
 */
export const EXAMPLE_VENDOR_ID = "printmoneylab";
export const EXAMPLE_SELLER_URL = "https://api.agentweather.io/v1/pulse/facilitator";
export const EXAMPLE_SELLER_DOMAIN = "api.agentweather.io";
/** Seller used in receipts discovery listings. A curated vendor Lumi test-buys, so the listed URL is a 402 in production (not a 404). */
export const EXAMPLE_RECEIPTS_SELLER = "api.printmoneylab.com";
export const RECEIPTS_EXAMPLE = `/v1/trust/receipts?seller=${EXAMPLE_RECEIPTS_SELLER}`;
/** resource.url for a receipts 402: the request URL including ?seller= when present, otherwise the listed example. */
export function receiptsResourceUrl(base: string, search = ""): string {
  const q = search.startsWith("?") ? search.slice(1) : search;
  const seller = new URLSearchParams(q).get("seller")?.trim();
  if (seller) return `${base}/v1/trust/receipts?${q}`;
  return `${base}${RECEIPTS_EXAMPLE}`;
}
export const FREE_TRUST_CHECK_EXAMPLE = `/v1/trust/check?url=${encodeURIComponent(EXAMPLE_SELLER_URL)}`;
export const HIGH_VALUE_EXAMPLE = `/v1/trust/check/high-value?url=${encodeURIComponent(EXAMPLE_SELLER_URL)}&amount=10`;
export const HIGH_VALUE_PRICING_TEXT = `${HIGH_VALUE.rate * 100}% of the stated payment amount (amount, USD), minimum $${HIGH_VALUE.minUsd}, maximum $${HIGH_VALUE.maxUsd}; e.g. amount=10 costs $${highValuePriceUsd(10)}.`;
/**
 * One short, public price line used everywhere a single summary is shown (docs home page, OpenAPI info, README, site).
 * Derived from DEFAULT_PRICES (fixed-price routes) and HIGH_VALUE (amount-based route), so it cannot drift from the quotes.
 */
const FIXED_PRICES_USD = (Object.keys(DEFAULT_PRICES) as PaidRoute[]).filter((r) => r !== "high_value_check").map((r) => Number(DEFAULT_PRICES[r].usd));
export const PAID_PRICE_SUMMARY = `Paid routes from $${Math.min(HIGH_VALUE.minUsd, ...FIXED_PRICES_USD)} per call (most $${Math.min(...FIXED_PRICES_USD)} to $${Math.max(...FIXED_PRICES_USD)}; the high-value check is ${HIGH_VALUE.rate * 100}% of the payment, capped at $${HIGH_VALUE.maxUsd})`;
export const HIGH_VALUE_ADDS = "Same verdict, label and score as the free check (paying never changes them), plus a live re-check of the seller at call time and a Lumi-signed receipt bound to the stated amount (paid: true).";
/** Short high-value price, e.g. "0.5% of the amount (min $0.005, max $0.25)". */
export const HIGH_VALUE_PRICE_SHORT = `${HIGH_VALUE.rate * 100}% of the amount (min $${HIGH_VALUE.minUsd}, max $${HIGH_VALUE.maxUsd})`;
/**
 * The one-line upgrade hint near the top of the free check (REST `paid_option` and the MCP free result). Honest by
 * construction: it names what the paid check adds and its price, and says the verdict, label and score stay the same.
 */
export function paidOptionText(amountUsd?: number): string {
  const forAmount = amountUsd !== undefined && Number.isFinite(amountUsd) && amountUsd > 0 && amountUsd <= HIGH_VALUE.maxAmountUsd
    ? `, $${highValuePriceUsd(amountUsd)} for amount=${amountUsd}` : "";
  return `high_value_check adds a live re-check and an amount-bound receipt; price ${HIGH_VALUE_PRICE_SHORT}${forAmount}; same verdict, label and score (paying never changes them)`;
}
/** Default dollar price of a fixed-price paid route, e.g. "$0.01" (the live 402 quote is binding). */
export const usdPriceText = (route: Exclude<PaidRoute, "high_value_check">) => `$${DEFAULT_PRICES[route].usd}`;
