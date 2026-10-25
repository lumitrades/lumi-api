import { describe, it, expect } from "vitest";
import { deriveAddress, deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { createApp } from "../src/app";
import { MemoryTrustStore } from "../src/trust/store";
import { SEED_OBSERVATIONS } from "../src/trust/seed";
import { MemoryReceiptStore, buildReceiptBody, receiptHash, receiptMessage, verifyReceipt, type PendingBuy, type Receipt } from "../src/trust/receipts";
import { utf8Hex } from "../src/trust/verify";
import { isoTimestamps } from "../src/freshness";
import { compact } from "../src/products";
import { sanitize } from "../src/sanitize";
import { trustVerdict } from "../src/quick";
import { FACILITATOR, DATA, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";

const KEY = "k".repeat(20) + "0123456789abcdef0123456789abcdef";
const BASE = "http://lumi.test";
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: KEY, PUBLIC_BASE_URL: BASE };
const kp = deriveKeypair(generateSeed({ entropy: new Uint8Array(16).fill(9) }));
const BUYER = deriveAddress(kp.publicKey);

async function signFor(tx: string, ts: number, extra: Partial<PendingBuy> = {}): Promise<Receipt> {
  const b: PendingBuy = { kind: "vendor", ref: "asksurf", endpoint: "https://x402.asksurf.ai/x402/xrpl/data/v1/news/feed", domain: null, pay_to: null, ts, network: "xrpl:0", tx_hash: tx, amount: "0.006", asset: "RLUSD", http_status: 200, data_returned: true, latency_ms: 700, summary: "ok", source: "lumi_test_buy", ...extra };
  const body = buildReceiptBody(b, { payer: BUYER, pay_to: "ra9b6JX5aPVbdJhogDDddsRAcasWg7gzC3", ledger_result: "tesSUCCESS", ledger_index: 1 }, { issuedAt: new Date(NOW).toISOString() });
  const h = await receiptHash(body);
  const message = receiptMessage("xrpl:0", tx, h);
  return { ...body, receipt_hash: h, signer: { key_type: "ripple-keypairs", address: BUYER, public_key: kp.publicKey, message, signature: sign(utf8Hex(message), kp.privateKey) } } as Receipt;
}

describe("H-2 signed receipts are served exactly as signed", () => {
  it("body walkers leave signed receipts untouched (ms timestamps, nulls) but still normalise siblings", async () => {
    const r = await signFor("AB".repeat(32), Date.parse("2026-10-23T09:25:11Z"), { http_status: 0, data_returned: false, summary: "" });
    expect(r.delivery.observed_at).toMatch(/\.000Z$/);
    const wrapped = { at: "2026-10-23T09:25:11.000Z", history: [{ at: "2026-10-23T09:25:11.000Z", receipt: r }] };
    for (const out of [isoTimestamps(wrapped), compact(wrapped), sanitize(wrapped)] as any[]) {
      expect(out.history[0].receipt).toEqual(r);
      expect(JSON.stringify(out.history[0].receipt)).toBe(JSON.stringify(r));
      expect((await verifyReceipt(out.history[0].receipt)).ok).toBe(true);
    }
    expect((isoTimestamps(wrapped) as any).at).toBe("2026-10-23T09:25:11Z");
    expect((isoTimestamps(wrapped) as any).history[0].at).toBe("2026-10-23T09:25:11Z");
  });

  it("paid vendor report: every embedded receipt equals the stored one and verifies ok", async () => {
    const store = new MemoryTrustStore(SEED_OBSERVATIONS);
    const rs = new MemoryReceiptStore();
    const fac = happyFacilitator();
    const app = createApp(ENV as any, { fetch: makeFetch(fac), log: () => {}, now: () => NOW, trustStore: store, receiptStore: rs } as any);
    const get = (p: string, h: Record<string, string> = {}) => app.fetch(new Request(BASE + p, { headers: h }));
    const first = await (await get("/v1/trust/vendors/asksurf/report", { Authorization: `Bearer ${KEY}` })).json();
    const hist: any[] = first.paid_test_buys?.history ?? [];
    expect(hist.length).toBeGreaterThan(0);
    const stored: Receipt[] = [];
    for (const h of hist) {
      const r = await signFor(h.tx_hash, Date.parse(h.at ?? h.ts ?? new Date(NOW - 3_600_000).toISOString()));
      stored.push(r);
      await rs.put([{ tx_hash: h.tx_hash, network: "xrpl:0", kind: "vendor", ref: "asksurf", receipt: r }]);
    }
    expect(stored.some((r) => /\.\d{3}Z$/.test(r.delivery.observed_at))).toBe(true);
    const q = await (await get("/v1/trust/vendors/asksurf/report")).json();
    const paid = await get("/v1/trust/vendors/asksurf/report", { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts[2]) });
    expect(paid.status).toBe(200);
    const b = await paid.json();
    expect(b.payment).toBeTruthy();
    const served = (b.paid_test_buys.history as any[]).map((h) => h.receipt).filter(Boolean);
    expect(served.length).toBe(stored.length);
    for (const s of served) {
      const orig = stored.find((r) => r.payment.tx_hash === s.payment.tx_hash)!;
      expect(s).toEqual(orig);
      const v = await verifyReceipt(s);
      expect(v.errors).toEqual([]);
      expect(v.ok).toBe(true);
    }
    // sibling timestamps in the same body are still normalised to second precision
    expect(JSON.stringify({ ...b, paid_test_buys: { ...b.paid_test_buys, history: b.paid_test_buys.history.map(({ receipt: _r, ...x }: any) => x) } })).not.toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });
});

describe("M-3 trust check: a known XRPL payTo of the seller is not a mismatch", () => {
  const URL_ = "https://esgpulse.theaslangroupllc.com/api/esg/cruelty-free";
  const EVM = "0x50ab2018c06c6E4eAA9BA52057Eb55eD284912fc";
  const XRPL = "rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32";
  const exact = (purchases: any[] = []) => ({ catalog: { entries: [{ resource: URL_, domain: "esgpulse.theaslangroupllc.com", tier: "test-bought", listed_price_usd: "0.05", pay_to: [{ network: "eip155:8453", pay_to: EVM }, { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", pay_to: "985iFjbnGQ3dJcwXnfRCMSrH4Jnc3kW1N6msR64B5KX1" }], quote_checks: { last_valid_quote: true, last_quote_pays_listed_address: true, last_price_matches_listing: true, checks_recorded: 3, valid_quote_rate: 1 }, purchases }] } });
  const codes = (b: any) => b.reasons.map((r: any) => r.code);

  it("the operator's XRPL payTo (curated aslan-macropulse shares the listed EVM payTo) matches", () => {
    const b: any = trustVerdict({ url: URL_, payTo: XRPL }, exact(), null, BASE);
    expect(codes(b)).toContain("pay_to_matches");
    expect(codes(b)).not.toContain("pay_to_mismatch");
    expect(b.verdict).not.toBe("block");
  });

  it("an XRPL payTo Lumi paid in its own signed test-buy receipt matches", () => {
    const other = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
    const e: any = exact([{ tx_hash: "AB".repeat(32), delivery: "delivered", data_returned: true, http_status: 200, receipt: { seller: { pay_to: other } } }]);
    e.catalog.entries[0].pay_to = [{ network: "eip155:8453", pay_to: "0x" + "77".repeat(20) }];
    expect(codes(trustVerdict({ url: URL_, payTo: other }, e, null, BASE))).toContain("pay_to_matches");
  });

  it("a random XRPL address and a wrong EVM address are still blocked; the listed EVM payTo still matches", () => {
    for (const bad of ["rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", "0x" + "12".repeat(20)]) {
      const b: any = trustVerdict({ url: URL_, payTo: bad }, exact(), null, BASE);
      expect(codes(b)).toContain("pay_to_mismatch");
      expect(b.verdict).toBe("block");
    }
    expect(codes(trustVerdict({ url: URL_, payTo: EVM.toLowerCase() }, exact(), null, BASE))).toContain("pay_to_matches");
  });
});

describe("L-9b feed: a bogus key is invalid, not missing", () => {
  const app = createApp(ENV as any, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW } as any);
  const call = (path: string, headers: Record<string, string> = {}, method = "GET") =>
    app.fetch(new Request(BASE + path, { method, headers: { "Content-Type": "application/json", ...headers }, ...(method === "POST" ? { body: JSON.stringify({ items: [{ url: "https://x.test/a" }] }) } : {}) }));

  it("no key -> api_key_required; bogus or unprefixed key -> invalid_api_key (401, invalid_token)", async () => {
    for (const [path, method] of [["/v1/feed/lookup", "POST"], ["/v1/feed/usage", "GET"], ["/v1/feed/delta", "GET"], ["/v1/feed/snapshot", "GET"]] as const) {
      const none = await call(path, {}, method);
      expect(none.status).toBe(401);
      expect((await none.json()).error).toBe("api_key_required");
      expect(none.headers.get("WWW-Authenticate")).toBe("Bearer");
      for (const key of ["lumi_fk_" + "0".repeat(48), "not-a-lumi-key"]) {
        const bad = await call(path, { Authorization: `Bearer ${key}` }, method);
        expect(bad.status).toBe(401);
        const j = await bad.json();
        expect(j.error).toBe("invalid_api_key");
        expect(j.note).toBe("Not charged.");
        expect(bad.headers.get("WWW-Authenticate")).toBe('Bearer error="invalid_token"');
      }
    }
  });
});
