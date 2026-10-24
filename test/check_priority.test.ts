/**
 * Free and paid trust checks send ONE test-buy priority signal (Bobby, Oct 23 2026: payment never affects the order).
 * Abuse limits, identical for both: one slot per seller per UTC day, TRUST_PRIORITY_DAILY_CAP sellers per day (default 5),
 * never-test-bought Base sellers only.
 */
import { describe, it, expect } from "vitest";
import { createApp, priorityCap } from "../src/app";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { PRIORITY_DAILY_CAP } from "../src/trust/catalog_service";
import { MemoryEvidenceStore } from "../src/trust/evidence";
import { MemoryTrialStore } from "../src/trial";
import { wrapFetchWithSIWx } from "@x402/extensions/sign-in-with-x";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RPC = "https://base-rpc.test";
const XR = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const DAY = 86_400_000;
const item = (resource: string, accepts: any[], calls = 0) => ({
  resource, type: "http", description: "d", accepts, extensions: { bazaar: { info: { input: { method: "GET", type: "http" } } } },
  quality: { l30DaysTotalCalls: calls, l30DaysUniquePayers: calls ? 4 : 0, lastCalledAt: new Date(NOW - 3_600_000).toISOString() }, lastUpdated: new Date(NOW).toISOString(),
});
const payTo = (i: number) => "0x" + (0xabc0000 + i).toString(16).padStart(40, "0");
const base = (i: number) => item(`https://api.s${i}.com/v1/q`, [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: payTo(i) }]);
// 8 never-bought Base sellers with no Bazaar usage (a warning sign), a second listing of seller 1, and an XRPL seller.
const ITEMS = [
  ...Array.from({ length: 8 }, (_, i) => base(i + 1)),
  item("https://api.s1.com/v1/other", [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: payTo(1) }]),
  item("https://api.xseller.com/v1/q", [{ scheme: "exact", network: "xrpl:0", asset: "XRP", amount: "10000", payTo: XR }]),
];
const ENV = {
  XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: "k".repeat(52),
  XRPL_RPC_URLS: "https://xrpl.rpc.test/",
  EVM_PAY_TO: "0x5E617bac19912e6d212CB303ae84655E9E203532", EVM_NETWORK: "eip155:84532", EVM_FACILITATOR_URL: "https://evm-fac.test", BASE_RPC_URL: RPC,
};
const enc = (u: string) => encodeURIComponent(u);
const R = (i: number) => `https://api.s${i}.com/v1/q`;

async function setup(env: Record<string, string> = {}) {
  let t = NOW;
  const ev = new MemoryEvidenceStore();
  ev.resources = new Set(ITEMS.map((i) => i.resource));
  const catalogStore = new MemoryCatalogStore();
  const fallback = makeFetch(happyFacilitator());
  const doFetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources"))
      return new Response(JSON.stringify({ items: ITEMS, pagination: { limit: 30, offset: 0, total: ITEMS.length } }));
    if (url === "https://xrpl.rpc.test/") return new Response(JSON.stringify({ result: { transactions: [] } }));
    if (url.startsWith(RPC)) {
      const b = JSON.parse(String(init?.body ?? "{}"));
      if (b.method === "eth_call") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (50_000n).toString(16).padStart(64, "0") }));
      return new Response("no", { status: 404 });
    }
    if (/^https:\/\/api\.(s\d|xseller)\.com\//.test(url)) return new Response("nope", { status: 200 });
    return fallback(input, init);
  }) as typeof fetch;
  const app = createApp({ ...ENV, ...env } as any, { fetch: doFetch, log: () => {}, now: () => t, catalogStore, evidenceStore: ev, trialStore: new MemoryTrialStore() });
  await app.scheduled();
  const req = (p: string, init: RequestInit = {}) => {
    const r = new Request("http://lumi.test" + p, init);
    const h = new Headers(r.headers); h.set("CF-Connecting-IP", "203.0.113." + Math.floor(Math.random() * 250));
    return app.fetch(new Request(r, { headers: h }));
  };
  const free = async (u: string) => { const r = await req("/v1/trust/vendors?url=" + enc(u)); expect(r.status).toBe(200); };
  const paid = async (u: string) => {
    const p = "/v1/trust/check?url=" + enc(u);
    const q: any = await (await req(p)).json();
    const r = await req(p, { headers: { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts.find((a: any) => a.network.startsWith("xrpl:"))) } });
    expect(r.status).toBe(200);
    await new Promise((s) => setTimeout(s, 0));
  };
  const trial = async (u: string) => {
    const via = ((i: any, init?: RequestInit) => {
      const r = i instanceof Request ? i : new Request(String(i), init);
      const h = new Headers(r.headers); h.set("CF-Connecting-IP", "198.51.100." + Math.floor(Math.random() * 250));
      return app.fetch(new Request(r, { headers: h }));
    }) as typeof fetch;
    const f = wrapFetchWithSIWx(via, privateKeyToAccount(generatePrivateKey()));
    const r = await f("http://lumi.test/v1/trust/check?url=" + enc(u), { headers: { "X-Lumi-Trial": "1" } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).access).toMatchObject({ mode: "trial", charged: false });
  };
  const snapshot = () => ({
    queue: [...ev.queue.values()].map(({ resource, network, price_usd, reasons, hits, status, queued_at, updated_at, note }) => ({ resource, network, price_usd, reasons, hits, status, queued_at, updated_at, note })).sort((a, b) => a.resource.localeCompare(b.resource)),
    priority: [...ev.priority.values()].sort((a, b) => a.seller.localeCompare(b.seller)),
  });
  const ownerQueue = async () => ((await (await req("/v1/trust/catalog/buy-queue?status=queued", { headers: { Authorization: "Bearer " + "k".repeat(52) } })).json()) as any).rows as any[];
  return { app, ev, catalogStore, req, free, paid, trial, snapshot, ownerQueue, advance: (ms: number) => (t += ms) };
}

describe("test-buy priority: free and paid checks are identical", () => {
  it("free lookup, free trial trust/check and paid trust/check produce the same queue effects", async () => {
    const a = await setup(), b = await setup(), c = await setup();
    await a.paid(R(1)); await b.free(R(1)); await c.trial(R(1));
    const sa = a.snapshot();
    expect(sa.queue).toHaveLength(1);
    expect(sa.queue[0]).toMatchObject({ resource: R(1), network: "eip155:8453", status: "queued", hits: 1 });
    expect(sa.queue[0].reasons).toContain("no_bazaar_usage");
    expect(sa.priority).toEqual([{ day: "2026-10-22", seller: "api.s1.com", resource: R(1), at: NOW }]);
    expect(b.snapshot()).toEqual(sa);
    expect(c.snapshot()).toEqual(sa);
    expect(await b.ownerQueue()).toEqual(await a.ownerQueue());
    // The same mixed sequence of checks in either payment mode ends in the same queue.
    const x = await setup(), y = await setup();
    for (const [i, how] of [[2, "paid"], [3, "free"], [2, "free"], [4, "paid"], [3, "paid"]] as const) await (how === "paid" ? x.paid(R(i)) : x.free(R(i)));
    for (const i of [2, 3, 2, 4, 3]) await y.free(R(i));
    expect(y.snapshot()).toEqual(x.snapshot());
  });

  it("dedupes per seller per UTC day (any mix of free and paid, any listing of the seller); the next day counts again", async () => {
    const s = await setup();
    await s.free(R(1)); await s.paid(R(1)); await s.free(R(1)); await s.trial(R(1));
    await s.paid("https://api.s1.com/v1/other"); await s.free("https://api.s1.com/v1/other");
    let snap = s.snapshot();
    expect(snap.queue.map((q) => [q.resource, q.hits])).toEqual([[R(1), 1]]);
    expect(snap.priority).toHaveLength(1);
    s.advance(DAY);
    await s.paid(R(1));
    snap = s.snapshot();
    expect(snap.queue.map((q) => [q.resource, q.hits])).toEqual([[R(1), 2]]);
    expect(snap.priority.map((p) => p.day)).toEqual(["2026-10-22", "2026-10-23"]);
  });

  it("caps jumped sellers per day at 5 by default, counting free and paid together", async () => {
    expect(PRIORITY_DAILY_CAP).toBe(5);
    const s = await setup();
    for (let i = 1; i <= 8; i++) await (i % 2 ? s.free(R(i)) : s.paid(R(i)));
    expect(s.snapshot().queue.map((q) => q.resource)).toEqual([1, 2, 3, 4, 5].map(R));
    expect(s.snapshot().priority).toHaveLength(5);
    // Spamming the capped-out sellers changes nothing, free or paid.
    for (let i = 6; i <= 8; i++) { await s.free(R(i)); await s.paid(R(i)); }
    expect(s.snapshot().queue).toHaveLength(5);
    expect(s.snapshot().queue.every((q) => q.hits === 1)).toBe(true);
    s.advance(DAY);
    for (let i = 6; i <= 8; i++) await s.free(R(i));
    expect(s.snapshot().queue.map((q) => q.resource)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(R));
  });

  it("TRUST_PRIORITY_DAILY_CAP is configurable (0 = off)", async () => {
    const two = await setup({ TRUST_PRIORITY_DAILY_CAP: "2" });
    for (let i = 1; i <= 4; i++) await two.paid(R(i));
    for (let i = 1; i <= 4; i++) await two.free(R(i));
    expect(two.snapshot().queue.map((q) => q.resource)).toEqual([R(1), R(2)]);
    const off = await setup({ TRUST_PRIORITY_DAILY_CAP: "0" });
    await off.paid(R(1)); await off.free(R(2)); await off.trial(R(3));
    expect(off.snapshot().queue).toHaveLength(0);
    expect([priorityCap(undefined), priorityCap(""), priorityCap("x"), priorityCap("-1"), priorityCap("2.5"), priorityCap("7"), priorityCap("0")]).toEqual([5, 5, 5, 5, 5, 7, 0]);
  });

  it("only never-test-bought Base sellers: a seller Lumi already bought, or a non-Base seller, never jumps (free or paid)", async () => {
    const s = await setup();
    await s.catalogStore.addBuy({ resource: "https://api.s2.com/v1/q", domain: "api.s2.com", ts: NOW - 90 * DAY, network: "eip155:8453", tx_hash: "0x" + "b".repeat(64), amount: "0.01", asset: "USDC", pay_to: payTo(2), facilitator: null, http_status: 200, data_returned: true, latency_ms: 100, summary: "ok" } as any);
    // Inconclusive (Lumi-side) buys do not count as a test-buy.
    await s.catalogStore.addBuy({ resource: "https://api.s3.com/v1/q", domain: "api.s3.com", ts: NOW - DAY, network: "eip155:8453", tx_hash: "0x" + "c".repeat(64), amount: "0.01", asset: "USDC", pay_to: payTo(3), facilitator: null, http_status: null, data_returned: false, latency_ms: null, summary: "timeout", inconclusive: "lumi_timeout" } as any);
    await s.free(R(2)); await s.paid(R(2)); await s.trial(R(2));
    await s.free("https://api.xseller.com/v1/q"); await s.paid("https://api.xseller.com/v1/q");
    await s.free(R(3));
    expect(s.snapshot().queue.map((q) => q.resource)).toEqual([R(3)]);
    // Rejected sellers use no cap slot.
    expect(s.snapshot().priority.map((p) => p.seller)).toEqual(["api.s3.com"]);
  });
});
