# Lumi Scanner Kit: Contributor Terms (DRAFT, not in effect)

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
- On revocation for abuse, Lumi may **forfeit** unpaid credits and refuse future keys for the same wallets.

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

## 4. Credits and rewards

- Accepted receipts earn **credits**. **Credits are not cash**, not money, not a security and not redeemable by
  right. Credit amounts are set by Lumi and may change: higher for wanted-list endpoints and under-covered chains
  (XRPL, Stellar), lower for repeats, and zero for unlisted endpoints.
- **Phase 2 (possible, not promised): fixed bounties.** Lumi may later pay a **fixed bounty per verified receipt**
  from a **capped monthly budget**. That budget opens only once Lumi's own net results are clearly ahead, as decided by
  Lumi. When the monthly budget is used up, no more bounties are paid that month. Bounties are set per receipt and
  are not tied to Lumi's revenue or profit. Lumi has full discretion over whether and when bounties start, their
  amount, eligibility and any KYC or tax requirements.
- Nothing in these terms is an employment, partnership or agency relationship.

## 5. Demand data

- Off by default. If you opt in (`share-demand on`), Lumi may use your passive purchases in **aggregate demand
  statistics only**, at domain level, with at least two contributors per row and no key ids or wallets. You can opt
  out at any time; opting out applies to future submissions.

## 6. What you get

- Your own submissions back, with status, findings and credits (`/v1/contrib/me`), plus normal Lumi API access.
- **Not** access to the raw pooled database.

## 7. Sellers

Sellers can dispute a finding by signing with their pay-to wallet. Lumi reviews disputes and may uphold or clear them.

## 8. No warranty; limits

The kit is provided "as is" (see `LICENSE`). Test-buys spend real funds: you are responsible for your wallets, caps
and any losses. Lumi is not liable for seller behaviour. These terms may change, and the current DRAFT is not in effect.
