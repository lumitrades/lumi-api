import { describe, it, expect } from "vitest";
import { badgeDecision, badgeThresholds, BADGE_MIN_SCORE, BADGE_MIN_PAID_TESTS, DEFAULT_BADGE_THRESHOLDS } from "../src/trust/check";
import { createContributors, MemoryContributorStore, CHECK_CREDITS_PER_RECEIPT, CHECK_CREDIT_PRICES, CHECK_CREDIT_EXPIRY_DAYS } from "../src/trust/contributors";

const score = (value: number, paid: number, inconclusive = 0) =>
  ({ score: { value, confidence: "high", samples: { paid_test_buys: paid, delivered: paid, inconclusive_test_buys: inconclusive } }, last_conclusive: "delivered" as const });

describe("Tested-by-Lumi badge thresholds (approved: score >= 80 AND >= 3 conclusive paid test-buys)", () => {
  it("ships the approved defaults as constants", () => {
    expect(BADGE_MIN_SCORE).toBe(80);
    expect(BADGE_MIN_PAID_TESTS).toBe(3);
    expect(DEFAULT_BADGE_THRESHOLDS).toEqual({ minScore: 80, minPaidTests: 3 });
  });

  it("needs both the score and the paid test-buys", () => {
    expect(badgeDecision(score(80, 3)).earned).toBe(true);
    expect(badgeDecision(score(79.9, 50))).toMatchObject({ earned: false, reason: "score_below_threshold" });
    expect(badgeDecision(score(100, 2))).toMatchObject({ earned: false, reason: "too_few_lumi_test_buys" });
    // Inconclusive test-buys are paid but not conclusive: 4 paid - 2 inconclusive = 2 < 3.
    expect(badgeDecision(score(95, 4, 2))).toMatchObject({ earned: false, reason: "too_few_lumi_test_buys" });
    expect(badgeDecision(score(95, 5, 2)).earned).toBe(true);
  });

  it("is configurable, with out-of-range overrides falling back to the defaults", () => {
    expect(badgeThresholds({})).toEqual({ minScore: 80, minPaidTests: 3 });
    expect(badgeThresholds({ BADGE_MIN_SCORE: "90", BADGE_MIN_PAID_TESTS: "5" })).toEqual({ minScore: 90, minPaidTests: 5 });
    expect(badgeThresholds({ BADGE_MIN_SCORE: "0", BADGE_MIN_PAID_TESTS: "0" })).toEqual({ minScore: 80, minPaidTests: 3 });
    expect(badgeThresholds({ BADGE_MIN_SCORE: "abc", BADGE_MIN_PAID_TESTS: "2.5" })).toEqual({ minScore: 80, minPaidTests: 3 });
    const strict = badgeThresholds({ BADGE_MIN_SCORE: "90", BADGE_MIN_PAID_TESTS: "5" });
    expect(badgeDecision(score(85, 4), strict).earned).toBe(false);
    expect(badgeDecision(score(92, 5), strict).earned).toBe(true);
  });
});

const contrib = (o: { checkCreditsPerReceipt?: string; checkCreditPrices?: string } = {}) =>
  createContributors({ store: new MemoryContributorStore(), fetch: (async () => new Response("{}")) as any, now: () => 0, xrplRpc: [], baseRpc: "", self: { pay_to: [], domains: [] }, ...o });

describe("Lumi Check credits (approved: receipt earns 5, check costs 1, report costs 10)", () => {
  it("ships the approved amounts as defaults", () => {
    expect(CHECK_CREDITS_PER_RECEIPT).toBe(5);
    expect(CHECK_CREDIT_PRICES).toEqual({ trust_check: 1, vendor_report: 10 });
    expect(CHECK_CREDIT_EXPIRY_DAYS).toBe(90);
    expect(contrib().rules.check_credits).toEqual({ per_verified_receipt: 5, prices: { trust_check: 1, vendor_report: 10 }, expires_after_days: 90 });
  });

  it("the defaults cannot be mutated at runtime, but deployments can override them", () => {
    expect(Object.isFrozen(CHECK_CREDIT_PRICES)).toBe(true);
    const c = contrib({ checkCreditsPerReceipt: "7", checkCreditPrices: JSON.stringify({ vendor_report: 12 }) });
    expect(c.rules.check_credits).toMatchObject({ per_verified_receipt: 7, prices: { trust_check: 1, vendor_report: 12 } });
    // Garbage overrides keep the approved amounts.
    expect(contrib({ checkCreditsPerReceipt: "-1", checkCreditPrices: "{\"trust_check\":0}" }).rules.check_credits).toMatchObject({ per_verified_receipt: 5, prices: { trust_check: 1, vendor_report: 10 } });
  });
});

describe("contributor activity (approved: active = activity in the last 365 days; credits still expire after 90)", () => {
  it("exposes the approved windows", async () => {
    const { CONTRIB_ACTIVE_WINDOW_DAYS, CONTRIB_RETENTION_DAYS } = await import("../src/trust/contributors");
    expect(CONTRIB_ACTIVE_WINDOW_DAYS).toBe(365);
    expect(CONTRIB_RETENTION_DAYS).toBe(90);
    expect(contrib().rules).toMatchObject({ active_window_days: 365, retention_days: 90, check_credits: { expires_after_days: 90 } });
  });
});

describe("Lumi Check signing key: pinned public key, separate from the admin credential", () => {
  it("pins exactly one active key and its key_id matches the public key", async () => {
    const { LUMI_SIGNING_KEYS, trustedPublicKeys } = await import("../src/trust/lumi_keys");
    const { keyIdOf } = await import("../src/trust/lumi_sign");
    expect(LUMI_SIGNING_KEYS.filter((k) => k.status === "active")).toHaveLength(1);
    for (const k of LUMI_SIGNING_KEYS) {
      expect(k.public_key).toMatch(/^[0-9a-f]{64}$/);
      expect(k.key_id).toBe(await keyIdOf(k.public_key));
    }
    expect(trustedPublicKeys([{ key_id: "x", public_key: "AA", status: "retired", added: "2026-01-01" }])).toEqual([]);
  });

  it("refuses to sign and closes contributor admin when one secret is reused for both jobs", async () => {
    const { signingSecretSeparate } = await import("../src/trust/lumi_keys");
    const seed = "ab".repeat(32);
    expect(signingSecretSeparate({ LUMI_CHECK_SIGNING_KEY: seed, CONTRIB_ADMIN_KEY: "c".repeat(40) })).toBe(true);
    expect(signingSecretSeparate({ LUMI_CHECK_SIGNING_KEY: seed, CONTRIB_ADMIN_KEY: seed.toUpperCase() })).toBe(false);
    expect(signingSecretSeparate({ LUMI_CHECK_SIGNING_KEY: seed, OWNER_MCP_KEY: ` ${seed} ` })).toBe(false);
    const { createApp } = await import("../src/app");
    const app = createApp({ XRPL_NETWORK: "xrpl:1", PAY_TO: "rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM", FACILITATOR_URL: "https://f.test", DATA_BASE_URL: "https://d.test", INVOICE_SECRET: "s", LUMI_CHECK_SIGNING_KEY: seed, CONTRIB_ADMIN_KEY: seed } as any, { log: () => {} } as any);
    const keys: any = await (await app.fetch(new Request("https://api.test/v1/check/keys"))).json();
    expect(keys.status).toBe("signing_key_reused_as_admin_key");
    expect(keys.keys.every((k: any) => k.signing === false)).toBe(true);
    const admin = await app.fetch(new Request("https://api.test/v1/owner/contributors", { headers: { Authorization: `Bearer ${seed}` } }));
    expect(admin.status).toBe(401);
  });

  it("/v1/check/keys lists the pinned keys and flags a configured key that is not pinned", async () => {
    const { createApp } = await import("../src/app");
    const app = createApp({ XRPL_NETWORK: "xrpl:1", PAY_TO: "rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM", FACILITATOR_URL: "https://f.test", DATA_BASE_URL: "https://d.test", INVOICE_SECRET: "s", LUMI_CHECK_SIGNING_KEY: "cd".repeat(32) } as any, { log: () => {} } as any);
    const keys: any = await (await app.fetch(new Request("https://api.test/.well-known/lumi-keys.json"))).json();
    expect(keys.status).toBe("configured_key_not_pinned");
    expect(keys.keys[0]).toMatchObject({ signing: true, pinned: false });
    expect(keys.keys.some((k: any) => k.key_id === "lsk_5c8c2f54fd228547" && k.pinned && k.status === "active")).toBe(true);
  });
});
