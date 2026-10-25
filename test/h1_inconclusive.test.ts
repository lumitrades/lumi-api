import { describe, it, expect } from "vitest";
import { deriveKeypair, deriveAddress, generateSeed, sign } from "ripple-keypairs";
import { createApp } from "../src/app";
import { buildReceiptBody, outcomeOf, receiptHash, receiptMatchesBuy, receiptMessage, verifyReceipt, MemoryReceiptStore, type PendingBuy, type Receipt } from "../src/trust/receipts";
import { dataReturnedView, deliveryCounts, deliveryState, deliveryText, guardBuy } from "../src/trust/delivery";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { trustVerdict } from "../src/quick";
import { utf8Hex } from "../src/trust/verify";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch } from "./helpers";

const BASE = "https://x.test";
const OWNER = "k".repeat(52);
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: OWNER };
const kp = deriveKeypair(generateSeed({ entropy: new Uint8Array(16).fill(9) }));
const XADDR = deriveAddress(kp.publicKey);
const TX = "4D407705BA422D804B3F3DD3505334926FD09051D6C0ED5BED9B7D235EEB9AFC";
const RES = "https://esgpulse.example/api/esg/cruelty-free";
const tbuy: PendingBuy = {
  kind: "catalog", ref: RES, endpoint: RES, domain: "esgpulse.example", pay_to: "rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32", ts: NOW - 3_600_000,
  network: "xrpl:0", tx_hash: TX, amount: "0.1", asset: "RLUSD", http_status: null, data_returned: false, latency_ms: null,
  summary: "XRPL test-buy 2026-10-23: payment settled; no HTTP response within 90 s, no data returned.", source: "lumi_catalog_buy",
};

async function signX(b: PendingBuy, supersedes?: { receipt_hash: string; reason: string }): Promise<Receipt> {
  const body = buildReceiptBody(b, { payer: XADDR, pay_to: b.pay_to!, ledger_result: "tesSUCCESS", ledger_index: 100, iou_issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" }, { issuedAt: new Date(NOW).toISOString(), supersedes });
  const h = await receiptHash(body);
  const message = receiptMessage(b.network, b.tx_hash, h);
  return { ...body, receipt_hash: h, signer: { key_type: "ripple-keypairs", address: XADDR, public_key: kp.publicKey, message, signature: sign(utf8Hex(message), kp.privateKey) } };
}

describe("H-1 guard: a buy with no HTTP response is inconclusive, never 'no data returned'", () => {
  it("classifies status 0/null without data as inconclusive (Lumi-side)", () => {
    expect(deliveryState({ http_status: null, data_returned: false })).toBe("inconclusive");
    expect(deliveryState({ http_status: 0, data_returned: false })).toBe("inconclusive");
    expect(deliveryState({ http_status: 502, data_returned: false })).toBe("not_delivered");
    expect(deliveryState({ http_status: 200, data_returned: true })).toBe("delivered");
    expect(deliveryState({ http_status: 200, data_returned: false, inconclusive: "lumi_side_error" })).toBe("inconclusive");
    expect(dataReturnedView({ http_status: null, data_returned: false })).toBeNull();
    expect(deliveryText({ http_status: 0, data_returned: false })).not.toMatch(/no (usable )?data/i);
    expect(deliveryCounts([{ http_status: 200, data_returned: true }, { http_status: 502, data_returned: false }, { http_status: null, data_returned: false }]))
      .toEqual({ delivered: 1, not_delivered: 1, inconclusive: 1, conclusive: 2 });
  });

  it("guardBuy rewrites the stored summary and keeps an explicit reason", () => {
    const g = guardBuy({ http_status: null, data_returned: false, summary: tbuy.summary, inconclusive: "lumi_client_timeout" });
    expect(g.inconclusive).toBe("lumi_client_timeout");
    expect(g.summary).not.toMatch(/no data returned/i);
    expect(g.summary).toMatch(/delivery unknown \(inconclusive, Lumi-side/);
    expect(guardBuy({ http_status: 0, data_returned: false, summary: "x" }).inconclusive).toBe("no_http_response");
    expect(guardBuy({ http_status: 404, data_returned: false, summary: "404" }).inconclusive).toBeNull();
  });

  it("catalog observation upload cannot record a status-0 buy as no data", async () => {
    const cs = new MemoryCatalogStore();
    await cs.addBuy(guardBuy({ resource: RES, domain: "esgpulse.example", ts: NOW, network: "xrpl:0", tx_hash: TX, amount: "0.1", asset: "RLUSD", pay_to: "r", facilitator: null, http_status: null, data_returned: false, latency_ms: null, summary: "no data returned" } as any));
    expect(deliveryState(cs.buys[0])).toBe("inconclusive");
    expect(cs.buys[0].summary).not.toMatch(/no data returned/i);
  });
});

describe("H-1 trust/check verdict: inconclusive buys never warn or block", () => {
  const entry = (purchases: any[]) => ({
    resource: RES, domain: "esgpulse.example", tier: "purchase-verified", listed_price_usd: "0.1",
    pay_to: [{ pay_to: "rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32", network: "xrpl:0" }],
    quote_checks: { last_checked_at: "2026-10-22T12:00:00Z", last_valid_quote: true, checks_recorded: 5, valid_quote_rate: 1, median_latency_ms: 300 },
    domain_age: { age_days: 400 }, purchases,
  });
  const inc = { at: "2026-10-23T03:15:50Z", tx_hash: TX, amount: "0.1", asset: "RLUSD", http_status: null, data_returned: null, delivery: "inconclusive", inconclusive_reason: "lumi_run_interrupted" };
  it("an inconclusive latest buy is info only (no paid_no_data block)", () => {
    const v: any = trustVerdict({ url: RES }, { catalog: { entries: [entry([inc])] }, curated: [] }, null, BASE);
    const codes = v.reasons.map((r: any) => r.code);
    expect(codes).not.toContain("paid_no_data");
    expect(codes).toContain("purchase_inconclusive");
    expect(v.verdict).not.toBe("block");
    expect(v.reasons.find((r: any) => r.code === "purchase_inconclusive").severity ?? "info").toBe("info");
    expect(JSON.stringify(v)).not.toMatch(/scam/i);
  });
  it("legacy rows (data_returned false, status null, no delivery field) are also not blocked", () => {
    const v: any = trustVerdict({ url: RES }, { catalog: { entries: [entry([{ ...inc, data_returned: false, delivery: undefined }])] }, curated: [] }, null, BASE);
    expect(v.reasons.map((r: any) => r.code)).not.toContain("paid_no_data");
    expect(v.verdict).not.toBe("block");
  });
  it("the verdict falls back to the latest conclusive buy", () => {
    const ok = { at: "2026-10-22T03:00:00Z", tx_hash: "AA".repeat(32), amount: "0.1", asset: "RLUSD", http_status: 200, data_returned: true, delivery: "delivered" };
    const v: any = trustVerdict({ url: RES }, { catalog: { entries: [entry([inc, ok])] }, curated: [] }, null, BASE);
    expect(v.verdict).toBe("allow");
    const bad = { ...ok, http_status: 502, data_returned: false, delivery: "not_delivered" };
    // Legal review M1: one failed conclusive buy is "check first" (and asks for a confirming re-buy), never checks_failed.
    const one: any = trustVerdict({ url: RES }, { catalog: { entries: [entry([inc, bad])] }, curated: [] }, null, BASE, undefined, Date.parse("2026-10-23T12:00:00Z"));
    expect(one.verdict).toBe("warn");
    expect(one.reasons.map((r: any) => r.code)).toContain("recent_buy_failed");
  });
  it("curated XRPL: an inconclusive latest buy does not add xrpl_paid_no_data", () => {
    const v: any = trustVerdict({ url: "https://curated.test/x" }, { catalog: { entries: [] }, curated: [{ id: "c", name: "C", detail: `${BASE}/v1/trust/vendors/c`, xrpl_test_buys: { count: 1, delivered: 0, inconclusive: 1 }, purchases: [{ ...inc, network: "xrpl:0" }] }] }, null, BASE);
    const codes = v.reasons.map((r: any) => r.code);
    expect(codes).not.toContain("xrpl_paid_no_data");
    expect(codes).toContain("xrpl_purchase_inconclusive");
  });
});

describe("H-1 receipts: inconclusive outcome, auditable supersede, I-2 signature_ok", () => {
  it("outcomeOf never returns timeout/other for a buy with no HTTP response", () => {
    expect(outcomeOf(null, false, "no HTTP response within 90 s")).toBe("inconclusive");
    expect(outcomeOf(0, false, "")).toBe("inconclusive");
    expect(outcomeOf(502, false, "")).toBe("error_status");
  });

  it("an inconclusive receipt has data_returned null and verifies", async () => {
    const r = await signX(tbuy);
    expect(r.delivery.outcome).toBe("inconclusive");
    expect(r.delivery.data_returned).toBeNull();
    expect(r.delivery.note).toMatch(/Lumi-side/);
    expect((await verifyReceipt(r)).ok).toBe(true);
    expect(receiptMatchesBuy(r, tbuy)).toBeNull();
  });

  it("I-2: a tampered body never reports signature_ok true", async () => {
    const r = await signX({ ...tbuy, http_status: 200, data_returned: true });
    const t = structuredClone(r); t.delivery.data_returned = false; t.delivery.outcome = "no_data";
    const c = await verifyReceipt(t);
    expect(c.ok).toBe(false);
    expect(c.hash_ok).toBe(false);
    expect(c.signature_ok).toBe(false);
    expect(c.errors).toContain("signature_not_over_body");
  });

  it("replacing a stored receipt requires supersedes; the old one stays verifiable as superseded", async () => {
    const rs = new MemoryReceiptStore();
    const legacy: PendingBuy = { ...tbuy };
    rs.buys = [legacy];
    const app = createApp({ ...ENV, TRUST_BUYER_ADDRESSES: XADDR } as any, { fetch: makeFetch(happyFacilitator()), now: () => NOW, receiptStore: rs });
    const auth = { Authorization: "Bearer " + OWNER, "Content-Type": "application/json" };
    const post = async (receipts: Receipt[]) => (await (await app.fetch(new Request(`${BASE}/v1/trust/receipts`, { method: "POST", headers: auth, body: JSON.stringify({ receipts }) }))).json()) as any;
    const first = await signX(legacy);
    expect((await post([first])).stored).toBe(1);
    expect((await post([first])).results[0].duplicate).toBe(true);
    // A new receipt for the same tx (re-issued at another time) without naming the old one is refused.
    const again = await signX({ ...legacy, summary: "re-issued" });
    const noSup = { ...again, delivery: { ...again.delivery } };
    const issued2 = buildReceiptBody(legacy, { payer: XADDR, pay_to: legacy.pay_to!, ledger_result: "tesSUCCESS", ledger_index: 100 }, { issuedAt: new Date(NOW + 1000).toISOString() });
    const h2 = await receiptHash(issued2);
    const m2 = receiptMessage("xrpl:0", TX, h2);
    const r2: Receipt = { ...issued2, receipt_hash: h2, signer: { key_type: "ripple-keypairs", address: XADDR, public_key: kp.publicKey, message: m2, signature: sign(utf8Hex(m2), kp.privateKey) } };
    void noSup;
    expect((await post([r2])).results[0].errors).toContain("supersedes_required");
    const fixed = await signX(legacy, { receipt_hash: first.receipt_hash, reason: "H-1 correction: inconclusive (Lumi-side)" });
    const res = await post([fixed]);
    expect(res.results[0].stored).toBe(true);
    expect(res.results[0].superseded).toBe(first.receipt_hash);
    const verify = async (r: Receipt) => (await (await app.fetch(new Request(`${BASE}/v1/trust/receipts/verify`, { method: "POST", body: JSON.stringify(r) }))).json()) as any;
    const vo = await verify(first);
    expect(vo.ok).toBe(true); expect(vo.status).toBe("superseded"); expect(vo.issued_by_lumi).toBe(true);
    expect(vo.superseded.by_receipt_hash).toBe(fixed.receipt_hash);
    const vn = await verify(fixed);
    expect(vn.status).toBe("current");
  });
});

describe("H-1 owner reclassify endpoint", () => {
  it("marks a stored catalog buy inconclusive, keeps the prior summary, and is owner-only", async () => {
    const cs = new MemoryCatalogStore();
    cs.buys.push({ resource: RES, domain: "esgpulse.example", ts: NOW, network: "xrpl:0", tx_hash: TX, amount: "0.1", asset: "RLUSD", pay_to: "r", facilitator: null, http_status: null, data_returned: false, latency_ms: null, summary: tbuy.summary } as any);
    const rs = new MemoryReceiptStore(); rs.buys = [tbuy];
    const app = createApp({ ...ENV } as any, { fetch: makeFetch(happyFacilitator()), now: () => NOW, receiptStore: rs, catalogStore: cs });
    const call = (body: any, auth = true) => app.fetch(new Request(`${BASE}/v1/trust/buys/inconclusive`, { method: "POST", headers: { ...(auth ? { Authorization: "Bearer " + OWNER } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    expect((await call({ tx_hash: TX, reason: "lumi_run_interrupted" }, false)).status).toBe(401);
    expect((await call({ tx_hash: TX, reason: "seller_bad" })).status).toBe(400);
    expect((await call({ tx_hash: "AB".repeat(32), reason: "lumi_client_timeout" })).status).toBe(404);
    const r = await call({ tx_hash: TX.toLowerCase(), reason: "lumi_run_interrupted" });
    const j: any = await r.json();
    expect(r.status).toBe(200);
    expect(j.delivery).toBe("inconclusive"); expect(j.data_returned).toBeNull();
    expect(cs.buys[0].inconclusive).toBe("lumi_run_interrupted");
    expect(cs.buys[0].summary_before).toBe(tbuy.summary);
    expect(cs.buys[0].summary).not.toMatch(/no data returned/i);
  });
});
