# Base USDC facilitator routing (trust routes: Coinbase CDP only)

Owner approval: Bobby, 2026-10-28 1:07 PM CT, branch only (`trust-cdp-only-1028`). Background: Lumi Legal
"stay but limit" on PayAI (notes/cleanup_2026-10-28/payai_terms_review.md).

## Which facilitator each route uses (Base USDC, `eip155:8453`)

| Route | Paid route key | Base facilitator | On CDP outage |
|---|---|---|---|
| `GET /v1/trust/check/high-value` (paid trust check tier) | `high_value_check` | Coinbase CDP only | 503 `cdp_unavailable` |
| `GET /v1/verdict` | `verdict` | Coinbase CDP only | 503 `cdp_unavailable` |
| `GET /v1/check/batch` | `batch_check` | Coinbase CDP only | 503 `cdp_unavailable` |
| `GET /v1/trust/receipts` | `receipts` | Coinbase CDP only | 503 `cdp_unavailable` |
| `GET /v1/trust/vendors/{id}/report` | `vendor_report` | Coinbase CDP only | 503 `cdp_unavailable` |
| `/v1/feed/*` plans, feed credits, `/v1/monitor/subscribe/*` plans and packs | plan ids | CDP first, PayAI fallback | falls back to PayAI |
| `GET /v1/wallet/check`, free `GET /v1/trust/check`, free `/v1/check` | (free) | none (never calls a facilitator) | n/a |

XRPL (t54 facilitator) and Stellar (OpenZeppelin Channels) are unchanged and never involve PayAI.

The set lives in `CDP_ONLY_ROUTES` (src/config.ts). `EVM_CDP_ONLY_ROUTES` overrides it per deployment: a comma list of
route keys, or `none` (used by `[env.testnet]`, which has no CDP key and uses x402.org, not PayAI). Unknown names fail
config load.

## What "CDP only" means

- The keyless fallback (`EVM_FACILITATOR_URL`, PayAI on mainnet) is never called for these routes: no `/verify`, no
  `/settle`. Their payment payload, `resource.description` and `extensions.bazaar` are never sent to PayAI, so PayAI
  gets nothing new to catalog for them.
- If CDP is not configured (no `CDP_API_KEY_ID`/`SECRET`, or `EVM_FACILITATOR=fallback`), these routes **do not offer
  Base USDC at all** in their 402; XRPL and Stellar are still offered. A Base payment header sent anyway matches no
  offered option (402, no facilitator call).
- The Coinbase CDP Bazaar listing is unaffected: CDP still receives the server's `resource` and `extensions.bazaar`.

## CDP outage behavior (decided: clear 503, never a silent fallback)

Verify phase (nothing claimed, nothing charged). Any case that used to fall back (network error, 5xx, 408/429,
401/403/404, unparseable or malformed reply, facilitator-side invalid reason such as `invalid_bazaar_extension`):

```
HTTP 503, Retry-After: N (5..300, default 30, or CDP's own Retry-After)
{ "error": "facilitator_unavailable", "reason": "cdp_unavailable", "retryable": true, "retryAfter": N,
  "correlationId": "...", "phase": "verify", "settlementAttempted": false, "charged": false,
  "payment_help": { "why": ..., "facilitator": "Coinbase CDP", "fallback_facilitator": null,
                    "upstream": { "status": ..., "reason": ... },
                    "retry": "Nothing was charged. Retry the same request with the same payment after N seconds ...",
                    "other_networks": ["xrpl:0", "stellar:pubnet"], "other_networks_note": ... } }
```

The same signed payment can be retried once CDP is back, while the quote is valid.

Settle phase (invoice and EIP-3009 nonce are already claimed):

- CDP answers 401/403/404/429, or a facilitator-side refusal without a transaction hash: 503 `cdp_unavailable` with
  `phase: "settle"`, `charged: false`. The authorization cannot be reused; the buyer requests a fresh 402 and signs again.
- Network error with no answer, 5xx, or any reply carrying a tx hash: unchanged `409 settlement_status_unknown`
  (the transfer may have reached the chain; Lumi never re-submits it elsewhere).
- A definite refusal about the payment itself (bad signature, insufficient funds): unchanged 402 re-quote.

Log event: `x402_cdp_only_unavailable` (route, phase, upstream status, reason). `/health` shows `evm.cdp_only_routes`.

Tests: test/trust_cdp_only.test.ts.
