# Funding a small XRPL test wallet

Use a dedicated wallet, never your main one. Values were checked on 2026-10-23 against xrpl.org
(<https://xrpl.org/docs/concepts/accounts/reserves>). Reserves are set by validator vote and can change, so look up the
live values with the `server_state` or `fee` API before you rely on them.

## 1. Reserves (Mainnet)

| Item | XRP locked |
|---|---|
| Base reserve per account | 1 XRP |
| Owner reserve per ledger object (each trust line, offer, ...) | 0.2 XRP |

These are the values in force since the December 2024 fee vote, which lowered them from 10 and 2 XRP.

Reserved XRP cannot be sent, but it can pay transaction fees. An account with one RLUSD trust line needs
**1.2 XRP** locked.

**Suggested funding:** about **2 XRP** for a test wallet. That is 1.2 XRP of reserve plus about 0.8 XRP of headroom
for fees (about 0.00001 XRP each) and XRP-priced buys. Add a small amount of RLUSD (for example 0.10 RLUSD) for
RLUSD-priced buys.

## 2. Create and activate

1. Generate a wallet offline (for example with `xrpl.js` `Wallet.generate()`) and store the seed in a file with mode 600.
   Never paste it into chats, logs or the kit's command line.
2. Send at least 1 XRP (2 XRP suggested) to the new address from an exchange or another wallet. The account exists
   once that payment validates. Note which wallet funded it: Lumi counts **funding sources**, so wallets funded from the
   same source count as one for per-endpoint caps and for confirming negative findings.

## 3. RLUSD trust line

RLUSD (Ripple USD) on XRPL Mainnet:

- issuer `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`
- currency code `RLUSD` (hex `524C555344000000000000000000000000000000`)

Submit a `TrustSet`:

```json
{
  "TransactionType": "TrustSet",
  "Account": "<your test wallet>",
  "LimitAmount": { "currency": "524C555344000000000000000000000000000000", "issuer": "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", "value": "10" }
}
```

A low limit (here 10 RLUSD) is a safety cap on what the wallet can hold. The trust line adds 0.2 XRP to the reserve.
Then buy or receive a little RLUSD.

## 4. Register with Lumi

Give Lumi the wallet **address** (never the seed) when your contributor key is issued. Set
`LUMI_KIT_XRPL_SEED_FILE=/path/to/wallet.json` for `lumi-scan report` or `lumi-scan buy --live`.

## 5. Getting the reserve back

Deleting an account (`AccountDelete`) returns the base reserve minus the deletion fee (currently 0.2 XRP). You must
remove trust lines first, which needs a zero RLUSD balance.
