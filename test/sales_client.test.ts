import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { MemorySalesStore, OWN_WALLETS, isOwnWallet, toRow, insertWithRetry, D1SalesStore, type SaleRow } from "../src/sales";
import { clientLabel, uaFamily } from "../src/traffic";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret" };
const BASE = "http://lumi.test";
const row = (tx: string): SaleRow => toRow({ route: "signal", rail: "base", network: "eip155:8453", asset: "USDC", amount: "0.01", tx, payer: "0xabc" }, NOW);

describe("sales: client type, own wallets, retry (1.1.7)", () => {
  it("labels the client from the User-Agent only, at most 40 chars", () => {
    expect(clientLabel("SettledScout/0.1 (+https://settled.tools/bot; pays once, records delivery)")).toBe("bot: SettledScout/0.1");
    expect(clientLabel("lumiere-paycheck-prober/1.0 (+https://lumierepaycheck.org)")).toBe("other: lumiere-paycheck-prober/1.0");
    expect(uaFamily("Mozilla/5.0 (compatible; Agent402/1.0; +https://agent402.tools/crawler)")).toBe("Agent402/1.0");
    expect(clientLabel("node")).toBe("sdk: node");
    expect(clientLabel(null)).toBe("other: none");
    expect(clientLabel("x".repeat(200)).length).toBeLessThanOrEqual(40);
  });

  it("includes the Solana buyer in the own-wallet list", () => {
    expect(OWN_WALLETS).toContain("4LDMGj8V3zCtsXhcNynncstLbfncPhF3GG46eken8EFC");
    expect(isOwnWallet("4LDMGj8V3zCtsXhcNynncstLbfncPhF3GG46eken8EFC")).toBe(true);
  });

  it("records the paying client's type on the sale row (no IP)", async () => {
    const salesStore = new MemorySalesStore();
    const app = createApp(ENV as any, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW, salesStore });
    const q = await (await app.fetch(new Request(BASE + "/v1/macro/yen"))).json();
    const hdr = paymentHeaderFor(q.accepts.find((a: any) => a.network.startsWith("xrpl:")));
    const r = await app.fetch(new Request(BASE + "/v1/macro/yen", { headers: { "PAYMENT-SIGNATURE": hdr, "User-Agent": "SettledScout/0.1 (+https://settled.tools/bot)", "CF-Connecting-IP": "203.0.113.9" } }));
    expect(r.status).toBe(200);
    expect(salesStore.rows).toHaveLength(1);
    expect(salesStore.rows[0].client).toBe("bot: SettledScout/0.1");
    expect(JSON.stringify(salesStore.rows[0])).not.toContain("203.0.113.9");
  });

  it("retries a transient insert failure once", async () => {
    const mem = new MemorySalesStore();
    let fails = 1;
    const flaky = { insert: async (r: SaleRow) => { if (fails-- > 0) throw new Error("D1_ERROR: internal error"); return mem.insert(r); }, since: mem.since.bind(mem) };
    expect(await insertWithRetry(flaky, row("0xr1"), 1)).toBe(true);
    expect(mem.rows).toHaveLength(1);
    const dead = { insert: async () => { throw new Error("down"); }, since: mem.since.bind(mem) };
    await expect(insertWithRetry(dead, row("0xr2"), 1)).rejects.toThrow("down");
  });

  it("D1 insert writes the client column, and falls back when the column is missing", async () => {
    const sqls: string[] = [];
    let hasColumn = false;
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            sqls.push(sql);
            if (!hasColumn && sql.includes(", client)")) throw new Error("D1_ERROR: table sales has no column named client");
            return { meta: { changes: 1 }, args };
          },
          all: async () => ({ results: [] }),
          first: async () => null,
        }),
      }),
    } as any;
    const s = new D1SalesStore(db);
    expect(await s.insert({ ...row("0xd1"), client: "bot: X/1" })).toBe(true);
    expect(sqls).toHaveLength(2);
    hasColumn = true;
    sqls.length = 0;
    expect(await s.insert({ ...row("0xd2"), client: "bot: X/1" })).toBe(true);
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain("client");
  });
});

describe("public copy (1.1.7)", () => {
  it("llms.txt and the docs page carry the pay-address line and the trial is 3 calls in total", async () => {
    const app = createApp(ENV as any, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW, salesStore: new MemorySalesStore() });
    const llms = await (await app.fetch(new Request(BASE + "/llms.txt"))).text();
    const html = await (await app.fetch(new Request(BASE + "/", { headers: { Accept: "text/html" } }))).text();
    for (const t of [llms, html]) {
      expect(t).toMatch(/always take Lumi's pay address/);
      expect(t).toMatch(/never from transaction history or a past transfer/);
      expect(t).not.toMatch(/on every paid endpoint/);
      expect(t).not.toMatch(/scam/i);
    }
  });
});
