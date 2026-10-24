import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app";
import { MemoryTrustStore } from "../src/trust/store";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { MemoryOutcomeStore, D1OutcomeStore, parseOutcome, OUTCOME_FIELDS } from "../src/trust/outcomes";
import { NOW, PAY_TO, FACILITATOR, DATA, happyFacilitator, makeFetch } from "./helpers";

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
    const { Miniflare } = await import("miniflare");
    const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('') } }", d1Databases: ["DB"] });
    try {
      const db: any = await mf.getD1Database("DB");
      for (const st of readFileSync("migrations/0018_check_outcomes.sql", "utf8").replace(/--.*$/gm, "").split(";").map((x) => x.trim()).filter(Boolean)) await db.prepare(st).run();
      const store = new D1OutcomeStore(db);
      await store.add([{ day: "2026-10-23", subject: "a.example", delivered: 1, failed: 0, by_class: { "2xx": 1 } }]);
      await store.add([{ day: "2026-10-23", subject: "a.example", delivered: 0, failed: 2, by_class: { "5xx": 1, timeout: 1 } }]);
      expect(await store.list("2026-01-01", 10)).toEqual([{ day: "2026-10-23", subject: "a.example", delivered: 1, failed: 2, by_class: { "2xx": 1, "5xx": 1, timeout: 1 } }]);
      expect(await store.purge("2026-12-01")).toBe(1);
    } finally { await mf.dispose(); }
  });
});
