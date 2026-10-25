/** Discovery entries for the plan routes (well-known x402 manifest, OpenAPI, index, skill.md, MCP, A2A). */
import type { Config } from "../config";
import { dropsToXrp } from "../config";
import { usdToDrops } from "../pricing";
import { FEED_LIMITS, MONITOR_LIMITS, PLANS, PLATFORM_LICENCE, WATCH_DISCOUNTS, WATCH_FREE, WATCH_TIERS, WATCH_TRIAL, WATCH_PRO_BUYS, WATCH_TRIAL_END, watchTier, type PlanId } from "./plans";

/** Listed (sold) plans, in discovery order. Monitor / Monitor Plus were retired 2026-10-25: not listed, never quoted (410). */
export const PLAN_ORDER: PlanId[] = ["watch", "watch_plus", "watch_plus_founder", "watch_pro", "audit", "feed", "feed_pro", "feed_credits"];

/** Extra query parameters of the per-endpoint Watch subscribe paths. */
export const WATCH_QTY_PARAMS = [
  { name: "endpoints", required: false, desc: `Number of endpoints covered (1-${WATCH_DISCOUNTS.maxEndpoints}; default: the number of seller endpoints in the enrolment). Price = per-endpoint price × endpoints; ${WATCH_DISCOUNTS.volumeMinEndpoints}+ endpoints get -${WATCH_DISCOUNTS.volume * 100}%.` },
  { name: "terms", required: false, desc: `1 (default) or ${WATCH_DISCOUNTS.prepayTerms}: prepay ${WATCH_DISCOUNTS.prepayTerms} consecutive 30-day terms for -${WATCH_DISCOUNTS.prepay * 100}% (does not stack with the volume discount: the larger one applies). Still no auto-renew.` },
];

/** What the unpaid template path does (no subject) and the query parameter that binds the payment. */
const WATCH_ENROLL = "Enrollment id from POST /v1/monitor/enroll (free, requires a payTo signature). Without it the path quotes the per-endpoint list price for 1 endpoint; a payment is refused before settlement.";
const PLAN_PARAM: Record<PlanId, { name: string; required: boolean; desc: string }> = {
  watch: { name: "enrollment", required: true, desc: WATCH_ENROLL },
  watch_plus: { name: "enrollment", required: true, desc: WATCH_ENROLL },
  watch_plus_founder: { name: "enrollment", required: true, desc: WATCH_ENROLL },
  watch_pro: { name: "enrollment", required: true, desc: WATCH_ENROLL },
  monitor: { name: "enrollment", required: true, desc: "Legacy plan (grandfathered; prefer Watch). Enrollment id from POST /v1/monitor/enroll (free, requires a payTo signature). Without it the path quotes the list price; a payment is refused before settlement." },
  monitor_plus: { name: "enrollment", required: true, desc: "Legacy plan (grandfathered; prefer Watch Plus). Enrollment id from POST /v1/monitor/enroll. Without it the path quotes the list price; a payment is refused before settlement." },
  audit: { name: "enrollment", required: true, desc: "Enrollment id from POST /v1/monitor/enroll. Without it the path quotes the list price; a payment is refused before settlement." },
  feed: { name: "key_id", required: false, desc: "Existing feed key id (from POST /v1/feed/keys). Omit to receive a new API key in the paid response." },
  feed_pro: { name: "key_id", required: false, desc: "Existing feed key id. Omit to receive a new API key in the paid response." },
  feed_credits: { name: "key_id", required: true, desc: "Feed key id the 1,000 credits attach to. Without it the path quotes the list price; a payment is refused before settlement." },
};

export function planAccepts(cfg: Config, id: PlanId) {
  const usd = PLANS[id].usd;
  const drops = usdToDrops(usd, cfg.xrpRate?.usd ?? cfg.xrpUsdFallback);
  return [
    ...(cfg.evm ? [{ scheme: "exact", network: cfg.evm.network, asset: cfg.evm.asset, asset_symbol: "USDC", amount: String(Math.round(Number(usd) * 1e6)), amount_usdc: usd, payTo: cfg.evm.payTo, extra: { name: cfg.evm.eip712.name, version: cfg.evm.eip712.version } }] : []),
    { scheme: "exact", network: cfg.network, asset: "XRP", amount: drops, amount_xrp: dropsToXrp(drops), payTo: cfg.payTo },
    ...cfg.ious.map((o) => ({ scheme: "exact", network: cfg.network, asset: o.currency, asset_symbol: o.symbol, issuer: o.issuer, amount: usd, payTo: cfg.payTo })),
    ...(cfg.stellar ? [{ scheme: "exact", network: cfg.stellar.network, asset: cfg.stellar.asset, asset_symbol: "USDC", amount: String(Math.round(Number(usd) * 1e7)), amount_usdc: usd, payTo: cfg.stellar.payTo, extra: { areFeesSponsored: true } }] : []),
  ];
}

export function planResources(cfg: Config, base: string) {
  return PLAN_ORDER.map((id) => ({
    name: `Lumi ${PLANS[id].name}`,
    url: `${base}${PLANS[id].path}`,
    template: `${base}${PLANS[id].path}`,
    query: {
      [PLAN_PARAM[id].name]: { required: PLAN_PARAM[id].required, description: PLAN_PARAM[id].desc },
      ...(PLANS[id].perEndpoint ? Object.fromEntries(WATCH_QTY_PARAMS.map((q) => [q.name, { required: q.required, description: q.desc }])) : {}),
    },
    ...(PLANS[id].perEndpoint ? { price_per: "endpoint per 30-day term (quote for 1 endpoint shown)" } : {}),
    ...(PLANS[id].legacy ? { legacy: true } : {}),
    mimeType: "application/json",
    method: "GET",
    description: `${PLANS[id].days ? `${PLANS[id].days}-day term, no auto-renew` : "One-off"}. ${PLANS[id].summary}`,
    plan: true,
    accepts: planAccepts(cfg, id),
  }));
}

export function planPriceTable(base: string) {
  return PLAN_ORDER.map((id) => ({ plan: id, name: PLANS[id].name, method: "GET", path: PLANS[id].path, url: `${base}${PLANS[id].path}?${PLAN_PARAM[id].name}=<${PLAN_PARAM[id].name}>`, price_usd: PLANS[id].usd, ...(PLANS[id].perEndpoint ? { per: "endpoint", query: "&endpoints=<N>&terms=<1|3>" } : {}), ...(PLANS[id].legacy ? { legacy: true } : {}), term_days: PLANS[id].days, auto_renew: false, summary: PLANS[id].summary }));
}

export const COMMERCE_FREE_ENDPOINTS = [
  { method: "GET", path: "/v1/monitor", summary: `Seller monitoring: plans per endpoint per 30 days (Watch $${PLANS.watch.usd}, Watch Plus $${PLANS.watch_plus.usd}, Watch Pro $${PLANS.watch_pro.usd}; ${WATCH_DISCOUNTS.volumeMinEndpoints}+ endpoints -${WATCH_DISCOUNTS.volume * 100}%, ${WATCH_DISCOUNTS.prepayTerms} terms prepaid -${WATCH_DISCOUNTS.prepay * 100}%, not stacked), Audit $${PLANS.audit.usd} one-off, free Watch tier, ${WATCH_TRIAL.days}-day Watch Plus trial; how to enrol, methodology and safeguards` },
  { method: "GET", path: "/v1/monitor/challenge?pay_to=", summary: "Message to sign with your payTo wallet (ripple-keypairs for XRPL, EIP-191 for Base) before enrolling" },
  { method: "POST", path: "/v1/monitor/enroll", summary: "Enrol endpoints for monitoring (signature-proven payTo; each endpoint quote-checked, ≤ $0.10 per test-buy)" },
  { method: "POST", path: "/v1/monitor/free", summary: `Free Watch tier (management token): ${WATCH_FREE.endpoints} endpoint, a daily quote check, no test-buys, no badge; status page labelled "${WATCH_FREE.label}"` },
  { method: "GET", path: "/v1/monitor/trial/challenge?pay_to=&domain=", summary: `Challenge for the one-per-seller ${WATCH_TRIAL.days}-day Watch Plus trial: proves control of the domain (well-known file or DNS TXT) and the payTo (signature)` },
  { method: "POST", path: "/v1/monitor/trial", summary: `Start the Watch Plus trial (no card, never auto-converts, test-buys capped at $${WATCH_TRIAL.capUsd} total. ${WATCH_TRIAL_END})` },
  { method: "GET", path: "/v1/monitor/status/{id}", summary: "Public seller status page (also .json): uptime from quote probes, test-buy outcomes, tier label" },
  { method: "GET", path: "/v1/monitor/sellers", summary: "Monitored sellers (each pays Lumi for monitoring; disclosed)" },
  { method: "GET", path: "/v1/monitor/sellers/{id}", summary: "Public seller entry: disclosure, plan status, test-buy outcomes, findings with seller replies" },
  { method: "GET", path: "/v1/monitor/badge/{file}", summary: "Live 'Monitored by Lumi' badge: {id}.svg or {id}.json; removed automatically when a test fails or the plan lapses" },
  { method: "POST", path: "/v1/monitor/replies", summary: "Seller reply to a finding (management token); findings cannot be removed" },
  { method: "GET", path: "/v1/monitor/corrections", summary: "Public correction log" },
  { method: "GET", path: "/v1/feed", summary: "Trust data feed for facilitators, wallets and frameworks: plans, metering, endpoints" },
  { method: "GET", path: "/v1/feed/license", summary: "Feed licence terms (no resale, attribution, no warranty)" },
  { method: "GET", path: "/v1/feed/challenge?wallet=", summary: "Message to sign with your wallet before requesting a free feed key" },
  { method: "POST", path: "/v1/feed/keys", summary: `Free feed key (${FEED_LIMITS.freePerMonth} lookups/month) with a wallet signature (challenge: GET /v1/feed/challenge?wallet=)` },
  { method: "POST", path: "/v1/feed/lookup", summary: `Keyed bulk lookup of up to ${FEED_LIMITS.maxBatch} URLs/payTos (metered)` },
  { method: "GET", path: "/v1/feed/lookup?url=|payTo=", summary: "Keyed single lookup (metered, 1 lookup)" },
  { method: "GET", path: "/v1/feed/delta?since=", summary: "Keyed status-change feed (Feed, Feed Pro)" },
  { method: "GET", path: "/v1/feed/snapshot?cursor=", summary: "Keyed licensed full export (Feed Pro)" },
  { method: "POST", path: "/v1/feed/webhook", summary: "Keyed: set the status-change webhook (Feed Pro); the secret is shown once" },
  { method: "GET", path: "/v1/feed/usage", summary: "Keyed usage and quota" },
];

const R = (codes: Record<string, string>) => Object.fromEntries(Object.entries(codes).map(([k, v]) => [k, { description: v }]));
const KEY = [{ feedKey: [] as string[] }];

export function commerceOpenApiPaths(cfg: Config, base: string) {
  const tagM = ["seller-monitoring"], tagF = ["trust-feed"];
  const body = (props: Record<string, unknown>, required: string[] = []) => ({ required: true, content: { "application/json": { schema: { type: "object", properties: props, required } } } });
  const paths: Record<string, unknown> = {
    "/v1/monitor": { get: { tags: tagM, security: [], summary: "Seller monitoring: plans, how to enrol, methodology, safeguards (free)", responses: R({ "200": "OK" }) } },
    "/v1/monitor/challenge": { get: { tags: tagM, security: [], summary: "Challenge to sign with the payTo wallet (free)", parameters: [{ name: "pay_to", in: "query", required: true, schema: { type: "string" }, example: cfg.payTo }], responses: R({ "200": "Message to sign", "400": "Invalid address (never charged)" }) } },
    "/v1/monitor/enroll": { post: { tags: tagM, summary: "Enrol endpoints (free; signature-proven payTo)", requestBody: body({ message: { type: "string" }, signature: { type: "string" }, public_key: { type: "string", description: "XRPL only" }, endpoints: { type: "array", maxItems: 20, items: { type: "object", properties: { url: { type: "string" }, method: { type: "string", enum: ["GET", "POST"] }, body: { type: "object" } }, required: ["url"] } }, webhook_url: { type: "string" }, email: { type: "string", description: "Kept private" } }, ["message", "signature"]), responses: R({ "201": "Enrolled: enrollment_id, per-plan eligibility, management token and webhook secret (shown once)", "403": "Signature proof failed", "422": "No endpoint qualifies (each rejection explained)" }) } },
    "/v1/monitor/free": { post: { tags: tagM, security: [{ managementToken: [] }], summary: `Free Watch tier: ${WATCH_FREE.endpoints} endpoint, a daily quote check, no test-buys, no badge (free)`, requestBody: body({ enrollment_id: { type: "string" } }, ["enrollment_id"]), responses: R({ "201": "Free tier active", "401": "Management token required", "404": "Unknown enrolment" }) } },
    "/v1/monitor/trial/challenge": { get: { tags: tagM, security: [], summary: `Challenge for the one-per-seller ${WATCH_TRIAL.days}-day Watch Plus trial: proves the domain (well-known file or DNS TXT) and the payTo (free)`, parameters: [{ name: "pay_to", in: "query", required: true, schema: { type: "string" } }, { name: "domain", in: "query", required: true, schema: { type: "string" } }], responses: R({ "200": "Challenge", "400": "Invalid input (never charged)" }) } },
    "/v1/monitor/trial": { post: { tags: tagM, security: [{ managementToken: [] }], summary: `Start the Watch Plus trial (no card, never auto-converts, test-buys capped at $${WATCH_TRIAL.capUsd} total)`, requestBody: body({ enrollment_id: { type: "string" }, message: { type: "string" }, signature: { type: "string" }, public_key: { type: "string" } }, ["enrollment_id", "message", "signature"]), responses: R({ "201": "Trial started", "403": "Proof failed", "409": "Trial already used" }) } },
    "/v1/monitor/status/{id}": { get: { tags: tagM, security: [], summary: "Public seller status page (HTML; also {id}.json): uptime from quote probes, test-buy outcomes, tier label (free)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: R({ "200": "OK", "404": "Unknown enrolment" }) } },
    "/v1/monitor/sellers": { get: { tags: tagM, security: [], summary: "Monitored sellers (free)", responses: R({ "200": "OK" }) } },
    "/v1/monitor/sellers/{id}": { get: { tags: tagM, security: [], summary: "Public seller entry with disclosure, findings and replies (free)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^men_[a-f0-9]{24}$" } }], responses: R({ "200": "OK", "404": "Unknown, or no plan paid yet" }) } },
    "/v1/monitor/badge/{file}": { get: { tags: tagM, security: [], summary: "Live badge: {id}.svg or {id}.json (free)", parameters: [{ name: "file", in: "path", required: true, schema: { type: "string", pattern: "^men_[a-f0-9]{24}\\.(svg|json)$" } }], responses: R({ "200": "Badge", "404": "Unknown seller" }) } },
    "/v1/monitor/replies": { post: { tags: tagM, security: [{ managementToken: [] }], summary: "Seller reply to a finding (free)", requestBody: body({ enrollment_id: { type: "string" }, finding_id: { type: "integer" }, text: { type: "string", maxLength: 1000 } }, ["enrollment_id", "finding_id", "text"]), responses: R({ "201": "Reply stored", "401": "Management token required" }) } },
    "/v1/monitor/corrections": { get: { tags: tagM, security: [], summary: "Public correction log (free)", responses: R({ "200": "OK" }) } },
    "/v1/feed": { get: { tags: tagF, security: [], summary: "Trust data feed: plans, metering, endpoints (free)", responses: R({ "200": "OK" }) } },
    "/v1/feed/license": { get: { tags: tagF, security: [], summary: "Licence terms (HTML; JSON with Accept: application/json)", responses: R({ "200": "OK" }) } },
    "/v1/feed/challenge": { get: { tags: tagF, security: [], summary: "Challenge to sign for a free key (free)", parameters: [{ name: "wallet", in: "query", required: true, schema: { type: "string" } }], responses: R({ "200": "Message to sign" }) } },
    "/v1/feed/keys": { post: { tags: tagF, summary: `Free key (${FEED_LIMITS.freePerMonth} lookups/month); signing again rotates the key`, requestBody: body({ message: { type: "string" }, signature: { type: "string" }, public_key: { type: "string" } }, ["message", "signature"]), responses: R({ "201": "api_key (shown once)", "200": "Key rotated", "403": "Signature proof failed" }) } },
    "/v1/feed/lookup": {
      post: { tags: tagF, security: KEY, summary: `Bulk lookup (≤ ${FEED_LIMITS.maxBatch} items; 1 lookup per item)`, requestBody: body({ items: { type: "array", maxItems: FEED_LIMITS.maxBatch, items: { type: "object", properties: { url: { type: "string" }, payTo: { type: "string" } } } } }, ["items"]), responses: R({ "200": "Results", "401": "API key required", "429": "Rate limit or quota (never charged)" }) },
      get: { tags: tagF, security: KEY, summary: "Single lookup (?url= or ?payTo=)", parameters: [{ name: "url", in: "query", schema: { type: "string" } }, { name: "payTo", in: "query", schema: { type: "string" } }], responses: R({ "200": "Results", "401": "API key required", "429": "Rate limit or quota" }) },
    },
    "/v1/feed/delta": { get: { tags: tagF, security: KEY, summary: "Status changes since a time (Feed, Feed Pro)", parameters: [{ name: "since", in: "query", schema: { type: "string", format: "date-time" } }, { name: "after_id", in: "query", schema: { type: "integer" } }], responses: R({ "200": "Changes", "403": "Plan required" }) } },
    "/v1/feed/snapshot": { get: { tags: tagF, security: KEY, summary: "Licensed full export, 200 entries per page (Feed Pro)", parameters: [{ name: "cursor", in: "query", schema: { type: "integer" } }], responses: R({ "200": "Page", "403": "Feed Pro required" }) } },
    "/v1/feed/webhook": { post: { tags: tagF, security: KEY, summary: "Set the status-change webhook (Feed Pro)", requestBody: body({ url: { type: ["string", "null"] } }, ["url"]), responses: R({ "200": "Webhook set; secret shown once" }) } },
    "/v1/feed/usage": { get: { tags: tagF, security: KEY, summary: "Usage and quota for this key", responses: R({ "200": "OK" }) } },
  };
  const rate = cfg.xrpRate?.usd ?? cfg.xrpUsdFallback;
  for (const id of PLAN_ORDER) {
    const p = PLANS[id], q = PLAN_PARAM[id];
    const drops = usdToDrops(p.usd, rate);
    paths[p.path] = {
      get: {
        operationId: `plan_${id}`,
        tags: p.family === "monitor" ? tagM : tagF,
        summary: `${p.name}${p.perEndpoint ? " (priced per endpoint" : " ("}${p.days ? `${p.perEndpoint ? ", " : ""}${p.days}-day term, no auto-renew` : "one-off"})${p.legacy ? " [legacy, grandfathered]" : ""}`,
        description: `${p.summary} Paid via x402 (XRPL XRP/RLUSD/USDC or Base USDC). Renew by paying again.${p.founder ? ` The amount below is for 1 endpoint × 1 term; the 402 for ?endpoints=N&terms=T quotes per-endpoint price × N × T (no further discounts). Open to the first ${p.founder.seats} sellers; at most ${p.founder.lockedTerms} terms per seller (409 before any quote otherwise).` : ""}${p.perEndpoint && !p.founder ? ` The amount below is for 1 endpoint × 1 term; the 402 for ?endpoints=N&terms=T quotes per-endpoint price × N × T less discounts (${WATCH_DISCOUNTS.volumeMinEndpoints}+ endpoints -${WATCH_DISCOUNTS.volume * 100}%, ${WATCH_DISCOUNTS.prepayTerms} terms -${WATCH_DISCOUNTS.prepay * 100}%; only the larger applies, they do not stack).` : ""}${p.family === "monitor" ? ` Test-buys are seller-funded from the fee, capped at ${p.perEndpoint ? watchTier(p.id)!.maxBuyUsd : MONITOR_LIMITS.maxBuyUsd} USD each and ${MONITOR_LIMITS.budgetShare * 100}% of the ${p.founder ? "Watch Plus list price" : "fee"} in total; ineligible plans return 409 before any quote.` : ""}`,
        parameters: [
          { name: q.name, in: "query", required: q.required, description: q.desc, schema: { type: "string" } },
          ...(p.perEndpoint ? WATCH_QTY_PARAMS.map((x) => ({ name: x.name, in: "query", required: x.required, description: x.desc, schema: { type: "integer" } })) : []),
        ],
        "x-payment-info": {
          protocols: [{ x402: {} }],
          price: { mode: "fixed", currency: "USD", amount: p.usd },
          xrp_price: { mode: cfg.xrpPricing === "live" ? "live" : "fixed", currency: "XRP", amount: dropsToXrp(drops) },
          scheme: "exact", network: cfg.network, asset: "XRP", amount_drops: drops, payTo: cfg.payTo,
          alternatives: [
            ...(cfg.evm ? [{ price: { mode: "fixed", currency: "USDC", amount: p.usd }, scheme: "exact", network: cfg.evm.network, asset: cfg.evm.asset, amount: String(Math.round(Number(p.usd) * 1e6)), payTo: cfg.evm.payTo }] : []),
            ...cfg.ious.map((o) => ({ price: { mode: "fixed", currency: o.symbol, amount: p.usd }, network: cfg.network, asset: o.currency, issuer: o.issuer, amount: p.usd })),
            ...(cfg.stellar ? [{ price: { mode: "fixed", currency: "USDC", amount: p.usd }, scheme: "exact", network: cfg.stellar.network, asset: cfg.stellar.asset, amount: String(Math.round(Number(p.usd) * 1e7)), payTo: cfg.stellar.payTo }] : []),
          ],
          term_days: p.days,
          auto_renew: false,
        },
        responses: R({ "201": "Paid: plan/key details. Settlement receipt in the PAYMENT-RESPONSE header.", "402": "Payment required (x402 v2)", "400": "Missing/unknown subject, bad endpoints/terms, or path template not filled (never charged)", "409": "Plan not eligible for this enrolment (never charged)", ...(p.legacy ? { "410": "Legacy plan retired (only if Lumi retires it; existing terms keep running)" } : {}) }),
      },
    };
  }
  return paths;
}

export function commerceSkillMd(base: string): string {
  const m = (id: PlanId) => `$${PLANS[id].usd}`;
  return `
## For x402 sellers: monitoring (opt-in, seller-funded)

Docs: \`GET ${base}/v1/monitor\`. Plans priced **per endpoint per 30 days**, paid via x402 (XRPL XRP/RLUSD/USDC or Base USDC), no auto-renew, terms stack:
- **Watch** ${m("watch")}/endpoint: hourly quote checks, a weekly test-buy (≤ $${WATCH_TIERS.watch.maxBuyUsd} per buy), alerts, status page and badge.
- **Watch Plus** ${m("watch_plus")}/endpoint: quote checks every 30 min, a daily test-buy (≤ $${WATCH_TIERS.watch_plus.maxBuyUsd}) rotating across chains, schema and p95-latency alerts, 90-day history.
- **Watch Plus founder** ${m("watch_plus_founder")}/endpoint (list ${m("watch_plus")}): the first ${PLANS.watch_plus_founder.founder!.seats} sellers get Watch Plus at this price for up to ${PLANS.watch_plus_founder.founder!.lockedTerms} terms, with the full Watch Plus test-buys (budget from the list price). No volume or prepay discount on top.
- **Watch Pro** ${m("watch_pro")}/endpoint: quote checks every 15 min, ${WATCH_PRO_BUYS}, a monthly report signed by Lumi's wallet.
- ${WATCH_DISCOUNTS.volumeMinEndpoints}+ endpoints: -${WATCH_DISCOUNTS.volume * 100}%. Prepay ${WATCH_DISCOUNTS.prepayTerms} terms: -${WATCH_DISCOUNTS.prepay * 100}%. Discounts do not stack: only the larger applies.
- **Audit** ${m("audit")} one-off: a test-buy of every listed endpoint, full report signed by Lumi's XRPL wallet.
- **Free Watch**: $0, ${WATCH_FREE.endpoints} endpoint, a daily quote check, no test-buys, no badge (\`POST /v1/monitor/free\`).
- **${WATCH_TRIAL.days}-day Watch Plus trial**: one per seller (prove the domain and the payTo wallet), test-buys capped at $${WATCH_TRIAL.capUsd} total, no card, never auto-converts. ${WATCH_TRIAL_END}
- **Platform licence** (wallets, facilitators, directories): from $${PLATFORM_LICENCE.from_usd} per 30 days, quoted per platform, contact to buy (${PLATFORM_LICENCE.contact}). ${PLATFORM_LICENCE.free_tier_terms}
- The old **Monitor** and **Monitor Plus** plans are no longer sold (their subscribe paths answer 410, never charged); terms bought before 2026-10-25 run to their end.

Steps: \`GET /v1/monitor/challenge?pay_to=<payTo>\` → sign it with the payTo wallet (XRPL: ripple-keypairs; Base: EIP-191) → \`POST /v1/monitor/enroll\` with endpoints and a webhook URL and/or email → pay \`GET /v1/monitor/subscribe/{watch|watch_plus|watch_pro|audit}?enrollment=<id>&endpoints=<N>&terms=<1|3>\`. Each test-buy is capped at $${MONITOR_LIMITS.maxBuyUsd} (Watch: $${WATCH_TIERS.watch.maxBuyUsd}); test-buys never exceed ${MONITOR_LIMITS.budgetShare * 100}% of the fee. Public status page: \`/v1/monitor/status/<id>\`. Alerts: paid but no/invalid data, 5xx/timeouts, payTo change, price change, schema change, recovery. Paying never changes a score; seller-funded tests are labelled; findings can be replied to, not removed; the badge (\`/v1/monitor/badge/<id>.svg\`) is removed automatically on failure or lapse; corrections: \`/v1/monitor/corrections\`.

## For facilitators, wallets and frameworks: trust data feed

Docs: \`GET ${base}/v1/feed\`; licence: \`${base}/v1/feed/license\` (no resale of raw data, attribution "Trust data: Lumi (lumitrades.io)", vet402 data CC BY).
- Free key: ${FEED_LIMITS.freePerMonth} lookups/month (\`GET /v1/feed/challenge?wallet=\`, sign, \`POST /v1/feed/keys\`). Answer-only.
- Metered: ${m("feed_credits")} per 1,000 lookups (\`GET /v1/feed/credits?key_id=<id>\`, x402).
- **Feed** ${m("feed")}/30 days: ${FEED_LIMITS.included.feed.toLocaleString("en-US")} lookups, full evidence + receipts, delta feed. **Feed Pro** ${m("feed_pro")}/30 days: ${FEED_LIMITS.included.feed_pro.toLocaleString("en-US")} lookups, licensed full snapshot export, status-change webhooks. (\`GET /v1/feed/subscribe/{feed|feed_pro}[?key_id=]\`.)
- \`POST /v1/feed/lookup\` {items:[{url}|{payTo}]} with \`Authorization: Bearer <key>\`; \`GET /v1/feed/delta?since=\`; \`GET /v1/feed/snapshot?cursor=\`; \`GET /v1/feed/usage\`.
`;
}
