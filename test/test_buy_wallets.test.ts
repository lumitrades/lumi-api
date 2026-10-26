// Security review M4: published Lumi test-buy wallet list + verify step 4b (fail closed, whatever issuer.name says).
import { describe, it, expect } from "vitest";
import { deriveKeypair, deriveAddress, generateSeed, sign } from "ripple-keypairs";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { ed25519 } from "@noble/curves/ed25519";
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

describe("Lumi test-buy wallet list (M4)", () => {
  it("is served free at /v1/check/wallets and /.well-known/lumi-test-buy-wallets.json, with the configured buyers only", async () => {
    const a = app({ TRUST_BUYER_ADDRESSES: XADDR, TRUST_BUYER_EVM: LUMI_WALLETS.evm.join(",") });
    for (const p of ["/v1/check/wallets", "/.well-known/lumi-test-buy-wallets.json"]) {
      const r = await a.fetch(new Request("https://x.test" + p));
      expect(r.status).toBe(200);
      const j = await r.json() as any;
      expect(j.kind).toBe("lumi_test_buy_wallets");
      expect(j.status).toBeUndefined();
      expect(JSON.stringify(j)).not.toMatch(/PROPOSED|security review/i);
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

// ---- M4 bypass regression: issuer.name is attacker-controlled; step 4b must not depend on it.
const evm = privateKeyToAccount(generatePrivateKey());
const stSk = ed25519.utils.randomPrivateKey();
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function crc16(b: Uint8Array) { let c = 0; for (const x of b) { c ^= x << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c; }
function gAddress(pk: Uint8Array) {
  const body = new Uint8Array([6 << 3, ...pk]); const c = crc16(body); const raw = new Uint8Array([...body, c & 0xff, c >> 8]);
  let bits = 0, val = 0, out = "";
  for (const b of raw) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(val << (5 - bits)) & 31];
  return out;
}
const STADDR = gAddress(ed25519.getPublicKey(stSk));
const ST_SELLER = "GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL";
type Net = "xrpl" | "base" | "stellar";
const PAYER: Record<Net, string> = { xrpl: XADDR, base: evm.address.toLowerCase(), stellar: STADDR };
const LIST_ENV: Record<Net, string> = { xrpl: "TRUST_BUYER_ADDRESSES", base: "TRUST_BUYER_EVM", stellar: "TRUST_BUYER_STELLAR" };

/** Build and sign a receipt end to end on `net`, as an attacker with their own wallet could, with any issuer.name. */
async function receiptOn(net: Net, issuerName?: unknown): Promise<any> {
  const b: PendingBuy = net === "xrpl" ? buy
    : net === "base" ? { ...buy, network: "eip155:8453", tx_hash: "0x" + "cd".repeat(32), amount: "0.01", asset: "USDC", pay_to: "0x" + "11".repeat(20) }
    : { ...buy, network: "stellar:pubnet", tx_hash: "ab".repeat(32), amount: "0.001", asset: "USDC", pay_to: ST_SELLER };
  const sellerPayTo = net === "xrpl" ? "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe" : b.pay_to!;
  const body: any = buildReceiptBody(b, { payer: PAYER[net], pay_to: sellerPayTo, ledger_result: net === "xrpl" ? "tesSUCCESS" : net === "base" ? "success" : "successful", ...(net === "xrpl" ? { ledger_index: 1 } : net === "base" ? { block_number: 5 } : {}) } as any, { issuedAt: new Date(NOW).toISOString() });
  if (issuerName === undefined) { /* keep "Lumi" */ } else if (issuerName === null) delete body.issuer; else body.issuer = { ...body.issuer, name: issuerName };
  const h = await receiptHash(body);
  const message = receiptMessage(b.network, b.tx_hash, h);
  const signer = net === "xrpl" ? { key_type: "ripple-keypairs", address: XADDR, public_key: kp.publicKey, message, signature: sign(utf8Hex(message), kp.privateKey) }
    : net === "base" ? { key_type: "eip191", address: evm.address, message, signature: await evm.signMessage({ message }) }
    : { key_type: "stellar-ed25519", address: STADDR, message, signature: Buffer.from(ed25519.sign(new TextEncoder().encode(message), stSk)).toString("base64") };
  return { ...body, receipt_hash: h, signer };
}

describe("step 4b fails closed (M4 bypass regression)", () => {
  const VARIANTS: unknown[] = ["Lumi", "Lumi Trades", "LUMI", "lumi", "Lumi ", " Lumi", "Lumi\u200b", "Lumı", "", "Someone Else", 42, null];
  for (const net of ["xrpl", "base", "stellar"] as Net[]) {
    it(`${net}: off-list payer fails for every issuer.name variant; signature and hash still check out`, async () => {
      for (const v of VARIANTS) {
        // Fresh app per call (the verify route is rate limited); default buyer lists never contain the test wallets.
        const res = await verify(app(), await receiptOn(net, v));
        expect(res.error, `${net} ${JSON.stringify(v)}`).toBeUndefined();
        expect(res.ok, `${net} ${JSON.stringify(v)}`).toBe(false);
        if (typeof v !== "string") continue; // malformed issuer: rejected earlier, also fine
        // A well-formed, correctly signed receipt: only step 4b stops it.
        expect(res.hash_ok, `${net} ${JSON.stringify(v)}`).toBe(true);
        expect(res.signature_ok, `${net} ${JSON.stringify(v)}`).toBe(true);
        expect(res.errors).toEqual(["payer_not_lumi_test_buy_wallet"]);
        expect(res.payer_on_lumi_wallet_list).toBe(false);
      }
    });
    it(`${net}: on-list payer verifies end to end`, async () => {
      const res = await verify(app({ [LIST_ENV[net]]: PAYER[net] }), await receiptOn(net));
      expect(res.errors).toEqual([]);
      expect(res.ok).toBe(true);
      expect(res.payer_on_lumi_wallet_list).toBe(true);
    });
  }
  it("base: list match is case-insensitive (checksummed payer on a lowercase list)", async () => {
    const r = await receiptOn("base");
    const res = await verify(app({ TRUST_BUYER_EVM: evm.address.toUpperCase().replace(/^0X/, "0x") }), r);
    expect(res.ok).toBe(true);
  });
  it("an on-list wallet on the wrong network does not pass", async () => {
    const res = await verify(app({ TRUST_BUYER_STELLAR: XADDR }), await receiptOn("xrpl"));
    expect(res.ok).toBe(false);
  });
  it("non-string payer or network is never on the list (no String() coercion)", async () => {
    const w = normaliseWallets({ xrpl: [XADDR], evm: [], stellar: [] });
    expect(isLumiTestBuyWallet(w, "xrpl:0", [XADDR] as any)).toBe(true); // helper alone coerces; the route guards it
    const r = await receiptOn("xrpl");
    for (const bad of [[XADDR], { toString: () => XADDR }, 1]) {
      const res = await verify(app({ TRUST_BUYER_ADDRESSES: XADDR }), { ...r, payment: { ...r.payment, payer: bad } });
      expect(res.ok).toBe(false);
      expect(res.payer_on_lumi_wallet_list).toBe(false);
    }
  });
  it("the how-to no longer keys step 4b on issuer.name", async () => {
    const doc = await (await app().fetch(new Request("https://x.test/v1/trust/receipts/verify"))).json() as any;
    const step = doc.verify_yourself.find((x: string) => x.startsWith("4b."));
    expect(step).not.toMatch(/issuer\.name\s*=|Lumi receipts only/);
    expect(step).toMatch(/Do not rely on issuer\.name/);
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
