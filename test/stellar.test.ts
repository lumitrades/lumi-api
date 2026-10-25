import { describe, it, expect } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { createApp } from "../src/app";
import { loadConfig, STELLAR_NETWORKS } from "../src/config";
import { PaymentRequiredV2Schema } from "@x402/core/schemas";
import { lookupStellarUsdc, stellarPublicKey, verifyStellarSignature, STELLAR_USDC_ISSUER } from "../src/trust/verify";
import { verifyReceipt, receiptHash, receiptMessage, buildReceiptBody } from "../src/trust/receipts";
import { explorerFor } from "../src/trust/catalog";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, jsonResponse, makeFetch, decodeB64Json, type FakeFacilitator } from "./helpers";

const ST_PAY_TO = "GCKTH26VNR4H4WLCXS5DX6563XRQQXWP5QKQWFD6CHOGTZJ2N5GKBU2L";
const ST_FAC = "https://stellar-facilitator.test/x402";
const PUBNET_USDC = STELLAR_NETWORKS["stellar:pubnet"].asset;
const PAYER_G = "GAQGTEKEVKMR4XKX2ZM34ZHX7HLHNLEJ65V5HDQEDE7UC4NVHO5UIPAB";
const TX = "c".repeat(64);
const ENV = {
  XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret",
  STELLAR_PAY_TO: ST_PAY_TO, STELLAR_NETWORK: "stellar:pubnet", STELLAR_FACILITATOR_URL: ST_FAC, STELLAR_FACILITATOR_API_KEY: "test-key",
};
const BASE = "http://lumi.test";

function stFacilitator(over: Partial<FakeFacilitator> = {}): FakeFacilitator {
  return {
    calls: [],
    verify: () => jsonResponse(200, { isValid: true, payer: PAYER_G }),
    settle: (b) => jsonResponse(200, { success: true, transaction: TX, network: b.paymentRequirements.network, payer: PAYER_G }),
    ...over,
  };
}

function setup(opts: { st?: FakeFacilitator; env?: Record<string, unknown> } = {}) {
  const st = opts.st ?? stFacilitator();
  const xrpl = happyFacilitator();
  const base = makeFetch(xrpl);
  const auth: (string | null)[] = [];
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(ST_FAC)) {
      const path = url.slice(ST_FAC.length);
      const body = JSON.parse(String(init?.body ?? "{}"));
      st.calls.push({ path, body });
      auth.push(new Headers(init?.headers).get("Authorization"));
      return path === "/verify" ? st.verify(body) : st.settle(body);
    }
    return base(input, init);
  }) as typeof fetch;
  const logs: any[] = [];
  const app = createApp({ ...ENV, ...(opts.env ?? {}) } as any, { fetch: doFetch, log: (e) => logs.push(e), now: () => NOW });
  const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(BASE + path, { headers }));
  return { app, get, st, xrpl, logs, auth };
}

const header = (accepted: any, xdr = "AAAAAgAAAAB" + "A".repeat(80)) =>
  Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { transaction: xdr } })).toString("base64");
const stellarOf = (body: any) => body.accepts.find((a: any) => a.network === "stellar:pubnet");

describe("Stellar config", () => {
  it("is off without pay-to or API key, or with ACCEPT_STELLAR_USDC=false; same USD prices as Base USDC", () => {
    expect(loadConfig({ XRPL_NETWORK: "xrpl:1", PAY_TO }).stellar).toBeUndefined();
    expect(loadConfig({ XRPL_NETWORK: "xrpl:1", PAY_TO, STELLAR_PAY_TO: ST_PAY_TO }).stellar).toBeUndefined();
    expect(loadConfig({ ...ENV, ACCEPT_STELLAR_USDC: "false" } as any).stellar).toBeUndefined();
    const c = loadConfig({ ...ENV, EVM_PAY_TO: "0x5E617bac19912e6d212CB303ae84655E9E203532" } as any);
    expect(c.stellar).toMatchObject({ network: "stellar:pubnet", asset: PUBNET_USDC, payTo: ST_PAY_TO, decimals: 7, facilitatorUrl: ST_FAC });
    expect(c.stellar!.prices).toEqual(c.evm!.prices);
    const ev = c.evm!.amounts as Record<string, string>, sa = c.stellar!.amounts as Record<string, string>;
    for (const r of Object.keys(ev)) expect(sa[r]).toBe(String(Number(ev[r]) * 10));
    expect(() => loadConfig({ ...ENV, STELLAR_PAY_TO: "rNotStellar" } as any)).toThrow();
  });
});

describe("Stellar x402 option", () => {
  it("adds a stellar:pubnet USDC entry after the XRPL options, schema-valid", async () => {
    const { get } = setup();
    const r = await get("/v1/sentiment");
    expect(r.status).toBe(402);
    const body = await r.json();
    expect(decodeB64Json(r.headers.get("PAYMENT-REQUIRED"))).toEqual(body);
    expect(PaymentRequiredV2Schema.safeParse(body).success).toBe(true);
    const s = body.accepts[body.accepts.length - 1];
    expect(s).toEqual({
      scheme: "exact", network: "stellar:pubnet", amount: "50000", asset: PUBNET_USDC, payTo: ST_PAY_TO, maxTimeoutSeconds: 300,
      extra: { areFeesSponsored: true, invoiceId: body.accepts[0].extra.invoiceId, symbol: "USDC", decimals: 7 },
    });
  });

  it("verifies + settles through the facilitator with the Bearer key, serves data with a Stellar receipt", async () => {
    const { get, st, xrpl, logs, auth } = setup();
    const body = await (await get("/v1/sentiment")).json();
    const r = await get("/v1/sentiment", { "PAYMENT-SIGNATURE": header(stellarOf(body)) });
    expect(r.status).toBe(200);
    expect(xrpl.calls).toHaveLength(0);
    expect(st.calls.map((c) => c.path)).toEqual(["/verify", "/settle"]);
    expect(auth).toEqual(["Bearer test-key", "Bearer test-key"]);
    expect(st.calls[0].body.paymentRequirements).toEqual(stellarOf(body));
    expect(st.calls[0].body.paymentPayload.accepted).toEqual(stellarOf(body));
    const out = await r.json();
    expect(out.payment).toEqual({
      transaction: TX, network: "stellar:pubnet", payer: PAYER_G, asset: "USDC", amount: "0.005", amount_atomic: "50000",
      token: PUBNET_USDC, explorer: `https://stellar.expert/explorer/public/tx/${TX}`,
    });
    expect(r.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
    expect(logs.find((l) => l.event === "x402_settled")).toMatchObject({ network: "stellar:pubnet", facilitator: "openzeppelin" });
  });

  it("refuses a replayed header and the same signed transaction against a fresh invoice", async () => {
    const { get, st } = setup();
    const first = await (await get("/v1/market")).json();
    const h = header(stellarOf(first));
    expect((await get("/v1/market", { "PAYMENT-SIGNATURE": h })).status).toBe(200);
    const replay = await get("/v1/market", { "PAYMENT-SIGNATURE": h });
    expect(replay.status).toBe(402);
    expect((await replay.json()).error).toBe("invoice_already_used");
    const second = await (await get("/v1/market")).json();
    const again = await get("/v1/market", { "PAYMENT-SIGNATURE": header(stellarOf(second)) });
    expect(again.status).toBe(402);
    expect((await again.json()).error).toBe("authorization_already_used");
    expect(st.calls.filter((c) => c.path === "/settle")).toHaveLength(1);
  });

  it("rejects a tampered amount, maps facilitator failures (re-quote, 503, 409)", async () => {
    const { get, st } = setup();
    const body = await (await get("/v1/market")).json();
    const bad = await get("/v1/market", { "PAYMENT-SIGNATURE": header({ ...stellarOf(body), amount: "1" }) });
    expect(bad.status).toBe(402);
    expect(st.calls).toHaveLength(0);

    const inval = setup({ st: stFacilitator({ verify: () => jsonResponse(200, { isValid: false, invalidReason: "invalid_exact_stellar_payload_wrong_amount" }) }) });
    const b2 = await (await inval.get("/v1/market")).json();
    const r2 = await inval.get("/v1/market", { "PAYMENT-SIGNATURE": header(stellarOf(b2)) });
    expect(r2.status).toBe(402);
    expect((await r2.json()).error).toMatch(/^verify_failed:/);

    const down = setup({ st: stFacilitator({ verify: () => new Response("x", { status: 502 }) }) });
    const b3 = await (await down.get("/v1/market")).json();
    const r3 = await down.get("/v1/market", { "PAYMENT-SIGNATURE": header(stellarOf(b3)) });
    expect(r3.status).toBe(503);

    const unk = setup({ st: stFacilitator({ settle: () => new Response("x", { status: 500 }) }) });
    const b4 = await (await unk.get("/v1/market")).json();
    const r4 = await unk.get("/v1/market", { "PAYMENT-SIGNATURE": header(stellarOf(b4)) });
    expect(r4.status).toBe(409);
  });

  it("is absent when disabled, and the XRPL flow is unchanged", async () => {
    const off = setup({ env: { ACCEPT_STELLAR_USDC: "false" } });
    const body = await (await off.get("/v1/sentiment")).json();
    expect(body.accepts.some((a: any) => a.network.startsWith("stellar:"))).toBe(false);
    const on = await (await setup().get("/v1/sentiment")).json();
    const strip = (a: any) => ({ ...a, extra: { ...a.extra, invoiceId: "-" } });
    expect(on.accepts.slice(0, -1).map(strip)).toEqual(body.accepts.map(strip));
  });

  it("docs list Stellar: well-known x402, openapi, llms.txt, skill.md", async () => {
    const { get } = setup();
    const wk = await (await get("/.well-known/x402")).text();
    expect(wk).toContain("stellar:pubnet");
    expect(wk).toContain(ST_PAY_TO);
    expect(await (await get("/openapi.json")).text()).toContain("stellar:pubnet");
    expect(await (await get("/llms.txt")).text()).toContain("Stellar");
    expect(await (await get("/skill.md")).text()).toContain("Paying with USDC on Stellar");
  });
});

// ---------------------------------------------------------------- trust: ledger lookup + receipts

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function crc16(b: Uint8Array) { let c = 0; for (const x of b) { c ^= x << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c; }
function gAddress(pk: Uint8Array) {
  const body = new Uint8Array([6 << 3, ...pk]);
  const c = crc16(body);
  const raw = new Uint8Array([...body, c & 0xff, c >> 8]);
  let bits = 0, val = 0, out = "";
  for (const b of raw) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(val << (5 - bits)) & 31];
  return out;
}

describe("Stellar trust evidence", () => {
  it("verifies stellar-sdk ed25519 signatures (Keypair.sign) and StrKey checksums", () => {
    // Vector produced with @stellar/stellar-sdk Keypair.random().sign(Buffer.from(msg, "utf8")).
    const msg = "lumi-receipt:stellar:pubnet:abc:def";
    const sig = "yRR5Cm32FItHq73XegJnL+mZYlcmFEbzoG7y1pRdrV40X8GWi49lYvLPfIQ+vu2zClkRw+yDRLjBJs0LiVPCBw==";
    expect(verifyStellarSignature(msg, sig, PAYER_G)).toBe(true);
    expect(verifyStellarSignature(msg + "x", sig, PAYER_G)).toBe(false);
    expect(verifyStellarSignature(msg, sig, ST_PAY_TO)).toBe(false);
    expect(stellarPublicKey(PAYER_G.slice(0, -1) + "A")).toBeNull();
    expect(gAddress(stellarPublicKey(ST_PAY_TO)!)).toBe(ST_PAY_TO);
  });

  it("reads SEP-41 USDC transfers and classic USDC payments from Horizon", async () => {
    const f = (async (u: string) => {
      if (u.endsWith(`/transactions/${TX}`)) return jsonResponse(200, { successful: true, created_at: "2026-10-23T15:00:00Z" });
      if (u.includes(`/transactions/${TX}/operations`)) return jsonResponse(200, { _embedded: { records: [
        { type: "invoke_host_function", asset_balance_changes: [
          { type: "transfer", asset_code: "USDC", asset_issuer: STELLAR_USDC_ISSUER, from: PAYER_G, to: ST_PAY_TO, amount: "0.0050000" },
          { type: "transfer", asset_code: "USDC", asset_issuer: "GFAKEISSUER", from: PAYER_G, to: ST_PAY_TO, amount: "9.0" },
        ] },
        { type: "payment", asset_code: "USDC", asset_issuer: STELLAR_USDC_ISSUER, from: PAYER_G, to: ST_PAY_TO, amount: "0.0100000" },
      ] } });
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const l = await lookupStellarUsdc(f, "https://horizon.test", TX);
    expect(l.ok).toBe(true);
    expect(l.ok && l.payments).toEqual([
      { hash: TX, from: PAYER_G, to: ST_PAY_TO, amount: "0.005", asset: "USDC", ts: Date.parse("2026-10-23T15:00:00Z") },
      { hash: TX, from: PAYER_G, to: ST_PAY_TO, amount: "0.01", asset: "USDC", ts: Date.parse("2026-10-23T15:00:00Z") },
    ]);
    expect(await lookupStellarUsdc(f, "https://horizon.test", "d".repeat(64))).toEqual({ ok: false, reason: "tx_not_found" });
    expect(explorerFor("stellar:pubnet", TX)).toBe(`https://stellar.expert/explorer/public/tx/${TX}`);
  });

  it("signs and verifies a Stellar receipt (stellar-ed25519 key type)", async () => {
    const sk = ed25519.utils.randomPrivateKey();
    const payer = gAddress(ed25519.getPublicKey(sk));
    const body = buildReceiptBody(
      { tx_hash: TX, network: "stellar:pubnet", kind: "catalog", ref: "https://seller.test/x", endpoint: "https://seller.test/x", domain: "seller.test", amount: "0.001", asset: "USDC", pay_to: "GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL", ts: NOW, http_status: 200, data_returned: true, summary: "200 json" } as any,
      { payer, pay_to: "GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL", ledger_result: "successful" },
      { issuedAt: "2026-10-23T15:00:00Z" },
    );
    expect(body.receipt_id).toBe(`lumi-stellar-${TX}`);
    expect(body.payment.amount_atomic).toBe(10000);
    const hash = await receiptHash(body);
    const message = receiptMessage("stellar:pubnet", TX, hash);
    const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(message), sk)).toString("base64");
    const r = { ...body, receipt_hash: hash, signer: { key_type: "stellar-ed25519", address: payer, message, signature } };
    const c = await verifyReceipt(r);
    expect(c.errors).toEqual([]);
    expect(c.ok).toBe(true);
    const forged = await verifyReceipt({ ...r, signer: { ...r.signer, address: ST_PAY_TO } });
    expect(forged.ok).toBe(false);
  });
});
