import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app";
import { MemoryTrustStore } from "../src/trust/store";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { MemoryOutcomeStore, D1OutcomeStore, parseOutcome, OUTCOME_FIELDS, createOutcomes, type OutcomeStore } from "../src/trust/outcomes";
import { NOW, PAY_TO, FACILITATOR, DATA, happyFacilitator, makeFetch, miniflareD1Options } from "./helpers";

const BASE = "https://api.lumitrades.io";
const OWNER = "owner-key-for-tests-0123456789-abcdefghijklmnop";
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PUBLIC_BASE_URL: BASE, OWNER_MCP_KEY: OWNER };
const FORBIDDEN = {
  payTo: "0x1111111111111111111111111111111111111111", wallet: "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY", amount: "10000", amountUsd: 0.01,
  tx_hash: "A".repeat(64), url: "https://api.seller.example/data?q=secret", query: "q=secret", path: "/data", payload: { a: 1 }, body: "x",
  client_id: "stable-123", install_id: "abc", ip: "1.2.3.4", network: "eip155:8453",
};

function mk() {
  const outcomeStore = new MemoryOutcomeStore();
  const app = createApp(ENV as any, { trustStore: new MemoryTrustStore([]), catalogStore: new MemoryCatalogStore(), outcomeStore, now: () => NOW, fetch: makeFetch(happyFacilitator()), log: () => {} } as any);
  const post = (b: unknown, ip = "9.9.9.9") => app.fetch(new Request(BASE + "/v1/check/outcome", { method: "POST", body: typeof b === "string" ? b : JSON.stringify(b), headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip } }));
  const owner = async () => (await (await app.fetch(new Request(BASE + "/v1/owner/check-outcomes", { headers: { Authorization: `Bearer ${OWNER}` } }))).json()) as any;
  return { app, post, owner, outcomeStore };
}
const ok = { v: 1, subject: "api.seller.example", delivered: true, status_class: "2xx" };

describe("Lumi Check tier 1: anonymous delivery outcomes", () => {
  it("accepts only subject + delivered + coarse status class (+ per-event token) and stores aggregate counters", async () => {
    const s = mk();
    expect((await s.post(ok)).status).toBe(202);
    expect((await s.post({ ...ok, delivered: false, status_class: "5xx", token: "t".repeat(22) })).status).toBe(202);
    expect((await s.post({ v: 1, subject: "vendor:printmoneylab", delivered: true })).status).toBe(202);
    const o = await s.owner();
    const row = o.rows.find((r: any) => r.subject === "api.seller.example");
    expect(row).toEqual({ day: new Date(NOW).toISOString().slice(0, 10), subject: "api.seller.example", delivered: 1, failed: 1, by_class: { "2xx": 1, "5xx": 1 } });
    expect(JSON.stringify(o)).not.toMatch(/9\.9\.9\.9|tttt/);
  });

  it("rejects every forbidden field (wallet, amount, tx hash, URL/query/path, payload, stable id, IP) and stores nothing", async () => {
    const s = mk();
    for (const [k, v] of Object.entries(FORBIDDEN)) {
      const r = await s.post({ ...ok, [k]: v });
      expect(r.status, k).toBe(400);
      expect(((await r.json()) as any).field).toBe(k);
    }
    // A URL or wallet smuggled into subject is rejected too.
    for (const subject of ["https://api.seller.example/data?q=1", "api.seller.example/data", "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY", "0x1111111111111111111111111111111111111111"])
      expect((await s.post({ ...ok, subject })).status, subject).toBe(400);
    expect((await s.post({ ...ok, status_class: "402 Payment Required" })).status).toBe(400);
    expect((await s.post({ ...ok, token: "short" })).status).toBe(400);
    expect((await s.post("not json")).status).toBe(400);
    expect((await s.owner()).rows).toEqual([]);
  });

  it("token only drops replays (no linking), rate limit applies, and outcomes never change scores", async () => {
    const s = mk();
    const before = await (await s.app.fetch(new Request(BASE + "/v1/trust/vendors/printmoneylab"))).text();
    const tok = "r".repeat(24);
    expect(((await (await s.post({ ...ok, token: tok })).json()) as any).status).toBe("recorded");
    expect(((await (await s.post({ ...ok, token: tok })).json()) as any).status).toBe("replay");
    for (let i = 0; i < 50; i++) await s.post({ v: 1, subject: "vendor:printmoneylab", delivered: false, status_class: "5xx" }, "8.8.8.8");
    let limited = false;
    for (let i = 0; i < 130; i++) if ((await s.post(ok, "7.7.7.7")).status === 429) limited = true;
    expect(limited).toBe(true);
    const after = await (await s.app.fetch(new Request(BASE + "/v1/trust/vendors/printmoneylab"))).text();
    expect(after).toBe(before);
  });

  it("allowed-field list is exactly the documented one", () => {
    expect([...OUTCOME_FIELDS]).toEqual(["v", "subject", "delivered", "status_class", "token"]);
    expect(parseOutcome({ ...ok, extra: 1 })).toMatchObject({ ok: false, field: "extra" });
  });

  it("D1 store: migration 0018 applies and counters accumulate (miniflare)", async () => {
    const { Miniflare, convertV4MiniflareOptions } = await import("miniflare") as any;
    const mf = new Miniflare(miniflareD1Options(convertV4MiniflareOptions));
    try {
      const db: any = await mf.getD1Database("DB");
      for (const st of (readFileSync("migrations/0018_check_outcomes.sql", "utf8") + ";" + readFileSync("migrations/0019_check_outcome_rollup.sql", "utf8")).replace(/--.*$/gm, "").split(";").map((x) => x.trim()).filter(Boolean)) await db.prepare(st).run();
      const store = new D1OutcomeStore(db);
      await store.add([{ day: "2026-10-23", subject: "a.example", delivered: 1, failed: 0, by_class: { "2xx": 1 } }]);
      await store.add([{ day: "2026-10-23", subject: "a.example", delivered: 0, failed: 2, by_class: { "5xx": 1, timeout: 1 } }]);
      expect(await store.list("2026-01-01", 10)).toEqual([{ day: "2026-10-23", subject: "a.example", delivered: 1, failed: 2, by_class: { "2xx": 1, "5xx": 1, timeout: 1 } }]);
    } finally { await mf.dispose(); }
  });
});

const DAY = 86_400_000;
const T0 = Date.parse("2026-07-01T03:07:00Z");
const dayAt = (t: number) => new Date(t).toISOString().slice(0, 10);
const rec = (o: ReturnType<typeof createOutcomes>, subject: string, delivered: boolean, status_class: string | null) => o.record({ ok: true, subject, delivered, status_class, token: null });

/** Shared scenario for the memory and D1 stores. */
async function rollupScenario(store: OutcomeStore, rawReads?: () => number) {
  let t = T0 - 2 * DAY + 3_600_000; // 2026-06-29 04:07
  const o = createOutcomes(store, () => t);
  const d1 = dayAt(t);
  rec(o, "a.example", true, "2xx"); rec(o, "a.example", true, "2xx"); rec(o, "a.example", false, "5xx"); rec(o, "b.example", false, "timeout");
  await o.flush();
  rec(o, "a.example", false, null); await o.flush(); // a second flush for the same day accumulates in the raw counters
  t += DAY; const d2 = dayAt(t);
  rec(o, "b.example", true, "2xx"); await o.flush();
  t = T0; // 2026-07-01 03:07: roll up 06-29 and 06-30 (today stays raw)
  rec(o, "c.example", true, "2xx");
  const n1 = await o.nightly();
  expect(n1.rolled).toEqual([d1, d2]);
  expect(n1.summaries).toBe(3);
  const want = [
    { day: d2, subject: "b.example", reports: 1, checks: null, delivered: 1, failed: 0, by_class: { "2xx": 1 } },
    { day: d1, subject: "a.example", reports: 4, checks: null, delivered: 2, failed: 2, by_class: { "2xx": 2, "5xx": 1 } },
    { day: d1, subject: "b.example", reports: 1, checks: null, delivered: 0, failed: 1, by_class: { timeout: 1 } },
  ];
  expect(await store.summaries("2026-01-01", 100)).toEqual(want);
  const reads1 = rawReads?.();
  // Idempotent: re-running the same night (or re-rolling a day) never double counts, and reads no raw day again.
  const n2 = await o.nightly();
  expect(n2).toMatchObject({ rolled: [], rerolled: [], summaries: 0, purged_days: [] });
  await store.rollup(d1, t); await store.rollup(d1, t);
  expect(await store.summaries("2026-01-01", 100)).toEqual(want);
  if (rawReads) expect(rawReads() - reads1!).toBe(4); // only the two forced re-rolls of d1 (2 rows each)
  // A late flush for a rolled day marks it dirty; the next night re-rolls it with the full (not doubled) total.
  t = T0 + 3_600_000;
  await store.add([{ day: d2, subject: "b.example", delivered: 0, failed: 1, by_class: { "4xx": 1 } }]);
  expect((await store.rollupDay(d2))?.dirty).toBe(true);
  t = T0 + DAY;
  const n3 = await o.nightly();
  expect(n3.rolled).toEqual([dayAt(T0)]);
  expect(n3.rerolled).toEqual([d2]);
  expect((await store.summaries(d2, 100)).find((r) => r.day === d2)).toMatchObject({ reports: 2, delivered: 1, failed: 1, by_class: { "2xx": 1, "4xx": 1 } });
  return { o, d1, d2, setT: (x: number) => (t = x) };
}

describe("Lumi Check tier 1: nightly rollup (summaries kept forever) + 90-day raw purge", () => {
  it("rolls each closed UTC day into one summary per seller, reads each raw day once, and is idempotent (memory)", async () => {
    const store = new MemoryOutcomeStore();
    await rollupScenario(store, () => store.rawReads);
  });

  it("purges raw rows only after 90 days and only for rolled-up, clean days; summaries survive forever", async () => {
    const store = new MemoryOutcomeStore();
    const { o, d1, d2, setT } = await rollupScenario(store);
    // An old day that was never rolled up (e.g. the rollup was down) and a dirty day: the purge must skip both.
    await store.add([{ day: "2026-01-10", subject: "z.example", delivered: 1, failed: 0, by_class: {} }]);
    await store.add([{ day: "2026-01-11", subject: "y.example", delivered: 1, failed: 0, by_class: {} }]);
    await store.rollup("2026-01-11", T0);
    await store.add([{ day: "2026-01-11", subject: "y.example", delivered: 1, failed: 0, by_class: {} }]); // dirty again
    expect(await store.purgeDay("2026-01-10", T0)).toBe(0); // unrolled: refused
    expect(await store.purgeDay("2026-01-11", T0)).toBe(0); // dirty: refused
    expect((await store.list("2026-01-01", 100)).filter((r) => r.day < "2026-02-01")).toHaveLength(2);
    // 91 days after d2: d1 and d2 are past retention; the dirty old day is re-rolled first and then purged.
    setT(Date.parse(d2 + "T03:07:00Z") + 91 * DAY);
    const n = await o.nightly();
    expect(n.rerolled).toContain("2026-01-11");
    expect(n.purged_days).toEqual(expect.arrayContaining(["2026-01-11", d1, d2]));
    expect(n.purged_days).not.toContain("2026-01-10"); // never rolled (the cursor is past it): kept, not deleted
    const raw = await store.list("2026-01-01", 1000);
    expect(raw.some((r) => r.day === "2026-01-10")).toBe(true);
    expect(raw.some((r) => r.day === d1 || r.day === d2 || r.day === "2026-01-11")).toBe(false);
    const sums = await store.summaries("2026-01-01", 1000);
    expect(sums.filter((r) => r.day === d1)).toHaveLength(2); // summaries kept
    expect(sums.find((r) => r.day === "2026-01-11")).toMatchObject({ reports: 2 });
    expect(n).toMatchObject({ raw_retention_days: 90, summaries_kept: "forever" });
    expect(await store.rollupDay(d1)).toMatchObject({ dirty: false, purged_at: expect.any(Number) });
    // Re-running after the purge changes nothing (summaries are not overwritten with zeros).
    await o.nightly();
    expect(await store.summaries("2026-01-01", 1000)).toEqual(sums);
  });

  it("late rows older than 2 days are dropped at flush, so a purged day can never be reopened", async () => {
    const store = new MemoryOutcomeStore();
    let t = T0;
    const o = createOutcomes(store, () => t);
    rec(o, "a.example", true, "2xx");
    t += 3 * DAY;
    expect(await o.flush()).toBe(0);
    expect(await store.list("2026-01-01", 10)).toEqual([]);
  });

  it("the cron runs the rollup only at 03:07 UTC; other minutes just flush", async () => {
    const outcomeStore = new MemoryOutcomeStore();
    let t = T0 - DAY + 60_000;
    const logs: any[] = [];
    const app = createApp(ENV as any, { trustStore: new MemoryTrustStore([]), catalogStore: new MemoryCatalogStore(), outcomeStore, now: () => t, fetch: makeFetch(happyFacilitator()), log: (e: any) => logs.push(e) } as any);
    const post = (b: unknown) => app.fetch(new Request(BASE + "/v1/check/outcome", { method: "POST", body: JSON.stringify(b), headers: { "Content-Type": "application/json", "CF-Connecting-IP": "9.9.9.9" } }));
    expect((await post(ok)).status).toBe(202);
    const run = async (at: number) => { t = at; const w: Promise<unknown>[] = []; await (app as any).scheduled({ scheduledTime: at, cron: "* * * * *" }, ENV, { waitUntil: (p: Promise<unknown>) => w.push(p) }); await Promise.all(w); };
    await run(T0 - 60_000);
    expect(await outcomeStore.list("2026-01-01", 10)).toHaveLength(1);
    expect(await outcomeStore.summaries("2026-01-01", 10)).toEqual([]);
    await run(T0);
    expect(await outcomeStore.summaries("2026-01-01", 10)).toMatchObject([{ subject: "api.seller.example", reports: 1, delivered: 1 }]);
    expect(logs.find((e) => e.event === "check_outcomes_nightly")).toMatchObject({ rolled: 1 });
    const own: any = await (await app.fetch(new Request(BASE + "/v1/owner/check-outcomes?summary_days=365", { headers: { Authorization: `Bearer ${OWNER}` } }))).json();
    expect(own).toMatchObject({ retention_days: 90, summaries_kept: "forever" });
    expect(own.summaries).toHaveLength(1);
  });

  it("D1 store: migrations 0018 + 0019 apply; rollup, idempotence, dirty re-roll and safe purge in SQL (miniflare)", async () => {
    const { Miniflare, convertV4MiniflareOptions } = await import("miniflare") as any;
    const mf = new Miniflare(miniflareD1Options(convertV4MiniflareOptions));
    try {
      const db: any = await mf.getD1Database("DB");
      const sql = (readFileSync("migrations/0018_check_outcomes.sql", "utf8") + ";" + readFileSync("migrations/0019_check_outcome_rollup.sql", "utf8")).replace(/--.*$/gm, "");
      for (const st of sql.split(";").map((x) => x.trim()).filter(Boolean)) await db.prepare(st).run();
      const store = new D1OutcomeStore(db);
      const { o, d1, d2, setT } = await rollupScenario(store);
      await store.add([{ day: "2026-01-10", subject: "z.example", delivered: 1, failed: 0, by_class: {} }]);
      expect(await store.purgeDay("2026-01-10", T0)).toBe(0); // unrolled: the SQL guard refuses
      await store.add([{ day: d1, subject: "a.example", delivered: 1, failed: 0, by_class: {} }]); // dirty d1
      expect(await store.purgeDay(d1, T0)).toBe(0); // dirty: refused
      setT(Date.parse(d2 + "T03:07:00Z") + 91 * DAY);
      const n = await o.nightly();
      expect(n.rerolled).toContain(d1);
      expect(n.purged_days).toEqual(expect.arrayContaining([d1, d2]));
      const raw = await store.list("2026-01-01", 1000);
      expect(raw.map((r) => r.day)).toContain("2026-01-10");
      expect(raw.some((r) => r.day === d1 || r.day === d2)).toBe(false);
      const sums = await store.summaries("2026-01-01", 1000);
      expect(sums.find((r) => r.day === d1 && r.subject === "a.example")).toMatchObject({ reports: 5, delivered: 3, failed: 2, checks: null });
      await o.nightly();
      expect(await store.summaries("2026-01-01", 1000)).toEqual(sums);
      // Query plans: every statement uses a primary key or partial index (no full scans).
      const plans: string[] = [];
      for (const q of [
        "SELECT day FROM check_rollup_days WHERE dirty = 1 ORDER BY day LIMIT 14",
        "SELECT day FROM check_rollup_days WHERE purged_at IS NULL AND day < '2026-04-01' AND dirty = 0 ORDER BY day LIMIT 14",
        "SELECT day, subject FROM check_outcomes WHERE day = '2026-06-29'",
        "DELETE FROM check_outcomes WHERE day = '2026-06-29'",
        "SELECT MAX(day) FROM check_rollup_days", "SELECT MIN(day) FROM check_outcomes",
      ]) plans.push(JSON.stringify((await db.prepare("EXPLAIN QUERY PLAN " + q).all()).results));
      for (const p of plans) expect(p, p).not.toMatch(/"SCAN (check_outcomes|check_rollup_days)"/);
    } finally { await mf.dispose(); }
  });
});
