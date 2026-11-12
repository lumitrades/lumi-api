import { describe, it, expect } from "vitest";
import { withPublicActivity, activityPublic, activityBand } from "../src/trust/activity";
import { VERDICT_DEFAULTS } from "../src/trust/verdict";

const NOW = Date.parse("2026-11-11T18:00:00-06:00");

describe("vendor lookup privacy overlay", () => {
  it("withPublicActivity drops payto_census and attaches the activity block", () => {
    const doc = {
      kind: "trust_lookup",
      payto_census: [{
        network: "xrpl:0", status: "ok", organic_payers: 482, organic_wallets: 500, organic_payments: 374848,
        excluded_payers: { lumi: 1 }, organic_usd: 12.5,
        top_clusters: [{ sample_payer: "rSecretPayer1111111111111111111", last_tx: "AB".repeat(32) }],
      }],
      catalog: { entries: [] },
    };
    const act = activityPublic({
      seller: "demo", domains: ["api.example.com"], pay_to: [], payers_30d: 40, payments_30d: 900,
      total_usd_30d: 1234.56, top_payer_share: 0.2, self_funded_share: 0.1,
      last_payment_at: NOW - 2 * 86_400_000, window_end: NOW - 86_400_000, source: null, fp: "x", kfp: "y", updated_at: NOW,
    }, NOW, VERDICT_DEFAULTS);
    const out = withPublicActivity(doc, act);
    expect(out.payto_census).toBeUndefined();
    expect(out.observed_onchain_payments).toMatchObject({
      shown: true,
      payer_groups_30d: "10–99",
      payments_30d: "100–999",
    });
    const blob = JSON.stringify(out);
    expect(blob).not.toMatch(/organic_payers|organic_payments|organic_usd|sample_payer|rSecretPayer|374848|1234\.56/);
    expect(activityBand(374848)).toBe("10k+");
  });

  it("withPublicActivity still omits census when there is no activity row", () => {
    const out = withPublicActivity({ payto_census: [{ organic_payers: 3 }], ok: true }, null);
    expect(out).toEqual({ ok: true, observed_onchain_payments: null });
    expect(out.payto_census).toBeUndefined();
  });
});
