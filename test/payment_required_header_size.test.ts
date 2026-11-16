import { describe, it, expect } from "vitest";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { isPaymentRequired, parsePaymentRequired, PaymentRequiredV2Schema } from "@x402/core/schemas";
import { createApp } from "../src/app";
import { PAID_ENDPOINTS } from "../src/catalog";
import { EXAMPLE_VENDOR_ID } from "../src/config";
import {
  PAYMENT_REQUIRED_HEADER_SOFT_LIMIT,
  paymentRequiredHeaderPayload,
} from "../src/x402";
import { MemoryTrustStore } from "../src/trust/store";
import { SEED_OBSERVATIONS } from "../src/trust/seed";
import { seededStores } from "./stage_c_fixtures";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, decodeB64Json } from "./helpers";

const EVM_PAY_TO = "0x5E617bac19912e6d212CB303ae84655E9E203532";
const ST_PAY_TO = "GCKTH26VNR4H4WLCXS5DX6563XRQQXWP5QKQWFD6CHOGTZJ2N5GKBU2L";
const PUBLIC = "https://api.lumitrades.io";
const ENV = {
  XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret",
  EVM_PAY_TO, EVM_NETWORK: "eip155:8453", EVM_FACILITATOR_URL: "https://evm-fac.test", EVM_CDP_ONLY_ROUTES: "none",
  STELLAR_PAY_TO: ST_PAY_TO, STELLAR_NETWORK: "stellar:pubnet", STELLAR_FACILITATOR_URL: "https://st-fac.test",
  STELLAR_FACILITATOR_API_KEY: "test-key",
  PUBLIC_BASE_URL: PUBLIC,
};
const BASE = "http://lumi.test";
const LONG_URL = "https://api.verylong-seller-example.com/" + "a".repeat(200 - "https://api.verylong-seller-example.com/".length);

function app() {
  return createApp(ENV as any, {
    fetch: makeFetch(happyFacilitator()),
    log: () => {},
    now: () => NOW,
    ...seededStores(NOW),
    trustStore: new MemoryTrustStore(SEED_OBSERVATIONS),
  });
}

const get = (a: ReturnType<typeof app>, path: string, headers: Record<string, string> = {}) =>
  a.fetch(new Request(BASE + path, { headers }));

function worstCasePaths(): { name: string; path: string }[] {
  const enc = encodeURIComponent(LONG_URL);
  const enc2 = encodeURIComponent(LONG_URL.replace("api.", "data."));
  return [
    { name: "high-value amount=10 long url", path: `/v1/trust/check/high-value?url=${enc}&amount=10` },
    { name: "high-value amount=100 long url", path: `/v1/trust/check/high-value?url=${enc}&amount=100` },
    { name: "high-value amount=10000 long url", path: `/v1/trust/check/high-value?url=${enc}&amount=10000` },
    { name: "verdict long url", path: `/v1/verdict?url=${enc}` },
    { name: "batch-check two long urls", path: `/v1/check/batch?urls=${enc},${enc2}` },
    { name: "receipts long seller", path: `/v1/trust/receipts?seller=${enc}` },
    { name: "receipts probe", path: `/v1/trust/receipts` },
    { name: "high-value probe", path: `/v1/trust/check/high-value` },
    { name: "verdict probe", path: `/v1/verdict` },
    { name: "vendor report", path: `/v1/trust/vendors/${EXAMPLE_VENDOR_ID}/report` },
    { name: "heurist vendor report", path: `/v1/trust/vendors/heurist-mesh/report` },
    ...PAID_ENDPOINTS.map((e) => ({
      name: `catalog ${e.route}`,
      path: e.route === "vendor_report" ? `/v1/trust/vendors/heurist-mesh/report` : e.route === "receipts" ? e.path : e.example,
    })),
  ];
}

describe("PAYMENT-REQUIRED header size", () => {
  it("stays under 8,400 chars for a 200-char url at amount=10 and larger, on every paid route", async () => {
    expect(LONG_URL.length).toBe(200);
    const a = app();
    const sizes: Record<string, number> = {};
    let quoted = 0;
    for (const { name, path } of worstCasePaths()) {
      const r = await get(a, path);
      const h = r.headers.get("PAYMENT-REQUIRED");
      if (r.status !== 402) {
        expect(h, `${name} ${r.status}`).toBeNull();
        continue;
      }
      quoted++;
      expect(h, name).toBeTruthy();
      sizes[name] = h!.length;
      expect(h!.length, `${name} header ${h!.length}`).toBeLessThan(PAYMENT_REQUIRED_HEADER_SOFT_LIMIT);
      const body = await r.json() as Record<string, unknown>;
      const hdr = decodeB64Json(h) as Record<string, unknown>;
      expect(hdr).toEqual(paymentRequiredHeaderPayload(body));
      // x402 v2 clients can parse the header
      expect(() => decodePaymentRequiredHeader(h!)).not.toThrow();
      const decoded = decodePaymentRequiredHeader(h!);
      expect(decoded.x402Version).toBe(2);
      expect(Array.isArray(decoded.accepts) && decoded.accepts.length).toBeGreaterThanOrEqual(5);
      expect(isPaymentRequired(hdr)).toBe(true);
      expect(parsePaymentRequired(hdr).success).toBe(true);
      expect(PaymentRequiredV2Schema.safeParse(hdr).success).toBe(true);
      // Body still carries Lumi extras and every payment option / how_to_pay / prices
      const accepts = body.accepts as any[];
      expect(accepts.some((x) => String(x.network).startsWith("eip155:"))).toBe(true);
      expect(accepts.some((x) => String(x.network).startsWith("xrpl:"))).toBe(true);
      expect(accepts.some((x) => String(x.network).startsWith("stellar:"))).toBe(true);
      expect(body.how_to_pay).toBeTruthy();
      expect(hdr.how_to_pay).toBe(body.how_to_pay);
      for (const k of ["example_result", "samples", "note", "trial", "trial_key", "first_check_refund", "payment_help"] as const) {
        expect(hdr[k], `${name} ${k} in header`).toBeUndefined();
      }
    }
    expect(quoted).toBeGreaterThanOrEqual(8);
    // high-value worst cases must have been quoted (not skipped)
    expect(sizes["high-value amount=10 long url"]).toBeGreaterThan(0);
    expect(sizes["verdict long url"]).toBeGreaterThan(0);
  });

  it("a trial-opt-in 402 with the SIWX extension also stays under the soft limit", async () => {
    const a = app();
    const path = `/v1/trust/check/high-value?url=${encodeURIComponent(LONG_URL)}&amount=10`;
    const r = await get(a, path, { "X-Lumi-Trial": "1" });
    expect(r.status).toBe(402);
    const h = r.headers.get("PAYMENT-REQUIRED")!;
    expect(h.length).toBeLessThan(PAYMENT_REQUIRED_HEADER_SOFT_LIMIT);
    const body = await r.json() as any;
    const hdr = decodeB64Json(h);
    expect(hdr).toEqual(paymentRequiredHeaderPayload(body));
    expect(hdr.extensions["sign-in-with-x"].info).toBeTruthy();
    expect(hdr.extensions["sign-in-with-x"].supportedChains).toBeTruthy();
    expect(hdr.extensions["sign-in-with-x"].lumi_trial).toBeUndefined();
    expect(hdr.extensions["sign-in-with-x"].schema).toBeUndefined();
    expect(hdr.extensions.bazaar).toBeUndefined();
    expect(body.extensions["sign-in-with-x"].lumi_trial).toBeTruthy();
    expect(body.extensions.bazaar).toBeTruthy();
    expect(isPaymentRequired(hdr)).toBe(true);
    expect(() => decodePaymentRequiredHeader(h)).not.toThrow();
  });
});
