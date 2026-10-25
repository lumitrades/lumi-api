import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { productSample } from "../src/samples";
import { staleRefusal } from "../src/x402";
import { nextSiteUpdate, metaFrom, isoTimestamps } from "../src/freshness";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret" };
const BASE = "http://lumi.test";
const FIELDS = ["as_of", "data_age_seconds", "next_update", "stale_after"];

function setup() {
  const fac = happyFacilitator();
  const app = createApp(ENV, { fetch: makeFetch(fac), log: () => {}, now: () => NOW });
  return { fac, get: (p: string, h: Record<string, string> = {}) => app.fetch(new Request(BASE + p, { headers: h })) };
}

describe("freshness metadata", () => {
  it("every paid response carries as_of, data_age_seconds, next_update, stale_after (ISO UTC)", async () => {
    const { get } = setup();
    for (const path of ["/v1/macro/yen", "/v1/market", "/v1/market", "/v1/market", "/v1/macro/yen", "/v1/events", "/v1/sentiment"]) {
      const q = await (await get(path)).json();
      const r = await get(path, { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts[0]) });
      expect(r.status, path).toBe(200);
      const j: any = await r.json();
      for (const f of FIELDS) expect(j, `${path} ${f}`).toHaveProperty(f);
      for (const f of ["as_of", "next_update", "stale_after"]) expect(j[f]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(typeof j.data_age_seconds).toBe("number");
      expect(Date.parse(j.next_update)).toBeLessThanOrEqual(Date.parse(j.stale_after));
      expect(Date.parse(j.as_of)).toBeLessThanOrEqual(NOW);
    }
  });

  it("metaFrom clamps next_update between now and stale_after", () => {
    const m = metaFrom(NOW - 3600_000, NOW + 600_000, NOW + 7200_000, NOW);
    expect(m.data_age_seconds).toBe(3600);
    expect(m.next_update).toBe(m.stale_after);
  });

  it("nextSiteUpdate lands ~25 min after a 6/12/18/23 America/Chicago run", () => {
    // NOW = 13:00Z = 08:00 CDT -> next is 12:00 CDT run, ~12:25 CDT = 17:25Z
    expect(new Date(nextSiteUpdate(NOW)).toISOString()).toBe("2026-10-22T17:25:00.000Z");
  });

  it("isoTimestamps normalises offsets to UTC Z and leaves markdown alone", () => {
    const out = isoTimestamps({ a: "2026-10-22T08:00:00-05:00", markdown: "2026-10-22T08:00:00-05:00", n: [{ t: "2026-10-22T13:00:00.000Z" }] }) as any;
    expect(out.a).toBe("2026-10-22T13:00:00Z");
    expect(out.markdown).toBe("2026-10-22T08:00:00-05:00");
    expect(out.n[0].t).toMatch(/^2026-10-22T13:00:00(\.000)?Z$/);
  });
});

describe("stale refusal", () => {
  it("refuses to charge once stale_after has passed (503, not charged)", async () => {
    expect(staleRefusal({ staleAfterMs: NOW + 1000 } as any, NOW)).toBeNull();
    const r = staleRefusal({ staleAfterMs: NOW - 1 } as any, NOW)!;
    expect(r.status).toBe(503);
    const j: any = await r.json();
    expect(j).toMatchObject({ error: "stale_data", settlementAttempted: false, retryable: true });
  });
});

describe("free samples hide trade outcomes", () => {
  it("GET /v1/samples never shows P/L or win/loss status", async () => {
    const { get } = setup();
    const j: any = await (await get("/v1/samples")).json();
    const s = JSON.stringify(j.products);
    expect(s).not.toMatch(/"(unrealized_pnl_pct|pnl_pct|mark_price)":|"status":"(win|loss|open|closed|stopped|target)/i);
  });
});
