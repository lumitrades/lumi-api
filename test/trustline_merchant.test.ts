import { describe, it, expect } from "vitest";
import { createApp, trustlineMerchantTxt } from "../src/app";
import { DATA, FACILITATOR, NOW, happyFacilitator, makeFetch } from "./helpers";

// Mainnet receiving wallet: the only wallet the t54 Trustline file may name.
const LUMI_XRPL = "rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM";
const ENV = { XRPL_NETWORK: "xrpl:0", PAY_TO: LUMI_XRPL, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret" };

describe("/.well-known/trustline-merchant.txt (t54 Trustline, unsigned)", () => {
  it("serves exactly one xrpl: line for Lumi's receiving wallet as text/plain", async () => {
    const app = createApp(ENV, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW });
    const r = await app.fetch(new Request("https://api.lumitrades.io/.well-known/trustline-merchant.txt"));
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toMatch(/^text\/plain/);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
    const body = await r.text();
    expect(body).toBe(`xrpl:${LUMI_XRPL}\n`);
    expect(body.trim().split("\n")).toHaveLength(1);
    // No other wallets (Base 0x…, Stellar G…), no email, no signature block.
    expect(body).not.toMatch(/0x[0-9a-f]{40}|\bG[A-Z2-7]{55}\b|@|BEGIN|signature/i);
  });
  it("helper output follows PAY_TO", () => {
    expect(trustlineMerchantTxt({ payTo: "rTEST" })).toBe("xrpl:rTEST\n");
  });
});
