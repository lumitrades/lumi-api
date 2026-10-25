import { describe, expect, it } from "vitest";
import { BAZAAR_MAX_DESCRIPTION, BAZAAR_ROUTES, ROUTE_TAGS, SERVICE_NAME, bazaarExtension, errorDocs, routeHeadline, serviceNameFor } from "../src/bazaar";
import type { PaidRoute } from "../src/config";

const ROUTES = Object.keys(BAZAAR_ROUTES) as PaidRoute[];
const FORBIDDEN_IDEAS = /price[- ]target|\btargets?\b|\bentry\b|entry zone|\bstop\b|leverage|strong buy|strong sell|\bbull|\bbear\b|buy\/sell/i;
const HYPE = /\b(best|guaranteed|moon|alpha|profit|huge|revolutionary|ultimate|unbeatable|explosive)\b/i;

describe("Bazaar listing copy (owner-approved cleanup 2026-10-25)", () => {
  it("one brand name, Use-when lead, <= 500 chars, disclaimer last, no banned words", () => {
    for (const r of ROUTES) {
      const d = BAZAAR_ROUTES[r].description;
      expect(serviceNameFor(r), r).toBe("Lumi Trades");
      expect(SERVICE_NAME).toBe("Lumi Trades");
      expect(d, r).toMatch(/^Use when /);
      expect(d.length, r).toBeLessThanOrEqual(BAZAAR_MAX_DESCRIPTION);
      expect(d, r).toMatch(/(not financial advice|not a guarantee|not a rating|Lumi does not trade real money)\.$/);
      expect(d, r).not.toMatch(/solana|scam/i);
      expect(d, r).not.toMatch(HYPE);
      expect(d, r).not.toMatch(/Lumi Market Ideas|Lumi Trust\b/);
      for (const t of ROUTE_TAGS[r]) expect(t, r).not.toMatch(/solana|signals|trade-ideas/i);
    }
  });

  it("slate, signal and levels listing copy has no targets, entries, stops, leverage, buy/sell ratings or scenarios", () => {
    for (const r of ["slate", "signal", "levels"] as PaidRoute[]) {
      expect(BAZAAR_ROUTES[r].description, r).not.toMatch(FORBIDDEN_IDEAS);
      expect(routeHeadline(r), r).not.toMatch(FORBIDDEN_IDEAS);
      expect(JSON.stringify(BAZAAR_ROUTES[r].example), r).not.toMatch(/entry_zone|"stop"|"targets"|"leverage"|Strong (Buy|Sell)|scenarios|projection|"bull"|"bear"/);
    }
  });

  it("trust listings lead with check-before-paying terms", () => {
    for (const r of ["trust_check", "verdict"] as PaidRoute[]) {
      expect(BAZAAR_ROUTES[r].description, r).toMatch(/before paying/);
      expect(ROUTE_TAGS[r], r).toContain("check-before-paying");
      expect(ROUTE_TAGS[r], r).toContain("pre-payment-check");
    }
    expect(BAZAAR_ROUTES.vendor_report.description).toMatch(/seller reputation/);
  });

  it("documents 400/402/404/429/5xx error responses per route", () => {
    for (const r of ROUTES) {
      const st = errorDocs(r).map((e) => e.status);
      for (const s of [402, 409, 429, 500, 502, 503]) expect(st, r).toContain(s);
      const out = (bazaarExtension(r, r === "vendor_report" ? "x" : "XRP").schema as any).properties.output;
      expect(out.description, r).toMatch(/^Errors: /);
    }
    expect(errorDocs("signal").map((e) => e.status)).toEqual(expect.arrayContaining([400, 404]));
    expect(errorDocs("vendor_report").map((e) => e.status)).toEqual(expect.arrayContaining([400, 404]));
    expect(errorDocs("trust_check").map((e) => e.status)).toContain(400);
    expect(errorDocs("verdict").map((e) => e.status)).toContain(400);
  });
});
