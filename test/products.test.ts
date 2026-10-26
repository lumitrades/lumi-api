import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, type FakeFacilitator } from "./helpers";
import { yenRisk, fundingRead } from "../src/products";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PRIVATE_NAMES: "Canaryname" };
const BASE = "http://lumi.test";

function setup(opts: { override?: Record<string, unknown>; now?: number; fac?: FakeFacilitator } = {}) {
  const fac = opts.fac ?? happyFacilitator();
  const app = createApp(ENV, { fetch: makeFetch(fac, { override: opts.override }), log: () => {}, now: () => opts.now ?? NOW });
  const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(BASE + path, { headers }));
  return { get, fac };
}

describe("market-data feeds built on the retired site data (2026-10-25)", () => {
  it("/v1/market, /v1/macro/yen, /v1/sentiment, /v1/events, /v1/events/next48h, /v1/trades, /v1/slate and /v1/brief are gone (410, not quoted)", async () => {
    const fac = happyFacilitator();
    const { get } = setup({ fac });
    for (const p of ["/v1/market", "/v1/macro/yen", "/v1/sentiment", "/v1/events", "/v1/events/next48h", "/v1/trades", "/v1/slate", "/v1/brief", "/v1/brief?format=md"]) {
      const r = await get(p);
      expect(r.status, p).toBe(410);
      expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
      expect((await r.json()).note).toBe("Not charged.");
    }
    expect(fac.calls).toHaveLength(0);
  });

  it("stay 410 even when the site data is stale (never a 503 or a quote)", async () => {
    const { get } = setup({ now: NOW + 3 * 86_400_000 });
    for (const p of ["/v1/market", "/v1/macro/yen", "/v1/sentiment", "/v1/events", "/v1/events/next48h"]) expect((await get(p)).status, p).toBe(410);
  });
});

describe("rules", () => {
  it("yen risk levels", () => {
    const q = (price: number, change_pct: number) => ({ price, change_pct, change_5d_pct: 0 }) as any;
    expect(yenRisk(q(160, 0.1), q(60000, 0.5))!.level).toBe("low");
    expect(yenRisk(q(157, -0.6), q(60000, -2.6))!.level).toBe("watch");
    expect(yenRisk(q(154.9, 0), null)!.level).toBe("elevated");
    expect(yenRisk(q(158, -1.8), null)!.level).toBe("elevated");
    expect(yenRisk(null, null)).toBeNull();
  });
  it("funding read", () => {
    expect(fundingRead(0.005)).toMatch(/^near zero/);
    expect(fundingRead(0.01)).toMatch(/^positive/);
    expect(fundingRead(0.05)).toMatch(/^high positive/);
    expect(fundingRead(-0.02)).toMatch(/^negative/);
    expect(fundingRead(null)).toBeNull();
  });
});
