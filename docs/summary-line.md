# `summary`: one plain-English line on every trust check (branch agent-summary-line-1028)

Every trust check answer now carries `summary` (a single line an AI agent can show its user word for word) and
`summary_facts` (the same facts, machine-readable). Both sit right after `kind` / `timestamp` / `source` and both are
inside the signed `lumi_receipt` payload, so the line can be verified like the verdict.

Where: free `GET /v1/trust/check`, paid `GET /v1/trust/check/high-value`, free `GET /v1/check` (signed payload),
remote MCP `lumi_trust_check` and the npm `lumi-trades-mcp` tool (summary is the first key), A2A `trust_check` (the text
starts with it). Code: `src/trust/summary.ts`; tests: `test/summary_line.test.ts`.

## Wording rules (enforced by tests)

- Facts only: test-buy count, delivered, did not deliver, inconclusive, last test-buy date (UTC), Lumi's check label.
- Bad results are stated as plainly as good ones; a failed label is always shown even when deliveries look good.
- Never "safe", "trusted", "verified", "guaranteed", "recommend", "should"; no instructions to agents; no hidden
  text; printable ASCII; one line. The only use of "guarantee" is the closing "Not a guarantee."
- No test-buys: "Lumi has not test-bought this listing yet." No record at all: says so, and that no record is not a
  negative finding.

## Examples

    Lumi test-bought this listing 10 times; 9 delivered, 1 did not deliver (last test-buy Oct 28, 2026). Lumi's check result: Delivered in recent checks. Not a guarantee.
    Lumi has not test-bought this listing yet. Its last free quote check (no payment) on Oct 27, 2026 got a valid x402 price quote. Lumi's check result: Not enough data. Not a guarantee.
    Lumi has no record of this seller: it is not in the x402 catalog Lumi reads and Lumi has not test-bought it. No record is not a negative finding.

## `summary_facts`

`{ scope: listing|seller|url|not_observed|lumi_itself, test_buys, delivered, not_delivered, inconclusive,
last_test_buy_at, window_days (curated sellers: 30; listings: null = all recorded test-buys), last_quote_check, label, version: "1" }`

Also: the full lookup's catalog entry now carries a `test_buys` aggregate over all recorded test-buys (its `purchases`
list stays the newest 5), the same shape as the free answer-only view.
