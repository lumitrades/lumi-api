import { describe, it, expect } from "vitest";
import { COUNTING, BADGE_LAPSE_MS, countBuys, endpointKey } from "../src/commerce/counting";
import { badgeStatus, COUNTING_TEXT } from "../src/commerce/monitor";
import { PACK_BADGE_LABEL } from "../src/commerce/plans";
import type { BuyRow } from "../src/trust/catalog";
import type { PlanRow, RunRow } from "../src/commerce/store";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 20, 10, 0, 0); // 10:00 UTC
const EP = "https://api.seller.com/v1/data";
const en = { id: "men_x", network: "xrpl:1", pay_to: "rSeller", pay_to_lc: "rseller", domain: null, proof: "", nonce: "n", endpoints: [{ url: EP, method: "GET", price_usd: "0.01", asset: null, amount: null, checked_at: null, source: "seller" }], webhook_url: null, webhook_secret: null, email: null, token_hash: "h", is_test: false, created_at: T0 - 10 * DAY } as any;
const plan = (p: string, over: Partial<PlanRow> = {}): PlanRow => ({ id: `pl_${p}`, enrollment_id: en.id, plan: p, starts_at: T0 - DAY, ends_at: T0 + 365 * DAY, paid_tx: `tx_${p}`, paid_network: "xrpl:1", paid_asset: "XRP", paid_amount: "1", payer: null, usd: 6.5, budget_usd: 3, spent_usd: 0, is_test: false, reminded: 0, created_at: T0 - DAY, credits: 30, ...over }) as any;
let n = 0;
const run = (ts: number, outcome: string, over: Partial<RunRow> = {}): RunRow => ({ id: ++n, enrollment_id: en.id, plan_id: "pl_retest_pack", endpoint: EP, ts, network: "xrpl:1", tx_hash: null, amount: "1", asset: "XRP", cost_usd: 0.01, http_status: outcome === "delivered" ? 200 : 500, data_returned: outcome === "delivered", latency_ms: 100, outcome, quote_pay_to: null, quote_price_usd: null, schema_hash: null, note: null, funding: "seller-funded", ...over });
const buy = (ts: number, delivered: boolean, over: Partial<BuyRow> = {}): BuyRow => ({ resource: EP, domain: "seller.com", ts, network: "xrpl:1", tx_hash: "T", amount: "1", asset: "XRP", pay_to: "rSeller", facilitator: null, http_status: delivered ? 200 : 502, data_returned: delivered, latency_ms: 90, summary: "", ...over });
// runsFor returns newest first
const newest = (rs: RunRow[]) => [...rs].sort((a, b) => b.ts - a.ts);

describe("counting: one counted test-buy per endpoint per UTC day", () => {
  it("rules are the adopted ones", () => {
    expect(COUNTING).toEqual({ perEndpointPerUtcDay: 1, badgeLapseDays: 30 });
    expect(COUNTING_TEXT.rule).toContain("whichever came first");
    expect(COUNTING_TEXT.score).toContain("never seller-paid runs");
  });
  it("a paid retry the same day after a failure is not counted; the failure stands and removes the badge", () => {
    const runs = newest([run(T0, "error_status"), run(T0 + 3_600_000, "delivered")]);
    const c = countBuys(runs, []);
    expect(c.map((x) => [x.delivered, x.counted, x.not_counted_reason])).toEqual([[true, false, "earlier_buy_same_day"], [false, true, undefined]]);
    const b = badgeStatus(en, [plan("retest_pack")], runs, T0 + 4 * 3_600_000);
    expect(b).toMatchObject({ ok: false, reason: "monitoring_failed" });
    // next UTC day a delivered buy counts and restores it
    const next = newest([...runs, run(T0 + DAY, "delivered")]);
    expect(badgeStatus(en, [plan("retest_pack")], next, T0 + DAY + 60_000)).toMatchObject({ ok: true, last_test: T0 + DAY });
  });
  it("Lumi's baseline buy that came first takes the day: a later paid run that day is history only", () => {
    const baseline = [buy(T0, false)]; // Lumi baseline saw a failure at 10:00
    const runs = [run(T0 + 2 * 3_600_000, "delivered")]; // seller pays a re-test at 12:00
    const c = countBuys(runs, baseline);
    expect(c.find((x) => x.source === "seller_paid")).toMatchObject({ counted: false, not_counted_reason: "lumi_baseline_buy_first" });
    expect(c.find((x) => x.source === "lumi_baseline")).toMatchObject({ counted: true, delivered: false });
    expect(badgeStatus(en, [plan("retest_pack")], runs, T0 + 3 * 3_600_000, baseline)).toMatchObject({ ok: false, reason: "monitoring_failed" });
  });
  it("an exact tie goes to the baseline buy; inconclusive baseline buys (Lumi-side) are not test-buys", () => {
    const c = countBuys([run(T0, "delivered")], [buy(T0, false)]);
    expect(c.find((x) => x.counted)!.source).toBe("lumi_baseline");
    const inc = countBuys([run(T0 + 1000, "delivered")], [buy(T0, false, { inconclusive: "lumi_timeout", http_status: null })]);
    expect(inc.filter((x) => x.counted).map((x) => x.source)).toEqual(["seller_paid"]);
  });
  it("quote-only and skipped runs are not test-buys and never date the badge", () => {
    const runs = newest([run(T0, "delivered"), run(T0 + DAY, "quote_only", { cost_usd: 0 }), run(T0 + 2 * DAY, "skipped")]);
    expect(countBuys(runs, []).map((x) => x.ts)).toEqual([T0]);
    expect(badgeStatus(en, [plan("retest_pack")], runs, T0 + 3 * DAY)).toMatchObject({ ok: true, last_test: T0 });
  });
  it("endpoint keys match a catalog resource to the enrolled URL (case of host, trailing slash)", () => {
    expect(endpointKey("https://API.Seller.com/v1/data/")).toBe(endpointKey(EP));
    expect(countBuys([], [buy(T0, true, { resource: "https://API.seller.com/v1/data/" })], [EP])).toHaveLength(1);
  });
});

describe("badge: dated by the last delivered counted buy, lapses after 30 days", () => {
  it("a pack holder's badge shows the last delivered counted buy and the pack label", () => {
    const runs = newest([run(T0, "delivered"), run(T0 + 5 * DAY, "delivered")]);
    const b = badgeStatus(en, [plan("retest_pack")], runs, T0 + 6 * DAY);
    expect(b).toMatchObject({ ok: true, last_test: T0 + 5 * DAY, result: "pass" });
    expect(PACK_BADGE_LABEL).toContain("paid");
  });
  it("Lumi's baseline buys keep a pack holder's badge dated like any other counted buy", () => {
    const b = badgeStatus(en, [plan("retest_pack")], [run(T0, "delivered")], T0 + 20 * DAY, [buy(T0 + 15 * DAY, true)]);
    expect(b).toMatchObject({ ok: true, last_test: T0 + 15 * DAY });
  });
  it("lapses 30 days after the last delivered counted buy, even with an unexpired pack", () => {
    const runs = [run(T0, "delivered")];
    expect(badgeStatus(en, [plan("retest_pack")], runs, T0 + BADGE_LAPSE_MS - 1000)).toMatchObject({ ok: true });
    expect(badgeStatus(en, [plan("retest_pack")], runs, T0 + BADGE_LAPSE_MS + 1000)).toMatchObject({ ok: false, reason: "no_recent_test", last_test: T0 });
  });
  it("a removed badge still reports the date of the last delivered counted buy", () => {
    const runs = newest([run(T0, "delivered"), run(T0 + 2 * DAY, "no_data")]);
    expect(badgeStatus(en, [plan("retest_pack")], runs, T0 + 3 * DAY)).toMatchObject({ ok: false, reason: "monitoring_failed", last_test: T0 });
  });
  it("tier windows shorter than 30 days still apply (Watch: 9 days); no window is longer than 30 days", () => {
    const runs = [run(T0, "delivered", { plan_id: "pl_watch" })];
    const watch = plan("watch", { ends_at: T0 + 29 * DAY, endpoints: 1 } as any);
    expect(badgeStatus(en, [watch], runs, T0 + 8 * DAY)).toMatchObject({ ok: true });
    expect(badgeStatus(en, [watch], runs, T0 + 10 * DAY)).toMatchObject({ ok: false, reason: "no_recent_test" });
    const monitor = plan("monitor", { ends_at: T0 + 60 * DAY }); // legacy 35-day window is capped at 30
    expect(badgeStatus(en, [monitor], runs, T0 + 31 * DAY)).toMatchObject({ ok: false, reason: "no_recent_test" });
  });
  it("paying cannot add counted buys: ten paid runs in a day count once, exactly like one baseline buy", () => {
    const paid = newest(Array.from({ length: 10 }, (_, i) => run(T0 + i * 60_000, i === 0 ? "no_data" : "delivered")));
    const counted = countBuys(paid, []).filter((x) => x.counted);
    expect(counted).toHaveLength(1);
    expect(counted[0].delivered).toBe(false);
    const baseOnly = countBuys([], [buy(T0, false)]).filter((x) => x.counted);
    expect(baseOnly).toHaveLength(1);
    expect(badgeStatus(en, [plan("retest_pack")], paid, T0 + DAY / 2).ok).toBe(false);
  });
  it("an expired pack gives no badge (plan lapsed)", () => {
    const old = plan("retest_pack", { ends_at: T0 + DAY });
    expect(badgeStatus(en, [old], [run(T0, "delivered")], T0 + 2 * DAY)).toMatchObject({ ok: false, reason: "plan_lapsed" });
  });
});
