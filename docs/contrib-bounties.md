# Contributor wanted-list bounties: design note (DISABLED, not built)

Status: **disabled**. There is no payout code. `CONTRIB_BOUNTIES.enabled = false`, `GET /v1/contrib/bounties` reports `enabled: false`,
and the legacy USD credit accounting stays behind `CONTRIB_CASH_BOUNTIES_ENABLED` (default off).

Launch rewards (no cash): 5 free Lumi Check credits per verified receipt (one per seller per UTC day; a detailed check
costs 1 credit, a vendor report 10), contributor badges,
the public leaderboard, early access and a higher `/v1/check` rate limit.

## Later, after revenue (needs the owner's sign-off before any build)

- A public **wanted list** of specific sellers/endpoints Lumi wants tested, each with a **fixed** bounty (not per-volume).
- Paid from a **capped budget** (monthly cap, per-seller cap, per-contributor cap); the list closes when the budget is spent.
- Only **verified tier-2 signed receipts** qualify: on-ledger payment checked, self-dealing checks passed, one claim per
  bounty, negatives only after independent confirmation, a dispute window before payout.
- Payouts would be manual, owner-approved batches with a separate scoped key; never automatic, never from a wallet key in the Worker.
- Sybil/collusion controls to design first: funding-source clustering, KYC threshold above a payout size, seller-funded buyer detection.
- Bounties never change a score, tier, ranking or badge; sellers cannot fund bounties on themselves.
