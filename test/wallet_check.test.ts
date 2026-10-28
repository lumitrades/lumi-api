/**
 * Free wallet check (GET /v1/wallet/check, MCP lumi_wallet_check): the x402 sellers a public wallet paid, matched to
 * Lumi's test-buy records with the shared summary line and simple flags. Harness copied from summary_line.test.ts.
 */
import { describe, it, expect } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { createApp } from "../src/app";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { MemoryEvidenceStore } from "../src/trust/evidence";
import { MemoryTrialStore } from "../src/trial";
import { MemoryTrustStore } from "../src/trust/store";
import { SEED_OBSERVATIONS } from "../src/trust/seed";
import { MemoryActivityStore } from "../src/trust/activity";
import { VENDORS } from "../src/vendors";
import { LUMI_STELLAR_ADDRESS } from "../src/config";
import { chainOf, groupPayments, sellerFlags, walletSummary, recipientsFromInflow, DUPLICATE_WINDOW_MS, WALLET_COMING_LATER } from "../src/trust/wallet_check";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch } from "./helpers";

const DAY = 86_400_000;
const BASE = "https://api.lumitrades.io";
const SEED = Buffer.from(ed25519.utils.randomPrivateKey()).toString("hex");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const EVM_PAY_TO = "0x5E617bac19912e6d212CB303ae84655E9E203532";
const payTo = (i: number) => "0x" + (0xabc0000 + i).toString(16).padStart(40, "0");
const R = (i: number) => `https://api.s${i}.com/v1/q`;
const ITEMS = [1, 2, 3].map((i) => ({
  resource: R(i), type: "http", description: "d",
  accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: payTo(i) }],
  extensions: { bazaar: { info: { input: { method: "GET", type: "http" } } } },
  quality: { l30DaysTotalCalls: 50, l30DaysUniquePayers: 6, lastCalledAt: new Date(NOW - 3_600_000).toISOString() }, lastUpdated: new Date(NOW).toISOString(),
}));
const ENV = {
  XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: "k".repeat(52),
  PUBLIC_BASE_URL: BASE, LUMI_CHECK_SIGNING_KEY: SEED, XRPL_RPC_URLS: "https://xrpl.rpc.test/",
  EVM_PAY_TO, EVM_NETWORK: "eip155:84532", EVM_FACILITATOR_URL: "https://evm-fac.test", BASE_RPC_URL: "https://base-rpc.test",
};
const WALLET = "0x" + "77".repeat(20);
const XWALLET = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
const SWALLET = "G" + "A".repeat(55);
const CURATED_XRPL = VENDORS.find((v) => v.pay_to?.xrpl?.length)!.pay_to.xrpl[0];
const NEVER = /\b(safe|safer|unsafe|trusted|trustworthy|guaranteed|recommend\w*|verified|legit\w*|scam\w*|fraud\w*|cheaper|overpaid|overpay\w*|more than an?)\b/i;
const iso = (t: number) => new Date(t).toISOString();

async function setup(live: { xrpl?: any; stellar?: { status: number; body?: any } } = {}) {
  const ev = new MemoryEvidenceStore();
  ev.resources = new Set(ITEMS.map((i) => i.resource));
  const catalogStore = new MemoryCatalogStore();
  const fallback = makeFetch(happyFacilitator());
  const calls: string[] = [];
  const doFetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.startsWith("https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources"))
      return new Response(JSON.stringify({ items: ITEMS, pagination: { limit: 30, offset: 0, total: ITEMS.length } }));
    if (url === "https://xrplcluster.com/" && live.xrpl) return new Response(JSON.stringify(live.xrpl));
    if (url === "https://xrpl.rpc.test/" || url.includes("ripple.com") || url.includes("xrplcluster")) return new Response(JSON.stringify({ result: { transactions: [] } }));
    if (url.startsWith("https://horizon.stellar.org/accounts/") && live.stellar) return new Response(JSON.stringify(live.stellar.body ?? {}), { status: live.stellar.status });
    if (url.startsWith("https://base-rpc.test")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (50_000n).toString(16).padStart(64, "0") }));
    if (/^https:\/\/api\.s\d\.com\//.test(url)) return new Response("nope", { status: 200 });
    return fallback(input, init);
  }) as typeof fetch;
  const logs: string[] = [];
  let t = NOW;
  const app = createApp(ENV as any, { fetch: doFetch, log: (...a: unknown[]) => logs.push(JSON.stringify(a)), now: () => t, catalogStore, evidenceStore: ev, trialStore: new MemoryTrialStore(), activityStore: new MemoryActivityStore(), trustStore: new MemoryTrustStore(SEED_OBSERVATIONS) } as any);
  await app.scheduled();
  let ip = 0;
  const req = (p: string, init: RequestInit = {}, fixedIp?: string) => {
    const r = new Request(BASE + p, init);
    const h = new Headers(r.headers); h.set("CF-Connecting-IP", fixedIp ?? "198.51.100." + (++ip % 250));
    return app.fetch(new Request(r, { headers: h }));
  };
  const buy = (i: number, ts: number, ok: boolean) => catalogStore.addBuy({
    resource: R(i), domain: `api.s${i}.com`, ts, network: "eip155:8453", tx_hash: "0x" + ts.toString(16).padStart(64, "0"), amount: "0.01", asset: "USDC",
    pay_to: payTo(i), facilitator: null, http_status: 200, data_returned: ok, latency_ms: 100, summary: ok ? "ok" : "200 with an empty body",
  } as any);
  const inflow = (pay_to: string, n: number, first_ts: number, last_ts: number, payer = WALLET) =>
    ev.addInflow([{ pay_to, payer, n, units: 10_000 * n, first_ts, last_ts, first_block: 1, last_tx: "0x" + last_ts.toString(16).padStart(64, "0") }]);
  const wc = async (a: string, ipx?: string) => { const r = await req("/v1/wallet/check?address=" + encodeURIComponent(a), {}, ipx); return { status: r.status, headers: r.headers, body: (await r.json()) as any }; };
  return { app, req, ev, catalogStore, buy, inflow, wc, logs, calls, advance: (ms: number) => (t += ms) };
}

describe("wallet check (unit)", () => {
  it("knows the three address kinds", () => {
    expect(chainOf(WALLET)).toBe("base");
    expect(chainOf(XWALLET)).toBe("xrpl");
    expect(chainOf(SWALLET)).toBe("stellar");
    expect(chainOf("hello")).toBeNull();
    expect(chainOf("0x1234")).toBeNull();
  });
  it("groups payments and spots same-amount repeats inside the duplicate window", () => {
    const g = groupPayments([
      { to: "a", at: NOW, amount: "0.01", asset: "USDC", tx: "t1" },
      { to: "a", at: NOW + 30_000, amount: "0.01", asset: "USDC", tx: "t2" },
      { to: "a", at: NOW + 30_000 + DUPLICATE_WINDOW_MS + 1, amount: "0.01", asset: "USDC", tx: "t3" },
      { to: "b", at: NOW + 1, amount: "1", asset: "XRP", tx: "t4" },
    ]);
    const a = g.find((x) => x.to === "a")!;
    expect(a.payments).toBe(3);
    expect(a.possible_duplicates).toBe(1);
    expect(a.last_tx).toBe("t3");
    expect(a.amounts.USDC).toBe("0.03");
    expect(g.find((x) => x.to === "b")!.possible_duplicates).toBe(0);
  });
  it("flags dead, delisted, failed and repeat facts, and nothing for a single clean payment", () => {
    const rec = { to: "a", payments: 1, first_at: NOW, last_at: NOW, last_tx: null, amounts: {}, possible_duplicates: 0 };
    expect(sellerFlags(rec, [{ resource: R(1) }], "checks_passed")).toEqual([]);
    const f = sellerFlags({ ...rec, payments: 4, first_at: NOW - 5 * DAY }, [{ resource: R(1), reachability: { status: "listing_looks_dead" }, listed_until: iso(NOW - DAY) }], "checks_failed").map((x) => x.code);
    expect(f).toEqual(["listing_looks_dead", "no_longer_listed", "recent_checks_failed", "repeat_payments"]);
  });
  it("summarises plainly; no record is never an all-clear", () => {
    const none = walletSummary("base", [], 2, 0);
    expect(none).toBe("Lumi found no payments from this Base wallet to x402 sellers it has a record of in the last 90 days (2 other recipients not in Lumi's records). No record is not a negative finding.");
    const some = walletSummary("xrpl", [{ flags: [{ code: "listing_looks_dead", detail: "" }], tested: true }, { flags: [{ code: "repeat_payments", detail: "" }], tested: false }], 0, 0);
    expect(some).toBe("This XRP Ledger wallet paid 2 x402 sellers Lumi has a record of in the last 90 days; Lumi has test-bought 1 of 2; 1 has a flag (dead or delisted listing, failed checks or a possible duplicate payment). Not a guarantee.");
    for (const s of [none, some]) expect(s).not.toMatch(NEVER);
  });
  it("drops index rows older than the 90-day window", () => {
    const rows = [
      { pay_to: "a", payer: "p", n: 2, units: 20000, first_ts: NOW - 10 * DAY, last_ts: NOW - DAY, first_block: 1, last_tx: "x" },
      { pay_to: "b", payer: "p", n: 1, units: 10000, first_ts: NOW - 120 * DAY, last_ts: NOW - 95 * DAY, first_block: 1, last_tx: "y" },
    ];
    expect(recipientsFromInflow(rows, NOW - 90 * DAY).map((r) => r.to)).toEqual(["a"]);
  });
});

describe("GET /v1/wallet/check", () => {
  it("bare call is a free usage answer (not counted) that names the coming-later extras without prices", async () => {
    const s = await setup();
    const r = await s.req("/v1/wallet/check");
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.kind).toBe("usage");
    expect(b.counted).toBe(false);
    expect(b.coming_later).toEqual([...WALLET_COMING_LATER]);
    expect(JSON.stringify(b)).not.toMatch(/\$\d|USD|price:/i);
  });
  it("bad address: 400, not counted", async () => {
    const s = await setup();
    const r = await s.wc("not-a-wallet");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_field");
  });

  it("Base: lists sellers paid with the shared summary line and flags; hides Lumi, unknown recipients and old rows", async () => {
    const s = await setup();
    for (let k = 0; k < 3; k++) await s.buy(1, NOW - (k + 1) * DAY, true);
    await s.buy(1, NOW - 4 * DAY, false);
    await s.inflow(payTo(1), 3, NOW - 20 * DAY, NOW - 2 * DAY);
    await s.inflow(payTo(2), 1, NOW - 5 * DAY, NOW - 5 * DAY);
    await s.inflow(EVM_PAY_TO.toLowerCase(), 7, NOW - 3 * DAY, NOW - DAY); // Lumi itself
    await s.inflow("0x" + "de".repeat(20), 1, NOW - 3 * DAY, NOW - 3 * DAY); // not a seller Lumi knows
    await s.inflow(payTo(3), 1, NOW - 120 * DAY, NOW - 100 * DAY); // outside the window
    await s.inflow(payTo(3), 9, NOW - 3 * DAY, NOW - DAY, "0x" + "99".repeat(20)); // another payer: never shown
    const r = await s.wc(WALLET);
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.headers.get("RateLimit-Limit")).toBeTruthy();
    const b = r.body;
    expect(b.kind).toBe("wallet_check");
    expect(b.access).toBe("free");
    expect(b.network).toBe("eip155:8453");
    expect(b.sellers.map((x: any) => x.pay_to)).toEqual([payTo(1), payTo(2)]);
    const s1 = b.sellers[0];
    expect(s1.seller).toBe("api.s1.com");
    expect(s1.payments).toBe(3);
    expect(s1.summary).toMatch(/^Lumi test-bought this (listing|seller) 4 times.*3 delivered, 1 did not deliver.*Not a guarantee\.$/);
    expect(s1.summary_facts.test_buys).toBe(4);
    expect(s1.flags.map((f: any) => f.code)).toContain("repeat_payments");
    expect(s1.trust_check).toBe(`${BASE}/v1/trust/check?url=${encodeURIComponent(R(1))}`);
    const s2 = b.sellers[1];
    expect(s2.summary).toMatch(/has not test-bought this .* yet/);
    expect(s2.flags).toEqual([]);
    expect(b.other_recipients).toBe(1);
    expect(b.summary).toBe("This Base wallet paid 2 x402 sellers Lumi has a record of in the last 90 days; Lumi has test-bought 1 of 2. Not a guarantee.");
    expect(b.coming_later).toEqual([...WALLET_COMING_LATER]);
    const all = JSON.stringify(b);
    expect(all.toLowerCase()).not.toContain(EVM_PAY_TO.toLowerCase());
    expect(all).not.toContain("de".repeat(20));
    expect(all).not.toContain("99".repeat(20));
    expect(all).not.toContain(payTo(3));
    expect(b.summary).not.toMatch(NEVER);
    for (const x of b.sellers) { expect(x.summary).not.toMatch(NEVER); for (const f of x.flags) expect(f.detail).not.toMatch(NEVER); }
  });

  it("Base: a running total that began before the 90-day window shows only the last payment date", async () => {
    const s = await setup();
    await s.inflow(payTo(1), 12, NOW - 150 * DAY, NOW - 3 * DAY);
    const b = (await s.wc(WALLET)).body;
    expect(b.sellers).toHaveLength(1);
    expect(b.sellers[0].payments).toBeNull();
    expect(b.sellers[0].paid).toMatch(/^last on /);
    expect(b.sellers[0].flags.map((f: any) => f.code)).not.toContain("repeat_payments");
    expect(JSON.stringify(b)).not.toMatch(/\b12 payments\b/);
  });

  it("Base: nothing found is said plainly, not as an all-clear", async () => {
    const s = await setup();
    const b = (await s.wc(WALLET)).body;
    expect(b.sellers).toEqual([]);
    expect(b.summary).toContain("No record is not a negative finding.");
  });

  it("XRPL: reads outgoing payments live, matches curated sellers, flags a possible duplicate, ignores incoming, failed and Lumi payments", async () => {
    const pay = (dest: string, t: number, amount: any, hash: string, extra: any = {}) => ({
      hash, close_time_iso: iso(t), tx_json: { TransactionType: "Payment", Account: XWALLET, Destination: dest, DeliverMax: amount, ...extra }, meta: { TransactionResult: "tesSUCCESS", delivered_amount: amount },
    });
    const xrpl = { result: { transactions: [
      pay(CURATED_XRPL, NOW - DAY, "10000", "H1"),
      pay(CURATED_XRPL, NOW - DAY - 30_000, "10000", "H2"),
      pay(PAY_TO, NOW - DAY, "50000", "H3"), // Lumi
      pay("rUnknownPersonXXXXXXXXXXXXXXXXXXX", NOW - 2 * DAY, "1000000", "H4"),
      { hash: "H5", close_time_iso: iso(NOW - DAY), tx_json: { TransactionType: "Payment", Account: CURATED_XRPL, Destination: XWALLET, DeliverMax: "5" }, meta: { TransactionResult: "tesSUCCESS" } },
      { ...pay(CURATED_XRPL, NOW - DAY, "10000", "H6"), meta: { TransactionResult: "tecPATH_DRY" } },
    ] } };
    const s = await setup({ xrpl });
    const b = (await s.wc(XWALLET)).body;
    expect(b.network).toBe("xrpl:0");
    expect(b.sellers).toHaveLength(1);
    const v = b.sellers[0];
    expect(v.pay_to).toBe(CURATED_XRPL);
    expect(v.payments).toBe(2);
    expect(v.last_tx).toBe("H1");
    expect(v.flags.map((f: any) => f.code)).toEqual(expect.arrayContaining(["repeat_payments", "possible_duplicate_payment"]));
    expect(v.summary).toMatch(/Not a guarantee\.$/);
    expect(b.other_recipients).toBe(1);
    expect(b.summary).toContain("1 has a flag");
    expect(JSON.stringify(b)).not.toContain(PAY_TO);
    expect(b.source.complete).toBe(true);
  });

  it("XRPL read failure is not an all-clear", async () => {
    const s = await setup({ xrpl: { result: { error: "actNotFound" } } });
    const b = (await s.wc(XWALLET)).body;
    expect(b.source.error).toBe("account_not_found");
    expect(b.summary).toMatch(/could not find this account/);
  });

  it("Stellar: reads outgoing payments from Horizon; payments to Lumi are never shown; 404 is said plainly", async () => {
    const recs = [
      { type: "payment", from: SWALLET, to: LUMI_STELLAR_ADDRESS, amount: "0.02", asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", created_at: iso(NOW - DAY), transaction_hash: "S1", transaction_successful: true },
      { type: "payment", from: "G" + "B".repeat(55), to: SWALLET, amount: "5", asset_type: "native", created_at: iso(NOW - DAY), transaction_hash: "S2", transaction_successful: true },
      { type: "payment", from: SWALLET, to: "G" + "C".repeat(55), amount: "1", asset_type: "native", created_at: iso(NOW - DAY), transaction_hash: "S3", transaction_successful: true },
    ];
    const s = await setup({ stellar: { status: 200, body: { _embedded: { records: recs } } } });
    const b = (await s.wc(SWALLET)).body;
    expect(b.network).toBe("stellar:pubnet");
    expect(b.sellers).toEqual([]);
    expect(b.other_recipients).toBe(1);
    expect(JSON.stringify(b)).not.toContain(LUMI_STELLAR_ADDRESS);
    const s404 = await setup({ stellar: { status: 404 } });
    expect((await s404.wc(SWALLET)).body.source.error).toBe("account_not_found");
  });

  it("is rate-limited at 100 a day per IP with its own counter (the free trust check still answers)", async () => {
    const s = await setup();
    const IP = "192.0.2.77";
    let last: any;
    for (let k = 0; k < 100; k++) { s.advance(7_000); last = await s.wc(WALLET, IP); if (last.status !== 200) break; }
    expect(last.status).toBe(200);
    s.advance(7_000);
    const over = await s.wc(WALLET, IP);
    expect(over.status).toBe(429);
    expect(over.body.error).toBe("free_limit_reached");
    expect(over.body.limit).toMatchObject({ per_day: 100, window: "day" });
    expect(over.headers.get("Retry-After")).toBeTruthy();
    const tc = await s.req("/v1/trust/check?url=" + encodeURIComponent(R(1)), {}, IP);
    expect(tc.status).toBe(200);
  }, 60_000);

  it("does not store or log the wallet looked up", async () => {
    const s = await setup();
    await s.inflow(payTo(1), 2, NOW - 5 * DAY, NOW - DAY, WALLET);
    const before = s.ev.inflow.size;
    await s.wc(XWALLET);
    await s.wc(WALLET);
    expect(s.ev.inflow.size).toBe(before);
    expect(s.logs.join("\n")).not.toContain(XWALLET);
    expect(s.logs.join("\n").toLowerCase()).not.toContain(WALLET);
    expect(JSON.stringify([...((s.catalogStore as any).buys ?? [])])).not.toContain(XWALLET);
  });
});

describe("MCP lumi_wallet_check", () => {
  it("is listed as a free tool with honest wording and answers with the summary first", async () => {
    const s = await setup();
    await s.inflow(payTo(2), 1, NOW - 5 * DAY, NOW - 5 * DAY);
    const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    const list: any = await (await s.req("/mcp", { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json();
    const t = list.result.tools.find((x: any) => x.name === "lumi_wallet_check");
    expect(t).toBeTruthy();
    expect(t.description).toMatch(/^Free/);
    expect(t.description).toMatch(/not a guarantee/i);
    expect(t.description).not.toMatch(/\b(safe|trusted|recommend\w*|cheaper)\b/i);
    const m: any = await (await s.req("/mcp", { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lumi_wallet_check", arguments: { address: WALLET } } }) })).json();
    const body = JSON.parse(m.result.content[0].text);
    expect(Object.keys(body)[0]).toBe("summary");
    expect(body.kind).toBe("wallet_check");
    expect(body.sellers[0].pay_to).toBe(payTo(2));
    const docs: any = await (await s.req("/openapi.json")).json();
    expect(docs.paths["/v1/wallet/check"].get.security).toEqual([]);
  });
});
