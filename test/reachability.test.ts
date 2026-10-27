import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { toListing, MemoryCatalogStore, D1CatalogStore, catalogFreeView } from "../src/trust/catalog";
import { classifySkipReason, classifyProbe, nextReach, reachView, reachStateOf, REACH_OCCASION_GAP_MS, REACH_TEXT, type ReachState } from "../src/trust/reachability";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: "k".repeat(52) };
const BASE = "http://lumi.test";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SELLER = "0xAbCdEf0000000000000000000000000000000001";
const H = 3_600_000;
const owner = { Authorization: "Bearer " + "k".repeat(52), "Content-Type": "application/json" };
const item = (resource: string) => ({
  resource, type: "http", description: "thing", serviceName: "S",
  accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: SELLER }],
  extensions: { bazaar: { info: { input: { method: "GET", type: "http" } } } },
  quality: { l30DaysTotalCalls: 50, l30DaysUniquePayers: 3 },
});
const EMPTY: ReachState = reachStateOf(null);
const fold = (checks: [number, string][]) => checks.reduce((s, [ts, reason]) => nextReach(s, { ts, ...classifySkipReason(reason)! }), EMPTY);
const BANNED = /\b(scam|fraud|malicious)/i;

describe("classifySkipReason (test-buyer skip text)", () => {
  it("maps each reason to the agreed class", () => {
    const k = (r: string) => classifySkipReason(r)?.kind ?? null;
    expect(k("HTTP 404 (expected 402)")).toBe("dead");
    expect(k("HTTP 410 (expected 402)")).toBe("dead");
    expect(k("TypeError: fetch failed")).toBe("dead");
    expect(k("HTTP 503 (expected 402)")).toBe("down");
    expect(k("HTTP 530 (expected 402)")).toBe("down");
    expect(k("TimeoutError: The operation was aborted due to timeout")).toBe("down");
    expect(k("HTTP 200 (expected 402)")).toBe("no_paywall");
    for (const s of [400, 401, 403, 405, 422, 423]) expect(k(`HTTP ${s} (expected 402)`)).toBe("needs_request");
    expect(k("HTTP 429 (expected 402)")).toBe("rate_limited");
    expect(k("quote payTo 0xabc differs from listing")).toBe("pay_to_differs");
    expect(k("unreadable 402: no PAYMENT-REQUIRED header")).toBe("ok");
    // buyer skip for a 402 quote without an EIP-712 domain (seller answered): counts as an answer
    expect(k("quote lacks EIP-712 name/version (seller answered with a 402), skipped")).toBe("ok");
    expect(k("no Base USDC exact option")).toBe("ok");
    expect(k("price 0.2 USDC above $0.05")).toBe("ok");
    // Lumi-side reasons are not about the seller: never recorded
    expect(k("listed price 0.2 above $0.05")).toBeNull();
    expect(k("budget (0.10 left)")).toBeNull();
    expect(k("buyer balance 0.01")).toBeNull();
    expect(k("something new")).toBeNull();
  });
  it("the Worker's own probe uses the same classes", () => {
    expect(classifyProbe({ ts: 1, status: null, valid: false, pay_to_match: null, error: "network error" }).kind).toBe("dead");
    expect(classifyProbe({ ts: 1, status: null, valid: false, pay_to_match: null, error: "no answer within 10 s" }).kind).toBe("down");
    expect(classifyProbe({ ts: 1, status: 402, valid: true, pay_to_match: false, error: null }).kind).toBe("pay_to_differs");
    expect(classifyProbe({ ts: 1, status: 402, valid: true, pay_to_match: true, error: null }).kind).toBe("ok");
    expect(classifyProbe({ ts: 1, status: 402, valid: false, pay_to_match: null, error: "402 without a readable x402 quote" }).kind).toBe("ok");
    expect(classifyProbe({ ts: 1, status: 404, valid: false, pay_to_match: null, error: "x" }).kind).toBe("dead");
    expect(classifyProbe({ ts: 1, status: 405, valid: false, pay_to_match: null, error: "x" }).kind).toBe("needs_request");
  });
});

describe("three strikes on separate occasions", () => {
  it("one failure never flags; repeats within 12 h are one occasion; the 3rd occasion flags", () => {
    const s1 = fold([[NOW, "HTTP 404 (expected 402)"]]);
    expect(reachView(s1)).toMatchObject({ status: "down_when_checked", flag: null, failed_checks_in_a_row: 1 });
    const s2 = fold([[NOW, "HTTP 404 (expected 402)"], [NOW + H, "HTTP 404 (expected 402)"], [NOW + 11 * H, "TypeError: fetch failed"]]);
    expect(s2.reach_strikes).toBe(1);
    expect(reachView(s2)!.last_checked_at).toBe(new Date(NOW + 11 * H).toISOString());
    const s3 = fold([[NOW, "HTTP 404 (expected 402)"], [NOW + REACH_OCCASION_GAP_MS, "HTTP 410 (expected 402)"]]);
    expect(reachView(s3)).toMatchObject({ status: "down_when_checked", failed_checks_in_a_row: 2 });
    const s4 = fold([[NOW, "HTTP 404 (expected 402)"], [NOW + 13 * H, "HTTP 404 (expected 402)"], [NOW + 26 * H, "HTTP 404 (expected 402)"]]);
    const v = reachView(s4)!;
    expect(v).toMatchObject({ status: "listing_looks_dead", flag: "listing_looks_dead", failed_checks_in_a_row: 3, last_result: "HTTP 404", failing_since: new Date(NOW).toISOString(), last_checked_at: new Date(NOW + 26 * H).toISOString() });
    expect(v.note).toContain("Clears automatically");
  });
  it("5xx and timeouts are down when checked, and count only when 3 in a row", () => {
    const s = fold([[NOW, "HTTP 503 (expected 402)"], [NOW + 13 * H, "TimeoutError: aborted"]]);
    expect(reachView(s)!.status).toBe("down_when_checked");
    const s3 = nextReach(s, { ts: NOW + 26 * H, ...classifySkipReason("HTTP 502 (expected 402)")! });
    expect(reachView(s3)!.status).toBe("listing_looks_dead");
  });
  it("any answer in between resets the run (automatic clear), including neutral 4xx", () => {
    const s = fold([[NOW, "HTTP 404 (expected 402)"], [NOW + 13 * H, "HTTP 404 (expected 402)"], [NOW + 20 * H, "HTTP 405 (expected 402)"], [NOW + 26 * H, "HTTP 404 (expected 402)"]]);
    expect(reachView(s)).toMatchObject({ status: "down_when_checked", failed_checks_in_a_row: 1 });
    const dead = fold([[NOW, "HTTP 404 (expected 402)"], [NOW + 13 * H, "HTTP 404 (expected 402)"], [NOW + 26 * H, "HTTP 404 (expected 402)"]]);
    const cleared = nextReach(dead, { ts: NOW + 40 * H, kind: "ok", detail: "answered with a 402 payment request" });
    expect(reachView(cleared)).toMatchObject({ status: "answering", flag: null, failed_checks_in_a_row: 0, failing_since: null });
  });
  it("an older check never overwrites a newer one", () => {
    const s = fold([[NOW + 10 * H, "HTTP 200 (expected 402)"]]);
    expect(nextReach(s, { ts: NOW, kind: "dead", detail: "HTTP 404" })).toBe(s);
  });
  it("notes: no paywall, payTo differs, needs a different request; factual wording only", () => {
    expect(reachView(fold([[NOW, "HTTP 200 (expected 402)"]]))).toMatchObject({ status: "answering", flag: "no_paywall", note: REACH_TEXT.no_paywall });
    expect(reachView(fold([[NOW, "quote payTo 0xabc differs from listing"]]))).toMatchObject({ status: "answering", flag: "pay_to_differs", note: REACH_TEXT.pay_to_differs });
    expect(reachView(fold([[NOW, "HTTP 401 (expected 402)"]]))).toMatchObject({ status: "answering", flag: "needs_different_request" });
    expect(JSON.stringify(REACH_TEXT)).not.toMatch(BANNED);
    expect(reachView(null)).toBeNull();
  });
});

function mk(store = new MemoryCatalogStore(), now = NOW, env: Record<string, string> = {}) {
  let t = now;
  const app = createApp({ ...ENV, ...env } as any, { fetch: makeFetch(happyFacilitator()), now: () => t, catalogStore: store, log: () => {} } as any);
  return { app, store, at: (x: number) => { t = x; } };
}
const post = (app: any, checks: unknown[], headers: Record<string, string> = owner) =>
  app.fetch(new Request(BASE + "/v1/trust/catalog/reachability", { method: "POST", headers, body: JSON.stringify({ checks }) }));

describe("POST /v1/trust/catalog/reachability (owner)", () => {
  it("owner only; records batches; unknown, Lumi-side and excluded checks are counted and ignored", async () => {
    const store = new MemoryCatalogStore();
    await store.upsert([toListing(item("https://api.gone.example/v1/x"))!, toListing(item("https://free.example/v1/y"))!], NOW - 1000);
    const { app, at } = mk(store, NOW + 30 * H);
    expect((await post(app, [], { "Content-Type": "application/json" })).status).toBe(401);
    const iso = (h: number) => new Date(NOW + h * H).toISOString();
    const r = await post(app, [
      { resource: "https://API.gone.example/v1/x/", reason: "HTTP 404 (expected 402)", checked_at: iso(0) },
      { resource: "https://api.gone.example/v1/x", reason: "HTTP 404 (expected 402)", checked_at: iso(13) },
      { resource: "https://api.gone.example/v1/x", reason: "TypeError: fetch failed", checked_at: iso(26) },
      { resource: "https://free.example/v1/y", reason: "HTTP 200 (expected 402)", checked_at: iso(26) },
      { resource: "https://free.example/v1/y", reason: "listed price 0.2 above $0.05", checked_at: iso(26) },
      { resource: "https://unknown.example/z", reason: "HTTP 404 (expected 402)", checked_at: iso(26) },
      { resource: "https://ai-agent-setup-checklist.agentchecklist.workers.dev/x", reason: "HTTP 404 (expected 402)", checked_at: iso(26) },
    ]);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ received: 7, recorded: 4, unknown: 1, ignored: 1, excluded: 1, written: 2 });
    const gone = store.rows.find((x) => x.domain === "api.gone.example")!;
    expect(reachView(gone)).toMatchObject({ status: "listing_looks_dead", failed_checks_in_a_row: 3, last_result: "no answer (DNS or connection failure)" });
    // the flag reaches the free lookup and Lumi Check, with the date of the last check; the decision is not changed by it
    const look = await (await app.fetch(new Request(BASE + "/v1/trust/vendors?url=" + encodeURIComponent("https://api.gone.example/v1/x")))).json() as any;
    expect(look.catalog.entries[0].reachability).toMatchObject({ status: "listing_looks_dead", flag: "listing_looks_dead", last_checked_at: iso(26) });
    const chk = await (await app.fetch(new Request(BASE + "/v1/check?url=" + encodeURIComponent("https://api.gone.example/v1/x")))).json() as any;
    expect(chk.reachability).toMatchObject({ status: "listing_looks_dead", last_checked_at: iso(26) });
    const free = await (await app.fetch(new Request(BASE + "/v1/check?url=" + encodeURIComponent("https://free.example/v1/y")))).json() as any;
    expect(free.reachability).toMatchObject({ flag: "no_paywall", note: REACH_TEXT.no_paywall });
    expect(JSON.stringify([look, chk, free])).not.toMatch(BANNED);
    // a later answer clears it
    at(NOW + 41 * H);
    expect((await (await post(app, [{ resource: "https://api.gone.example/v1/x", reason: "no Base USDC exact option", checked_at: iso(40) }])).json() as any).written).toBe(1);
    expect(reachView(gone)).toMatchObject({ status: "answering", flag: null });
    // nothing new: no write
    expect((await (await post(app, [{ resource: "https://api.gone.example/v1/x", reason: "no Base USDC exact option", checked_at: iso(40) }])).json() as any).written).toBe(0);
  });
  it("rejects oversize batches and future / stale times", async () => {
    const store = new MemoryCatalogStore();
    await store.upsert([toListing(item("https://api.gone.example/v1/x"))!], NOW);
    const { app } = mk(store);
    expect((await post(app, Array(201).fill({}))).status).toBe(400);
    const r = await (await post(app, [
      { resource: "https://api.gone.example/v1/x", reason: "HTTP 404 (expected 402)", checked_at: new Date(NOW + 2 * H).toISOString() },
      { resource: "https://api.gone.example/v1/x", reason: "HTTP 404 (expected 402)", checked_at: new Date(NOW - 31 * 24 * H).toISOString() },
    ])).json() as any;
    expect(r).toMatchObject({ recorded: 0, ignored: 2, written: 0 });
  });
});

describe("worker quote check feeds the same streak", () => {
  it("cron probes write reach state in the probe update; paid views and free views carry it", async () => {
    const store = new MemoryCatalogStore();
    await store.upsert([toListing(item("https://api.gone.example/v1/x"))!], NOW);
    const f = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    let t = NOW;
    const app = createApp(ENV as any, { fetch: f, now: () => t, catalogStore: store, log: () => {} } as any);
    for (let i = 0; i < 3; i++) { t = NOW + i * 13 * H; await app.scheduled(); }
    expect(store.rows[0].probe_status).toBe(404);
    expect(reachView(store.rows[0])).toMatchObject({ status: "listing_looks_dead", failed_checks_in_a_row: 3, last_result: "HTTP 404" });
    expect(catalogFreeView(store.rows[0], [], t).reachability?.flag).toBe("listing_looks_dead");
  });
});

describe("D1 writes stay small", () => {
  it("saveReach is one UPDATE per listing in one batch; saveProbes adds reach columns only when changed", async () => {
    const sql: { q: string; args: unknown[] }[] = [];
    const db: any = {
      prepare: (q: string) => ({ q, bind: (...args: unknown[]) => ({ q, args }) }),
      batch: async (st: any[]) => { sql.push(...st); return st.map(() => ({ meta: { changes: 1, rows_written: 1 } })); },
    };
    const s = new D1CatalogStore(db);
    const st = { ...EMPTY, reach_at: NOW, reach_kind: "dead" as const, reach_detail: "HTTP 404", reach_strikes: 1, reach_strike_at: NOW, reach_since: NOW };
    expect(await s.saveReach([{ id: 7, ...st }, { id: 8, ...st }])).toBe(2);
    expect(sql).toHaveLength(2);
    expect(sql[0].q).toMatch(/^UPDATE catalog SET reach_at = \?.* WHERE id = \?$/);
    expect(sql[0].args).toEqual([NOW, "dead", "HTTP 404", 1, NOW, NOW, 7]);
    sql.length = 0;
    const p = { id: 7, ts: NOW, status: 404, valid: false, pay_to_match: null, price_usd: null, price_match: null, latency_ms: 5, error: "x", hist: "0", lat_hist: "5" };
    await s.saveProbes([p, { ...p, id: 8, reach: st }]);
    expect(sql[0].q).not.toContain("reach_");
    expect(sql[1].q).toContain("reach_since = ?17");
    expect(sql[1].args).toHaveLength(17);
  });
});

describe("listing_looks_dead adds a check_first reason", () => {
  it("Lumi Check and the verdict carry listing_looks_dead (warn); notes do not; it clears with the flag", async () => {
    const store = new MemoryCatalogStore();
    await store.upsert([toListing(item("https://api.gone.example/v1/x"))!, toListing(item("https://free.example/v1/y"))!], NOW - 1000);
    const { app, at } = mk(store, NOW + 30 * H, { VERDICT_PRICING: "free" });
    const iso = (h: number) => new Date(NOW + h * H).toISOString();
    await post(app, [0, 13, 26].map((h) => ({ resource: "https://api.gone.example/v1/x", reason: "HTTP 404 (expected 402)", checked_at: iso(h) })).concat([{ resource: "https://free.example/v1/y", reason: "HTTP 200 (expected 402)", checked_at: iso(26) }]));
    const q = (u: string, p = "/v1/check") => app.fetch(new Request(BASE + p + "?url=" + encodeURIComponent(u))).then((r: Response) => r.json() as any);
    const chk = await q("https://api.gone.example/v1/x");
    expect(chk.reasons).toContainEqual({ code: "listing_looks_dead", severity: "warn" });
    expect(chk.decision).toBe("warn");
    expect(chk.label).toBe("check_first");
    const ver = await q("https://api.gone.example/v1/x", "/v1/verdict");
    expect(ver.label).toBe("check_first");
    expect(ver.reason_codes).toContain("listing_looks_dead");
    expect(ver.reason_code).toBe("listing_looks_dead");
    expect(ver.reason).toMatch(/^listing looks dead: do not pay until it answers again/);
    expect(JSON.stringify([chk, ver])).not.toMatch(BANNED);
    const free = await q("https://free.example/v1/y");
    expect(free.reasons.map((r: any) => r.code)).not.toContain("listing_looks_dead");
    at(NOW + 41 * H);
    await post(app, [{ resource: "https://api.gone.example/v1/x", reason: "no Base USDC exact option", checked_at: iso(40) }]);
    expect((await q("https://api.gone.example/v1/x")).reasons.map((r: any) => r.code)).not.toContain("listing_looks_dead");
  });
});
