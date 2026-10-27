/**
 * Strict delivery judgement (2026-10-27): one rule for the API and the test-buy runners (src/trust/judge.ts).
 * Fixtures are real response shapes from Lumi's stored paid buys (notes/x402_buys, stellar_buys, Base resp files),
 * anonymised: hosts, ids, addresses and tokens removed or replaced; values shortened.
 */
import { describe, it, expect } from "vitest";
import { judgeResponse, JUDGE_SUMMARY } from "../src/trust/judge";
import { deliveryCounts, deliveryState, deliveryText, guardBuy, inconclusiveReason, isInconclusiveReason, judgedRow, INCONCLUSIVE_REASONS } from "../src/trust/delivery";
import { scoreVendor } from "../src/trust/index";
import type { ObservationRow } from "../src/trust/store";
import { NOW } from "./helpers";

const ok200 = (body: unknown) => judgeResponse({ status: 200, body: typeof body === "string" ? body : JSON.stringify(body) });
const D = 86_400_000;
const BANNED = /\b(scam\w*|fraud\w*|untrustworthy|rip-?off|thie(f|ves)|steal\w*|rug|fake|ponzi|criminal)\b/i;

describe("error after payment: a 2xx error payload is not delivered", () => {
  const cases: [string, unknown][] = [
    ["message-only Not Found (XRPL)", { detail: "Not Found" }],
    ["statusCode 500 in body", { statusCode: 500, message: "Internal server error" }],
    ["status 400 in body", { status: 400, error: "Query parameter 'q' must not be empty" }],
    ["error object, data null", { data: null, error: { code: "UPSTREAM", message: "upstream request failed" }, meta: { request_id: "req_1" } }],
    ["fetch error with provenance only", { url: "https://example", error: "could not fetch url (timeout, DNS, or blocked)", provider: "Example reader", fetched_at: "2026-10-22T20:40:00Z" }],
    ["upstream error code", { error: "surf_upstream_error", upstream_status: 401 }],
    ["error code + message", { error: "unsupported_fiat", message: "\"X\" is not covered. Supported: ARS, BRL" }],
    ["error + disclaimer", { error: "campaign_not_found", disclaimer: "Educational analytics; informational only." }],
    ["success false", { success: false, error: "not_found" }],
    ["ok false + payment envelope", { ok: false, payment: { status: "pending_confirmation", network: "eip155:8453" } }],
    ["GraphQL errors, data null", { status: "success", data: null, errors: [{ message: "Exception while fetching data: Server error" }] }],
    ["JSON-RPC error", { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }],
    ["status: error", { status: "error", message: "service unavailable" }],
    ["upstream_failed after payment", { error: "upstream_failed", message: "This request failed unexpectedly after payment processing began." }],
    ["placeholder not replaced (Stellar)", { error: "replace {pair} with a trading pair, e.g. BTC-USDT" }],
  ];
  for (const [name, body] of cases)
    it(name, () => {
      const j = ok200(body);
      expect(j).toMatchObject({ state: "not_delivered", reason: "error_after_payment" });
      expect(judgedRow(j)).toEqual({ data_returned: false, inconclusive: null });
    });
  it("plain-text and HTML error pages", () => {
    expect(ok200("error code: 502").reason).toBe("error_after_payment");
    expect(ok200("Internal Server Error").reason).toBe("error_after_payment");
    expect(ok200("<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>").reason).toBe("error_after_payment");
  });
});

describe("conservative: real data next to an error-ish field stays delivered", () => {
  it("data plus error: null", () => expect(ok200({ error: null, data: [{ symbol: "XRP", price: 1.3 }] }).state).toBe("delivered"));
  it("status: ok / success: true with payload", () => {
    expect(ok200({ status: "ok" }).state).toBe("delivered");
    expect(ok200({ success: true, service: "Fishing product search", query: "method", count: 12, products: [{ id: 1, name: "Rod" }] }).state).toBe("delivered");
  });
  it("ping payload {data:{ok,paid,server_time}} stays delivered", () => expect(ok200({ data: { ok: true, paid: true, server_time: "2026-10-23T00:00:00Z" }, meta: { v: 1 } }).state).toBe("delivered"));
  it("upstream page status 404 with extracted text stays delivered", () =>
    expect(ok200({ url: "https://example.com/article", status: 404, markdown: "- Example Domain\n\nThis domain is for use in documentation examples without needing permission." }).state).toBe("delivered"));
  it("error name plus structured details stays delivered (not clearly an error-only body)", () =>
    expect(ok200({ name: "INPUT_INVALID", message: "The input is invalid", data: { zid: "<redacted>", details: [{ field: "chainId", reason: "Expected number, received nan" }, { field: "buyToken", reason: "Required" }] } }).state).toBe("delivered"));
  it("message that does not read as an error stays delivered", () => expect(ok200({ message: "No such letter" }).state).toBe("delivered"));
  it("long text answers stay delivered", () => expect(ok200("The forecast for Amsterdam tomorrow is mostly cloudy with a high of 12 C.").state).toBe("delivered"));
});

describe("empty result: inconclusive, not counted against the seller", () => {
  const cases: [string, unknown][] = [
    ["{}", {}],
    ["[]", []],
    ["null", null],
    ["empty rates with a format descriptor (XRPL mesh)", { result: { rates: [], format: ["symbol", "rate", "interval", "apr"] } }],
    ["data [] with error null", { data: [], error: null }],
    ["data [] with paging metadata", { error: null, data: [], metadata: { pageSize: 50, page: 1, totalRows: 0, totalPages: 0 } }],
    ["nested empty list with meta", { data: { candles: [] }, meta: { signal: "candles", version: "v1" } }],
    ["query echo, count 0, empty list", { query: "fed rate", count: 0, markets: [] }],
    ["ok true + payer envelope, empty jobs", { ok: true, network: "base", jobs: [] }],
    ["source + count 0 + empty candidates", { source: "public API", count: 0, fetched_at: "2026-10-26T19:55:38Z", candidates: [] }],
  ];
  for (const [name, body] of cases)
    it(name, () => {
      const j = ok200(body);
      expect(j).toMatchObject({ state: "inconclusive", reason: "empty_result" });
      expect(judgedRow(j)).toEqual({ data_returned: false, inconclusive: "empty_result" });
    });
});

describe("explicit screening 'no match' answers stay delivered", () => {
  it("match_count 0 / matches []", () =>
    expect(ok200({ schema_version: "2026-43", query: { owner_address: "<redacted>" }, matches: [], match_count: 0, pricing_status: "paid" })).toMatchObject({ state: "delivered", reason: "screening_answer" }));
  it("clean / no-hits verdict with other fields", () => {
    expect(ok200({ address: "<redacted>", sanctioned: false, lists_checked: ["OFAC SDN"], checked_at: "2026-10-24T00:00:00Z" }).state).toBe("delivered");
    expect(ok200({ count: 0, threats: [], checked: "example.com" }).state).toBe("delivered");
    expect(ok200({ data: { attestation: { canonVersion: "sanctions-screen-v2" }, screen: { hits: [] } } }).state).toBe("delivered");
  });
  it("exists:false with a 'Not found' message is an answer, not an error", () =>
    expect(ok200({ timestamp: "2026-10-26T19:51:54Z", query: { type: "address", value: "<redacted>" }, exists: false, types: [], message: "Not found in database." }).state).toBe("delivered"));
  it("validator {valid:false, errors:[...]} is the product's answer", () =>
    expect(ok200({ valid: false, errors: [{ location: "#", keyword: "required", error: "Instance does not have required property \"name\"." }] }).state).toBe("delivered"));
});

describe("unchanged rules", () => {
  it("our own client timeout / no response stays inconclusive", () => {
    expect(judgeResponse({ status: null, body: "", fetchError: "The operation was aborted due to timeout" })).toMatchObject({ state: "inconclusive", reason: "lumi_client_timeout" });
    expect(judgeResponse({ status: 0, body: null })).toMatchObject({ state: "inconclusive", reason: "no_http_response" });
    expect(judgedRow(judgeResponse({ status: null, body: "", fetchError: "timeout" }))).toEqual({ data_returned: false, inconclusive: "lumi_client_timeout" });
  });
  it("non-2xx and 0-byte 2xx stay not delivered", () => {
    expect(judgeResponse({ status: 502, body: "{\"data\":[1]}" })).toMatchObject({ state: "not_delivered", reason: "http_error" });
    expect(judgeResponse({ status: 200, body: "  " })).toMatchObject({ state: "not_delivered", reason: "empty_body" });
  });
  it("summaries never use banned words and say 'not counted' for inconclusive reasons", () => {
    for (const t of [...Object.values(JUDGE_SUMMARY), ...Object.values(INCONCLUSIVE_REASONS)]) expect(t).not.toMatch(BANNED);
    expect(JUDGE_SUMMARY.empty_result).toMatch(/not counted against the seller/);
    expect(JUDGE_SUMMARY.empty_result).not.toMatch(/Lumi-side/);
  });
});

describe("empty_result in storage and scoring", () => {
  const obs = (ts: number, o: Partial<ObservationRow> = {}): ObservationRow => ({
    vendor_id: "v", endpoint: "https://v.example/x", ts, network: "xrpl:0", tx_hash: String(ts).padEnd(64, "0"), amount: "1", asset: "RLUSD",
    http_status: 200, data_returned: true, latency_ms: 300, summary: "ok", source: "test", ...o,
  });
  it("is a valid inconclusive reason; wording is not 'Lumi-side'", () => {
    expect(isInconclusiveReason("empty_result")).toBe(true);
    const r = { http_status: 200, data_returned: false, inconclusive: "empty_result" };
    expect(deliveryState(r)).toBe("inconclusive");
    expect(inconclusiveReason(r)).toBe("empty_result");
    expect(deliveryText(r)).toMatch(/empty result/);
    expect(deliveryText(r)).not.toMatch(/Lumi-side|no (usable )?data/);
    expect(deliveryText({ http_status: null, data_returned: false })).toMatch(/Lumi-side/);
    const g = guardBuy({ http_status: 200, data_returned: false, inconclusive: "empty_result", summary: "Base test-buy: HTTP 200, empty result (result lists were empty)" });
    expect(g.inconclusive).toBe("empty_result");
    expect(g.summary).toMatch(/not counted against the seller\)\.$/);
    expect(g.summary).not.toMatch(/Lumi-side/);
  });
  it("is excluded from the delivery rate and never counts as a failure", () => {
    const probes = { n: 10, ok: 10, latencies: [300], latest: [] } as any;
    const rows = [obs(NOW - 3 * D), obs(NOW - 2 * D), obs(NOW - D, { data_returned: false, inconclusive: "empty_result" })];
    expect(deliveryCounts(rows)).toEqual({ delivered: 2, not_delivered: 0, inconclusive: 1, conclusive: 2 });
    const withEmpty = scoreVendor(probes, rows as any, [], NOW);
    const without = scoreVendor(probes, rows.slice(0, 2) as any, [], NOW);
    expect((withEmpty.components.delivery as any).value).toBe(1);
    expect(withEmpty.value).toBe(without.value);
    expect((withEmpty.components.delivery as any).inconclusive).toBe(1);
    // The same body judged as an error after payment does count.
    const withErr = scoreVendor(probes, [...rows.slice(0, 2), obs(NOW - D, { data_returned: false })] as any, [], NOW);
    expect(withErr.value!).toBeLessThan(without.value!);
  });
});
