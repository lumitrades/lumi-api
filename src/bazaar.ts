/**
 * x402 Bazaar discovery metadata (the `bazaar` extension of a v2 PaymentRequired), one entry per paid route.
 *
 * The CDP facilitator indexes a resource after its first successful settlement, using `paymentPayload.resource`
 * (url, description <= 500 chars, mimeType) and `paymentPayload.extensions.bazaar` (`info` validated against
 * `schema` with JSON Schema 2020-12). The shape matches `declareDiscoveryExtension()` from @x402/extensions, with
 * `routeTemplate` + `pathParams` for the parameterised routes so all coins / vendors collapse into one listing.
 * Examples are deliberately short: the whole PaymentRequired also travels base64-encoded in a response header.
 */

import { DEFAULT_PRICES, type PaidRoute } from "./config";

/** CDP rejects verify/settle when resource.description is longer than this. */
export const BAZAAR_MAX_DESCRIPTION = 500;

/**
 * Bazaar service metadata (x402 v2 `resource.serviceName/tags/iconUrl`): printable ASCII, serviceName <= 32 chars,
 * at most 5 tags of <= 32 chars each. Each route gets its own tag set so the listings cover many search terms.
 */
export const SERVICE_NAME = "Lumi Trades";
/** Every listing uses one brand name (owner decision 2026-10-25); the trust routes keep their own tag set. */
export const TRUST_SERVICE_NAME = SERVICE_NAME;
export const TRUST_ROUTES: PaidRoute[] = ["trust_check", "vendor_report", "verdict", "receipts", "batch_check"];
export const SERVICE_ICON = "https://lumitrades.io/assets/icon-512.png";
export const ROUTE_TAGS: Record<PaidRoute, string[]> = {
  vendor_report: ["x402", "seller-reputation", "vendor-report", "api-monitoring", "due-diligence"],
  trust_check: ["x402", "check-before-paying", "pre-payment-check", "trust-check", "agent-payments"],
  verdict: ["x402", "check-before-paying", "pre-payment-check", "seller-reputation", "test-buys"],
  receipts: ["x402", "test-buys", "signed-receipts", "seller-reputation", "check-before-paying"],
  batch_check: ["x402", "check-before-paying", "batch-check", "pre-payment-check", "agent-payments"],
};

export function serviceMeta(route: PaidRoute): { serviceName: string; tags: string[]; iconUrl: string } {
  return { serviceName: serviceNameFor(route), tags: ROUTE_TAGS[route], iconUrl: SERVICE_ICON };
}

export function serviceNameFor(route: PaidRoute): string {
  void route;
  return SERVICE_NAME;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface RouteMeta {
  /** Listing text (<= 500 chars, plain description). */
  description: string;
  /** Colon-style template for routes with a path parameter. */
  routeTemplate?: string;
  pathParam?: { name: string; schema: Record<string, Json> };
  /** Query parameters. */
  query?: Record<string, Record<string, Json>>;
  /** Query parameters that must be present (the request is refused with 400, never charged, without them). */
  queryRequired?: string[];
  example: Record<string, Json>;
}

/** Coin input: ticker or CoinGecko id, case-insensitive (XRP, xrp and ripple are the same coin). */
export const COIN_PATTERN = "^[A-Za-z0-9-]{1,40}$";
/** Vendor id input, identical in the OpenAPI document and the 402 bazaar schema. */
export const VENDOR_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";

/** Example `payment` block of a paid response, at the route's real (default) Base USDC price. */
const pay = (route: PaidRoute, usd: string = DEFAULT_PRICES[route].usd): Record<string, Json> => ({
  network: "eip155:8453",
  asset: "USDC",
  amount: usd,
  transaction: "0x5f0c...e41a",
  payer: "0x12ab...89cd",
});

/** Example freshness fields (present on every paid response): as_of, data_age_seconds, next_update, stale_after. */
const FRESH = (asOf: string, staleAfter: string, ageSeconds = 600, nextUpdate?: string): Record<string, Json> => {
  const next = nextUpdate ?? new Date(Math.min(Date.parse(asOf) + 6 * 3_600_000, Date.parse(staleAfter))).toISOString().replace(/\.\d{3}Z$/, "Z");
  return { as_of: asOf, data_age_seconds: ageSeconds, next_update: next, stale_after: staleAfter };
};

/** Shared promise appended to every listing. */
export const FAIR_USE =
  "Every response carries as_of. Not charged on bad input or when Lumi cannot answer.";

export const BAZAAR_ROUTES: Record<PaidRoute, RouteMeta> = {
  vendor_report: {
    description:
      "Use when an agent needs seller reputation evidence before paying an x402 vendor on Lumi Trades' curated list: the full observation history, with unpaid 402-quote checks (status, quoted price, latency), paid test purchases with transaction hashes and delivered yes/no (XRP Ledger, Base, Stellar), uptime over 24h/7d/30d/90d, quoted-price history and score components with sample sizes. Not charged on unknown vendors or without recent data. Automated observations, not a rating.",
    routeTemplate: "/v1/trust/vendors/:id/report",
    pathParam: {
      name: "id",
      schema: { type: "string", pattern: VENDOR_ID_PATTERN, description: "Vendor id from GET /v1/trust/vendors (free)" },
    },
    example: {
      kind: "trust_vendor_report",
      id: "example-vendor",
      name: "Example Vendor",
      score: { value: 82, confidence: "medium", window_days: 30 },
      windows: { "24h": { uptime_pct: 100 }, "7d": { uptime_pct: 99.4 } },
      paid_test_buys: { count: 6, delivered: 6, delivery_pct: 100 },
      quote_checks: { columns: ["checked_at", "endpoint", "http_status", "valid_quote", "price"], rows: [["2026-10-22T12:30:00Z", 0, 402, true, "0.01"]] },
      ...FRESH("2026-10-22T12:30:00Z", "2026-10-24T12:30:00Z"),
      payment: pay("vendor_report"),
    },
  },
  trust_check: {
    description:
      "Use when an agent should check before paying an x402 resource URL: a pre-payment trust check that returns allow, warn or block with coded reasons. Built from a daily index of the CDP Bazaar catalog, unpaid 402-quote checks and Lumi Trades' own on-chain test purchases on Base, the XRP Ledger and Stellar. Optional payTo and amount inputs catch address or price mismatches. A free signed version is at /v1/check. Not charged on bad input. Observations, not a guarantee.",
    query: {
      url: { type: "string", description: "The x402 resource URL you are about to pay (required)" },
      payTo: { type: "string", description: "The payTo address from its 402 quote (optional)" },
      amount: { type: "string", description: "The quoted price in USD, e.g. 0.01 (optional)" },
    },
    queryRequired: ["url"],
    example: {
      kind: "trust_check",
      query: { url: "https://api.example.com/v1/data", payTo: "0x12ab...89cd" },
      verdict: "warn",
      confidence: "low",
      reasons: [{ code: "last_quote_invalid", severity: "warn", detail: "Lumi's last free quote check did not get a valid x402 quote." }],
      next_steps: { free_lookup: "https://api.lumitrades.io/v1/trust/vendors?url=..." },
      ...FRESH("2026-10-23T11:00:00Z", "2026-10-24T11:00:00Z"),
      payment: pay("trust_check"),
    },
  },
  verdict: {
    description:
      "Use when an agent wants a one-label check before paying an x402 URL or seller domain: checks_passed, check_first, checks_failed or no_data, with as-of date, evidence window, conclusive test-buy count, last delivered/failed dates, reason codes, and evidence and appeal links. Same data and signing key as the free /v1/check. Observed on-chain payments appear as ranges only (unverified; no payer addresses or amounts). Not charged on bad input. Observations, not a guarantee.",
    query: {
      url: { type: "string", description: "The x402 resource URL or the seller's domain (required)" },
      payTo: { type: "string", description: "The payTo address from its 402 quote (optional)" },
      amount: { type: "string", description: "The quoted price in USD, e.g. 0.01 (optional)" },
    },
    queryRequired: ["url"],
    example: {
      kind: "lumi_verdict",
      label: "checks_passed",
      label_text: "Delivered in recent checks",
      reason_code: "delivered_recently",
      as_of: "2026-10-25",
      evidence_window: { from: "2026-09-02", to: "2026-10-20", test_buy_rule_days: 14 },
      n_conclusive: 3,
      last_delivered_at: "2026-10-20T09:12:00Z",
      last_failed_at: null,
      reply_url: "https://lumitrades.io/contact/",
      observed_onchain_payments: { shown: true, name: "Observed on-chain payments (unverified)", payer_groups_30d: "10–99", payments_30d: "100–999", last_payment: "within the last week" },
      commercial_relationship: [],
      ...FRESH("2026-10-25T11:00:00Z", "2026-10-26T11:00:00Z"),
      payment: pay("verdict"),
    },
  },
  receipts: {
    description:
      "Use when an agent wants the proof behind a seller check: the signed test-buy receipts Lumi Trades holds for one x402 seller (domain, resource URL or payTo), newest first, with date, endpoint, network (Base, XRP Ledger, Stellar), amount, transaction hash, explorer link and delivered yes/no. Anyone can verify a receipt for free at /v1/trust/receipts/verify. Not charged on bad input or when Lumi holds no receipt for the seller. Observations, not a guarantee.",
    query: {
      seller: { type: "string", description: "The seller: a domain (api.example.com), an x402 resource URL or a payTo address (required)" },
    },
    queryRequired: ["seller"],
    example: {
      kind: "lumi_seller_receipts",
      query: { seller: "api.example.com" },
      count: 1,
      delivered: 1,
      not_delivered: 0,
      inconclusive: 0,
      receipts: [{
        at: "2026-10-22T20:37:37Z", endpoint: "https://api.example.com/v1/data", network: "eip155:8453", amount: "0.01", asset: "USDC",
        tx_hash: "0x9c1e...7b20", explorer: "https://basescan.org/tx/0x9c1e...7b20", delivery: "delivered", receipt_hash: "5d2a...c0f1",
      }],
      verify: "https://api.lumitrades.io/v1/trust/receipts/verify",
      ...FRESH("2026-10-26T11:00:00Z", "2026-10-27T11:00:00Z"),
      payment: pay("receipts"),
    },
  },
  batch_check: {
    description:
      "Use when an agent must check several x402 sellers before paying: up to 10 resource URLs or seller domains in one call, each with the same label as the free /v1/check (checks_passed, check_first, checks_failed or no_data), reason codes, conclusive test-buy count, last delivered date and an evidence link, in one signed answer. Based on Lumi Trades' record; it does not contact the sellers. Not charged on bad input. Observations, not a guarantee.",
    query: {
      urls: { type: "string", description: "Comma-separated x402 resource URLs or seller domains, 1 to 10 (required)" },
    },
    queryRequired: ["urls"],
    example: {
      kind: "lumi_batch_check",
      count: 2,
      results: [
        { url: "https://api.example.com/v1/data", label: "checks_passed", reason_code: "delivered_recently", n_conclusive: 3, last_delivered_at: "2026-10-20T09:12:00Z", evidence: "https://api.lumitrades.io/trust/v/api.example.com" },
        { url: "https://data.example.org/v1/quote", label: "no_data", reason_code: "not_observed", n_conclusive: 0, last_delivered_at: null, evidence: "https://api.lumitrades.io/trust/v/data.example.org" },
      ],
      ...FRESH("2026-10-26T11:00:00Z", "2026-10-27T11:00:00Z"),
      payment: pay("batch_check"),
    },
  },
};

/** One documented error status of a paid route (listed in the 402 bazaar schema, OpenAPI and /.well-known/x402). */
export interface ErrorDoc {
  status: number;
  error: string;
  when: string;
}

/** Path placeholder routes return 404 for unknown ids; url-input routes return 400 for bad input. */
const COIN_ROUTES: PaidRoute[] = [];
const URL_ROUTES: PaidRoute[] = ["trust_check", "verdict"];

/**
 * Error responses of a paid route, matching what the code returns (x402.ts, app.ts). Every status below except 402,
 * 409 settlement_status_unknown and 500 happens before any payment is settled, so it is never charged.
 */
export function errorDocs(route: PaidRoute): ErrorDoc[] {
  const out: ErrorDoc[] = [];
  if (route === "batch_check") out.push({ status: 400, error: "invalid_input", when: "urls missing, more than 10 entries, or an entry that is not an absolute http(s) URL or a domain. Never charged." });
  else if (URL_ROUTES.includes(route)) out.push({ status: 400, error: "invalid_input", when: "url missing or not an absolute http(s) URL, or payTo/amount malformed. Never charged." });
  else if (route === "receipts") out.push({ status: 400, error: "invalid_input", when: "seller missing, or not a domain, an absolute http(s) URL or a payTo address. Never charged." });
  else if (COIN_ROUTES.includes(route) || route === "vendor_report") out.push({ status: 400, error: "invalid_input", when: "Path placeholder not filled in (e.g. {id}) on a paid request. Never charged." });
  out.push({ status: 402, error: "payment_required", when: "No payment, or the payment was invalid or failed to settle: x402 v2 PaymentRequired in the body and the PAYMENT-REQUIRED header." });
  if (COIN_ROUTES.includes(route)) out.push({ status: 404, error: "not_found", when: "Unknown coin. Never charged." });
  if (route === "receipts") out.push({ status: 404, error: "not_found", when: "Lumi holds no test-buy receipt for this seller (the free GET /v1/check still answers). Never charged." });
  if (route === "vendor_report") out.push({ status: 404, error: "not_found", when: "Unknown vendor id (GET /v1/trust/vendors lists ids). Never charged." });
  out.push({ status: 409, error: "idempotency_conflict | settlement_status_unknown", when: "Idempotency-Key reused with a different payment (never charged), or the facilitator did not confirm settlement; check the transaction before paying again." });
  out.push({ status: 429, error: "rate_limited", when: "Not returned on paid calls. The free lookups (/v1/check, /v1/trust/vendors, /v1/trust/catalog) return 429 with Retry-After over their limits; a facilitator 429 surfaces as a retryable 503." });
  out.push({ status: 500, error: "internal_error", when: "Unexpected server error; retry later." });
  out.push({ status: 502, error: "invalid_verify_response | settle_http_error", when: "The payment facilitator returned an unusable answer; not retryable as-is. Nothing is settled on invalid_verify_response." });
  out.push({ status: 503, error: "stale_data | data_unavailable | facilitator_unavailable", when: "Lumi cannot answer right now (no recent observations, an upstream down) or the facilitator is busy (incl. its 429/5xx). Retry-After header set. Never charged." });
  return out;
}

/** Compact one-line form of errorDocs(), used as a JSON Schema annotation in the bazaar extension. */
export function errorSummary(route: PaidRoute): string {
  return "Errors: " + errorDocs(route).map((e) => `${e.status} ${e.error}`).join("; ") + ". Details: GET /openapi.json (responses) or /.well-known/x402 (errors).";
}

/** Minimal JSON Schema for an example value: type at every level, object properties to depth 2, all present keys required at the top. */
export function schemaFor(v: Json, depth = 0): Record<string, Json> {
  if (v === null) return { type: "null" };
  if (Array.isArray(v)) return { type: "array" };
  if (typeof v === "object") {
    if (depth >= 1) return { type: "object" };
    return {
      type: "object",
      properties: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, schemaFor(x, depth + 1)])),
      required: Object.keys(v).filter((k) => k === "kind" || k === "payment"),
    };
  }
  return { type: typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string" };
}

/**
 * The `bazaar` extension for one request. `arg` is the concrete path parameter (coin symbol / vendor id) of this URL,
 * `query` the recognised query parameters actually present.
 */
export function bazaarExtension(route: PaidRoute, arg?: string, query?: Record<string, string>, usd?: string): Record<string, Json> {
  const meta0 = BAZAAR_ROUTES[route];
  const meta = usd ? { ...meta0, example: { ...meta0.example, payment: pay(route, String(Number(usd))) } } : meta0;
  const input: Record<string, Json> = { type: "http", method: "GET" };
  const inputProps: Record<string, Json> = {
    type: { type: "string", const: "http" },
    method: { type: "string", enum: ["GET"] },
  };
  if (meta.query) {
    const present = Object.fromEntries(Object.entries(query ?? {}).filter(([k]) => k in meta.query!));
    if (Object.keys(present).length) input.queryParams = present;
    inputProps.queryParams = { type: "object", properties: meta.query, ...(meta.queryRequired ? { required: meta.queryRequired } : {}), additionalProperties: false };
  } else if (!meta.pathParam) {
    // No inputs at all: still declare an (empty) query schema so discovery tools see an input schema.
    inputProps.queryParams = { type: "object", properties: {}, additionalProperties: false };
  }
  if (meta.pathParam && arg !== undefined) {
    input.pathParams = { [meta.pathParam.name]: arg };
    inputProps.pathParams = {
      type: "object",
      properties: { [meta.pathParam.name]: meta.pathParam.schema },
      required: [meta.pathParam.name],
      additionalProperties: false,
    };
  }
  return {
    info: { input, output: { type: "json", example: meta.example } },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: { type: "object", properties: inputProps, required: ["type", "method"], additionalProperties: false },
        output: {
          type: "object",
          description: errorSummary(route),
          properties: { type: { type: "string" }, example: schemaFor(meta.example) },
          required: ["type"],
        },
      },
      required: ["input"],
    },
    ...(meta.routeTemplate && arg !== undefined ? { routeTemplate: meta.routeTemplate } : {}),
  };
}

/** resource.description for a quote: the full summary when it fits CDP's limit, otherwise the Bazaar listing text. */
/** Buyer-keyword headline per route, so Bazaar search and listings show what it is and what it costs first. */
const HEADLINES: Record<PaidRoute, (subject?: string) => string> = {
  vendor_report: (v) => `x402 seller reputation report${v ? ` for ${v}` : ""} (uptime, latency, test-buys)`,
  trust_check: () => "Check before paying an x402 URL (allow / warn / block with coded reasons)",
  verdict: () => "Check before paying: one-label x402 pre-payment check (checks_passed / check_first / checks_failed / no_data)",
  receipts: () => "Signed x402 test-buy receipts for one seller (tx hash, explorer link, delivered yes/no)",
  batch_check: () => "Check up to 10 x402 sellers before paying, one signed answer",
};

/**
 * The 402 resource description that the Bazaar and x402scan index: the route's v2 listing text (Scout,
 * notes/outreach/bazaar_descriptions_v2.md), never with a price inside it. Prices live only in accepts[] and in
 * openapi x-payment-info, so a listing can never show a stale or wrong price in its text.
 * `full`/`opts` are kept for call-site compatibility.
 */
export function resourceDescription(route: PaidRoute, full: string, opts: { subject?: string; usd?: string } = {}): string {
  void full; void opts;
  const desc = BAZAAR_ROUTES[route].description;
  return desc.length <= BAZAAR_MAX_DESCRIPTION ? desc : desc.slice(0, BAZAAR_MAX_DESCRIPTION - 1).replace(/\s+\S*$/, "") + "…";
}

/** Short keyword headline per route (not used in resource.description; kept for titles). */
export function routeHeadline(route: PaidRoute, subject?: string): string {
  return HEADLINES[route](subject);
}
