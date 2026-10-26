import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { MemorySalesStore, salesSummary, toRow, sendSaleAlert, OWN_WALLETS } from "../src/sales";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, jsonResponse, makeFetch, paymentHeaderFor, type FakeFacilitator } from "./helpers";

const KEY = "owner-key-for-tests-0123456789abcdef";
const EVM_PAY_TO = "0x5E617bac19912e6d212CB303ae84655E9E203532";
const EVM_FAC = "https://evm-facilitator.test";
const HOOK = "https://hooks.example.test/sales";
const ENV = {
  XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: KEY,
  EVM_PAY_TO, EVM_NETWORK: "eip155:84532", EVM_FACILITATOR_URL: EVM_FAC,
};
const BASE = "http://lumi.test";

function setup(env: Record<string, unknown> = {}, evmTx = "0x" + "c".repeat(64)) {
  const evm: FakeFacilitator = {
    calls: [],
    verify: (b) => jsonResponse(200, { isValid: true, payer: b.paymentPayload.payload.authorization.from }),
    settle: (b) => jsonResponse(200, { success: true, transaction: evmTx, network: b.paymentRequirements.network }),
  };
  const xrpl = happyFacilitator();
  const base = makeFetch(xrpl);
  const hooks: any[] = [];
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === HOOK) {
      hooks.push(JSON.parse(String(init?.body)));
      return new Response("ok");
    }
    if (url.startsWith(EVM_FAC)) {
      const path = url.slice(EVM_FAC.length);
      const body = JSON.parse(String(init?.body ?? "{}"));
      evm.calls.push({ path, body });
      return path === "/verify" ? evm.verify(body) : evm.settle(body);
    }
    return base(input, init);
  }) as typeof fetch;
  const salesStore = new MemorySalesStore();
  const app = createApp({ ...ENV, ...env } as any, { fetch: doFetch, log: () => {}, now: () => NOW, salesStore });
  const appFetch = ((input: RequestInfo | URL, init?: RequestInit) => app.fetch(input instanceof Request ? input : new Request(String(input), init))) as typeof fetch;
  return { app, appFetch, salesStore, hooks };
}

function buyer(pk = generatePrivateKey()) {
  const account = privateKeyToAccount(pk);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  return { account, client };
}

async function payXrpl(app: ReturnType<typeof createApp>, path: string) {
  const q = await (await app.fetch(new Request(BASE + path))).json();
  return app.fetch(new Request(BASE + path, { headers: { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts.find((a: any) => a.network.startsWith("xrpl:"))) } }));
}

describe("sales ledger", () => {
  it("records one row per settle on both rails, with rail, asset, decimal amount, list USD and payer", async () => {
    const { app, appFetch, salesStore } = setup();
    const { account, client } = buyer();
    expect((await wrapFetchWithPayment(appFetch, client)(BASE + "/v1/verdict?url=https%3A%2F%2Fa.example%2Fx")).status).toBe(200);
    expect((await payXrpl(app, "/v1/trust/check?url=https%3A%2F%2Fa.example%2Fx")).status).toBe(200);
    expect(salesStore.rows).toHaveLength(2);
    const [b, x] = salesStore.rows;
    expect(b).toMatchObject({ route: "verdict", routeKey: "verdict", rail: "base", network: "eip155:84532", asset: "USDC", amount: "0.01", usd: 0.01, payer: account.address, isTest: false });
    expect(x).toMatchObject({ route: "trust_check", routeKey: "trust_check", rail: "xrpl", network: "xrpl:1", asset: "XRP", isTest: false, usd: 0.0198 }); // 0.015 XRP valued at the fallback 1.32 USD/XRP
    expect(Number(x.amount)).toBeGreaterThan(0);
    expect(x.amount).not.toMatch(/^\d{4,}$/); // XRP, not drops
  });

  it("marks Lumi's own wallets as test sales (case-insensitive) and the summary excludes them", async () => {
    const { appFetch, salesStore, app } = setup();
    // A real key is not needed: toRow marks by payer address.
    expect(toRow({ route: "signal", rail: "base", network: "eip155:8453", asset: "USDC", amount: "0.01", tx: "0x1", payer: OWN_WALLETS[0].toLowerCase() }, NOW).isTest).toBe(true);
    expect(toRow({ route: "signal", rail: "xrpl", network: "xrpl:0", asset: "XRP", amount: "0.005", tx: "A1", payer: "rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM" }, NOW).isTest).toBe(true);
    await salesStore.insert(toRow({ route: "signal", rail: "base", network: "eip155:8453", asset: "USDC", amount: "0.01", usd: 0.01, tx: "0xtest", payer: OWN_WALLETS[0] }, NOW - 1000));
    await salesStore.insert(toRow({ route: "brief", rail: "base", network: "eip155:8453", asset: "USDC", amount: "0.03", usd: 0.03, tx: "0xold", payer: "0xabc" }, NOW - 10 * 86_400_000));
    await salesStore.insert(toRow({ route: "brief", rail: "base", network: "eip155:8453", asset: "USDC", amount: "0.03", usd: 0.03, tx: "0xold", payer: "0xabc" }, NOW));
    expect((await wrapFetchWithPayment(appFetch, buyer().client)(BASE + "/v1/verdict?url=https%3A%2F%2Fa.example%2Fx")).status).toBe(200);

    const unauth = await app.fetch(new Request(BASE + "/v1/owner/sales"));
    expect(unauth.status).toBe(401);
    expect((await app.fetch(new Request(BASE + "/v1/owner/sales", { headers: { Authorization: "Bearer wrong" } }))).status).toBe(401);
    const r = await app.fetch(new Request(BASE + "/v1/owner/sales", { headers: { Authorization: `Bearer ${KEY}` } }));
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    const s = await r.json();
    expect(s.today_utc.sales).toBe(1);
    expect(s.last_7d.sales).toBe(1);
    expect(s.last_30d.sales).toBe(2); // duplicate tx ignored, test wallet excluded
    expect(s.last_30d.usd_list_total).toBe(0.04);
    expect(s.by_route_30d.verdict.sales).toBe(1);
    expect(s.by_route_30d.brief.sales).toBe(1);
    expect(s.by_route_30d.signal).toBeUndefined();
    expect(s.test_sales_30d.sales).toBe(1);
    expect(s.alert).toEqual({ webhook: false, email: false });
    const all = await (await app.fetch(new Request(BASE + "/v1/owner/sales?include_tests=1", { headers: { Authorization: `Bearer ${KEY}` } }))).json();
    expect(all.last_30d.sales).toBe(3);
  });

  it("alerts the configured webhook (background via waitUntil), skips test wallets, never blocks the sale", async () => {
    const { app, hooks, salesStore } = setup({ SALES_WEBHOOK_URL: HOOK });
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) };
    const ctxFetch = ((input: RequestInfo | URL, init?: RequestInit) => app.fetch(input instanceof Request ? input : new Request(String(input), init), ctx)) as typeof fetch;
    expect((await wrapFetchWithPayment(ctxFetch, buyer().client)(BASE + "/v1/verdict?url=https%3A%2F%2Fa.example%2Fx")).status).toBe(200);
    await Promise.all(pending);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].text).toMatch(/^Lumi sale: verdict paid 0\.01 USDC on Base \(~\$0\.01\) tx 0x/);
    expect(hooks[0].sale.route).toBe("verdict");

    // Lumi's own buyer wallet: recorded as test, no alert.
    const ownKeyAccount = buyer(); // stands in for an own wallet via SALES_TEST_WALLETS
    const own2 = setup({ SALES_WEBHOOK_URL: HOOK, SALES_TEST_WALLETS: ownKeyAccount.account.address }, "0x" + "e".repeat(64));
    expect((await wrapFetchWithPayment(own2.appFetch, ownKeyAccount.client)(BASE + "/v1/verdict?url=https%3A%2F%2Fa.example%2Fx")).status).toBe(200);
    expect(own2.salesStore.rows[0].isTest).toBe(true);
    expect(own2.hooks).toHaveLength(0);
    expect(salesStore.rows[0].isTest).toBe(false);
  });

  it("a failing ledger or alert never fails the paid response", async () => {
    const broken = { insert: async () => { throw new Error("d1 down"); }, since: async () => [] };
    const app = createApp({ ...ENV, SALES_WEBHOOK_URL: "https://unreachable.invalid/x" } as any, {
      fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW, salesStore: broken as any,
    });
    expect((await payXrpl(app, "/v1/trust/check?url=https%3A%2F%2Fa.example%2Fx")).status).toBe(200);
  });

  it("email alert goes through the send_email binding when recipient, sender and binding are all set", async () => {
    const sent: any[] = [];
    const row = toRow({ route: "brief", rail: "xrpl", network: "xrpl:0", asset: "RLUSD", amount: "0.03", usd: 0.03, tx: "ABC", payer: "rBuyer" }, NOW);
    const via = await sendSaleAlert(
      { email: "owner@example.test", emailFrom: "sales@lumitrades.io", emailBinding: { send: async (m) => void sent.push(m) }, makeMessage: (f, t, raw) => ({ f, t, raw }) },
      row,
      fetch,
    );
    expect(via).toEqual(["email"]);
    expect(sent[0].raw).toMatch(/Subject: Lumi sale: brief paid 0\.03 RLUSD on XRPL/);
    expect(await salesSummary(new MemorySalesStore(), NOW)).toMatchObject({ last_30d: { sales: 0 } });
  });
});

describe("payments refused at settlement are not revenue", () => {
  it("salesSummary drops refused txs from every total and lists them separately", async () => {
    const store = new MemorySalesStore();
    const now = Date.UTC(2026, 9, 25, 12);
    await store.insert(toRow({ route: "monitor", rail: "xrpl", network: "xrpl:0", asset: "RLUSD", amount: "5", usd: 5, payer: "rBuyerA", tx: "KEEP" }, now - 1000));
    await store.insert(toRow({ route: "monitor", rail: "xrpl", network: "xrpl:0", asset: "RLUSD", amount: "5", usd: 5, payer: "rBuyerB", tx: "LOST" }, now - 500));
    const s = await salesSummary(store, now, { refusedTx: ["LOST"] });
    expect(s.last_30d).toMatchObject({ sales: 1, usd_list_total: 5 });
    expect(s.today_utc.sales).toBe(1);
    expect(s.by_route_30d.monitor.sales).toBe(1);
    expect(s.recent.map((r) => r.tx)).toEqual(["KEEP"]);
    expect(s.refused_at_settlement_30d).toMatchObject({ sales: 1, usd_list_total: 5, excluded_from_revenue: true, txs: ["LOST"] });
    expect((await salesSummary(store, now)).last_30d.sales).toBe(2);
  });
});
