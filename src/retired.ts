/**
 * Retired routes (2026-10-25). Lumi is an x402 seller trust service only; every non-trust data route was retired
 * (including /v1/funding, /v1/fear-greed and /v1/institutional, retired with v1.2.0). Every path below answers 410 Gone with a short JSON body pointing to the seller check, before any routing,
 * payment handling or 402 quote: a payment header sent to a retired path is ignored and never settled.
 */

import { EXAMPLE_SELLER_URL, EXAMPLE_VENDOR_ID, FREE_TRUST_CHECK_EXAMPLE, HIGH_VALUE_EXAMPLE, HIGH_VALUE_PRICING_TEXT, FREE_TRUST_CHECK_LIMITS } from "./config";

export const RETIRED_ON = "2026-10-25";
export const RETIRED_USE = "/v1/check";

/** Retired paths (concrete, template or legacy alias), matched case-insensitively and with or without a trailing slash. */
export const RETIRED_PATH_RE =
  /^\/v1\/(?:(?:signal|signals|lite|levels)(?:\/[^/]*)?|scan|slate|brief|coins|ideas|trades|bias|market|macro\/yen|sentiment|events(?:\/next48h)?|funding(?:\/[^/]*)?|fear[-_]?greed(?:\/[^/]*)?|institutional(?:\/[^/]*)?)\/?$/i;

/** MCP tools and A2A skills that were retired with those routes. */
export const RETIRED_TOOLS = ["lumi_signal", "lumi_lite", "lumi_scan", "lumi_levels", "lumi_slate", "lumi_brief", "lumi_coins",
  "lumi_market", "lumi_macro_yen", "lumi_sentiment", "lumi_events", "lumi_events_48h", "lumi_funding", "lumi_fear_greed",
  "lumi_institutional_brief"];
export const RETIRED_SKILLS = ["signal", "lite", "scan", "levels", "slate", "brief", "coins", "market", "macro_yen", "sentiment", "events", "events_48h",
  "funding", "fear_greed", "institutional"];

/** Retired vendor reports (2026-10-26, owner approved 11:22 AM CT): only these vendors' GET /v1/trust/vendors/<id>/report
 *  answers 410 Gone (never quoted, never settled). The vendor's data stays; every other vendor's report is unchanged. */
export const RETIRED_VENDOR_REPORTS_ON = "2026-10-26";
export const RETIRED_VENDOR_REPORTS = ["asksurf"];
const RETIRED_VENDOR_REPORT_RE = new RegExp(`^/v1/trust/vendors/(?:${RETIRED_VENDOR_REPORTS.join("|")})/report/?$`, "i");

export function isRetiredVendorReport(path: string): boolean {
  return RETIRED_VENDOR_REPORT_RE.test(path);
}

export function isRetiredPath(path: string): boolean {
  return RETIRED_PATH_RE.test(path) || isRetiredVendorReport(path);
}

export function retiredBody(path: string, base = "") {
  const vendorReport = isRetiredVendorReport(path);
  return {
    error: "gone",
    status: 410,
    path,
    detail: vendorReport
      ? `This vendor report was retired on ${RETIRED_VENDOR_REPORTS_ON}. Nothing is sold or charged here.`
      : `This endpoint was retired on ${RETIRED_ON}. Lumi now offers x402 seller checks only. Nothing is sold or charged here.`,
    use: `${base}${RETIRED_USE}`,
    use_detail: "Lumi now checks x402 sellers before you pay: GET /v1/check?url=<x402 resource> (free).",
    current_routes: currentTrustRoutes(base),
    note: "Not charged.",
  };
}

/**
 * Current trust routes, attached to every 410 so a client with an old path can move on without reading docs. Every url is a
 * working example (no {id} or <placeholder> to fill in); params says what to replace.
 */
export function currentTrustRoutes(base = "") {
  const ex = encodeURIComponent(EXAMPLE_SELLER_URL);
  return {
    trust_check: { method: "GET", url: `${base}${FREE_TRUST_CHECK_EXAMPLE}`, params: "url: the x402 resource you are about to pay; optional payTo, amount (USD)", price: `free, ${FREE_TRUST_CHECK_LIMITS.perDay}/day per IP and per key (RateLimit-* headers; 429 names the paid route)` },
    high_value_check: { method: "GET", url: `${base}${HIGH_VALUE_EXAMPLE}`, params: "url and amount (USD) required; optional payTo", price: `${HIGH_VALUE_PRICING_TEXT} (x402)` },
    seller_check: { method: "GET", url: `${base}/v1/check?url=${ex}`, params: "url", price: "free" },
    vendor_lookup: { method: "GET", url: `${base}/v1/trust/vendors?url=${ex}`, params: "url, domain or payTo", price: "free" },
    vendor_report: { method: "GET", url: `${base}/v1/trust/vendors/${EXAMPLE_VENDOR_ID}/report`, params: "vendor id in the path (list: GET /v1/trust/vendors)", price: "$0.02 (x402)" },
    docs: `${base}/openapi.json`,
  };
}

export function retiredResponse(path: string, base = "", headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(retiredBody(path, base), null, 2), {
    status: 410,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600", ...headers },
  });
}
