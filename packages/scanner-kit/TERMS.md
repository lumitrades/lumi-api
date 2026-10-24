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
- On revocation for abuse, Lumi may remove your badge and refuse future keys for the same wallets.

## 3. What you submit

- Only **test data** about purchases from x402 sellers: the payment's chain and transaction ID (checked on-ledger),
  HTTP status, timing, response size, response hash, schema fingerprint, freshness, facilitator and settlement time.
  No amounts or prices, no response bodies and no personal data. A transaction ID is public on its blockchain: anyone
  who has it can look it up and link it to the wallet that paid.
- You prove control of each wallet you register by signing a message bound to your contributor key. Wallets without a
  proof do not count toward a badge.
- Wallets funded from the same source count as one contributor: at most one counted receipt per seller per UTC day
  across all of them. Receipts from wallets funded by the seller (its pay-to wallet or that wallet's funder) do not count.
  Lumi looks up and caches each wallet's first funder from public ledger data for this.
- You confirm that you actually made each payment from a wallet you control, and that it reflects a real
  interaction. Self-testing (your own endpoints, domains or wallets) is not allowed and is rejected.
- Lumi verifies each receipt on-ledger before it counts. It may reject, hold, down-weight or remove any submission,
  including negative findings that are not independently confirmed or that a seller disputes.
- You grant Lumi a perpetual, irrevocable, worldwide, royalty-free licence to use, combine, analyse and publish your
  submissions, including in aggregate scores and badges.

## 4. Recognition (badge only)

- Contributors with a **verified** tier-2 receipt get a public, pseudonymous **contributor badge**, optionally shown
  with a count of verified contributions. One receipt per unique seller per UTC day counts; self-tests, duplicates,
  unconfirmed negatives and disputed findings do not. Tier-1 anonymous outcomes earn nothing.
- That is the only reward. There are **no** credits, money, payments, prizes, discounts, rankings, early access,
  rate-limit changes or other perks, and the badge has no monetary value.
- Contributing never changes how any score is computed. Lumi may remove a badge for abuse.
- Nothing in these terms is an employment, partnership or agency relationship.

## 5. Sharing tiers

- **Tier 1 (off until you say yes):** nothing is sent before you agree. After your first check, the CLI asks once:
  "Share your results to help improve Lumi's public trust list? [Y/n]". If you say yes, after each paid call the kit
  sends an anonymous delivery outcome: seller host (or Lumi vendor id), delivered yes/no, and a coarse status class. No
  wallet address, amount, tx hash, URL path or query, payload, or stable identifier. Your answer is stored only on your
  machine. Runs where the kit cannot ask (no terminal, CI, MCP server, code) stay off. Change it any time with
  `lumi-scan telemetry on|off`, `LUMI_CHECK_TELEMETRY=on|off`, or `"telemetry": true|false`. Sharing never changes how
  any score is computed.
- **Tier 2 (off by default, opt-in):** full signed receipts. Nothing is sent unless you turn it on (`lumi-scan sharing on`).
  Each receipt shares the payment's chain and transaction ID, which is public on-chain and can be linked to the wallet
  that paid. The receipt has no amount or wallet field. Lumi confirms the payment on the public ledger and does not
  store the amount. It keeps the paying wallet address (read from the ledger) only for the anti-gaming checks in
  section 3; it is never published or shown publicly, and is removed if you delete your account.
- **Retention.** Raw data (tier-1 outcome counters and tier-2 submissions, including the stored receipt copy) is kept for
  90 days, then deleted. A raw tier-1 day is deleted only after it has been summarised. The summaries, one row per seller
  per UTC day with delivered, failed and status-class counts (no wallet, amount, tx hash, URL query, payload or identifier
  of you), are kept long-term.
- Your contributor account (key id, public key, registered wallets) is kept while it is active, meaning you submitted a
  verified receipt in the last 12 months. It is not deleted at 90 days.
- **Deleting your account.** You can delete it at any time yourself (`lumi-scan account delete`, which calls the signed
  `DELETE /v1/contrib/me`) or by emailing hello@lumitrades.io. Deletion cannot be undone.
  Deleted at once: your key (it can never sign again), label, public key, registered wallets and the funding wallet
  recorded for each, own domains, demand opt-in, last-activity date, your badge, and every tier-2 receipt you shared
  (including the stored copy), except receipts Lumi has already cited in a published, dated test result.
  Kept, with no link to you: those cited receipts, with your wallet signature, paying-wallet link, kit details and key id
  removed (the transaction hash, seller and delivery result stay because the published result cites them; they still
  fall under the 90-day raw retention), and the anonymous per-seller daily summaries and tier-1 counters, which never
  had a link to you. What remains of the key is a tombstone (the random key id, status "deleted" and dates) so it cannot
  be reused. Payments on a public blockchain cannot be deleted by anyone.

## 6. Demand data

- Off by default. If you opt in (`share-demand on`), Lumi may use your passive purchases in **aggregate demand
  statistics only**, at domain level, with at least two contributors per row and no key ids or wallets. You can opt
  out at any time; opting out applies to future submissions.

## 7. What you get

- Your own submissions back, with status and findings, and your badge (`/v1/contrib/me`), plus normal Lumi API access.
- **Not** access to the raw pooled database.

## 8. Sellers

Sellers can dispute a finding by signing with their pay-to wallet. Lumi reviews disputes and may uphold or clear them.

## 9. No warranty; limits

The kit is provided "as is" (see `LICENSE`). Test-buys spend real funds: you are responsible for your wallets, caps
and any losses. Lumi is not liable for seller behaviour. These terms may change, and the current DRAFT is not in effect.
