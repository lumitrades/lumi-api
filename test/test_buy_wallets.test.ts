// Security review M4 (PROPOSED): published Lumi test-buy wallet list + verify step 4b.
import { describe, it, expect } from "vitest";
import { deriveKeypair, deriveAddress, generateSeed, sign } from "ripple-keypairs";
import { createApp } from "../src/app";
import { buildReceiptBody, receiptHash, receiptMessage, type PendingBuy, type Receipt } from "../src/trust/receipts";
import { isLumiTestBuyWallet, normaliseWallets } from "../src/trust/wallets";
import { utf8Hex } from "../src/trust/verify";
import { LUMI_WALLETS } from "../src/trust/evidence";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: "k".repeat(52) };
const kp = deriveKeypair(generateSeed({ entropy: new Uint8Array(16).fill(9) }));
const XADDR = deriveAddress(kp.publicKey);
const buy: PendingBuy = {
  kind: "vendor", ref: "example-vendor", endpoint: "https://seller.example/v1/data", domain: null, pay_to: null, ts: NOW - 3_600_000,
  network: "xrpl:0", tx_hash: "EF".repeat(32), amount: "0.006", asset: "RLUSD", http_status: 200, data_returned: true, latency_ms: 500, summary: "ok", source: "lumi_test_buy",
};
async function signed(): Promise<Receipt> {
  const body = buildReceiptBody(buy, { payer: XADDR, pay_to: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", ledger_result: "tesSUCCESS", ledger_index: 1 }, { issuedAt: new Date(NOW).toISOString() });
  const h = await receiptHash(body);
  const message = receiptMessage(buy.network, buy.tx_hash, h);
  return { ...body, receipt_hash: h, signer: { key_type: "ripple-keypairs", address: XADDR, public_key: kp.publicKey, message, signature: sign(utf8Hex(message), kp.privateKey) } };
}
const app = (env: Record<string, string> = {}) => createApp({ ...ENV, ...env } as any, { fetch: makeFetch(happyFacilitator()), now: () => NOW });
const verify = async (a: ReturnType<typeof app>, r: unknown) => (await a.fetch(new Request("https://x.test/v1/trust/receipts/verify", { method: "POST", body: JSON.stringify(r) }))).json() as Promise<any>;

describe("Lumi test-buy wallet list (M4, proposed)", () => {
  it("is served free at /v1/check/wallets and /.well-known/lumi-test-buy-wallets.json, with the configured buyers only", async () => {
    const a = app({ TRUST_BUYER_ADDRESSES: XADDR, TRUST_BUYER_EVM: LUMI_WALLETS.evm.join(",") });
    for (const p of ["/v1/check/wallets", "/.well-known/lumi-test-buy-wallets.json"]) {
      const r = await a.fetch(new Request("https://x.test" + p));
      expect(r.status).toBe(200);
      const j = await r.json() as any;
      expect(j.kind).toBe("lumi_test_buy_wallets");
      expect(j.status).toMatch(/PROPOSED/);
      expect(j.wallets["xrpl:0"]).toEqual([XADDR]);
      expect(j.wallets["eip155:8453"]).toEqual(LUMI_WALLETS.evm.map((x) => x.toLowerCase()));
      expect(j.wallets["stellar:pubnet"].length).toBe(1);
      expect(JSON.stringify(j)).not.toMatch(/seed|secret|private/i);
      expect(JSON.stringify(j)).not.toContain("/" + "workspace");
    }
  });

  it("matching: XRPL/Stellar exact, EVM case-insensitive, unknown network never", () => {
    const w = normaliseWallets({ xrpl: ["rA"], evm: ["0xAbC"], stellar: ["GX"] });
    expect(isLumiTestBuyWallet(w, "xrpl:0", "rA")).toBe(true);
    expect(isLumiTestBuyWallet(w, "xrpl:0", "ra")).toBe(false);
    expect(isLumiTestBuyWallet(w, "eip155:8453", "0xabc")).toBe(true);
    expect(isLumiTestBuyWallet(w, "stellar:pubnet", "GX")).toBe(true);
    expect(isLumiTestBuyWallet(w, "solana:x", "rA")).toBe(false);
    expect(isLumiTestBuyWallet(w, "xrpl:0", undefined)).toBe(false);
  });

  it("step 4b: a well-signed Lumi receipt from a wallet not on the list fails verification", async () => {
    const r = await signed();
    const off = await verify(app(), r); // default buyers do not include XADDR
    expect(off.hash_ok).toBe(true); expect(off.signature_ok).toBe(true);
    expect(off.ok).toBe(false);
    expect(off.errors).toContain("payer_not_lumi_test_buy_wallet");
    expect(off.payer_on_lumi_wallet_list).toBe(false);
    const on = await verify(app({ TRUST_BUYER_ADDRESSES: XADDR }), r);
    expect(on.ok).toBe(true);
    expect(on.payer_on_lumi_wallet_list).toBe(true);
  });

  it("the how-to lists step 4b and links the wallet list", async () => {
    const doc = await (await app().fetch(new Request("https://x.test/v1/trust/receipts/verify"))).json() as any;
    const s = doc.verify_yourself.join("\n");
    expect(s).toMatch(/^4b\. /m);
    expect(s).toContain("/.well-known/lumi-test-buy-wallets.json");
  });
});

describe("API security.txt (L1)", () => {
  it("serves RFC 9116 security.txt with the API canonical URL and no trading words", async () => {
    const r = await app().fetch(new Request("https://x.test/.well-known/security.txt"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/plain/);
    const t = await r.text();
    expect(t).toMatch(/^Contact: mailto:hello@lumitrades\.io$/m);
    expect(t).toMatch(/^Expires: 20\d\d-/m);
    expect(t).toContain("Canonical: https://api.lumitrades.io/.well-known/security.txt");
    expect(t).not.toMatch(/paper[- ]trading|dashboard|signal|trading/i);
  });
});
