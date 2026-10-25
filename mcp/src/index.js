#!/usr/bin/env node
/**
 * lumi-trades-mcp: stdio MCP server for the Lumi API (https://api.lumitrades.io).
 * Paid tools pay per call via x402 with YOUR wallet: XRP/RLUSD/USDC on the XRP Ledger (XRPL_SEED) or USDC on Base (EVM_PRIVATE_KEY),
 * within per-call caps and a session budget.
 * Analytics and education only, not financial advice.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient, loadSettings, assetLabel } from "./lumi.js";
import { registerContribTools, checkLumiReceipt } from "./contrib.js";

const VENDOR_LOOKUP_DESCRIPTION =
  "Free. Check an x402 seller before you pay it: pass url (the resource you are about to buy), domain, or payTo (the address in its 402 quote, case-insensitive). Lumi ingests the full CDP x402 Bazaar catalog daily and runs free, unpaid 402-quote checks of listings on a rotating schedule (valid quote, price and payTo vs the listing, latency, domain age; live coverage counts in the response), labelled 'quote-verified, low confidence', plus Lumi's own test-buys confirmed on-chain, labelled 'purchase-verified' and counted per chain (Base USDC buys of Bazaar listings; XRPL buys of a small curated list, separately). Answer-only: tx evidence is in the paid trust check. Observations, not ratings; no match is not a negative signal. With no arguments: the curated XRPL vendor scores and catalog counts; vendor_id gives one curated vendor's summary (tx evidence is in the paid vendor report).";

export const VERSION = "0.9.6";

/** Paid tools: name -> API path builder + description (prices are read live from the API's 402 quote). */
export const PAID_TOOLS = [
  {
    name: "lumi_brief",
    path: (a) => `/v1/brief${a.format === "md" ? "?format=md" : ""}`,
    input: { format: z.enum(["json", "md"]).optional().describe("json (default) or md for ready-to-post markdown") },
    description:
      "Today's crypto market brief from Lumi: BTC price/levels/signal, CoinMarketCap Fear & Greed, funding, top/bottom movers, key levels for 14 coins, yen watch, events in the next 48h, Lumi's current paper-trade ideas (pending/open only, no outcomes or P/L), sourced news. Paid: $0.02 per call (USDC on Base; or RLUSD, USDC or XRP at the live rate on the XRP Ledger).",
  },
  {
    name: "lumi_signal",
    path: (a) => `/v1/signal/${encodeURIComponent(a.coin)}`,
    input: { coin: z.string().describe("Ticker or CoinGecko id, any of the 51 in lumi_coins, e.g. BTC ETH XRP SOL AVAX TRX") },
    description: "Lumi Market Ideas. Paper-trade analysis, not investment advice. Lumi does not trade real money. Mechanical buy/sell read for one of 51 coins, computed live (1h refreshed about every 13 minutes): overall label + score, 1h/4h/1d labels and indicators (RSI, MACD, EMA, Bollinger, StochRSI, volume). Paid: $0.01 per call (USDC on Base; or RLUSD, USDC or XRP at the live rate on the XRP Ledger).",
  },
  {
    name: "lumi_levels",
    path: (a) => `/v1/levels/${encodeURIComponent(a.coin)}`,
    input: { coin: z.string().describe("Ticker or CoinGecko id of a watchlist/major coin, e.g. XRP BTC ETH") },
    description: "Lumi Market Ideas. Paper-trade analysis, not investment advice. Lumi does not trade real money. Lumi's support/resistance levels, bias, rule-based 7-day bull/base/bear scenario levels (not forecasts), commentary, catalysts and sources for one coin. Paid: $0.01 per call (USDC on Base, or XRP/RLUSD/USDC on the XRP Ledger).",
  },
  { name: "lumi_scan", path: () => "/v1/scan", input: {}, description: "Lumi Market Ideas. Paper-trade analysis, not investment advice. Lumi does not trade real money. Whole-market screen in one call: buy/sell label, score, 1h/4h/1d labels, 1h RSI, price and 24h change for 50 large-cap coins, strongest first, plus label counts and breadth. Computed live. Paid: $0.02 per call (USDC on Base, or XRP/RLUSD/USDC on the XRP Ledger)." },
  {
    name: "lumi_lite",
    path: (a) => `/v1/lite/${encodeURIComponent(a.coin)}`,
    input: { coin: z.string().describe("Ticker or CoinGecko id, any of the 51 in lumi_coins, e.g. BTC ETH XRP") },
    description: "Lumi Market Ideas. Paper-trade analysis, not investment advice. Lumi does not trade real money. Cheap headline read for one coin: overall buy/sell label and score, 1h/4h/1d labels, price and 24h change (lumi_signal adds the indicator breakdown). Paid: $0.004 per call (USDC on Base, or XRP/RLUSD/USDC on the XRP Ledger).",
  },
  { name: "lumi_slate", path: () => "/v1/slate", input: {}, description: "Lumi Market Ideas. Paper-trade analysis, not investment advice. Lumi does not trade real money. Lumi's current paper-trade ideas (entry, stop, targets, leverage, conviction) and 'no setup' notes. Paid: $0.02 per call (USDC on Base, or XRP/RLUSD/USDC on the XRP Ledger)." },
  { name: "lumi_market", path: () => "/v1/market", input: {}, description: "BTC backdrop (levels, scenario levels, signal), macro (yen note, total cap, dominance, Fear & Greed, funding) and breadth. Paid: $0.02 per call (USDC on Base, or XRP/RLUSD/USDC on the XRP Ledger)." },
  { name: "lumi_macro_yen", path: () => "/v1/macro/yen", input: {}, description: "Yen carry-trade watch: USD/JPY, Nikkei 225, rule-based carry-trade risk (low/watch/elevated) around 155, Japan events (BOJ, CPI). Paid: $0.01 per call (USDC on Base, or XRP/RLUSD/USDC on the XRP Ledger)." },
  { name: "lumi_sentiment", path: () => "/v1/sentiment", input: {}, description: "CoinMarketCap Fear & Greed, BTC perp funding with a plain-English read, open interest, total cap/dominance, breadth across 14 coins. Paid: $0.005 per call (USDC on Base, or XRP/RLUSD/USDC on the XRP Ledger)." },
  { name: "lumi_events", path: () => "/v1/events", input: {}, description: "Sourced upcoming macro/crypto events (timed releases in UTC + US Central, and dated per-coin catalysts). Paid: $0.005 per call (USDC on Base, or XRP/RLUSD/USDC on the XRP Ledger)." },
  { name: "lumi_funding", path: () => "/v1/funding", input: {}, description: "Perpetual funding rates for every Lumi coin listed on OKX (rate, 8h-normalised, annualised, next funding time, plain-English read), BTC read, median, most positive/negative. Refreshed every 15 minutes. Paid: $0.003 per call (USDC on Base, or XRP/RLUSD/USDC on the XRP Ledger)." },
  { name: "lumi_fear_greed", path: () => "/v1/fear-greed", input: {}, description: "CoinMarketCap Fear & Greed now, yesterday, last week and last month, change vs each, yearly high/low and a 30-day series. Refreshed every 30 minutes. Paid: $0.003 per call (USDC on Base, or XRP/RLUSD/USDC on the XRP Ledger)." },
  { name: "lumi_events_48h", path: () => "/v1/events/next48h", input: {}, description: "What is scheduled in the next 48 hours: macro releases and decisions with UTC + US Central times, why each matters and its source, plus dated coin catalysts. Paid: $0.003 per call (USDC on Base, or XRP/RLUSD/USDC on the XRP Ledger)." },
  {
    name: "lumi_institutional_brief",
    path: (a) => `/v1/institutional${a.format === "md" ? "?format=md" : ""}`,
    input: { format: z.enum(["json", "md"]).optional().describe("json (default) or md for ready-to-read markdown") },
    description:
      "Daily policy brief: what BIS, IMF, US Treasury/OCC, Fed, SEC, CFTC, JPMorgan (Kinexys), SBI, Cross River, Securitize, R3 " +
      "and other banks, central banks and tokenization firms did in the last days, and how each move maps to XRP, XLM, XDC, QNT, AXL and HBAR (plus RLUSD/USDC). " +
      "Every item is dated and sourced, with why it matters, impact and confidence, and a link_type that separates confirmed links from Lumi's " +
      "indirect-alignment analysis (institution goals vs token mission, both sides quoted). Includes a per-token map, connections, no-news notes and " +
      "what to watch next. Refreshed daily; never sold stale. Paid: $0.10 per call (USDC on Base; or RLUSD, USDC or XRP at the live rate on the XRP Ledger); " +
      "allowed by the default caps (LUMI_MAX_USD_PER_CALL 0.30, LUMI_MAX_XRP_PER_CALL 0.25). Not financial advice.",
  },
  {
    name: "lumi_trust_check",
    path: (a) => {
      const q = new URLSearchParams({ url: String(a.url ?? "") });
      if (a.payTo) q.set("payTo", String(a.payTo));
      if (a.amount !== undefined) q.set("amount", String(a.amount));
      return `/v1/trust/check?${q}`;
    },
    input: {
      url: z.string().describe("The x402 resource URL you are about to pay"),
      payTo: z.string().optional().describe("Optional: the payTo address in its 402 quote"),
      amount: z.string().optional().describe("Optional: the quoted price in USD, e.g. 0.01"),
    },
    description:
      "Should I pay this x402 URL? allow / warn / block with coded reasons, from Lumi's daily CDP Bazaar index, free 402-quote checks and Lumi's own test-buys (Base USDC for Bazaar listings; XRPL only for a small curated vendor list, counted separately). " +
      "Pass url, and optionally the payTo and USD amount you were quoted, to catch address or price mismatches. Links the free lookup and, for curated vendors, the $0.02 full report. " +
      "Observations, not a guarantee. Paid: $0.004 per call (USDC on Base, or XRP/RLUSD/USDC on the XRP Ledger).",
  },
  {
    name: "lumi_vendor_report",
    path: (a) => `/v1/trust/vendors/${encodeURIComponent(a.vendor_id)}/report`,
    input: { vendor_id: z.string().regex(/^[a-z0-9-]{1,64}$/).describe("Vendor id from lumi_vendor_scores, e.g. printmoneylab") },
    description:
      "Detailed report on one x402 vendor from Lumi's trust list: full observation history (every free 402-quote check over 90 days, every paid test-buy with tx hash and delivered yes/no), " +
      "latency stats and 7-day trend, uptime % (24h/7d/30d/90d) and daily series, quoted-price history, verified agent reports, vendor replies, sample sizes and confidence labels. " +
      "Automated observations, not a rating. Paid: $0.02 per call (USDC on Base, or XRP/RLUSD/USDC on the XRP Ledger). The free summary is lumi_vendor_scores.",
  },
];

const DISCLAIMER = "Lumi Trades data: analytics and education only, not financial advice. Trade ideas are paper trades.";
const TRUST_DISCLAIMER = "Automated observations by Lumi, not a rating, endorsement or guarantee. Not financial advice.";
const MARKET_IDEAS_NAME = "Lumi Market Ideas";
const MARKET_IDEAS_NOTICE = "Paper-trade analysis, not investment advice. Lumi does not trade real money.";
const MARKET_IDEAS_TOOLS = new Set(["lumi_signal", "lumi_lite", "lumi_scan", "lumi_slate", "lumi_levels"]);
const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });

export function buildServer(client, opts = {}) {
  const server = new McpServer({ name: "lumi-trades-mcp", version: VERSION });
  const s = client.settings;
  registerContribTools(server, s, opts.contrib);

  server.registerTool(
    "lumi_catalog",
    { title: "Lumi: endpoints and prices (free)", description: "Free. Lists Lumi API endpoints, live prices (USD; XRP / RLUSD / USDC on the XRP Ledger or USDC on Base), payment settings of this MCP server and the caller wallet address.", inputSchema: {} },
    async () => {
      const r = await client.free("/");
      const a = assetLabel(s.asset);
      return text({
        api: s.apiUrl,
        network: s.rail === "base" ? "eip155:8453 (Base)" : s.network,
        pay_with: a,
        wallet: (await client.walletAddress()) ?? "not configured (set XRPL_SEED for the XRP Ledger or EVM_PRIVATE_KEY for USDC on Base to enable paid tools)",
        caps: {
          per_call: s.asset === "XRP" ? `${s.maxXrpPerCall} XRP (LUMI_MAX_XRP_PER_CALL)` : `${s.maxUsdPerCall} ${a} (LUMI_MAX_USD_PER_CALL)`,
          session_budget: `${s.budget} ${a} (LUMI_SESSION_BUDGET)`,
          spent: `${client.ledger.spent} ${a}`,
        },
        endpoints: r.body?.paid_endpoints?.map((e) => ({ path: e.path, prices: e.prices, summary: e.summary })) ?? r.body,
        guarantee: r.body?.guarantee,
      });
    },
  );

  server.registerTool(
    "lumi_coins",
    { title: "Lumi: supported coins (free)", description: "Free. The 51 coins Lumi covers (tickers and CoinGecko ids). Lumi Market Ideas (paper-trade analysis, not investment advice): signals for all 51; levels only for the 14 watchlist and major coins.", inputSchema: {} },
    async () => {
      const r = await client.free("/v1/coins");
      return text(r.body?.coins?.map((c) => ({ symbol: c.symbol, id: c.id, name: c.name, group: c.group })) ?? r.body);
    },
  );

  server.registerTool(
    "lumi_samples",
    {
      title: "Lumi: free samples of every paid product",
      description:
        "Free. A truncated, clearly labelled SAMPLE of each paid product (signal, lite, scan, levels, slate, market, brief, yen, sentiment, funding, fear_greed, events, events_48h, institutional brief, trust_check, vendor report) with its USD price and full URL, so you can judge it before paying. Lists are cut to 2 entries; up to 10 minutes old. Pass route to get one product.",
      inputSchema: { route: z.string().regex(/^[a-z_]{1,32}$/).optional().describe("Optional product route, e.g. institutional or signal") },
    },
    async ({ route }) => {
      const r = await client.free("/v1/samples");
      if (!route || r.status !== 200) return text(r.body);
      const one = (r.body?.products || []).find((p) => p.route === route);
      return text(one ? { label: r.body.label, ...one } : { error: "unknown route", routes: (r.body?.products || []).map((p) => p.route) });
    },
  );

  server.registerTool(
    "lumi_quote",
    {
      title: "Lumi: price check without paying (free)",
      description: "Free. Shows the x402 price quote (XRP / RLUSD / USDC on the XRP Ledger, USDC on Base) for any Lumi paid path, e.g. /v1/brief, without paying. A 503 means the data is not fresh right now and the call would not be sold.",
      inputSchema: { path: z.string().regex(/^\/v1\//).describe("Paid API path, e.g. /v1/brief or /v1/signal/XRP") },
    },
    async ({ path }) => text(await client.quote(path)),
  );

  server.registerTool(
    "lumi_vendor_scores",
    {
      title: "Lumi: x402 vendor observations (free)",
      description: VENDOR_LOOKUP_DESCRIPTION,
      inputSchema: {
        url: z.string().max(500).optional().describe("Resource URL you are about to pay, e.g. https://example.com/api/data"),
        domain: z.string().max(253).optional().describe("Seller host or domain, e.g. example.com"),
        payTo: z.string().max(120).optional().describe("payTo address from the seller's 402 quote (0x... or r...)"),
        vendor_id: z.string().regex(/^[a-z0-9-]{1,64}$/).optional().describe("Optional curated vendor id, e.g. printmoneylab"),
      },
    },
    async ({ url, domain, payTo, vendor_id }) => {
      let path = "/v1/trust/vendors";
      if (url || domain || payTo) {
        const q = new URLSearchParams();
        if (url) q.set("url", url);
        if (domain) q.set("domain", domain);
        if (payTo) q.set("payTo", payTo);
        path += "?" + q.toString();
      } else if (vendor_id) path += "/" + encodeURIComponent(vendor_id);
      const r = await client.free(path);
      return r.status === 200 ? text(r.body) : { ...text({ status: r.status, body: r.body }), isError: true };
    },
  );

  server.registerTool(
    "lumi_verdict",
    {
      title: "Lumi: one-label pre-payment check",
      description:
        "Before paying an x402 URL or seller domain: one label from the same data and signing key as Lumi's free /v1/check: checks_passed (Delivered in recent checks), check_first (Check first), checks_failed (Recent checks failed) or no_data (Not enough data), with as-of date, evidence window, conclusive test-buy count, last delivered/failed dates, reason codes, evidence and appeal links, and observed on-chain payments as ranges only. Free today; if Lumi prices it (at most $0.004) it is paid with your wallet within the configured caps. Paying Lumi never changes a result. Observations, not a guarantee.",
      inputSchema: {
        url: z.string().min(1).max(500).describe("The x402 resource URL (or the seller's domain) you are about to pay"),
        payTo: z.string().max(120).optional().describe("Optional: the payTo address in its 402 quote"),
        amount: z.string().max(20).optional().describe("Optional: the quoted price in USD, e.g. 0.01"),
      },
    },
    async ({ url, payTo, amount }) => {
      const q = new URLSearchParams({ url });
      if (payTo) q.set("payTo", payTo);
      if (amount) q.set("amount", amount);
      const path = "/v1/verdict?" + q.toString();
      const r = await client.free(path);
      if (r.status === 200) return text(r.body);
      if (r.status !== 402) return { ...text({ status: r.status, body: r.body }), isError: true };
      const p = await client.paid(path, "application/json");
      if (!p.paid) return { ...text(p), isError: p.status !== 402 || !!p.error };
      return text({ ...p.body, mcp_receipt: { tx: p.receipt?.transaction, network: p.receipt?.network, spent_this_session: p.spent_this_session } });
    },
  );

  server.registerTool(
    "lumi_seller_monitoring",
    {
      title: "Lumi: seller monitoring plans and monitored sellers (free)",
      description:
        "Free. For x402 sellers, priced per endpoint per 30 days: Watch $5 (hourly quote checks, weekly test-buy), Watch Plus $12 (30 min checks, daily test-buy rotating chains, schema/p95 alerts), Watch Pro $20 (15 min checks, daily buys on up to 3 chains, limited by the test-buy budget, signed monthly report); 10+ endpoints -20% or 3 terms prepaid -10% (not stacked: the larger applies). Audit $99 one-off. Free Watch tier (1 endpoint, daily quote check, no test-buys) and a one-per-seller 14-day Watch Plus trial (no card, never converts; on day 14 nothing is charged, checks stop, the badge comes off and history freezes read-only). Legacy Monitor/Monitor Plus are grandfathered. No auto-renew; payTo proven by signature; paying never changes a score. " +
        "No args: plans, enrolment steps and safeguards. enrollment_id: that seller's public entry (disclosure, findings, replies) and live badge status. Plans are paid over x402 at the REST URL.",
      inputSchema: { enrollment_id: z.string().regex(/^men_[a-f0-9]{24}$/).optional().describe("Optional enrollment id (men_...)") },
    },
    async ({ enrollment_id }) => {
      if (!enrollment_id) return text((await client.free("/v1/monitor")).body);
      const [e, b] = await Promise.all([client.free(`/v1/monitor/sellers/${enrollment_id}`), client.free(`/v1/monitor/badge/${enrollment_id}.json`)]);
      return e.status === 200 ? text({ ...e.body, badge: b.body }) : { ...text({ status: e.status, body: e.body }), isError: true };
    },
  );

  server.registerTool(
    "lumi_trust_feed",
    {
      title: "Lumi: trust data feed plans and licence (free)",
      description:
        "Free. Licensed trust data feed for facilitators, wallets and frameworks: free key with 1,000 lookups/month (wallet signature), $1.50 per 1,000 extra lookups, Feed $99/30 days, Feed Pro $199/30 days (snapshot export, webhooks). Returns plans, endpoints and licence terms (no resale, attribution).",
      inputSchema: {},
    },
    async () => text((await client.free("/v1/feed")).body),
  );

  for (const t of PAID_TOOLS) {
    server.registerTool(
      t.name,
      { title: `${MARKET_IDEAS_TOOLS.has(t.name) ? MARKET_IDEAS_NAME : "Lumi"}: ${t.name.replace(/^lumi_/, "").replace(/_/g, " ")} (paid)`, description: `${t.description} Pays with your own wallet via x402 (XRPL_SEED or EVM_PRIVATE_KEY) within the configured caps.`, inputSchema: t.input },
      async (args) => {
        const fmtMd = (t.name === "lumi_brief" || t.name === "lumi_institutional_brief") && args?.format === "md";
        const r = await client.paid(t.path(args ?? {}), fmtMd ? "text/markdown" : "application/json");
        if (!r.paid) return { ...text(r), isError: r.status !== 402 || !!r.error };
        const receipt = { tx: r.receipt?.transaction, network: r.receipt?.network, spent_this_session: r.spent_this_session };
        if (typeof r.body === "string") return text(`${r.body}\n\n[x402 receipt: ${JSON.stringify(receipt)}]`);
        // Paid trust/check: its lumi_receipt is kept only when signed by a pinned Lumi key.
        const body = t.name === "lumi_trust_check" ? await checkLumiReceipt(r.body, opts.contrib ?? {}) : r.body;
        return text({ ...body, mcp_receipt: receipt, ...(t.name === "lumi_vendor_report" ? {} : t.name === "lumi_trust_check" ? { note: TRUST_DISCLAIMER } : { note: DISCLAIMER }), ...(MARKET_IDEAS_TOOLS.has(t.name) ? { product_line: MARKET_IDEAS_NAME, notice: MARKET_IDEAS_NOTICE } : {}) });
      },
    );
  }
  return server;
}

async function main() {
  const settings = loadSettings();
  const client = createClient(settings);
  const server = buildServer(client);
  await server.connect(new StdioServerTransport());
  // stderr only: stdout is the MCP channel. Never print the seed.
  const wallet = await client.walletAddress();
  const where = settings.rail === "base" ? "Base (eip155:8453)" : settings.network;
  console.error(`lumi-trades-mcp ${VERSION}: ${settings.apiUrl}, paying in ${assetLabel(settings.asset)} (${where})${wallet ? ` from ${wallet}` : " (no wallet configured: free tools and quotes only)"}`);
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((e) => {
    console.error(`lumi-trades-mcp: ${e?.message ?? e}`);
    process.exit(1);
  });
}
