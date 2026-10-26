# Lumi API

**x402 seller trust you can verify.** Lumi Trades ([lumitrades.io](https://lumitrades.io)) checks x402 sellers before an agent pays them: a live pre-payment check of the seller's 402 quote, Lumi's own paid test-buys with signed receipts, and a one-line verdict. Paid checks cost $0.01 to $0.02 and settle through [x402](https://xrpl.org/docs/agents/agentic-payments-x402) v2 in XRP, RLUSD or USDC on the XRP Ledger, or in USDC on Base or Stellar. Discoverable over x402, OpenAPI, MCP and A2A.

> Automated observations by Lumi, not a rating, endorsement or guarantee. Information only, not financial advice. Paying never changes a score: seller-funded test-buys go into the seller's private monitoring history, not their public result.

## Quickstart

Free first: [`/v1/check`](https://api.lumitrades.io/v1/check?url=https://api.example.com/v1/data) (free cached pay-check), [`/v1/trust/vendors`](https://api.lumitrades.io/v1/trust/vendors) (seller observations), [`/v1/samples`](https://api.lumitrades.io/v1/samples) (labelled samples of every paid check), [`/llms.txt`](https://api.lumitrades.io/llms.txt). Open [api.lumitrades.io](https://api.lumitrades.io/) in a browser for the human quickstart.

**USDC on Base, official x402 fetch SDK** ([examples/base-x402-fetch.ts](examples/base-x402-fetch.ts)):

```ts
// npm i @x402/fetch @x402/evm viem
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`) });
const res = await wrapFetchWithPayment(fetch, client)("https://api.lumitrades.io/v1/trust/check?url=https://api.example.com/v1/data"); // $0.02, gasless
console.log(await res.json());
```

**Coinbase AgentKit, direct URL** ([examples/agentkit-direct-url.ts](examples/agentkit-direct-url.ts)). AgentKit 0.10.4's
`discover_x402_services` drops x402 v2 resources (it reads `metadata.description`; the Bazaar returns `description`), so call the URL:

```ts
// npm i @coinbase/agentkit viem
import { AgentKit, ViemWalletProvider, x402ActionProvider } from "@coinbase/agentkit";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const walletProvider = new ViemWalletProvider(createWalletClient({
  account: privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`), chain: base, transport: http(),
}));
const agentkit = await AgentKit.from({ walletProvider, actionProviders: [x402ActionProvider()] });
const act = (n: string) => agentkit.getActions().find((a) => a.name.endsWith(n))!;

const url = "https://api.lumitrades.io/v1/trust/check?url=https://api.example.com/v1/data";
const quote = JSON.parse(await act("make_http_request").invoke({ url }));          // 402 terms
const o = quote.acceptablePaymentOptions.find((x: any) => x.network === "eip155:8453"); // 20000 = $0.02 USDC
const paid = JSON.parse(await act("retry_http_request_with_x402").invoke({
  url, method: "GET",
  selectedPaymentOption: { scheme: o.scheme, network: o.network, asset: o.asset, amount: o.amount, payTo: o.payTo },
}));
console.log(paid.data);
```

**XRP Ledger** (XRP, RLUSD or USDC): [examples/agent-client.ts](examples/agent-client.ts) (`x402-xrpl`) and [examples/agent_client.py](examples/agent_client.py).

**MCP** (Claude Desktop, Cursor, any MCP client):

```json
{ "mcpServers": {
  "lumi-remote": { "url": "https://api.lumitrades.io/mcp" },
  "lumi": { "command": "npx", "args": ["-y", "lumi-trades-mcp"], "env": { "EVM_PRIVATE_KEY": "0x...", "LUMI_MAX_USD_PER_CALL": "0.02" } } } }
```

---

## Endpoints and pricing

| | Endpoint | Price | Returns |
|---|---|---|---|
| free | `GET /` | – | JSON index: description, payment config, endpoint list, prices |
| free | `GET /health` | – | Liveness, network, receiving address |
| free | `GET /skill.md` (also `/llms.txt`) | – | Agent guide: what is offered, prices, how to pay |
| free | `GET /.well-known/x402` | – | x402 discovery manifest |
| free | `GET /.well-known/trustline-merchant.txt` | – | t54 Trustline merchant file: Lumi's XRPL receiving wallet |
| free | `GET /openapi.json` | – | OpenAPI 3.1 with `x-payment-info` per paid route |
| free | `GET /v1/check?url=…` | – | Free cached pay-check for an x402 URL (allow / check_first / warn / block) |
| free | `GET /v1/trust/vendors` | – | Seller observations: quote checks and test-buy counts |
| free | `GET /v1/samples` | – | Truncated, labelled SAMPLE of every paid check |
| free | `POST /mcp` | – | Remote MCP server (Streamable HTTP) |
| free | `GET /.well-known/agent-card.json` | – | A2A agent card |
| free | `POST /a2a` | – | A2A JSON-RPC |
| **paid** | `GET /v1/verdict?url=…` | **$0.01** | One-line verdict for an x402 URL, with the evidence behind it |
| **paid** | `GET /v1/trust/check?url=…` | **$0.02** | Live pre-payment check: Lumi fetches the seller's 402 now and returns it with Lumi's test-buy history (tx hashes, delivered yes/no, signed receipts) |
| **paid** | `GET /v1/trust/vendors/{id}/report` | **$0.02** | Full observation history for one curated seller |

Every USD price is payable as RLUSD or USDC on the XRP Ledger, USDC on Base or USDC on Stellar (same amount), or the XRP equivalent.

**Never charged when Lumi cannot answer.** Bad input, an unknown seller or missing observations return 4xx/503 *before* any payment is requested, and a payment header sent anyway is ignored.

**Retired 2026-10-25.** Routes from earlier versions of this API answer `410 Gone` and never quote or charge, even when a payment header is sent.

### Seller plans

See [`/v1/monitor`](https://api.lumitrades.io/v1/monitor) for terms: Watch ($5 per endpoint per 30 days), Watch Pro ($20), Audit ($99 one-off), the Founder pack (24 test-buys for $5, first sellers only) and the Re-test pack (30 test-buys for $6.50). Seller-funded test-buys are private monitoring history and never change a public score; to have Lumi re-check a public result, ask for a free re-test at hello@lumitrades.io. Data access for platforms: Feed, Feed Pro, Feed credits and the platform licence ([`/v1/feed`](https://api.lumitrades.io/v1/feed)).

### Accepted assets

Every 402 offers the same quote in four options on two networks, all sharing one invoice id (one payment per invoice):

| `accepts[]` | Asset | `asset` field | Issuer (`extra.issuer`) | `amount` unit |
|---|---|---|---|---|
| 0 | XRP | `XRP` | – | drops |
| 1 | RLUSD (Ripple USD) | `524C555344000000000000000000000000000000` | `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De` ([docs.ripple.com](https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl)) | IOU value, e.g. `"0.01"` |
| 2 | USDC (Circle) | `5553444300000000000000000000000000000000` | `rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE` ([developers.circle.com](https://developers.circle.com/stablecoins/usdc-contract-addresses)) | IOU value, e.g. `"0.01"` |
| 3 | USDC on **Base** (`network: "eip155:8453"`) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | – (`extra: { name: "USD Coin", version: "2" }`, the EIP-712 domain) | atomic units, 6 decimals, e.g. `"10000"` = 0.01 |

Options 0-2 are on `xrpl:0` and pay `rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM`; option 3 pays Lumi's Base address `0x5E617bac19912e6d212CB303ae84655E9E203532`.

XRP stays first, so clients that take `accepts[0]` keep paying in XRP. Stablecoin prices are fixed in USD cents. At XRP ≈ $1.33 (Oct 22 2026), 0.01 USD ≈ 0.0075 XRP and 0.02 USD ≈ 0.015 XRP, so the XRP prices are slightly cheaper. Payers need a trust line to the issuer and a balance. The Payment is same-asset (`SendMax` = `Amount`, no path or conversion). Turn off either stablecoin with `ACCEPT_RLUSD=false` / `ACCEPT_USDC=false`. Testnet uses the official testnet issuers (`rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`, `rHuGNhqTG32mfmAvWA8hUyWRLV3tCSwKQt`), and `RLUSD_ISSUER` / `USDC_ISSUER` override them.

## How Lumi tests sellers

- **Free probes:** unpaid requests to seller endpoints that record whether a valid x402 v2 quote comes back, what it pays, the price and the latency. Probes never pay.
- **Paid test-buys:** Lumi buys from sellers with its own wallets on XRPL, Base and Stellar, within small daily caps. Every test-buy transaction is checked on-chain before it is stored, and each record carries a signed receipt.
- **Methodology:** [`/v1/trust/methodology`](https://api.lumitrades.io/v1/trust/methodology). Corrections: [`/v1/monitor/corrections`](https://api.lumitrades.io/v1/monitor/corrections).

## Run locally

Requires Node 20+.

```bash
npm install
npm test                 # vitest (mocked facilitator, fixture data)
npm run typecheck

# Plain Node (testnet config from env or .dev.vars)
XRPL_NETWORK=xrpl:1 PAY_TO=r... npm start          # http://127.0.0.1:8787

# Workers runtime locally (workerd + Durable Object)
cp .dev.vars.example .dev.vars                     # set INVOICE_SECRET (and PAY_TO via wrangler.toml [env.testnet])
npm run dev                                        # wrangler dev --env testnet
```

## Deploy

`npm run deploy` (Cloudflare Workers, custom domain `api.lumitrades.io`). Needs wrangler auth for the account that owns `lumitrades.io` and the `INVOICE_SECRET` secret. Smoke test: `curl https://api.lumitrades.io/health` and `curl -i https://api.lumitrades.io/v1/verdict?url=https://api.example.com/v1/data` (expect 402).

## Disclaimer

Lumi results are automated observations, not a rating, endorsement or guarantee. Information only, not financial advice.

## License

MIT. See [LICENSE](LICENSE).
