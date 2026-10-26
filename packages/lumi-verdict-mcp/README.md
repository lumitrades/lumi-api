# lumi-verdict-mcp

**Check an x402 seller before your agent pays it.** A small MCP server (stdio) with one job: before your agent pays an x402 URL,
ask **[Lumi Trades](https://lumitrades.io)** for one signed label, based on Lumi's own paid test-buys on XRPL, Base and Stellar.
x402 seller trust you can verify. Works with Claude Desktop, Cursor, Claude Code, Cline, Windsurf and any other MCP client.

> Automated observations by Lumi, not a rating, endorsement or guarantee. Paying Lumi never changes a result.

## Tools

| Tool | Price (USD) | Input | What you get |
|---|---|---|---|
| `lumi_verdict` | $0.01 | `url` `payTo?` `amount?` | One label: `checks_passed` (Delivered in recent checks) / `check_first` (Check first) / `checks_failed` (Recent checks failed) / `no_data` (Not enough data), with as-of date, conclusive test-buy count, last delivered and failed dates, reason codes, evidence and appeal links. `label_live` is the label after Lumi contacts the seller at call time (an unpaid request) and compares its quote, price, payTo and TLS with Lumi's record. Signed by Lumi |
| `lumi_check_free` | free | `url` `payTo?` `amount?` | The same label from Lumi's record (cached, no live contact with the seller), signed by Lumi. Only the origin and path of the URL are sent |

`lumi_verdict` calls `GET https://api.lumitrades.io/v1/verdict` and pays per call via x402 **with your own wallet**:
USDC on Base (gasless) or XRP / RLUSD / USDC on the XRP Ledger, signed locally on your machine, within per-call caps and a session budget.
No API key, no account. The price is read live from each 402 quote. Without a wallet, `lumi_verdict` returns the price quote and pays nothing.
**You only pay when you get an answer:** bad input is refused before any quote (4xx, nothing charged), and the API answers 503 "Not charged." when it cannot answer.

Price, the proof behind each label and how to verify a signed answer: <https://lumitrades.io/prices/> (machine-readable: <https://lumitrades.io/prices.json>).

Want every Lumi tool (seller lookups, full reports, seller monitoring, the trust feed)? Use [`lumi-trades-mcp`](https://www.npmjs.com/package/lumi-trades-mcp).
This package reuses its payment code unchanged.

## Install

Requires Node 20+.

```bash
npx -y lumi-verdict-mcp
```

### Claude Desktop / Cursor / any MCP client (`mcpServers` JSON)

```json
{
  "mcpServers": {
    "lumi-verdict": {
      "command": "npx",
      "args": ["-y", "lumi-verdict-mcp"],
      "env": {
        "EVM_PRIVATE_KEY": "0x...your Base agent wallet key (holds USDC, no ETH needed)...",
        "LUMI_MAX_USD_PER_CALL": "0.05",
        "LUMI_SESSION_BUDGET": "0.50"
      }
    }
  }
}
```

Paying on the XRP Ledger instead: set `"XRPL_SEED": "sEd..."` (and optionally `"LUMI_PAY_ASSET": "RLUSD"` or `"USDC"`, default `XRP`) in place of `EVM_PRIVATE_KEY`.
Claude Code: `claude mcp add lumi-verdict -e EVM_PRIVATE_KEY=0x... -- npx -y lumi-verdict-mcp` (or `-e XRPL_SEED=sEd...`).

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `EVM_PRIVATE_KEY` | – | `0x` private key of **your** Base wallet that pays in USDC (gasless). Kept in memory only; never logged, returned to the model or sent anywhere (only the signature is sent). Use a dedicated low-balance agent wallet. |
| `XRPL_SEED` | – | Seed of **your** XRPL wallet that pays. Kept in memory only; never logged, returned to the model or sent anywhere. Use a dedicated low-balance agent wallet. |
| `LUMI_PAY_ASSET` | `XRP` if `XRPL_SEED` is set, else `BASE_USDC` | `BASE_USDC`, or `XRP`, `RLUSD`, `USDC` on the XRP Ledger |
| `LUMI_MAX_USD_PER_CALL` | `0.30` | Refuse any stablecoin quote above this |
| `LUMI_MAX_XRP_PER_CALL` | `0.25` | Refuse any XRP quote above this |
| `LUMI_SESSION_BUDGET` | `1` | Max total spend per server process, in the pay asset |
| `XRPL_NETWORK` | `xrpl:0` | `xrpl:0` mainnet, `xrpl:1` testnet |
| `LUMI_API_URL` | `https://api.lumitrades.io` | API base URL |
| `LUMI_EXPECTED_PAY_TO` | Lumi's wallets on the official API: `rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM` (XRPL mainnet), `0x5E617bac19912e6d212CB303ae84655E9E203532` (Base) | Refuse to pay any other address |

## Licence

MIT
