import { describe, it, expect } from "vitest";
import { FEED_LICENSE } from "../src/commerce/policy";
import { PLANS, PLATFORM_LICENCE } from "../src/commerce/plans";
import { catalogView, catalogFreeView, sourceMeta, CDP_SOURCE, SEED_ONLY_SOURCES, X402LIST_ATTRIBUTION } from "../src/trust/catalog";

const NOW = Date.parse("2026-11-11T18:00:00-06:00");
const row = (source: string, extra: Record<string, unknown> = {}): any => ({
  id: 1, resource: "https://api.example.com/v1/q", domain: "api.example.com", reg_domain: "example.com",
  service_name: "Copied Name", description: "Copied directory blurb", method: "GET", price_usd: "0.02",
  networks: "eip155:8453", pay_tos: "0xabc", accepts: JSON.stringify([{ n: "eip155:8453", p: "0xabc" }]),
  calls_30d: 170794, payers_30d: 88, last_called_at: NOW, quality_at: NOW, last_seen: NOW,
  source, ...extra,
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
    expect(PLANS.feed_credits.usd).toBe("1.50");
    expect(PLATFORM_LICENCE.from_usd).toBe("499");
    expect(PLATFORM_LICENCE.summary).toMatch(/non-binding target/);
  });

  it("catalog views drop Coinbase quality fields and use the real source tag", () => {
    const full = catalogView(row(CDP_SOURCE), [], undefined, NOW) as any;
    const free = catalogFreeView(row(CDP_SOURCE), [], NOW) as any;
    for (const v of [full, free]) {
      expect(v.bazaar_quality).toBeUndefined();
      expect(v.bazaar_calls_30d).toBeUndefined();
      expect(v.source).toBe("cdp_bazaar");
      expect(v.source_licence).toBe("lumi_observations");
      expect(JSON.stringify(v)).not.toMatch(/170794|unique_payers/);
    }
    expect(full.description).toBe("Copied directory blurb");
  });

  it("seed-only directories drop copied metadata; x402-list is marked CC BY 4.0 with no no-resale", () => {
    expect(SEED_ONLY_SOURCES.has("ext:payai")).toBe(true);
    const seed = catalogView(row("ext:payai"), [], undefined, NOW) as any;
    expect(seed.discovery_seed).toBe(true);
    expect(seed.source_licence).toBe("seed_only");
    expect(seed.service_name).toBeUndefined();
    expect(seed.description).toBeUndefined();
    expect(seed.resource).toBe("https://api.example.com/v1/q");
    const listed = catalogView(row("ext:x402list"), [], undefined, NOW) as any;
    expect(listed.source_licence).toBe("CC BY 4.0");
    expect(listed.source_attribution).toBe(X402LIST_ATTRIBUTION);
    expect(listed.no_resale_does_not_apply).toBe(true);
    expect(listed.service_name).toBe("Copied Name");
    expect(sourceMeta("ext:dexter").discovery_seed).toBe(true);
  });
});
