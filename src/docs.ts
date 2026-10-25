/** Free, human- and agent-facing documents: index, skill.md, discovery manifests, OpenAPI. */

import { COMMERCE_FREE_ENDPOINTS, commerceOpenApiPaths, commerceSkillMd, planPriceTable, planResources } from "./commerce/discovery";
import { PLATFORM_LICENCE, WATCH_DISCOUNTS, WATCH_FREE, WATCH_TRIAL, WATCH_TRIAL_END } from "./commerce/plans";
import type { Config, PaidRoute } from "./config";
import { EXPLORERS, dropsToXrp } from "./config";
import { PAID_ENDPOINTS, VERDICT_ENDPOINT, paidEndpoints, priceTable } from "./catalog";
import { BAZAAR_ROUTES, TRUST_ROUTES, VENDOR_ID_PATTERN, errorDocs, serviceNameFor } from "./bazaar";
import { DISCLAIMER, SOURCE, type CoinRef } from "./views";
import { RECEIPT_OUTCOMES } from "./trust/receipts";
import { LINE_LABEL, OPENAPI_TAG, OPENAPI_TAGS, productLine } from "./lines";
import { RETIRED_ON } from "./retired";
import { BADGE_MIN_SCORE, BADGE_MIN_PAID_TESTS } from "./trust/check";
import { SIWX_HEADER, SIWX_KEY, TRIAL_LIMITS, TRIAL_OPT_IN_HEADER, TRIAL_SHORT, TRIAL_SUMMARY, XRPL_SIWX_TYPE, trialChains, trialEligible } from "./trial";

/** Free-trial terms (x402 sign-in-with-x), shown in the index, /.well-known/x402, OpenAPI, skill.md and the home page. */
export function freeTrialInfo(cfg: Config) {
  return {
    summary: TRIAL_SUMMARY,
    free_calls_per_wallet: TRIAL_LIMITS.perWallet,
    eligible_routes: PAID_ENDPOINTS.filter((e) => trialEligible(e.route, Number(usdPrice(cfg, e.route)))).map((e) => e.route),
    not_eligible: PAID_ENDPOINTS.filter((e) => !trialEligible(e.route, Number(usdPrice(cfg, e.route)))).map((e) => e.route),
    protocol: "x402 sign-in-with-x extension (CAIP-122; EIP-4361 for Base), opt-in: send header X-Lumi-Trial: 1 and the 402 adds extensions[\"sign-in-with-x\"]",
    opt_in_header: `${TRIAL_OPT_IN_HEADER}: 1`,
    default_402: "without the opt-in header every 402 is a plain x402 payment quote (prices in accepts[]) with a top-level trial hint; it never carries the sign-in-with-x extension",
    header: SIWX_HEADER,
    extension_key: SIWX_KEY,
    chains: trialChains(cfg.evm?.network, cfg.network),
    ...(cfg.evm
      ? {
          base: {
            chain: cfg.evm.network,
            signature: "EIP-191 personal_sign of the EIP-4361 message by an EOA (smart-contract wallets not supported for trials)",
            requires: `the signing wallet holds at least 0.01 USDC on ${cfg.evm.networkName} (checked on-chain, nothing is moved)`,
          },
        }
      : {}),
    xrpl: {
      chain: cfg.network,
      type: XRPL_SIWX_TYPE,
      message: `the same CAIP-122 message built from the challenge info, first line "<domain> wants you to sign in with your XRP Ledger account:", then the r-address; "Chain ID: ${cfg.network.split(":")[1]}"`,
      signature: "ripple-keypairs sign(<UTF-8 bytes of the message as uppercase hex>, privateKey), hex; the payload adds publicKey (hex)",
      key: "the master key (not disabled) or the account's current RegularKey, checked on the validated ledger",
      requires: "an activated XRP Ledger account (its reserve is already locked; nothing is moved). XRP, RLUSD and USDC payers all qualify",
    },
    one_trial_per_wallet: "one ledger and the same caps for Base and XRPL wallets: 3 free calls per wallet in total, not per chain; the per-IP daily cap is shared across chains",
    limits: { per_wallet_lifetime: TRIAL_LIMITS.perWallet, per_ip_per_day: TRIAL_LIMITS.perIpDay, challenge_ttl_seconds: TRIAL_LIMITS.challengeTtlSec, one_time_challenge: true },
    response: "normal paid body plus access: { mode: \"trial\", charged: false, wallet, trial_calls_used, trial_calls_remaining }; no PAYMENT-RESPONSE, nothing settled",
    refused: "normal 402 (pay as usual) with a top-level trial: { granted: false, reason }",
    precedence: "a PAYMENT-SIGNATURE header always wins: a paid retry is settled normally",
    client: "Base: @x402/extensions/sign-in-with-x wrapFetchWithSIWx(fetch, account), called with headers { \"X-Lumi-Trial\": \"1\" }, does the signing and retry. XRPL: build the message, sign it with ripple-keypairs and send the payload yourself (see /llms.txt)",
    rest_only: "REST endpoints only (not MCP or A2A)",
  };
}

/** Runnable XRPL free-trial client (sign-in-with-x, type "xrpl"), shown in llms.txt and on the home page. */
export function xrplTrialSnippet(base: string, network: string): string {
  return `// npm i xrpl ripple-keypairs   (3 free calls per new wallet; nothing is charged)
import { Wallet } from "xrpl";
import { sign } from "ripple-keypairs";

const wallet = Wallet.fromSeed(process.env.XRPL_SEED);
const url = "${base}/v1/sentiment";
const quote = await (await fetch(url, { headers: { "X-Lumi-Trial": "1" } })).json();
const ext = quote.extensions["sign-in-with-x"], i = ext.info;
const chain = ext.supportedChains.find((c) => c.type === "xrpl"); // { chainId: "${network}", type: "xrpl" }
const message = [
  \`\${i.domain} wants you to sign in with your XRP Ledger account:\`, wallet.classicAddress, "", i.statement, "",
  \`URI: \${i.uri}\`, \`Version: \${i.version}\`, \`Chain ID: \${chain.chainId.split(":")[1]}\`, \`Nonce: \${i.nonce}\`,
  \`Issued At: \${i.issuedAt}\`, \`Expiration Time: \${i.expirationTime}\`, "Resources:", ...i.resources.map((r) => \`- \${r}\`),
].join("\\n");
const signature = sign(Buffer.from(message, "utf8").toString("hex").toUpperCase(), wallet.privateKey);
const payload = { ...i, address: wallet.classicAddress, chainId: chain.chainId, type: "xrpl", signature, publicKey: wallet.publicKey };
const res = await fetch(url, { headers: { "SIGN-IN-WITH-X": Buffer.from(JSON.stringify(payload)).toString("base64") } });
const body = await res.json(); // body.access = { mode: "trial", charged: false, trial_calls_remaining, ... }`;
}

/** OpenAPI schema of a receipt's delivery block. data_returned is null when delivery is inconclusive (Lumi recorded no HTTP response). */
export const RECEIPT_DELIVERY_SCHEMA = {
  type: "object",
  properties: {
    observed_at: { type: "string", format: "date-time" },
    http_status: { type: "integer", description: "0 = Lumi recorded no HTTP response" },
    data_returned: { type: ["boolean", "null"], description: "true/false when a response was recorded; null when delivery is inconclusive (Lumi-side: no HTTP response recorded), which never counts against the seller" },
    outcome: { type: "string", enum: [...RECEIPT_OUTCOMES] },
    inconclusive_reason: { type: "string", description: "Only when outcome is inconclusive, e.g. lumi_client_timeout, lumi_run_interrupted" },
    latency_ms: { type: "integer" },
    source: { type: "string" },
    note: { type: "string" },
  },
  required: ["observed_at", "http_status", "data_returned", "outcome"],
} as const;

export const VERSION = "1.1.7";

/** accepts[] indices: USDC on Base first (when configured), then XRP, then the XRPL stablecoins. */
export function acceptsIndex(cfg: Config) {
  const off = cfg.evm ? 1 : 0;
  return {
    evm: cfg.evm ? 0 : -1, xrp: off, iou: (i: number) => off + 1 + i, xrplRange: cfg.ious.length ? `${off}-${off + cfg.ious.length}` : String(off),
    stellar: cfg.stellar ? off + 1 + cfg.ious.length : -1,
  };
}

/** Plain-English accepts order for docs. */
export function acceptsOrder(cfg: Config): string {
  const ix = acceptsIndex(cfg);
  return [
    ...(cfg.evm ? [`USDC on ${cfg.evm.networkName} (accepts[0])`] : []),
    `XRP (accepts[${ix.xrp}])`,
    ...cfg.ious.map((o, i) => `${o.symbol} on the XRP Ledger (accepts[${ix.iou(i)}])`),
    ...(cfg.stellar ? [`USDC on ${cfg.stellar.networkName} (accepts[${ix.stellar}])`] : []),
  ].join(", ");
}

export const FRESHNESS_FIELDS =
  "Every paid response carries as_of (when the data was produced), data_age_seconds, next_update (expected next refresh) and stale_after; " +
  "past stale_after the call is refused with 503 'Not charged.' and no payment is settled.";

export function indexDoc(cfg: Config, base: string, coins: CoinRef[]) {
  return {
    name: "Lumi API",
    version: VERSION,
    description:
      "Lumi Trades (lumitrades.io) checks x402 sellers before AI agents pay them, and sells neutral crypto market data per call. " +
      `No API keys or accounts: each paid call is settled in ${settledIn(cfg)} via the x402 protocol (HTTP 402, exact scheme).`,
    human_summary:
      "Lumi Trades seller checks: an x402 'should I pay this URL?' check and paid x402 vendor reports. " +
      "Market data (no trade calls): the BTC/macro backdrop, a yen macro watch, a sentiment snapshot (Fear & Greed + funding), an events calendar, " +
      "funding rates, CoinMarketCap Fear & Greed with history, the next 48h of events and a daily policy brief. " +
      `Per-coin readings, levels, the scan, the watchlist slate and the daily market brief were retired on ${RETIRED_ON} (410 Gone). ` +
      `Trial: ${TRIAL_SHORT} (see free_trial). ` +
      `Agents call an endpoint, receive HTTP 402 with the price in ${acceptsOrder(cfg)}, sign ${cfg.evm ? "an EIP-3009 USDC authorization or " : ""}${cfg.stellar ? "a Stellar USDC transfer or " : ""}a small XRPL Payment, retry, and get JSON back. ` +
      FRESHNESS_FIELDS,
    source: SOURCE,
    payment: {
      protocol: "x402",
      x402Version: 2,
      scheme: "exact",
      network: cfg.network,
      network_name: cfg.networkName,
      asset: cfg.evm ? "USDC" : "XRP",
      accepts_order: acceptsOrder(cfg),
      assets: assetsInfo(cfg),
      pay_to: cfg.payTo,
      facilitator: cfg.facilitatorUrl,
      source_tag: cfg.sourceTag,
      headers: { challenge: "PAYMENT-REQUIRED", payment: "PAYMENT-SIGNATURE", receipt: "PAYMENT-RESPONSE" },
      explorer: EXPLORERS[cfg.network],
      networks: paymentNetworks(cfg),
      xrp_pricing:
        cfg.xrpPricing === "live"
          ? { mode: "live", ...(cfg.xrpRate ? { xrp_usd: cfg.xrpRate.usd, source: cfg.xrpRate.source, as_of: cfg.xrpRate.as_of } : {}), rule: "XRP amount = USD price / live XRP-USD rate, rounded up to 0.0001 XRP" }
          : { mode: "fixed" },
    },
    guarantee:
      "You only pay when you get data: inputs are fetched and validated (present, non-empty, fresh) before any 402 quote; " +
      "otherwise 503 'Not charged.' and no payment can be settled. Bad input (unknown coin, bad format) returns 4xx before any quote, never charged. " +
      "A payment arriving after the data's stale_after is refused before settlement. The paid body is built before settlement.",
    freshness: FRESHNESS_FIELDS,
    ...(freeTrialInfo(cfg) ? { free_trial: freeTrialInfo(cfg) } : {}),
    free_endpoints: [
      { method: "GET", path: "/", summary: "This index" },
      { method: "GET", path: "/health", summary: "Liveness + config summary" },
      { method: "GET", path: "/skill.md", summary: "Agent guide: what is offered, prices, how to pay, example code" },
      { method: "GET", path: "/.well-known/x402", summary: "x402 discovery manifest" },
      { method: "GET", path: "/.well-known/agent-card.json", summary: "A2A agent card (alias /.well-known/agent.json)" },
      { method: "GET", path: "/.well-known/mcp/server-card.json", summary: "MCP Server Card for the remote MCP server (alias /.well-known/mcp.json)" },
      { method: "GET", path: "/.well-known/agents.json", summary: "agents.json (v0.1.0) flows over /openapi.json, trust check first" },
      { method: "GET", path: "/openapi.json", summary: "OpenAPI 3.1 description with x-payment-info" },
      ...(cfg.verdictPaid ? [] : [{ method: "GET", path: "/v1/verdict?url=", summary: "Free (rate-limited) pre-payment check, one signed label from the same data as /v1/check: checks_passed (Delivered in recent checks) / check_first (Check first) / checks_failed (Recent checks failed) / no_data (Not enough data), with dates, evidence window, sample count, reason codes, evidence and appeal links. Paying Lumi never changes a result" }]),
      { method: "GET", path: "/llms.txt", summary: "Short plain-text guide for LLMs" },
      { method: "GET", path: "/v1/check?url=", summary: "Lumi Check: free, signed allow / warn / block before you pay an x402 seller, from Lumi's cached observations (rate-limited per client)" },
      { method: "GET", path: "/v1/check/keys", summary: "Public keys that sign Lumi Check answers and badges (alias /.well-known/lumi-keys.json)" },
      { method: "POST", path: "/v1/check/outcome", summary: "Optional anonymous delivery outcome (seller host + delivered yes/no only; not a scoring input)" },
      { method: "GET", path: "/v1/verdict/rules", summary: "Verdict labels, public names, the allow/warn/block to label mapping, thresholds and definitions" },
      { method: "GET", path: "/v1/samples", summary: "Free truncated SAMPLE of every paid product (lists cut to 2, up to 10 min old) with USD price and full URL" },
      { method: "GET", path: "/v1/trust/vendors", summary: "Lumi's automated observations of other x402 vendors (402-quote checks every 30 min, paid test-buys with tx evidence, sample sizes)" },
      { method: "GET", path: "/v1/trust/vendors?url=|domain=|payTo=", summary: "Look up any x402 seller before you pay it: the full CDP Bazaar catalog, with free 402-quote checks on a rotating schedule ('quote-checked, low confidence'; not every listing is checked yet, see catalog.coverage: 'N resources across M domains indexed, X quote-checked, Y test-bought on Base (USDC); separately, Z XRPL endpoints from the curated list') and Lumi's on-chain-confirmed test-buys ('test-bought', counted per chain)" },
      { method: "GET", path: "/v1/trust/catalog", summary: "Free teaser of the ingested x402 catalog: the 100 most-used listings (?page=1..4, ?limit<=25, or ?popular=1&max_usd=0.05), answer-only (no tx hashes), with live counts by tier; rate-limited per client" },
      { method: "GET", path: "/v1/trust/vendors/{id}", summary: "One vendor: observations with evidence, latest probes, agent reports, vendor replies" },
      { method: "GET", path: "/v1/trust/vendors/{id}/report", summary: "Paid ($0.02, x402): full observation history for one vendor; listed under paid_endpoints" },
      { method: "GET", path: "/v1/trust/methodology", summary: "How trust observations and scores are computed; how to report and how vendors reply" },
      { method: "GET", path: "/v1/badge", summary: "How the earned-only 'Tested by Lumi' badge works and how to embed it" },
      { method: "GET", path: "/v1/badge/{key}.json", summary: "The badge as a Lumi-signed JSON verdict" },
      { method: "GET", path: "/v1/badge/{key}.svg", summary: `Free, signed, earned-only 'Tested by Lumi' badge: shown only while the seller's live score is >= ${BADGE_MIN_SCORE} with >= ${BADGE_MIN_PAID_TESTS} conclusive paid test-buys (latest delivered); never sold. Also /v1/badge/{key}.json (Lumi-signed verdict); docs at /v1/badge. Legacy /badge paths answer 301 here (query kept)` },
      { method: "GET", path: "/trust/v/{key}", summary: "Public result page each badge links to: latest dated tests, how Lumi tests, right to reply, disclaimer, embed snippets" },
      { method: "POST", path: "/v1/reports", summary: "Report a paid call to a listed vendor (counts only with an on-ledger payment + payer signature)" },
      { method: "GET", path: "/v1/trust/receipts/verify", summary: "How to verify a Lumi signed test-buy receipt (counterparty_delivery_receipt v0.1) yourself" },
      { method: "POST", path: "/v1/trust/receipts/verify", summary: "Verify a signed test-buy receipt (hash, paying-wallet signature; ?ledger=1 also checks the payment on-chain), free" },
      { method: "POST", path: "/v1/tips", summary: "Send Lumi a private tip (stored privately; never published or returned)" },
      { method: "POST", path: "/v1/trust/replies", summary: "Vendor right to reply (signed by a listed pay-to address), or email hello@lumitrades.io" },
      ...COMMERCE_FREE_ENDPOINTS,
      { method: "POST", path: "/mcp", summary: "Remote MCP server (Streamable HTTP): free tools for everyone; paid tools return the price and how to pay" },
      { method: "POST", path: "/a2a", summary: "A2A JSON-RPC endpoint (SendMessage / message/send): free skills answered inline, paid skills return x402 terms" },
    ],
    mcp: mcpInfo(base, cfg),
    a2a: { agent_card: `${base}/.well-known/agent-card.json`, endpoint: `${base}/a2a`, protocol_versions: ["1.0", "0.3"], binding: "JSONRPC" },
    paid_endpoints: priceTable(cfg),
    product_lines: productLinesDoc(),
    plans: planPriceTable(base),
    platform_licence: { ...PLATFORM_LICENCE },
    docs: `${base}/skill.md`,
    disclaimer: DISCLAIMER,
  };
}

export function wellKnownX402(cfg: Config, base: string) {
  // Follows draft-hawkins-x402-dns-discovery (kind/resource-server manifest).
  // `resources` lists concrete example URLs, since templates are not fetchable.
  return {
    x402Version: 2,
    kind: "resource-server",
    name: "Lumi Trades",
    description: `Pay-per-call reads from Lumi Trades (lumitrades.io), settled in ${settledIn(cfg)}, in two groups: checks before paying an x402 seller (a pre-payment check, a one-label verdict and seller reputation reports from Lumi's trust observations); and neutral market data (macro, yen macro watch, sentiment, funding, Fear & Greed, events and a 48h window, and a daily policy brief; no trade calls, not financial advice). Each resource carries product_line. Also: seller monitoring plans (Watch $5, Watch Plus $12, Watch Pro $20 per endpoint per 30d; Audit $99; free tier and 14-day trial) and a licensed trust data feed (free 1,000 lookups/month; $1.50 per 1,000; Feed $99/30d; Feed Pro $199/30d).`,
    resources: paidEndpoints(cfg).map((e) => ({
      name: e.name,
      url: `${base}${e.example}`,
      template: `${base}${e.template}`,
      mimeType: "application/json",
      method: e.method,
      description: BAZAAR_ROUTES[e.route].description,
      serviceName: serviceNameFor(e.route),
      product_line: LINE_LABEL[productLine(e.route)],
      errors: errorDocs(e.route),
      accepts: [
        ...(cfg.evm
          ? [{
              scheme: "exact",
              network: cfg.evm.network,
              asset: cfg.evm.asset,
              asset_symbol: "USDC",
              amount: cfg.evm.amounts[e.route],
              amount_usdc: cfg.evm.prices[e.route],
              payTo: cfg.evm.payTo,
              extra: { name: cfg.evm.eip712.name, version: cfg.evm.eip712.version },
            }]
          : []),
        {
          scheme: "exact",
          network: cfg.network,
          asset: "XRP",
          amount: cfg.pricesDrops[e.route],
          amount_xrp: dropsToXrp(cfg.pricesDrops[e.route]),
          payTo: cfg.payTo,
        },
        ...cfg.ious.map((o) => ({
          scheme: "exact",
          network: cfg.network,
          asset: o.currency,
          asset_symbol: o.symbol,
          issuer: o.issuer,
          amount: o.prices[e.route],
          payTo: cfg.payTo,
        })),
        ...(cfg.stellar
          ? [{
              scheme: "exact",
              network: cfg.stellar.network,
              asset: cfg.stellar.asset,
              asset_symbol: "USDC",
              amount: cfg.stellar.amounts[e.route],
              amount_usdc: cfg.stellar.prices[e.route],
              payTo: cfg.stellar.payTo,
              extra: { areFeesSponsored: true },
            }]
          : []),
      ],
    })).concat(planResources(cfg, base) as any),
    plans: { note: "Plan routes (seller monitoring, trust data feed) are one x402 payment per 30-day term (Watch tiers: per endpoint, ?endpoints=N, optionally ?terms=3 prepaid) or one-off, no auto-renew. The concrete URL quotes the list price; the payment binds to ?enrollment= or ?key_id= and is refused before settlement without a valid one (except Feed / Feed Pro, which issue a new key).", monitor: `${base}/v1/monitor`, feed: `${base}/v1/feed`, license: `${base}/v1/feed/license` },
    facilitators: [cfg.facilitatorUrl, ...(cfg.evm ? [...(cfg.evm.cdp ? [cfg.evm.cdp.url] : []), cfg.evm.facilitatorUrl] : []), ...(cfg.stellar ? [cfg.stellar.facilitatorUrl] : [])],
    networks: paymentNetworks(cfg),
    agent_card: `${base}/.well-known/agent-card.json`,
    openapi: `${base}/openapi.json`,
    docs: `${base}/skill.md`,
    mcp: { url: `${base}/mcp`, transport: "streamable-http" },
    ...(freeTrialInfo(cfg) ? { free_trial: freeTrialInfo(cfg) } : {}),
    attestation: { type: "signed-receipts", receipts: "counterparty_delivery_receipt v0.1 (SHA-256 receipt_hash, signed by the paying wallet) on Lumi Trades seller checks test-buys, served with paid vendor reports (/v1/trust/vendors/{id}/report) and paid catalog lookups (POST /v1/feed/lookup, Feed and Feed Pro plans; not in /v1/trust/check); verify free with POST /v1/trust/receipts/verify", verify: `${base}/v1/trust/receipts/verify`, monitor_reports: "Audit reports carry an Ed25519 signature over report_hash; only the hash and signature are public" },
    contact: "https://lumitrades.io",
    updated: new Date().toISOString(),
  };
}

/** Lumi's site coins (full coverage); the rest of the top-50 universe is signals-only (group "top50"). */

/** Optional Idempotency-Key header on every paid route. */
const IDEMPOTENCY_PARAM = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  description: "Optional retry key (16-128 characters: letters, digits, - or _). A retry with the same key and the same payment returns the cached response (header Idempotent-Replayed: true) and is never charged twice; the same key with a different payment is refused with 409. The x402 payment-identifier extension id works the same way. Cached for 24 hours.",
  schema: { type: "string", minLength: 16, maxLength: 128, pattern: "^[A-Za-z0-9_-]{16,128}$" },
};

export function openApi(cfg: Config, base: string, coins: CoinRef[]) {
  const paths: Record<string, unknown> = {
    "/v1/samples": { get: { summary: "Free truncated samples of every paid product (labelled SAMPLE)", security: [], responses: { "200": { description: "OK" } } } },
    "/health": { get: { summary: "Health (free)", responses: { "200": { description: "OK" } } } },
    ...trustPaths(),
    ...commerceOpenApiPaths(cfg, base),
  };
  const verdictParams = [
    { name: "url", in: "query", required: true, description: "The x402 resource URL, or the seller's bare domain, you are about to pay", schema: { type: "string", maxLength: 500 }, example: "https://api.example.com/v1/data" },
    { name: "payTo", in: "query", required: false, description: "The payTo address in its 402 quote (EVM 0x... or XRPL r...)", schema: { type: "string", maxLength: 120 } },
    { name: "amount", in: "query", required: false, description: "The quoted price in USD (decimal)", schema: { type: "string", maxLength: 20 } },
  ];
  paths["/v1/check"] = {
    get: {
      operationId: "check",
      tags: ["trust"],
      security: [],
      summary: "Lumi Check (free): signed allow / warn / block before you pay an x402 seller, from Lumi's cached observations",
      description: "Answer-only and rate-limited per client. Signed with the keys at /v1/check/keys; carries the data age of the observations it is based on. The paid /v1/trust/check returns the full evidence.",
      parameters: [...verdictParams.map((p) => ({ ...p, required: false })), { name: "network", in: "query", required: false, description: "CAIP-2 network of the quote, e.g. eip155:8453 or xrpl:0", schema: { type: "string", maxLength: 40 } }],
      responses: { "200": { description: "Signed decision" }, "400": { description: "Bad or missing url (never charged)" }, "429": { description: "Free rate limit" } },
    },
  };
  paths["/v1/check/keys"] = { get: { tags: ["trust"], security: [], summary: "Public signing keys for Lumi Check answers and badges (free; alias /.well-known/lumi-keys.json)", responses: { "200": { description: "OK" } } } };
  paths["/v1/check/outcome"] = {
    post: {
      tags: ["trust"], security: [],
      summary: "Optional anonymous delivery outcome: seller host or vendor id + delivered yes/no + coarse status class only (free; not a scoring input)",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", maxProperties: 4 } } } },
      responses: { "202": { description: "Counted" }, "400": { description: "Not an allowed field set; nothing stored" }, "413": { description: "Body over 512 bytes" }, "429": { description: "Rate limited" } },
    },
  };
  paths["/v1/verdict/rules"] = { get: { tags: ["trust"], security: [], summary: "Verdict labels, public names, allow/warn/block mapping, thresholds and definitions (free)", responses: { "200": { description: "OK" } } } };
  if (!cfg.verdictPaid) {
    paths["/v1/verdict"] = {
      get: {
        operationId: "verdict",
        tags: ["trust"],
        security: [],
        summary: "Pre-payment check, one label (free, rate-limited alias of /v1/check)",
        description: VERDICT_ENDPOINT.summary + " Signed (Ed25519, kind lumi_verdict, embedded lumi_check receipt). Labels and the allow/warn/block mapping: GET /v1/verdict/rules.",
        parameters: verdictParams,
        "x-example-url": `${base}/v1/verdict?url=${encodeURIComponent("https://api.example.com/v1/data")}`,
        responses: { "200": { description: "OK" }, "400": { description: "Missing or invalid url" }, "429": { description: "Rate limited" } },
      },
    };
  }
  for (const e of paidEndpoints(cfg)) {
    paths[e.template] = {
      get: {
        operationId: e.route,
        summary: e.name,
        description: BAZAAR_ROUTES[e.route].description,
        tags: [OPENAPI_TAG[productLine(e.route)]],
        "x-product-line": LINE_LABEL[productLine(e.route)],
        "x-service-name": serviceNameFor(e.route),
        parameters: [...(e.template.includes("{id}")
          ? [{ name: "id", in: "path", required: true, description: "Vendor id from GET /v1/trust/vendors (free)", schema: { type: "string", pattern: VENDOR_ID_PATTERN }, example: "printmoneylab", examples: { printmoneylab: { value: "printmoneylab" } } }]
          : e.route === "verdict"
          ? verdictParams
          : e.route === "trust_check"
          ? [
              { name: "url", in: "query", required: true, description: "The x402 resource URL you are about to pay (http/https)", schema: { type: "string", maxLength: 500 }, example: "https://api.example.com/v1/data" },
              { name: "payTo", in: "query", required: false, description: "The payTo address in its 402 quote (EVM 0x... or XRPL r...), to check against the listing", schema: { type: "string" } },
              { name: "amount", in: "query", required: false, description: "The quoted price in USD (decimal), to check against the listing", schema: { type: "string", pattern: "^[0-9]+(\\.[0-9]+)?$" }, example: "0.01" },
            ]
          : e.route === "institutional"
            ? [{ name: "format", in: "query", required: false, description: "json (default) or md for text/markdown", schema: { type: "string", enum: ["json", "md"] } }]
            : []), IDEMPOTENCY_PARAM],
        ...(e.template.includes("{id}")
          ? { "x-example-url": `${base}${e.template.replace("{id}", "printmoneylab")}` }
          : e.route === "trust_check" || e.route === "verdict"
          ? { "x-example-url": `${base}${e.template}?url=${encodeURIComponent("https://api.example.com/v1/data")}` }
          : {}),
        "x-free-trial": trialEligible(e.route, Number(usdPrice(cfg, e.route))) ? { eligible: true, free_calls_per_wallet: TRIAL_LIMITS.perWallet, opt_in_header: `${TRIAL_OPT_IN_HEADER}: 1`, header: SIWX_HEADER, extension: SIWX_KEY } : { eligible: false },
        "x-payment-info": {
          // x402scan discovery spec: protocols as objects, price in decimal USD (the per-asset terms follow).
          protocols: [{ x402: {} }],
          price: { mode: "fixed", currency: "USD", amount: usdPrice(cfg, e.route) },
          xrp_price: cfg.xrpPricing === "live"
            ? { mode: "live", currency: "XRP", amount: dropsToXrp(cfg.pricesDrops[e.route]), ...(cfg.xrpRate ? { xrp_usd: cfg.xrpRate.usd, as_of: cfg.xrpRate.as_of } : {}), note: "XRP amount = USD price / live XRP-USD rate (5-minute cache), rounded up to 0.0001 XRP; the 402 quote is binding" }
            : { mode: "fixed", currency: "XRP", amount: dropsToXrp(cfg.pricesDrops[e.route]) },
          // Payment options in the same order as the 402 accepts[]: Base USDC first, then XRP, then the XRPL IOUs, then Stellar USDC.
          ...(cfg.evm
            ? { scheme: "exact", network: cfg.evm.network, asset: cfg.evm.asset, asset_symbol: "USDC", amount: cfg.evm.amounts[e.route], payTo: cfg.evm.payTo }
            : { scheme: "exact", network: cfg.network, asset: "XRP", amount_drops: cfg.pricesDrops[e.route], payTo: cfg.payTo }),
          alternatives: [
            ...(cfg.evm ? [{ price: { mode: "fixed", currency: "XRP", amount: dropsToXrp(cfg.pricesDrops[e.route]) }, scheme: "exact", network: cfg.network, asset: "XRP", amount_drops: cfg.pricesDrops[e.route], payTo: cfg.payTo }] : []),
            ...cfg.ious.map((o) => ({
              price: { mode: "fixed", currency: o.symbol, amount: o.prices[e.route] },
              scheme: "exact",
              network: cfg.network,
              asset: o.currency,
              issuer: o.issuer,
              amount: o.prices[e.route],
              payTo: cfg.payTo,
            })),
            ...(cfg.stellar ? [{ price: { mode: "fixed", currency: "USDC", amount: cfg.stellar.prices[e.route] }, scheme: "exact", network: cfg.stellar.network, asset: cfg.stellar.asset, amount: cfg.stellar.amounts[e.route], payTo: cfg.stellar.payTo }] : []),
          ],
        },
        responses: {
          "200": {
            description: "Paid data (JSON) with as_of, data_age_seconds, next_update and stale_after. Settlement receipt in the PAYMENT-RESPONSE header.",
            content: { "application/json": { example: { ...BAZAAR_ROUTES[e.route].example, payment: { ...(BAZAAR_ROUTES[e.route].example.payment as object), amount: String(Number(usdPrice(cfg, e.route) ?? 0)) } } } },
          },
          "402": { description: "Payment required. x402 v2 PaymentRequired in the body and the PAYMENT-REQUIRED header. accepts[] order: Base USDC, XRP, then XRPL IOUs." },
          ...(e.template.includes("{")
            ? { "400": { description: "Path template not filled in (e.g. :id, <id>, ${id}), or any unfilled path sent with a payment header; the body gives an example URL (never charged). Without a payment header, the literal OpenAPI template path ({id}, as discovery crawlers request it) returns the route's normal 402 quote with a note to fill the placeholder; a payment sent to it is refused with this 400." } }
            : e.route === "trust_check" || e.route === "verdict"
            ? { "400": { description: "url missing, empty or not an absolute http(s) URL, or payTo/amount malformed (never charged). A request with no query string at all, as discovery crawlers send it, returns the normal 402 quote; a payment sent without url is refused with this 400.", content: { "application/json": { example: { error: "invalid_query", detail: "url is required: the x402 resource URL (or the seller's domain) you are about to pay.", example: `${base}/v1/${e.route === "verdict" ? "verdict" : "trust/check"}?url=https://api.example.com/v1/data`, note: "Not charged." } } } } }
            : e.route === "institutional"
            ? { "400": { description: "format is not json or md (never charged)." } }
            : {}),
          ...(e.template.includes("{id}")
            ? { "404": { description: "Unknown vendor id (never charged). Vendor ids: GET /v1/trust/vendors (free)." } }
            : {}),
          "403": { description: "verifiable_intent_denied: the payment's signed intent does not allow this purchase (never charged)." },
          "409": { description: "Idempotency-Key (or payment-identifier id) already used with a different payment (never charged), or settlement_status_unknown: the facilitator did not confirm settlement; check the transaction before paying again." },
          "429": { description: "Not returned on paid calls. The free lookups (/v1/check, /v1/trust/vendors, /v1/trust/catalog) return 429 rate_limited with Retry-After over their limits; a facilitator 429 surfaces as a retryable 503 facilitator_unavailable." },
          "500": { description: "internal_error: unexpected server error; retry later." },
          "502": { description: "invalid_verify_response or settle_http_error: the payment facilitator returned an unusable answer; not retryable as-is (nothing is settled on invalid_verify_response)." },
          "503": {
            description: (e.route === "vendor_report" ? "No observation of this vendor in the last 48 h, so the report is not sold. " : "Inputs missing or past stale_after, so the data is not sold. ") + "Body: {error: 'stale_data' (or 'data_unavailable' when an upstream is down, or 'facilitator_unavailable' when the payment facilitator is busy or rate-limited), data_age_seconds (null when unknown), retry_after_seconds, retryable, note}; Retry-After header set. Never charged.",
            content: { "application/json": { example: { error: "stale_data", detail: "Inputs are past stale_after; not sold until refreshed.", data_age_seconds: 7260, retry_after_seconds: 300, retryable: true, note: "Not charged." } } },
          },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Lumi Trades API: x402 seller checks before paying, plus neutral crypto market data (x402)",
      version: VERSION,
      contact: { name: "Lumi Trades", url: "https://lumitrades.io", email: "hello@lumitrades.io" },
      description:
        `Pay-per-call reads from lumitrades.io for AI agents, in two groups (OpenAPI tags): ` +
        `trust (Lumi Trades seller checks for x402 sellers; free lookup; paid pre-payment check and vendor reports); ` +
        `and market data (macro backdrop, yen macro watch, sentiment, Fear & Greed, funding, events and a daily policy brief; data only, no trade calls). ` +
        `No API key: pay a few cents per call in ${settledIn(cfg)} via x402. ` +
        `${TRIAL_SUMMARY} ` +
        `Not charged on bad input or stale data; every response carries as_of, data_age_seconds, next_update and stale_after.`,
      "x-guidance":
        "GET /v1/check?url= (free) is the signed pre-payment seller check; GET /v1/samples (free) previews every paid product, truncated. " +
        "Trust (Lumi Trades seller checks): GET /v1/trust/check?url= answers 'should I pay this x402 URL?' with allow/warn/block and reasons; GET /v1/trust/vendors/{id}/report gives a vendor's full observation history. " +
        "Market data: GET /v1/market gives the BTC and macro backdrop; " +
        "GET /v1/macro/yen gives USD/JPY, Nikkei and a rule-based yen risk level; GET /v1/sentiment gives Fear & Greed, funding and breadth; " +
        "GET /v1/funding gives perp funding rates; GET /v1/fear-greed gives CoinMarketCap Fear & Greed with history; " +
        "GET /v1/events gives sourced upcoming macro/crypto events; GET /v1/events/next48h gives what is scheduled in the next 48 hours; " +
        "GET /v1/institutional gives a daily sourced policy brief (regulators, central banks, banks, tokenization). " +
        `Per-coin readings, levels, the scan, the watchlist slate, the market brief and /v1/coins were retired on ${RETIRED_ON} and answer 410 Gone (never charged). ` +
        `Each paid call is one x402 v2 'exact' payment: ${acceptsOrder(cfg)}` +
        (cfg.evm ? ` (Base: ${cfg.evm.network}, token ${cfg.evm.asset}; XRPL: ${cfg.network}${cfg.stellar ? `; Stellar: ${cfg.stellar.network}, token ${cfg.stellar.asset}` : ""})` : ` (${cfg.network})`) +
        `; pick an option by network and asset. Bad input returns 4xx and stale data 503 before any payment is requested (not charged). ` +
        `Retries: send the same Idempotency-Key header (or the x402 payment-identifier extension id) with the same payment and the cached response is returned without a second charge. ` +
        `Every response carries as_of, data_age_seconds, next_update and stale_after. Full guide: ${base}/skill.md. Information only, not financial advice.`,
    },
    ...(freeTrialInfo(cfg) ? { "x-free-trial": freeTrialInfo(cfg) } : {}),
    tags: [...OPENAPI_TAGS, { name: "seller-monitoring", description: "Lumi Trades seller checks: seller monitoring plans." }, { name: "trust-feed", description: "Lumi Trades seller checks: licensed trust data feed." }],
    servers: [{ url: base }],
    externalDocs: { description: "Agent guide", url: `${base}/skill.md` },
    paths,
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "Owner key, only for owner-only endpoints. Paid endpoints use x402 (see x-payment-info); free endpoints need no auth." },
        feedKey: { type: "http", scheme: "bearer", description: "Trust data feed API key (lumi_fk_…), from POST /v1/feed/keys or a Feed plan payment; X-Lumi-Key header also accepted." },
        managementToken: { type: "http", scheme: "bearer", description: "Seller monitoring management token (lumi_mt_…), returned once at enrolment." },
      },
    },
  };
}

/** Route price in decimal USD with 6 places (the USDC price, else the RLUSD price, both USD-denominated). */
export function usdPrice(cfg: Config, route: PaidRoute): string | undefined {
  const v = cfg.evm?.prices[route] ?? cfg.ious.find((o) => o.symbol === "RLUSD")?.prices[route];
  return v == null ? undefined : Number(v).toFixed(6);
}

function trustPaths(): Record<string, unknown> {
  const json = (props: Record<string, unknown>, required: string[]) => ({ required: true, content: { "application/json": { schema: { type: "object", properties: props, required } } } });
  const r = (codes: Record<string, string>) => Object.fromEntries(Object.entries(codes).map(([k, v]) => [k, { description: v }]));
  const tag = ["trust"];
  return {
    "/v1/trust/vendors": { get: { tags: tag, security: [], summary: "x402 seller lookup and vendor observations (free)", description: "With url, domain or payTo (case-insensitive): matches across the full CDP x402 Bazaar catalog, answer-only (tier, last quote check, test-buy count; up to 5 entries; no tx hashes or check history, those are in the paid /v1/trust/check); rate-limited per client (ingested daily; listings get free, unpaid 402-quote checks on a rotating schedule: valid quote, price and payTo vs the listing, latency, domain age; live coverage counts in the response) and Lumi's on-chain-confirmed test-buys, counted per chain (Base USDC buys of Bazaar listings; XRPL buys of a small curated vendor list, separately; see catalog.purchase_verified_by_chain). Tiers: 'catalogued, not yet checked', 'quote-checked, low confidence', 'quote-checked: no valid x402 quote at the last check', 'test-bought'. No match returns {observed:false, note}; that is not a negative finding. Without parameters: the curated XRPL vendor list (allowlist order, not ranked) plus catalog counts; each vendor's last_paid_observation includes the tx_hash and explorer link of its latest paid test-buy only (free; null when Lumi has no paid test-buy of that vendor). For a few vendors where Lumi has confirmed the cause is not on its side, and only while Lumi has no paid test-buy of them, payment_attempts gives {status:'test_payment_not_accepted_yet', label:'Test payment not accepted yet on XRPL', network:'xrpl:0', network_name:'XRPL', count, first_attempt, last_attempt}: signed XRPL test payments the seller's endpoint did not accept (none reached the ledger, nothing was paid). Informational only, never part of the score; absent for every other vendor. Older tx hashes, signed receipts and the full history are in the paid /v1/trust/vendors/{id}/report ($0.02). Observations, not ratings.", parameters: [
      { name: "url", in: "query", required: false, description: "Resource URL you are about to pay", schema: { type: "string", maxLength: 500 } },
      { name: "domain", in: "query", required: false, description: "Seller host or registrable domain", schema: { type: "string", maxLength: 253 } },
      { name: "payTo", in: "query", required: false, description: "payTo address from the seller's 402 quote (case-insensitive)", schema: { type: "string", maxLength: 120 } },
    ], responses: r({ "200": "OK" }) } },
    "/v1/trust/catalog": { get: { tags: tag, security: [], summary: "Free teaser of the ingested x402 catalog", description: "The 100 most-used Bazaar listings (25 per page, pages 1-4) with live counts by tier. Answer-only: tier, listed price, last quote check and test-buy count; no tx hashes, receipts or check history (tx evidence is in the paid /v1/trust/check; full history and signed receipts in the paid /v1/trust/vendors/{id}/report and Feed lookups). Not a full export: after= is ignored and pages past 4 are empty. Rate-limited per hashed client IP (10/min, 40/day); use ?url=|domain=|payTo= on /v1/trust/vendors to look up any listing.", parameters: [
      { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 4 } },
      { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 25 } },
      { name: "popular", in: "query", required: false, description: "1 = most-used Bazaar listings first", schema: { type: "string", enum: ["1"] } },
      { name: "max_usd", in: "query", required: false, schema: { type: "number" } },
    ], responses: r({ "200": "OK" }) } },
    "/v1/trust/vendors/{id}": { get: { tags: tag, summary: "One vendor's observations and evidence (free)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: VENDOR_ID_PATTERN }, example: "printmoneylab" }], responses: r({ "200": "OK", "404": "Unknown vendor" }) } },
    "/v1/trust/methodology": { get: { tags: tag, security: [], summary: "Methodology, report format and right to reply (free)", responses: r({ "200": "OK" }) } },
    "/v1/badge": { get: { tags: ["badge"], security: [], summary: "How the free, signed, earned-only 'Tested by Lumi' badge works (free)", responses: r({ "200": "OK" }) } },
    "/v1/badge/{key}.svg": { get: { tags: ["badge"], security: [], summary: "'Tested by Lumi' badge (SVG, free, earned only)", description: `Shown only while the seller's live Lumi score is at least ${BADGE_MIN_SCORE} with at least ${BADGE_MIN_PAID_TESTS} conclusive paid test-buys and the latest test-buy delivered; otherwise the SVG says 'no badge' (or 'not scored'). Re-evaluated from the live score, never sold; paying Lumi never changes a result. Replaces the retired /badge/{key}.svg (which now answers 301 here, query kept).`, parameters: [{ name: "key", in: "path", required: true, description: "Lumi vendor id (e.g. printmoneylab) or the exact host of a curated vendor's x402 service", schema: { type: "string", maxLength: 200 }, example: "printmoneylab" }], responses: { "200": { description: "SVG badge (also when not earned)", content: { "image/svg+xml": {} } } } } },
    "/v1/badge/{key}.json": { get: { tags: ["badge"], security: [], summary: "'Tested by Lumi' badge verdict (JSON, signed, free)", description: "earned, reason, live score, thresholds and a Lumi-signed object (Ed25519, kind tested_badge, short expires_at). Verify it against Lumi's pinned public keys (lumi-scanner-kit verifyLumiSigned). Replaces the retired /badge/{key}.json (301 here, query kept).", parameters: [{ name: "key", in: "path", required: true, schema: { type: "string", maxLength: 200 }, example: "printmoneylab" }], responses: r({ "200": "OK" }) } },
    "/trust/v/{key}": { get: { tags: ["badge"], security: [], summary: "Public badge result page (HTML, free)", parameters: [{ name: "key", in: "path", required: true, schema: { type: "string", maxLength: 253 }, example: "printmoneylab" }], responses: { "200": { description: "HTML page", content: { "text/html": {} } } } } },
    "/v1/reports": {
      post: {
        tags: tag,
        summary: "Report a paid call to a listed vendor",
        description: "Counts only when verified: the payment must be validated on-ledger (sent by `reporter` to a listed pay-to address, within 7 days) and `signature` must sign `lumi-report:<network>:<tx_hash>` with the payer's key. Unverified submissions are stored privately and never shown. 5/min and 20/day per IP.",
        requestBody: json({
          vendor_id: { type: "string" }, network: { type: "string", enum: ["xrpl:0", "eip155:8453"], default: "xrpl:0" }, tx_hash: { type: "string" }, reporter: { type: "string" }, signature: { type: "string" },
          outcome: { type: "string", enum: ["delivered", "no_data", "empty_result", "error_status", "timeout", "wrong_data", "other"] }, http_status: { type: "integer" }, response_excerpt: { type: "string", maxLength: 4000 },
        }, ["vendor_id", "tx_hash", "reporter", "outcome", "signature"]),
        responses: r({ "201": "Verified and recorded", "400": "Invalid input", "404": "Unknown vendor", "409": "A verified report for this tx exists", "422": "Not verified (stored privately, not shown)", "429": "Rate limited", "503": "Ledger unreachable; nothing stored" }),
      },
    },
    "/v1/trust/receipts/verify": {
      get: { tags: tag, security: [], summary: "How to verify a signed test-buy receipt (free)", responses: r({ "200": "OK" }) },
      post: {
        tags: tag,
        security: [],
        summary: "Verify a signed test-buy receipt (free)",
        description: "Body: a counterparty_delivery_receipt v0.1 (as served in paid vendor reports and paid Feed catalog lookups). Checks the canonical SHA-256 receipt_hash, that the paying wallet signed `lumi-receipt:<network>:<tx_hash>:<receipt_hash>` (XRPL ripple-keypairs / Base EIP-191), and, with ?ledger=1, the payment on-chain. 10/min and 100/day per IP.",
        parameters: [{ name: "ledger", in: "query", required: false, schema: { type: "string", enum: ["1"] } }],
        requestBody: json({ type: { type: "string" }, version: { type: "string" }, receipt_hash: { type: "string" }, signer: { type: "object" }, payment: { type: "object" }, seller: { type: "object" }, delivery: RECEIPT_DELIVERY_SCHEMA, supersedes: { type: "object", description: "Present when this receipt replaces an earlier one for the same tx (correction); the old receipt then verifies with status superseded.", properties: { receipt_hash: { type: "string" }, reason: { type: "string" }, corrections_url: { type: "string" } } } }, ["type", "version", "receipt_hash", "signer", "payment"]),
        responses: r({ "200": "Verification result (ok true/false with errors)", "400": "Invalid JSON", "413": "Body too large", "429": "Rate limited" }),
      },
    },
    "/v1/tips": {
      post: {
        tags: tag,
        summary: "Private tip to Lumi",
        description: "Stored privately. Never shown, published, or returned by any endpoint. 3/min and 10/day per IP.",
        requestBody: json({ text: { type: "string", minLength: 10, maxLength: 1000 }, coins: { type: "array", items: { type: "string" }, maxItems: 10 }, source_urls: { type: "array", items: { type: "string", format: "uri" }, maxItems: 5 } }, ["text"]),
        responses: r({ "202": "Received", "400": "Invalid input", "429": "Rate limited" }),
      },
    },
    "/v1/trust/replies": {
      post: {
        tags: tag,
        summary: "Vendor right to reply",
        description: "Sign `lumi-reply:<vendor_id>:<sha256 hex of text>` with the key of a pay-to address listed for the vendor (XRPL: master key or RegularKey, include public_key; Base: EIP-191). Verified replies are shown with the vendor entry. Or email hello@lumitrades.io.",
        requestBody: json({ vendor_id: { type: "string" }, text: { type: "string", maxLength: 1000 }, network: { type: "string", enum: ["xrpl:0", "eip155:8453"] }, address: { type: "string" }, public_key: { type: "string" }, signature: { type: "string" } }, ["vendor_id", "text", "address", "signature"]),
        responses: r({ "201": "Verified and shown", "400": "Invalid input", "404": "Unknown vendor", "422": "Signature or address not verified (not stored)", "429": "Rate limited" }),
      },
    },
  };
}

/** Product-line grouping of the paid routes (Lumi Trades seller checks, market data). */
export function productLinesDoc() {
  const paths = (line: "trust" | "market_data") => PAID_ENDPOINTS.filter((e) => productLine(e.route) === line).map((e) => e.template);
  return {
    trust: { name: LINE_LABEL.trust, paths: paths("trust"), note: "Observations, not ratings, endorsements or guarantees." },
    market_data: { name: LINE_LABEL.market_data, paths: paths("market_data"), note: "Neutral market data." },
    retired: { on: RETIRED_ON, paths: ["/v1/signal/{coin}", "/v1/lite/{coin}", "/v1/levels/{coin}", "/v1/scan", "/v1/slate", "/v1/brief", "/v1/coins"], status: 410, use: "/v1/check" },
  };
}

function mcpInfo(base: string, cfg: Config) {
  return {
    remote: { url: `${base}/mcp`, transport: "streamable-http", stateless: true },
    stdio: { package: "lumi-trades-mcp", command: "npx -y lumi-trades-mcp", pays_with: "your own wallet, signed locally: XRP, RLUSD or USDC on the XRP Ledger (XRPL_SEED) or USDC on Base, gasless (EVM_PRIVATE_KEY), within per-call caps and a session budget" },
    registry: "io.github.cypher-osiris/lumi-trades-mcp",
    tools: {
      free: ["lumi_catalog", "lumi_samples", "lumi_quote", ...(cfg.verdictPaid ? [] : ["lumi_verdict"]), "lumi_vendor_scores"],
      paid: ["lumi_market", "lumi_macro_yen", "lumi_sentiment", "lumi_funding", "lumi_fear_greed", "lumi_events", "lumi_events_48h", "lumi_institutional_brief", "lumi_trust_check", "lumi_vendor_report", ...(cfg.verdictPaid ? ["lumi_verdict"] : [])],
    },
    note: `On the remote server, paid tools return the price and how to pay: x402 at the REST endpoint (settled in ${settledIn(cfg)}), or the npm package with your wallet. Stale data is never sold.`,
  };
}

const IOU_NAMES: Record<string, string> = { RLUSD: "Ripple USD", USDC: "Circle USDC" };

function orIous(cfg: Config): string {
  return cfg.ious.map((o) => ` or ${o.symbol}`).join("");
}

/** "XRP or RLUSD or USDC on the XRP Ledger, or USDC on Base" */
export function settledIn(cfg: Config): string {
  return `XRP${orIous(cfg)} on the XRP Ledger${cfg.evm ? `, or USDC on ${cfg.evm.networkName}` : ""}${cfg.stellar ? `, or USDC on ${cfg.stellar.networkName}` : ""}`;
}

/** Every payment network, in `accepts` order (Base USDC first when configured, then the XRP Ledger). */
export function paymentNetworks(cfg: Config) {
  const ix = acceptsIndex(cfg);
  const out: Record<string, unknown>[] = [
    {
      network: cfg.network,
      name: cfg.networkName === "mainnet" ? "XRP Ledger" : `XRP Ledger ${cfg.networkName}`,
      scheme: "exact",
      assets: ["XRP", ...cfg.ious.map((o) => o.symbol)],
      accepts_index: ix.xrplRange,
      pay_to: cfg.payTo,
      facilitator: cfg.facilitatorUrl,
      source_tag: cfg.sourceTag,
      payload: "presigned XRPL Payment blob (x402-xrpl)",
    },
  ];
  if (cfg.evm) {
    out.unshift({
      network: cfg.evm.network,
      name: cfg.evm.networkName,
      scheme: "exact",
      assets: ["USDC"],
      token: cfg.evm.asset,
      decimals: cfg.evm.decimals,
      accepts_index: "0",
      pay_to: cfg.evm.payTo,
      facilitator: cfg.evm.cdp ? cfg.evm.cdp.url : cfg.evm.facilitatorUrl,
      ...(cfg.evm.cdp ? { fallback_facilitator: cfg.evm.facilitatorUrl } : {}),
      payload: "EIP-3009 transferWithAuthorization (gasless for the payer; @x402/evm, @x402/fetch)",
    });
  }
  if (cfg.stellar) {
    out.push({
      network: cfg.stellar.network,
      name: cfg.stellar.networkName,
      scheme: "exact",
      assets: ["USDC"],
      token: cfg.stellar.asset,
      decimals: cfg.stellar.decimals,
      accepts_index: String(ix.stellar),
      pay_to: cfg.stellar.payTo,
      facilitator: cfg.stellar.facilitatorUrl,
      payload: "signed SEP-41 USDC transfer (Soroban auth entry); fees sponsored by the facilitator (@x402/stellar, @x402/fetch)",
    });
  }
  return out;
}

function assetsInfo(cfg: Config) {
  const ix = acceptsIndex(cfg);
  const out: Record<string, unknown>[] = [{ symbol: "XRP", asset: "XRP", unit: "drops in accepts[].amount", accepts_index: ix.xrp }];

  cfg.ious.forEach((o, i) =>
    out.push({
      symbol: o.symbol,
      name: IOU_NAMES[o.symbol],
      asset: o.currency,
      issuer: o.issuer,
      unit: 'IOU value string in accepts[].amount (e.g. "0.01" = 1 US cent)',
      accepts_index: ix.iou(i),
      note: `Payer needs a ${o.symbol} trust line to ${o.issuer} and a balance.`,
    }),
  );
  if (cfg.evm) {
    out.unshift({
      symbol: "USDC",
      name: `Circle USDC on ${cfg.evm.networkName}`,
      network: cfg.evm.network,
      asset: cfg.evm.asset,
      unit: 'atomic units (6 decimals) in accepts[].amount (e.g. "10000" = 0.01 USDC)',
      accepts_index: 0,
      pay_to: cfg.evm.payTo,
      note: "EIP-3009 signature only; the facilitator pays gas. Payer needs USDC on Base, no ETH.",
    });
  }
  if (cfg.stellar) {
    out.push({
      symbol: "USDC",
      name: `Circle USDC on ${cfg.stellar.networkName}`,
      network: cfg.stellar.network,
      asset: cfg.stellar.asset,
      unit: 'atomic units (7 decimals) in accepts[].amount (e.g. "100000" = 0.01 USDC)',
      accepts_index: ix.stellar,
      pay_to: cfg.stellar.payTo,
      note: "Signed SEP-41 transfer on the USDC contract; the facilitator sponsors the network fee. Payer needs a USDC trustline and balance on Stellar.",
    });
  }
  return out;
}

function iouNote(cfg: Config): string {
  if (!cfg.ious.length) return "";
  const ix = acceptsIndex(cfg);
  const lines = cfg.ious
    .map(
      (o, i) =>
        `   \`accepts[${ix.iou(i)}]\` is the same quote in **${o.symbol}** (${IOU_NAMES[o.symbol]}): \`{ asset: "${o.currency}", amount: "<value, e.g. 0.01>", extra: { issuer: "${o.issuer}", invoiceId, sourceTag, symbol: "${o.symbol}" } }\`.`,
    )
    .join("\n");
  return `${lines}
   Pick one option and echo it back unchanged as \`accepted\` (all options share one invoice; it can be paid once). To pay in a stablecoin your wallet needs a
   trust line to that issuer and a balance; the Payment's \`Amount\` is \`{ currency, issuer, value }\` and \`SendMax\` equals \`Amount\` (no conversion).
`;
}

export function skillMd(cfg: Config, base: string, coins: CoinRef[]): string {
  const row = (p: ReturnType<typeof priceTable>[number]) => `| \`${p.method} ${p.path}\` | ${p.prices.map((x) => (x.asset === "XRP" && !("chain" in x) ? `${p.price_xrp} XRP (${p.price_drops} drops)` : `${x.amount} ${x.asset}${"chain" in x ? ` on ${x.chain}` : ""}`)).join(" or ")} | ${p.summary} |`;
  const table = (label: string) => `| Endpoint | Price | What you get |\n|---|---|---|\n${priceTable(cfg).filter((p) => p.product_line === label).map(row).join("\n")}`;
  const rows = `### Lumi Trades seller checks (x402 pay-checks and vendor reports)\n\n${table(LINE_LABEL.trust)}\n\n### Market data\n\n${table(LINE_LABEL.market_data)}`;
  const net = cfg.network;
  const wsUrl = net === "xrpl:0" ? "wss://xrplcluster.com" : "wss://s.altnet.rippletest.net:51233";
  const rpcUrl = net === "xrpl:0" ? "https://xrplcluster.com/" : "https://s.altnet.rippletest.net:51234/";
  const maxDrops = Math.max(...Object.values(cfg.pricesDrops).map(Number));
  return `---
name: lumi-api
description: Pay-per-call reads from Lumi Trades, paid in ${settledIn(cfg)} via x402. Lumi Trades seller checks (should I pay this x402 URL?, vendor reports); and neutral market data (BTC + macro backdrop, yen macro watch, Fear & Greed sentiment, funding, events calendar, daily policy brief; no trade calls).
---

# Lumi API (agent guide)

Base URL: ${base}
Network: \`${net}\` (${cfg.networkName}). Assets: XRP${cfg.ious.map((o) => ` or ${o.symbol} (${IOU_NAMES[o.symbol]}, issuer \`${o.issuer}\`, currency \`${o.currency}\`)`).join("")}. Pay to: \`${cfg.payTo}\`.
${cfg.evm ? `Also: \`${cfg.evm.network}\` (${cfg.evm.networkName}). Asset: USDC \`${cfg.evm.asset}\`. Pay to: \`${cfg.evm.payTo}\`. Facilitator: ${cfg.evm.cdp ? `${cfg.evm.cdp.url} (Coinbase CDP; fallback ${cfg.evm.facilitatorUrl})` : cfg.evm.facilitatorUrl}.
` : ""}${cfg.stellar ? `Also: \`${cfg.stellar.network}\` (${cfg.stellar.networkName}). Asset: USDC \`${cfg.stellar.asset}\` (Circle, 7 decimals). Pay to: \`${cfg.stellar.payTo}\`. Facilitator: ${cfg.stellar.facilitatorUrl} (OpenZeppelin, fees sponsored).
` : ""}Protocol: [x402](https://xrpl.org/docs/agents/agentic-payments-x402) v2, \`exact\` scheme (one presigned XRPL Payment per call${cfg.evm ? ", or one EIP-3009 USDC authorization on Base" : ""}${cfg.stellar ? ", or one signed USDC transfer on Stellar" : ""}).
No API key, no account, no sign-up for the per-call endpoints (the optional trust data feed uses keys, see below).
A2A agent card: ${base}/.well-known/agent-card.json. MCP: ${base}/mcp.

## What you can buy

Two groups: **Lumi Trades seller checks** and **market data** (OpenAPI tags \`trust\`, \`market data\`).

${rows}

Retired on ${RETIRED_ON}: \`/v1/signal/{coin}\`, \`/v1/lite/{coin}\`, \`/v1/levels/{coin}\`, \`/v1/scan\`, \`/v1/slate\`, \`/v1/brief\` and \`/v1/coins\`
answer **410 Gone** (JSON pointing to \`/v1/check\`), never a 402, and a payment header sent to them is ignored. Lumi no longer publishes market readings or trade ideas.

Which one to call (Lumi Trades seller checks):
- About to pay some x402 URL? \`GET /v1/trust/check?url=<resource>&payTo=<address in its quote>&amount=<USD>\` returns \`allow\` / \`warn\` / \`block\`
  with coded reasons (payTo or price mismatch vs the listing, never observed, failed quotes, slow, young domain, paid but no data).
- Checking any x402 seller before you pay it? See the lookup and vendor report below.

Which one to call (market data):
- BTC price and the macro backdrop in one call? \`GET /v1/market\`.
- USD/JPY, Nikkei and Japan events? \`GET /v1/macro/yen\`.
- Market mood only? \`GET /v1/sentiment\`. What's scheduled? \`GET /v1/events\`.
- Just one number, cheaply? \`GET /v1/fear-greed\` (CoinMarketCap Fear & Greed + history), \`GET /v1/funding\` (perp funding for the top coins on OKX),
  \`GET /v1/events/next48h\` (only the next 48 hours).
- What are central banks, regulators and big banks doing, and what does it mean for XRP, XLM, XDC, QNT, AXL, HBAR? \`GET /v1/institutional\`
  (daily, sourced; each link labelled \`confirmed\`, \`indirect_alignment\` (Lumi's analysis) or \`context\`; \`?format=md\` for markdown).

Lumi Trades seller checks lookups:
- Checking any x402 seller before you pay it? \`GET /v1/trust/vendors?url=<resource>\` (or \`?domain=\`, \`?payTo=\`) is free and covers the whole CDP Bazaar catalog (answer-only; tx evidence is in the paid \`/v1/trust/check\`, $0.02). For curated vendors, \`GET /v1/trust/vendors/{id}\` is the free summary; \`GET /v1/trust/vendors/{id}/report\` ($0.02)
  is the full observation history (every quote check and paid test-buy with tx hashes, latency stats and trend, uptime %, agent reports, replies).
  Unknown vendor: 404; no observation in the last 48 h: 503. Both before any 402, never charged.

Fields that are not available at request time are omitted, never filled with guesses.

**Not charged on bad input or stale data.** Unknown vendors, bad parameters or unfilled path templates get a 4xx before any quote.
Every paid response carries \`as_of\` (when the data was produced), \`data_age_seconds\`, \`next_update\` (expected next refresh)
and \`stale_after\`. Past \`stale_after\` the endpoint answers 503 "Not charged." instead of a quote, and a payment that arrives
after it is refused before settlement.

**You only pay when you get data.** Before a price is even quoted, the API loads and checks every input the endpoint needs
(present, non-empty, recently refreshed). If anything is missing, empty or stale you get \`503\` with
\`{ "error": "stale_data", "data_age_seconds", "retry_after_seconds", "note": "Not charged." }\` (\`data_unavailable\` when an input is missing) and **no 402 quote**, so no payment can be signed or settled. The response body is built *before* the payment is settled and is
served right after a validated \`tesSUCCESS\`: a settled payment always returns the data you paid for.

Free: \`GET /\`, \`GET /health\`, \`GET /skill.md\`, \`GET /v1/check?url=\`, \`GET /v1/samples\`, \`GET /v1/trust/vendors\` (\`?url=|domain=|payTo=\` lookup), \`GET /v1/trust/catalog\`, \`GET /v1/trust/vendors/{id}\`, \`GET /v1/trust/methodology\`, \`GET /v1/badge/{key}.svg|.json\` (legacy \`/badge\` paths 301 there), \`GET /trust/v/{key}\`, \`GET|POST /v1/trust/receipts/verify\`, \`GET /.well-known/x402\`, \`GET /.well-known/agent-card.json\`, \`GET /.well-known/mcp/server-card.json\`, \`GET /.well-known/agents.json\`, \`GET /openapi.json\`, \`POST /mcp\`, \`POST /a2a\`.

Every paid response is JSON with \`kind\`, \`timestamp\`, \`source: "${SOURCE}"\`, \`as_of\`, \`data_age_seconds\`, \`next_update\`, \`stale_after\`, a \`payment\` block (network, tx hash, explorer link) and a \`disclaimer\`. All timestamps are ISO 8601 UTC.
lumitrades.io publishes market data four times a day (6 AM, 12 PM, 6 PM and 11 PM US Central); the policy brief (\`/v1/institutional\`) once a day (not sold if older than 36 h). Every paid response carries \`as_of\` (the oldest input), \`data_age_seconds\` and \`stale_after\`.

## Free trial: ${TRIAL_LIMITS.perWallet} calls per new wallet (Base or XRPL)

Any paid endpoint (including \`/v1/institutional\`) can be tried for free: ${TRIAL_LIMITS.perWallet} calls per wallet in total (not per endpoint), using the
x402 **sign-in-with-x** extension (CAIP-122). Nothing is charged and no funds move. It works with a Base wallet or an XRP Ledger
wallet; it is one trial per wallet (one shared ledger and the same caps for both chains, not 3 per chain).

1. Send the request with header \`${TRIAL_OPT_IN_HEADER}: 1\`. The 402 then also carries \`extensions["sign-in-with-x"]\` = \`{ info: { domain, uri, version: "1", nonce, issuedAt, expirationTime, statement, resources: [uri] }, supportedChains: ${JSON.stringify(trialChains(cfg.evm?.network, cfg.network))} }\`.
   The challenge is one-time, bound to that exact URL and valid for ${TRIAL_LIMITS.challengeTtlSec / 60} minutes.
2. Sign it with your wallet (proof of control; not a payment):
${cfg.evm ? `   - **Base** (\`type: "eip191"\`): sign the EIP-4361 message for those fields with an EOA on ${cfg.evm.networkName} (EIP-191 \`personal_sign\`). The wallet must hold at least 0.01 USDC on ${cfg.evm.networkName} (checked on-chain, nothing is moved).
` : ""}   - **XRP Ledger** (\`type: "${XRPL_SIWX_TYPE}"\`, \`chainId: "${cfg.network}"\`): build the same CAIP-122 message, with first line \`<domain> wants you to sign in with your XRP Ledger account:\`, your r-address on the second line and \`Chain ID: ${cfg.network.split(":")[1]}\`, then sign its UTF-8 bytes with ripple-keypairs: \`sign(utf8 hex, privateKey)\`. Add \`publicKey\` (hex) to the payload. The key must be the account's master key (not disabled) or its current RegularKey, and the account must be activated (checked on the validated ledger, nothing is moved). XRP, RLUSD and USDC payers all qualify.
3. Retry the same URL with header \`${SIWX_HEADER}: base64(JSON{ domain, address, statement, uri, version, chainId, type, nonce, issuedAt, expirationTime, resources, signature[, publicKey] })\`.
4. You get the normal body plus \`access: { mode: "trial", charged: false, wallet, trial_calls_used, trial_calls_remaining }\`. If the trial is not granted
   (used up, ${TRIAL_LIMITS.perIpDay} per IP per day, bad or reused signature, unfunded wallet) you get the normal 402 with \`trial: { granted: false, reason }\`: just pay.

Without that header the 402 is a plain x402 payment quote (with a top-level \`trial\` hint), so normal payers and discovery scanners see prices only.
A \`PAYMENT-SIGNATURE\` header always takes precedence. REST only (not MCP/A2A).
${cfg.evm ? `
Base, with the official client:

\`\`\`ts
import { wrapFetchWithSIWx } from "@x402/extensions/sign-in-with-x";
import { privateKeyToAccount } from "viem/accounts";
const tryFree = wrapFetchWithSIWx(fetch, privateKeyToAccount(process.env.EVM_PRIVATE_KEY as \`0x\${string}\`));
const r = await tryFree("${base}/v1/sentiment", { headers: { "${TRIAL_OPT_IN_HEADER}": "1" } }); // 200 with access.mode "trial" (first ${TRIAL_LIMITS.perWallet} calls), else the 402 to pay
\`\`\`
` : ""}
XRP Ledger:

\`\`\`ts
${xrplTrialSnippet(base, cfg.network)}
\`\`\`

## How payment works

\`accepts[]\` order: ${acceptsOrder(cfg)}. Choose by \`network\` + \`asset\`, not by position; all options share one invoice that can be paid once.
**Pay address:** always take Lumi's pay address (\`payTo\`) from the live 402 payment response or \`${base}/.well-known/x402\`, never from transaction history or a past transfer.
${cfg.evm ? `Most x402 clients (\`@x402/fetch\` + \`@x402/evm\`) simply take \`accepts[0]\`, USDC on ${cfg.evm.networkName}: see "Paying with USDC" below. The XRPL flow:
` : ""}
1. \`GET ${base}/v1/market\` with no payment -> **HTTP 402**. The body (and the base64 \`PAYMENT-REQUIRED\` header) is an x402 v2 \`PaymentRequired\`:
   \`accepts[${acceptsIndex(cfg).xrp}] = { scheme: "exact", network: "${net}", asset: "XRP", amount: "<drops>", payTo: "${cfg.payTo}", maxTimeoutSeconds: ${cfg.invoiceTtlSeconds}, extra: { invoiceId, sourceTag: ${cfg.sourceTag} } }\`
${iouNote(cfg)}2. Sign (do not submit) an XRPL \`Payment\` for exactly \`amount\` drops to \`payTo\`, with \`SourceTag\`, a \`LastLedgerSequence\`,
   and the invoice bound via a Memo (\`MemoData = hex(utf8(invoiceId))\`) and/or \`InvoiceID = SHA-256(invoiceId)\`.
3. Retry the same request with header \`PAYMENT-SIGNATURE: base64(JSON{ x402Version: 2, accepted: <accepts[${acceptsIndex(cfg).xrp}]>, payload: { signedTxBlob, invoiceId } })\`.
4. The server has the facilitator (${cfg.facilitatorUrl}) verify and submit your payment. On a validated \`tesSUCCESS\` you get **200**
   with the data and a \`PAYMENT-RESPONSE\` header: base64 \`{ success, transaction, network, payer }\`.

Quotes expire after ${cfg.invoiceTtlSeconds}s and each invoice can be paid once. If you get 402 again, read \`error\` and pay the fresh quote.
**Idempotent retries:** send \`Idempotency-Key: <16-128 chars of A-Z a-z 0-9 _ ->\` (or the x402 \`payment-identifier\` extension id) with your payment.
Retrying with the same key and the same payment returns the cached response (header \`Idempotent-Replayed: true\`) and never settles again;
the same key with a different payment gets 409 \`idempotency_key_reused\`, not charged.
503 with \`retryable: true, settlementAttempted: false\` is safe to retry with the same header. 409 \`settlement_status_unknown\`: look up your tx on the ledger before paying again.

The x402-xrpl SDKs (T54, the reference XRPL implementation) do all of this for you.
${cfg.evm ? `
### Paying with USDC on ${cfg.evm.networkName} (accepts[0])

The same 402 lists \`accepts[0]\` = \`{ scheme: "exact", network: "${cfg.evm.network}", asset: "${cfg.evm.asset}", amount: "<atomic USDC, 6 decimals: 10000 = 0.01>", payTo: "${cfg.evm.payTo}", maxTimeoutSeconds: ${cfg.invoiceTtlSeconds}, extra: { name: "${cfg.evm.eip712.name}", version: "${cfg.evm.eip712.version}", invoiceId, symbol: "USDC", decimals: 6 } }\`.
Sign an EIP-3009 \`transferWithAuthorization\` for exactly \`amount\` to \`payTo\` and retry with \`PAYMENT-SIGNATURE: base64(JSON{ x402Version: 2, accepted: <that entry, unchanged>, payload: { signature, authorization: { from, to, value, validAfter, validBefore, nonce } } })\`.
Lumi's facilitator (${cfg.evm.cdp ? `Coinbase CDP, fallback ${cfg.evm.facilitatorUrl}` : cfg.evm.facilitatorUrl}) verifies it and submits it on ${cfg.evm.networkName}, paying the gas: your wallet needs USDC only, no ETH. Same rules: one invoice, one payment, never charged when data is stale.
The official x402 client packages (\`@x402/fetch\` + \`@x402/evm\`) do this for you; USDC on ${cfg.evm.networkName} is the first option, so they pick it by default.
` : ""}${cfg.stellar ? `
### Paying with USDC on ${cfg.stellar.networkName} (accepts[${acceptsIndex(cfg).stellar}])

The same 402 lists \`{ scheme: "exact", network: "${cfg.stellar.network}", asset: "${cfg.stellar.asset}", amount: "<atomic USDC, 7 decimals: 100000 = 0.01>", payTo: "${cfg.stellar.payTo}", maxTimeoutSeconds: ${cfg.invoiceTtlSeconds}, extra: { areFeesSponsored: true, invoiceId, symbol: "USDC", decimals: 7 } }\`.
Sign a SEP-41 \`transfer(from, payTo, amount)\` on the USDC contract (auth entry only) and retry with \`PAYMENT-SIGNATURE: base64(JSON{ x402Version: 2, accepted: <that entry, unchanged>, payload: { transaction: "<XDR>" } })\`.
Lumi's facilitator (${cfg.stellar.facilitatorUrl}, OpenZeppelin Channels) verifies it, sponsors the fee and submits it: your account needs a USDC trustline and balance, no extra XLM. Same rules: one invoice, one payment, never charged when data is stale.
\`@x402/fetch\` + \`@x402/stellar\` (\`createEd25519Signer\`, \`ExactStellarScheme\`, network \`${cfg.stellar.network}\`) do this for you; register only the Stellar scheme so the client picks this option.
` : ""}

## Example: TypeScript / Node (npm \`x402-xrpl\`)

\`\`\`ts
import { Wallet } from "xrpl";
import { x402Fetch, decodePaymentResponseHeader } from "x402-xrpl";

const fetchPaid = x402Fetch({
  wallet: Wallet.fromSeed(process.env.XRPL_SEED!),   // your agent's wallet
  network: "${net}",
  wsUrl: "${wsUrl}",
  maxValue: "${maxDrops}",                            // spend cap per call, in drops
});

const res = await fetchPaid("${base}/v1/market");
console.log(res.status, await res.json());
const receipt = res.headers.get("PAYMENT-RESPONSE");
if (receipt) console.log(decodePaymentResponseHeader(receipt)); // { success, transaction, ... }
\`\`\`
${cfg.ious.length ? `
Pay in a stablecoin instead (wallet must hold it on a trust line to the issuer):

\`\`\`ts
const STABLE = { ${cfg.ious.map((o) => `${o.symbol}: { currency: "${o.currency}", issuer: "${o.issuer}" }`).join(", ")} };
const want = STABLE.${cfg.ious[0].symbol};
const fetchStable = x402Fetch({
  wallet: Wallet.fromSeed(process.env.XRPL_SEED!),
  network: "${net}",
  wsUrl: "${wsUrl}",
  // pick the stablecoin option and cap it at 0.05 per call
  paymentRequirementsSelector: (accepts) => {
    const r = accepts.find((a: any) => a.asset === want.currency && a.extra?.issuer === want.issuer);
    if (!r || Number(r.amount) > 0.05) throw new Error("no acceptable stablecoin quote");
    return r;
  },
});
\`\`\`
Note: the SDK's numeric \`maxValue\` compares raw \`amount\` strings across assets (drops for XRP, a decimal value for stablecoins), so use a selector like the one above when paying in a stablecoin.
` : ""}

${cfg.evm ? `## Example: USDC on ${cfg.evm.networkName} (npm \`@x402/fetch\`, \`@x402/evm\`, \`viem\`)

\`\`\`ts
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.EVM_PRIVATE_KEY as \`0x\${string}\`) });
const fetchPaid = wrapFetchWithPayment(fetch, client);   // picks the ${cfg.evm.network} USDC option

const res = await fetchPaid("${base}/v1/market");
console.log(res.status, await res.json());
console.log(decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!)); // { success, transaction, network, payer }
\`\`\`

## Example: Coinbase AgentKit (direct URL, USDC on ${cfg.evm.networkName})

AgentKit 0.10.4's \`discover_x402_services\` currently hides x402 v2 sellers (it reads \`metadata.description\`, the Bazaar returns \`description\`),
so give your agent the URL directly. \`make_http_request\` gets the 402 and keeps the ${cfg.evm.network} option; \`retry_http_request_with_x402\` pays it.

\`\`\`ts
// npm i @coinbase/agentkit viem
import { AgentKit, ViemWalletProvider, x402ActionProvider } from "@coinbase/agentkit";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const walletProvider = new ViemWalletProvider(createWalletClient({
  account: privateKeyToAccount(process.env.EVM_PRIVATE_KEY as \`0x\${string}\`), chain: base, transport: http(),
}));
const agentkit = await AgentKit.from({ walletProvider, actionProviders: [x402ActionProvider()] });
const act = (n: string) => agentkit.getActions().find((a) => a.name.endsWith(n))!;

const url = "${base}/v1/market";
const quote = JSON.parse(await act("make_http_request").invoke({ url }));        // status: error_402_payment_required
const o = quote.acceptablePaymentOptions.find((x: any) => x.network === "${cfg.evm.network}"); // amount "20000" = $0.02
const paid = JSON.parse(await act("retry_http_request_with_x402").invoke({
  url, method: "GET",
  selectedPaymentOption: { scheme: o.scheme, network: o.network, asset: o.asset, amount: o.amount, payTo: o.payTo },
}));
console.log(paid.data, paid.details?.paymentProof);
\`\`\`
In an LLM agent with AgentKit tools, the prompt "call ${base}/v1/market and pay the Base USDC option" does the same.
Full runnable version: https://github.com/cypher-osiris/lumi-api/blob/main/examples/agentkit-direct-url.ts

` : ""}## Example: Python (PyPI \`x402-xrpl\`)

\`\`\`python
import os
from xrpl.wallet import Wallet
from x402_xrpl.clients import x402_requests, decode_payment_response

session = x402_requests(
    Wallet.from_seed(os.environ["XRPL_SEED"]),
    rpc_url="${rpcUrl}",
    network_filter="${net}",
    scheme_filter="exact",
)
r = session.get("${base}/v1/market", timeout=180)
print(r.status_code, r.json()["macro"]["yen_note"])
print(decode_payment_response(r.headers["PAYMENT-RESPONSE"]))
\`\`\`

## MCP

- **Remote MCP server:** \`${base}/mcp\` (Streamable HTTP, stateless; protocol 2026-07-28 and 2025-03-26 .. 2025-11-25).
  Add it as a remote MCP connector URL. Free tools: \`lumi_catalog\`, \`lumi_samples\`, \`lumi_quote\`${cfg.verdictPaid ? "" : ", `lumi_verdict`"}, \`lumi_vendor_scores\`. Paid tools
  return the price and how to pay (x402 at the REST endpoint, settled in ${settledIn(cfg)}), since a remote connector has no wallet:
  Lumi Trades seller checks ${cfg.verdictPaid ? "`lumi_verdict` ($0.01), " : ""}\`lumi_trust_check\`, \`lumi_vendor_report\`; market data \`lumi_market\`, \`lumi_macro_yen\`, \`lumi_sentiment\`, \`lumi_funding\`,
  \`lumi_fear_greed\`, \`lumi_events\`, \`lumi_events_48h\`, \`lumi_institutional_brief\`. The reading, levels, scan, slate, brief and coins tools were retired on ${RETIRED_ON}.
- **Local MCP server that pays for you:** \`npx -y lumi-trades-mcp\` with \`XRPL_SEED\` (XRP/RLUSD/USDC on the XRP Ledger) and/or
  \`EVM_PRIVATE_KEY\` (USDC on Base, gasless) set (npm \`lumi-trades-mcp\`, MCP Registry \`io.github.cypher-osiris/lumi-trades-mcp\`).
  Same tools; each paid call is an x402 payment from your wallet within a per-call cap (\`LUMI_MAX_USD_PER_CALL\`, default 0.30, which covers every endpoint) and a session budget.

\`\`\`json
{ "mcpServers": { "lumi": { "command": "npx", "args": ["-y", "lumi-trades-mcp"], "env": { "EVM_PRIVATE_KEY": "0x...", "LUMI_MAX_USD_PER_CALL": "0.30" } } } }
\`\`\`

## A2A

- **Agent card:** \`${base}/.well-known/agent-card.json\` (alias \`/.well-known/agent.json\`), A2A 1.0 and 0.3: \`supportedInterfaces\` lists both (protocolVersion 1.0 and 0.3), and the top-level 0.3 fields say \`protocolVersion: "0.3.0"\`, so 0.3-only registries show 0.3.0.
- **JSON-RPC endpoint:** \`POST ${base}/a2a\` with \`SendMessage\` (A2A 1.0) or \`message/send\` (0.3). Send text such as "catalog" or
  "should I pay https://example.com/api", or a data part \`{ "skill": "vendor_trust", "url": "https://example.com/api" }\`. Free skills (\`catalog\`, \`quote\`, \`vendor_trust\`) answer inline. Paid skills answer with
  the live x402 terms (every network option) and the REST URL to pay at; nothing is charged over A2A.

## x402 vendor observations (free)

Lumi publishes its automated observations of other x402 sellers on the XRP Ledger: an unpaid 402-quote check of each listed endpoint every 30 minutes,
and small paid test-buys from Lumi's own wallets, each with the amount, ledger tx hash, HTTP status and whether the response contained data.
Test-buys are capped and disclosed: test-buys share a hard cap of about $0.50 a day (0.30 RLUSD + 0.10 XRP for curated XRPL vendors, plus up to 0.15 USDC for Stellar sellers) (not every vendor is bought every day), Base catalog re-buys are capped at $0.10 per day, and no listing priced above $0.05 is bought. The real cadence per vendor is in the coverage figures of /v1/trust/vendors.
Scores are observations with sample sizes, not ratings; few samples are marked low confidence; vendors are listed in allowlist order, not ranked.

- Lookup before you pay: \`GET ${base}/v1/trust/vendors?url=<resource>\` | \`?domain=\` | \`?payTo=\` (full CDP Bazaar catalog, free quote checks on a rotating schedule = "quote-checked, low confidence"; not every listing is checked yet, the response's \`coverage\` line says "N resources across M domains indexed, X quote-checked, Y test-bought on Base (USDC); separately, Z XRPL endpoints from curated vendors test-bought"; on-chain test-buys = "test-bought", counted per chain: Base USDC buys of Bazaar listings vs XRPL buys of a small curated list (\`purchase_verified_by_chain\`); no match = \`{observed:false}\`, not a negative finding). Free lookups are answer-only (tier, last quote check, test-buy count; no tx hashes) and rate-limited per client; evidence is in the paid \`/v1/trust/check\` ($0.02) and \`/v1/trust/vendors/{id}/report\` ($0.02). Browse a teaser (top 100 most-used, 25 per page, 40 requests/day): \`GET ${base}/v1/trust/catalog?page=1\`.
- \`GET ${base}/v1/trust/vendors\`, \`GET ${base}/v1/trust/vendors/{id}\`, method: \`GET ${base}/v1/trust/methodology\`. MCP: \`lumi_vendor_scores\`. A2A: \`vendor_trust\`.
- **"Tested by Lumi" badge (free, for sellers, earned only):** \`GET ${base}/v1/badge/{key}.svg\` (and \`.json\`, a Lumi-signed verdict), key = your Lumi vendor id or the exact host of your curated x402 service. Shown only while your live Lumi score is at least ${BADGE_MIN_SCORE} with at least ${BADGE_MIN_PAID_TESTS} conclusive paid test-buys and the latest test-buy delivered; removed automatically when you drop below; never sold, and paying Lumi never changes a result. Links to the public result page \`${base}/trust/v/{key}\` (dated tests, how Lumi tests, right to reply via hello@lumitrades.io). Embed (Markdown/README): \`[![Tested by Lumi](${base}/v1/badge/{key}.svg)](${base}/trust/v/{key})\`; HTML: \`<a href="${base}/trust/v/{key}"><img src="${base}/v1/badge/{key}.svg" alt="Tested by Lumi" height="20"></a>\`. Docs: \`GET ${base}/v1/badge\`. The old \`/badge\` paths are retired and answer 301 to \`/v1/badge\` (query kept).
- **Paid detailed report ($0.02 per call, x402 on every rail):** \`GET ${base}/v1/trust/vendors/{id}/report\`: full observation history (every free quote
  check over 90 days, every paid test-buy with tx hash and delivered yes/no), latency min/p50/p90/p95/max and 7-day trend, uptime % for 24h/7d/30d/90d and a
  daily series, quoted-price history, agent reports, vendor replies, sample sizes and confidence labels. Not sold (503, not charged) if Lumi has no
  observation of the vendor in the last 48 h. MCP: \`lumi_vendor_report\`. A2A: \`vendor_report\`.
- **Paid pay-check ($0.02 per call):** \`GET ${base}/v1/trust/check?url=<resource>[&payTo=<address>][&amount=<USD>]\`: one verdict, \`allow\`, \`warn\` or \`block\`,
  with coded reasons (\`pay_to_mismatch\`, \`price_above_listing\`, \`paid_no_data\`, \`not_observed\`, \`unreliable_quotes\`, \`slow\`, \`young_domain\` ...), a confidence label,
  and links to the free lookup and (for curated vendors) the $0.02 report. A bad or missing \`url\` gets 400 before any quote. MCP: \`lumi_trust_check\`. A2A: \`trust_check\`.
- **Pre-payment check, one label (${cfg.verdictPaid ? "paid, $0.01 per call" : "free, rate-limited"}):** \`GET ${base}/v1/verdict?url=<resource or seller domain>[&payTo=<address>][&amount=<USD>]\`.
  Same data and signing key as \`/v1/check\` (embedded signed \`check_receipt\`), signed as \`lumi_verdict\`. Labels: \`checks_passed\` "Delivered in recent checks",
  \`check_first\` "Check first", \`checks_failed\` "Recent checks failed", \`no_data\` "Not enough data" (not a negative finding). Mapping from the older
  \`decision\`: allow -> checks_passed, warn -> check_first, block -> checks_failed, unknown -> no_data. Every answer carries \`as_of\`, \`evidence_window\`,
  \`n_conclusive\`, \`last_delivered_at\`, \`last_failed_at\`, \`reason_codes\`, evidence and reply/appeal links (https://lumitrades.io/contact/) and
  \`commercial_relationship\` (disclosure only). Paying Lumi, including seller monitoring, never changes a result. Thresholds and definitions:
  \`GET ${base}/v1/verdict/rules\`. MCP: \`lumi_verdict\`.
- **Report a call you paid for:** \`POST ${base}/v1/reports\` with \`{vendor_id, network, tx_hash, reporter, outcome, signature}\`, where \`signature\` signs
  \`lumi-report:<network>:<tx_hash>\` with the paying key. Only reports with an on-ledger payment and a valid signature are shown or scored.
- **Private tips:** \`POST ${base}/v1/tips\` \`{text, coins?, source_urls?}\`. Stored privately; never published or returned.
- **Vendors can reply:** sign \`lumi-reply:<vendor_id>:<sha256 of text>\` with a listed pay-to key and \`POST ${base}/v1/trust/replies\`, or email hello@lumitrades.io.
${commerceSkillMd(base)}
## Rules of use

- ${DISCLAIMER}
- Market data is general information. Do not present it as personalised advice or as a recommendation about any asset.
- Cite "Lumi Trades (lumitrades.io)" when you surface this data to people.
`;
}

const LOGO = "https://lumitrades.io/assets/icon-512.png";
/** Social / x402scan card for api.lumitrades.io (the page <title> stays descriptive). */
export const OG_TITLE = "Lumi Trades: check x402 sellers before you pay";
export const OG_DESC = "Lumi Check: free signed allow/warn/block for x402 sellers, backed by paid test-buys on XRPL, Base and Stellar.";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Human quickstart served at `/` when the client asks for text/html (browsers, x402scan's page fetcher). */
export function indexHtml(cfg: Config, base: string, coins: CoinRef[]): string {
  const title = "Lumi API: x402 seller checks before you pay, plus crypto market data (pay on XRPL, Base or Stellar)";
  const desc =
    "Free x402 vendor trust observations and paid pay-checks (Lumi Trades seller checks), and neutral crypto market data (BTC and macro backdrop, funding, Fear & Greed, sentiment, events, a daily policy brief; information only, no trade calls) for AI agents. No API key: most calls cost $0.003-$0.02 with x402 in USDC on Base, XRP/RLUSD/USDC on the XRP Ledger or USDC on Stellar, and new wallets get 3 free trial calls in total, not per endpoint (a Base wallet holding at least 0.01 USDC or an activated XRP Ledger account; one trial per wallet).";
  const rowOf = (p: ReturnType<typeof priceTable>[number]) => {
    const usd = p.price_base_usdc ?? p.price_rlusd ?? p.price_usdc;
    return `<tr><td><code>${esc(`${p.method} ${p.path}`)}</code></td><td>${usd ? `$${esc(String(usd))}` : ""}</td><td>${esc(p.price_xrp)} XRP</td><td>${esc(p.summary)}</td></tr>`;
  };
  const group = (label: string, head: string) =>
    `<tr class="grp"><th colspan="4" id="${esc(label.toLowerCase().replace(/[^a-z]+/g, "-"))}">${head}</th></tr>\n` + priceTable(cfg).filter((p) => p.product_line === label).map(rowOf).join("\n");
  const rows = [
    group(LINE_LABEL.trust, "Lumi Trades seller checks: x402 pay-checks and vendor reports"),
    group(LINE_LABEL.market_data, "Market data"),
  ].join("\n");
  const evm = cfg.evm;
  const baseSnippet = evm
    ? `// npm i @x402/fetch @x402/evm viem
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.EVM_PRIVATE_KEY) });
const res = await wrapFetchWithPayment(fetch, client)("${base}/v1/market"); // $0.02 USDC on Base, gasless
console.log(await res.json());`
    : "";
  const agentkitSnippet = evm
    ? `// npm i @coinbase/agentkit viem   (call the URL directly; discover_x402_services hides v2 sellers in 0.10.4)
const quote = JSON.parse(await act("make_http_request").invoke({ url: "${base}/v1/market" }));
const o = quote.acceptablePaymentOptions.find((x) => x.network === "${evm.network}");
const paid = await act("retry_http_request_with_x402").invoke({ url: "${base}/v1/market", method: "GET",
  selectedPaymentOption: { scheme: o.scheme, network: o.network, asset: o.asset, amount: o.amount, payTo: o.payTo } });`
    : "";
  const trialSnippet = evm
    ? `// npm i @x402/extensions viem   (3 free calls per new wallet; nothing is charged)
import { wrapFetchWithSIWx } from "@x402/extensions/sign-in-with-x";
import { privateKeyToAccount } from "viem/accounts";

const tryFree = wrapFetchWithSIWx(fetch, privateKeyToAccount(process.env.EVM_PRIVATE_KEY));
const res = await tryFree("${base}/v1/sentiment", { headers: { "${TRIAL_OPT_IN_HEADER}": "1" } });
const body = await res.json(); // body.access = { mode: "trial", charged: false, trial_calls_remaining, ... }`
    : "";
  const xrplSnippet = `// npm i xrpl x402-xrpl
import { Wallet } from "xrpl";
import { x402Fetch } from "x402-xrpl";

const fetchPaid = x402Fetch({ wallet: Wallet.fromSeed(process.env.XRPL_SEED), network: "${cfg.network}",
  wsUrl: "wss://xrplcluster.com", maxValue: "100000" }); // cap: 0.1 XRP per call
const res = await fetchPaid("${base}/v1/market");
console.log(await res.json());`;
  const mcpSnippet = `{ "mcpServers": {
  "lumi-remote": { "url": "${base}/mcp" },
  "lumi": { "command": "npx", "args": ["-y", "lumi-trades-mcp"],
            "env": { "EVM_PRIVATE_KEY": "0x... (USDC on Base)", "LUMI_MAX_USD_PER_CALL": "0.30" } } } }`;
  const pre = (s: string) => `<pre><code>${esc(s)}</code></pre>`;
  const keywords = [
    "x402", "pay per call API", "x402 seller check", "crypto API", "crypto market data", "bitcoin",
    "institutional policy brief", "CBDC", "tokenization", "stablecoins", "RLUSD", "USDC on Base",
    "XRP Ledger", "XRPL", "AI agents", "agentic payments", "MCP server", "A2A agent", "Coinbase x402 Bazaar", "x402 vendor trust scores",
  ].join(", ");
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebAPI",
    name: "Lumi API",
    alternateName: "Lumi Trades API",
    url: `${base}/`,
    description: desc,
    documentation: `${base}/openapi.json`,
    provider: { "@type": "Organization", name: "Lumi Trades", url: "https://lumitrades.io/", logo: LOGO },
    keywords,
    offers: priceTable(cfg).map((p) => ({ "@type": "Offer", name: `${p.method} ${p.path}`, description: p.summary, price: String(p.price_base_usdc ?? p.price_rlusd ?? p.price_usdc ?? ""), priceCurrency: "USD" })),
  }).replace(/</g, "\\u003c");
  const quick: [string, string, string][] = [
    ["skill.md", `${base}/skill.md`, "Agent instructions"],
    ["openapi.json", `${base}/openapi.json`, "OpenAPI 3.1 with x-payment-info"],
    [".well-known/x402", `${base}/.well-known/x402`, "x402 discovery"],
    ["/mcp", `${base}/mcp`, "Remote MCP (streamable HTTP)"],
    ["agent card", `${base}/.well-known/agent-card.json`, "A2A agent card"],
    ["llms.txt", `${base}/llms.txt`, "LLM-readable overview"],
  ];
  const quickHtml = quick.map(([n, u, d]) => `<a class="ql" href="${esc(u)}"><code>${esc(n)}</code><span>${esc(d)}</span></a>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="keywords" content="${esc(keywords)}">
<meta name="theme-color" content="#070a10">
<meta property="og:title" content="${esc(OG_TITLE)}"><meta property="og:description" content="${esc(OG_DESC)}">
<meta name="twitter:card" content="summary"><meta name="twitter:title" content="${esc(OG_TITLE)}"><meta name="twitter:description" content="${esc(OG_DESC)}">
<meta property="og:url" content="${esc(base)}/"><meta property="og:type" content="website"><meta property="og:image" content="${LOGO}">
<link rel="icon" href="${LOGO}"><link rel="canonical" href="${esc(base)}/">
<link rel="alternate" type="application/json" href="${esc(base)}/"><link rel="alternate" type="text/markdown" href="${esc(base)}/llms.txt">
<script type="application/ld+json">${jsonLd}</script>
<style>
:root{--bg:#070a10;--bg2:#0b1019;--glass:rgba(22,29,42,.62);--line:rgba(148,163,184,.14);--text:#e7edf5;--muted:#8b99ad;--cyan:#22d3ee;--violet:#a78bfa;--grad:linear-gradient(135deg,var(--cyan),var(--violet))}
*{box-sizing:border-box}html{background:var(--bg)}
body{margin:0;color:var(--text);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,Inter,sans-serif;
background:radial-gradient(900px 500px at 10% -10%,rgba(34,211,238,.10),transparent 60%),radial-gradient(800px 500px at 100% 0,rgba(167,139,250,.10),transparent 60%),linear-gradient(180deg,var(--bg2),var(--bg) 600px);min-height:100vh}
a{color:var(--cyan);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
header{position:sticky;top:0;z-index:5;backdrop-filter:blur(10px);background:rgba(7,10,16,.78);border-bottom:1px solid var(--line)}
header .wrap{display:flex;align-items:center;gap:16px;height:60px}
.brand{display:flex;align-items:center;gap:10px;color:var(--text);font-weight:700;font-size:17px}.brand img{border-radius:9px}
.brand b{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
nav{margin-left:auto;display:flex;gap:18px;font-size:14px}nav a{color:var(--muted)}nav a:hover{color:var(--text);text-decoration:none}
.hero{padding:56px 0 28px}.eyebrow{display:inline-block;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:4px 12px}
h1{font-size:clamp(30px,5vw,46px);line-height:1.12;margin:16px 0 12px;letter-spacing:-.02em}
h1 span{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.pitch{font-size:19px;color:var(--text);margin:0 0 10px;max-width:760px}.lead{color:var(--muted);max-width:820px;margin:0}
.cta{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}
.btn{display:inline-block;padding:10px 16px;border-radius:10px;border:1px solid var(--line);background:var(--glass);color:var(--text);font-weight:600;font-size:14px}
.btn.p{background:var(--grad);color:#06121f;border:0}.btn:hover{text-decoration:none;filter:brightness(1.08)}
h2{font-size:22px;margin:40px 0 12px;letter-spacing:-.01em}h2::after{content:"";display:block;width:44px;height:3px;border-radius:3px;background:var(--grad);margin-top:8px}
.card{background:var(--glass);border:1px solid var(--line);border-radius:14px;padding:18px 20px}
.free a{white-space:nowrap}
.qls{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.ql{display:flex;flex-direction:column;gap:2px;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:var(--glass)}
.ql:hover{border-color:rgba(34,211,238,.45);text-decoration:none}.ql code{color:var(--cyan);font-size:14px}.ql span{color:var(--muted);font-size:13px}
.tbl{overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:var(--glass)}
table{border-collapse:collapse;width:100%;font-size:14px;min-width:640px}
th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);text-align:left;padding:12px 14px;border-bottom:1px solid var(--line);background:rgba(11,16,25,.6)}
tr.grp th{color:var(--text);font-size:13px;background:rgba(34,211,238,.06)}
td{padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}tbody tr:hover td{background:rgba(34,211,238,.04)}
td:nth-child(2){font-weight:700;color:#7dd3fc;white-space:nowrap}td:nth-child(3){color:var(--muted);white-space:nowrap}
code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}td code{color:var(--text)}
pre{background:#05080d;border:1px solid var(--line);padding:14px 16px;overflow:auto;border-radius:12px;font-size:13px;color:#d3dbe6}
.note{color:var(--muted);font-size:14px}
footer{margin:48px 0 0;padding:22px 0 40px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
@media (max-width:640px){nav{gap:12px;font-size:13px}.brand span.t{display:none}.hero{padding:36px 0 16px}.pitch{font-size:17px}}
</style>
</head><body>
<header><div class="wrap">
<a class="brand" href="https://lumitrades.io/"><img src="${LOGO}" width="34" height="34" alt="Lumi logo"><span class="t">Lumi <b>API</b></span></a>
<nav><a href="https://lumitrades.io/">lumitrades.io</a><a href="https://lumitrades.io/agents/">Agents</a><a href="https://lumitrades.io/trust/">Trust</a></nav>
</div></header>
<main class="wrap">
<section class="hero">
<span class="eyebrow">x402 &middot; USDC on Base &middot; XRP / RLUSD / USDC on XRPL</span>
<h1>Lumi API: <span>x402 trust checks &amp; crypto market data for AI agents</span></h1>
<p class="pitch">Pay-per-call crypto data for agents: no API key, no signup, from $0.003 per call over x402.</p>
<p class="lead">${esc(desc)}</p>
<div class="cta"><a class="btn p" href="${esc(base)}/skill.md">Agent quickstart (skill.md)</a><a class="btn" href="${esc(base)}/v1/samples">Free samples</a><a class="btn" href="${esc(base)}/v1/trust/vendors">x402 vendor trust (free)</a></div>
</section>
<div class="card free"><p style="margin:0"><strong>Free:</strong> <a href="${esc(base)}/v1/trust/vendors">x402 vendor trust list</a> (seller lookup <code>?url=</code>, answer-only) &middot;
<a href="${esc(base)}/v1/trust/catalog">catalog teaser</a> (top 100 listings) &middot;
<a href="${esc(base)}/v1/trust/methodology">methodology</a> &middot; <a href="${esc(base)}/v1/badge">Tested by Lumi badge</a> &middot; <a href="${esc(base)}/v1/check">free seller check</a> &middot; <a href="${esc(base)}/v1/samples">free samples</a> &middot;
<a href="${esc(base)}/llms.txt">llms.txt</a> &middot; <a href="${esc(base)}/openapi.json">OpenAPI</a> &middot;
<a href="${esc(base)}/.well-known/agent-card.json">A2A card</a> &middot; MCP <code>${esc(base)}/mcp</code><br>
<strong>Free trial:</strong> ${TRIAL_LIMITS.perWallet} free calls per new wallet in total (not per endpoint), usable on any paid endpoint including <code>/v1/institutional</code>: send <code>X-Lumi-Trial: 1</code> and sign the 402's <code>sign-in-with-x</code> challenge with ${cfg.evm ? "a Base wallet holding at least 0.01 USDC or " : ""}an activated XRP Ledger account (no payment, nothing moves; one trial per wallet). <a href="#trial">How</a>.<br>
<strong>New:</strong> <a href="${esc(base)}/v1/trust/check?url=https%3A%2F%2Fapi.example.com%2Fv1%2Fdata">/v1/trust/check</a> (should I pay this x402 URL? allow / warn / block, $${usdPrice(cfg, "trust_check")}) &middot;
<a href="${esc(base)}/v1/funding">/v1/funding</a> &middot; <a href="${esc(base)}/v1/fear-greed">/v1/fear-greed</a> &middot; <a href="${esc(base)}/v1/events/next48h">/v1/events/next48h</a><br>
<strong>Retired ${RETIRED_ON}:</strong> per-coin readings, levels, the scan, the watchlist slate and the market brief (410 Gone, never charged).<br>
<strong>Pay address:</strong> always take Lumi's pay address (<code>payTo</code>) from the live 402 payment response or <a href="${esc(base)}/.well-known/x402">/.well-known/x402</a>, never from transaction history or a past transfer.</p></div>
<h2>For agents</h2>
<div class="qls">
${quickHtml}
</div>
<h2>What you can buy</h2>
<div class="tbl"><table><thead><tr><th>Endpoint</th><th>USD</th><th>XRP</th><th>What you get</th></tr></thead><tbody>
${rows}</tbody></table></div>
<p class="note">Every response carries <code>as_of</code>, <code>data_age_seconds</code>, <code>next_update</code> and <code>stale_after</code> (ISO UTC). You only pay when you get data: not charged on bad input (4xx before any quote) or stale data (503 "Not charged." past <code>stale_after</code>).</p>
<h2 id="monitoring">For x402 sellers: monitoring</h2>
<div class="tbl"><table><thead><tr><th>Plan</th><th>USD</th><th>What you get</th></tr></thead><tbody>
${planPriceTable(base).filter((p) => p.path.startsWith("/v1/monitor")).map((p) => `<tr><td><code>GET ${esc(p.path)}</code></td><td>$${esc(p.price_usd)}${p.per ? " per endpoint" : ""}${p.term_days ? ` / ${p.term_days} days` : " one-off"}${p.legacy ? " (legacy, grandfathered)" : ""}</td><td>${esc(p.summary)}</td></tr>`).join("\n")}
<tr><td><code>POST /v1/monitor/free</code></td><td>$0</td><td>Free Watch: ${WATCH_FREE.endpoints} endpoint, a daily quote check, no test-buys, no badge (status page labelled &ldquo;${esc(WATCH_FREE.label)}&rdquo;).</td></tr>
<tr><td><code>POST /v1/monitor/trial</code></td><td>$0</td><td>${WATCH_TRIAL.days}-day Watch Plus trial, one per seller (prove the domain and the payTo wallet), test-buys capped at $${WATCH_TRIAL.capUsd} in total, no card, never auto-converts. ${WATCH_TRIAL_END}</td></tr></tbody></table></div>
<p class="note">Prove your payTo with a signature, enrol endpoints (test-buys capped at $0.05 each on Watch and $0.10 on Watch Plus / Pro, seller-funded and labelled so, never more than half the fee), pay over x402 per endpoint (${WATCH_DISCOUNTS.volumeMinEndpoints}+ endpoints -${WATCH_DISCOUNTS.volume * 100}%, ${WATCH_DISCOUNTS.prepayTerms} terms prepaid -${WATCH_DISCOUNTS.prepay * 100}%); no auto-renew. Status page: <code>/v1/monitor/status/&lt;id&gt;</code>. Paying never changes a score; findings can be replied to, not removed; the badge is removed automatically if a test fails or the plan lapses. <a href="${esc(base)}/v1/monitor">How it works</a> &middot; <a href="${esc(base)}/v1/monitor/sellers">Monitored sellers</a> &middot; <a href="${esc(base)}/v1/monitor/corrections">Corrections</a></p>
<h2 id="feed">For facilitators, wallets and frameworks: trust data feed</h2>
<div class="tbl"><table><thead><tr><th>Plan</th><th>USD</th><th>What you get</th></tr></thead><tbody>
<tr><td>Free key</td><td>$0</td><td>1,000 lookups / month per key (wallet signature), answer-only.</td></tr>
${planPriceTable(base).filter((p) => p.path.startsWith("/v1/feed")).map((p) => `<tr><td><code>GET ${esc(p.path)}</code></td><td>$${esc(p.price_usd)}${p.term_days ? ` / ${p.term_days} days` : ""}</td><td>${esc(p.summary)}</td></tr>`).join("\n")}</tbody></table></div>
<p class="note"><a href="${esc(base)}/v1/feed">Feed docs</a> &middot; <a href="${esc(base)}/v1/feed/license">Licence terms</a> (no resale of raw data, attribution required).</p>
${evm ? `<h2>Quickstart: USDC on Base (x402 fetch SDK)</h2>${pre(baseSnippet)}
<h2>Quickstart: Coinbase AgentKit</h2>${pre(agentkitSnippet)}
<p class="note">Full runnable example: <a href="https://github.com/cypher-osiris/lumi-api/blob/main/examples/agentkit-direct-url.ts">examples/agentkit-direct-url.ts</a></p>` : ""}
<h2 id="trial">Free trial: ${TRIAL_LIMITS.perWallet} calls per new wallet (Base or XRPL)</h2>${cfg.evm ? pre(trialSnippet) : ""}${pre(xrplTrialSnippet(base, cfg.network))}
<p class="note">Uses the x402 <code>sign-in-with-x</code> extension (CAIP-122). ${cfg.evm ? `Base: EIP-4361 signed by an EOA holding at least 0.01 USDC on ${esc(cfg.evm.networkName)}. ` : ""}XRP Ledger: type <code>xrpl</code>, signed with the account's master key or current regular key (ripple-keypairs) plus <code>publicKey</code>; the account must be activated. Nothing is charged or moved. Limits: ${TRIAL_LIMITS.perWallet} per wallet (one trial per wallet, not per chain), ${TRIAL_LIMITS.perIpDay} per IP per day, one-time 5-minute challenges. The response carries <code>access.mode: "trial"</code>, <code>charged: false</code>. After that, pay per call as usual.</p>
<h2>Quickstart: XRP Ledger (XRP, RLUSD, USDC)</h2>${pre(xrplSnippet)}
<h2>MCP (Claude, Cursor, any MCP client)</h2>${pre(mcpSnippet)}
<p class="note">The remote server lists prices and payment terms; the npm package <code>lumi-trades-mcp</code> pays from your own wallet within per-call caps.</p>
</main>
<footer><div class="wrap"><small>${esc(DISCLAIMER)} Source: Lumi Trades (lumitrades.io). API v${VERSION}.</small></div></footer>
</body></html>`;
}

/**
 * Human page for a browser that opens a vendor report link without paying (Accept ranks text/html first, no payment header).
 * Explains the paid x402 call and links the docs; agents (JSON / any other Accept) still get the normal 402 quote.
 */
export function vendorReportHtml(cfg: Config, base: string, id: string, name: string | null): string {
  const usd = String(Number(usdPrice(cfg, "vendor_report") ?? "0.02"));
  const url = `${base}/v1/trust/vendors/${encodeURIComponent(id)}/report`;
  const free = `${base}/v1/trust/vendors/${encodeURIComponent(id)}`;
  const who = name ? `${esc(name)} (<code>${esc(id)}</code>)` : `<code>${esc(id)}</code>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lumi vendor report: ${esc(name ?? id)} ($${esc(usd)} x402 call)</title>
<meta name="robots" content="noindex">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;color:#111}code,pre{background:#f3f3f3;border-radius:4px;padding:.1rem .3rem}pre{padding:.75rem;overflow:auto}a{color:#0645ad}</style>
</head><body>
<h1>Vendor report: ${who}</h1>
<p>This URL is a <strong>paid API call</strong>: $${esc(usd)} per request, paid with <a href="https://x402.org">x402</a> on XRPL, Base or Stellar. A browser visit is not charged and gets this page instead.</p>
<p>The paid report adds Lumi's full test-buy history for this vendor (each paid test-buy with its transaction, HTTP status and whether data came back), probe history and the score breakdown, as a signed JSON document.</p>
<h2>How to call it</h2>
<ol><li>Request <code>${esc(url)}</code> from an x402 client (Accept: application/json). The server answers <code>402 Payment Required</code> with the price and payTo.</li>
<li>Sign the payment and repeat the request with the <code>PAYMENT-SIGNATURE</code> header. The report comes back with a payment receipt.</li></ol>
<h2>Free alternatives</h2>
<ul><li>Vendor summary (free): <a href="${esc(free)}">${esc(free)}</a></li>
<li>Free pre-payment check for any x402 URL: <a href="${esc(base)}/v1/check">${esc(base)}/v1/check?url=...</a></li></ul>
<p>Docs: <a href="${esc(base)}/">${esc(base)}/</a> (quickstart), <a href="${esc(base)}/openapi.json">OpenAPI</a>, <a href="${esc(base)}/v1/trust/methodology">methodology</a>.</p>
<p><small>Paying Lumi never changes a vendor's score or label.</small></p>
</body></html>
`;
}
