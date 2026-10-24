# Lumi Check contributors: score-gaming controls (scanner-kit-v0, draft)

Status: implemented on the `scanner-kit-v0` branch, with tests. Not deployed. Migration `0022_contrib_antigaming.sql`
is a draft and has not been applied to production D1. Applying it needs Bobby's approval.

## 1. Wallet-control proof at registration

Every wallet signs `lumi-wallet-proof:v1:<contributor ed25519 public key hex>:<address>` (EVM addresses lower-cased).
Proofs are checked with the same verifiers as seller disputes: ripple-keypairs for XRPL, EIP-191 for Base and ed25519
for Stellar. The message includes the contributor key, so a proof can't be replayed for another key.

- `POST /v1/owner/contributors` takes `wallet_proofs: { [address]: { key_type, public_key?, signature } }`. If a proof is
  missing or invalid it returns `400 wallet_proof_required`, with the exact message each wallet has to sign.
- `allow_unproven: true` (an explicit owner action) registers the wallet with `proven = 0`. Every receipt from that wallet
  gets `weight 0` (`wallet_unproven`).
- `POST /v1/contrib/me/wallet-proof` is contributor-signed and proves a wallet later. Earlier receipts keep weight 0.
- Kit: `lumi-scan prove-wallet --network N [--submit]`. The proof is signed locally with the wallet secret from env, and
  the secret is never printed.
- **Migration effect:** wallets registered before 0022 default to `proven = 0`. Their contributors have to run
  `prove-wallet --submit` before new receipts count.

## 2. Funding-source tracing and clusters

First funders are looked up once per wallet and cached in `wallet_funding`. A funder that is found is kept for good;
a lookup that finds nothing is retried after `funding_recheck_days` (7).

| Chain | Source |
|---|---|
| XRPL | `account_tx` forward, limit 1: the activating Payment's `Account` (existing public XRPL RPC list) |
| Stellar | Horizon `/accounts/{id}/operations?order=asc&limit=1`: `create_account.funder` |
| Base | Etherscan-compatible explorer API (`CONTRIB_BASE_EXPLORER_API`, default `https://base.blockscout.com/api`, no key). The earliest inbound ETH (`txlist`) or USDC (`tokentx`, contract 0x8335…2913) transfer |

Note: from the box, `base.blockscout.com` returned a Cloudflare challenge page to curl (2026-10-23). If the Worker gets
the same, lookups return `funder: null` and the wallet is its own source (fail-open, as before), retried after 7 days.
The alternative is the Etherscan v2 API, which needs a free API key (Bobby would have to create it).

A wallet's `source` is its funder, or that funder's own source if the funder is a registered wallet (one hop).
Ignored funders (`CONTRIB_FUNDER_IGNORE`, for example exchange hot wallets) never link wallets. When a wallet that
earlier wallets named as their source is registered later, those earlier wallets are re-pointed to its source.

**One cluster = one contributor for scoring and credits.** A receipt gets `weight 0` (`same_cluster`) when another key
whose wallets share its source already has a weighted receipt for the same seller (pay_to or domain) that UTC day.
The existing per-endpoint caps already count funding sources rather than wallets. The owner can review clusters at
`GET /v1/owner/contributors/clusters`, which lists sources shared by more than one key.

## 3. Seller-funded wallets

A receipt gets `weight 0` (`seller_funded`) and earns no credits when the payer's funder or source is the seller's
pay_to, or the pay_to's own first funder, or a registered wallet in the same cluster as that funder. Ignored funders
are skipped.

## Zero weight

`weight 0` receipts are stored as evidence and shown to the contributor with the reason. They don't count toward the
leaderboard, credit lots or badges, and they never confirm, or get confirmed by, another contributor's negative.

## 4. Near-duplicates

The tx-hash check stays. In addition, the same key, payer, pay_to and amount with ledger times within
`near_dup_window_s` (120 s) returns `409 near_duplicate`. This applies to stored rows (using the `(key_id, day)` index)
and to receipts still queued for the batch writer.

## Rate limits

| Limiter | Where | Status |
|---|---|---|
| Contributor requests per key (`per_minute`, 10) | `authContributor` | Uses the **Workers Rate Limiting** binding `CONTRIB_RATE_LIMITER` when bound, shared across isolates in a location with no D1 rows. Otherwise falls back to the in-isolate map. The binding is commented out in `wrangler.toml` and needs Bobby's approval and a deploy |
| Perk checks per key per minute | `checkPerk` | In-isolate. A second ratelimit binding would be needed (same approval) |
| Tier-1 outcome reports per IP (120/min) | `app.ts outcomeLimited` | In-isolate by design: the IP is never stored. A ratelimit binding keyed on a hashed IP would work too |
| Free `/v1/check`, catalog, lookup, receipt | `trust/index.ts limited()` | Already durable (meta counters) |

Why the per-key minute counter isn't in D1: each signed request would cost one D1 row write. At 10 requests per minute
per contributor, that takes over the 5,000-row daily contributions budget (`write_budget_rows`) with a handful of active
contributors, and it adds a write to every read endpoint. The Rate Limiting binding costs no D1 rows.

## Tier 1 never feeds scores

Anonymous tier-1 outcome counters (`check_outcomes`, `check_outcome_daily`) have no contributor link and are never
read by scoring, the leaderboard or credits. A test asserts this.
