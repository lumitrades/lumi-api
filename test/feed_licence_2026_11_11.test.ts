import { describe, it, expect } from "vitest";
import { FEED_LICENSE } from "../src/commerce/policy";
import { PLANS, PLATFORM_LICENCE } from "../src/commerce/plans";
import {
  catalogView, catalogFreeView, feedEntryView, sourceMeta, classifySellerConfirmation,
  wellKnownListsResource, sellerWellKnownUrl, confirmationStatsFromRows,
  CDP_SOURCE, SEED_ONLY_SOURCES, X402LIST_ATTRIBUTION,
} from "../src/trust/catalog";

const NOW = Date.parse("2026-11-11T18:00:00-06:00");
const row = (source: string, extra: Record<string, unknown> = {}): any => ({
  id: 1, resource: "https://api.example.com/v1/q", domain: "api.example.com", reg_domain: "example.com",
  service_name: "Copied Name", description: "Copied directory blurb", method: "GET", price_usd: "0.02",
  networks: "eip155:8453", pay_tos: "0xabc", accepts: JSON.stringify([{ n: "eip155:8453", p: "0xabc" }]),
  calls_30d: 170794, payers_30d: 88, last_called_at: NOW, quality_at: NOW, last_seen: NOW,
  probe_ts: null, probe_valid: null, probe_price_usd: null, probe_pay_to_match: null,
  source, ...extra,
});
const confirmed = (source: string, extra: Record<string, unknown> = {}) => row(source, {
  probe_ts: NOW - 3_600_000, probe_valid: 1, probe_status: 402, probe_price_usd: "0.015", probe_pay_to_match: 1, ...extra,
});

describe("licence v2026-11-11 and feed field rules", () => {
  it("is version 2026-11-11, allows the $499 platform plan, and does not no-resale CC BY fields", () => {
    expect(FEED_LICENSE.version).toBe("2026-11-11");
    expect(FEED_LICENSE.replaces).toBe("2026-10-22");
    const text = FEED_LICENSE.terms.join("\n");
    expect(text).toMatch(/Platform licence \(quoted from \$499/);
    expect(text).toMatch(/\$1\.50/);
    expect(text).not.toMatch(/\$1\.5\b/);
    expect(text).toMatch(/no automatic renewal|no auto-renew/i);
    expect(text).toMatch(/not a "consumer report"|not a consumer reporting agency/);
    expect(text).toMatch(/Neither party will defend, indemnify/);
    expect(text).toMatch(/not subject to clause 3's no-resale rule/);
    expect(text).toMatch(/Data: x402-list\.com \(CC BY 4\.0\)/);
    expect(text).toMatch(/PayAI, thirdweb, 402index, Dexter and Saylor/);
    expect(text).toMatch(/Coinbase Bazaar quality fields are not Licensed Fields/);
    expect(text).toMatch(/never include: payer wallet addresses/);
    expect(text).toMatch(/seller-confirmed facts/);
    expect(text).toMatch(/cited source is the seller's endpoint/);
    expect(text).toMatch(/copied Coinbase or other-directory descriptions/);
    expect(PLANS.feed_credits.usd).toBe("1.50");
    expect(PLATFORM_LICENCE.from_usd).toBe("499");
    expect(PLATFORM_LICENCE.summary).toMatch(/non-binding target/);
  });

  it("catalog views drop copied descriptions and Coinbase quality fields", () => {
    const full = catalogView(row(CDP_SOURCE), [], undefined, NOW) as any;
    const free = catalogFreeView(row(CDP_SOURCE), [], NOW) as any;
    for (const v of [full, free]) {
      expect(v.bazaar_quality).toBeUndefined();
      expect(v.bazaar_calls_30d).toBeUndefined();
      expect(v.service_name).toBeUndefined();
      expect(v.description).toBeUndefined();
      expect(v.seller_confirmed).toBe(false);
      expect(v.source).toBe("unverified");
      expect(v.drop_reason).toBe("not_quote_checked");
      expect(v.discovery_seed).toBe("cdp_bazaar");
      expect(JSON.stringify(v)).not.toMatch(/170794|unique_payers|Copied Name|Copied directory blurb/);
    }
  });

  it("a seller-confirmed row cites the seller's endpoint and uses the probed price", () => {
    const v = catalogView(confirmed(CDP_SOURCE), [], undefined, NOW) as any;
    expect(v.seller_confirmed).toBe(true);
    expect(v.source).toBe("seller_endpoint");
    expect(v.confirmed_how).toBe("unpaid_402_probe");
    expect(v.confirmed_from).toBe("https://api.example.com/v1/q");
    expect(v.advertised_price_usd).toBe("0.015");
    expect(v.discovery_seed).toBe("cdp_bazaar");
    expect(v.service_name).toBeUndefined();
    expect(v.description).toBeUndefined();
  });

  it("seed-only directories drop copied metadata; confirmed x402-list rows keep CC BY credit", () => {
    expect(SEED_ONLY_SOURCES.has("ext:payai")).toBe(true);
    const seed = catalogView(row("ext:payai"), [], undefined, NOW) as any;
    expect(seed.discovery_seed).toBe("ext:payai");
    expect(seed.service_name).toBeUndefined();
    expect(seed.description).toBeUndefined();
    expect(seed.resource).toBe("https://api.example.com/v1/q");
    const listed = catalogView(confirmed("ext:x402list"), [], undefined, NOW) as any;
    expect(listed.source).toBe("seller_endpoint");
    expect(listed.source_licence).toBe("CC BY 4.0");
    expect(listed.source_attribution).toBe(X402LIST_ATTRIBUTION);
    expect(listed.no_resale_does_not_apply).toBe(true);
    expect(listed.service_name).toBeUndefined();
    expect(sourceMeta("ext:dexter").discovery_seed).toBe(true);
  });

  it("feedEntryView includes only confirmed rows, with activity, and never payer or income fields", () => {
    expect(feedEntryView(row(CDP_SOURCE), [], undefined, NOW)).toBeNull();
    expect(feedEntryView(row(CDP_SOURCE, { probe_ts: NOW - 3 * 86_400_000, probe_valid: 1 }), [], undefined, NOW)).toBeNull();
    const activity = { name: "observed_onchain_payments", shown: true, payer_groups_30d: "10–99", payments_30d: "100–999", as_of: new Date(NOW).toISOString() };
    const v = feedEntryView(confirmed(CDP_SOURCE), [], undefined, NOW, { activity }) as any;
    expect(v.source).toBe("seller_endpoint");
    expect(v.advertised_price_usd).toBe("0.015");
    expect(v.listed_price_usd).toBeUndefined();
    expect(v.observed_onchain_payments).toEqual(activity);
    expect(v.description).toBeUndefined();
    expect(JSON.stringify(v)).not.toMatch(/170794|organic_usd|sample_payer|Copied directory/);
  });

  it("classifies drop reasons and accepts a well-known confirmation", () => {
    const neverChecked = row(CDP_SOURCE);
    const invalid = row(CDP_SOURCE, { probe_ts: NOW - 1_000, probe_valid: 0 });
    const stale = row(CDP_SOURCE, { probe_ts: NOW - 3 * 86_400_000, probe_valid: 1 });
    const ok = confirmed(CDP_SOURCE);
    expect(classifySellerConfirmation(neverChecked, NOW).drop_reason).toBe("not_quote_checked");
    expect(classifySellerConfirmation(invalid, NOW).drop_reason).toBe("invalid_or_unreadable_402");
    expect(classifySellerConfirmation(stale, NOW).drop_reason).toBe("stale_confirmation");
    expect(classifySellerConfirmation(ok, NOW).confirmed).toBe(true);
    const wkUrl = sellerWellKnownUrl("https://api.example.com/v1/q");
    expect(wkUrl).toBe("https://api.example.com/.well-known/x402");
    const doc = { resources: [{ url: "https://api.example.com/v1/q", method: "GET" }] };
    expect(wellKnownListsResource(doc, "https://api.example.com/v1/q")).toBe(true);
    expect(wellKnownListsResource(doc, "https://other.example/v1/q")).toBe(false);
    const viaWk = classifySellerConfirmation(neverChecked, NOW, { listed: true, at: NOW - 1_000, url: wkUrl! });
    expect(viaWk).toMatchObject({ confirmed: true, how: "well_known_x402" });
    const stats = confirmationStatsFromRows([neverChecked, invalid, stale, ok], NOW);
    expect(stats).toEqual({
      total: 4, verified: 1, dropped: 3,
      reasons: { not_quote_checked: 1, invalid_or_unreadable_402: 1, stale_confirmation: 1 },
    });
  });
});
