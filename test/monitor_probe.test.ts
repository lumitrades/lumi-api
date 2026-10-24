import { describe, it, expect } from "vitest";
import { dueTargets, parseQuote, rollup, detectTransitions, type Sample, type ProbeTarget } from "../tools/monitor_probe";

const T0 = Date.parse("2026-10-23T10:00:00Z");
const tgt = (every: number): ProbeTarget => ({ enrollment_id: "men_a", endpoint: "https://x.test/a", method: "GET", every_ms: every, plan: "watch", network: "xrpl:0", pay_to: "rA" });
const smp = (ts: number, ok: boolean, extra: Partial<Sample> = {}): Sample => ({ enrollment_id: "men_a", endpoint: "https://x.test/a", ts, ok, ms: 100, amount: "1000", asset: "XRP", pay_to: "rA", ...extra });

describe("box-side monitor probe (pure parts)", () => {
  it("probes a target only when its tier interval elapsed", () => {
    const st = { eps: { "men_a|https://x.test/a": { last_ts: T0, ok: true, fails: 0, pay_to: "rA", amount: "1" } }, samples: [] };
    expect(dueTargets([tgt(3_600_000)], st, T0 + 10 * 60_000)).toHaveLength(0);
    expect(dueTargets([tgt(15 * 60_000)], st, T0 + 15 * 60_000)).toHaveLength(1);
    expect(dueTargets([tgt(3_600_000)], { eps: {}, samples: [] }, T0)).toHaveLength(1);
  });
  it("parses an unpaid 402 and treats anything else as a failed check", () => {
    expect(parseQuote(402, { accepts: [{ network: "eip155:8453", amount: "5", asset: "USDC", payTo: "0x1" }, { network: "xrpl:0", amount: "9", asset: "XRP", payTo: "rA" }] }, "xrpl:0")).toMatchObject({ ok: true, amount: "9", pay_to: "rA" });
    expect(parseQuote(200, {}, "xrpl:0").ok).toBe(false);
    expect(parseQuote(402, { accepts: [] }, "xrpl:0").error).toBe("no_accepts");
  });
  it("rolls samples up to one row per endpoint per UTC day with p50/p95", () => {
    const xs = [smp(T0, true, { ms: 100 }), smp(T0 + 1, true, { ms: 300 }), smp(T0 + 2, false), smp(T0 + 86_400_000, true)];
    const r = rollup(xs);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ day: "2026-10-23", checks: 3, ok: 2, p50_ms: 100, p95_ms: 300, quote_pay_to: "rA" });
  });
  it("alerts on down after 2 failures, recovery, payTo and price changes", () => {
    let st = detectTransitions(undefined, smp(T0, true)).next;
    let d = detectTransitions(st, smp(T0 + 1, false));
    expect(d.transitions).toHaveLength(0);
    d = detectTransitions(d.next, smp(T0 + 2, false));
    expect(d.transitions.map((x) => x.kind)).toEqual(["quote_down"]);
    d = detectTransitions(d.next, smp(T0 + 3, true, { pay_to: "rB", amount: "2000" }));
    expect(d.transitions.map((x) => x.kind)).toEqual(["quote_recovered", "pay_to_changed", "price_changed"]);
    st = d.next;
    expect(detectTransitions(st, smp(T0 + 4, true, { ms: 9000, pay_to: "rB", amount: "2000" }), 5000, [9000, 9000, 9000, 9000]).transitions.map((x) => x.kind)).toEqual(["latency_p95_high"]);
  });
});
