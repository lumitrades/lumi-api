# Lumi API

**Pay-per-call crypto market reads for AI agents, settled in XRP, RLUSD or USDC on the XRP Ledger, or in USDC on Base, via [x402](https://xrpl.org/docs/agents/agentic-payments-x402) v2. Discoverable over x402, OpenAPI, MCP and A2A.**

Lumi Trades ([lumitrades.io](https://lumitrades.io)) publishes three separate product lines: **Lumi Trust** (x402 seller pay-checks and vendor observations, below), **market data** (a BTC/macro backdrop, a daily market brief, a yen carry-trade watch, a sentiment snapshot and an events calendar, funding and Fear & Greed, plus a daily Institutional & Policy Brief that maps what central banks, regulators, banks and tokenization firms are doing to XRP, XLM, XDC, QNT, AXL and HBAR) and **Lumi Market Ideas** (indicator signals, the all-coins scan, support/resistance levels, a public paper-trade slate and its raw history; paper-trade analysis, not investment advice, and Lumi does not trade real money). Lumi API puts those reads behind HTTP 402. An agent calls an endpoint, gets a price in XRP (or a stablecoin, on the XRP Ledger or on Base), signs one small payment, retries, and receives JSON. XRPL is the home network and stays first in every quote; Base USDC is the bridge for EVM agents that already speak standard x402. There are no API keys, accounts or invoices to reconcile. The payment *is* the authentication, and every call leaves an auditable on-ledger record.

> Analytics and education only. Not financial advice. Trade ideas are paper trades.
>
> **Lumi Market Ideas** (`/v1/signal/{coin}`, `/v1/lite/{coin}`, `/v1/scan`, `/v1/levels/{coin}`, `/v1/slate`, `/v1/trades`): Paper-trade analysis, not investment advice. Lumi does not trade real money. Their responses carry `product_line: "Lumi Market Ideas"` and `notice` fields plus `X-Lumi-Product-Line` / `X-Lumi-Notice` headers (additive; prices and shapes unchanged).

## Quickstart

Free first: [`/v1/trust/vendors`](https://api.lumitrades.io/v1/trust/vendors) (x402 vendor trust observations), [`/v1/samples`](https://api.lumitrades.io/v1/samples) (truncated samples of every paid product), [`/v1/coins`](https://api.lumitrades.io/v1/coins),
[`/llms.txt`](https://api.lumitrades.io/llms.txt). Open [api.lumitrades.io](https://api.lumitrades.io/) in a browser for the human quickstart.

**USDC on Base, official x402 fetch SDK** ([examples/base-x402-fetch.ts](examples/base-x402-fetch.ts)):

```ts
// npm i @x402/fetch @x402/evm viem
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`) });
const res = await wrapFetchWithPayment(fetch, client)("https://api.lumitrades.io/v1/signal/XRP"); // $0.01, gasless
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

const url = "https://api.lumitrades.io/v1/signal/XRP";
const quote = JSON.parse(await act("make_http_request").invoke({ url }));          // 402 terms
const o = quote.acceptablePaymentOptions.find((x: any) => x.network === "eip155:8453"); // 10000 = $0.01 USDC
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
  "lumi": { "command": "npx", "args": ["-y", "lumi-trades-mcp"], "env": { "EVM_PRIVATE_KEY": "0x...", "LUMI_MAX_USD_PER_CALL": "0.30" } } } }
```

---

## Endpoints and pricing

| | Endpoint | Price | Returns |
|---|---|---|---|
| free | `GET /` | – | JSON index: description, payment config, endpoint list, prices |
| free | `GET /health` | – | Liveness, network, receiving address |
| free | `GET /skill.md` (also `/llms.txt`) | – | Agent guide: what's offered, prices, how to pay, example code |
| free | `GET /.well-known/x402` | – | x402 discovery manifest ([draft-hawkins-x402-dns-discovery](https://datatracker.ietf.org/doc/draft-hawkins-x402-dns-discovery/) shape) |
| free | `GET /openapi.json` | – | OpenAPI 3.1 with `x-payment-info` per paid route (x402scan-style discovery) |
| free | `GET /v1/coins` | – | Supported coins |
| free | `GET /v1/samples` | – | Truncated, labelled SAMPLE of every paid product (lists cut to 2, signal shows one timeframe, institutional = headline + big picture + 2 items + sources); cached 10 min |
| free | `POST /mcp` | – | Remote MCP server (Streamable HTTP): free tools for everyone; paid tools explain the price and how to pay |
| free | `GET /.well-known/agent-card.json` (also `/.well-known/agent.json`) | – | A2A agent card (A2A 1.0, with 0.3 compatibility fields): skills mirroring the endpoints, MCP URL, x402 payment networks |
| free | `POST /a2a` | – | A2A JSON-RPC (`SendMessage` 1.0, `message/send` 0.3): free skills answer inline; paid skills return the live x402 terms |

**Lumi Trust (paid)**

| | Endpoint | Price | Returns |
|---|---|---|---|
| **paid** | `GET /v1/trust/vendors/{id}/report` | **0.015 XRP** or **0.02 RLUSD / USDC** (0.02 USDC on Base) | **x402 vendor report**: Lumi's full observation history for one vendor on the trust list: every free 402-quote check (90-day retention), every paid test-buy with amount, tx hash, explorer link and delivered yes/no, latency min/p50/p90/p95/max and 7-day trend, uptime % (24h/7d/30d/90d) and daily series, quoted-price history, verified agent reports, vendor replies, score components, sample sizes and confidence labels. Unknown vendor: 404; no observation in 48 h: 503 (both before any 402, never charged). Owner bearer key: free |

**Market data (paid)**

| | Endpoint | Price | Returns |
|---|---|---|---|
| **paid** | `GET /v1/market` | **0.01 XRP** or **0.02 RLUSD / USDC** | BTC backdrop (levels, projection, signal), macro (yen/USDJPY note, total cap, dominance, fear & greed, BTC perp funding/OI), breadth |
| **paid** | `GET /v1/brief` | **0.015 XRP** or **0.02 RLUSD / USDC** | Today's market brief (what the newsletter and Shorts say): BTC price/levels/signal, CoinMarketCap Fear & Greed, funding, top/bottom movers, key levels for all 13 coins, yen watch, events in the next 48h, active paper trades, sourced news. JSON with a `markdown` field; `?format=md` returns `text/markdown` |
| **paid** | `GET /v1/macro/yen` | **0.0075 XRP** or **0.01 RLUSD / USDC** | USD/JPY + Nikkei 225 (price, 1d/5d change, ranges), rule-based carry-trade risk (`low`/`watch`/`elevated`) around the 155 line with reasons, Lumi's yen note, Japan events (CPI, BOJ), sources |
| **paid** | `GET /v1/sentiment` | **0.0038 XRP** or **0.005 RLUSD / USDC** | CoinMarketCap Fear & Greed (value, band, change), BTC perp funding + plain-English read + OI (OKX), total cap/volume/dominance, breadth and signal-label counts |
| **paid** | `GET /v1/events` | **0.0038 XRP** or **0.005 RLUSD / USDC** | Sourced upcoming macro/crypto events: timed releases (UTC + US Central, why it matters) and dated per-coin catalysts (Fed, BOJ, CPI, upgrades, conferences) |
| **paid** | `GET /v1/institutional` | **$0.10**: 0.10 RLUSD / USDC (XRPL, Base or Stellar) or the XRP equivalent (default 0.077 XRP, live-priced) | **Institutional & Policy Brief** (daily): sourced analysis of what BIS, IMF, US Treasury/OCC, Fed, SEC, CFTC, JPMorgan (Kinexys), SBI, Cross River, Securitize, R3 and others are doing, mapped to XRP, XLM, XDC, QNT, AXL and HBAR. Each item: date, source URL, why it matters, coins, impact, confidence and `link_type` (`confirmed` / `indirect_alignment` = Lumi's analysis / `context`). Plus big picture, per-token map, connections, no-news notes, what to watch. JSON with `markdown`; `?format=md` returns `text/markdown`. Not sold if older than 36 h |

**Lumi Market Ideas (paid).** Paper-trade analysis, not investment advice. Lumi does not trade real money. Also `/v1/lite/{coin}` and `/v1/scan` (see `/openapi.json`, tag "Lumi Market Ideas").

| | Endpoint | Price | Returns |
|---|---|---|---|
| **paid** | `GET /v1/signal/{coin}` | **0.005 XRP** or **0.01 RLUSD / USDC** | Buy/sell label + score, 1h/4h/1d labels, indicator summary (RSI, MACD, EMA stack, Bollinger, StochRSI, volume) |
| **paid** | `GET /v1/levels/{coin}` | **0.005 XRP** or **0.01 RLUSD / USDC** | Support/resistance, bias, 7-day bull/base/bear projection, commentary, catalysts, sources |
| **paid** | `GET /v1/slate` | **0.01 XRP** or **0.02 RLUSD / USDC** | Active paper-trade ideas (entry/zone, stop, targets, leverage, conviction, status), "no setup" notes |
| **paid** | `GET /v1/trades` | **0.01 XRP** or **0.02 RLUSD / USDC** | Raw paper-trade history: every idea ever posted with entry, stop, targets, leverage, status and reasoning (no aggregate scorecard) |

Pricing rationale (Oct 2026, XRP ≈ $1.33): single data feeds on the XRPL AI Hub sell for 0.001-0.012 RLUSD (AskSurf, Heurist Mesh, KR Crypto) and composite reads for ~0.02-0.025 (Strale Fear & Greed via Monid, invinoveritas). Lumi's quick reads sit at $0.003-$0.005, single feeds at $0.01 and the multi-source brief at $0.02 (v1.0). The daily Institutional & Policy Brief is $0.10 (lowered from $0.25 on Oct 23 2026, and now included in the free trial): exactly 0.10 RLUSD / USDC (XRPL, Base or Stellar); the XRP default is **0.077 XRP** (0.10 / 1.30), repriced from the live rate when `XRP_PRICING=live`.

### You only pay when you get data

Other x402 vendors have taken payment and then returned an upstream error or an empty body. Lumi API is built so that cannot happen:

1. Every input file an endpoint needs is fetched and **validated before any 402 quote is issued**: present, non-empty, and fresh (market data ≤ 12 h old, `DATA_MAX_AGE_HOURS`; hand-written analysis/events ≤ 48 h; FX/Nikkei quotes ≤ 4 days).
2. The response body is **built before settlement** and must carry real content (e.g. a Fear & Greed value for `/v1/sentiment`, a USD/JPY or Nikkei quote for `/v1/macro/yen`).
3. If anything fails, the answer is `503` `{ "error": "data_stale" | "data_unavailable", "note": "Not charged." }` with **no** `PAYMENT-REQUIRED` header. A payment header sent anyway is ignored (the facilitator is never called), even for a quote issued earlier while the data was fresh.
4. Settlement happens only after these checks; the prepared body is returned immediately after a validated `tesSUCCESS`.

Fields that are unavailable are omitted, never guessed. Tests: `test/products.test.ts` ("you only pay when you get data").

`{coin}`: `XRP XLM HBAR XDC AXL ZBCN BTC ETH SOL DOGE ADA LINK SUI`. Tickers or CoinGecko ids work, case-insensitive.
Every RLUSD / USDC price above is also payable as **USDC on Base** (same amount). Prices are configurable (`PRICE_*_XRP`, `PRICE_*_RLUSD`, `PRICE_*_USDC` in `wrangler.toml`; Base follows `PRICE_*_USDC` unless `PRICE_*_BASE_USDC` is set).

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

To pay in a stablecoin with `x402Fetch`, pass a `paymentRequirementsSelector` that picks the option by `asset` and `extra.issuer`. The SDK's numeric `maxValue` compares raw `amount` strings across assets, so it is not a meaningful cap for IOUs. See `/skill.md`.

Every paid response includes `timestamp`, `source: "lumitrades.io"`, a `payment` block (network, tx hash, payer, explorer link) and a `disclaimer`.

**You are never charged for a failed request.** Unknown coins return 404 and upstream outages return 503 *before* any payment is requested. Data is only served after a validated `tesSUCCESS` settlement.

## How agents pay (x402 v2, `exact` scheme on XRPL)

```
Agent                          Lumi API (Worker)                 T54 facilitator         XRP Ledger
  | GET /v1/signal/XRP              |                                  |                      |
  |-------------------------------->|                                  |                      |
  | 402 + PAYMENT-REQUIRED          |  (stateless HMAC invoice id)     |                      |
  |<--------------------------------|                                  |                      |
  | sign Payment(20000 drops,       |                                  |                      |
  |  SourceTag, Memo=invoiceId,     |                                  |                      |
  |  InvoiceID=sha256(invoiceId))   |                                  |                      |
  | GET + PAYMENT-SIGNATURE         |                                  |                      |
  |-------------------------------->| check invoice HMAC/expiry/route  |                      |
  |                                 | POST /verify ------------------->|                      |
  |                                 | claim invoice (Durable Object)   |                      |
  |                                 | POST /settle ------------------->| submit blob -------->|
  |                                 |<---------------- tesSUCCESS -----|<---- validated ------|
  | 200 JSON + PAYMENT-RESPONSE     |                                  |                      |
  |<--------------------------------|                                  |                      |
```

1. **Challenge.** An unpaid request gets `402` with an x402 v2 `PaymentRequired` in the body and in the base64 `PAYMENT-REQUIRED` header:
   ```json
   { "scheme": "exact", "network": "xrpl:0", "asset": "XRP", "amount": "20000",
     "payTo": "rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM", "maxTimeoutSeconds": 300,
     "extra": { "invoiceId": "lumi1.signal:XRP.<exp>.<nonce>.<mac>", "sourceTag": 804681468 } }
   ```
2. **Pay.** The agent signs (but does not submit) an XRPL `Payment` for exactly `amount` drops to `payTo`, bound to the invoice (Memo + `InvoiceID`), and retries with `PAYMENT-SIGNATURE`.
3. **Settle.** Lumi API checks the invoice, then has the facilitator verify and submit the blob. On a validated `tesSUCCESS` it returns the data and a `PAYMENT-RESPONSE` receipt `{ success, transaction, network, payer }`.

Agents don't have to implement this by hand. The reference XRPL SDKs (`x402-xrpl` on npm and PyPI, maintained by T54) handle it end to end:

```ts
import { Wallet } from "xrpl";
import { x402Fetch } from "x402-xrpl";

const fetchPaid = x402Fetch({ wallet: Wallet.fromSeed(process.env.XRPL_SEED!), network: "xrpl:0", maxValue: "100000" });
const res = await fetchPaid("https://api.lumitrades.io/v1/signal/XRP");
console.log(await res.json());
```

```python
from xrpl.wallet import Wallet
from x402_xrpl.clients import x402_requests
s = x402_requests(Wallet.from_seed(SEED), rpc_url="https://xrplcluster.com/", network_filter="xrpl:0", scheme_filter="exact")
print(s.get("https://api.lumitrades.io/v1/market", timeout=180).json())
```

See `examples/agent-client.ts`, `examples/agent_client.py` and the live `/skill.md`.

### Paying with USDC on Base (x402 v2, `exact` scheme on EVM)

The last `accepts[]` entry is a standard x402 v2 EVM requirement, so the official x402 clients work unchanged and skip the XRPL options:

```json
{ "scheme": "exact", "network": "eip155:8453", "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "amount": "10000",
  "payTo": "0x5E617bac19912e6d212CB303ae84655E9E203532", "maxTimeoutSeconds": 300,
  "extra": { "name": "USD Coin", "version": "2", "invoiceId": "lumi1.signal:XRP.<exp>.<nonce>.<mac>", "symbol": "USDC", "decimals": 6 } }
```

The agent signs an EIP-3009 `transferWithAuthorization` (no gas, no ETH needed) and retries with
`PAYMENT-SIGNATURE: base64({ x402Version: 2, accepted, payload: { signature, authorization } })`. Lumi API checks the invoice and the
authorization locally (recipient, exact amount, validity window), has the [Coinbase CDP facilitator](https://docs.cdp.coinbase.com/x402/welcome)
verify it (falling back to the keyless [PayAI facilitator](https://facilitator.payai.network) if CDP is unreachable or errors), claims the invoice **and** the authorization nonce in the Durable Object guard, then settles. Same receipt, same error semantics,
same "never charged on stale data" rule as XRPL.

```ts
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`) });
const res = await wrapFetchWithPayment(fetch, client)("https://api.lumitrades.io/v1/brief");
console.log(await res.json());
```

Why CDP first (since v0.8): payments settled through Coinbase's CDP facilitator get the endpoint listed in the
[x402 Bazaar](https://docs.cdp.coinbase.com/x402/bazaar), the discovery index that x402 clients and agent wallets search. Every paid 402
carries an `extensions.bazaar` block (input schema, path/query parameters, a sample JSON output and its JSON Schema, and a `routeTemplate`
such as `/v1/signal/:coin` so all coins list as one resource) plus a `resource.description` of at most 500 characters. The Worker signs a
short-lived (120 s) Ed25519 JWT per facilitator request with Web Crypto; the CDP key is a Worker secret, never in the repo.

Fallback: if CDP fails for a facilitator-side reason (network error, 401/403/404, 408/429/5xx, malformed reply, or a rejection about the
extension or requirements rather than the payment), the same signed payment goes to PayAI, which needs no key. A failed settle only
falls back when CDP returned no transaction hash; EIP-3009 authorizations execute at most once on-chain, so a payment can never be taken
twice. Payment problems (insufficient funds, bad signature, expired authorization) are final and return a fresh 402, with no fallback.
`EVM_FACILITATOR = "fallback"` turns CDP off; `EVM_FACILITATOR_URL` switches the fallback facilitator.

### Error semantics (same as the reference middleware)

| Status | Meaning | Agent action |
|---|---|---|
| 402 + `error` | No/invalid/expired/used invoice, or the facilitator rejected the payment | Pay the fresh quote in the body |
| 503 `retryable: true, phase: verify, settlementAttempted: false` | Facilitator or guard unavailable before any money moved | Retry the same header after `Retry-After` |
| 409 `settlement_status_unknown` | Settlement may have happened | Look up your tx on the ledger before paying again |
| 404 / 503 with `"note": "Not charged."` | Bad coin / upstream data down | Fix the request or retry later |

## Design notes

- **Runs on Cloudflare Workers** (`src/index.ts`) and on **plain Node** (`src/node.ts`) from the same `createApp()` (`src/app.ts`). The only runtime dependency in the Worker bundle is `@x402/core` (its x402 v2 schemas validate Base payment payloads); the bundle is about 62 KiB gzipped.
- **Two payment networks, one invoice.** XRPL options come first and use the unchanged T54 flow; the Base option (`src/x402.ts`, `requireEvmPayment`) uses its own facilitator URL. Tests drive it with the official `@x402/fetch` + `@x402/evm` client and real EIP-3009 signatures against mocked facilitator responses, and check our requirement constants against `@x402/evm`'s own price parser.
- **Wire-compatible with the XRPL reference implementation.** `src/x402.ts` mirrors T54's FastAPI/Express `require_payment` middleware (x402 v2 headers, `/verify` then `/settle`, typed 503/409 errors). The official npm and PyPI buyer SDKs work against it unchanged. Both were exercised on testnet.
- **Stateless invoices.** Workers isolates share no memory, so the reference SDK's in-memory invoice store can't be used. Invoice ids are HMAC tokens (`INVOICE_SECRET`) that bind route, amount, network, `payTo` and expiry. Any isolate can validate them, and a quote for `/v1/signal/XRP` can't be redeemed on `/v1/slate`.
- **One-time redemption via a Durable Object** (`src/invoice-guard.ts`). This is required. On testnet, the T54 facilitator returns `success: true` again when an already-settled blob is resubmitted, because XRPL submission is idempotent on the tx hash. `npm run probe:replay` reproduces this. Without a resource-server guard, one payment could be replayed for unlimited data. The guard atomically claims each invoice id before `/settle`. It is sharded 16 ways and expires entries with alarms. SQLite-backed DOs are on the Workers Free plan.
- **Privacy filter** (`src/sanitize.ts`). Every field is whitelisted per endpoint (`src/views.ts`). Free text is then filtered sentence by sentence to drop anything mentioning a configured private name (`PRIVATE_NAMES` secret) or personal holdings/positions, and sensitive keys are dropped recursively. Tests inject canaries to prove it.
- **Short cache.** Upstream `lumitrades.io/data/*.json` is cached for 60s per isolate (`DATA_TTL_SECONDS`), with up to 15 minutes of stale fallback.
- **On-ledger metrics.** Every payment carries `SourceTag 804681468 (the T54 facilitator tag that the XRPL AI Hub counts)` and is sent to Lumi's wallet, so usage can be counted from public ledger data. Each settlement also logs an `x402_settled` JSON line in Workers Logs.

## Run locally

Requires Node 20+.

```bash
npm install
npm test                 # 27 unit/integration tests (mocked facilitator, fixture data)
npm run typecheck

# Plain Node (testnet config from env or .dev.vars)
XRPL_NETWORK=xrpl:1 PAY_TO=r... npm start          # http://127.0.0.1:8787

# Workers runtime locally (workerd + Durable Object)
cp .dev.vars.example .dev.vars                     # set INVOICE_SECRET (and PAY_TO via wrangler.toml [env.testnet])
npm run dev                                        # wrangler dev --env testnet
```

## Testnet demo (repeatable)

```bash
npm run demo:testnet
```

The demo does the following:
1. creates two throwaway **testnet** wallets via the XRPL faucet (payer and receiver) on first run, stored only in `.testnet/wallets.json`, which is git-ignored and mode 600
2. starts Lumi API in-process with testnet config and the T54 testnet facilitator
3. sends `GET /v1/signal/XRP` and gets **402** with the requirements
4. signs the Payment with the `x402-xrpl` SDK, retries, and gets **200** with data and a `PAYMENT-RESPONSE` receipt
5. replays the same `PAYMENT-SIGNATURE` and gets **402 `invoice_already_used`**
6. runs the one-line agent flow `x402Fetch(/v1/market)` and gets **200**
7. checks both transactions on the ledger (validated, `tesSUCCESS`, destination, amount, the SourceTag, invoice memo) and writes a transcript to `demo/`

To run it against the Workers runtime instead: `npm run dev` in one shell, then `LUMI_API_URL=http://127.0.0.1:8787 npm run demo:testnet`.

Recorded runs (Oct 22 2026), all validated `tesSUCCESS` on XRPL Testnet (the first five at the launch prices of 0.02/0.05 XRP, the last two at the current 0.005/0.01 XRP):

| Run | Endpoint | Amount | Tx |
|---|---|---|---|
| Node | `/v1/signal/XRP` | 0.02 XRP | [D1575C79…3A38EA](https://testnet.xrpl.org/transactions/D1575C79856EF71080F9118B0E3228C397021002D26EAAA9EED300BCA13A38EA) |
| Node | `/v1/market` (x402Fetch) | 0.05 XRP | [59790423…70A4](https://testnet.xrpl.org/transactions/59790423E951F3FA9DD32BA026CEED66CED895DB4232800A072E9E8C3DF870A4) |
| workerd (`wrangler dev`) | `/v1/signal/XRP` | 0.02 XRP | [2E7E0E11…402591](https://testnet.xrpl.org/transactions/2E7E0E119548B9C96F16359BAFABB0A2906EF2F0FD2326473A91042286402591) |
| workerd (`wrangler dev`) | `/v1/market` (x402Fetch) | 0.05 XRP | [E4165025…21BB90](https://testnet.xrpl.org/transactions/E41650253754E23A613C4D593D2B4B2654C7581BB64AFD397D6EE3526A21BB90) |
| Python SDK client | `/v1/levels/XRP` | 0.02 XRP | [355244D3…683F70](https://testnet.xrpl.org/transactions/355244D3602E67D7BF87CB2920B609CF74DF9E9C63B01005F27B020823683F70) |
| Node (current prices) | `/v1/signal/XRP` | 0.005 XRP | [70B12A01…FB2A6E](https://testnet.xrpl.org/transactions/70B12A01E8D8E51E5E9755C858AC94DCB5360BE996C96A6242DF92B994FB2A6E) |
| Node (current prices) | `/v1/market` (x402Fetch) | 0.01 XRP | [4510B9AE…2E7C97](https://testnet.xrpl.org/transactions/4510B9AE3D4B2751D55CB54634DAA4B6C6148809A9E609EE53574C97562E7C97) |

Stablecoin runs (`npm run demo:testnet:stablecoin`, `DEMO_ASSET=RLUSD|USDC`), Oct 22 2026, through the T54 testnet facilitator. Both validated `tesSUCCESS`, and replay was refused:

| Asset | Endpoint | Price | Tx |
|---|---|---|---|
| RLUSD (`524C55…`) | `/v1/slate` | 0.02 | [336D4368…7016D8](https://testnet.xrpl.org/transactions/336D4368F784BC8454A01DCEBBF66F29D8D64878D1C31A712AA865A1BD7016D8) |
| USDC (`555344…`) | `/v1/slate` | 0.02 | [E6C88B93…011F10](https://testnet.xrpl.org/transactions/E6C88B93493DFC6E3450753066008345AC9587FA303EA953276D07E5E0011F10) |

The official testnet faucets for RLUSD (tryrlusd.com, login) and USDC (faucet.circle.com, reCAPTCHA) cannot be scripted. These runs therefore use a **stand-in testnet issuer** (`rhkAVriskfs45BnuJ49jx2GVa9M7Szh9nu`) that issues the same 40-hex currency codes, with the API pointed at it through `RLUSD_ISSUER` / `USDC_ISSUER`. The API, SDK and facilitator run the same IOU code path. `STANDIN=0` uses the official testnet issuer once the payer has been funded from a faucet.

Settle latency was about 6 to 7 s per paid call, including XRPL validation. Full transcripts are in `demo/`.

### Mainnet demo (labeled, self-payment)

> **DEMO:** both wallets belong to Lumi. This shows the live flow working and is **not** organic usage. Exclude it from usage metrics.

`npm run demo:buyer:create` generates a demo-buyer wallet. The seed goes to a mode-600 file outside the repo and the script prints only the address. `DEMO_CONFIRM=yes npm run demo:mainnet` makes one capped XRP x402 call to `api.lumitrades.io` and logs the transaction.

| Date | From (demo buyer) | Endpoint | Amount | Tx |
|---|---|---|---|---|
| 2026-10-22 | `rpvsTYDZmX1j1ndmEFG6YjjZZwp6VRtQRz` | `/v1/signal/XRP` | 0.005 XRP | [356E5C91…4C37E5](https://livenet.xrpl.org/transactions/356E5C9147B4B5D6C1F275C172EF8652E9C082458BAEC4204B569986714C37E5) (`tesSUCCESS`, SourceTag 804681468, 7.4 s) |

## Deploy to `api.lumitrades.io` (Cloudflare Workers)

`wrangler.toml` is ready: mainnet config, custom domain `api.lumitrades.io`, Durable Object binding and migration.

1. Authenticate wrangler with **one** of:
   - `npx wrangler login` (browser OAuth with the Cloudflare account that owns `lumitrades.io`), or
   - `export CLOUDFLARE_API_TOKEN=...` with a token scoped to that account and the `lumitrades.io` zone with **Account › Workers Scripts: Edit**, **Zone › Workers Routes: Edit**, **Zone › DNS: Edit** and **Zone › Zone: Read**. Also set `CLOUDFLARE_ACCOUNT_ID`.
2. `npx wrangler secret put INVOICE_SECRET` (a long random string, e.g. `openssl rand -hex 32`)
3. Optional staging first: `npm run deploy:testnet` (testnet, `lumi-api-testnet.<account>.workers.dev`)
4. Trust layer: `npx wrangler d1 create lumi_trust` (put the id in `wrangler.toml`), then
   `npx wrangler d1 migrations apply lumi_trust --remote`. The `*/30 * * * *` Cron Trigger runs the free probes.
5. `npm run deploy`. Wrangler creates the `api.lumitrades.io` DNS record and certificate, because `custom_domain = true`.
6. Smoke test: `curl https://api.lumitrades.io/health` and `curl -i https://api.lumitrades.io/v1/signal/XRP` (expect 402).

### Mainnet configuration

| Var | Value |
|---|---|
| `XRPL_NETWORK` | `xrpl:0` |
| `PAY_TO` | `rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM` (Lumi's receiving wallet; the server only needs the address) |
| `FACILITATOR_URL` | `https://xrpl-facilitator-mainnet.t54.ai` |
| `SOURCE_TAG` | `804681468` (T54 facilitator tag, counted by the XRPL AI Hub) |
| `INVOICE_SECRET` | secret, required on mainnet (startup refuses without it) |
| `PRIVATE_NAMES` | optional secret: comma-separated names scrubbed from paid responses (`npx wrangler secret put PRIVATE_NAMES`) |
| `OWNER_MCP_KEY` | optional secret (32+ chars): operator key for the remote MCP endpoint; paid tools return data free (`npx wrangler secret put OWNER_MCP_KEY`) |
| `LUMI_CHECK_SIGNING_KEY` | Lumi Check secret (scanner-kit-v0): Ed25519 seed that signs check answers, receipts and badge verdicts; its public key is pinned in the clients. Set at deploy time (`npx wrangler secret put LUMI_CHECK_SIGNING_KEY`). See [docs/lumi-check-keys.md](docs/lumi-check-keys.md) |
| `CONTRIB_ADMIN_KEY` | Lumi Check secret (scanner-kit-v0): separate admin credential for the contributor owner routes, never the signing key (falls back to `OWNER_MCP_KEY`). Set at deploy time (`npx wrangler secret put CONTRIB_ADMIN_KEY`) |
| `EVM_NETWORK` | `eip155:8453` (Base mainnet; testnet env uses `eip155:84532`, Base Sepolia) |
| `EVM_PAY_TO` | `0x5E617bac19912e6d212CB303ae84655E9E203532` (Lumi's Base receiving address; address only). Unset = no Base option |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | secrets (`npx wrangler secret put ...`): Coinbase CDP Secret API Key (Ed25519). With both set, Base USDC verifies and settles through the CDP facilitator |
| `EVM_FACILITATOR` | `cdp` (default; uses CDP when its key is set) or `fallback` (keyless facilitator only) |
| `EVM_FACILITATOR_URL` | fallback facilitator: `https://facilitator.payai.network` (testnet: `https://x402.org/facilitator`) |
| `ACCEPT_BASE_USDC` | `true`; `false` removes the Base option |

The server never holds a private key. The payer signs, the facilitator submits, and XRP (or RLUSD/USDC) lands in `PAY_TO`; Base USDC lands in `EVM_PAY_TO`. `PAY_TO` needs RLUSD and USDC trust lines to receive stablecoins. Lumi's mainnet wallet has both (limit 1,000,000 each).

## Data inputs

All paid data comes from Lumi's own published JSON files under `https://lumitrades.io/data/` (for example
[`https://lumitrades.io/data/prices.json`](https://lumitrades.io/data/prices.json); the folder itself has no index page): `prices`, `signals`, `analysis`, `trades`, `context`
(total cap, dominance, CoinMarketCap Fear & Greed, OKX BTC funding/OI, and USD/JPY + Nikkei from Yahoo Finance) and, since v0.2,
`events.json` + `brief.json` (generated by the site's `scripts/brief.py` from the newsletter and the Shorts' sourced news/event notes).
Since v0.5, `/v1/institutional` reads `institutional_brief.json`, written once a day by Lumi's research routine and published with the
site's `scripts/publish.sh`. Required: `generated_utc` (ISO 8601 UTC, the freshness clock: older than 36 h = 503 "Not charged."),
`date`, `big_picture[]` (≥1), and `items[]` and/or `no_notable_news[]`. Items need `entity`, `headline` and an http(s) `source_url`
(items without one are dropped) plus `date`, `why_it_matters`, `coins[]`, `link_type` (`confirmed` | `indirect_alignment` | `context`),
optional `link_basis`, `additional_sources[]`, `impact` (`bullish|neutral|bearish|mixed`), `confidence` (`high|medium|low`). Optional:
`coverage_window {from,to}`, `alignments[]` (Lumi's overlap analysis, both sides quoted and sourced: `entity, coin, theme, institution_says,
institution_source_url, token_says, token_source_url, overlap, confidence`), `theses[]` (`title, text, evidence_this_window, sources[]`,
always labelled analysis, never fact), `connections[]`, `watch_next[]`, `markdown` (else rendered), `disclaimer`.

## Trust layer v0: x402 vendor observations (free)

Lumi publishes its own automated observations of other x402 sellers on the XRP Ledger, so agents can see how an endpoint has actually
answered before they pay it. These are observations with timestamps, tx hashes and sample sizes, not ratings or reviews of a business.

| Endpoint | What |
|---|---|
| `GET /v1/trust/vendors?url=…` / `?domain=…` / `?payTo=…` | Look up any x402 seller before paying: the full CDP x402 Bazaar catalog (ingested daily; live counts at `/v1/trust/catalog`) with free unpaid 402-quote checks on a rotating schedule (valid quote, price and payTo vs listing, latency, RDAP domain age) labelled **quote-verified, low confidence**, plus Lumi's on-chain-confirmed test-buys labelled **purchase-verified**. No match: `{observed:false, note}` (not a negative signal). Lumi itself: "self, not scored" |
| `GET /v1/trust/catalog` | Browse the catalog (`?after=&limit=`, or `?popular=1&max_usd=0.05`) with counts by tier |
| `GET /v1/trust/vendors` | Every allowlisted vendor (allowlist order, not ranked): score, confidence, sample sizes, last paid observation with evidence, latest probes |
| `GET /v1/trust/vendors/{id}` | One vendor: listed endpoints and pay-to addresses, score components, up to 50 observations, latest probe per endpoint, verified agent reports, vendor replies |
| `GET /v1/trust/methodology` | The full method below, as JSON |
| `POST /v1/reports` | Agent report of a paid call (shown and scored only when verified) |
| `POST /v1/tips` | Private tip to Lumi. Stored privately; never shown, published, or returned anywhere |
| `POST /v1/trust/replies` | Vendor right to reply (signed), or email hello@lumitrades.io |
| `POST /v1/trust/observations` | Owner only (`OWNER_MCP_KEY` bearer): record a Lumi test-buy; the tx is checked on-ledger before it is stored |
| `POST /v1/trust/probe` | Owner only: run the free probes now |

Also as the MCP tool `lumi_vendor_scores` (optional `vendor_id`) and the A2A skill `vendor_trust`.

**Paid detailed report (v0.7):** `GET /v1/trust/vendors/{id}/report`, $0.02 per call over x402 on every rail (0.015 XRP fixed at XRP ~= $1.32, like
`PRICE_INSTITUTIONAL_XRP`; override with `PRICE_VENDOR_REPORT_XRP/_RLUSD/_USDC`). Full history instead of the free summary's last 50 test-buys and latest
probes. Sold only when Lumi has observed the vendor (probe or test-buy) in the last 48 h; otherwise 503, not charged. `Authorization: Bearer <OWNER_MCP_KEY>`
reads it free. MCP: `lumi_vendor_report` (`vendor_id`). A2A: `vendor_report`. The free endpoints above are unchanged.

### Methodology

- **Free probes (every 30 min, Cron Trigger).** One unpaid request to each listed endpoint (`User-Agent: LumiTrustProbe/0.6`, 15 s timeout,
  never any payment header). Recorded: HTTP status, whether it is a valid x402 v2 quote with an `xrpl:0` option paying an address listed for
  that vendor, price and asset, whether the quote carries a `sourceTag`, latency. Probes older than 90 days are pruned.
- **Paid test-buys (periodic, from Lumi's own XRPL wallet, run from the operator's box, never from the Worker).** Single calls on a vendor's
  cheapest listed endpoint, within shared caps (not every vendor every day): hard caps of about $0.50 a day (0.40 RLUSD + 0.10 XRP in total), and no endpoint priced above 0.05. Each record shows the amount,
  asset, ledger tx hash, HTTP status, whether the response contained data, and latency. The Worker re-checks every tx on the ledger (sender is
  Lumi's wallet, recipient is a listed pay-to address, amount and asset match) before storing it. The Worker holds no key.
- **"Contained data"** = 2xx and a non-empty body for that endpoint (e.g. a non-empty result list). Error bodies, empty lists and empty
  objects count as no data.
- **Score (0-100, last 30 days)** = weighted mean of the components that have data: delivery 0.5 (delivered / paid test-buys), uptime 0.2
  (valid quotes / probes), latency 0.15 (`1 - (median_ms - 500) / 4500`, clipped to 0..1), agent reports 0.15 (`P / (P + N)`).
- **Confidence:** low with fewer than 5 paid test-buys or fewer than 10 probes; medium below 20 paid test-buys; otherwise high.
- **Agent reports** count only when verified: the payment is validated on-ledger (tesSUCCESS, sent by `reporter`, delivered to a listed pay-to
  address, within 7 days; XRPL or USDC on Base) **and** the payer signs `lumi-report:<network>:<tx_hash>` (XRPL: `ripple-keypairs`
  `sign(utf8hex(challenge), privateKey)`, checked against the tx's `SigningPubKey`; Base: EIP-191 `personal_sign`). Unverified submissions get
  422 and are stored privately for abuse review; they are never shown or scored. A verified report is shown at once and counts after a 24 h
  hold; at most 1 per reporter per day and 5 per 30 days count; a negative report weighs 1.5 when a Lumi test-buy within 6 h also returned no
  data. One verified report per tx.
- **Right to reply.** Every vendor entry carries `right_to_reply`. A vendor signs `lumi-reply:<vendor_id>:<sha256 hex of the text>` with the key
  of a listed pay-to address (XRPL master key or RegularKey, with `public_key`; or EIP-191 for a listed Base address) and POSTs
  `{vendor_id, text, network, address, public_key?, signature}` to `/v1/trust/replies`, or emails hello@lumitrades.io. Verified replies are
  shown with the entry.
- **Wording.** Entries are factual: e.g. "paid <amount> RLUSD on <ISO time>, tx <hash>, HTTP <status>, response contained no data".
- **Abuse limits.** Bodies up to 16 KB; per-IP limits keyed on a salted HMAC of the IP (reports 5/min, 20/day; tips 3/min, 10/day; replies
  3/min, 10/day) plus global daily caps. Response excerpts, tips and IP hashes are never served.
- **Storage.** Cloudflare D1 (`lumi_trust`, migrations in `migrations/`). `0002` seeds Lumi's real paid buys of 2026-10-22. Without a D1
  binding (Node server, tests, testnet env) an in-memory store with the same seed is used.
- **Allowlist:** `src/vendors.ts`. Lumi does not list or score itself.

### Daily test-buys (operator box)

`/workspace/tools/trust_testbuys.ts` (outside this repo, next to the wallet tooling) buys once per allowlisted vendor within the caps above,
logs to `notes/trust_testbuys.log`, and posts each result to `POST /v1/trust/observations` with the owner key. Secrets are read from files
and never printed.

**Who jumps the queue (free and paid checks are identical).** Any Lumi check of an exact listing, free
(`GET /v1/trust/vendors?url=…`, the `/v1/trust/check` free trial) or paid (`/v1/trust/check`), sends the same signal: if the verdict
finds one of the objective signals in `BUY_SIGNALS` (from Lumi's own records and public data only; `pay_to_mismatch`
is excluded because it depends on the payTo the caller enters, so who ran the check never matters) and the listing is a Base seller (host) Lumi has never conclusively test-bought, it is added to the buy queue
(`GET /v1/trust/catalog/buy-queue`), which `catalog_buys.ts --daily` puts first on the next day's Base list. Limits, the same for both:
one slot per seller per 30 days (`PRIORITY_SELLER_DAYS`; repeat checks add nothing), at most `TRUST_PRIORITY_DAILY_CAP` sellers per UTC day (default 5,
`0` = off; D1 table `buy_priority`, migration `0024`). An unpaid 402 quote never queues. Paying Lumi never changes this order.

## Sales ledger (owner-only)

Every settled payment (XRPL and Base) writes one row to the D1 `sales` table (migration `0003_sales.sql`): route, rail,
asset, amount, list USD, payer, tx, time and `is_test` (payments from Lumi's own wallets, i.e. test-buys and Bazaar
refreshes). `GET /v1/owner/sales` with `Authorization: Bearer <OWNER_MCP_KEY>` returns today (UTC), 7-day, 30-day,
by-route and by-rail totals, excluding test wallets (`?include_tests=1` to include them, `?recent=N` for more rows).
Recording is best effort and never blocks or fails a paid response.

Optional alert per sale (off unless configured; test-wallet sales are skipped unless `SALES_ALERT_TESTS=1`):

| Setting | Kind | Meaning |
|---|---|---|
| `SALES_WEBHOOK_URL` | secret | Incoming-webhook URL; receives a JSON POST `{text, content, sale}` (Slack, Discord or generic) |
| `SALES_ALERT_EMAIL` | var | Recipient address (must be a verified destination in Cloudflare Email Routing) |
| `SALES_ALERT_FROM` | var | Sender on a domain with Email Routing enabled |
| `SALES_EMAIL` | `send_email` binding | Cloudflare binding used to send the email alert |
| `SALES_TEST_WALLETS` | var | Extra comma-separated wallets to mark `is_test` |

## MCP servers

### Remote: `https://api.lumitrades.io/mcp`

The Worker serves a remote MCP endpoint (Streamable HTTP, stateless, JSON responses; protocol `2026-07-28` with `server/discover`,
plus the legacy `initialize` handshake for `2024-11-05` .. `2025-11-25` clients). Paste the URL into any client that takes a remote MCP
server URL (e.g. a Grok, Claude or ChatGPT connector, or `npx @modelcontextprotocol/inspector`).

- Same tool names and descriptions as the stdio package below: free `lumi_catalog`, `lumi_coins`, `lumi_samples`, `lumi_quote`, `lumi_vendor_scores`; paid Lumi Trust `lumi_trust_check`, `lumi_vendor_report`;
  paid market data `lumi_brief`, `lumi_market`, `lumi_macro_yen`, `lumi_sentiment`, `lumi_events`, `lumi_institutional_brief`; paid **Lumi Market Ideas** `lumi_signal`, `lumi_lite`, `lumi_scan`, `lumi_levels`, `lumi_slate`, `lumi_trades`
  (titled "Lumi Market Ideas: …"; paper-trade analysis, not investment advice; Lumi does not trade real money).
- A remote connector has no wallet, so a paid tool returns a normal tool result with the price and the two ways to pay: x402 at the
  REST endpoint, or the `lumi-trades-mcp` npm package with your own XRPL wallet. Nothing is charged.
- The freshness rule still applies: stale or missing data is a tool error ("Not charged."), never a quote or data.
- Operator access: the Cloudflare secret `OWNER_MCP_KEY` (sent as `Authorization: Bearer <key>`, or as the path `/mcp/<key>` for
  connector UIs that cannot set headers) makes paid tools return data through the same internal handlers, with no facilitator call.
  Compared in constant time and never logged; Workers invocation logs are off so request URLs are not recorded.
- `GET`/`DELETE /mcp` return 405 (no sessions or standalone SSE stream). CORS is open (`*`) for browser-based MCP clients.

## A2A

- **Agent card:** `https://api.lumitrades.io/.well-known/agent-card.json` (alias `/.well-known/agent.json`). A2A 1.0 shape
  (`supportedInterfaces`, `capabilities`, `skills`, `provider`) plus the 0.3 fields (`url`, `preferredTransport`, `protocolVersion`).
  Skills mirror the endpoints (free `catalog`, `coins`, `quote`, `vendor_trust`; paid `brief`, `signal`, `levels`, `slate`, `market`, `macro_yen`,
  `sentiment`, `events`, `vendor_report`, `trades`, `institutional`). The x402 networks and prices and the MCP URL are in `capabilities.extensions`.
- **JSON-RPC endpoint:** `POST https://api.lumitrades.io/a2a`, stateless. `SendMessage` (1.0) and `message/send` (0.3) take text such as
  "signal XRP" or a data part `{ "skill": "signal", "coin": "XRP" }` and reply with a direct Message. Free skills answer inline; paid skills
  answer with the live x402 terms (every network option) and the REST URL to pay at, and nothing is charged over A2A. No tasks, streaming
  or push notifications (those methods return the spec errors).

### Local stdio: `lumi-trades-mcp`

`mcp/` is a stdio MCP server ([`lumi-trades-mcp`](https://www.npmjs.com/package/lumi-trades-mcp) on npm, `io.github.cypher-osiris/lumi-trades-mcp` in the official MCP Registry) exposing every endpoint as a tool and paying per call with the user's own XRPL wallet
(`XRPL_SEED`) or Base USDC wallet (`EVM_PRIVATE_KEY`, gasless), with per-call spend caps (`LUMI_MAX_USD_PER_CALL`, default 0.30). See [mcp/README.md](mcp/README.md).

## Project layout

```
src/
  index.ts          Workers entry (+ exports the InvoiceGuard Durable Object)
  node.ts           Node HTTP adapter (npm start)
  app.ts            router, free/paid endpoints, "never charge on failure" ordering
  x402.ts           x402 v2 merchant flow: challenge, HMAC invoices, verify/settle (XRPL + Base), replay guards
  cdp.ts            Coinbase CDP facilitator auth: per-request Ed25519 JWT (Web Crypto), EXTENSION-RESPONSES decoding
  bazaar.ts         x402 Bazaar discovery metadata per paid route (description, input/output schema, example, routeTemplate)
  invoice-guard.ts  Durable Object: atomic one-time invoice redemption
  views.ts          whitelisted response shapes (signal, levels, slate, market)
  products.ts       brief, macro/yen, sentiment, events, trades (+ markdown brief, carry-trade + funding rules)
  institutional.ts  daily Institutional & Policy Brief (/v1/institutional): field whitelist, link types, per-token map, markdown
  freshness.ts      "you only pay when you get data": input presence/freshness + content checks before any quote
  sanitize.ts       privacy filter
  data.ts           cached fetch of lumitrades.io/data/*.json
  docs.ts           index, skill.md, /.well-known/x402, openapi.json
  mcp.ts            remote MCP endpoint (/mcp): Streamable HTTP JSON-RPC, tools, owner-key access
  a2a.ts            A2A agent card + JSON-RPC endpoint (/a2a)
  catalog.ts        endpoint + price catalog
  config.ts         env parsing, XRP to drops, network defaults
  vendors.ts        trust-layer allowlist (x402 vendors, endpoints, pay-to addresses)
  trust/            trust layer v0: routes + scoring (index.ts), D1/in-memory store, ledger + signature checks, seed
migrations/         D1 schema + 2026-10-22 seed (wrangler d1 migrations apply lumi_trust --remote)
scripts/            testnet wallet setup, end-to-end demo, replay probe
examples/           minimal agent clients (TypeScript and Python)
test/               vitest suites + fixture data (with privacy canaries)
demo/               recorded testnet transcripts
```

## Roadmap (XRPL Grants milestones)

1. **Mainnet launch** on `api.lumitrades.io`, listed in x402 discovery indexes (OpenAPI and `/.well-known/x402`) and in the XRPL agent ecosystem.
2. **Stablecoin pricing.** Done: RLUSD and Circle USDC are in `accepts[]` next to XRP, priced in USD cents (see *Accepted assets*). Since v0.4 the same price is also payable in USDC on Base, with XRPL kept first.
3. **Prepaid credits through payment channels.** Agents that call often open an XRPL PayChannel once and stream signed claims, which brings per-call cost and latency well below one on-ledger Payment per call. Candidates are the `upto`/`paychan` x402 schemes.
4. **Usage metrics dashboard.** Public stats from on-ledger data (payments to `PAY_TO` with `SourceTag 804681468`: calls, unique payer agents, XRP volume per endpoint) plus Workers Analytics Engine. These metrics become the grant KPIs.
5. **More products.** Done: daily brief, yen carry-trade watch, sentiment, events, paper-trade history, and an MCP server wrapper (`mcp/`). Next: historical signal series, a backtest API, webhook/stream subscriptions.
6. **Hardening.** Facilitator failover or self-hosted verification, rate limits, and a Bazaar `extensions` input/output schema in the 402.

## Disclaimer

Lumi API provides analytics for information and education only. It is not financial advice. Lumi Market Ideas is paper-trade analysis, not investment advice; Lumi does not trade real money. Lumi Trust results are automated observations, not a rating, endorsement or guarantee. Trade ideas are hypothetical paper trades for illustration, not orders or recommendations. Crypto is volatile and leverage can magnify losses. Do your own research.

## License

MIT. See [LICENSE](LICENSE).
