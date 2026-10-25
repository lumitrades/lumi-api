import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { loadConfig, iouValue, RLUSD_CURRENCY, USDC_CURRENCY, MAINNET_PAY_TO } from "../src/config";
import { DATA, FACILITATOR, PAY_TO, happyFacilitator, makeFetch, paymentHeaderFor, decodeB64Json, type FakeFacilitator , NOW } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret" };
const TESTNET_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const MAINNET_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const USDC_MAINNET = "rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE";
const USDC_TESTNET = "rHuGNhqTG32mfmAvWA8hUyWRLV3tCSwKQt";
const BASE = "http://lumi.test";

function setup(env: Record<string, string> = {}, fac: FakeFacilitator = happyFacilitator()) {
  const logs: any[] = [];
  const app = createApp({ ...ENV, ...env }, { fetch: makeFetch(fac), log: (e) => logs.push(e), now: () => NOW });
  const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(BASE + path, { headers }));
  return { get, fac, logs };
}

describe("stablecoin config", () => {
  it("defaults to Ripple's / Circle's official issuers per network and USD-cent prices", () => {
    const main = loadConfig({ XRPL_NETWORK: "xrpl:0", INVOICE_SECRET: "x".repeat(32) });
    const cents = { signal: "0.01", levels: "0.01", slate: "0.02", market: "0.02", brief: "0.02", yen: "0.01", sentiment: "0.005", events: "0.005", institutional: "0.1", vendor_report: "0.02", scan: "0.02", lite: "0.004", trust_check: "0.02", funding: "0.003", fear_greed: "0.003", events_48h: "0.003", verdict: "0.01" };
    expect(main.ious).toEqual([
      { symbol: "RLUSD", currency: RLUSD_CURRENCY, issuer: MAINNET_ISSUER, prices: cents },
      { symbol: "USDC", currency: USDC_CURRENCY, issuer: USDC_MAINNET, prices: cents },
    ]);
    const test = loadConfig({ XRPL_NETWORK: "xrpl:1", PAY_TO: MAINNET_PAY_TO });
    expect(test.ious.map((o) => o.issuer)).toEqual([TESTNET_ISSUER, USDC_TESTNET]);
    expect(loadConfig({ XRPL_NETWORK: "xrpl:2", PAY_TO: MAINNET_PAY_TO }).ious).toEqual([]);
    expect(loadConfig({ XRPL_NETWORK: "xrpl:1", PAY_TO: MAINNET_PAY_TO, ACCEPT_RLUSD: "false" }).ious.map((o) => o.symbol)).toEqual(["USDC"]);
    expect(loadConfig({ XRPL_NETWORK: "xrpl:1", PAY_TO: MAINNET_PAY_TO, PRICE_SLATE_USDC: "0.03" }).ious[1].prices.slate).toBe("0.03");
    expect(() => loadConfig({ XRPL_NETWORK: "xrpl:1", PAY_TO: MAINNET_PAY_TO, USDC_ISSUER: "nope" })).toThrow(/USDC_ISSUER/);
    const hex = (t: string) => Buffer.from(t).toString("hex").toUpperCase().padEnd(40, "0");
    expect(RLUSD_CURRENCY).toBe(hex("RLUSD"));
    expect(USDC_CURRENCY).toBe(hex("USDC"));
  });

  it("validates IOU price strings", () => {
    expect(iouValue("0.010")).toBe("0.01");
    expect(iouValue("01.5")).toBe("1.5");
    expect(() => iouValue("0")).toThrow();
    expect(() => iouValue("-1")).toThrow();
    expect(() => iouValue("1e-3")).toThrow();
  });
});

describe("stablecoins in the 402", () => {
  it("offers XRP first, then RLUSD, then USDC, sharing one invoice", async () => {
    const { get } = setup();
    for (const [path, xrp, rl] of [["/v1/signal/XRP", "5000", "0.01"], ["/v1/levels/BTC", "5000", "0.01"], ["/v1/slate", "10000", "0.02"], ["/v1/market", "10000", "0.02"]]) {
      const r = await get(path);
      expect(r.status).toBe(402);
      const body = await r.json();
      expect(decodeB64Json(r.headers.get("PAYMENT-REQUIRED"))).toEqual(body);
      const [a, b, c] = body.accepts;
      expect(body.accepts).toHaveLength(3);
      expect(c).toMatchObject({ asset: USDC_CURRENCY, amount: rl, payTo: PAY_TO });
      expect(c.extra).toMatchObject({ issuer: USDC_TESTNET, symbol: "USDC", invoiceId: a.extra.invoiceId });
      expect(a).toMatchObject({ asset: "XRP", amount: xrp });
      expect(b).toMatchObject({ scheme: "exact", network: "xrpl:1", asset: RLUSD_CURRENCY, amount: rl, payTo: PAY_TO, maxTimeoutSeconds: 300 });
      expect(b.extra).toMatchObject({ issuer: TESTNET_ISSUER, symbol: "RLUSD", sourceTag: 5864, invoiceId: a.extra.invoiceId });
    }
  });

  it("can be switched off", async () => {
    const { get } = setup({ ACCEPT_RLUSD: "false", ACCEPT_USDC: "false" });
    expect((await (await get("/v1/slate")).json()).accepts).toHaveLength(1);
  });

  it("settles an RLUSD payment and labels the receipt", async () => {
    const { get, fac, logs } = setup();
    const req = (await (await get("/v1/slate")).json()).accepts[1];
    const r = await get("/v1/slate", { "PAYMENT-SIGNATURE": paymentHeaderFor(req) });
    expect(r.status).toBe(200);
    expect(fac.calls[0].body.paymentRequirements).toEqual(req);
    expect(fac.calls[1].body.paymentRequirements).toEqual(req);
    const body = await r.json();
    expect(body.payment).toMatchObject({ asset: "RLUSD", amount: "0.02", issuer: TESTNET_ISSUER });
    expect(logs[0]).toMatchObject({ event: "x402_settled", asset: "RLUSD", amount: "0.02" });
  });

  it("settles a USDC payment", async () => {
    const { get, fac } = setup();
    const req = (await (await get("/v1/signal/ETH")).json()).accepts[2];
    const r = await get("/v1/signal/ETH", { "PAYMENT-SIGNATURE": paymentHeaderFor(req) });
    expect(r.status).toBe(200);
    expect(fac.calls[1].body.paymentRequirements).toEqual(req);
    expect((await r.json()).payment).toMatchObject({ asset: "USDC", amount: "0.01", issuer: USDC_TESTNET });
  });

  it("rejects an RLUSD-priced option relabelled as USDC (issuer swap)", async () => {
    const { get } = setup();
    const [, rl, us] = (await (await get("/v1/slate")).json()).accepts;
    const r = await get("/v1/slate", { "PAYMENT-SIGNATURE": paymentHeaderFor({ ...rl, extra: { ...rl.extra, issuer: us.extra.issuer } }) });
    expect((await r.json()).error).toBe("payment_requirements_mismatch");
  });

  it("XRP receipts still carry drops", async () => {
    const { get } = setup();
    const req = (await (await get("/v1/slate")).json()).accepts[0];
    const body = await (await get("/v1/slate", { "PAYMENT-SIGNATURE": paymentHeaderFor(req) })).json();
    expect(body.payment).toMatchObject({ asset: "XRP", amount: "0.01", amount_drops: "10000" });
  });

  it("rejects a tampered RLUSD amount, issuer or currency, and refuses paying the same invoice twice in different assets", async () => {
    const { get, fac } = setup();
    const [x, req] = (await (await get("/v1/market")).json()).accepts;
    for (const bad of [
      { ...req, amount: "0.0001" },
      { ...req, extra: { ...req.extra, issuer: "rUJvhZ513MnBQVBcNap9NPJmKDWdKjyhC5" } },
      { ...req, asset: "USD" },
    ]) {
      const r = await get("/v1/market", { "PAYMENT-SIGNATURE": paymentHeaderFor(bad) });
      expect(r.status).toBe(402);
      expect((await r.json()).error).toBe("payment_requirements_mismatch");
    }
    expect(fac.calls).toHaveLength(0);
    expect((await get("/v1/market", { "PAYMENT-SIGNATURE": paymentHeaderFor(req) })).status).toBe(200);
    const again = await get("/v1/market", { "PAYMENT-SIGNATURE": paymentHeaderFor(x) });
    expect(again.status).toBe(402);
    expect((await again.json()).error).toBe("invoice_already_used");
  });

  it("invoices are bound to the RLUSD price too", async () => {
    const a = setup();
    const req = (await (await a.get("/v1/signal/XRP")).json()).accepts[1];
    const repriced = setup({ PRICE_SIGNAL_RLUSD: "0.05" });
    const r = await repriced.get("/v1/signal/XRP", { "PAYMENT-SIGNATURE": paymentHeaderFor(req) });
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe("invalid_invoice");
  });

  it("documents RLUSD in index, discovery, OpenAPI and skill.md", async () => {
    const { get } = setup();
    const index = await (await get("/")).json();
    expect(index.paid_endpoints.map((p: any) => p.price_rlusd)).toEqual(["0.01", "0.01", "0.02", "0.004", "0.02", "0.02", "0.02", "0.01", "0.005", "0.005", "0.003", "0.003", "0.003", "0.1", "0.02", "0.02", "0.01"]);
    expect(index.paid_endpoints.map((p: any) => p.price_usdc)).toEqual(["0.01", "0.01", "0.02", "0.004", "0.02", "0.02", "0.02", "0.01", "0.005", "0.005", "0.003", "0.003", "0.003", "0.1", "0.02", "0.02", "0.01"]);
    expect(index.payment.assets[1]).toMatchObject({ symbol: "RLUSD", issuer: TESTNET_ISSUER, accepts_index: 1 });
    expect(index.payment.assets[2]).toMatchObject({ symbol: "USDC", issuer: USDC_TESTNET, accepts_index: 2 });
    const wk = await (await get("/.well-known/x402")).json();
    expect(wk.resources[0].accepts[2]).toMatchObject({ asset: USDC_CURRENCY, asset_symbol: "USDC", issuer: USDC_TESTNET });
    expect(wk.resources[0].accepts[1]).toMatchObject({ asset: RLUSD_CURRENCY, asset_symbol: "RLUSD", issuer: TESTNET_ISSUER, amount: "0.01" });
    const oa = await (await get("/openapi.json")).json();
    expect(oa.paths["/v1/slate"].get["x-payment-info"].alternatives[0].price).toEqual({ mode: "fixed", currency: "RLUSD", amount: "0.02" });
    const skill = await (await get("/skill.md")).text();
    expect(skill).toContain("0.01 RLUSD");
    expect(skill).toContain("0.02 USDC");
    expect(skill).toContain(USDC_TESTNET);
    expect(skill).toContain("paymentRequirementsSelector");
    expect(skill).toContain(TESTNET_ISSUER);
  });
});
