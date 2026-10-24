# lumi-trades-mcp

MCP server (stdio) for **[Lumi Trades](https://lumitrades.io)**: **free x402 vendor trust score lookups**, a **daily crypto market brief**
and **Institutional & Policy Brief**, and **crypto signals** for the top 50 coins (support/resistance scenario levels for 13 tracked coins) for Claude Desktop, Cursor, Claude Code, Cline, Windsurf
and any other MCP client. Paid tools **pay per call via x402 with your own wallet: USDC on Base (gasless) or XRP / RLUSD / USDC on the XRP Ledger**.
No API key, no account: each paid tool call is one small payment, signed locally on your machine.

> Analytics and education only. Not financial advice. Trade ideas are hypothetical paper trades for illustration, not orders or signals to copy.

**No install needed to browse:** the same tools are also served remotely at `https://api.lumitrades.io/mcp` (Streamable HTTP),
for clients that take a remote MCP server URL. A remote connector has no wallet, so its paid tools return the price and how to pay;
use this package when you want paid tools to pay automatically from your own wallet.

## Tools

| Tool | Paid? | Price (USD) | What you get |
|---|---|---|---|
| `lumi_catalog` | free | – | Endpoints, live prices, this server's wallet + spend caps |
| `lumi_samples` | free | `route?` | Truncated, labelled samples of every paid product with USD price and full URL |
| `lumi_coins` | free | – | The 50 coins covered: signals for all, levels for the 13 watchlist/major coins (XRP XLM HBAR XDC AXL ZBCN BTC ETH SOL DOGE ADA LINK SUI) |
| `lumi_quote` | free | – | The x402 quote for any paid path, without paying |
| `lumi_vendor_scores` | free | `url?` `domain?` `payTo?` `vendor_id?` | Look up any x402 seller before paying: tier (catalogued / quote-verified, low confidence / purchase-verified), last free 402-quote check, price and payTo vs its Bazaar listing, on-chain test-buy evidence. No args: Lumi's curated vendor scores |
| `lumi_seller_monitoring` | free | `enrollment_id?` | Seller monitoring plans (Monitor $9/30d, Monitor Plus $29/30d, Audit $99 one-off), enrolment steps; with an id, that seller's public entry and badge. Paying never changes a score |
| `lumi_trust_feed` | free | – | Trust data feed plans (free key 1,000 lookups/month, Feed $99/30d, Feed Pro $199/30d) and licence terms |
| `lumi_check` | free | `url?` `pay_to?` `amount_usd?` `network?` | **Lumi Check** before you pay any x402 seller: allow / warn / block with reasons, the seller's score and a link to its live report. Signed by Lumi and verified locally. Only origin + path of the URL is sent. Fail-open: warn if Lumi is unreachable within 2.5 s |
| `lumi_scan_seller` | free | `url` | Fetch an x402 seller's 402 quote without paying, plus a dry-run test-buy plan against local caps |
| `lumi_report_receipt` | free | `endpoint` `network` `tx_hash` … | Sign a receipt for a purchase you already made. `submit: true` is tier 2 sharing: off by default, needs `LUMI_SHARE_RECEIPTS=1` or `lumi-scan sharing on`. Verified receipts earn free Lumi Check credits (no cash) |
| `lumi_brief` | paid | $0.02 | Today's market brief (BTC, CoinMarketCap Fear & Greed, movers, key levels, yen, events, paper trades, news). `format: "md"` for markdown |
| `lumi_signal` | paid | $0.01 | Buy/sell read for one coin (1h/4h/1d + indicators) |
| `lumi_levels` | paid | $0.01 | Support/resistance, rule-based 7-day scenario levels (not forecasts), commentary for one coin |
| `lumi_scan` | paid | $0.02 | Whole-market screen: buy/sell label, score, 1h RSI, price and 24h change for the top 50 coins, strongest first |
| `lumi_lite` | paid | $0.004 | Cheap headline read for one coin: label, score, 1h/4h/1d labels, price, 24h change |
| `lumi_slate` | paid | $0.02 | Current paper-trade ideas |
| `lumi_market` | paid | $0.02 | BTC + macro backdrop and breadth |
| `lumi_macro_yen` | paid | $0.01 | USD/JPY, Nikkei, carry-trade risk around 155, Japan events |
| `lumi_sentiment` | paid | $0.005 | Fear & Greed, funding read, OI, dominance, breadth |
| `lumi_events` | paid | $0.005 | Sourced upcoming macro/crypto events and catalysts |
| `lumi_funding` | paid | $0.003 | Perp funding rates for the top-50 coins on OKX (8h-normalised, annualised, plain-English read) |
| `lumi_fear_greed` | paid | $0.003 | CoinMarketCap Fear & Greed now vs yesterday/week/month, yearly high/low, 30-day series |
| `lumi_events_48h` | paid | $0.003 | What is scheduled in the next 48 hours (UTC + US Central), why it matters, sources |
| `lumi_trades` | paid | $0.02 | Paper-trade ideas as a raw list (entry, stop, targets, status, reasoning) |
| `lumi_trust_check` | paid | $0.004 | Pre-payment check of any x402 URL you are about to pay: payTo/price mismatches vs listings and Lumi's observations. `url` required |
| `lumi_vendor_report` | paid | $0.02 | Full observation history for one x402 vendor on Lumi's trust list: every quote check (90 days) and paid test-buy with tx hash and delivered yes/no, latency stats and trend, uptime %, verified agent reports, vendor replies, confidence labels. `vendor_id` required |
| `lumi_institutional_brief` | paid | $0.10 | Daily Institutional & Policy Brief: BIS, IMF, US Treasury/regulators, JPMorgan, SBI, Cross River, Securitize, R3 and others mapped to XRP, XLM, XDC, QNT, AXL, HBAR (confirmed vs indirect-alignment links, sourced). `format: "md"` for markdown. Allowed by the default caps (0.30 USD / 0.25 XRP) |

How to pay, in order of preference: **1. USDC on Base** (gasless, `EVM_PRIVATE_KEY`), **2. the XRP Ledger** (`XRPL_SEED`):
RLUSD or USDC at the same USD price, or XRP at the live XRP/USD rate (quoted per call, rounded up to 0.0001 XRP).
Prices are read live from each 402 quote; the table is for orientation. **You only pay when you get data**: the API refuses to quote
(503, "Not charged.") when its data is missing or stale, so a payment is never settled without data.

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

Defaults (pending owner approval): **fail-open** (a timeout or an unverifiable answer gives `warn`, payment goes ahead) and a
**2.5 s timeout**. Set `failMode: "closed"` to block instead. Paying Lumi never changes any seller's score, tier, ranking or badge.
The adapters come from `lumi-scanner-kit` (Apache-2.0); scoring and verification stay on Lumi's servers.

What the kit shares: **tier 1** (on by default, `LUMI_CHECK_TELEMETRY=off` or `lumi-scan telemetry off` to stop) is only an
anonymous delivery outcome after a paid call: seller host, delivered yes/no, a coarse status class and a random one-time token.
No wallet, amount, tx hash, query string or stable ID. **Tier 2** (off by default) sends full signed receipts and is the only thing
that earns credits. See the kit README.

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
| `LUMI_KIT_HOME` / `LUMI_KIT_CONFIG` | `~/.lumi-scanner-kit/config.json` | Kit config (telemetry and sharing switches) |
| `LUMI_CHECK_TELEMETRY` | on | `off` disables tier 1 outcome reports |
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

Testnet run, Oct 22 2026 (via MCP stdio, x402 on XRPL Testnet, all `tesSUCCESS`): `lumi_sentiment` 9137C1AE…, `lumi_macro_yen`
38DDADD0…, `lumi_events` EBD235D3…, `lumi_trades` 661D8180…, `lumi_brief` (markdown) 16F1BEFA….

## License

MIT
