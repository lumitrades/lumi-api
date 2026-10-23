# Lumi Scanner Kit (v0, DRAFT, not published)

A thin client for contributing **signed, on-ledger-verifiable x402 delivery receipts** to Lumi ("Tested by Lumi").
The kit only collects and signs evidence. Seller selection, scoring, the catalog, history and anti-fraud stay on
Lumi's server.

> **License scope.** This client code is open source under **Apache-2.0** (see `LICENSE`; it was chosen for the
> patent grant). The license covers **only the code in this package**. It does **not** cover Lumi's pooled dataset,
> scoring, verification server, contributor keys, the "Tested by Lumi" name or badges. Those stay Lumi's and are not
> licensed. See `NOTICE` and `TERMS.md`.

## How contributing works

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
4. You earn **credits**, which are not cash. Possible fixed per-receipt bounties come later (see `TERMS.md`).

## Quick start

```bash
cd packages/scanner-kit && npm install          # Node >= 20
node bin/lumi-scan.js keygen                    # writes ~/.lumi-scanner-kit/contributor_key.json (mode 600) and prints the PUBLIC key
# Send Lumi the public key plus the wallet address(es) you pay from. Lumi issues a key_id: add it to the key file as "key_id".

node bin/lumi-scan.js quote https://seller.example/x402/data   # free: 402 quote, latency, price per chain
node bin/lumi-scan.js wanted --limit 5                          # what to test next (server-chosen)

# Passive: report a purchase you already made (the wallet secret is read from env or a file and never printed)
export LUMI_KIT_XRPL_SEED_FILE=/path/to/wallet.json             # {"seed": "..."}; or LUMI_KIT_STELLAR_SECRET(_FILE) / LUMI_KIT_EVM_KEY(_FILE)
node bin/lumi-scan.js report --endpoint https://seller.example/x402/data --network xrpl:0 \
  --tx <TX_HASH> --status 200 --outcome delivered               # prints the signed receipt
node bin/lumi-scan.js report ... --submit                       # sends it to Lumi

node bin/lumi-scan.js buy https://seller.example/x402/data      # dry run: shows what would be paid, against your caps
node bin/lumi-scan.js me                                        # your own submissions and credits
node bin/lumi-scan.js share-demand on                           # opt in to aggregate demand stats (off by default)
```

Outcomes: `delivered`, `no_data`, `empty_result`, `error_status`, `timeout`, `wrong_data`, `other`, `inconclusive`.

Extra test data recorded with each receipt (all optional): latency, HTTP status, response size, response SHA-256,
schema fingerprint (field names and types, not values), data freshness, quoted price per chain, facilitator and
settlement time. Response bodies are never uploaded, only their hash and shape.

MCP: the `lumi-trades-mcp` branch build adds `lumi_scan_seller` (quote + dry-run plan) and `lumi_report_receipt`
(passive report; set `LUMI_CONTRIB_KEY_FILE`).

## What you get back

- Your own submissions, with their status, credits and findings (`lumi-scan me`).
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
