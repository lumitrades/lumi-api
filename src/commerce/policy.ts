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

/** Test-buy pack terms (Re-test pack, Founder pack), returned in the purchase response and GET /v1/monitor/packs.
 *  Keep the numbers in sync with PLANS.retest_pack / PLANS.founder_pack / PACK_LIMITS (test/testbuy_packs.test.ts checks). */
export const PACK_TERMS = {
  version: "2026-10-25",
  terms: [
    "What you buy: a fixed number of test-buys (Re-test pack 30, Founder pack 24) for one exact price, paid once via x402. No auto-renew, no subscription.",
    "Each test-buy is one real paid call to one of your enrolled seller endpoints whose enrolled price is at most $0.10. Endpoints above $0.10 are refused before you pay.",
    "You choose when: the first re-test is queued when you buy; queue the rest with POST /v1/monitor/packs/use. At most one counted test-buy per endpoint per UTC day.",
    "Expiry: unused test-buys expire 12 months after purchase.",
    "Refunds: none, except that if Lumi stops selling test-buys, unused test-buys are refunded. A failed result on your endpoint is a delivered result and uses the test-buy. If Lumi cannot run a queued test-buy because of a fault on Lumi's side, the test-buy goes back to your pack.",
    "Fulfilment: during the pre-sale, queued test-buys are run by hand from Lumi's operator box (no guaranteed turnaround). Every result is dated, kept with a receipt signed by the paying wallet, and published on your seller page like any other result, failures included.",
    "Founder pack: first 10 sellers only, one place per company (enrolments sharing a payTo wallet or a domain count as one company), up to 12 purchases per company at $5 each.",
    "Founder places are checked twice: before you pay, and again atomically when the payment settles. If another seller takes the last place (or your company's 12th purchase settles first) while your payment is settling, your payment has gone through but no pack is added: the call answers 409 with the transaction hash. Nothing is refunded automatically; email the hash and the case is reviewed by hand (a refund or another credit is decided case by case).",
    "Paying never changes a score, tier or label, and Lumi's own baseline test-buys continue for every seller, paying or not.",
  ],
};

/** What happens to a Founder pack payment that loses the place race at settlement. Plain wording, shown in the 409 and the docs. */
export const FOUNDER_RACE_TEXT =
  "Your payment settled on-chain before the place could be confirmed, so it cannot be undone by Lumi's code. No pack, credit or test-buy was added. Nothing is refunded automatically: email the transaction hash to the contact address and the payment is reviewed by hand; whether it is refunded or turned into another credit is decided case by case.";

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
  cadence: { watch: "per endpoint: hourly quote checks, a weekly test-buy", legacy_watch_plus_terms: "Watch Plus and its founder offer are no longer sold (replaced by the test-buy packs on 2026-10-25); terms bought before then run to their end (quote checks every 30 min, a daily test-buy rotating across chains)", retest_pack: "30 test-buys queued by the seller (POST /v1/monitor/packs/use), one per endpoint per UTC day, valid 12 months", founder_pack: "24 test-buys queued by the seller, one per endpoint per UTC day, valid 12 months (first 10 sellers, one place per company)", watch_pro: "per endpoint: quote checks every 15 min, daily buys on up to 3 chains, limited by the test-buy budget, a monthly signed report", watch_free: "1 endpoint, a daily quote check, no test-buys", watch_plus_trial: "the 14-day Watch trial: quote checks every 30 min, Lumi-funded test-buys capped at $0.25 in total. On day 14 the trial ends: nothing is charged, checks and test-buys stop, the Monitored badge comes off, and history freezes read-only. It never converts to a paid plan.", legacy_monitor_terms: "Monitor and Monitor Plus are no longer sold (retired 2026-10-25); terms bought before then run to their end at their original cadence", audit: "one-off: every listed endpoint once (catalog listings for the payTo + endpoints the seller names)" },
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
