# Lumi Check: Contributor Terms (DRAFT, not in effect)

> **DRAFT for review. Not legal advice and not yet offered to anyone.** v0 is a private dry run with Lumi's own
> agents (Lumi and Lumi Scout) as the first two contributors.

## 1. What these terms cover

These terms cover taking part in Lumi's contributor program: submitting receipts with a Lumi-issued contributor key.
The kit's **client code** is licensed separately under Apache-2.0 (`LICENSE`). That license covers only the client
code. It does not cover Lumi's pooled dataset, scoring, verification server, contributor keys, the "Tested by Lumi"
name or badges. Those remain Lumi's, and nothing here or in the license grants rights in them.

## 2. Contributor keys

- Lumi issues keys at its discretion and can **revoke a key instantly**, with or without notice, for example for
  suspected self-testing, boosting, collusion, false reports or abuse.
- A key is a revocable credential tied to the wallets you register. It is not transferable and has no value of its own.
- On revocation for abuse, Lumi may **forfeit** unspent credits and refuse future keys for the same wallets.

## 3. What you submit

- Only **test data** about purchases from x402 sellers: payment facts that can be checked on-ledger, HTTP status,
  timing, response size, response hash, schema fingerprint, freshness, quoted prices, facilitator and settlement
  time. No response bodies and no personal data.
- You confirm that you actually made each payment from a wallet you control, and that it reflects a real
  interaction. Self-testing (your own endpoints, domains or wallets) is not allowed and is rejected.
- Lumi verifies each receipt on-ledger before it counts. It may reject, hold, down-weight or remove any submission,
  including negative findings that are not independently confirmed or that a seller disputes.
- You grant Lumi a perpetual, irrevocable, worldwide, royalty-free licence to use, combine, analyse and publish your
  submissions, including in aggregate scores and badges.

## 4. Rewards (no cash)

- Each **verified** contributed receipt earns **free Lumi Check credits**, which you can spend on Lumi checks and
  detailed reports. Only tier-2 signed receipts earn credits; tier-1 anonymous outcomes earn nothing. One receipt per
  unique seller per UTC day earns; self-tests, duplicates, unconfirmed negatives and disputed findings earn nothing.
  The amount per receipt is set by Lumi and may change. Unused credits expire 90 days after the day they were earned;
  spends use your oldest credits first.
- **Credits are not cash**, not money, not a security, not transferable and cannot be redeemed for money.
- Contributors with a verified receipt also get the contributor badge, a place on the public (pseudonymous)
  leaderboard, early access and higher rate limits.
- **No cash bounties at launch.** Any future paid bounties would be a separate, opt-in "wanted list" of fixed bounties
  for testing specific sellers, from a capped budget, under separate terms. Nothing here promises them.
- Nothing in these terms is an employment, partnership or agency relationship.

## 5. Sharing tiers

- **Tier 1 (on by default):** after each check, the kit sends an anonymous delivery outcome: seller host (or Lumi vendor
  id), delivered yes/no, and a coarse status class. No wallet address, amount, tx hash, URL path or query, payload, or
  stable identifier. Turn it off with `lumi-scan telemetry off`, `LUMI_CHECK_TELEMETRY=off`, or `"telemetry": false`.
- **Tier 2 (off by default, opt-in):** full signed receipts. Nothing is sent unless you turn it on (`lumi-scan sharing on`).
- **Retention.** Raw data (tier-1 outcome counters and tier-2 submissions, including the stored receipt copy) is kept for
  90 days, then deleted. A raw tier-1 day is deleted only after it has been summarised. The summaries, one row per seller
  per UTC day with delivered, failed and status-class counts (no wallet, amount, tx hash, URL query, payload or identifier
  of you), are kept long-term.
- Your contributor account (key id, public key, registered wallets) is kept while it is active, meaning you submitted a
  receipt or made a signed check in the last 12 months. It is not deleted at 90 days. You can ask Lumi to revoke it
  at any time.

## 6. Demand data

- Off by default. If you opt in (`share-demand on`), Lumi may use your passive purchases in **aggregate demand
  statistics only**, at domain level, with at least two contributors per row and no key ids or wallets. You can opt
  out at any time; opting out applies to future submissions.

## 7. What you get

- Your own submissions back, with status, findings and credits (`/v1/contrib/me`), plus normal Lumi API access.
- **Not** access to the raw pooled database.

## 8. Sellers

Sellers can dispute a finding by signing with their pay-to wallet. Lumi reviews disputes and may uphold or clear them.

## 9. No warranty; limits

The kit is provided "as is" (see `LICENSE`). Test-buys spend real funds: you are responsible for your wallets, caps
and any losses. Lumi is not liable for seller behaviour. These terms may change, and the current DRAFT is not in effect.
