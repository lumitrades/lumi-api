/**
 * A2A (Agent2Agent) support: the agent card at /.well-known/agent-card.json (alias /.well-known/agent.json) and a small,
 * stateless JSON-RPC endpoint at /a2a.
 *
 * The card follows A2A 1.0 (supportedInterfaces, capabilities, skills) and also carries the 0.3 fields (url,
 * preferredTransport, protocolVersion) so 0.3 clients can read it. The endpoint answers `SendMessage` (1.0) and
 * `message/send` (0.3) with a direct Message (no task store): free skills answer inline, paid skills answer with the
 * live x402 terms for every network and the REST URL to pay at. Nothing is charged over A2A.
 */

import { planPriceTable } from "./commerce/discovery";
import type { Trust } from "./trust";
import type { Config } from "./config";
import { atomicToUsdc, dropsToXrp } from "./config";
import { PAID_ENDPOINTS, priceTable } from "./catalog";
import { VERSION, paymentNetworks, settledIn } from "./docs";
import { DISCLAIMER, type CoinRef } from "./views";
import type { PaidRoute } from "./config";
import { VENDORS } from "./vendors";
import { SERVICE_ICON } from "./bazaar";
import { MARKET_IDEAS_NAME, MARKET_IDEAS_NOTICE, MARKET_IDEAS_ROUTES } from "./lines";

const VENDOR_IDS = VENDORS.map((v) => v.id);

export const A2A_VERSIONS = ["1.0", "0.3"];

export const A2A_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, A2A-Version, A2A-Extensions, Authorization",
  "Access-Control-Max-Age": "86400",
};

interface SkillDef {
  id: string;
  route?: PaidRoute;
  name: string;
  tags: string[];
  examples: string[];
  /** Words that select this skill from free text. */
  match: RegExp;
  needsCoin?: boolean;
  needsVendor?: boolean;
  needsUrl?: boolean;
}

const SKILLS: SkillDef[] = [
  { id: "catalog", name: "Catalog: endpoints, prices, payment networks (free)", tags: ["catalog", "pricing", "x402", "free"], examples: ["catalog", "what do you sell and how much?"], match: /\b(catalog|prices?|pricing|endpoints?|help|menu)\b/i },
  { id: "coins", name: "Supported coins (free)", tags: ["coins", "free"], examples: ["list coins"], match: /\b(coins|supported|tickers)\b/i },
  { id: "vendor_trust", name: "x402 seller lookup and observations (free)", tags: ["trust", "x402", "vendors", "observations", "lookup", "bazaar", "free"], examples: ["vendor trust scores", "{\"skill\":\"vendor_trust\",\"url\":\"https://example.com/api/x402\"}", "{\"skill\":\"vendor_trust\",\"payTo\":\"0x...\"}", "{\"skill\":\"vendor_trust\",\"vendor_id\":\"printmoneylab\"}"], match: /\b(vendors?|trust)\b/i },
  { id: "seller_monitoring", name: "Seller monitoring plans for x402 sellers (info free; plans paid at the REST URL)", tags: ["monitoring", "x402", "sellers", "badge", "audit"], examples: ["seller monitoring plans", "{\"skill\":\"seller_monitoring\"}"], match: /\b(monitor(ing)?|badge|audit)\b/i },
  { id: "trust_feed", name: "Trust data feed for facilitators, wallets and frameworks (info free; keys and plans at the REST URL)", tags: ["data", "feed", "license", "trust", "x402"], examples: ["trust data feed", "{\"skill\":\"trust_feed\"}"], match: /\b(data feed|trust feed|feed|licen[cs]e|bulk lookup)\b/i },
  { id: "samples", name: "Free samples of every paid product", tags: ["samples", "preview", "free"], examples: ["samples", "show me a free sample"], match: /\b(samples?|preview|try|demo)\b/i },
  { id: "quote", name: "Price quote for a paid call, without paying (free)", tags: ["quote", "x402", "free"], examples: ["quote /v1/brief"], match: /\bquote\b/i },
  {
    id: "institutional",
    route: "institutional",
    name: "Daily Institutional & Policy Brief",
    tags: ["institutional", "policy", "regulation", "cbdc", "tokenization", "stablecoins", "xrp", "xlm", "xdc", "qnt", "axl", "hbar", "paid"],
    examples: ["institutional brief", "what are BIS, IMF and the big banks doing that matters for XRP and QNT?"],
    match: /\b(institution(al|s)?|policy|regulat(ion|ions|ory|ors?)|bis|imf|treasury|occ|sec|cftc|cbdcs?|jpmorgan|jpm|kinexys|sbi|cross river|securitize|corda|r3|banks?|tokeni[sz](ed|ation))\b/i,
  },
  { id: "brief", route: "brief", name: "Daily crypto market brief", tags: ["crypto", "market", "brief", "newsletter", "paid"], examples: ["today's crypto market brief"], match: /\b(brief|summary|today|newsletter)\b/i },
  { id: "scan", route: "scan", name: "Lumi Market Ideas: all-coins scan, 50 live signals in one call", tags: ["crypto", "screener", "signals", "scan", "market-ideas", "paid"], examples: ["scan all coins", "which coins look strongest?"], match: /\b(scan|screen|screener|all coins|strongest|weakest)\b/i },
  { id: "lite", route: "lite", name: "Lumi Market Ideas: lite coin signal (label, score, price)", tags: ["crypto", "signal", "lite", "market-ideas", "paid"], examples: ["lite XRP"], match: /\blite\b/i, needsCoin: true },
  { id: "signal", route: "signal", name: "Lumi Market Ideas: coin signal (buy/sell read)", tags: ["crypto", "signal", "technical-analysis", "market-ideas", "paid"], examples: ["signal XRP", "is BTC a buy?"], match: /\b(signal|buy|sell|rsi|macd)\b/i, needsCoin: true },
  { id: "levels", route: "levels", name: "Lumi Market Ideas: support/resistance + rule-based 7-day scenario levels (not forecasts)", tags: ["crypto", "levels", "support", "resistance", "market-ideas", "paid"], examples: ["levels ETH"], match: /\b(levels?|support|resistance|projection|scenarios?)\b/i, needsCoin: true },
  { id: "slate", route: "slate", name: "Lumi Market Ideas: paper-trade slate (current ideas)", tags: ["crypto", "trade-ideas", "paper-trading", "market-ideas", "paid"], examples: ["current trade ideas"], match: /\b(slate|ideas?|setups?)\b/i },
  { id: "market", route: "market", name: "BTC + macro market backdrop", tags: ["crypto", "bitcoin", "macro", "paid"], examples: ["BTC macro backdrop"], match: /\b(market|backdrop|macro|dominance)\b/i },
  { id: "macro_yen", route: "yen", name: "Yen carry-trade watch (USD/JPY, Nikkei)", tags: ["macro", "yen", "carry-trade", "japan", "paid"], examples: ["yen carry trade risk"], match: /\b(yen|jpy|usd\/?jpy|nikkei|carry|japan|boj)\b/i },
  { id: "funding", route: "funding", name: "Perpetual funding rates (50 coins)", tags: ["crypto", "funding", "perpetuals", "derivatives", "paid"], examples: ["funding rates"], match: /\bfunding\b/i },
  { id: "fear_greed", route: "fear_greed", name: "Fear & Greed (CoinMarketCap, with history)", tags: ["crypto", "sentiment", "fear-greed", "paid"], examples: ["fear and greed index"], match: /\bfear\b.*\bgreed\b|\bfear[-_ ]?greed\b/i },
  { id: "events_48h", route: "events_48h", name: "Events in the next 48 hours", tags: ["macro", "events", "calendar", "48h", "paid"], examples: ["what's scheduled in the next 48 hours?"], match: /\b(48 ?h(ours)?|next two days|tomorrow)\b/i },
  { id: "sentiment", route: "sentiment", name: "Crypto sentiment (Fear & Greed, funding)", tags: ["crypto", "sentiment", "fear-greed", "funding", "paid"], examples: ["fear and greed"], match: /\b(sentiment|fear|greed|funding|mood)\b/i },
  { id: "events", route: "events", name: "Macro + crypto events calendar", tags: ["macro", "events", "calendar", "paid"], examples: ["upcoming events"], match: /\b(events?|calendar|fomc|cpi|schedule)\b/i },
  {
    id: "vendor_report",
    route: "vendor_report",
    name: "x402 vendor report: full observation history for one vendor (paid)",
    tags: ["trust", "x402", "vendors", "observations", "report", "paid"],
    examples: ["vendor report printmoneylab", "{\"skill\":\"vendor_report\",\"vendor_id\":\"printmoneylab\"}"],
    match: /\b(vendor|trust)\s+report\b|\breport\b.*\bvendor\b/i,
    needsVendor: true,
  },
  {
    id: "trust_check",
    route: "trust_check",
    name: "Should I pay this x402 URL? allow / warn / block (paid)",
    tags: ["trust", "x402", "payment-safety", "check", "paid"],
    examples: ["should I pay https://api.example.com/v1/data", "{\"skill\":\"trust_check\",\"url\":\"https://api.example.com/v1/data\",\"payTo\":\"0x...\",\"amount\":\"0.01\"}"],
    match: /\b(should i pay|pay[- ]check|trust[- ]check|safe to pay)\b/i,
    needsUrl: true,
  },
  { id: "trades", route: "trades", name: "Lumi Market Ideas: paper-trade history", tags: ["crypto", "paper-trading", "market-ideas", "paid"], examples: ["your paper-trade history"], match: /\b(trades|trade history|paper[- ]?trades?)\b/i },
];

const FREE_DESCRIPTIONS: Record<string, string> = {
  catalog: "Lists every Lumi endpoint with live prices on every payment network (XRP Ledger, Base, Stellar), the MCP and A2A endpoints, and the no-charge-when-stale guarantee.",
  coins: "The 50 coins Lumi covers (tickers and CoinGecko ids). Lumi Market Ideas (paper-trade analysis, not investment advice): signals for all, levels for the watchlist and majors.",
  vendor_trust:
    "Check an x402 seller before paying it: {\"url\":\"...\"}, {\"domain\":\"...\"} or {\"payTo\":\"...\"} (case-insensitive) looks it up in the full CDP x402 Bazaar catalog (free quote checks of listings on a rotating schedule: 'quote-verified, low confidence'; live coverage counts in the response) and Lumi's on-chain-confirmed test-buys ('purchase-verified', counted per chain: Base USDC for Bazaar listings, XRPL for a small curated list). Answer-only; tx evidence is in the paid trust check. With no arguments: curated XRPL vendor observations; {\"vendor_id\":\"...\"} for one vendor's summary. Observations, not ratings; no match is not a negative signal.",
  samples: "Free, clearly labelled SAMPLE previews of every paid product (truncated, up to 10 minutes old), with the USD price of each. Use it to see the output shape before paying.",
  seller_monitoring:
    "For x402 sellers: Monitor $9/30 days (1 endpoint, test-buy per term + alerts), Monitor Plus $29/30 days (weekly test-buys, up to 20 endpoints), Audit $99 one-off (every listed endpoint, signed report). Seller-funded, no auto-renew, payTo proven by signature; paying never changes a score. Answers with the plan table and enrolment steps; payment happens at GET /v1/monitor/subscribe/{plan}?enrollment=.",
  trust_feed:
    "Licensed trust data feed: free key with 1,000 lookups/month (wallet signature), $1.50 per 1,000 extra lookups, Feed $99/30 days, Feed Pro $199/30 days (snapshot export, webhooks). Answers with plans, endpoints and licence terms; keys and payments at the REST URLs under /v1/feed.",
  quote: "Live x402 v2 quote (all accepts options) for a paid skill or path, e.g. {\"skill\":\"signal\",\"coin\":\"XRP\"} or \"quote /v1/brief\". A 503 means the data is not fresh right now and would not be sold.",
};

function priceLine(cfg: Config, route: PaidRoute): string {
  const parts = [`${dropsToXrp(cfg.pricesDrops[route])} XRP`, ...cfg.ious.map((o) => `${o.prices[route]} ${o.symbol}`)];
  const xrpl = `${parts.join(" / ")} on the XRP Ledger`;
  const st = cfg.stellar ? `, or ${cfg.stellar.prices[route]} USDC on ${cfg.stellar.networkName}` : "";
  return (cfg.evm ? `${xrpl}, or ${cfg.evm.prices[route]} USDC on ${cfg.evm.networkName}` : xrpl) + st;
}

export function agentCard(cfg: Config, base: string) {
  const a2aUrl = `${base}/a2a`;
  // Card order leads with the trust check (matching order in SKILLS is unchanged).
  const LEAD = ["trust_check", "vendor_trust", "vendor_report"];
  const ordered = [...SKILLS.filter((s) => LEAD.includes(s.id)).sort((a, b) => LEAD.indexOf(a.id) - LEAD.indexOf(b.id)), ...SKILLS.filter((s) => !LEAD.includes(s.id))];
  const skills = ordered.map((s) => {
    const ep = s.route ? PAID_ENDPOINTS.find((e) => e.route === s.route)! : undefined;
    return {
      id: s.id,
      name: s.name,
      description: ep
        ? `${ep.summary} Paid per call via x402 at ${base}${ep.template}: ${priceLine(cfg, s.route!)}. Over A2A this skill returns the live payment terms; it is never charged when data is stale.`
        : FREE_DESCRIPTIONS[s.id],
      tags: s.tags,
      examples: s.examples,
      inputModes: ["text/plain", "application/json"],
      outputModes: ["application/json", "text/plain"],
    };
  });
  return {
    name: "Lumi Trades",
    description:
      "Should I pay this x402 URL? Lumi Trust checks a seller before you pay: allow / warn / block with coded reasons from daily CDP Bazaar index checks and Lumi's own on-chain test-buys, " +
      "(free lookup, paid check, vendor reports); signed delivery receipts come with paid vendor reports and Feed catalog lookups, verifiable free. " +
      "Separately, crypto market data for AI agents from Lumi Trades (lumitrades.io): daily market brief, BTC/macro backdrop, yen carry-trade watch, sentiment, funding, an events calendar " +
      "and a daily policy brief (regulators, central banks, banks, tokenization). " +
      `And ${MARKET_IDEAS_NAME}, a separate product line (${MARKET_IDEAS_NOTICE}): per-coin signals, lite reads, the all-coins scan, support/resistance levels and paper-trade ideas and history (signals cover the top 50 coins; levels and paper trades cover 13 tracked coins). ` +
      `Pay per call over x402 v2 with no API key or account, in ${settledIn(cfg)}. Also available as a remote MCP server. Analytics only, not financial advice.`,
    // A2A 1.0
    supportedInterfaces: A2A_VERSIONS.map((v) => ({ url: a2aUrl, protocolBinding: "JSONRPC", protocolVersion: v })),
    provider: { organization: "Lumi Trades", url: "https://lumitrades.io" },
    iconUrl: SERVICE_ICON,
    version: VERSION,
    documentationUrl: `${base}/skill.md`,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [
        {
          uri: "https://x402.org",
          description:
            "Paid skills are HTTP endpoints priced with x402 v2 (HTTP 402 + PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE). " +
            "accepts[] lists USDC on Base first, then XRP, RLUSD and USDC on the XRP Ledger, then USDC on Stellar; pick by network and asset. Payment happens at the REST URL, not in-band over A2A.",
          required: false,
          params: {
            x402Version: 2,
            scheme: "exact",
            networks: paymentNetworks(cfg),
            discovery: `${base}/.well-known/x402`,
            openapi: `${base}/openapi.json`,
            prices: priceTable(cfg).map((p) => ({ path: p.path, prices: p.prices })),
            plans: planPriceTable(base).map((p) => ({ path: p.path, name: p.name, price_usd: p.price_usd, term_days: p.term_days, auto_renew: false })),
            guarantee: "Inputs are checked (present, non-empty, fresh) before any 402 quote; stale data is answered with 503 'Not charged.'",
            idempotency: "Send an Idempotency-Key header (or the x402 payment-identifier extension id) with a payment: a retry with the same key and payment returns the cached response and is never charged twice.",
            attestation: {
              type: "signed-receipts",
              receipts: "counterparty_delivery_receipt v0.1 (SHA-256 receipt_hash, signed by the paying wallet) on Lumi Trust test-buys",
              verify: `${base}/v1/trust/receipts/verify`,
            },
          },
        },
        {
          uri: "https://modelcontextprotocol.io",
          description: "The same tools over MCP (Streamable HTTP, stateless).",
          required: false,
          params: { url: `${base}/mcp`, transport: "streamable-http", stdioPackage: "lumi-trades-mcp" },
        },
      ],
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json", "text/plain"],
    skills,
    // A2A 0.3 compatibility (ignored by 1.0 clients)
    protocolVersion: "0.3.0",
    url: a2aUrl,
    preferredTransport: "JSONRPC",
    additionalInterfaces: [{ url: a2aUrl, transport: "JSONRPC" }],
    supportsAuthenticatedExtendedCard: false,
  };
}

// ---------------------------------------------------------------- JSON-RPC

export interface A2aDeps {
  config: Config;
  coins(): Promise<CoinRef[]>;
  /** Unpaid internal GET of a paid path (returns the 402 terms, or a not-charged error). */
  quote(path: string): Promise<{ status: number; body: any }>;
  /** Trust layer (free vendor observations). */
  trust?: Pick<Trust, "vendorsDoc" | "vendorDoc" | "lookup">;
  /** Free samples document (same as GET /v1/samples). */
  samples?(): Promise<Record<string, unknown>>;
  log(event: Record<string, unknown>): void;
}

type Id = string | number | null;
const rpc = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id: Id, code: number, message: string, reason?: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(reason ? { data: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "a2a-protocol.org" }] } : {}) },
});

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...A2A_CORS },
  });
}

export async function handleA2a(request: Request, base: string, deps: A2aDeps): Promise<Response> {
  if (request.method !== "POST") {
    return reply(
      {
        error: "method_not_allowed",
        detail: "A2A JSON-RPC endpoint: POST { jsonrpc: '2.0', id, method: 'SendMessage' (A2A 1.0) or 'message/send' (0.3), params: { message } }.",
        agent_card: `${base}/.well-known/agent-card.json`,
      },
      405,
    );
  }
  let msg: any;
  try {
    msg = JSON.parse(await request.text());
  } catch {
    return reply(rpcErr(null, -32700, "Invalid JSON payload"));
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return reply(rpcErr(msg?.id ?? null, -32600, "Request payload validation error"));
  }
  const id: Id = msg.id ?? null;
  const method: string = msg.method;
  const legacy = method.includes("/"); // 0.3 slash-style names
  const headerVer = (request.headers.get("A2A-Version") ?? new URL(request.url).searchParams.get("A2A-Version") ?? "").trim();
  const version = headerVer || (legacy ? "0.3" : "1.0");
  const mm = version.match(/^(\d+)\.(\d+)/);
  const ver = mm ? `${mm[1]}.${mm[2]}` : version;
  if (!A2A_VERSIONS.includes(ver)) return reply(rpcErr(id, -32009, `A2A version ${version} is not supported (supported: ${A2A_VERSIONS.join(", ")})`, "VERSION_NOT_SUPPORTED"));

  switch (method) {
    case "SendMessage":
    case "message/send": {
      const m = msg.params?.message;
      if (!m || typeof m !== "object" || !Array.isArray(m.parts) || !m.parts.length) {
        return reply(rpcErr(id, -32602, "Invalid parameters: params.message with at least one part is required"));
      }
      if (m.taskId) return reply(rpcErr(id, -32001, "Task not found (this agent is stateless and answers with messages, not tasks)", "TASK_NOT_FOUND"));
      const out = await answer(m, base, deps);
      const contextId = typeof m.contextId === "string" && m.contextId ? m.contextId : crypto.randomUUID();
      const messageId = crypto.randomUUID();
      deps.log({ event: "a2a_message", skill: out.skill, version: ver });
      if (ver === "0.3") {
        return reply(rpc(id, {
          kind: "message",
          messageId,
          contextId,
          role: "agent",
          parts: [{ kind: "text", text: out.text }, { kind: "data", data: out.data }],
          metadata: { skill: out.skill },
        }));
      }
      return reply(rpc(id, {
        message: {
          messageId,
          contextId,
          role: "ROLE_AGENT",
          parts: [{ text: out.text, mediaType: "text/plain" }, { data: out.data, mediaType: "application/json" }],
          metadata: { skill: out.skill },
        },
      }));
    }
    case "SendStreamingMessage":
    case "message/stream":
    case "SubscribeToTask":
    case "tasks/resubscribe":
      return reply(rpcErr(id, -32004, "Streaming is not supported by this agent", "UNSUPPORTED_OPERATION"));
    case "GetTask":
    case "tasks/get":
    case "CancelTask":
    case "tasks/cancel":
      return reply(rpcErr(id, -32001, "Task not found (this agent is stateless and creates no tasks)", "TASK_NOT_FOUND"));
    case "ListTasks":
      return reply(rpc(id, { tasks: [], nextPageToken: "", pageSize: 0, totalSize: 0 }));
    case "CreateTaskPushNotificationConfig":
    case "GetTaskPushNotificationConfig":
    case "ListTaskPushNotificationConfigs":
    case "DeleteTaskPushNotificationConfig":
    case "tasks/pushNotificationConfig/set":
    case "tasks/pushNotificationConfig/get":
    case "tasks/pushNotificationConfig/list":
    case "tasks/pushNotificationConfig/delete":
      return reply(rpcErr(id, -32003, "Push notifications are not supported", "PUSH_NOTIFICATION_NOT_SUPPORTED"));
    case "GetExtendedAgentCard":
    case "agent/getAuthenticatedExtendedCard":
      return reply(rpcErr(id, -32004, "No extended agent card", "UNSUPPORTED_OPERATION"));
    default:
      return reply(rpcErr(id, -32601, `Method not found: ${method}`));
  }
}

interface Answer { skill: string; text: string; data: Record<string, unknown> }

/** Pick a skill from data parts ({ skill, coin, path, format }) or free text, then answer. */
async function answer(m: any, base: string, deps: A2aDeps): Promise<Answer> {
  const cfg = deps.config;
  const parts: any[] = m.parts;
  const data = parts.map((p) => p?.data ?? (p?.kind === "data" ? p.data : undefined)).find((d) => d && typeof d === "object") ?? {};
  const text = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join(" ").trim();
  const coins = await deps.coins();

  let skill: SkillDef | undefined = typeof data.skill === "string" ? SKILLS.find((s) => s.id === data.skill || s.route === data.skill) : undefined;
  const pathArg = typeof data.path === "string" ? data.path : text.match(/\/v1\/[A-Za-z0-9/_.?=&%-]+/)?.[0];
  if (!skill && /\bquote\b/i.test(text)) skill = SKILLS.find((s) => s.id === "quote");
  if (!skill && /\b(should i pay|pay[- ]check|trust[- ]check|safe to pay)\b/i.test(text)) skill = SKILLS.find((s) => s.id === "trust_check");
  if (!skill && /\b(vendor|trust)\s+report\b|\breport\b.*\bvendors?\b/i.test(text)) skill = SKILLS.find((s) => s.id === "vendor_report");
  if (!skill && /\b(seller monitoring|monitor(ing)? plans?|monitored by lumi|badge)\b/i.test(text)) skill = SKILLS.find((s) => s.id === "seller_monitoring");
  if (!skill && /\b(data feed|trust feed|feed plans?|data licen[cs]e|bulk lookup)\b/i.test(text)) skill = SKILLS.find((s) => s.id === "trust_feed");
  if (!skill && /\b(vendors?|trust)\b/i.test(text)) skill = SKILLS.find((s) => s.id === "vendor_trust");
  if (!skill && (["url", "domain", "payTo", "pay_to"].some((k) => typeof data[k] === "string") || (/\b(check|verify|seller|safe|legit|payto)\b/i.test(text) && /https?:\/\/|\b0x[0-9a-fA-F]{40}\b/.test(text))))
    skill = SKILLS.find((s) => s.id === "vendor_trust");
  if (!skill) skill = SKILLS.filter((s) => s.route).find((s) => s.match.test(text)) ?? SKILLS.find((s) => !s.route && s.match.test(text));
  const coinArg =
    (typeof data.coin === "string" && data.coin) ||
    coins.find((c) => new RegExp(`(^|[^A-Za-z0-9])(${c.symbol}|${c.id})([^A-Za-z0-9]|$)`, "i").test(text))?.symbol;

  if (!skill || skill.id === "catalog") {
    return {
      skill: "catalog",
      text:
        `Lumi Trades sells crypto market reads per call over x402 (${settledIn(cfg)}). ` +
        "Free here: catalog, coins, quote, vendor_trust, seller_monitoring, trust_feed. Paid skills: " + SKILLS.filter((s) => s.route).map((s) => s.id).join(", ") +
        ". Ask e.g. 'signal XRP' to get the live payment terms." + (skill ? "" : " (No skill matched your message, so here is the catalog.)"),
      data: {
        api: base,
        agent_card: `${base}/.well-known/agent-card.json`,
        mcp: `${base}/mcp`,
        networks: paymentNetworks(cfg),
        endpoints: priceTable(cfg).map((p) => ({ path: p.path, name: p.name, product_line: p.product_line, prices: p.prices })),
        disclaimer: DISCLAIMER,
      },
    };
  }
  if (skill.id === "seller_monitoring" || skill.id === "trust_feed") {
    const r = await deps.quote(skill.id === "seller_monitoring" ? "/v1/monitor" : "/v1/feed");
    const plans = (r.body?.plans ?? []) as any[];
    return {
      skill: skill.id,
      text: `${FREE_DESCRIPTIONS[skill.id]} Docs: ${base}${skill.id === "seller_monitoring" ? "/v1/monitor" : "/v1/feed"}.` + (plans.length ? ` Plans: ${plans.map((p) => `${p.name ?? p.plan} $${p.price_usd}`).join(", ")}.` : ""),
      data: r.body,
    };
  }
  if (skill.id === "vendor_trust") {
    if (!deps.trust) return { skill: "vendor_trust", text: "The trust layer is unavailable right now.", data: { error: "unavailable" } };
    const sv = (k: string) => (typeof data[k] === "string" && (data[k] as string).trim() ? (data[k] as string).trim().slice(0, 500) : undefined);
    const lq = {
      url: sv("url") ?? text.match(/https?:\/\/[^\s"'<>]+/)?.[0],
      domain: sv("domain"),
      payTo: sv("payTo") ?? sv("pay_to") ?? text.match(/\b0x[0-9a-fA-F]{40}\b/)?.[0] ?? text.match(/\br[1-9A-HJ-NP-Za-km-z]{24,34}\b/)?.[0],
    };
    if (lq.url || lq.domain || lq.payTo) {
      const doc: any = await deps.trust.lookup(lq, base, { free: true });
      const summary = doc.self
        ? `${doc.self.name}: ${doc.self.label}.`
        : !doc.observed
          ? `No Lumi observations for ${JSON.stringify(lq).slice(0, 200)}. No observation is not a negative signal.`
          : `${doc.catalog?.total_matches ?? 0} catalog match(es)${doc.curated?.length ? ` + ${doc.curated.length} curated vendor(s)` : ""}; tiers: ${Object.entries(doc.catalog?.tiers_shown ?? {}).map(([k, v]) => `${v} ${k}`).join(", ") || "n/a"}. Observations, not ratings.`;
      return { skill: "vendor_trust", text: `${summary} Methodology: ${base}/v1/trust/methodology`, data: doc };
    }
    const id = typeof data.vendor_id === "string" ? data.vendor_id : undefined;
    if (id) {
      const doc = await deps.trust.vendorDoc(id, base);
      if (!doc) return { skill: "vendor_trust", text: `Unknown vendor_id ${JSON.stringify(id).slice(0, 80)}. See ${base}/v1/trust/vendors.`, data: { error: "unknown_vendor" } };
      const sc = doc.score as { value: number | null; confidence: string };
      return { skill: "vendor_trust", text: `${doc.name}: Lumi observation score ${sc.value ?? "n/a"} (${sc.confidence} confidence). Methodology: ${base}/v1/trust/methodology`, data: doc };
    }
    const doc = await deps.trust.vendorsDoc(base);
    const list = (doc.vendors as { name: string; score: number | null; confidence: string }[]).map((v) => `${v.name}: ${v.score ?? "n/a"} (${v.confidence})`).join("; ");
    return { skill: "vendor_trust", text: `Lumi's automated observations of x402 vendors (not ratings): ${list}. Methodology: ${base}/v1/trust/methodology`, data: doc };
  }
  if (skill.id === "samples") {
    const doc = deps.samples ? await deps.samples() : null;
    return {
      skill: "samples",
      text: `Free SAMPLE previews of all paid products: ${base}/v1/samples (truncated, up to 10 minutes old; labelled is_sample).`,
      data: doc ?? { url: `${base}/v1/samples` },
    };
  }
  if (skill.id === "coins") {
    return { skill: "coins", text: `Lumi covers ${coins.length} coins: ${coins.map((c) => c.symbol).join(", ")}.`, data: { coins } };
  }

  // quote, or a paid skill: both return the live x402 terms (nothing is charged here)
  let path: string | undefined;
  let target = skill;
  if (skill.id === "quote") {
    if (pathArg && /^\/v1\/[A-Za-z0-9/_.?=&%-]*$/.test(pathArg)) path = pathArg;
    else {
      const t = SKILLS.filter((s) => s.route).find((s) => s.id !== "quote" && (s.id === data.of || s.match.test(text.replace(/\bquote\b/i, ""))));
      if (t) target = t;
    }
  }
  if (!path) {
    if (!target.route) return { skill: "quote", text: "Tell me which paid skill or path to quote, e.g. 'quote /v1/brief' or {\"skill\":\"quote\",\"path\":\"/v1/signal/XRP\"}.", data: { error: "missing_path" } };
    const ep = PAID_ENDPOINTS.find((e) => e.route === target.route)!;
    if (target.needsVendor) {
      const vendorArg = (typeof data.vendor_id === "string" && data.vendor_id) || VENDOR_IDS.find((v) => new RegExp(`(^|[^a-z0-9-])${v}([^a-z0-9-]|$)`, "i").test(text));
      if (!vendorArg) return { skill: target.id, text: `Which vendor? ${target.id} needs a vendor_id: ${VENDOR_IDS.join(", ")}.`, data: { error: "missing_vendor_id", vendors: VENDOR_IDS } };
      path = ep.template.replace("{id}", encodeURIComponent(String(vendorArg).toLowerCase()));
    } else if (target.needsUrl) {
      const u = (typeof data.url === "string" && data.url.trim()) || text.match(/https?:\/\/[^\s"'<>]+/)?.[0];
      if (!u) return { skill: target.id, text: `Which URL? ${target.id} needs url (the x402 resource you are about to pay), optionally payTo and amount.`, data: { error: "missing_url" } };
      const qs = new URLSearchParams({ url: u.slice(0, 500) });
      if (typeof data.payTo === "string" && data.payTo.trim()) qs.set("payTo", data.payTo.trim());
      if (data.amount !== undefined) qs.set("amount", String(data.amount));
      path = `${ep.template}?${qs}`;
    } else if (target.needsCoin && !coinArg) {
      return { skill: target.id, text: `Which coin? ${target.id} needs one of: ${coins.map((c) => c.symbol).join(", ")}.`, data: { error: "missing_coin", supported: coins.map((c) => c.symbol) } };
    }
    if (!path) path = ep.template.replace("{coin}", encodeURIComponent(String(coinArg ?? ""))) + ((target.route === "brief" || target.route === "institutional") && data.format === "md" ? "?format=md" : "");
  }
  const q = await deps.quote(path);
  const url = `${base}${path}`;
  if (q.status !== 402) {
    return {
      skill: target.id,
      text: q.status === 503 ? `Not for sale right now (data not fresh). Not charged. Try again later.` : `No quote for ${path} (HTTP ${q.status}). Not charged.`,
      data: { status: q.status, url, body: q.body, charged: false },
    };
  }
  const options = (q.body?.accepts ?? []).map((a: any) => ({
    network: a.network,
    asset: a.asset === "XRP" ? "XRP" : a.extra?.symbol ?? a.asset,
    amount: a.asset === "XRP" ? dropsToXrp(String(a.amount)) : String(a.network).startsWith("eip155:") ? atomicToUsdc(String(a.amount)) : a.amount,
    payTo: a.payTo,
  }));
  return {
    skill: target.id,
    text:
      `${target.name} is paid: ${options.map((o: any) => `${o.amount} ${o.asset} (${o.network})`).join(" or ")}. ` +
      `Pay with x402 at ${url}: GET it, answer the 402 with a PAYMENT-SIGNATURE for one accepts[] option, receive the data. Nothing was charged over A2A.`,
    data: {
      status: "payment_required",
      charged: false,
      url,
      x402: q.body,
      options,
      how_to_pay: `${base}/skill.md`,
      ...(target.route && MARKET_IDEAS_ROUTES.includes(target.route) ? { product_line: MARKET_IDEAS_NAME, notice: MARKET_IDEAS_NOTICE } : {}),
    },
  };
}
