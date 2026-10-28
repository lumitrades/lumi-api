/**
 * Listing liveness probe (agenteconomy.report methodology 2026-10-28): one unpaid request per listed resource URL, verbatim,
 * no redirects; a 405 is retried as POST with an empty JSON body. Up = 402 (or 200 for a free resource); retired = 410 with a
 * past Sunset (leaves the denominator); anything else (400, 404, bare 410, 5xx) is down. These are the 12 resource URLs the
 * catalog lists for api.lumitrades.io on 2026-10-28, exactly as listed.
 */
import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch } from "./helpers";

const BASE = "https://api.lumitrades.io";
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PUBLIC_BASE_URL: BASE };

const PROBE_DAY = Date.parse("2026-10-28T12:00:00Z"); // the day the catalog listing was read
const LISTED: [string, "paid" | "free" | "retired"][] = [
  ["/v1/signal/:coin", "retired"],
  ["/v1/levels/:coin", "retired"],
  ["/v1/trust/vendors/:id/report", "paid"],
  ["/v1/trust/check", "free"],
  ["/v1/lite/:coin", "retired"],
  ["/v1/check/batch", "paid"],
  ["/v1/trust/receipts", "paid"],
  ["/v1/verdict", "paid"],
  ["/v1/feed/credits", "paid"],
  ["/v1/monitor/subscribe/founder_pack", "paid"],
  ["/v1/monitor/subscribe/retest_pack", "paid"],
  ["/v1/monitor/subscribe/watch", "paid"],
];

function setup() {
  const fac = { calls: [] as string[] };
  const base = makeFetch(happyFacilitator());
  const doFetch = (async (input: any, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    if (u.startsWith(FACILITATOR)) fac.calls.push(u);
    return base(input, init);
  }) as typeof fetch;
  const app = createApp(ENV as any, { fetch: doFetch, log: () => {}, now: () => NOW });
  const probe = async (p: string) => {
    let r = await app.fetch(new Request(BASE + p, { redirect: "manual", headers: { "CF-Connecting-IP": "198.51.100.9" } }));
    if (r.status === 405) r = await app.fetch(new Request(BASE + p, { method: "POST", body: "{}", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.9" } }));
    return r;
  };
  return { probe, fac, app };
}

function classify(r: Response, kind: "paid" | "free" | "retired"): "up" | "retired" | "down" {
  if (r.status === 402) return "up";
  if (r.status === 200 && kind === "free") return "up";
  if (r.status === 410) {
    const s = Date.parse(r.headers.get("Sunset") ?? "");
    return Number.isFinite(s) && s < PROBE_DAY ? "retired" : "down";
  }
  return "down";
}

describe("listing liveness probe on every listed resource URL", () => {
  it("every listed URL is up (402 / free 200) or retired (410 + past Sunset); none is down", async () => {
    const { probe, fac } = setup();
    const out: Record<string, string> = {};
    for (const [p, kind] of LISTED) {
      const r = await probe(p);
      out[p] = `${r.status} ${classify(r, kind)}`;
      expect(classify(r, kind), `${p} -> ${r.status}`).toBe(kind === "retired" ? "retired" : "up");
      if (r.status === 402) expect(r.headers.get("PAYMENT-REQUIRED"), p).toBeTruthy();
    }
    const counted = Object.values(out).filter((v) => !v.endsWith("retired"));
    expect(counted.every((v) => v.endsWith(" up"))).toBe(true);
    expect(counted).toHaveLength(9);
    expect(fac.calls).toHaveLength(0);
  });

  it("the listed :id report template is quoted like {id}: same rails and prices, a note to fill the placeholder, payment refused", async () => {
    const { probe, app } = setup();
    const a = await (await probe("/v1/trust/vendors/:id/report")).json();
    const b = await (await probe("/v1/trust/vendors/%7Bid%7D/report")).json();
    const strip = (x: any[]) => x.map((y) => ({ network: y.network, asset: y.asset, amount: y.amount, payTo: y.payTo }));
    expect(strip(a.accepts)).toEqual(strip(b.accepts));
    expect(a.note).toMatch(/Replace :id .*refused and not charged/);
    const paid = await app.fetch(new Request(BASE + "/v1/trust/vendors/:id/report", { headers: { "PAYMENT-SIGNATURE": "junk" } }));
    expect(paid.status).toBe(400);
    expect((await paid.json()).error).toBe("path_template_not_filled");
  });

  it("bare /v1/trust/check is a free 200 usage document, never counted against the free quota", async () => {
    const { probe } = setup();
    for (let i = 0; i < 105; i++) {
      const r = await probe("/v1/trust/check");
      expect(r.status).toBe(200);
      expect(r.headers.get("RateLimit-Remaining")).toBeNull();
      if (i === 0) {
        const j = await r.json();
        expect(j).toMatchObject({ kind: "usage", route: "trust_check", access: "free", counted: false });
        expect(j.example).toContain("/v1/trust/check?url=");
        expect(j.verdict).toBeUndefined();
      }
    }
  });
});
