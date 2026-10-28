# lumi-trades-mcp

MCP server (stdio) for **[Lumi Trades](https://lumitrades.io)**, an independent x402 seller trust service. Start with the free
`lumi_trust_check`: pass the x402 URL you are about to pay and get allow / warn / block with coded reasons, backed by Lumi's own
test-buys on XRPL, Base and Stellar with signed, verifiable evidence. Works with Claude Desktop, Cursor, Claude Code, Cline, Windsurf and any other MCP client.
Paid tools **pay per call via x402 with your own wallet: USDC on Base (gasless) or XRP / RLUSD / USDC on the XRP Ledger**
(the API also accepts USDC on Stellar; this package pays only on Base or the XRP Ledger).
No API key, no account: each paid tool call is one small payment, signed locally on your machine.

> Automated observations by Lumi, not a rating, endorsement or guarantee.
>
> **Changed in 0.10.0:** `lumi_trust_check` is now **free** (rate-limited per client; over the limit the API answers 429 `free_limit_reached`
> pointing to the paid route). New paid `lumi_high_value_check` (`url` + `amount`): the same verdict and score plus a live re-check and a signed receipt
> bound to the amount, priced at 0.5% of the amount (min $0.005, max $0.25). Paying never changes a verdict or score.
>
> **Changed in 0.9.9:** this package is now only about checking x402 sellers. Tools for API routes retired on Oct 25, 2026 were removed;
> those routes answer 410 Gone and are never charged. Use `lumi_trust_check` (or the local `lumi_check` / `/v1/check`) to check a seller before paying.
> zod is now required at the patched range (GHSA-mrhx-c7xc-m3w5) for every dependency.

**No install needed to browse:** a remote server at `https://api.lumitrades.io/mcp` (Streamable HTTP) serves the same Lumi tools
except the three local-only ones (`lumi_check`, `lumi_scan_seller`, `lumi_report_receipt`, which verify, fetch or sign on your machine).
A remote connector has no wallet, so its paid tools return the price and how to pay; use this package when you want paid tools
to pay automatically from your own wallet.

## Tools

Listed in `tools/list` order. "Remote too" means the tool is also on `https://api.lumitrades.io/mcp`. Prices are not listed here:
they are read live from each 402 quote (see `lumi_catalog` or `lumi_quote`).

| Tool | Free / paid | Remote too | Arguments | What you get |
|---|---|---|---|---|
| `lumi_trust_check` | free (rate-limited) | yes | `url` `payTo?` `amount?` | **Start here.** Should I pay this x402 URL? allow / warn / block with coded reasons, payTo/price mismatches vs listings and Lumi's observations. Over the limit, 429 `free_limit_reached` points to `lumi_high_value_check` |
| `lumi_check` | free | no (local) | `url?` `pay_to?` `amount_usd?` `network?` | Signed `/v1/check` answer verified locally on your machine: allow / warn / block with reasons, the seller's score and a link to its live report. Only origin + path of the URL is sent. Fail-open: warn if Lumi is unreachable within 2.5 s. Remote equivalent: `lumi_trust_check` |
| `lumi_scan_seller` | free | no (local) | `url` | Fetch an x402 seller's 402 quote without paying, plus a dry-run test-buy plan against local caps |
| `lumi_report_receipt` | free | no (local) | `endpoint` `network` `tx_hash` … | Sign a receipt for a purchase you already made. `submit: true` is tier 2 sharing: off by default, needs `LUMI_SHARE_RECEIPTS=1` or `lumi-scan sharing on`. Shares the payment's chain and transaction ID, which is public on-chain and linkable to the paying wallet. Verified receipts earn a public badge only |
| `lumi_catalog` | free | yes | – | Endpoints, live prices, this server's wallet + spend caps |
| `lumi_samples` | free | yes | `route?` | Truncated, labelled samples of every paid product |
| `lumi_quote` | free | yes | `path` | The x402 quote for any paid path, without paying |
| `lumi_vendor_scores` | free | yes | `url?` `domain?` `payTo?` `vendor_id?` | Look up any x402 seller: tier (catalogued / quote-checked, low confidence / test-bought), last free 402-quote check, price and payTo vs its Bazaar listing, on-chain test-buy evidence. No args: Lumi's curated vendor scores |
| `lumi_verdict` | paid | yes (returns the price terms) | `url` `payTo?` `amount?` | One label before paying, same data and signing as `/v1/check`: `checks_passed` / `check_first` / `checks_failed` / `no_data`, with dates, evidence window, sample count, reason codes, evidence and appeal links. Paying Lumi never changes a result |
| `lumi_seller_monitoring` | free | yes | `enrollment_id?` | Seller monitoring plans, test-buy packs, free Watch tier and 14-day trial, enrolment steps; with an id, that seller's public entry and badge. Paying never changes a score |
| `lumi_trust_feed` | free | yes | – | Trust data feed plans and licence terms |
| `lumi_high_value_check` | paid (share of `amount`) | yes (returns the price terms) | `url` `amount` `payTo?` | Before a larger payment: the same verdict and score as `lumi_trust_check`, plus a live re-check of the seller and a signed receipt bound to the amount |
| `lumi_vendor_report` | paid | yes (returns the price terms) | `vendor_id` | Full observation history for one x402 vendor on Lumi's trust list: every quote check (90 days) and paid test-buy with tx hash and delivered yes/no, latency stats and trend, uptime %, agent reports, vendor replies, confidence labels |

How to pay, in order of preference: **1. USDC on Base** (gasless, `EVM_PRIVATE_KEY`), **2. the XRP Ledger** (`XRPL_SEED`):
RLUSD or USDC at the same USD price, or XRP at the live XRP/USD rate (quoted per call, rounded up to 0.0001 XRP).
Prices are read live from each 402 quote. **You only pay when you get an answer**: the API checks
your input before quoting (4xx, nothing charged) and answers 503 "Not charged." when it cannot answer, so a payment is never settled without an answer.

## Install

Requires Node 20+. Published on npm as [`lumi-trades-mcp`](https://www.npmjs.com/package/lumi-trades-mcp) and in the
[official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=lumi-trades) as `io.github.cypher-osiris/lumi-trades-mcp`.

```bash
npx -y lumi-trades-mcp
```

### Claude Desktop / Cursor / any MCP client (`mcpServers` JSON)

```json
{
  "mcpServers": {
    "lumi-trades": {
      "command": "npx",
      "args": ["-y", "lumi-trades-mcp"],
      "env": {
        "EVM_PRIVATE_KEY": "0x...your Base agent wallet key (holds USDC, no ETH needed)...",
        "LUMI_MAX_USD_PER_CALL": "0.30",
        "LUMI_SESSION_BUDGET": "1"
      }
    }
  }
}
```

Paying on the XRP Ledger instead: set `"XRPL_SEED": "sEd..."` (and optionally `"LUMI_PAY_ASSET": "RLUSD"` or `"USDC"`, default `XRP`) in place of `EVM_PRIVATE_KEY`.

From a clone instead: `"command": "node", "args": ["/absolute/path/to/lumi-api/mcp/src/index.js"]` (after `npm install` in `mcp/`).
Claude Code: `claude mcp add lumi-trades -e EVM_PRIVATE_KEY=0x... -- npx -y lumi-trades-mcp` (or `-e XRPL_SEED=sEd...`).

Without a wallet the free tools work and paid tools return the price quote instead of paying.

## Lumi Check from your own code (x402 / MCP hooks)

```js
import { lumiCheckHooks } from "lumi-trades-mcp/src/check.js";
const { lumi, x402Hook, mcpHook } = await lumiCheckHooks();   // options: { failMode: "open"|"closed", timeoutMs, publicKeys }

x402Client.onBeforePaymentCreation(x402Hook);   // @x402 core: returns { abort: true, reason } on "block"
mcpClient.onPaymentRequired(mcpHook);           // @x402/mcp: returns { abort: true } on "block" (checked by payTo)
const v = await lumi.check({ url, payTo, amountUsd: 0.01 }); // { decision, reasons, score, link, verified }
```

Defaults: **fail-open** (a timeout or an unverifiable answer gives `warn`, payment goes ahead) and a
**2.5 s timeout**. Set `failMode: "closed"` to block instead. Paying Lumi never changes any seller's score, tier, ranking or badge.
The adapters come from `lumi-check` on npm (Apache-2.0); scoring and verification stay on Lumi's servers.

What the kit shares: **nothing until the user says yes.** The `lumi-scan` CLI asks once, after the first check ("Share your
results to help improve Lumi's public trust list? [Y/n]"). The MCP server cannot ask, so here sharing stays off and one hint is
written to stderr; turn it on with `LUMI_CHECK_TELEMETRY=on` or `lumi-scan telemetry on`. **Tier 1** is only an anonymous delivery
outcome after a paid call: seller host, delivered yes/no, a coarse status class and a random one-time token. No wallet, amount,
tx hash, query string or stable ID. Sharing never changes any score. **Tier 2** (off by default) sends full signed receipts.
Each receipt shares the payment's chain and transaction ID (no amount or wallet field); a transaction ID is public on-chain and
can be linked to the paying wallet. Contributors get a public badge only, nothing of monetary value. See the kit README.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `EVM_PRIVATE_KEY` | – | `0x` private key of **your** Base wallet that pays in USDC via an EIP-3009 authorization (gasless: the facilitator pays gas). Kept in memory only; never logged, returned to the model or sent anywhere (only the signature is sent). Use a dedicated low-balance agent wallet. |
| `XRPL_SEED` | – | Seed of **your** XRPL wallet that pays. Kept in memory only; never logged, returned to the model or sent anywhere (payments are signed locally, the API only receives the signed blob). Use a dedicated low-balance agent wallet. |
| `LUMI_PAY_ASSET` | `XRP` if `XRPL_SEED` is set, else `BASE_USDC` | `BASE_USDC` (USDC on Base), or `XRP`, `RLUSD`, `USDC` on the XRP Ledger (XRPL stablecoins need a trust line + balance) |
| `LUMI_MAX_XRP_PER_CALL` | `0.25` | Refuse any XRP quote above this |
| `LUMI_MAX_USD_PER_CALL` | `0.30` | Refuse any stablecoin quote (Base or XRPL) above this. The refusal message names this variable and the value needed |
| `LUMI_SESSION_BUDGET` | `1` | Max total spend per server process, in the pay asset |
| `XRPL_NETWORK` | `xrpl:0` | `xrpl:0` mainnet, `xrpl:1` testnet |
| `LUMI_API_URL` | `https://api.lumitrades.io` | API base URL |
| `LUMI_EXPECTED_PAY_TO` | Lumi's wallets on the official API: `rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM` (XRPL mainnet), `0x5E617bac19912e6d212CB303ae84655E9E203532` (Base) | Refuse to pay any other address |
| `LUMI_CHECK_API` | `LUMI_API_URL` | Base URL for `lumi_check` |
| `LUMI_KIT_HOME` / `LUMI_KIT_CONFIG` | `~/.lumi-scanner-kit/config.json` | Kit config (saved sharing answer, telemetry and sharing switches) |
| `LUMI_CHECK_TELEMETRY` | off (until the user says yes) | `on` enables tier 1 outcome reports, `off` disables them; overrides the saved answer |
| `LUMI_SHARE_RECEIPTS` | off | `1` enables tier 2 receipt submission |
| `LUMI_CONTRIB_KEY_FILE` | – | Contributor key for tier 2 submissions (`lumi-scan keygen`) |
| `XRPL_WS_URL` | `wss://xrplcluster.com` / `wss://testnet.xrpl-labs.com` | Ledger connection used to autofill and sign |

Safety: before signing, the server checks network, scheme, asset, payee, per-call cap and session budget. Anything off and it
does not sign. Every paid result carries the on-chain transaction hash.

## Tests

```bash
npm test                         # spend-cap / payee / settings unit tests + a mocked Base USDC payment through @x402/fetch
node scripts-e2e-testnet.mjs     # testnet only: real x402 payments through MCP against a local testnet API (see the file header)
```

## License

MIT
