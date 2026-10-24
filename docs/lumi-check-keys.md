# Lumi Check signing keys and admin secret (scanner-kit-v0, not deployed)

Lumi Check answers (`GET /v1/check`), paid trust/check `lumi_receipt`s and Tested-by-Lumi badge verdicts are signed
with a dedicated Ed25519 key. It is **not** a wallet key (it cannot move funds) and **not** an admin credential.

| Secret | Purpose | Set with (at deploy time only) |
|---|---|---|
| `LUMI_CHECK_SIGNING_KEY` | 64-hex Ed25519 seed that signs answers, receipts and badge verdicts | `npx wrangler secret put LUMI_CHECK_SIGNING_KEY` |
| `CONTRIB_ADMIN_KEY` | separate admin credential for `/v1/owner/contributors*` (falls back to `OWNER_MCP_KEY` when unset) | `npx wrangler secret put CONTRIB_ADMIN_KEY` |

Both are Worker secrets. **Neither is set yet**: they are set with `wrangler secret put` as part of the deploy of this
branch, not before. Never commit or paste either value. The two must be different secrets: if
`LUMI_CHECK_SIGNING_KEY` equals `CONTRIB_ADMIN_KEY` or `OWNER_MCP_KEY`, the Worker fails closed (nothing is signed,
`/v1/check/keys` reports `signing_key_reused_as_admin_key`, and the contributor admin routes refuse every key).

## Current key

| key_id | public key (hex) | status |
|---|---|---|
| `lsk_5c8c2f54fd228547` | `7d8806265f0ce62af2bf354392246019e5f607ae2470c611bffedba59ef82e52` | active (added 2026-10-23) |

`key_id` = `lsk_` + the first 16 hex of sha256(lower-case public key hex). The private seed was generated locally and is
kept outside the repo; it is the value for `LUMI_CHECK_SIGNING_KEY`. Only the public key is in the code.

## Pinning

The public keys are **pinned** in three places that a test keeps identical:

- `src/trust/lumi_keys.ts` (server: `/v1/check/keys` lists them; a configured key that is not pinned shows `configured_key_not_pinned`)
- `packages/scanner-kit/src/lumi_keys.js` (lumi-scanner-kit)
- `mcp/src/lumi_keys.js` (lumi-trades-mcp)

Clients verify every Lumi-signed answer and receipt against the pinned, non-retired keys. They do **not** fetch
`/v1/check/keys` to decide trust (that would let whoever answers the request choose the key). A response signed by any
other key is rejected with `lumi_untrusted_key` (a retired key with `lumi_retired_key`), and Lumi Check then treats it
as unverified (fail-open: `warn`; fail-closed: `block`).

## Rotation

1. Generate the new key locally; add its public key to all three lists with `status: "next"`; release the kit and MCP.
2. When clients have the release, `wrangler secret put LUMI_CHECK_SIGNING_KEY` with the new seed and deploy.
3. Mark the new key `active` and the old one `retired` (with a `retired` date) in the next release. Answers live 15
   minutes, so nothing valid is still in flight. Retired keys are rejected.

For a compromised key, skip the overlap: mark it `retired` and ship the release immediately.
