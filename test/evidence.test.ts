import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { buyCandidate } from "../src/trust/catalog_service";
import { MemoryEvidenceStore, classifyPayers, xrplCensus, baseLogs, vet402View, parseVet402, X402_SOURCE_TAG, VET402 } from "../src/trust/evidence";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SELLER = "0xAbCdEf0000000000000000000000000000000001";
const XR = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"; // XRPL seller payTo
const A = "rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn"; // organic payer, funded by F
const B = "rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh"; // organic payer, same funder F (one cluster with A)
const C = "rGWrZyQqhTp9Xu7G5Pkayo7bXjH4k4QYpf"; // funded by Lumi -> excluded
const F = "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv";
const TESTER = "r4w68TArDZjivtcFMNL7PvKf7uPg14Vev8";
const LUMI = "rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM";
const H = (n: number) => n.toString(16).toUpperCase().padStart(64, "0");

const ptx = (from: string, i: number, extra: Record<string, unknown>) => ({
  hash: H(i), close_time_iso: new Date(NOW - i * 3_600_000).toISOString(),
  tx_json: { TransactionType: "Payment", Account: from, Destination: XR, ...extra },
  meta: { TransactionResult: "tesSUCCESS", delivered_amount: "10000" },
});
const TXS = [
  ptx(A, 1, { SourceTag: X402_SOURCE_TAG }), ptx(A, 2, { SourceTag: X402_SOURCE_TAG }),
  ptx(B, 3, { InvoiceID: "AB".repeat(32) }), ptx(C, 4, { SourceTag: X402_SOURCE_TAG }),
  ptx(TESTER, 5, { SourceTag: X402_SOURCE_TAG }), ptx(F, 6, {}), // untagged: incoming, not x402
];
const FUNDED: Record<string, string> = { [A]: F, [B]: F, [C]: LUMI };

function xrplFetch(calls: string[] = []): typeof fetch {
  return (async (_u: any, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body));
    const p = b.params[0];
    calls.push(`${b.method}:${p.account}:${p.forward ? "f" : "b"}`);
    if (p.account === XR) return new Response(JSON.stringify({ result: { transactions: TXS } }));
    const f = FUNDED[p.account];
    return new Response(JSON.stringify({ result: { transactions: f ? [{ tx_json: { TransactionType: "Payment", Account: f, Destination: p.account } }] : [] } }));
  }) as typeof fetch;
}

describe("evidence: payer classification", () => {
  it("clusters by funder, excludes Lumi / testers / self-funded, ignores hubs", () => {
    const P = (payer: string, funder: string | null, n = 1) => ({ payer, funder, funder_known: true, n, last_ts: NOW - n, last_tx: "t" + payer });
    const c = classifyPayers([P("a", "f"), P("b", "f", 2), P("c", "lumi"), P("tester", null), P("d", "seller"), P("e", "hub"), P("g", "hub")],
      { payTo: "seller", sellerPayTos: [], lumi: ["lumi"], testers: ["tester"], hubs: new Set(["hub"]) });
    expect(c.excluded).toEqual({ lumi: 1, known_testers: 1, self_funded: 1 });
    expect(c.organic_payers).toBe(3); // {a,b} via f, e, g (hub not used for clustering)
    expect(c.organic_wallets).toBe(4);
    expect(c.organic_payments).toBe(5);
  });
});

describe("evidence: XRPL census", () => {
  it("counts SourceTag/InvoiceID payments and resolves funders", async () => {
    const st = new MemoryEvidenceStore();
    const d = await xrplCensus(xrplFetch(), ["https://x/"], XR, st, NOW);
    expect(d.incoming_payments).toBe(6);
    expect(d.x402_payments).toBe(5);
    expect(d.markers).toEqual({ source_tag: 4, invoice_id: 1 });
    expect(d.payers.find((p) => p.a === A)).toMatchObject({ n: 2, f: F, fk: true });
    const c = classifyPayers(d.payers.map((p) => ({ payer: p.a, funder: p.f, funder_known: p.fk, n: p.n, last_ts: p.last_ts, last_tx: p.last_tx })),
      { payTo: XR, sellerPayTos: [], lumi: [LUMI], testers: [TESTER], hubs: new Set() });
    expect(c).toMatchObject({ organic_payers: 1, organic_wallets: 2, organic_payments: 3, excluded: { lumi: 1, known_testers: 1, self_funded: 0 } });
    expect((await st.getCensus("xrpl:0", XR))?.doc).toBeTruthy();
  });
});

describe("evidence: Base forward index", () => {
  it("aggregates USDC Transfer logs per (payTo, payer), skipping mints and self-transfers", async () => {
    const pad = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
    const P1 = "0x1111111111111111111111111111111111111111";
    const log = (from: string, to: string, b: number, units: number, tx: string) => ({ address: USDC.toLowerCase(), topics: [TOPIC, pad(from), pad(to)], data: "0x" + units.toString(16), blockNumber: "0x" + b.toString(16), transactionHash: tx });
    const logs = [log(P1, SELLER, 100, 10000, "0xa"), log(P1, SELLER, 105, 5000, "0xb"), log("0x" + "0".repeat(40), SELLER, 101, 1, "0xc"), log(SELLER, SELLER, 102, 1, "0xd")];
    const f = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: logs }))) as unknown as typeof fetch;
    const rows = await baseLogs(f, ["https://b/"], [SELLER.toLowerCase()], 100, 110, { block: 110, ts: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ payer: P1, n: 2, units: 15000, first_block: 100, last_tx: "0xb" });
    const st = new MemoryEvidenceStore();
    await st.addInflow(rows); await st.addInflow(rows);
    expect((await st.inflowFor(SELLER.toLowerCase(), 10))[0].n).toBe(4);
    expect(await st.unresolvedPayers(5)).toHaveLength(1);
  });
});

describe("evidence: vet402 (third party, CC BY 4.0)", () => {
  it("parses owner rows and shows tx evidence only in the paid view", () => {
    const rows = parseVet402({ retrieved_at: "2026-10-22T00:00:00Z", rows: [{ k: "api.x.com/a", l0_verdict: "fail", l0_probed_at: "2026-10-21T00:00:00Z", l1_attempts: 2, l1_settled: 1, l1_delivered: 1, l1_last_tx: "0x" + "a".repeat(64), l1_last_http: 200 }] }, NOW);
    expect(Array.isArray(rows)).toBe(true);
    const r = (rows as any[])[0];
    expect(parseVet402({ retrieved_at: "x", rows: [] }, NOW)).toMatch(/retrieved_at/);
    expect(parseVet402({ retrieved_at: "2026-10-22", rows: [{ k: "https://a" }] }, NOW)).toMatch(/no scheme/);
    const free = vet402View(r, true), paid = vet402View(r, false);
    expect(free).toMatchObject({ license: "CC BY 4.0", link: VET402.link });
    expect(free.cite).toContain("retrieved 2026-10-22");
    expect(JSON.stringify(free)).not.toContain("aaaa");
    expect((paid.l1 as any).last_tx_hash).toBe("0x" + "a".repeat(64));
  });
});

describe("evidence: buy candidates", () => {
  const exact = (purchases: any[] = []) => ({ catalog: { entries: [{ resource: "https://a.test/x", listed_price_usd: "0.01", pay_to: [{ network: "eip155:8453", pay_to: SELLER }], purchases }] } });
  it("needs an exact match, no recent purchase and a suspicious signal", () => {
    const body = { matched: { exact: true }, reasons: [{ code: "no_organic_payers" }, { code: "pay_to_matches" }] };
    expect(buyCandidate(body, exact(), NOW)).toEqual({ resource: "https://a.test/x", network: "eip155:8453", price_usd: 0.01, reasons: ["no_organic_payers"] });
    expect(buyCandidate({ ...body, reasons: [{ code: "pay_to_matches" }] }, exact(), NOW)).toBeNull();
    expect(buyCandidate(body, exact([{ at: new Date(NOW - 86_400_000).toISOString() }]), NOW)).toBeNull();
    expect(buyCandidate({ ...body, matched: { exact: false } }, exact(), NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------- end to end through the app
const item = (resource: string, accepts: any[], calls = 50) => ({
  resource, type: "http", description: "d", accepts, extensions: { bazaar: { info: { input: { method: "GET", type: "http" } } } },
  quality: { l30DaysTotalCalls: calls, l30DaysUniquePayers: 4, lastCalledAt: new Date(NOW - 3_600_000).toISOString() }, lastUpdated: new Date(NOW).toISOString(),
});
const ITEMS = [
  item("https://api.xseller.com/v1/q", [{ scheme: "exact", network: "xrpl:0", asset: "XRP", amount: "10000", payTo: XR }]),
  item("https://api.bseller.com/v1/q", [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: SELLER }], 0),
];
function appFetch(): typeof fetch {
  const x = xrplFetch();
  const base = makeFetch(happyFacilitator());
  return (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources"))
      return new Response(JSON.stringify({ items: ITEMS, pagination: { limit: 30, offset: 0, total: ITEMS.length } }));
    if (url === "https://xrpl.rpc.test/") return x(input, init);
    if (url.startsWith("https://api.bseller.com/") || url.startsWith("https://api.xseller.com/")) return new Response("nope", { status: 200 });
    return base(input, init);
  }) as typeof fetch;
}
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: "k".repeat(52), XRPL_RPC_URLS: "https://xrpl.rpc.test/" };
const owner = { Authorization: "Bearer " + "k".repeat(52), "Content-Type": "application/json" };

describe("evidence: lookups and trust/check", () => {
  async function setup() {
    const ev = new MemoryEvidenceStore();
    ev.resources = new Set(ITEMS.map((i) => i.resource));
    const app = createApp(ENV as any, { fetch: appFetch(), now: () => NOW, catalogStore: new MemoryCatalogStore(), evidenceStore: ev });
    await app.scheduled();
    const req = (p: string, init: RequestInit = {}) => app.fetch(new Request("http://lumi.test" + p, init));
    const get = async (p: string, h: Record<string, string> = {}) => { const r = await req(p, { headers: h }); return { status: r.status, body: (await r.json()) as any }; };
    const buy = async (p: string) => {
      const q: any = await (await req(p)).json();
      return get(p, { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts[0]) });
    };
    return { app, ev, req, get, buy };
  }

  it("free XRPL payTo lookup: census counts only; paid trust/check: clusters with tx hashes", async () => {
    const { get, buy } = await setup();
    const free = await get("/v1/trust/vendors?payTo=" + XR);
    const c = free.body.payto_census[0];
    expect(c).toMatchObject({ network: "xrpl:0", status: "ok", organic_payers: 1, organic_payments: 3, x402_payments: 5 });
    expect(c.top_clusters).toBeUndefined();
    expect(JSON.stringify(free.body)).not.toContain(H(1));
    expect(free.body.catalog.entries[0].bazaar_quality).toMatchObject({ calls_30d: 50, unique_payers_30d: 4 });
    const paid = await buy("/v1/trust/check?url=" + encodeURIComponent("https://api.xseller.com/v1/q"));
    expect(paid.status).toBe(200);
    expect(paid.body.reasons.map((r: any) => r.code)).toEqual(expect.arrayContaining(["bazaar_usage", "organic_payers"]));
    expect(JSON.stringify(paid.body)).not.toMatch(/\bscam\b/i);
  });

  it("vet402 import is attributed and separate; a suspicious paid check queues a test-buy (not inline)", async () => {
    const { get, req, buy, ev } = await setup();
    const unauth = await req("/v1/trust/catalog/evidence/vet402", { method: "POST", body: "{}" });
    expect(unauth.status).toBe(401);
    const r = await req("/v1/trust/catalog/evidence/vet402", { method: "POST", headers: owner, body: JSON.stringify({ retrieved_at: "2026-10-22T00:00:00Z", rows: [
      { k: "api.bseller.com/v1/q", l0_verdict: "fail", l0_probed_at: "2026-10-21T00:00:00Z", l1_attempts: 1, l1_settled: 0, l1_delivered: 0, l1_last_status: "settle_failed" },
      { k: "unknown.example/x", l0_verdict: "pass" },
    ] }) });
    expect(await r.json()).toMatchObject({ received: 2, matched: 1, unmatched_keys: ["unknown.example/x"] });
    const free = await get("/v1/trust/vendors?url=" + encodeURIComponent("https://api.bseller.com/v1/q"));
    expect(free.body.catalog.entries[0].third_party.vet402).toMatchObject({ license: "CC BY 4.0", l0: { verdict: "fail" } });
    // The free lookup by exact URL already sends the priority signal (same rule as the paid check since Oct 23 2026).
    expect(ev.queue.get("https://api.bseller.com/v1/q")).toMatchObject({ status: "queued", hits: 1 });
    const u = "/v1/trust/check?url=" + encodeURIComponent("https://api.bseller.com/v1/q");
    await req(u); // unpaid quote: never queues or adds hits
    expect(ev.queue.size).toBe(1);
    expect(ev.queue.get("https://api.bseller.com/v1/q")!.hits).toBe(1);
    const paid = await buy(u);
    expect(paid.body.reasons.find((x: any) => x.code === "vet402_l0_fail")?.severity).toBe("warn");
    expect(paid.body.reasons.map((x: any) => x.code)).toContain("no_bazaar_usage");
    await new Promise((s) => setTimeout(s, 0));
    const q = await get("/v1/trust/catalog/buy-queue", owner);
    expect(q.body.rows[0]).toMatchObject({ resource: "https://api.bseller.com/v1/q", status: "queued", network: "eip155:8453" });
    expect(q.body.rows[0].reasons).toContain("vet402_l0_fail");
    expect(q.body.rows[0].hits).toBe(1); // same seller, same UTC day: the paid check adds nothing
    const sum = await get("/v1/trust/catalog");
    expect(JSON.stringify(sum.body)).not.toMatch(/vet402.*purchase_verified/);
  });
});
