/**
 * One delivery judgement for a paid x402 response, shared by the API (src/trust/delivery.ts) and Lumi's test-buy
 * runners (Base catalog_buys.ts, XRPL/Stellar trust_testbuys.ts carry a byte-identical copy). Pure: no I/O, no deps.
 *
 * Rules, in order (conservative: when in doubt, the buy keeps today's verdict):
 *  1. No HTTP status (Lumi's client gave up, network error) -> inconclusive, lumi_client_timeout / no_http_response.
 *     Never counted against the seller (unchanged).
 *  2. Non-2xx -> not_delivered, http_error (unchanged).
 *  3. 2xx with a 0-byte / whitespace-only body -> not_delivered, empty_body (unchanged).
 *  4. 2xx whose body is clearly an error payload -> not_delivered, error_after_payment. Error shapes:
 *     top-level `error` (non-null, non-false) or non-empty `errors`; `success: false` / `ok: false`;
 *     `status: "error" | "fail" | "failed"` or a numeric `status`/`statusCode` >= 400; JSON-RPC `error` without `result`;
 *     a message-only object (`message` / `detail` / `msg` / `reason`, nothing else of substance) whose text reads as an
 *     error; a short plain-text or HTML error page. In every case the body must carry no real data beside the error:
 *     a body with a non-empty data container, 2+ non-envelope fields, or one long (80+ char) text field stays delivered,
 *     e.g. data plus `error: null`.
 *  5. 2xx whose body is an empty result -> inconclusive, empty_result (not counted against the seller): `{}`, `[]`,
 *     `null`, `""`, or a data-feed body whose only payload arrays are all empty (counts, paging, timestamps and other
 *     envelope fields around them do not count as data). Explicit screening answers stay delivered: a body with a
 *     screening field (match_count, matches, hits, found, sanctioned, flagged, verdict, clean, risk..., threats,
 *     findings, alerts, incidents, valid, ...) is an answer ("no match"), not an empty result, and not an error either
 *     ({exists:false, message:"Not found"} or a validator's {valid:false, errors:[...]} are answers).
 *  6. Anything else -> delivered.
 *
 * Fairness (Bobby 2026-10-27): an error that is clearly caused by Lumi's own test input, not the seller, is inconclusive,
 * our_query_error (never counted against the seller), checked before rules 4-5 on JSON objects:
 *   - an unfilled placeholder: a literal {name} (or %7Bname%7D) in the request Lumi sent, or quoted back in the error text;
 *   - an explicit invalid-input code at the top level (INPUT_INVALID, invalid_*, unsupported_*, missing_param..., validation_error,
 *     bad_request), with no result rows beside it (validation details naming the fields are fine);
 *   - an error payload whose text names Lumi's input: a snake_case parameter that "is not registered/covered/supported/valid"
 *     or "is required/missing/invalid", a quoted value that "is not covered/supported/valid", "expected X, received Y",
 *     "invalid/missing/unsupported parameter|argument|field|query|input|value".
 * The same check applies to an HTTP 400/422 paid response (e.g. 0x INPUT_INVALID naming the fields Lumi sent).
 * Screening answers are never our_query_error, nor is any body that also points at the seller's side (an execution or
 * upstream failure, "retry later", a rate limit, a timeout). Other borderline bodies keep their verdict (e.g. settlement_pending stays
 * delivered; {"message":"No such letter"} stays delivered).
 */

export type JudgedState = "delivered" | "not_delivered" | "inconclusive";
export type JudgedReason =
  | "data"
  | "screening_answer"
  | "lumi_client_timeout"
  | "no_http_response"
  | "http_error"
  | "empty_body"
  | "error_after_payment"
  | "empty_result"
  | "our_query_error";

export interface JudgeInput {
  /** HTTP status of the paid response; null/0 when Lumi saw none. */
  status: number | null | undefined;
  /** Raw response body text (may be truncated by the caller; judgement only needs the start for text bodies). */
  body: string | null | undefined;
  contentType?: string | null;
  /** Set when Lumi's own fetch failed: "timeout" counts as Lumi's client timeout, anything else as no HTTP response. */
  fetchError?: string | null;
  /** What Lumi sent (URL plus request body), used only to spot an unfilled {placeholder} in Lumi's own test input. */
  request?: string | null;
}

export interface Judgement {
  state: JudgedState;
  reason: JudgedReason;
  /** Short factual description (no judgement words), safe to put in a public summary. */
  detail: string;
}

/** Envelope / non-payload keys: never "real data" on their own. Compared lower-case, without _ or -. */
const ENVELOPE = new Set(
  [
    // error vocabulary
    "error", "errors", "err", "message", "messages", "msg", "detail", "details", "reason", "code", "status", "statuscode",
    "success", "ok", "hint", "hints", "help", "example", "examples", "usage", "docs", "documentation", "expected", "received",
    "supported", "field", "fields", "issues", "params", "parameters", "optional", "required", "openapi", "machinedocs",
    "howtocall", "howtopay", "nextstep", "resolution", "resolutionhint", "retryable", "retryafter", "title", "type", "instance",
    "footer", "owneractionrequired", "upstreamstatus", "registerurl", "freedemo", "limits", "settlevia",
    "errorcode", "errorname", "errorcategory", "errortype", "errormessage", "cloudflareerror", "upstreamerror",
    // payment / x402 vocabulary
    "x402", "x402version", "accepts", "extensions", "resource", "payment", "paymentaccepted", "receipt", "settlement", "charged",
    "refund", "redelivery", "paid", "price", "priceusd", "priceusdc", "pricedisplay", "costusd", "costusdc", "network", "payer",
    "payto", "facilitator", "tx", "txhash", "transaction",
    // envelope / paging / provenance
    "meta", "metadata", "pagination", "page", "pages", "perpage", "pagesize", "limit", "offset", "cursor", "next", "nextcursor",
    "previous", "prev", "hasmore", "more", "total", "totalcount", "totalresults", "count", "resultcount", "resultscount", "results_count",
    "query", "q", "request", "requestid", "id", "jsonrpc", "traceid", "timestamp", "ts", "time", "servertime", "generatedat",
    "asof", "fetchedat", "retrievedat", "checkedat", "createdat", "updatedat", "date", "source", "sources", "service", "provider",
    "version", "apiversion", "schemaversion", "endpoint", "url", "method", "mode", "cached", "cache", "cachedat", "freshness",
    "disclaimer", "note", "notes", "notice", "attribution", "terms", "license", "networkreferrals", "warnings", "warning",
    // schema descriptors (describe the rows, are not rows)
    "format", "formats", "columns", "schema", "headers", "units",
  ].map((k) => k.replace(/[_-]/g, "")),
);
const norm = (k: string) => k.toLowerCase().replace(/[_-]/g, "");
const isEnvelope = (k: string) => ENVELOPE.has(norm(k));

/** A field that is itself an answer to a screening question ("no match" is a result, not an empty feed). */
const SCREENING_KEY = /^(match(es|ed|count|found)?|nummatches|hits?|hitcount|found|exists|valid|isvalid|issanctioned|sanction(s|ed)?|flag(s|ged)?|isflagged|listed|islisted|blocked|verdict|clean|isclean|risk\w*|screen\w*|threats?|findings|alerts|incidents|activeincidents|violations|blockers|safe|issafe|malicious|ismalicious)$/;
const isScreeningKey = (k: string) => SCREENING_KEY.test(norm(k));
/** Object carries a screening answer: a screening key whose value is set (null/"" do not count). */
const hasScreeningAnswer = (o: Record<string, unknown>) => Object.entries(o).some(([k, v]) => isScreeningKey(k) && v != null && v !== "");

const ERROR_TEXT =
  /\b(error|errors|exception|invalid|missing|required|must (be|not|provide|include)|not found|unauthori[sz]ed|forbidden|denied|failed|failure|unable to|could not|cannot|can't|not allowed|bad request|bad gateway|payment required|insufficient|expired|rate.?limit(ed)?|too many requests|try again|unavailable|timed? ?out|not supported|unsupported|no route|malformed)\b/i;
const ERROR_STATUS_STR = /^(error|err|fail|failed|failure|unauthori[sz]ed|forbidden|invalid|denied|rejected)$/i;
const PLAIN_TEXT_ERROR =
  /^\s*(error\b|errors?:|internal server error|bad gateway|service unavailable|gateway time-?out|not found\b|404\b|500\b|502\b|503\b|504\b|unauthori[sz]ed|forbidden|too many requests|bad request|request failed|upstream (error|request failed|connect error)|an error occurred|something went wrong|error code:? ?\d+|invalid (request|input|parameter)|exception\b|traceback)/i;
const HTML_ERROR_TITLE = /<title>\s*([^<]*\b(error|not found|bad gateway|unavailable|forbidden|unauthori[sz]ed|timed? ?out|[45]\d\d)\b[^<]*)<\/title>/i;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const emptyScalar = (v: unknown) => v == null || v === "" || (typeof v === "string" && !v.trim());

/** Non-empty array, or object with at least one non-envelope key that itself has content (recursive, bounded). */
function hasPayload(v: unknown, depth = 0): boolean {
  if (depth > 6) return true; // deep structure: treat as data
  if (Array.isArray(v)) return v.length > 0;
  if (isObj(v)) return Object.entries(v).some(([k, x]) => !isEnvelope(k) && (isObj(x) || Array.isArray(x) ? hasPayload(x, depth + 1) : !emptyScalar(x)));
  return !emptyScalar(v);
}

/** "Real data" beside an error field: a non-empty non-envelope container, or 2+ non-empty non-envelope scalars. */
function hasSubstance(o: Record<string, unknown>): boolean {
  let scalars = 0;
  for (const [k, v] of Object.entries(o)) {
    if (isEnvelope(k)) continue;
    if (Array.isArray(v) || isObj(v)) { if (hasPayload(v, 1)) return true; continue; }
    if (typeof v === "string" && v.trim().length >= 80) return true; // one long text field (article, markdown, answer) is data
    if (!emptyScalar(v) && v !== false) scalars++;
  }
  return scalars >= 2;
}

const textOf = (v: unknown): string => (typeof v === "string" ? v : isObj(v) ? String(v.message ?? v.msg ?? v.detail ?? v.error ?? v.code ?? "") : "");

/** Error payload in a 2xx JSON object? Returns a short description, or null. */
function errorShape(o: Record<string, unknown>): string | null {
  const keys = Object.keys(o);
  const get = (name: string) => { const k = keys.find((x) => norm(x) === name); return k === undefined ? undefined : o[k]; };
  const err = get("error"), errs = get("errors"), success = get("success"), ok = get("ok"), status = get("status"), statusCode = get("statuscode");
  const substance = hasSubstance(o);
  // JSON-RPC error without a result.
  if (get("jsonrpc") !== undefined && isObj(err) && get("result") === undefined) return "JSON-RPC error object";
  if (substance) return null; // real data present: an incidental error/status field does not make it an error
  if (hasScreeningAnswer(o)) return null; // e.g. {exists:false, message:"Not found"} or {valid:false, errors:[...]} is an answer
  if (err != null && err !== false && !(typeof err === "string" && !err.trim()) && !(isObj(err) && !Object.keys(err).length)) return "error field";
  if (Array.isArray(errs) ? errs.length > 0 : isObj(errs) ? Object.keys(errs).length > 0 : typeof errs === "string" && !!errs.trim()) return "errors field";
  if (success === false || ok === false) return success === false ? "success: false" : "ok: false";
  if (typeof status === "string" && ERROR_STATUS_STR.test(status.trim())) return `status: "${status.trim().slice(0, 20)}"`;
  const num = [status, statusCode].map((x) => (typeof x === "number" ? x : typeof x === "string" && /^\d{3}$/.test(x) ? Number(x) : null)).find((x) => x != null);
  if (num != null && num >= 400 && num <= 599) return `status ${num} in body`;
  // Message-only shapes: {message}, {detail}, {msg}, {reason} (+ envelope keys), text reads as an error.
  const msg = ["message", "detail", "msg", "reason", "title"].map((k) => textOf(get(k))).find((t) => t.trim());
  if (msg && ERROR_TEXT.test(msg)) return "error message";
  return null;
}

const PLACEHOLDER = /\{[A-Za-z_][\w-]{0,40}\}|%7B[A-Za-z_][\w-]{0,40}%7D/i;
const INPUT_CODE =
  /^(input_?invalid|invalid_?(input|inputs|param|params|parameter|parameters|argument|arguments|query|request|value|field|fields|fiat|currency|pair|symbol|ticker|token|address|chain|chainid|network|id|url|date)|unsupported_?\w+|missing_?(param|params|parameter|parameters|field|fields|argument|arguments|input|query|value)|validation_?(error|failed)|bad_?request)$/i;
const INPUT_TEXT = new RegExp(
  [
    "\\b[a-z][a-z0-9]*_[a-z0-9_]+\\b[^.;]{0,20}\\b(is not (registered|covered|supported|valid|recognized)|is (required|missing|invalid))\\b",
    "\"[^\"]{1,120}\" is not (covered|supported|valid|recognized)",
    "\\bexpected \\w+,? received \\w+",
    "\\b(invalid|missing|unsupported|unknown) (query )?(param|params|parameter|parameters|argument|arguments|field|fields|query|input|value)\\b",
  ].join("|"),
  "i",
);

const SELLER_SIDE = /execution_?failed|upstream|retry_?later|"retriable":\s*true|internal (server )?error|server error|rate.?limit|timed? ?out|unavailable/i;

/** Non-empty result rows (a non-envelope non-empty array) in the top two levels. */
function rowsPresent(o: Record<string, unknown>): boolean {
  return Object.entries(o).some(([k, v]) => !isEnvelope(k) && (Array.isArray(v) ? v.length > 0 : isObj(v) && Object.entries(v).some(([k2, x]) => !isEnvelope(k2) && Array.isArray(x) && x.length > 0)));
}

/** Error clearly caused by Lumi's own test input? Returns a short description, or null. `err` = errorShape() result. */
function ourQueryShape(o: Record<string, unknown>, request: string, err: string | null): string | null {
  if (hasScreeningAnswer(o) || rowsPresent(o)) return null;
  // Any sign the failure was on the seller's side (execution/upstream failure, retry later, rate limit) -> not ours.
  if (SELLER_SIDE.test(JSON.stringify(o))) return null;
  const keys = Object.keys(o);
  const get = (name: string) => { const k = keys.find((x) => norm(x) === name); return k === undefined ? undefined : o[k]; };
  const e = get("error");
  const codes = [e, get("code"), get("name"), get("errorcode"), get("errortype"), isObj(e) ? e.code : undefined, isObj(e) ? e.type : undefined]
    .filter((x): x is string => typeof x === "string");
  if (codes.some((c) => INPUT_CODE.test(c.trim()))) return "invalid or unsupported input in Lumi's test query";
  if (!err) return null;
  const texts = [e, get("message"), get("detail"), get("msg"), get("reason"), get("hint"), isObj(e) ? e.message : undefined].map(textOf).join(" | ");
  if (PLACEHOLDER.test(request) || PLACEHOLDER.test(texts)) return "unfilled placeholder in Lumi's test request";
  if (INPUT_TEXT.test(texts)) return "the error names Lumi's test input";
  return null;
}

/** Empty result? Returns a short description, or null. Assumes errorShape() already returned null. */
function emptyShape(j: unknown): string | null {
  if (j == null) return "JSON null";
  if (typeof j === "string") return j.trim() ? null : "empty JSON string";
  if (Array.isArray(j)) return j.length ? null : "empty JSON array";
  if (!isObj(j)) return null;
  if (!Object.keys(j).length) return "empty JSON object";
  // Explicit screening answer anywhere in the top two levels: a "no match" result, not an empty feed.
  const lvl2 = Object.values(j).filter(isObj) as Record<string, unknown>[];
  if ([j, ...lvl2].some((o) => Object.keys(o).some(isScreeningKey))) return null;
  // Data-feed body: at least one payload array, all payload arrays empty, nothing else of substance.
  let arrays = 0;
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4) return;
    if (Array.isArray(v)) { arrays++; return; }
    if (isObj(v)) for (const [k, x] of Object.entries(v)) if (!isEnvelope(k)) walk(x, depth + 1);
  };
  walk(j, 0);
  if (arrays > 0 && !hasPayload(j)) return "result lists were empty";
  return null;
}

function tryJson(text: string): { ok: true; v: unknown } | { ok: false } {
  const t = text.trim();
  if (!/^[[{"]|^(null|true|false|-?\d)/.test(t)) return { ok: false };
  try { return { ok: true, v: JSON.parse(t) }; } catch { return { ok: false }; }
}

export function judgeResponse(i: JudgeInput): Judgement {
  const status = i.status ?? null;
  if (status == null || status === 0) {
    const timeout = /timeout|timed out|abort|no (answer|response) within/i.test(String(i.fetchError ?? ""));
    return { state: "inconclusive", reason: timeout ? "lumi_client_timeout" : "no_http_response", detail: timeout ? "no response before Lumi's client timeout" : "no HTTP response recorded" };
  }
  if (status < 200 || status > 299) {
    // HTTP 400/422 after payment whose body says Lumi's own input was invalid (e.g. INPUT_INVALID with field details).
    if (status === 400 || status === 422) {
      const j4 = tryJson(String(i.body ?? ""));
      const q = j4.ok && isObj(j4.v) ? ourQueryShape(j4.v, String(i.request ?? ""), errorShape(j4.v) ?? `HTTP ${status}`) : null;
      if (q) return { state: "inconclusive", reason: "our_query_error", detail: `HTTP ${status}; error caused by Lumi's test input (${q})` };
    }
    return { state: "not_delivered", reason: "http_error", detail: `HTTP ${status}` };
  }
  const text = String(i.body ?? "");
  if (!text.trim()) return { state: "not_delivered", reason: "empty_body", detail: "empty body" };
  const j = tryJson(text);
  if (j.ok) {
    if (isObj(j.v)) {
      const e = errorShape(j.v);
      const q = ourQueryShape(j.v, String(i.request ?? ""), e);
      if (q) return { state: "inconclusive", reason: "our_query_error", detail: `error caused by Lumi's test input (${q})` };
      if (e) return { state: "not_delivered", reason: "error_after_payment", detail: `error payload after payment (${e})` };
    }
    const m = emptyShape(j.v);
    if (m) return { state: "inconclusive", reason: "empty_result", detail: `empty result (${m})` };
    const screening = isObj(j.v) && [j.v, ...(Object.values(j.v).filter(isObj) as Record<string, unknown>[])].some((o) => Object.keys(o).some(isScreeningKey));
    return { state: "delivered", reason: screening ? "screening_answer" : "data", detail: "JSON" };
  }
  // Text / HTML: only short, unmistakable error pages count as errors.
  const t = text.trim();
  if (t.length <= 600 && PLAIN_TEXT_ERROR.test(t)) return { state: "not_delivered", reason: "error_after_payment", detail: "plain-text error after payment" };
  if (t.length <= 20_000 && /^<(!doctype html|html)/i.test(t) && HTML_ERROR_TITLE.test(t)) return { state: "not_delivered", reason: "error_after_payment", detail: "HTML error page after payment" };
  return { state: "delivered", reason: "data", detail: /html/i.test(String(i.contentType ?? "")) || /^</.test(t) ? "HTML/text" : "text" };
}

/** Phrase a runner puts in the public summary for each non-delivered reason (factual wording only). */
export const JUDGE_SUMMARY: Record<Exclude<JudgedReason, "data" | "screening_answer">, string> = {
  lumi_client_timeout: "no response before Lumi's client timeout; delivery unknown (inconclusive, Lumi-side; not counted against the seller)",
  no_http_response: "no HTTP response recorded; delivery unknown (inconclusive, Lumi-side; not counted against the seller)",
  http_error: "no data returned",
  empty_body: "empty body; no data returned",
  error_after_payment: "error after payment: the 2xx body was an error message; no data returned",
  empty_result: "empty result for Lumi's test query (inconclusive; not counted against the seller)",
  our_query_error: "error caused by Lumi's own test input, not the seller (inconclusive; not counted against the seller)",
};
