/**
 * Bugfixes 2026-10-28:
 * 1. Nightly jobs (contributor purge, check-outcomes rollup) were gated to 03:07 UTC, but scheduled() only runs on the
 *    half-hourly cron (:00/:30), so they never fired. They now run on the 03:00 UTC tick (isNightlyTick).
 * 2. Wallet check listed one row per payTo, so a seller with several payTos (blockrun.ai) appeared several times.
 *    Rows are now one per seller, with every address in pay_tos. Harness copied from wallet_check.test.ts.
 */
import { describe, it, expect } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { createApp, isNightlyTick } from "../src/app";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { MemoryEvidenceStore } from "../src/trust/evidence";
import { MemoryTrialStore } from "../src/trial";
import { MemoryTrustStore } from "../src/trust/store";
import { SEED_OBSERVATIONS } from "../src/trust/seed";
import { MemoryActivityStore } from "../src/trust/activity";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch } from "./helpers";

const DAY = 86_400_000;
const BASE = "https://api.lumitrades.io";
const SEED = Buffer.from(ed25519.utils.randomPrivateKey()).toString("hex");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const payTo = (i: number) => "0x" + (0xbbb0000 + i).toString(16).padStart(40, "0");
const WALLET = "0x" + "77".repeat(20);
// blockrun-like seller: 3 listings on one host, 2 payTos; plus an unrelated seller
const LISTINGS = [
  { resource: "https://blockrun.example/api/v1/a", payTo: payTo(1) },
  { resource: "https://blockrun.example/api/v1/b", payTo: payTo(2) },
  { resource: "https://blockrun.example/api/v1/c", payTo: payTo(2) },
  { resource: "https://other.example/q", payTo: payTo(3) },
];
const ITEMS = LISTINGS.map((l) => ({
  resource: l.resource, type: "http", description: "d",
  accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: l.payTo }],
  extensions: { bazaar: { info: { input: { method: "GET", type: "http" } } } },
  quality: { l30DaysTotalCalls: 50, l30DaysUniquePayers: 6, lastCalledAt: new Date(NOW - 3_600_000).toISOString() }, lastUpdated: new Date(NOW).toISOString(),
}));
const ENV = {
  XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: "k".repeat(52),
  PUBLIC_BASE_URL: BASE, LUMI_CHECK_SIGNING_KEY: SEED, XRPL_RPC_URLS: "https://xrpl.rpc.test/",
  EVM_PAY_TO: "0x5E617bac19912e6d212CB303ae84655E9E203532", EVM_NETWORK: "eip155:84532", EVM_FACILITATOR_URL: "https://evm-fac.test", BASE_RPC_URL: "https://base-rpc.test",
  EVM_CDP_ONLY_ROUTES: "none",
};

async function setup(start = NOW) {
  const ev = new MemoryEvidenceStore();
  ev.resources = new Set(ITEMS.map((i) => i.resource));
  const catalogStore = new MemoryCatalogStore();
  const fallback = makeFetch(happyFacilitator());
  const doFetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources"))
      return new Response(JSON.stringify({ items: ITEMS, pagination: { limit: 30, offset: 0, total: ITEMS.length } }));
    if (url.startsWith("https://base-rpc.test")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (50_000n).toString(16).padStart(64, "0") }));
    if (/\.example\//.test(url)) return new Response("nope", { status: 200 });
    if (url === "https://xrpl.rpc.test/" || url.includes("ripple.com") || url.includes("xrplcluster")) return new Response(JSON.stringify({ result: { transactions: [] } }));
    return fallback(input, init);
  }) as typeof fetch;
  const logs: any[] = [];
  let t = start;
  const app = createApp(ENV as any, { fetch: doFetch, log: (e: any) => logs.push(e), now: () => t, catalogStore, evidenceStore: ev, trialStore: new MemoryTrialStore(), activityStore: new MemoryActivityStore(), trustStore: new MemoryTrustStore(SEED_OBSERVATIONS) } as any);
  const inflow = (pay_to: string, n: number, first_ts: number, last_ts: number) =>
    ev.addInflow([{ pay_to, payer: WALLET, n, units: 10_000 * n, first_ts, last_ts, first_block: 1, last_tx: "0x" + last_ts.toString(16).padStart(64, "0") }]);
  const wc = async (a: string) => {
    const r = await app.fetch(new Request(BASE + "/v1/wallet/check?address=" + encodeURIComponent(a), { headers: { "CF-Connecting-IP": "198.51.100.9" } }));
    return { status: r.status, body: (await r.json()) as any };
  };
  return { app, logs, inflow, wc, setNow: (ms: number) => (t = ms) };
}

describe("nightly gate (cron bug: 03:07 never matched a :00/:30 tick)", () => {
  it("isNightlyTick is true only in [03:00, 03:30) UTC", () => {
    const at = (h: string) => Date.parse(`2026-10-29T${h}Z`);
    expect(isNightlyTick(at("03:00:00"))).toBe(true);
    expect(isNightlyTick(at("03:00:04.9"))).toBe(true); // late delivery of the 03:00 tick
    expect(isNightlyTick(at("03:07:00"))).toBe(true);
    expect(isNightlyTick(at("03:30:00"))).toBe(false);
    expect(isNightlyTick(at("02:30:00"))).toBe(false);
    expect(isNightlyTick(at("15:00:00"))).toBe(false);
  });
  it("exactly one half-hourly tick per UTC day is nightly (the old gate matched none)", () => {
    const day0 = Date.parse("2026-10-29T00:00:00Z");
    const ticks = Array.from({ length: 48 }, (_, i) => day0 + i * 30 * 60_000);
    expect(ticks.filter(isNightlyTick).map((t) => new Date(t).toISOString())).toEqual(["2026-10-29T03:00:00.000Z"]);
    const old = (ms: number) => { const d = new Date(ms); return d.getUTCHours() === 3 && d.getUTCMinutes() === 7; };
    expect(ticks.filter(old)).toEqual([]);
  });
  it("scheduled() on the 03:00 UTC tick runs the contributor purge and outcomes.nightly; other ticks do not", async () => {
    const s = await setup(Date.parse("2026-10-29T02:30:00Z"));
    let purges = 0;
    const orig = s.app.contributors.purge.bind(s.app.contributors);
    (s.app.contributors as any).purge = (...a: any[]) => { purges++; return (orig as any)(...a); };
    await s.app.scheduled();
    expect(purges).toBe(0);
    expect(s.logs.filter((e) => e?.event === "check_outcomes_nightly")).toHaveLength(0);
    s.setNow(Date.parse("2026-10-29T03:00:01Z"));
    await s.app.scheduled();
    expect(purges).toBe(1);
    expect(s.logs.filter((e) => e?.event === "check_outcomes_nightly")).toHaveLength(1);
    s.setNow(Date.parse("2026-10-29T03:30:00Z"));
    await s.app.scheduled();
    expect(purges).toBe(1);
    expect(s.logs.filter((e) => e?.event === "check_outcomes_nightly")).toHaveLength(1);
  });
});

describe("wallet check: one row per seller (duplicate blockrun rows)", () => {
  it("folds a seller's payTos into one row with pay_tos, summed payments and the latest date", async () => {
    const s = await setup();
    await s.app.scheduled();
    await s.inflow(payTo(1), 2, NOW - 10 * DAY, NOW - 2 * DAY);
    await s.inflow(payTo(2), 3, NOW - 20 * DAY, NOW - DAY);
    await s.inflow(payTo(3), 1, NOW - 5 * DAY, NOW - 5 * DAY);
    const r = await s.wc(WALLET);
    expect(r.status).toBe(200);
    const b = r.body;
    expect(b.sellers.map((x: any) => x.seller)).toEqual(["blockrun.example", "other.example"]);
    const br = b.sellers[0];
    expect(br.pay_to).toBe(payTo(2)); // most recently paid address
    expect(br.pay_tos).toEqual([payTo(2), payTo(1)]);
    expect(br.payments).toBe(5);
    expect(br.last_paid_at).toBe(new Date(NOW - DAY).toISOString());
    expect(br.paid).toMatch(/^5 payments, last on /);
    expect(br.flags.filter((f: any) => f.code === "repeat_payments")).toHaveLength(1);
    expect(new Set(br.listings).size).toBe(br.listings.length);
    expect(br.listings.length).toBeLessThanOrEqual(3);
    expect(b.sellers[1].pay_tos).toBeUndefined(); // single-address sellers unchanged
    expect(b.summary).toMatch(/paid 2 x402 sellers/);
  });
  it("a merged seller counts once toward the seller limit", async () => {
    const s = await setup();
    await s.app.scheduled();
    await s.inflow(payTo(1), 1, NOW - 3 * DAY, NOW - 3 * DAY);
    await s.inflow(payTo(2), 1, NOW - 2 * DAY, NOW - 2 * DAY);
    const b = (await s.wc(WALLET)).body;
    expect(b.sellers).toHaveLength(1);
    expect(b.sellers[0].payments).toBe(2);
    expect(b.summary).toMatch(/paid 1 x402 seller /);
  });
});
