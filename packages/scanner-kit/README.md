# Lumi Check (v0, DRAFT, not published)

A thin client for checking an x402 seller **before you pay** and, if you choose, contributing **signed,
on-ledger-verifiable delivery receipts** to Lumi ("Tested by Lumi"). Scoring, verification, the catalog and anti-fraud
stay on Lumi's server.

> **License scope.** This client code is open source under **Apache-2.0** (see `LICENSE`; it was chosen for the
> patent grant). The license covers **only the code in this package**. It does **not** cover Lumi's pooled dataset,
> scoring, verification server, contributor keys, the "Tested by Lumi" name or badges. Those stay Lumi's and are not
> licensed. See `NOTICE` and `TERMS.md`.

## Pre-pay trust check

Free. Returns `allow`, `warn` or `block` with reasons, the seller's current Lumi score and a link to the live report.
Every verdict is **signed by Lumi** (ed25519) and verified locally before it is used. Only the URL's origin + path is
sent (query strings are dropped). Paying Lumi never changes any score, tier, ranking or badge.

```js
import { createLumiCheck, x402BeforePaymentHook, mcpOnPaymentRequiredHook, withOutcomeReporting } from "lumi-scanner-kit";

const lumi = createLumiCheck();             // fail-open, 2.5 s timeout; verdicts must be signed by a pinned Lumi key

// From code
const r = await lumi.check({ url: "https://seller.example/x402/data", payTo: "0x...", amountUsd: 0.01, network: "eip155:8453" });
// r.decision, r.reasons, r.score, r.link, r.verified

// x402 client (@x402/core / @x402/fetch): abort the payment when Lumi says "block"
client.onBeforePaymentCreation(x402BeforePaymentHook(lumi));           // { blockOnWarn: true } to be stricter

// MCP client (@x402/mcp): tool payments are checked by payTo
mcpClient.onPaymentRequired(mcpOnPaymentRequiredHook(lumi));

// Optional: one tier-1 delivery outcome per paid call (see "What is shared")
const paidFetch = withOutcomeReporting(wrapFetchWithPayment(fetch, client), lumi);
```

CLI: `lumi-scan check https://seller.example/x402/data --pay-to 0x... --amount 0.01`.

**Fail mode (defaults pending Bobby's approval):** `fail_mode: "open"` with `timeout_ms: 2500`. If Lumi is slow,
unreachable, or returns a verdict whose signature does not verify, the result is `warn` (`lumi_unreachable` /
`lumi_unverified`, or `lumi_untrusted_key` / `lumi_retired_key` when it is signed by a key that is not pinned) and the
payment goes ahead. Set `"fail_mode": "closed"` in the config (or `failMode: "closed"`) to
block instead. The detailed paid check (`/v1/trust/check`, x402) adds reason details and a signed `lumi_receipt`.

**Pinned keys.** The kit ships Lumi's signing public keys in `src/lumi_keys.js` (`LUMI_SIGNING_KEYS`, with a rotation
status: `next`, `active` or `retired`) and never fetches keys at runtime, so whoever answers a request cannot choose the
key it is checked against. A verdict or receipt signed by any other key is rejected with `lumi_untrusted_key` (a retired
key: `lumi_retired_key`); a key rotation ships as a kit update. Current key: `lsk_5c8c2f54fd228547`.
`/v1/check/keys` lists the same keys for reference only.

Verify any Lumi-signed response yourself: `verifyLumiSigned(response)` checks against the pinned keys; the result has
`ok`, `errors`, and on failure `error` + `detail`. `{ publicKeys }` replaces the pins (tests or a self-hosted Lumi only).

## What is shared

You are shown this at first run and in `lumi-scan setup`.

| | Default | What is sent | Earns |
|---|---|---|---|
| **Tier 1: delivery outcomes** | **ON** | After each paid check: seller host (or Lumi vendor id), delivered yes/no, coarse status class (`2xx`/`4xx`/`5xx`/`timeout`), and a fresh random token per report. **No** wallet address, amount, tx hash, URL path or query, payload, or stable ID. | nothing |
| **Tier 2: signed receipts** | **OFF** (opt-in) | Full signed delivery receipts (below). Nothing is sent unless you turn it on. | free Lumi Check credits |

- Tier 1 off (any one): `lumi-scan telemetry off`, env `LUMI_CHECK_TELEMETRY=off`, or `"telemetry": false` in
  `~/.lumi-scanner-kit/config.json`.
- Tier 2 on/off: `lumi-scan sharing on|off`, `"share_receipts": true|false`, or env `LUMI_SHARE_RECEIPTS=1|0`.
- Env always wins over the config file. `lumi-scan telemetry status` / `sharing status` show the effective setting.
- Retention: raw data (tier-1 outcome counters, tier-2 submissions) is kept for 90 days, then deleted, and a raw day is
  deleted only after it has been rolled up. The daily per-seller summaries (delivered, failed, status-class counts; no
  wallet, amount, tx, query or client id) are kept long-term. Contributor accounts are kept while active (a receipt or
  signed check in the last 365 days). Unused credits expire 90 days after they were earned. Tier-1 outcomes are never a
  scoring input.

### Deleting your account

`lumi-scan account delete` (asks you to type your key id; `--confirm <key_id>` when not in a terminal) calls the signed
`DELETE /v1/contrib/me`. You can also email hello@lumitrades.io and Lumi deletes it for you the same way.

- Deleted at once: your key (it can never sign again), label, public key, registered wallets and the funding wallet
  recorded for each, own domains, demand opt-in, last-activity date, your free check credits (balance, earned batches
  and spends), your leaderboard entry, and every tier-2 receipt you shared (including the stored copy), except receipts
  Lumi has already cited in a published, dated test result.
  Kept, with no link to you: those cited receipts, with your wallet signature, payer address, kit details and key id
  removed (the transaction hash, seller and delivery result stay because the published result cites them; they still
  fall under the 90-day raw retention), and the anonymous per-seller daily summaries and tier-1 counters, which never
  had a link to you. What remains of the key is a tombstone (the random key id, status "deleted" and dates) so it cannot
  be reused. Payments on a public blockchain cannot be deleted by anyone.

## How contributing works (tier 2, opt-in)

1. **Passive (default).** You already buy from x402 sellers. After a purchase, `lumi-scan report` looks the payment
   up on-ledger, builds a `counterparty_delivery_receipt` and signs it with the **paying wallet**. You submit it,
   signed with your **contributor key**. There is no new spend.
2. **Optional test-buy.** `lumi-scan wanted` shows what Lumi would like tested next (chosen server-side).
   `lumi-scan buy <url>` is a **dry run** unless you add `--live`. It is capped locally at 0.01 per buy, 0.05 per day
   per asset and 3 buys per day by default. Hard ceilings cannot be raised: 0.05, 0.5 and 10. Live buys are XRPL-only
   in v0.
3. Lumi checks every receipt **on-ledger** before it counts. It rejects self-tests (your own endpoints or wallets) and
   caps receipts per key, per endpoint and per funding source. A negative finding counts only once a second,
   independent contributor (or a Lumi re-buy) confirms it, and sellers can dispute a finding.
4. **What counts.** Lumi looks up who first funded each registered wallet (Base explorer, XRPL activation, Stellar
   `create_account`) and groups wallets with the same funder into one cluster. A cluster earns at most once per seller
   per UTC day, however many keys it uses. Receipts from a wallet funded by the seller's pay-to wallet (or the seller's
   own funder) count for nothing, as do receipts from wallets without a wallet-control proof. A second receipt for the
   same payer, seller and amount within two minutes of another is refused as a near-duplicate even with a new tx hash.
   Zero-weight receipts are stored and shown to you with `weight: 0` and the reason, but earn no credits or leaderboard
   place and can't confirm anyone's negative finding. Exchange and faucet wallets Lumi lists are ignored as funders.
5. **No cash.** Each verified receipt earns **5 free Lumi Check credits** (one per unique seller per day; self-tests and
   duplicates earn nothing), spendable on detailed checks (1 credit) and vendor reports (10 credits) (`lumi-scan credits`,
   `lumi-scan spend trust_check <url>`). You also get the contributor badge, a place on the public leaderboard, early
   access and higher rate limits. Cash bounties are disabled.

## Quick start

```bash
cd packages/scanner-kit && npm install          # Node >= 20
node bin/lumi-scan.js setup                     # shows what is shared; choose tier 1 / tier 2
node bin/lumi-scan.js keygen                    # writes ~/.lumi-scanner-kit/contributor_key.json (mode 600) and prints the PUBLIC key
node bin/lumi-scan.js prove-wallet --network xrpl:0           # signs a wallet-control proof locally (needs the wallet secret env below)
# Send Lumi the public key, the wallet address(es) you pay from and one proof per wallet. Lumi issues a key_id: add it to
# the key file as "key_id". Wallets registered without a proof earn nothing until you run `prove-wallet --submit`.

node bin/lumi-scan.js quote https://seller.example/x402/data   # free: 402 quote, latency, price per chain
node bin/lumi-scan.js wanted --limit 5                          # what to test next (server-chosen)

# Passive: report a purchase you already made (the wallet secret is read from env or a file and never printed)
export LUMI_KIT_XRPL_SEED_FILE=/path/to/wallet.json             # {"seed": "..."}; or LUMI_KIT_STELLAR_SECRET(_FILE) / LUMI_KIT_EVM_KEY(_FILE)
node bin/lumi-scan.js report --endpoint https://seller.example/x402/data --network xrpl:0 \
  --tx <TX_HASH> --status 200 --outcome delivered               # prints the signed receipt
node bin/lumi-scan.js sharing on                               # tier 2 opt-in (required before --submit)
node bin/lumi-scan.js report ... --submit                       # sends it to Lumi

node bin/lumi-scan.js buy https://seller.example/x402/data      # dry run: shows what would be paid, against your caps
node bin/lumi-scan.js me                                        # your own submissions, badges and credits
node bin/lumi-scan.js credits                                   # free Lumi Check credit balance
node bin/lumi-scan.js share-demand on                           # opt in to aggregate demand stats (off by default)
```

Outcomes: `delivered`, `no_data`, `empty_result`, `error_status`, `timeout`, `wrong_data`, `other`, `inconclusive`.

Extra test data recorded with each receipt (all optional): latency, HTTP status, response size, response SHA-256,
schema fingerprint (field names and types, not values), data freshness, quoted price per chain, facilitator and
settlement time. Response bodies are never uploaded, only their hash and shape.

MCP: the `lumi-trades-mcp` branch build adds `lumi_scan_seller` (quote + dry-run plan) and `lumi_report_receipt`
(passive report; set `LUMI_CONTRIB_KEY_FILE`).

## What you get back

- Your own submissions, with their status, findings and free check credits (`lumi-scan me`, `lumi-scan credits`).
- Normal Lumi API access.
- **Not** the raw pooled database.

## Files

- `RECEIPT_FORMAT.md`: the receipt, its mapping to ARS `counterparty_delivery_receipt` v0.1, and request signing.
- `FUNDING_XRPL.md`: funding a small XRPL test wallet (reserve, RLUSD trustline).
- `TERMS.md`: contributor terms (DRAFT).
- `LICENSE` (Apache-2.0) and `NOTICE` (what is not licensed).

## Security

- Wallet secrets come from env or files only. They are never logged or sent; output passes through a redactor.
- The contributor key signs API requests only and cannot move funds. Lumi can revoke it instantly.
- Use a dedicated low-balance wallet for test-buys.
