# XRPL DestinationTag per product (internal routing table)

Lumi's own XRPL x402 quotes (accepts on `xrpl:0` for XRP, RLUSD and USDC) can carry `extra.destinationTag` instead of
Lumi's old `extra.sourceTag` 5864. The buyer's Payment then has that DestinationTag, so every settlement into Lumi's payTo
(`rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM` on mainnet) says which product it paid for. Sales are keyed on
**payTo + DestinationTag**. The t54 facilitator rejects a payment whose DestinationTag differs (`destination_tag_mismatch`).

Source of truth: `src/xrpl_destination_tags.ts`. The product is the Quote.routeKey prefix (before the first `:`).
Tags are permanent once used on mainnet: never renumber or reuse, only append.

| Tag  | Product (routeKey prefix) | Route |
|------|---------------------------|-------|
| 1001 | vendor_report      | GET /v1/trust/vendors/{id}/report |
| 1002 | high_value_check   | GET /v1/trust/check/high-value |
| 1003 | verdict            | GET /v1/verdict |
| 1004 | receipts           | GET /v1/trust/receipts |
| 1005 | batch_check        | GET /v1/check/batch |
| 2001 | monitor            | /v1/monitor/subscribe/monitor (retired) |
| 2002 | monitor_plus       | /v1/monitor/subscribe/monitor_plus (retired) |
| 2003 | watch              | /v1/monitor/subscribe/watch |
| 2004 | watch_plus         | /v1/monitor/subscribe/watch_plus (retired) |
| 2005 | watch_plus_founder | /v1/monitor/subscribe/watch_plus_founder (retired) |
| 2006 | watch_pro          | /v1/monitor/subscribe/watch_pro |
| 2007 | audit              | /v1/monitor/subscribe/audit |
| 2008 | retest_pack        | /v1/monitor/subscribe/retest_pack |
| 2009 | founder_pack       | /v1/monitor/subscribe/founder_pack |
| 3001 | feed               | /v1/feed/subscribe/feed |
| 3002 | feed_pro           | /v1/feed/subscribe/feed_pro |
| 3003 | feed_credits       | /v1/feed/credits |
| 9000 | (unmapped)         | fallback; a test fails if any paid route or plan lacks a tag |

## Switches (wrangler.toml vars)

- `XRPL_DEST_TAG_ROUTES`: `""` = off (legacy `sourceTag` 5864 on every quote), a comma list of products
  (e.g. `receipts`) for a staged rollout, or `all`.
- `XRPL_DEST_TAG_SOURCE_TAG`: `none` (default) = destination-tagged quotes carry no `extra.sourceTag`; a uint32
  (e.g. `804681468`) = state that SourceTag explicitly on destination-tagged quotes.

Note (verified against the t54 mainnet `/verify`, 2026-10-30): when a quote has no `extra.sourceTag`, t54 requires the
tx SourceTag to be 804681468 (`source_tag_mismatch` otherwise). The x402-xrpl SDK (0.3.4 and 0.4.0-beta.1) adds a
SourceTag only when the quote states one, so with `none` a standard SDK buyer's untagged payment is refused.
