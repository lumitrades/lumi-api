# First high-value check refund (flag, default OFF)

Offer: a buyer's first paid high-value check (`GET /v1/trust/check/high-value`) is refunded, up to **$0.25**, once per payer
address, to the address that paid. The verdict, label and score are the same either way (paying never changes them).

## Flag

`FIRST_HV_REFUND` in `wrangler.toml` `[vars]`. Default `"off"`. Only the exact value `"on"` (case-insensitive) turns it on;
unset, empty, `"off"` or any other value keeps it off.

| | Flag off (default) | Flag on |
|---|---|---|
| High-value 402 | no refund text | adds top-level `first_check_refund` (one sentence) |
| `GET /v1/owner/refunds/first-high-value` | 404 `not_found` (before any auth or read) | owner-only list (Bearer `OWNER_MCP_KEY`) |
| Money moved by code | none | none |

**No code path sends money, with the flag on or off.** The list is computed on read from the sales ledger (`sales` table): each
non-test payer's earliest settled `high_value_check`, `refund_usd = min(paid_usd, 0.25)`. Lumi's own wallets
(`OWN_WALLETS`, `SALES_TEST_WALLETS`) are excluded. The operator pays each refund by hand, on the same network, after review.

## Switching it on (owner decision; needs a deploy)

1. Get the owner's yes for the offer and its budget (worst case $0.25 x number of new payers).
2. Set `FIRST_HV_REFUND = "on"` in `wrangler.toml` `[vars]` (or the dashboard variable), then deploy as usual.
3. Review owed refunds: `curl -H "Authorization: Bearer $OWNER_MCP_KEY" https://api.lumitrades.io/v1/owner/refunds/first-high-value`
4. Pay each `owed[]` row by hand (`refund_usd` to `payer` on `network`); keep the refund tx next to the original `tx`.
5. To stop the offer: set it back to `"off"` and deploy; the 402 text and the list disappear, already-promised refunds should still be paid.

Note: the list has no "paid" marker yet; track paid refunds by original `tx` until one is added.
