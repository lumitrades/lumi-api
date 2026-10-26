/** Single source of truth for endpoints, prices and descriptions (used by docs, discovery and the paywall). */

import type { Config, PaidRoute } from "./config";
import { dropsToXrp } from "./config";
import { LINE_LABEL, productLine } from "./lines";

export interface PaidEndpoint {
  route: PaidRoute;
  method: "GET";
  path: string;
  /** Short listing name (XRPL AI Hub / x402 indexes ingest it). */
  name: string;
  /** OpenAPI-style template. */
  template: string;
  summary: string;
  example: string;
}

/** Shared buyer guarantee on every paid endpoint. */
export const NOT_CHARGED = "Not charged on bad input or when Lumi cannot answer (every response carries as_of).";

export const PAID_ENDPOINTS: PaidEndpoint[] = [
  {
    route: "trust_check",
    name: "Lumi Trades: check before paying an x402 URL (allow / warn / block)",
    method: "GET",
    path: "/v1/trust/check",
    template: "/v1/trust/check",
    summary:
      "Use this before your agent pays an unfamiliar x402 URL: allow / warn / block with coded reasons, from Lumi's daily CDP Bazaar index, free 402-quote checks and Lumi's own test-buys (Base USDC for Bazaar listings; XRPL only for a small curated vendor list, counted separately). Query: url (required), payTo and amount (optional: the payTo address and USD price you were quoted, to catch address or price mismatches). block = a concrete mismatch or a paid call that returned nothing; warn = not enough evidence; allow = listing and recent checks agree. Live: after payment Lumi contacts the seller once (an unpaid request; Lumi never pays the seller) and compares its current quote, price, payTo and TLS with Lumi's record; the result is in live, signed as live_evidence. A safety change it finds also shows on the free /v1/check at once. Links the free lookup and, for curated vendors, the $0.02 full report. Observations, not a guarantee. Not charged on bad input.",
    example: "/v1/trust/check?url=https://api.example.com/v1/data",
  },
  {
    route: "vendor_report",
    name: "Lumi Trades: x402 seller reputation report (full observation history)",
    method: "GET",
    path: "/v1/trust/vendors/{id}/report",
    template: "/v1/trust/vendors/{id}/report",
    summary:
      "Use this when you need evidence before paying an x402 vendor on Lumi's trust list: the full observation history. Every free 402-quote check (90-day retention) " +
      "with status, quoted price and latency; every paid test-buy with amount, ledger tx hash, explorer link and delivered yes/no; latency stats " +
      "(min/p50/p90/p95/max) and the 7-day trend; uptime % over 24h/7d/30d/90d and a daily series; per-endpoint quoted-price history; " +
      "agent reports; vendor replies; score components, sample sizes and confidence labels. Automated observations, not a rating. " +
      "Not sold (503, not charged) when the vendor has no observation in the last 48 h. The free summary is GET /v1/trust/vendors/{id}.",
    example: "/v1/trust/vendors/printmoneylab/report",
  },
  {
    route: "receipts",
    name: "Lumi Trades: signed x402 test-buy receipts for one seller",
    method: "GET",
    path: "/v1/trust/receipts",
    template: "/v1/trust/receipts",
    summary:
      "Use this when you want the proof behind a seller check: the signed test-buy receipts Lumi holds for one x402 seller, newest first (up to 50). Query: seller (required): a domain, an x402 resource URL or a payTo address. Each receipt has date, endpoint, network (Base, XRP Ledger, Stellar), amount, transaction hash, explorer link and delivered yes/no, plus the signed counterparty_delivery_receipt that anyone can verify for free at /v1/trust/receipts/verify. Only Lumi's own test-buys from its published wallets (/v1/check/wallets). Not charged on bad input or when Lumi holds no receipt for the seller (404). Paying never changes a score or label. Observations, not a guarantee.",
    example: "/v1/trust/receipts?seller=api.example.com",
  },
  {
    route: "batch_check",
    name: "Lumi Trades: check up to 10 x402 sellers before paying (batch)",
    method: "GET",
    path: "/v1/check/batch",
    template: "/v1/check/batch",
    summary:
      "Use this before your agent pays several x402 sellers: up to 10 resource URLs or seller domains in one call (query: urls, comma-separated), each with the same label as the free /v1/check (checks_passed, check_first, checks_failed or no_data), reason codes, conclusive test-buy count, last delivered and last failed dates and an evidence link, in one signed answer (kind lumi_batch_check). Based on Lumi's record: it does not contact the sellers (GET /v1/verdict adds a live check for one URL). Not charged on bad input. Paying never changes a score or label. Observations, not a guarantee.",
    example: "/v1/check/batch?urls=https://api.example.com/v1/data,data.example.org",
  },
];

/**
 * GET /v1/verdict, listed as a paid resource only when the owner switches VERDICT_PRICING to "paid".
 * In the default free mode it is a free, rate-limited alias of /v1/check and appears under free endpoints instead.
 */
export const VERDICT_ENDPOINT: PaidEndpoint = {
  route: "verdict",
  name: "Lumi Trades: check before paying, one label (checks_passed / check_first / checks_failed / no_data)",
  method: "GET",
  path: "/v1/verdict",
  template: "/v1/verdict",
  summary:
    "Use this before your agent pays an x402 URL or seller domain: one label from the same data and signing key as the free /v1/check: checks_passed (Delivered in recent checks), check_first (Check first), checks_failed (Recent checks failed) or no_data (Not enough data), with as_of, evidence window, conclusive test-buy count, last delivered/failed dates, reason codes, evidence and appeal links, and observed on-chain payments as ranges only. When paid it is the one-word version of the live check: label_live is the same label after Lumi contacts the seller once at call time (an unpaid request; Lumi never pays the seller) and compares its quote, price, payTo and TLS with Lumi's record, with signed live_evidence. Paying Lumi never changes a result. Observations, not a guarantee. Not charged on bad input.",
  example: "/v1/verdict?url=https://api.example.com/v1/data",
};

/** Every endpoint sold over x402 under this config (adds /v1/verdict only in paid mode). */
export function paidEndpoints(cfg: Pick<Config, "verdictPaid">): PaidEndpoint[] {
  // Listing order: the two original checks, then /v1/verdict (when paid), then the sub-cent receipt lookup and batch check.
  return cfg.verdictPaid ? [...PAID_ENDPOINTS.slice(0, 2), VERDICT_ENDPOINT, ...PAID_ENDPOINTS.slice(2)] : PAID_ENDPOINTS;
}

/** Catalog entry for a paid route, including /v1/verdict (whether or not it is currently priced). */
export function endpointFor(route: PaidRoute): PaidEndpoint {
  const e = route === "verdict" ? VERDICT_ENDPOINT : PAID_ENDPOINTS.find((x) => x.route === route);
  if (!e) throw new Error(`no catalog entry for paid route ${route}`);
  return e;
}

export function priceTable(cfg: Config) {
  return paidEndpoints(cfg).map((e) => ({
    method: e.method,
    path: e.path,
    name: e.name,
    product_line: LINE_LABEL[productLine(e.route)],
    price_xrp: dropsToXrp(cfg.pricesDrops[e.route]),
    price_drops: cfg.pricesDrops[e.route],
    price_rlusd: cfg.ious.find((o) => o.symbol === "RLUSD")?.prices[e.route] ?? null,
    price_usdc: cfg.ious.find((o) => o.symbol === "USDC")?.prices[e.route] ?? null,
    price_base_usdc: cfg.evm?.prices[e.route] ?? null,
    prices: [
      ...(cfg.evm
        ? [{ asset: "USDC", amount: cfg.evm.prices[e.route], network: cfg.evm.network, chain: cfg.evm.networkName, token: cfg.evm.asset, amount_atomic: cfg.evm.amounts[e.route] }]
        : []),
      { asset: "XRP", amount: dropsToXrp(cfg.pricesDrops[e.route]), network: cfg.network },
      ...cfg.ious.map((o) => ({ asset: o.symbol, amount: o.prices[e.route], currency: o.currency, issuer: o.issuer, network: cfg.network })),
      ...(cfg.stellar
        ? [{ asset: "USDC", amount: cfg.stellar.prices[e.route], network: cfg.stellar.network, chain: cfg.stellar.networkName, token: cfg.stellar.asset, amount_atomic: cfg.stellar.amounts[e.route] }]
        : []),
    ],
    summary: e.summary,
    example: e.example,
  }));
}
