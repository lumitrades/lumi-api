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
