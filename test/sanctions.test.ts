import { describe, it, expect } from "vitest";
import { classicAddressToXAddress } from "ripple-address-codec";
import { createApp } from "../src/app";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { buyCandidate } from "../src/trust/catalog_service";
import { MemoryEvidenceStore } from "../src/trust/evidence";
import { trustVerdict } from "../src/quick";
import { createSanctionsScreen, normalizeAddress, SANCTIONS_REASON } from "../src/sanctions";
import snapshot from "../data/ofac_sdn_addresses.json";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";

// Real OFAC SDN entries (SDN_ADVANCED.XML, "Digital Currency Address - ETH" / "- XRP"), as published (mixed case).
const SDN_EVM = "0x7F367cC41522cE07553e823bf3be79A889DEbe1B";
const SDN_XRPL = "rnXyVQzgxZe7TR1EPzTkGj2jxH4LMJYh66";
const CLEAN_EVM = "0xAbCdEf0000000000000000000000000000000001";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Minimal StrKey encoder (test-only) so the Stellar checks run on a synthetic key: the SDN list has no Stellar entry today.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function crc16(b: Uint8Array) { let c = 0; for (const x of b) { c ^= x << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c; }
function strkey(version: number, payload: Uint8Array) {
  const body = Uint8Array.from([version, ...payload]); const c = crc16(body);
  const all = Uint8Array.from([...body, c & 0xff, c >> 8]);
  let bits = 0, val = 0, out = "";
  for (const x of all) { val = (val << 8) | x; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(val << (5 - bits)) & 31];
  return out;
}
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1);
const STELLAR_G = strkey(6 << 3, KEY);
const STELLAR_M = strkey(12 << 3, Uint8Array.from([...KEY, 0, 0, 0, 0, 0, 0, 0, 42]));

describe("sanctions: snapshot and normalisation", () => {
  it("the bundled snapshot is the cited OFAC source and contains the real listed addresses", () => {
    expect(snapshot.source).toContain("sanctionslistservice.ofac.treas.gov");
    expect(snapshot.evm.length).toBeGreaterThanOrEqual(50);
    expect(snapshot.evm).toContain(SDN_EVM.toLowerCase());
    expect(snapshot.xrpl).toContain(SDN_XRPL);
    for (const a of snapshot.evm) expect(a).toMatch(/^0x[0-9a-f]{40}$/);
  });
  it("EVM is case-normalised, CAIP-prefixed forms are accepted", () => {
    expect(normalizeAddress(SDN_EVM)).toEqual({ format: "evm", normalized: SDN_EVM.toLowerCase() });
    expect(normalizeAddress("eip155:8453:" + SDN_EVM.toUpperCase().replace("0X", "0x"))?.normalized).toBe(SDN_EVM.toLowerCase());
  });
  it("XRPL: classic, tagged and X-address forms map to the classic address; case is significant", () => {
    expect(normalizeAddress(SDN_XRPL)?.normalized).toBe(SDN_XRPL);
    expect(normalizeAddress(SDN_XRPL + ":12345")?.normalized).toBe(SDN_XRPL);
    expect(normalizeAddress(SDN_XRPL + "?dt=7")?.normalized).toBe(SDN_XRPL);
    expect(normalizeAddress(classicAddressToXAddress(SDN_XRPL, 99, false))?.normalized).toBe(SDN_XRPL);
    expect(normalizeAddress(classicAddressToXAddress(SDN_XRPL, false, true))?.normalized).toBe(SDN_XRPL);
    expect(normalizeAddress(SDN_XRPL.toLowerCase())).toBeNull(); // base58: a lower-cased r-address is not the same (or a valid) address
  });
  it("Stellar: G is upper-cased, muxed M maps to its G account, a bad checksum is rejected", () => {
    expect(normalizeAddress(STELLAR_G.toLowerCase())?.normalized).toBe(STELLAR_G);
    expect(normalizeAddress(STELLAR_M)).toEqual({ format: "stellar", normalized: STELLAR_G });
    expect(normalizeAddress(STELLAR_M.slice(0, -1) + (STELLAR_M.endsWith("A") ? "B" : "A"))).toBeNull();
  });
});

describe("sanctions: screen", () => {
  it("checks real listed EVM and XRPL addresses in any accepted form; clean addresses pass", () => {
    const s = createSanctionsScreen({ log: () => {} });
    expect(s.check(SDN_EVM.toLowerCase())).toMatchObject({ normalized: SDN_EVM.toLowerCase(), format: "evm", list: "OFAC SDN", publication_date: snapshot.publication_date });
    expect(s.check(SDN_EVM.toUpperCase().replace("0X", "0x"))).not.toBeNull();
    expect(s.check(classicAddressToXAddress(SDN_XRPL, 1, false))?.normalized).toBe(SDN_XRPL);
    expect(s.check(CLEAN_EVM)).toBeNull();
    expect(s.check("")).toBeNull();
    expect(s.checkAny([CLEAN_EVM, null, SDN_XRPL])?.format).toBe("xrpl");
  });
  it("covers Stellar (G and muxed M) once a key is listed", () => {
    const s = createSanctionsScreen({ doc: { evm: [], xrpl: [], stellar: [STELLAR_G] }, log: () => {} });
    expect(s.check(STELLAR_M)?.normalized).toBe(STELLAR_G);
  });
  it("KV copy is unioned with the snapshot, read at most once per TTL, and a KV failure keeps the snapshot", async () => {
    let t = NOW, reads = 0;
    const kv = { get: async () => { reads++; return { publication_date: "2099-01-01", evm: [CLEAN_EVM], xrpl: [], stellar: [] }; } };
    const s = createSanctionsScreen({ kv, now: () => t, log: () => {} });
    expect(s.check(CLEAN_EVM)).toBeNull();
    await s.ready(); await s.ready();
    expect(reads).toBe(1);
    expect(s.check(CLEAN_EVM)?.publication_date).toBe("2099-01-01");
    expect(s.check(SDN_EVM)).not.toBeNull(); // union: a refresh never drops the bundled entries
    t += 7 * 3_600_000; await s.ready();
    expect(reads).toBe(2);
    const broken = createSanctionsScreen({ kv: { get: async () => { throw new Error("kv down"); } }, log: () => {} });
    await broken.ready();
    expect(broken.check(SDN_XRPL)).not.toBeNull();
  });
  it("refuse() logs one structured line", () => {
    const lines: any[] = [];
    const s = createSanctionsScreen({ log: (e) => lines.push(e) });
    s.refuse("t", s.check(SDN_EVM)!, { x: 1 });
    expect(lines).toEqual([expect.objectContaining({ event: "sanctioned_address_refused", where: "t", address: SDN_EVM.toLowerCase(), list: "OFAC SDN", x: 1 })]);
  });
});

describe("sanctions: trust verdict and buy candidates", () => {
  const s = createSanctionsScreen({ log: () => {} });
  const exact = (payTo: string) => ({ catalog: { entries: [{ resource: "https://a.test/x", listed_price_usd: "0.01", pay_to: [{ network: "eip155:8453", pay_to: payTo }], purchases: [] }] } });
  it("a quoted listed payTo blocks with reason sanctioned_address (first reason)", () => {
    const v: any = trustVerdict({ url: "https://a.test/x", payTo: SDN_EVM }, exact(SDN_EVM), null, "https://lumi.test", s);
    expect(v.verdict).toBe("block");
    expect(v.reasons[0]).toMatchObject({ code: SANCTIONS_REASON, severity: "block" });
  });
  it("a listing whose recorded payTo is listed blocks even without a quoted payTo; XRPL keeps its case", () => {
    expect((trustVerdict({ url: "https://a.test/x" }, exact(SDN_EVM), null, "https://lumi.test", s) as any).reasons[0].code).toBe(SANCTIONS_REASON);
    const x: any = trustVerdict({ url: "https://a.test/x", payTo: SDN_XRPL }, exact(SDN_XRPL), null, "https://lumi.test", s);
    expect(x.verdict).toBe("block");
    expect(x.reasons[0].code).toBe(SANCTIONS_REASON);
  });
  it("a clean payTo is not affected", () => {
    const v: any = trustVerdict({ url: "https://a.test/x", payTo: CLEAN_EVM }, exact(CLEAN_EVM), null, "https://lumi.test", s);
    expect(v.reasons.map((r: any) => r.code)).not.toContain(SANCTIONS_REASON);
  });
  it("buyCandidate never queues a sanctioned resource", () => {
    const body = { matched: { exact: true }, reasons: [{ code: SANCTIONS_REASON }, { code: "no_organic_payers" }] };
    expect(buyCandidate(body, exact(SDN_EVM), NOW)).toBeNull();
    expect(buyCandidate({ ...body, reasons: [{ code: "no_organic_payers" }] }, exact(CLEAN_EVM), NOW)).not.toBeNull();
  });
});

// ---------------------------------------------------------------- through the app
const item = (resource: string, payTo: string) => ({
  resource, type: "http", description: "d", accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo }],
  extensions: { bazaar: { info: { input: { method: "GET", type: "http" } } } },
  quality: { l30DaysTotalCalls: 0, l30DaysUniquePayers: 0, lastCalledAt: new Date(NOW - 3_600_000).toISOString() }, lastUpdated: new Date(NOW).toISOString(),
});
const BAD = "https://api.sdnseller.com/v1/q", GOOD = "https://api.cleanseller.com/v1/q";
const ITEMS = [item(BAD, SDN_EVM), item(GOOD, CLEAN_EVM)];
const OWNER = "k".repeat(52);
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: OWNER, PUBLIC_BASE_URL: "http://lumi.test" };
function appFetch(): typeof fetch {
  const base = makeFetch(happyFacilitator());
  return (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources")) return new Response(JSON.stringify({ items: ITEMS, pagination: { limit: 30, offset: 0, total: ITEMS.length } }));
    if (url.startsWith("https://api.sdnseller.com/") || url.startsWith("https://api.cleanseller.com/")) return new Response("nope", { status: 200 });
    return base(input, init);
  }) as typeof fetch;
}
async function setup() {
  const ev = new MemoryEvidenceStore();
  const logs: any[] = [];
  const app = createApp(ENV as any, { fetch: appFetch(), now: () => NOW, catalogStore: new MemoryCatalogStore(), evidenceStore: ev, log: (e: any) => logs.push(e) });
  await app.scheduled();
  const req = (p: string, init: RequestInit = {}) => app.fetch(new Request("http://lumi.test" + p, init));
  const get = async (p: string, h: Record<string, string> = {}) => { const r = await req(p, { headers: h }); return { status: r.status, body: (await r.json()) as any }; };
  const buy = async (p: string) => { const q: any = await (await req(p)).json(); return get(p, { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts[0]) }); };
  return { ev, logs, req, get, buy };
}
const refusals = (logs: any[]) => logs.filter((l) => l?.event === "sanctioned_address_refused");

describe("sanctions: app hooks", () => {
  it("/v1/trust/check blocks a listed payTo with sanctioned_address, logs it, and queues no test-buy", async () => {
    const { ev, logs, buy } = await setup();
    const r = await buy("/v1/trust/check?url=" + encodeURIComponent(BAD) + "&pay_to=" + SDN_EVM);
    expect(r.status).toBe(200);
    expect(r.body.verdict).toBe("block");
    expect(r.body.reasons[0].code).toBe(SANCTIONS_REASON);
    await new Promise((s) => setTimeout(s, 0));
    expect([...ev.queue.keys()]).not.toContain(BAD);
    expect(refusals(logs)[0]).toMatchObject({ where: "trust_check", address: SDN_EVM.toLowerCase() });
  });
  it("the owner buy-queue withholds a listed payTo from the runner and reports it as refused", async () => {
    const { ev, logs, get } = await setup();
    await ev.enqueueBuy({ resource: BAD, network: "eip155:8453", price_usd: 0.01, reasons: ["no_organic_payers"] }, NOW);
    await ev.enqueueBuy({ resource: GOOD, network: "eip155:8453", price_usd: 0.01, reasons: ["no_organic_payers"] }, NOW);
    const q = await get("/v1/trust/catalog/buy-queue", { Authorization: "Bearer " + OWNER });
    expect(q.status).toBe(200);
    expect(q.body.rows.map((r: any) => r.resource)).toEqual([GOOD]);
    expect(q.body.refused).toEqual([{ resource: BAD, pay_to: SDN_EVM.toLowerCase(), reason: SANCTIONS_REASON }]);
    expect(refusals(logs).some((l) => l.where === "catalog_buy_queue")).toBe(true);
  });
  it("monitor: a listed payTo gets no enrolment challenge (EVM any case, XRPL)", async () => {
    const { logs, req } = await setup();
    for (const a of [SDN_EVM, SDN_EVM.toLowerCase(), SDN_XRPL]) {
      const r = await req("/v1/monitor/challenge?pay_to=" + a);
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ reason: SANCTIONS_REASON, list: "OFAC SDN" });
    }
    expect((await req("/v1/monitor/challenge?pay_to=" + CLEAN_EVM)).status).toBe(200);
    expect(refusals(logs).filter((l) => l.where === "monitor_challenge")).toHaveLength(3);
  });
});

describe("sanctions: box runner guard (scripts/ofac_guard.ts)", () => {
  it("refuses and logs listed payTos, passes clean ones, falls back to the repo snapshot", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "ofac-")); // empty: no box copy, so the repo snapshot is used
    process.env.LUMI_OFAC_DIR = dir;
    process.env.LUMI_SANCTIONS_LOG = join(dir, "refused.log");
    const g = await import("../scripts/ofac_guard");
    expect(() => g.assertPayToAllowed(SDN_EVM, "catalog_buys", { resource: BAD })).toThrow(g.SanctionedAddressError);
    expect(() => g.assertPayToAllowed(classicAddressToXAddress(SDN_XRPL, 5, false), "trust_testbuys:xrpl")).toThrow(/sanctioned_address/);
    expect(() => g.assertPayToAllowed(CLEAN_EVM, "catalog_buys")).not.toThrow();
    const lines = readFileSync(join(dir, "refused.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.event, l.where, l.pay_to])).toEqual([
      ["sanctioned_address_refused", "catalog_buys", SDN_EVM.toLowerCase()],
      ["sanctioned_address_refused", "trust_testbuys:xrpl", SDN_XRPL],
    ]);
    expect(g.loadSanctionsSet([join(dir, "nope.json")]).files).toEqual([]); // nothing loadable => assertPayToAllowed fails closed
  });
});
