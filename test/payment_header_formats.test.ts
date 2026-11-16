import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { parsePaymentHeader, paymentHeaderProblem } from "../src/payment_header";
import { DATA, NOW, FACILITATOR, PAY_TO, PAYER, makeFetch, happyFacilitator, jsonResponse, paymentHeaderFor, decodeB64Json } from "./helpers";
import { paymentRequiredHeaderPayload } from "../src/x402";

// 2026-10-28: Scout's refused-payment events (lumi-deploy-check v1 + junk, x402lint junk) showed v1 payloads refused as
// the misleading invalid_payment_signature_header and no hint of the expected format. These pin the accepted formats,
// the clear 402 `payment_help` block, and that a reformatted header is never a payment without verification.
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, OWNER_MCP_KEY: "owner-key-for-tests-0123456789abcdef", INVOICE_SECRET: "test-secret" };
const BASE = "http://lumi.test";
const ROUTE = "/v1/trust/check/high-value?url=https://api.example.com/x&amount=4";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function setup(fac = happyFacilitator()) {
  const app = createApp(ENV as any, { fetch: makeFetch(fac), log: () => {}, now: () => NOW });
  const get = (headers: Record<string, string> = {}) => app.fetch(new Request(BASE + ROUTE, { headers: { "User-Agent": "x402-fetch/0.6", ...headers } }));
  const quote = async () => decodeB64Json((await get()).headers.get("PAYMENT-REQUIRED")).accepts[0];
  return { app, get, quote, fac };
}

describe("payment header parsing", () => {
  const p = { x402Version: 2, accepted: { scheme: "exact", network: "xrpl:1" }, payload: { signedTxBlob: "12" } };
  it("classifies base64, unpadded base64url, raw JSON and junk", () => {
    expect(parsePaymentHeader(b64(p))).toMatchObject({ encoding: "base64", obj: p });
    expect(parsePaymentHeader(` ${b64(p)}\n`)).toMatchObject({ encoding: "base64", obj: p });
    const url = Buffer.from(JSON.stringify({ ...p, note: "??>>" })).toString("base64url");
    expect(url).toMatch(/[-_]/);
    expect(parsePaymentHeader(url)).toMatchObject({ encoding: "base64url" });
    expect(parsePaymentHeader(JSON.stringify(p))).toMatchObject({ encoding: "raw_json", obj: p });
    expect(parsePaymentHeader("%%%not-base64%%%")).toEqual({ encoding: "invalid", obj: null });
    expect(parsePaymentHeader(b64("just a string"))).toEqual({ encoding: "invalid", obj: null });
    expect(parsePaymentHeader("{not json")).toEqual({ encoding: "invalid", obj: null });
  });
  it("names the problem: not base64 / v1 / wrong version / missing accepted; none for a v2 payload", () => {
    expect(paymentHeaderProblem(b64(p))).toBeNull();
    expect(paymentHeaderProblem(b64url(p))).toBeNull();
    expect(paymentHeaderProblem(JSON.stringify(p))?.error).toBe("payment_header_not_base64");
    expect(paymentHeaderProblem("junk!")?.error).toBe("invalid_payment_signature_header");
    const v1 = paymentHeaderProblem(b64({ x402Version: 1, scheme: "exact", network: "base", payload: {} }));
    expect(v1?.error).toBe("invalid_x402_version");
    expect(v1?.problem).toMatch(/v1/);
    expect(paymentHeaderProblem(b64({ ...p, x402Version: 3 }))?.error).toBe("invalid_x402_version");
    expect(paymentHeaderProblem(b64({ x402Version: 2, payload: {} }))?.error).toBe("invalid_payment_signature_header");
  });
});

describe("402 refusals for unusable payment headers", () => {
  const cases: [string, (acc: any) => Record<string, string>, string, Record<string, unknown>][] = [
    ["raw JSON v2 in PAYMENT-SIGNATURE", (acc) => ({ "PAYMENT-SIGNATURE": JSON.stringify({ x402Version: 2, accepted: acc, payload: { signedTxBlob: "12000022", invoiceId: acc.extra.invoiceId } }) }), "payment_header_not_base64", { header: "PAYMENT-SIGNATURE", encoding: "raw_json", x402Version: 2 }],
    ["v1 payload in X-PAYMENT", () => ({ "X-PAYMENT": b64({ x402Version: 1, scheme: "exact", network: "base", payload: { signature: "0x" + "ab".repeat(65), authorization: {} } }) }), "invalid_x402_version", { header: "X-PAYMENT", encoding: "base64", x402Version: 1 }],
    ["junk in X-PAYMENT", () => ({ "X-PAYMENT": "%%%not-base64%%%" }), "invalid_payment_signature_header", { header: "X-PAYMENT", encoding: "invalid", x402Version: null }],
  ];
  for (const [name, headers, error, received] of cases) {
    it(`${name}: 402 + re-quote + payment_help (expected header, encoding, version, example); facilitator never called`, async () => {
      const { get, quote, fac } = setup();
      const acc = await quote();
      const r = await get(headers(acc));
      expect(r.status).toBe(402);
      const body = await r.json();
      expect(body.error).toBe(error);
      expect(body.accepts.length).toBeGreaterThan(0);
      expect(body.payment_help.received).toEqual(received);
      expect(body.payment_help.expected).toMatchObject({ header: "PAYMENT-SIGNATURE", x402Version: 2 });
      expect(body.payment_help.expected.also_read).toMatch(/X-PAYMENT/);
      expect(body.payment_help.expected.encoding).toMatch(/base64/);
      expect(body.payment_help.example.decoded).toMatchObject({ x402Version: 2 });
      expect(body.payment_help.note).toMatch(/Not charged/);
      // payment_help is body-only (header budget); the header still re-quotes accepts so an SDK can retry
      expect(decodeB64Json(r.headers.get("PAYMENT-REQUIRED"))).toEqual(paymentRequiredHeaderPayload(body));
      expect(fac.calls).toEqual([]);
    });
  }

  it("a plain quote (no payment header) carries no payment_help", async () => {
    const { get } = setup();
    expect((await (await get()).json()).payment_help).toBeUndefined();
  });
});

describe("valid v2 payloads are accepted under either header and either base64 alphabet, always verified", () => {
  for (const [name, mk] of [
    ["PAYMENT-SIGNATURE base64", (h: string) => ({ "PAYMENT-SIGNATURE": h })],
    ["X-PAYMENT base64", (h: string) => ({ "X-PAYMENT": h })],
    ["PAYMENT-SIGNATURE base64url unpadded", (h: string) => ({ "PAYMENT-SIGNATURE": Buffer.from(h, "base64").toString("base64url") })],
  ] as const) {
    it(`${name}: verify + settle, then 200`, async () => {
      const { get, quote, fac } = setup();
      const acc = await quote();
      const r = await get(mk(paymentHeaderFor(acc)));
      expect(r.status).toBe(200);
      expect(fac.calls.map((c) => c.path)).toEqual(["/verify", "/settle"]);
    });
  }

  it("an invalid signature is refused in every accepted format (never served, never settled)", async () => {
    for (const mk of [(h: string) => ({ "PAYMENT-SIGNATURE": h }), (h: string) => ({ "X-PAYMENT": h }), (h: string) => ({ "X-PAYMENT": Buffer.from(h, "base64").toString("base64url") })]) {
      const fac = happyFacilitator();
      fac.verify = () => jsonResponse(200, { isValid: false, invalidReason: "invalid_signature", payer: PAYER });
      const { get, quote } = setup(fac);
      const r = await get(mk(paymentHeaderFor(await quote())));
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).not.toBe(200);
      expect(fac.calls.map((c) => c.path)).toEqual(["/verify"]);
    }
  });

  it("raw JSON is never sent to the facilitator or served, even when the payload inside would verify", async () => {
    const { get, quote, fac } = setup();
    const acc = await quote();
    const raw = Buffer.from(paymentHeaderFor(acc), "base64").toString("utf8");
    const r = await get({ "PAYMENT-SIGNATURE": raw });
    expect(r.status).toBe(402);
    expect(fac.calls).toEqual([]);
  });
});
