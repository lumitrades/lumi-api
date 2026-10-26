/**
 * Retired routes (2026-10-25). Lumi is an x402 seller trust service only; every non-trust data route was retired
 * (including /v1/funding, /v1/fear-greed and /v1/institutional, retired with v1.2.0). Every path below answers 410 Gone with a short JSON body pointing to the seller check, before any routing,
 * payment handling or 402 quote: a payment header sent to a retired path is ignored and never settled.
 */

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

export function isRetiredPath(path: string): boolean {
  return RETIRED_PATH_RE.test(path);
}

export function retiredBody(path: string, base = "") {
  return {
    error: "gone",
    status: 410,
    path,
    detail: `This endpoint was retired on ${RETIRED_ON}. Lumi now offers x402 seller checks only. Nothing is sold or charged here.`,
    use: `${base}${RETIRED_USE}`,
    use_detail: "Lumi now checks x402 sellers before you pay: GET /v1/check?url=<x402 resource> (free).",
    note: "Not charged.",
  };
}

export function retiredResponse(path: string, base = "", headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(retiredBody(path, base), null, 2), {
    status: 410,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600", ...headers },
  });
}
