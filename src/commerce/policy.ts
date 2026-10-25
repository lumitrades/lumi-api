/** Public policy text for seller monitoring and the licence feed (leaf module: no imports, safe to use from trust/). */

/** Final seller-monitoring terms (shown on GET /v1/monitor and the methodology). */
export const MONITOR_TERMS = {
  version: "2026-10-22",
  terms: [
    "Refunds: plans are not refundable once paid, except when Lumi cannot perform the monitoring it sold (for example it cannot reach or pay your endpoints because of a fault on Lumi's side). Then the unperformed part of the term is refunded.",
    "Audit reports: the full report is private to the seller and is only shown with the management token. Only its report_hash and Lumi's signature over it are public, so anyone can check a report the seller chooses to share.",
    "No warranty: monitoring results are dated observations (quote checks and test-buys), not a rating, endorsement, audit opinion or guarantee. They can be incomplete, delayed or wrong. Provided as is.",
    "Liability: to the extent permitted by law, Lumi is not liable for losses from decisions made using monitoring results, alerts or reports. Not financial advice.",
    "Terms: 30-day plans (Audit is one-off), no auto-renew; renewing means paying again. Changes to these terms are dated here.",
  ],
};

export const MONITOR_SAFEGUARDS = [
  "Paying never changes a score, tier or label. The scoring and catalog code does not read monitoring tables; a monitored seller is checked exactly like everyone else.",
  "Seller-funded test-buys are labelled funding: 'seller-funded' everywhere they appear; Lumi's own independent checks stay separate.",
  "Findings are append-only. A seller can reply to a finding (the reply is shown next to it) but cannot edit or remove it.",
  "The badge is computed live: it is removed automatically when the latest test fails, when no recent test exists, or when the plan lapses.",
  "Corrections Lumi makes to its own data are listed in a public correction log (GET /v1/monitor/corrections); nothing is removed silently.",
  "A paid plan is a commercial relationship and is disclosed on the seller's public entry (seller page, trust lookups and the licence feed).",
  "Plans are 30-day terms (Audit is one-off) with no auto-renew. Renewing means paying again; reminders go out 3 days before the end.",
  "Enrolment requires proof of control of the payTo (a signature from that wallet). Lumi never asks for keys or seeds.",
];

export const MONITOR_METHODOLOGY = {
  what: "Seller monitoring (opt-in, paid by the seller): Lumi buys the seller's own x402 endpoints on a schedule with a real payment and checks what comes back.",
  checks: [
    "paid_no_data / paid_invalid_data: payment settled but no data, an empty body or a non-JSON body where JSON was declared",
    "http_5xx / timeout: the paid retry failed with a server error or did not answer within 20 s",
    "pay_to_changed: the 402 quote pays a different address than the one the seller proved at enrolment",
    "price_changed: the quoted price moved more than 10% (USD-normalised) from the enrolled price",
    "schema_changed: the structure (keys and types) of the paid response changed",
    "recovered: a previously failing endpoint delivers again",
  ],
  cadence: { watch: "per endpoint: hourly quote checks, a weekly test-buy", watch_plus: "per endpoint: quote checks every 30 min, a daily test-buy rotating across the chains it accepts", watch_plus_founder: "same as Watch Plus (founder price for the first 10 sellers, kept for 12 terms; full Watch Plus test-buy budget)", watch_pro: "per endpoint: quote checks every 15 min, daily buys on up to 3 chains, limited by the test-buy budget, a monthly signed report", watch_free: "1 endpoint, a daily quote check, no test-buys", watch_plus_trial: "14 days of Watch Plus quote checks, Lumi-funded test-buys capped at $0.25 in total. On day 14 the trial ends: nothing is charged, checks and test-buys stop, the Monitored badge comes off, and history freezes read-only. It never converts to a paid plan.", legacy_monitor_terms: "Monitor and Monitor Plus are no longer sold (retired 2026-10-25); terms bought before then run to their end at their original cadence", audit: "one-off: every listed endpoint once (catalog listings for the payTo + endpoints the seller names)" },
  test_buy_cap: "Each test-buy is capped at $0.10 ($0.05 on Watch) and funded from the plan fee (the free trial is Lumi-funded, capped at $0.25 in total); planned test-buy spend must stay within 50% of the fee. Endpoints above the cap are rejected at enrolment (Audit: quote-checked only, no buy).",
  safeguards: MONITOR_SAFEGUARDS,
  terms: MONITOR_TERMS.terms,
};

export const FEED_LICENSE = {
  title: "Lumi Trades Trust Data Licence (feed)",
  version: "2026-10-22",
  terms: [
    "Licence: a non-exclusive, non-transferable right to query the Lumi trust feed and use the results inside your own product (for example a facilitator, wallet, agent framework or marketplace) to inform your users.",
    "No resale: you may not resell, sublicense, republish or redistribute the raw data or a substantial part of it as a dataset, feed or API. Showing individual results to your own users is allowed.",
    "Attribution: where results are shown to people, credit \"Trust data: Lumi (lumitrades.io)\". Third-party data keeps its own licence: vet402 observatory data is CC BY 4.0 and must be credited as given in its `attribution` field.",
    "Snapshots (Feed Pro): bulk exports are for your internal use and caching for the term of your licence; delete or stop refreshing them when the licence ends.",
    "No warranty: the data is a set of dated observations (quote checks and test-buys), not a rating, endorsement, audit opinion or guarantee. It can be incomplete, delayed or wrong. Provided as is.",
    "Liability: to the extent permitted by law, Lumi is not liable for losses from decisions made using the data. Not financial advice.",
    "Commercial relationships: sellers that pay Lumi for monitoring are flagged in the data (commercial_relationship). Paying never changes a score.",
    "Credits: metered credits are prepaid and never expire. They stay on your key until used.",
    "Refunds: payments are not refundable, except where Lumi cannot provide the service that was paid for; then the unprovided part is refunded.",
    "Keys: keep your key secret; Lumi stores only a hash and cannot show it again. Lumi may suspend keys used to abuse the service or breach these terms.",
    "Terms: 30-day plans, no auto-renew; renewing means paying again. Changes to these terms are dated on this page.",
  ],
};
