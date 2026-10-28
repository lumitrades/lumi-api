import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { MemoryEvidenceStore, D1EvidenceStore, baseLogs, utcDay, INFLOW_RETENTION_DAYS, BASE_NET, type InflowRow } from "../src/trust/evidence";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, miniflareD1Options } from "./helpers";

const DAY = 86_400_000;
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SELLER = "0x" + "ab".repeat(20);
const P1 = "0x" + "11".repeat(20);
const P2 = "0x" + "22".repeat(20);
const row = (payer: string, t: number, n = 1, tx = "0x" + t.toString(16)): InflowRow => ({ pay_to: SELLER, payer, n, units: 10_000 * n, first_ts: t, last_ts: t, first_block: Math.floor(t / 2000), last_tx: tx });

describe("base_inflow 90-day retention", () => {
  it("baseLogs splits a block range that crosses UTC midnight into one row per day", async () => {
    const midnight = Math.floor(NOW / DAY) * DAY;
    const head = { block: 10_000, ts: midnight + 60_000 }; // block 10000 is 1 min after midnight
    const pad = (a: string) => "0x" + "0".repeat(24) + a.slice(2);
    const log = (b: number, tx: string) => ({ address: USDC, topics: [TOPIC, pad(P1), pad(SELLER)], data: "0x2710", blockNumber: "0x" + b.toString(16), transactionHash: tx });
    const logs = [log(9_900, "0xa"), log(9_960, "0xb"), log(9_990, "0xc")]; // 3:20 and 1:20 before, 0:40 after midnight
    const f = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: logs }))) as unknown as typeof fetch;
    const rows = await baseLogs(f, ["https://b/"], [SELLER], 9_900, 10_000, head);
    expect(rows.map((r) => [r.day, r.n, r.last_tx]).sort()).toEqual([[utcDay(midnight - DAY), 2, "0xb"], [utcDay(midnight), 1, "0xc"]]);
  });

  it("memory store: reads sum the kept days; the prune deletes days older than 90 and funders of payers no longer kept", async () => {
    const ev = new MemoryEvidenceStore();
    await ev.addInflow([row(P1, NOW - 100 * DAY, 4), row(P1, NOW - 10 * DAY, 2), row(P1, NOW - DAY, 1, "0xlast"), row(P2, NOW - 95 * DAY, 3)]);
    expect(ev.inflow.size).toBe(4);
    const all = await ev.inflowFor(SELLER, 10);
    expect(all.find((r) => r.payer === P1)).toMatchObject({ n: 7, units: 70_000, first_ts: NOW - 100 * DAY, last_ts: NOW - DAY, last_tx: "0xlast" });
    expect((await ev.outflowOf(P1, NOW - 90 * DAY, 10))[0]).toMatchObject({ n: 3, last_tx: "0xlast" });
    await ev.putFunders([
      { network: BASE_NET, account: P1, funder: "0xf1", checked_at: NOW - 99 * DAY, note: null },
      { network: BASE_NET, account: P2, funder: "0xf2", checked_at: NOW - 94 * DAY, note: null },
      { network: "xrpl:0", account: "rX", funder: "rF", checked_at: NOW - 200 * DAY, note: null },
    ]);
    const cut = NOW - INFLOW_RETENTION_DAYS * DAY;
    const r = await ev.pruneInflow(utcDay(cut), cut);
    expect(r).toMatchObject({ inflow_days: 2, funders: 1 });
    expect([...ev.inflow.values()].every((x) => x.day! >= utcDay(cut))).toBe(true);
    expect(await ev.inflowFor(SELLER, 10)).toEqual([expect.objectContaining({ payer: P1, n: 3, first_ts: NOW - 10 * DAY })]);
    expect((await ev.funders(BASE_NET, [P1, P2])).map((f) => f.account)).toEqual([P1]); // P1 still has kept days
    expect(await ev.funders("xrpl:0", ["rX"])).toHaveLength(1); // only Base payer rows are pruned here
  });

  it("the catalog cron prunes once per UTC day and logs the counts", async () => {
    let t = NOW;
    const ev = new MemoryEvidenceStore();
    const catalogStore = new MemoryCatalogStore();
    const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret" };
    const app = createApp(ENV as any, { fetch: makeFetch(happyFacilitator()), now: () => t, catalogStore, evidenceStore: ev });
    await ev.addInflow([row(P1, NOW - 120 * DAY), row(P1, NOW - 91 * DAY), row(P2, NOW - 3 * DAY)]);
    const r1: any = await app.scheduled();
    expect(r1.catalog.inflow_prune).toMatchObject({ retention_days: 90, inflow_days: 2 });
    expect(JSON.parse((await catalogStore.getMeta("inflow_prune"))!)).toMatchObject({ day: utcDay(NOW), inflow_days: 2 });
    await ev.addInflow([row(P1, NOW - 100 * DAY)]);
    t += 30 * 60_000;
    const r2: any = await app.scheduled();
    if (utcDay(t) === utcDay(NOW)) { expect(r2.catalog.inflow_prune).toBeUndefined(); expect(ev.inflow.size).toBe(2); }
    t = NOW + DAY;
    const r3: any = await app.scheduled();
    expect(r3.catalog.inflow_prune).toMatchObject({ inflow_days: 1 });
    expect([...ev.inflow.values()].map((x) => x.payer)).toEqual([P2]);
  });

  it("D1: migration 0032 moves running totals to per-day rows, empties base_inflow; upserts, summed reads and the prune work in SQL (miniflare)", async () => {
    const { Miniflare, convertV4MiniflareOptions } = await import("miniflare") as any;
    const mf = new Miniflare(miniflareD1Options(convertV4MiniflareOptions));
    try {
      const db: any = await mf.getD1Database("DB");
      const run = async (f: string, only?: RegExp) => { for (const st of readFileSync(f, "utf8").replace(/--.*$/gm, "").split(";").map((x) => x.trim()).filter(Boolean)) if (!only || only.test(st)) await db.prepare(st).run(); };
      await run("migrations/0009_evidence.sql", /^CREATE TABLE IF NOT EXISTS (base_inflow|funders|funder_todo) /);
      // A legacy running total (first payment 100 days ago, last 2 days ago) and a recent one.
      await db.prepare("INSERT INTO base_inflow VALUES (?1, ?2, 5, 50000, ?3, ?4, 7, '0xold')").bind(SELLER, P1, NOW - 100 * DAY, NOW - 2 * DAY).run();
      await db.prepare("INSERT INTO base_inflow VALUES (?1, ?2, 1, 10000, ?3, ?3, 9, '0xp2')").bind(SELLER, P2, NOW - 5 * DAY).run();
      await run("migrations/0032_base_inflow_daily.sql");
      expect((await db.prepare("SELECT COUNT(*) AS c FROM base_inflow").first()).c).toBe(0);
      const moved = (await db.prepare("SELECT payer, day, n FROM base_inflow_daily ORDER BY payer").all()).results;
      expect(moved).toEqual([{ payer: P1, day: utcDay(NOW - 100 * DAY), n: 5 }, { payer: P2, day: utcDay(NOW - 5 * DAY), n: 1 }]);
      const st = new D1EvidenceStore(db);
      await st.addInflow([row(P1, NOW - DAY, 2, "0xnew")]);
      await st.addInflow([row(P1, NOW - DAY + 1000, 1, "0xnewer")]); // same day: upsert
      expect((await db.prepare("SELECT COUNT(*) AS c FROM base_inflow_daily").first()).c).toBe(3);
      const p1 = (await st.inflowFor(SELLER, 10)).find((r) => r.payer === P1)!;
      expect(p1).toMatchObject({ n: 8, last_ts: NOW - DAY + 1000, last_tx: "0xnewer", first_ts: NOW - 100 * DAY });
      // The moved running total (last payment 2 days ago) is still inside the window; its first_ts shows it began earlier.
      expect((await st.outflowOf(P1, NOW - 90 * DAY, 10))[0]).toMatchObject({ pay_to: SELLER, n: 8, first_ts: NOW - 100 * DAY, last_tx: "0xnewer" });
      expect((await st.outflowOf(P1, NOW - 1.5 * DAY, 10))[0]).toMatchObject({ n: 3, first_ts: NOW - DAY });
      const plan = JSON.stringify((await db.prepare("EXPLAIN QUERY PLAN SELECT * FROM base_inflow_daily WHERE payer = ?1 AND last_ts >= ?2").bind(P1, 0).all()).results);
      expect(plan).toContain("base_inflow_daily_payer");
      await db.prepare("INSERT INTO funders VALUES (?1, ?2, '0xf', ?3, NULL)").bind(BASE_NET, P1, NOW - 99 * DAY).run();
      await db.prepare("INSERT INTO funders VALUES (?1, ?2, '0xf', ?3, NULL)").bind(BASE_NET, "0x" + "33".repeat(20), NOW - 99 * DAY).run();
      await db.prepare("INSERT INTO funder_todo VALUES (?1, 1, ?2)").bind("0x" + "44".repeat(20), NOW - 95 * DAY).run();
      await db.prepare("INSERT INTO base_inflow VALUES (?1, ?2, 1, 1, ?3, ?3, 1, '0xlegacy')").bind(SELLER, "0x" + "55".repeat(20), NOW - 91 * DAY).run();
      const cut = NOW - 90 * DAY;
      const r = await st.pruneInflow(utcDay(cut), cut);
      expect(r).toEqual({ cutoff_day: utcDay(cut), inflow_days: 1, legacy_rows: 1, funders: 1, funder_todo: 1 });
      expect((await st.inflowFor(SELLER, 10)).map((x) => [x.payer, x.n])).toEqual([[P1, 3], [P2, 1]]);
      expect((await db.prepare("SELECT account FROM funders").all()).results).toEqual([{ account: P1 }]);
    } finally { await mf.dispose(); }
  });
});
