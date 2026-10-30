/**
 * First-customer plan (2026-10-30): free check first in agent text, dollar prices on paid tools, an honest paid_option near
 * the top of the free check, "pay in 10 lines" examples (+ how_to_pay in 402s), the first high-value refund flag (default
 * OFF, no money path), lumi_quote Stellar amounts in USDC, and unfilled path templates answering 400 (covered in app.test.ts).
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { MemoryEvidenceStore } from "../src/trust/evidence";
import { MemoryTrialStore } from "../src/trial";
import { MemoryTrustStore } from "../src/trust/store";
import { SEED_OBSERVATIONS } from "../src/trust/seed";
import { MemorySalesStore, firstHighValueRefunds, toRow } from "../src/sales";
import { FIRST_HV_REFUND_CAP_USD, firstHvRefundOn, loadConfig, paidOptionText } from "../src/config";
import { PAY_NODE, PAY_PYTHON } from "../src/pay_examples";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch } from "./helpers";

const BASE = "https://api.lumitrades.io";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SELLER = "https://api.s1.com/v1/q";
const OWNER = "owner-key-for-tests-0123456789-abcdefghijklmnop";
const ENV = {
  XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret",
  PUBLIC_BASE_URL: BASE, XRPL_RPC_URLS: "https://xrpl.rpc.test/", OWNER_MCP_KEY: OWNER,
  EVM_PAY_TO: "0x5E617bac19912e6d212CB303ae84655E9E203532", EVM_NETWORK: "eip155:8453", EVM_FACILITATOR_URL: "https://evm-fac.test",
  EVM_CDP_ONLY_ROUTES: "none", BASE_RPC_URL: "https://base-rpc.test",
  STELLAR_PAY_TO: "GCKTH26VNR4H4WLCXS5DX6563XRQQXWP5QKQWFD6CHOGTZJ2N5GKBU2L", STELLAR_NETWORK: "stellar:pubnet",
  STELLAR_FACILITATOR_URL: "https://stellar-facilitator.test/x402", STELLAR_FACILITATOR_API_KEY: "test-key",
};
const enc = encodeURIComponent;
const b64 = (s: string | null) => JSON.parse(Buffer.from(s ?? "", "base64").toString("utf8"));
const BUYER = "0x1111111111111111111111111111111111111111";

async function setup(extra: Record<string, string> = {}, sales = new MemorySalesStore()) {
  const fallback = makeFetch(happyFacilitator());
  const calls: string[] = [];
  const ITEMS = [{
    resource: SELLER, type: "http", description: "d",
    accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: "0x" + "ab".repeat(20) }],
    extensions: { bazaar: { info: { input: { method: "GET", type: "http" } } } },
    quality: { l30DaysTotalCalls: 50, l30DaysUniquePayers: 6, lastCalledAt: new Date(NOW - 3_600_000).toISOString() }, lastUpdated: new Date(NOW).toISOString(),
  }];
  const doFetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.startsWith("https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources"))
      return new Response(JSON.stringify({ items: ITEMS, pagination: { limit: 30, offset: 0, total: 1 } }));
    if (url === "https://xrpl.rpc.test/") return new Response(JSON.stringify({ result: { transactions: [] } }));
    if (url.startsWith("https://base-rpc.test")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (50_000n).toString(16).padStart(64, "0") }));
    if (url.startsWith("https://api.s1.com/")) {
      const pr = { x402Version: 2, accepts: ITEMS[0].accepts };
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
    }
    return fallback(input, init);
  }) as typeof fetch;
  const ev = new MemoryEvidenceStore();
  ev.resources = new Set([SELLER]);
  const app = createApp({ ...ENV, ...extra } as any, {
    fetch: doFetch, log: () => {}, now: () => NOW, catalogStore: new MemoryCatalogStore(), evidenceStore: ev, trialStore: new MemoryTrialStore(),
    trustStore: new MemoryTrustStore(SEED_OBSERVATIONS), salesStore: sales,
  } as any);
  await app.scheduled();
  const req = (p: string, headers: Record<string, string> = {}) => app.fetch(new Request(BASE + p, { headers: { "CF-Connecting-IP": "203.0.113.7", ...headers } }));
  const mcp = async (method: string, params: unknown) => (await (await app.fetch(new Request(BASE + "/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }))).json()) as any;
  return { app, req, mcp, calls };
}

describe("move 3: honest upgrade hint near the top of the free check", () => {
  it("access and paid_option come right after summary / summary_facts; paying never changes the result", async () => {
    const { req } = await setup();
    const r = await req(`/v1/trust/check?url=${enc(SELLER)}&amount=10`);
    expect(r.status).toBe(200);
    const text = await r.text();
    const keys = Object.keys(JSON.parse(text));
    expect(keys.slice(0, 7)).toEqual(["kind", "timestamp", "source", "summary", "summary_facts", "access", "paid_option"]);
    const b = JSON.parse(text);
    expect(b.access).toMatchObject({ mode: "free", charged: false });
    expect(b.paid_option).toBe(paidOptionText(10));
    expect(b.paid_option).toMatch(/price 0\.5% of the amount \(min \$0\.005, max \$0\.25\), \$0\.05 for amount=10; same verdict, label and score \(paying never changes them\)$/);
    expect(b.paid_option).not.toMatch(/better|higher|improve|boost/i);
    expect(text.indexOf('"paid_option"')).toBeLessThan(text.indexOf('"verdict"'));
  });
  it("without an amount: no per-amount price, still the honest wording", async () => {
    const { req } = await setup();
    const b: any = await (await req(`/v1/trust/check?url=${enc(SELLER)}`)).json();
    expect(b.paid_option).toBe(paidOptionText());
    expect(b.paid_option).not.toMatch(/for amount=/);
  });
  it("MCP lumi_trust_check result carries paid_option near the top too", async () => {
    const { mcp } = await setup();
    const out = await mcp("tools/call", { name: "lumi_trust_check", arguments: { url: SELLER } });
    const t = out.result.content[0].text as string;
    expect(t).toContain('"paid_option"');
    expect(t.indexOf('"paid_option"')).toBeLessThan(t.indexOf('"verdict"'));
    expect(t).toMatch(/paying never changes them/);
  });
});

describe("moves 1-2: free check first, dollar prices on paid tools and skills", () => {
  it("MCP: trust check is first and says start here; paid tools state their price; quote/catalog mention Stellar", async () => {
    const { mcp } = await setup();
    const tools = (await mcp("tools/list", {})).result.tools as any[];
    const d = Object.fromEntries(tools.map((t) => [t.name, t.description as string]));
    expect(tools[0].name).toBe("lumi_trust_check");
    expect(d.lumi_trust_check).toMatch(/Start here before any paid tool\. One label \(checks_passed \/ check_first \/ checks_failed \/ no_data\)/);
    expect(d.lumi_verdict).toMatch(/^Paid: \$0\.01 per call/);
    expect(d.lumi_high_value_check).toMatch(/^Paid: 0\.5% of the stated amount, min \$0\.005, max \$0\.25 \(e\.g\. \$0\.05 for amount=10\)/);
    expect(d.lumi_vendor_report).toMatch(/Paid: \$0\.02 per call/);
    expect(d.lumi_quote).toMatch(/USDC on Stellar/);
    expect(d.lumi_catalog).toMatch(/USDC on Stellar/);
  });
  it("A2A card: paid skills carry their dollar price; trust_check says start here", async () => {
    const { req } = await setup();
    const card: any = await (await req("/.well-known/agent-card.json")).json();
    const s = Object.fromEntries(card.skills.map((x: any) => [x.id, x]));
    expect(s.trust_check.name).toMatch(/checks_passed \/ check_first \/ checks_failed \/ no_data.*start here/);
    expect(s.high_value_check.description).toMatch(/^Price: 0\.5% of the amount \(min \$0\.005, max \$0\.25\) per call, e\.g\. \$0\.05 for amount=10\./);
    expect(s.vendor_report.description).toMatch(/^Price: \$0\.02 per call\./);
  });
  it("stdio MCP package: same prices and start-here text", () => {
    const src = readFileSync(new URL("../mcp/src/index.js", import.meta.url), "utf8");
    expect(src).toMatch(/Paid: \$0\.01 per call/);
    expect(src).toMatch(/Paid: 0\.5% of the stated amount, min \$0\.005, max \$0\.25/);
    expect(src).toMatch(/Paid: \$0\.02 per call/);
    expect(src).toMatch(/USDC on Stellar/);
  });
  it("lumi_quote shows Stellar USDC as a decimal amount, not stroops", async () => {
    const { mcp } = await setup();
    const out = await mcp("tools/call", { name: "lumi_quote", arguments: { path: `/v1/trust/check/high-value?url=${enc(SELLER)}&amount=10` } });
    const q = JSON.parse(out.result.content[0].text);
    const st = q.options.find((o: any) => String(o.network).startsWith("stellar:"));
    expect(st).toBeTruthy();
    expect(st.amount).toBe("0.05");
    const base = q.options.find((o: any) => o.network === "eip155:8453");
    expect(base.amount).toBe("0.05");
  });
});

describe("move 4: pay in 10 lines", () => {
  it("the committed examples are exactly what skill.md serves, and each is at most 10 lines", () => {
    const node = readFileSync(new URL("../examples/pay-in-10-lines.mjs", import.meta.url), "utf8");
    const py = readFileSync(new URL("../examples/pay_in_10_lines.py", import.meta.url), "utf8");
    expect(node).toBe(PAY_NODE);
    expect(py).toBe(PAY_PYTHON);
    for (const s of [node, py]) expect(s.trimEnd().split("\n").length).toBeLessThanOrEqual(10);
    expect(node).toMatch(/MAX = 250000n/);
    expect(py).toMatch(/MAX = .*250000/);
    for (const s of [node, py]) expect(s).not.toMatch(/0x[0-9a-fA-F]{64}/); // no key material
  });
  it("skill.md has the section with both examples, the free-check-first line and the labels", async () => {
    const { req } = await setup();
    const skill = await (await req("/skill.md")).text();
    expect(skill).toContain("## Pay in 10 lines (USDC on Base)");
    expect(skill).toContain(PAY_NODE);
    expect(skill).toContain(PAY_PYTHON);
    expect(skill).toMatch(/`checks_passed` \/ `check_first` \/ `checks_failed` \/ `no_data`/);
    expect(skill).toMatch(/Call it before any paid route/);
    expect(skill.indexOf("## Start here: the free trust check")).toBeLessThan(skill.indexOf("## Pay in 10 lines"));
  });
  it("paid 402s with a Base option carry how_to_pay (body and header), small enough for the header budget", async () => {
    const { req } = await setup();
    for (const p of [`/v1/trust/check/high-value?url=${enc(SELLER)}&amount=1`, `/v1/trust/check/high-value`]) {
      const r = await req(p);
      expect(r.status, p).toBe(402);
      const body: any = await r.json();
      const hdr = b64(r.headers.get("PAYMENT-REQUIRED"));
      expect(body.how_to_pay).toEqual(hdr.how_to_pay);
      expect(body.how_to_pay).toBe(`${BASE}/skill.md#pay-in-10-lines-usdc-on-base (node or Python, USDC on Base)`);
      // The pointer is small: its share of the base64 header is well under 150 chars.
      expect(Math.ceil((JSON.stringify(body.how_to_pay).length + 14) * 4 / 3)).toBeLessThan(150);
    }
  });
  it("how_to_pay keeps a Base-only 402 (the live CDP-only setup) under the 8000-char header budget", async () => {
    const { req } = await setup({ STELLAR_PAY_TO: "", XRPL_NETWORK: "xrpl:1" });
    const r = await req(`/v1/trust/check/high-value?url=${enc(SELLER)}&amount=1`);
    expect(r.status).toBe(402);
    expect(((await r.json()) as any).how_to_pay).toBeTruthy();
    expect(r.headers.get("PAYMENT-REQUIRED")!.length).toBeLessThan(8000);
  });
  it("no Base option (CDP-only trust routes without CDP): no how_to_pay", async () => {
    const { req } = await setup({ EVM_CDP_ONLY_ROUTES: "" });
    const body: any = await (await req(`/v1/trust/check/high-value?url=${enc(SELLER)}&amount=1`)).json();
    if (!body.accepts.some((a: any) => String(a.network).startsWith("eip155:"))) expect(body.how_to_pay).toBeUndefined();
  });
});

describe("move 5: first high-value check refund flag (default OFF, no money path)", () => {
  const sale = (payer: string, usd: number, ts: number, tx: string, route = "high_value_check") =>
    toRow({ route, rail: "base", network: "eip155:8453", asset: "USDC", amount: String(usd), usd, payer, tx, ts }, NOW);

  it("only the exact value 'on' enables it; default config is off", () => {
    expect(firstHvRefundOn({})).toBe(false);
    for (const v of ["", "off", "true", "1", "yes", "enabled", "onn"]) expect(firstHvRefundOn({ FIRST_HV_REFUND: v }), v).toBe(false);
    for (const v of ["on", "ON", " On "]) expect(firstHvRefundOn({ FIRST_HV_REFUND: v }), v).toBe(true);
    expect(loadConfig(ENV as any).firstHvRefund).toBe(false);
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    expect(toml).toMatch(/^FIRST_HV_REFUND = "off"/m);
  });

  it("flag off: no offer in the 402, owner list is a 404 before auth, nothing read or fetched", async () => {
    const sales = new MemorySalesStore();
    await sales.insert(sale(BUYER, 0.05, NOW - 1000, "0x" + "1".repeat(64)));
    let reads = 0;
    const since = sales.since.bind(sales);
    sales.since = async (t) => { reads++; return since(t); };
    const { req, calls } = await setup({}, sales);
    const q: any = await (await req(`/v1/trust/check/high-value?url=${enc(SELLER)}&amount=1`)).json();
    expect(q.first_check_refund).toBeUndefined();
    const before = calls.length;
    for (const h of [{}, { Authorization: `Bearer ${OWNER}` }] as Record<string, string>[]) {
      const r = await req("/v1/owner/refunds/first-high-value", h);
      expect(r.status).toBe(404);
    }
    expect(reads).toBe(0);
    expect(calls.length).toBe(before);
  });

  it("flag on: the 402 announces it; owner list needs the key and is computed from the ledger without any outbound call", async () => {
    const sales = new MemorySalesStore();
    await sales.insert(sale(BUYER, 0.05, NOW - 3000, "0x" + "1".repeat(64)));
    await sales.insert(sale(BUYER.toUpperCase().replace("0X", "0x"), 0.25, NOW - 2000, "0x" + "2".repeat(64))); // same payer, later: not owed
    await sales.insert(sale("0x2222222222222222222222222222222222222222", 0.25, NOW - 1000, "0x" + "3".repeat(64)));
    await sales.insert(sale("0x3333333333333333333333333333333333333333", 0.01, NOW - 500, "0x" + "4".repeat(64), "verdict")); // not high-value
    await sales.insert(sale("0x7722DfAE6bbed2Fd02Dc07455c2f5BF14bE25E4a", 0.05, NOW - 400, "0x" + "5".repeat(64))); // Lumi's own test wallet
    const { req, calls } = await setup({ FIRST_HV_REFUND: "on" }, sales);
    const q: any = await (await req(`/v1/trust/check/high-value?url=${enc(SELLER)}&amount=1`)).json();
    expect(q.first_check_refund).toMatch(/refunded, up to \$0\.25, once per payer address/);
    expect(q.first_check_refund).toMatch(/same either way/);
    const v: any = await (await req(`/v1/verdict?url=${enc(SELLER)}`)).json().catch(() => ({}));
    expect(v.first_check_refund).toBeUndefined();
    expect((await req("/v1/owner/refunds/first-high-value")).status).toBe(401);
    expect((await req("/v1/owner/refunds/first-high-value", { Authorization: "Bearer wrong" })).status).toBe(401);
    const before = calls.length;
    const r = await req("/v1/owner/refunds/first-high-value", { Authorization: `Bearer ${OWNER}` });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(calls.length).toBe(before); // no facilitator, RPC or any other outbound call: nothing can be sent
    expect(b).toMatchObject({ kind: "lumi_first_hv_refunds", enabled: true, cap_usd: 0.25, count: 2, total_usd: 0.3 });
    expect(b.owed.map((x: any) => [x.payer, x.refund_usd, x.tx[2]])).toEqual([[BUYER, 0.05, "1"], ["0x2222222222222222222222222222222222222222", 0.25, "3"]]);
    expect(b.note).toMatch(/never sends refunds automatically/);
  });

  it("refund is capped at $0.25 even for an odd ledger row", () => {
    const rows = [sale(BUYER, 9, NOW, "0xa"), sale("rPayer", NaN, NOW, "0xb")];
    const out = firstHighValueRefunds(rows, FIRST_HV_REFUND_CAP_USD);
    expect(out.every((x) => x.refund_usd <= 0.25)).toBe(true);
  });

  it("the refund code has no money path (no fetch, facilitator or signing in the module or route)", () => {
    const src = readFileSync(new URL("../src/sales.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export function firstHighValueRefunds"));
    expect(fn).not.toMatch(/fetch|settle|sign|facilitator|send/i);
    const app = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    const a = app.indexOf('if (path === "/v1/owner/refunds/first-high-value")');
    const route = app.slice(a, app.indexOf("// Owner-only sales ledger summary", a));
    expect(route).not.toMatch(/doFetch|settle|sign\(|facilitator/);
  });
});
