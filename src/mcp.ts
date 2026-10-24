/**
 * Remote MCP endpoint (Streamable HTTP, stateless) at /mcp.
 *
 * Dual-era: serves modern clients (protocol 2026-07-28: per-request `_meta`, `server/discover`, no handshake) and
 * legacy clients (2024-11-05 .. 2025-11-25: `initialize` / `notifications/initialized` / `ping`). Every request is a
 * POST with one JSON-RPC message (legacy batches are accepted too); replies are application/json, or a single-event
 * text/event-stream when the client only accepts SSE. No sessions, no GET stream (GET/DELETE -> 405; HEAD -> 204).
 *
 * Tools mirror the stdio wrapper in mcp/ (lumi-trades-mcp). Free tools work for everyone. Paid tools return data only
 * for the owner key (Authorization: Bearer <key> or /mcp/<key>), via the same internal handlers as the REST API and with
 * no facilitator call. Without the key they return the price and how to pay (x402 at the REST endpoint, or the npm
 * package with an XRPL wallet). The freshness rule applies either way: stale or missing data is an error, never data.
 */

import { TRIAL_SHORT } from "./trial";
import type { Config, PaidRoute } from "./config";
import { atomicToUsdc, dropsToXrp } from "./config";
import { PAID_ENDPOINTS } from "./catalog";
import { indexDoc, VERSION } from "./docs";
import { DISCLAIMER, type CoinRef } from "./views";
import { MARKET_IDEAS_NAME, MARKET_IDEAS_NOTICE, MARKET_IDEAS_ROUTES, TRUST_DISCLAIMER } from "./lines";
import type { Prepared } from "./app";
import { lookupError, type Trust } from "./trust";

export const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];
const PV_META = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO = { name: "lumi-trades", title: "Lumi Trades", version: VERSION };
const NPM_PACKAGE = "lumi-trades-mcp";

export interface McpDeps {
  config: Config;
  /** OWNER_MCP_KEY secret. Unset or short = owner access disabled. */
  ownerKey?: string;
  coins(): Promise<CoinRef[]>;
  prepare(route: PaidRoute, coinArg?: string, base?: string): Promise<Prepared>;
  /** Unpaid internal GET of a paid path (returns the 402 terms, or a not-charged error). */
  quote(path: string): Promise<{ status: number; body: any }>;
  /** Trust layer (free vendor observations). */
  trust?: Pick<Trust, "vendorsDoc" | "vendorDoc" | "lookup">;
  log(event: Record<string, unknown>): void;
}

type Args = Record<string, unknown>;
interface PaidTool {
  name: string;
  route: PaidRoute;
  description: string;
  inputSchema: Record<string, unknown>;
  coin?: (a: Args) => string | undefined;
  /** Name of the required argument read by `coin` (default "coin"). */
  argName?: string;
  path: (a: Args) => string;
}

const NO_ARGS = { type: "object", properties: {} };
const COIN_ARG = (desc: string) => ({
  type: "object",
  properties: { coin: { type: "string", description: desc } },
  required: ["coin"],
});
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export const VENDOR_REPORT_TOOL_DESCRIPTION =
  "Detailed report on one x402 vendor from Lumi's trust list: full observation history (every free 402-quote check over 90 days, every paid test-buy with tx hash and delivered yes/no), " +
  "latency stats and 7-day trend, uptime % (24h/7d/30d/90d) and daily series, quoted-price history, verified agent reports, vendor replies, sample sizes and confidence labels. " +
  "Automated observations, not a rating. Paid ($0.02: ~0.015 XRP / 0.02 RLUSD / 0.02 USDC). The free summary is lumi_vendor_scores.";

export const TRUST_CHECK_TOOL_DESCRIPTION =
  "Should I pay this x402 URL? allow / warn / block with coded reasons, from Lumi's daily CDP Bazaar index, free 402-quote checks and Lumi's own test-buys (Base USDC for Bazaar listings; XRPL only for a small curated vendor list, counted separately). " +
  "Pass url, and optionally the payTo and USD amount you were quoted, to catch address or price mismatches. Links the free lookup and, for curated vendors, the $0.02 full report. " +
  "Observations, not a guarantee. Paid: $0.004 per call (USDC/RLUSD, or the XRP equivalent).";

export const INSTITUTIONAL_TOOL_DESCRIPTION =
  "Daily policy brief: what BIS, IMF, US Treasury/OCC, Fed, SEC, CFTC, JPMorgan (Kinexys), SBI, Cross River, Securitize, R3 " +
  "and other banks, central banks and tokenization firms did in the last days, and how each move maps to XRP, XLM, XDC, QNT, AXL and HBAR (plus RLUSD/USDC). " +
  "Every item is dated and sourced, with why it matters, impact and confidence, and a link_type that separates confirmed links from Lumi's " +
  "indirect-alignment analysis (institution goals vs token mission, both sides quoted). Includes a per-token map, connections, no-news notes and " +
  "what to watch next. Use it when you need the institutional/regulatory picture behind these tokens without reading dozens of releases. " +
  "Refreshed daily; never sold stale. Paid: $0.10 per call (USDC/RLUSD, or the XRP equivalent). Not financial advice.";

export const VENDOR_LOOKUP_DESCRIPTION =
  "Free. Check an x402 seller before you pay it: pass url (the resource you are about to buy), domain, or payTo (the address in its 402 quote, case-insensitive). Lumi ingests the full CDP x402 Bazaar catalog daily and runs free, unpaid 402-quote checks of listings on a rotating schedule (valid quote, price and payTo vs the listing, latency, domain age; live coverage counts in the response), labelled 'quote-verified, low confidence', plus Lumi's own test-buys confirmed on-chain, labelled 'purchase-verified' and counted per chain (Base USDC buys of Bazaar listings; XRPL buys of a small curated list, separately). Answer-only: tx evidence is in the paid trust check. Observations, not ratings; no match is not a negative signal. With no arguments: the curated XRPL vendor scores and catalog counts; vendor_id gives one curated vendor's summary (tx evidence is in the paid vendor report).";

/** Same names and descriptions as mcp/src/index.js (PAID_TOOLS). */
export const PAID_TOOLS: PaidTool[] = [
  {
    name: "lumi_brief",
    route: "brief",
    path: (a) => `/v1/brief${a.format === "md" ? "?format=md" : ""}`,
    inputSchema: { type: "object", properties: { format: { type: "string", enum: ["json", "md"], description: "json (default) or md for ready-to-post markdown" } } },
    description:
      "Today's crypto market brief from Lumi: BTC price/levels/signal, CoinMarketCap Fear & Greed, funding, top/bottom movers, key levels for 13 coins, yen watch, events in the next 48h, Lumi's active paper trades, sourced news. Paid: $0.02 per call (USDC/RLUSD, or the XRP equivalent).",
  },
  {
    name: "lumi_signal",
    route: "signal",
    coin: (a) => str(a.coin),
    path: (a) => `/v1/signal/${encodeURIComponent(str(a.coin) ?? "")}`,
    inputSchema: COIN_ARG("Ticker or CoinGecko id, any of the 50 in lumi_coins, e.g. BTC ETH XRP SOL AVAX TRX"),
    description: "Lumi Market Ideas. Paper-trade analysis, not investment advice. Lumi does not trade real money. Mechanical buy/sell read for one of 50 top coins, computed live (1h refreshed about every 13 minutes): overall label + score, 1h/4h/1d labels and indicators (RSI, MACD, EMA, Bollinger, StochRSI, volume). Paid: $0.01 per call (USDC/RLUSD, or the XRP equivalent).",
  },
  {
    name: "lumi_levels",
    route: "levels",
    coin: (a) => str(a.coin),
    path: (a) => `/v1/levels/${encodeURIComponent(str(a.coin) ?? "")}`,
    inputSchema: COIN_ARG("Ticker or CoinGecko id of a watchlist/major coin, e.g. XRP BTC ETH"),
    description: "Lumi Market Ideas. Paper-trade analysis, not investment advice. Lumi does not trade real money. Lumi's support/resistance levels, bias, rule-based 7-day bull/base/bear scenario levels (not forecasts), commentary, catalysts and sources for one coin. Paid: $0.01 per call (USDC/RLUSD, or the XRP equivalent).",
  },
  {
    name: "lumi_scan",
    route: "scan",
    path: () => "/v1/scan",
    inputSchema: NO_ARGS,
    description: "Lumi Market Ideas. Paper-trade analysis, not investment advice. Lumi does not trade real money. Whole-market screen in one call: buy/sell label, score, 1h/4h/1d labels, 1h RSI, price and 24h change for all 50 top coins, strongest first, plus label counts and breadth. Computed live. Paid: $0.02 per call (USDC/RLUSD, or the XRP equivalent).",
  },
  {
    name: "lumi_lite",
    route: "lite",
    coin: (a) => str(a.coin),
    path: (a) => `/v1/lite/${encodeURIComponent(str(a.coin) ?? "")}`,
    inputSchema: COIN_ARG("Ticker or CoinGecko id, any of the 50 in lumi_coins, e.g. BTC ETH XRP"),
    description: "Lumi Market Ideas. Paper-trade analysis, not investment advice. Lumi does not trade real money. Cheap headline read for one coin: overall buy/sell label and score, 1h/4h/1d labels, price and 24h change (lumi_signal adds the indicator breakdown). Paid: $0.004 per call (USDC/RLUSD, or the XRP equivalent).",
  },
  { name: "lumi_slate", route: "slate", path: () => "/v1/slate", inputSchema: NO_ARGS, description: "Lumi Market Ideas. Paper-trade analysis, not investment advice. Lumi does not trade real money. Lumi's current paper-trade ideas (entry, stop, targets, leverage, conviction) and 'no setup' notes. Paid: $0.02 per call (USDC/RLUSD, or the XRP equivalent)." },
  { name: "lumi_market", route: "market", path: () => "/v1/market", inputSchema: NO_ARGS, description: "BTC backdrop (levels, scenario levels, signal), macro (yen note, total cap, dominance, Fear & Greed, funding) and breadth. Paid: $0.02 per call (USDC/RLUSD, or the XRP equivalent)." },
  { name: "lumi_macro_yen", route: "yen", path: () => "/v1/macro/yen", inputSchema: NO_ARGS, description: "Yen carry-trade watch: USD/JPY, Nikkei 225, rule-based carry-trade risk (low/watch/elevated) around 155, Japan events (BOJ, CPI). Paid: $0.01 per call (USDC/RLUSD, or the XRP equivalent)." },
  { name: "lumi_sentiment", route: "sentiment", path: () => "/v1/sentiment", inputSchema: NO_ARGS, description: "CoinMarketCap Fear & Greed, BTC perp funding with a plain-English read, open interest, total cap/dominance, breadth across 13 coins. Paid: $0.005 per call (USDC/RLUSD, or the XRP equivalent)." },
  { name: "lumi_events", route: "events", path: () => "/v1/events", inputSchema: NO_ARGS, description: "Sourced upcoming macro/crypto events (timed releases in UTC + US Central, and dated per-coin catalysts). Paid: $0.005 per call (USDC/RLUSD, or the XRP equivalent)." },
  { name: "lumi_funding", route: "funding", path: () => "/v1/funding", inputSchema: NO_ARGS, description: "Perpetual funding rates for the top-50 coins listed on OKX (rate, 8h-normalised, annualised, next funding time, plain-English read), BTC read, median, most positive/negative. Refreshed every 15 minutes. Paid: $0.003 per call (USDC/RLUSD, or the XRP equivalent)." },
  { name: "lumi_fear_greed", route: "fear_greed", path: () => "/v1/fear-greed", inputSchema: NO_ARGS, description: "CoinMarketCap Fear & Greed now, yesterday, last week and last month, change vs each, yearly high/low and a 30-day series. Refreshed every 30 minutes. Paid: $0.003 per call (USDC/RLUSD, or the XRP equivalent)." },
  { name: "lumi_events_48h", route: "events_48h", path: () => "/v1/events/next48h", inputSchema: NO_ARGS, description: "What is scheduled in the next 48 hours: macro releases and decisions with UTC + US Central times, why each matters and its source, plus dated coin catalysts. Paid: $0.003 per call (USDC/RLUSD, or the XRP equivalent)." },
  { name: "lumi_trades", route: "trades", path: () => "/v1/trades", inputSchema: NO_ARGS, description: "Lumi Market Ideas. Paper-trade analysis, not investment advice. Lumi does not trade real money. Lumi's paper-trade history as a raw list (entry, stop, targets, leverage, status, reasoning). Paid: $0.02 per call (USDC/RLUSD, or the XRP equivalent)." },
  {
    name: "lumi_institutional_brief",
    route: "institutional",
    path: (a) => `/v1/institutional${a.format === "md" ? "?format=md" : ""}`,
    inputSchema: { type: "object", properties: { format: { type: "string", enum: ["json", "md"], description: "json (default) or md for ready-to-read markdown" } } },
    description: INSTITUTIONAL_TOOL_DESCRIPTION,
  },
  {
    name: "lumi_trust_check",
    route: "trust_check",
    argName: "url",
    coin: (a) => (str(a.url)?.trim() ? new URLSearchParams(Object.entries({ url: str(a.url)!.trim(), payTo: str(a.payTo), amount: a.amount === undefined ? undefined : String(a.amount) }).filter(([, v]) => v) as [string, string][]).toString() : undefined),
    path: (a) => `/v1/trust/check?${String(a.coin ?? "")}`,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The x402 resource URL you are about to pay" },
        payTo: { type: "string", description: "Optional: the payTo address in its 402 quote" },
        amount: { type: "string", description: "Optional: the quoted price in USD, e.g. 0.01" },
      },
      required: ["url"],
    },
    description: TRUST_CHECK_TOOL_DESCRIPTION,
  },
  {
    name: "lumi_vendor_report",
    route: "vendor_report",
    argName: "vendor_id",
    coin: (a) => str(a.vendor_id),
    path: (a) => `/v1/trust/vendors/${encodeURIComponent(str(a.vendor_id) ?? "")}/report`,
    inputSchema: {
      type: "object",
      properties: { vendor_id: { type: "string", pattern: "^[a-z0-9-]{1,64}$", description: "Vendor id from lumi_vendor_scores, e.g. printmoneylab" } },
      required: ["vendor_id"],
    },
    description: VENDOR_REPORT_TOOL_DESCRIPTION,
  },
];

/** Shared note for every paid tool, stated once in the server instructions instead of in each tool description. */
export const PAID_TOOLS_NOTE =
  "Paid tools on this remote server return the price and how to pay (x402 at the REST URL on XRPL, Base or Stellar, or the lumi-trades-mcp npm package with an XRPL or Base wallet); the owner key gets the data. Never charged when data is stale.";

function toolList() {
  const ro = { readOnlyHint: true, openWorldHint: true };
  return [
    {
      name: "lumi_catalog",
      title: "Lumi: endpoints and prices (free)",
      description: "Free. Lists Lumi API endpoints, live prices (XRP / RLUSD / USDC on the XRP Ledger, USDC on Base), payment settings of this MCP server and the caller wallet address.",
      inputSchema: NO_ARGS,
      annotations: ro,
    },
    { name: "lumi_coins", title: "Lumi: supported coins (free)", description: "Free. The 50 coins Lumi covers (tickers and CoinGecko ids). Lumi Market Ideas (paper-trade analysis, not investment advice): signals for all, levels for the watchlist and majors.", inputSchema: NO_ARGS, annotations: ro },
    {
      name: "lumi_samples",
      title: "Lumi: free samples of every paid product",
      description:
        "Free. A truncated, clearly labelled SAMPLE of each paid product (signal, lite, scan, levels, slate, market, brief, yen, sentiment, funding, fear_greed, events, events_48h, trades, institutional brief, trust_check, vendor report) with its USD price and full URL, so you can see the shape and quality before paying. Lists are cut to 2 entries; up to 10 minutes old. Pass route to get one product.",
      inputSchema: { type: "object", properties: { route: { type: "string", pattern: "^[a-z_]{1,32}$", description: "Optional product route, e.g. institutional or signal" } } },
      annotations: ro,
    },
    {
      name: "lumi_quote",
      title: "Lumi: price check without paying (free)",
      description:
        "Free. Shows the x402 price quote (XRP / RLUSD / USDC on the XRP Ledger, USDC on Base) for any Lumi paid path, e.g. /v1/brief, without paying. A 503 means the data is not fresh right now and the call would not be sold.",
      inputSchema: { type: "object", properties: { path: { type: "string", pattern: "^/v1/", description: "Paid API path, e.g. /v1/brief or /v1/signal/XRP" } }, required: ["path"] },
      annotations: ro,
    },
    {
      name: "lumi_vendor_scores",
      title: "Lumi: x402 vendor observations (free)",
      description:
        VENDOR_LOOKUP_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", maxLength: 500, description: "Resource URL you are about to pay, e.g. https://example.com/api/data" },
          domain: { type: "string", maxLength: 253, description: "Seller host or domain, e.g. example.com" },
          payTo: { type: "string", maxLength: 120, description: "payTo address from the seller's 402 quote (0x... or r...)" },
          vendor_id: { type: "string", pattern: "^[a-z0-9-]{1,64}$", description: "Optional curated vendor id, e.g. printmoneylab" },
        },
      },
      annotations: ro,
    },
    {
      name: "lumi_seller_monitoring",
      title: "Lumi: seller monitoring plans and monitored sellers (free)",
      description:
        "Free. For x402 sellers: Monitor $9/30 days (1 endpoint, seller-funded test-buy per term + alerts), Monitor Plus $29/30 days (weekly test-buys, up to 20 endpoints), Audit $99 one-off (every listed endpoint, signed report). No auto-renew; payTo proven by signature; paying never changes a score. " +
        "No args: plans, enrolment steps and safeguards. enrollment_id: that seller's public entry (disclosure, findings, replies) and live badge status. Plans are paid over x402 at the REST URL.",
      inputSchema: { type: "object", properties: { enrollment_id: { type: "string", pattern: "^men_[a-f0-9]{24}$", description: "Optional enrollment id (men_...)" } } },
      annotations: ro,
    },
    {
      name: "lumi_trust_feed",
      title: "Lumi: trust data feed plans and licence (free)",
      description:
        "Free. Licensed trust data feed for facilitators, wallets and frameworks: free key with 1,000 lookups/month (wallet signature), $1.50 per 1,000 extra lookups, Feed $99/30 days, Feed Pro $199/30 days (snapshot export, webhooks). Returns plans, endpoints and licence terms (no resale, attribution).",
      inputSchema: NO_ARGS,
      annotations: ro,
    },
    ...PAID_TOOLS.map((t) => ({
      name: t.name,
      title: `${MARKET_IDEAS_ROUTES.includes(t.route) ? MARKET_IDEAS_NAME : "Lumi"}: ${t.name.replace(/^lumi_/, "").replace(/_/g, " ")} (paid)`,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: ro,
    })),
  ];
}

const INSTRUCTIONS =
  "Lumi Trades (lumitrades.io), three groups. Lumi Trust: lumi_trust_check (should I pay this x402 URL? allow/warn/block), lumi_vendor_scores and lumi_vendor_report, lumi_seller_monitoring, lumi_trust_feed. " +
  "Market data: daily brief, BTC/macro backdrop, yen carry-trade watch, sentiment, funding rates, Fear & Greed, events and the next 48h, and a daily policy brief " +
  "(BIS, IMF, US regulators, major banks and tokenization firms mapped to XRP, XLM, XDC, QNT, AXL, HBAR). " +
  `${MARKET_IDEAS_NAME} (${MARKET_IDEAS_NOTICE}): live signals for 50 coins (lumi_signal, cheap lumi_lite, or all at once with lumi_scan), lumi_levels support/resistance, lumi_slate paper-trade ideas and lumi_trades history. ` +
  "Free: lumi_catalog, lumi_coins, lumi_samples (truncated previews of every paid product), lumi_quote, lumi_vendor_scores (Lumi's observations of other x402 vendors), lumi_seller_monitoring (Monitor $9/30d, Monitor Plus $29/30d, Audit $99) and lumi_trust_feed (free 1,000 lookups/month, Feed $99/30d, Feed Pro $199/30d); lumi_vendor_report is the paid full history for one vendor ($0.02). " +
  "Paid tools cost $0.003 to $0.10 per call (the daily policy brief is $0.10, everything else $0.02 or less) via x402; paid in XRP, RLUSD or USDC on the XRP Ledger or USDC on Base or Stellar; " + TRIAL_SHORT + "; without access they return the price and how to pay. " +
  PAID_TOOLS_NOTE + " Analytics and education only, not financial advice. Cite 'Lumi Trades (lumitrades.io)'.";

// ---------------------------------------------------------------- auth

const enc = new TextEncoder();
async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}
/** Constant-time string comparison (fixed-length digests, XOR-accumulated). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
const MIN_KEY_LENGTH = 32;
export async function isOwnerKey(candidate: string | undefined, ownerKey: string | undefined): Promise<boolean> {
  if (!ownerKey || ownerKey.length < MIN_KEY_LENGTH || !candidate) return false;
  return safeEqual(candidate, ownerKey);
}

// ---------------------------------------------------------------- HTTP

/** Methods /mcp actually supports; Allow (on 405) and Access-Control-Allow-Methods both use this one list. */
export const MCP_ALLOW = "POST, HEAD, OPTIONS";

export const MCP_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": MCP_ALLOW,
  "Access-Control-Allow-Headers":
    "*, Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID, PAYMENT-SIGNATURE, X-PAYMENT",
  "Access-Control-Expose-Headers": "MCP-Protocol-Version, Mcp-Session-Id, WWW-Authenticate",
  "Access-Control-Max-Age": "86400",
};

function httpJson(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...MCP_CORS, ...extra },
  });
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any; result?: unknown; error?: unknown };
type Reply = { status: number; body: Record<string, unknown> } | null;

const rpcError = (id: Rpc["id"], code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

/** Decode an Mcp-Name / Mcp-Param value (=?base64?...?= sentinel form). */
function decodeHeaderValue(v: string): string {
  const m = v.match(/^=\?base64\?(.*)\?=$/);
  if (!m) return v;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
  } catch {
    return "\u0000invalid";
  }
}

function validOrigin(origin: string | null): boolean {
  if (origin === null || origin === "null") return true;
  // Public, credential-less endpoint (no cookies; access is by explicit key), so any well-formed web origin is allowed.
  try {
    const u = new URL(origin);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol.endsWith("-extension:");
  } catch {
    return false;
  }
}

/**
 * Handle a request to /mcp or /mcp/<key>. `pathKey` is the segment after /mcp/ (undefined for /mcp).
 */
export async function handleMcp(request: Request, base: string, pathKey: string | undefined, deps: McpDeps): Promise<Response> {
  if (pathKey !== undefined && !(await isOwnerKey(pathKey, deps.ownerKey))) {
    return httpJson(404, { error: "not_found", hint: `The MCP endpoint is ${base}/mcp` });
  }
  if (!validOrigin(request.headers.get("Origin"))) {
    return httpJson(403, rpcError(null, -32600, "Forbidden origin"));
  }
  if (request.method === "HEAD") {
    // Liveness probe (some MCP clients/connectors HEAD the URL first): no body, same CORS + Allow headers.
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", ...MCP_CORS, Allow: MCP_ALLOW } });
  }
  if (request.method !== "POST") {
    // Stateless server: no standalone SSE stream and no sessions to delete.
    return httpJson(
      405,
      {
        error: "method_not_allowed",
        detail: "This is a stateless MCP Streamable HTTP endpoint: POST one JSON-RPC message per request.",
        mcp_endpoint: `${base}/mcp`,
        protocol_versions: SUPPORTED_VERSIONS,
        docs: `${base}/skill.md`,
      },
      { Allow: MCP_ALLOW },
    );
  }

  let owner = pathKey !== undefined;
  const auth = request.headers.get("Authorization");
  const bearer = auth?.match(/^\s*Bearer\s+(\S+)\s*$/i)?.[1];
  let bearerRejected = false;
  if (!owner && bearer) {
    owner = await isOwnerKey(bearer, deps.ownerKey);
    bearerRejected = !owner;
  }

  let msg: unknown;
  try {
    msg = JSON.parse(await request.text());
  } catch {
    return httpJson(400, rpcError(null, -32700, "Parse error: body must be one JSON-RPC message"));
  }

  const ctx: Ctx = { base, deps, owner, bearerRejected, request };
  const accept = request.headers.get("Accept") ?? "";
  const sseOnly = /text\/event-stream/i.test(accept) && !/application\/json|\*\/\*/i.test(accept);

  if (Array.isArray(msg)) {
    // Legacy (2025-03-26) batches.
    if (!msg.length) return httpJson(400, rpcError(null, -32600, "Invalid Request: empty batch"));
    const replies = (await Promise.all(msg.map((m) => dispatch(m, ctx)))).filter((r): r is NonNullable<Reply> => r !== null);
    if (!replies.length) return new Response(null, { status: 202, headers: MCP_CORS });
    return respond(200, replies.map((r) => r.body), sseOnly);
  }
  const reply = await dispatch(msg, ctx);
  if (!reply) return new Response(null, { status: 202, headers: MCP_CORS });
  return respond(reply.status, reply.body, sseOnly);
}

function respond(status: number, body: unknown, sse: boolean): Response {
  if (sse && status === 200) {
    return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
      status,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no", ...MCP_CORS },
    });
  }
  return httpJson(status, body);
}

interface Ctx {
  base: string;
  deps: McpDeps;
  owner: boolean;
  bearerRejected: boolean;
  request: Request;
}

async function dispatch(raw: unknown, ctx: Ctx): Promise<Reply> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { status: 400, body: rpcError(null, -32600, "Invalid Request") };
  const m = raw as Rpc;
  const isRequest = m.id !== undefined && m.id !== null && typeof m.method === "string";
  // Notifications (notifications/initialized, cancelled, ...) and client responses: accept, no body.
  if (!isRequest) {
    if (typeof m.method === "string" || "result" in m || "error" in m) return null;
    return { status: 400, body: rpcError(m.id, -32600, "Invalid Request") };
  }
  const id = m.id!;
  const method = m.method!;
  const params = m.params && typeof m.params === "object" ? m.params : {};
  const h = ctx.request.headers;

  // ---- version + header validation
  const headerVer = h.get("MCP-Protocol-Version") ?? undefined;
  const bodyVer: string | undefined = typeof params._meta?.[PV_META] === "string" ? params._meta[PV_META] : undefined;
  if (headerVer && bodyVer && headerVer !== bodyVer) {
    return { status: 400, body: rpcError(id, -32020, `Header mismatch: MCP-Protocol-Version '${headerVer}' does not match _meta '${bodyVer}'`) };
  }
  const mcpMethod = h.get("Mcp-Method");
  if (mcpMethod !== null && mcpMethod !== method) {
    return { status: 400, body: rpcError(id, -32020, `Header mismatch: Mcp-Method header value does not match body method '${method}'`) };
  }
  const mcpName = h.get("Mcp-Name");
  if (mcpName !== null && (method === "tools/call" || method === "prompts/get" || method === "resources/read")) {
    const bodyName = method === "resources/read" ? params.uri : params.name;
    if (decodeHeaderValue(mcpName) !== bodyName) {
      return { status: 400, body: rpcError(id, -32020, "Header mismatch: Mcp-Name header value does not match the body") };
    }
  }

  if (method === "initialize") {
    // Legacy handshake: negotiate a legacy revision.
    const want = str(params.protocolVersion);
    const version = want && LEGACY_VERSIONS.includes(want) ? want : LEGACY_VERSIONS[0];
    return ok(id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    }, false);
  }

  const version = bodyVer ?? headerVer ?? "2025-03-26";
  if (!SUPPORTED_VERSIONS.includes(version)) {
    return { status: 400, body: rpcError(id, -32022, "Unsupported protocol version", { supported: SUPPORTED_VERSIONS, requested: version }) };
  }
  const modern = version === MODERN_VERSION;

  switch (method) {
    case "server/discover":
      return ok(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        instructions: INSTRUCTIONS,
        ttlMs: 3_600_000,
        cacheScope: "public",
      }, true);
    case "ping":
      return ok(id, {}, modern);
    case "tools/list":
      return ok(id, { tools: toolList() }, modern);
    case "resources/list":
      return ok(id, { resources: [] }, modern);
    case "resources/templates/list":
      return ok(id, { resourceTemplates: [] }, modern);
    case "prompts/list":
      return ok(id, { prompts: [] }, modern);
    case "tools/call": {
      const name = str(params.name);
      const args: Args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
      if (!name || !toolList().some((t) => t.name === name)) {
        return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name ?? "(missing name)"}`) };
      }
      return ok(id, await callTool(name, args, ctx), modern);
    }
    default:
      return { status: modern ? 404 : 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}

function ok(id: string | number, result: Record<string, unknown>, modern: boolean): Reply {
  const r = modern ? { resultType: "complete", ...result, _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO } } : result;
  return { status: 200, body: { jsonrpc: "2.0", id, result: r } };
}

// ---------------------------------------------------------------- tools

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (obj: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

async function callTool(name: string, args: Args, ctx: Ctx): Promise<ToolResult> {
  const { deps, base, owner } = ctx;
  const cfg = deps.config;
  const access = owner ? "owner" : "public";
  try {
    switch (name) {
      case "lumi_catalog": {
        const idx = indexDoc(cfg, base, await deps.coins());
        return text({
          api: base,
          mcp: `${base}/mcp`,
          network: cfg.network,
          access: owner ? "owner key: paid tools return data at no charge" : "public: free tools only; paid tools return the price and how to pay",
          ...(ctx.bearerRejected ? { auth_note: "The Authorization bearer token was not recognised; serving public access." } : {}),
          pay_with: ["XRP", ...cfg.ious.map((o) => o.symbol), ...(cfg.evm ? [`USDC on ${cfg.evm.networkName} (${cfg.evm.network})`] : []), ...(cfg.stellar ? [`USDC on ${cfg.stellar.networkName} (${cfg.stellar.network})`] : [])],
          a2a: `${base}/.well-known/agent-card.json`,
          wallet: "none (remote server; pay via x402 at the REST endpoint or run the lumi-trades-mcp npm package with your own XRPL wallet)",
          endpoints: idx.paid_endpoints.map((e) => ({ path: e.path, prices: e.prices, summary: e.summary })),
          guarantee: idx.guarantee,
        });
      }
      case "lumi_samples": {
        const r = await deps.quote("/v1/samples");
        if (r.status !== 200) return text({ status: r.status, body: r.body }, true);
        const route = str(args.route);
        if (!route) return text(r.body);
        const one = (r.body?.products || []).find((p: any) => p.route === route);
        return one ? text({ label: r.body.label, ...one }) : text({ error: "unknown route", routes: (r.body?.products || []).map((p: any) => p.route) }, true);
      }
      case "lumi_seller_monitoring": {
        const id = str(args.enrollment_id);
        if (id && !/^men_[a-f0-9]{24}$/.test(id)) return text({ error: "enrollment_id must look like men_<24 hex>" }, true);
        if (!id) { const r = await deps.quote("/v1/monitor"); return text(r.body, r.status !== 200); }
        const [entry, badge] = await Promise.all([deps.quote(`/v1/monitor/sellers/${id}`), deps.quote(`/v1/monitor/badge/${id}.json`)]);
        if (entry.status !== 200) return text({ status: entry.status, body: entry.body }, true);
        return text({ ...entry.body, badge: badge.body });
      }
      case "lumi_trust_feed": {
        const [doc, lic] = await Promise.all([deps.quote("/v1/feed"), deps.quote("/v1/feed/license")]);
        return text({ ...(doc.body ?? {}), license_terms: lic.body }, doc.status !== 200);
      }
      case "lumi_coins": {
        const list = await deps.coins();
        return text(list.map((c) => ({ symbol: c.symbol, id: c.id, name: c.name, group: (c as any).group })));
      }
      case "lumi_vendor_scores": {
        if (!deps.trust) return text({ error: "trust layer unavailable" }, true);
        const lq = { url: str(args.url), domain: str(args.domain), payTo: str(args.payTo) ?? str(args.pay_to) };
        if (lq.url || lq.domain || lq.payTo) {
          // Empty optional args are ignored (MCP clients often send ""); non-empty but malformed ones are errors.
          const err = lookupError(lq);
          if (err) return text(err, true);
          return text(await deps.trust.lookup(lq, base, { free: true }));
        }
        const id = str(args.vendor_id);
        if (id) {
          const doc = await deps.trust.vendorDoc(id, base);
          return doc ? text(doc) : text({ error: "unknown vendor_id", list: `${base}/v1/trust/vendors` }, true);
        }
        return text(await deps.trust.vendorsDoc(base));
      }
      case "lumi_quote": {
        const path = str(args.path);
        if (!path || !/^\/v1\/[A-Za-z0-9/_.?=&%-]*$/.test(path)) return text({ error: "path must be a Lumi paid path such as /v1/brief or /v1/signal/XRP" }, true);
        const r = await deps.quote(path);
        if (r.status !== 402) return text({ status: r.status, body: r.body });
        return text({
          status: 402,
          resource: r.body?.resource?.url,
          description: r.body?.resource?.description,
          options: (r.body?.accepts || []).map((a: any) => ({
            asset: a.asset === "XRP" ? "XRP" : a.extra?.symbol ?? a.asset,
            amount: a.asset === "XRP" ? dropsToXrp(String(a.amount)) : String(a.network).startsWith("eip155:") ? atomicToUsdc(String(a.amount)) : a.amount,
            network: a.network,
            payTo: a.payTo,
            ...(String(a.network).startsWith("eip155:") ? { token: a.asset } : {}),
          })),
        });
      }
    }

    const tool = PAID_TOOLS.find((t) => t.name === name)!;
    let coinArg: string | undefined;
    if (tool.coin) {
      coinArg = tool.coin(args)?.trim();
      if (!coinArg) {
        return text({ error: tool.argName === "vendor_id" ? "missing required argument: vendor_id (e.g. printmoneylab; list with lumi_vendor_scores)" : tool.argName === "url" ? "missing required argument: url (the x402 resource URL you are about to pay)" : "missing required argument: coin (ticker or CoinGecko id, e.g. XRP)" }, true);
      }
    }
    if ((tool.name === "lumi_brief" || tool.name === "lumi_institutional_brief") && args.format !== undefined && args.format !== "json" && args.format !== "md") {
      return text({ error: "format must be json or md" }, true);
    }

    // Freshness gate first (same as the REST paywall): missing/stale/empty data is an error and is never charged.
    const prep = await deps.prepare(tool.route, coinArg, base);
    deps.log({ event: "mcp_tool_call", tool: name, access, ok: prep.ok, ...(prep.ok ? {} : { status: prep.status }) });
    if (!prep.ok) return text({ status: prep.status, ...prep.error }, true);

    const restUrl = `${base}${tool.path({ ...args, coin: prep.coin?.symbol ?? coinArg, ...(tool.argName === "vendor_id" ? { vendor_id: String(prep.body.id ?? coinArg) } : {}) })}`;
    if (owner) {
      if ((tool.name === "lumi_brief" || tool.name === "lumi_institutional_brief") && args.format === "md") {
        const md = String((prep.body as { markdown?: string }).markdown ?? "");
        return text(`${md}\n\n_${DISCLAIMER}_`);
      }
      return text({ ...prep.body, access: { mode: "owner", charged: false, via: "remote MCP" }, ...(tool.route === "vendor_report" ? {} : { note: tool.route === "trust_check" ? TRUST_DISCLAIMER : DISCLAIMER }) });
    }
    return paymentRequired(tool, restUrl, cfg, base);
  } catch (err) {
    deps.log({ event: "mcp_tool_error", tool: name, error: String((err as Error)?.message ?? err) });
    return text({ error: "internal_error", detail: "The tool failed before any payment. Not charged.", retryable: true }, true);
  }
}

function paymentRequired(tool: PaidTool, restUrl: string, cfg: Config, base: string): ToolResult {
  const endpoint = PAID_ENDPOINTS.find((e) => e.route === tool.route)!;
  const xrp = dropsToXrp(cfg.pricesDrops[tool.route]);
  const prices: Record<string, unknown>[] = [
    { asset: "XRP", amount: xrp, network: cfg.network },
    ...cfg.ious.map((o) => ({ asset: o.symbol, amount: o.prices[tool.route], issuer: o.issuer, network: cfg.network })),
  ];
  if (cfg.evm) prices.push({ asset: "USDC", amount: cfg.evm.prices[tool.route], network: cfg.evm.network, token: cfg.evm.asset });
  const xrplText = prices.filter((p) => p.network === cfg.network).map((p) => `${p.amount} ${p.asset}`).join(" or ");
  // Base USDC first (gasless, most agent wallets hold it), the XRP Ledger second.
  const priceText = cfg.evm
    ? `${cfg.evm.prices[tool.route]} USDC on ${cfg.evm.networkName}, or ${xrplText} on the XRP Ledger`
    : `${xrplText} on the XRP Ledger`;
  const priceTextAll = cfg.stellar ? `${priceText}, or ${cfg.stellar.prices[tool.route]} USDC on ${cfg.stellar.networkName}` : priceText;
  const summary =
    `${tool.name} is a paid Lumi tool: ${priceTextAll} per call (x402). ` +
    "This remote MCP connection has no wallet, so nothing was charged and no data was returned. " +
    "The data is fresh and available right now. To get it, either pay per call via x402 at the REST endpoint below, " +
    `or install the ${NPM_PACKAGE} MCP server (npm) with your own wallet (USDC on Base, or the XRP Ledger) so it can pay automatically within spend caps.`;
  return text(
    summary +
      "\n\n" +
      JSON.stringify(
        {
          status: "payment_required",
          charged: false,
          tool: tool.name,
          what_you_get: endpoint.summary,
          price: [...(cfg.evm ? [prices[prices.length - 1], ...prices.slice(0, -1)] : prices), ...(cfg.stellar ? [{ asset: "USDC", amount: cfg.stellar.prices[tool.route], network: cfg.stellar.network, token: cfg.stellar.asset }] : [])],
          network: cfg.network,
          pay_to: cfg.payTo,
          ...(cfg.evm ? { base: { network: cfg.evm.network, pay_to: cfg.evm.payTo, asset: cfg.evm.asset } } : {}),
          ...(cfg.stellar ? { stellar: { network: cfg.stellar.network, pay_to: cfg.stellar.payTo, asset: cfg.stellar.asset } } : {}),
          how_to_pay: [
            {
              option: "x402 REST call",
              url: restUrl,
              steps:
                "GET the URL -> HTTP 402 with x402 v2 terms (PAYMENT-REQUIRED); sign an EIP-3009 USDC authorization on Base (or an XRPL Payment) for the quoted amount; " +
                "retry with the PAYMENT-SIGNATURE header -> 200 with the data. @x402/fetch + @x402/evm (Base) or the x402-xrpl SDK (npm or PyPI) does this in one call" +
                (cfg.stellar ? "; on Stellar, @x402/fetch + @x402/stellar signs a USDC transfer (fees sponsored)." : "."),
              guide: `${base}/skill.md`,
            },
            ...(cfg.evm
              ? [
                  {
                    option: `npm MCP server (${NPM_PACKAGE}), USDC on ${cfg.evm.networkName} (recommended)`,
                    install: `npx -y ${NPM_PACKAGE}`,
                    config: { command: "npx", args: ["-y", NPM_PACKAGE], env: { EVM_PRIVATE_KEY: "<your Base agent wallet key, signed locally; holds USDC, no ETH needed>", LUMI_MAX_USD_PER_CALL: "0.30", LUMI_SESSION_BUDGET: "1" } },
                    note: "Gasless: pays with an EIP-3009 USDC authorization (the facilitator pays gas). Runs locally over stdio within per-call caps and a session budget.",
                  },
                ]
              : []),
            {
              option: `npm MCP server (${NPM_PACKAGE}), XRP Ledger`,
              install: `npx -y ${NPM_PACKAGE}`,
              config: { command: "npx", args: ["-y", NPM_PACKAGE], env: { XRPL_SEED: "<your XRPL wallet seed, signed locally>", LUMI_PAY_ASSET: "XRP", LUMI_MAX_XRP_PER_CALL: Number(xrp) > 0.05 ? "0.25" : "0.05", ...(Number(cfg.ious[0]?.prices[tool.route] ?? 0) > 0.05 ? { LUMI_MAX_USD_PER_CALL: "0.3" } : {}), LUMI_SESSION_BUDGET: "1" } },
              note: "Runs locally over stdio and pays from your wallet within per-call caps and a session budget.",
            },
          ],
          free_tools: ["lumi_catalog", "lumi_coins", "lumi_samples", "lumi_quote", "lumi_vendor_scores", "lumi_seller_monitoring", "lumi_trust_feed"],
          free_sample: `${base}/v1/samples`,
          disclaimer: tool.route === "trust_check" || tool.route === "vendor_report" ? TRUST_DISCLAIMER : DISCLAIMER,
          ...(MARKET_IDEAS_ROUTES.includes(tool.route) ? { product_line: MARKET_IDEAS_NAME, notice: MARKET_IDEAS_NOTICE } : {}),
        },
        null,
        2,
      ),
    true,
  );
}
