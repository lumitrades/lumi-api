# Receipt format: `counterparty_delivery_receipt` v0.1 plus `x_lumi_contrib`

Contributor receipts use the same body Lumi uses for its own signed test-buy receipts: the proposed AgenticRiskStandard
(ARS) evidence type `counterparty_delivery_receipt`, version `ars-evidence/0.1`. Kit-specific data goes in one
extension block, `x_lumi_contrib`. ARS consumers can ignore it, but it is covered by the hash.

## Body

```json
{
  "type": "counterparty_delivery_receipt",
  "version": "ars-evidence/0.1",
  "receipt_id": "contrib-xrpl-<tx_hash>",
  "issued_at": "2026-10-23T21:00:00.000Z",
  "issuer": { "name": "Lumi Check contributor", "methodology_url": "https://api.lumitrades.io/v1/trust/methodology", "methodology_version": "v0" },
  "seller": { "endpoint": "https://seller.example/x402/data", "domain": "seller.example", "pay_to": "r..." },
  "payment": { "network": "xrpl:0", "asset": "RLUSD", "issuer": "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", "amount": "0.001",
               "tx_hash": "<64 hex>", "payer": "r...", "ledger_result": "tesSUCCESS" },
  "delivery": { "observed_at": "2026-10-23T20:59:58Z", "http_status": 200, "data_returned": true, "outcome": "delivered", "latency_ms": 840, "source": "contributor" },
  "x_lumi_contrib": {
    "format": "lumi-contrib/0.1",
    "kit": { "name": "lumi-scanner-kit", "version": "0.1.0" },
    "mode": "passive",
    "measurements": { "latency_ms": 840, "http_status": 200, "response_bytes": 1834, "response_sha256": "<64 hex>",
                      "schema_fingerprint": "<32 hex>", "data_timestamp": "...", "freshness_s": 42, "quote_latency_ms": 120,
                      "quotes": [{ "network": "xrpl:0", "asset": "RLUSD", "amount": "0.001", "pay_to": "r...", "scheme": "exact" }],
                      "facilitator": "...", "settlement_ms": 2100 }
  },
  "receipt_hash": "<sha256 hex>",
  "signer": { "key_type": "ripple-keypairs", "address": "r...", "public_key": "...", "message": "lumi-receipt:xrpl:0:<tx>:<hash>", "signature": "..." }
}
```

## Hash and signature

- `receipt_hash` is the SHA-256 of the canonical JSON of the body without `receipt_hash` and `signer`. Canonical JSON
  means keys sorted and no whitespace, in the RFC 8785 style.
- The **paying wallet** signs `lumi-receipt:<network>:<tx_hash>:<receipt_hash>`:
  - XRPL: `ripple-keypairs` over the UTF-8 hex
  - Base: EIP-191 `personal_sign`
  - Stellar: ed25519 over the UTF-8 message, base64-encoded
- The signer address must equal `payment.payer`.
- Anyone can verify a receipt offline, or on-ledger with `POST /v1/trust/receipts/verify?ledger=1`.

## Mapping to ARS `counterparty_delivery_receipt` v0.1

| ARS field | Kit value |
|---|---|
| `type`, `version` | Unchanged |
| `receipt_id` | `contrib-<chain>-<tx_hash>`. Lumi's own receipts use `lumi-<chain>-<tx>`. |
| `issuer` | The contributor, described generically. Contributor identity is held server-side by key id and never put in the receipt. |
| `seller.*` | Same. `vendor_id` is omitted; the server resolves it. |
| `payment.network` | `xrpl:0`, `eip155:8453` and **`stellar:pubnet`**. Stellar extends the v0.1 enum and is documented here. |
| `payment.*` | Same. Optional `ledger_index` and `block_number` are filled by the server from the ledger. |
| `delivery.outcome` | Same 8-value enum. `data_returned` is `null` for `inconclusive`. |
| `delivery.source` | `"contributor"`. Lumi's own receipts use a descriptive string such as `"Lumi daily test-buy (XRPL)"`. |
| `x_lumi_contrib` | Extension. `format` versions the block; `kit.version` lets the server retire old kits (HTTP 426). |
| `receipt_hash`, `signer` | Same scheme as Lumi's receipts |

## Submission request

`POST /v1/contrib/submissions` with body `{"mode":"passive"|"test_buy","receipt":{...}}`. It is signed with the
**contributor key** (ed25519), not the wallet.

```
Lumi-Contributor-Key: lck_<16 hex>
Lumi-Timestamp: <unix ms>            (must be within 5 minutes)
Lumi-Signature: base64(ed25519("lumi-contrib/v0\n<METHOD>\n<path+query>\n<ts>\n<sha256 hex of body>"))
Lumi-Kit: lumi-scanner-kit/0.1.0
```

A seller dispute (`POST /v1/contrib/disputes`) is signed by the seller's `pay_to` wallet over
`lumi-dispute:<tx_hash>:<sha256(reason)>`.
