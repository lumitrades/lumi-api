/**
 * Runtime configuration. Every value comes from the environment (wrangler.toml
 * [vars], `wrangler secret`, `.dev.vars`, or process.env when run under Node),
 * so the same code runs on Cloudflare Workers, `wrangler dev` and plain Node.
 */

import { CDP_FACILITATOR_URL, type CdpCredentials } from "./cdp";

export type XrplNetwork = "xrpl:0" | "xrpl:1" | "xrpl:2";

export interface Env {
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
  /** Prices in XRP (decimal strings). */
  PRICE_SIGNAL_XRP?: string;
  PRICE_LEVELS_XRP?: string;
  PRICE_SLATE_XRP?: string;
  PRICE_MARKET_XRP?: string;
  PRICE_BRIEF_XRP?: string;
  PRICE_YEN_XRP?: string;
  PRICE_SENTIMENT_XRP?: string;
  PRICE_EVENTS_XRP?: string;
  PRICE_TRADES_XRP?: string;
  /** Any PRICE_<ROUTE>_<XRP|RLUSD|USDC> override. */
  [price: `PRICE_${string}`]: string | undefined;
  /** Accept RLUSD (Ripple USD, XRPL issued token) as a second asset. "false" disables. Default on. */
  ACCEPT_RLUSD?: string;
  /** RLUSD issuer override. Defaults to Ripple's official issuer for the network (docs.ripple.com). */
  RLUSD_ISSUER?: string;
  /** Prices in RLUSD (decimal strings, USD-equivalent). */
  PRICE_SIGNAL_RLUSD?: string;
  PRICE_LEVELS_RLUSD?: string;
  PRICE_SLATE_RLUSD?: string;
  PRICE_MARKET_RLUSD?: string;
  /** Accept Circle USDC (XRPL issued token) as a third asset. "false" disables. Default on. */
  ACCEPT_USDC?: string;
  /** USDC issuer override. Defaults to Circle's official issuer for the network (developers.circle.com). */
  USDC_ISSUER?: string;
  /** Prices in USDC (decimal strings). */
  PRICE_SIGNAL_USDC?: string;
  PRICE_LEVELS_USDC?: string;
  PRICE_SLATE_USDC?: string;
  PRICE_MARKET_USDC?: string;
  /** Where Lumi's published JSON lives. */
  DATA_BASE_URL?: string;
  /** Cache TTL for upstream data, seconds. */
  DATA_TTL_SECONDS?: string;
  /** Max age (hours) of market data before paid calls are refused with 503 (analysis/events get 4x). Default 12. */
  DATA_MAX_AGE_HOURS?: string;
  /** Seconds a 402 quote (invoice) stays payable. */
  INVOICE_TTL_SECONDS?: string;
  /** Comma-separated private names to scrub from paid responses. Set with `wrangler secret put PRIVATE_NAMES`. */
  PRIVATE_NAMES?: string;
  /** Owner access key for the remote MCP endpoint (/mcp): paid tools return data free. `wrangler secret put OWNER_MCP_KEY`. */
  OWNER_MCP_KEY?: string;
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
  /** Cloudflare Queue producer for catalog ingest / quote-check jobs (Workers Free: fan-out keeps each invocation small). */
  TRUST_QUEUE?: { sendBatch(messages: { body: unknown }[]): Promise<unknown> };
  /** Lumi Check contributions write queue (lumi-contrib-writes). Absent = writes inline. */
  CONTRIB_QUEUE?: { send(body: unknown): Promise<unknown> };
  /** JSON overrides for contributor credit weights / caps (see src/trust/contributors.ts DEFAULT_CREDITS / DEFAULT_CAPS). */
  CONTRIB_CREDITS?: string;
  CONTRIB_CAPS?: string;
  /** Oldest accepted scanner-kit version (semver), and comma-separated retired versions. */
  CONTRIB_KIT_MIN_VERSION?: string;
  CONTRIB_KIT_RETIRED?: string;
  /** Comma-separated funder addresses ignored when grouping contributor wallets by funding source (exchange hot wallets). */
  CONTRIB_FUNDER_IGNORE?: string;
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

export type PaidRoute = "signal" | "levels" | "slate" | "market" | "brief" | "yen" | "sentiment" | "events" | "trades" | "institutional" | "vendor_report"
  | "scan" | "lite" | "trust_check" | "funding" | "fear_greed" | "events_48h";

/**
 * Default prices per route: XRP and USD-stablecoin (RLUSD/USDC). Override with PRICE_<ROUTE>_XRP / _RLUSD / _USDC
 * (e.g. PRICE_YEN_XRP). Benchmarks on the XRPL AI Hub (Oct 2026): single data feeds 0.001-0.012 RLUSD (AskSurf, Heurist,
 * printmoneylab), composite reads ~0.02-0.025 (Strale Fear & Greed, invinoveritas signals). XRP ~= $1.33.
 */
export const DEFAULT_PRICES: Record<PaidRoute, { xrp: string; usd: string }> = {
  signal: { xrp: "0.005", usd: "0.01" },
  levels: { xrp: "0.005", usd: "0.01" },
  slate: { xrp: "0.01", usd: "0.02" },
  market: { xrp: "0.01", usd: "0.02" },
  brief: { xrp: "0.015", usd: "0.02" },
  yen: { xrp: "0.0075", usd: "0.01" },
  sentiment: { xrp: "0.0038", usd: "0.005" },
  events: { xrp: "0.0038", usd: "0.005" },
  trades: { xrp: "0.01", usd: "0.02" },
  // Daily Institutional & Policy Brief: $0.10 (was $0.25 until Oct 23 2026). Stablecoins are exactly 0.10; the XRP
  // default is set from XRP ~= $1.30 on Oct 23 2026 (0.10 / 1.30 = 0.077 XRP); XRP_PRICING=live reprices it from the
  // live rate, otherwise update PRICE_INSTITUTIONAL_XRP in wrangler.toml if XRP moves a lot.
  institutional: { xrp: "0.077", usd: "0.10" },
  // Paid detailed x402 vendor report (trust layer): $0.02. Stablecoins exactly 0.02; XRP fixed from XRP ~= $1.32 on
  // Oct 22 2026 (0.02 / 1.32 = 0.0152 -> 0.015 XRP), same no-live-repricing rule as PRICE_INSTITUTIONAL_XRP.
  vendor_report: { xrp: "0.015", usd: "0.02" },
  // Stage C (0.12.0) focused reads. XRP defaults from XRP ~= $1.32; live XRP pricing (XRP_PRICING=live) overrides them.
  scan: { xrp: "0.015", usd: "0.02" },
  lite: { xrp: "0.003", usd: "0.004" },
  trust_check: { xrp: "0.003", usd: "0.004" },
  funding: { xrp: "0.0023", usd: "0.003" },
  fear_greed: { xrp: "0.0023", usd: "0.003" },
  events_48h: { xrp: "0.0023", usd: "0.003" },
};
export const PAID_ROUTES = Object.keys(DEFAULT_PRICES) as PaidRoute[];

export interface Config {
  network: XrplNetwork;
  networkName: "mainnet" | "testnet" | "devnet";
  payTo: string;
  facilitatorUrl: string;
  invoiceSecret: string;
  invoiceSecretIsDevDefault: boolean;
  sourceTag: number;
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
  /** USD list price per route (the stablecoin price); live XRP pricing targets exactly this. */
  usdPrices: Record<PaidRoute, string>;
  /** fixed = PRICE_<R>_XRP; live = usdPrices / live XRP-USD rate (pricesDrops is updated in place per request). */
  xrpPricing: "fixed" | "live";
  xrpUsdFallback: number;
  /** The rate behind the current pricesDrops when xrpPricing is live. */
  xrpRate?: { usd: number; source: string; as_of: string };
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
  explorer: string;
  /** Decimal USDC prices per route (same as the XRPL stablecoin prices). */
  prices: Record<PaidRoute, string>;
  /** Atomic USDC amounts (6 decimals) per route, as sent in accepts[].amount. */
  amounts: Record<PaidRoute, string>;
}

/** Circle USDC on Base (https://developers.circle.com/stablecoins/usdc-contract-addresses), with its EIP-712 domain. */
export const EVM_NETWORKS: Record<EvmNetwork, Omit<EvmOption, "payTo" | "prices" | "amounts" | "facilitatorUrl" | "cdp"> & { facilitatorUrl: string }> = {
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
    prices,
    amounts,
  };
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

  return {
    network,
    networkName,
    payTo,
    facilitatorUrl: (env.FACILITATOR_URL || FACILITATORS[network]).replace(/\/+$/, ""),
    invoiceSecret,
    invoiceSecretIsDevDefault,
    sourceTag,
    pricesDrops: Object.fromEntries(
      PAID_ROUTES.map((r) => [r, xrpToDrops((env as Record<string, string | undefined>)[`PRICE_${r.toUpperCase()}_XRP`] || DEFAULT_PRICES[r].xrp)]),
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
        return [r, iouValue(e[`PRICE_${R}_BASE_USDC`] || e[`PRICE_${R}_USDC`] || e[`PRICE_${R}_RLUSD`] || DEFAULT_PRICES[r].usd)];
      }),
    ) as Record<PaidRoute, string>,
    xrpPricing: (env.XRP_PRICING || "").trim().toLowerCase() === "live" ? "live" : "fixed",
    xrpUsdFallback: Number(env.XRP_USD_FALLBACK) > 0 ? Number(env.XRP_USD_FALLBACK) : 1.32,
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
