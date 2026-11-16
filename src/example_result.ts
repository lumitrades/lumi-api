/**
 * Short, labelled sample results carried in the 402 body of the trust routes (2026-10-28), so a buyer sees what it
 * gets before paying. Real-shaped (same field names and real reason codes as the paid answer) but invented, on
 * placeholder example.com sellers, never a real seller's verdict. Body-only: not copied into the PAYMENT-REQUIRED
 * header, which must stay under the 8,400-char soft limit (test/payment_required_header_size.test.ts).
 */
import type { PaidRoute } from "./config";

export const EXAMPLE_RESULT_LABEL = "EXAMPLE only, not a real result";

const EXAMPLES: Partial<Record<PaidRoute, Record<string, unknown>>> = {
  high_value_check: {
    url: "https://api.example.com/v1/data",
    verdict: "warn",
    confidence: "medium",
    reasons: [{ code: "pay_to_unrecognised", severity: "warn" }],
    live: { outcome: "unchanged" },
  },
  verdict: {
    url: "https://api.example.com/v1/data",
    label: "checks_passed",
    reason_code: "delivered_recently",
    n_conclusive: 3,
  },
  batch_check: {
    results: [
      { url: "https://api.example.com/v1/data", label: "checks_passed" },
      { url: "https://data.example.org/v1/quote", label: "checks_failed", reason_code: "paid_no_data" },
    ],
  },
};

/** `{ label, result }` for a trust route's 402 quote, or undefined for routes without a verdict (reports, receipts, plans). */
export function exampleResultFor(route: PaidRoute): { label: string; result: Record<string, unknown> } | undefined {
  const r = EXAMPLES[route];
  return r ? { label: EXAMPLE_RESULT_LABEL, result: r } : undefined;
}
