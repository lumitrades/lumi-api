/**
 * Market price reference for the "priced well above market average" not-scored label.
 *
 * Lumi's routine test-buys only pay listings up to TEST_BUY_MAX_USD per call (tools/trust_testbuys.ts MAX_PRICE,
 * a strict `price > MAX_PRICE` skip). A listing priced above that is never test-bought, so it is never scored.
 * When its cheapest price is also a clear multiple (PRICE_LABEL_MULTIPLE) of the catalog median for the asset
 * families it accepts, the not-scored reason says so; otherwise the neutral "not yet test-bought" is used.
 *
 * The label is disclosure only: it never changes a score, a verdict label, a tier or a badge.
 * The reference (median price per call of priced x402 listings, per asset family, plus overall) is computed by the
 * cron from one histogram query and cached in the catalog meta row "price_market"; request paths only read that row.
 */

export type PriceFamily = "base_usdc" | "solana_usdc" | "stellar_usdc" | "xrpl_rlusd";
export const PRICE_FAMILIES: PriceFamily[] = ["base_usdc", "solana_usdc", "stellar_usdc", "xrpl_rlusd"];
export const FAMILY_NAMES: Record<PriceFamily, string> = {
  base_usdc: "Base USDC",
  solana_usdc: "Solana USDC",
  stellar_usdc: "Stellar USDC",
  xrpl_rlusd: "XRPL RLUSD",
};

/** Lumi's routine test-buy price limit, USD per call (tools/trust_testbuys.ts MAX_PRICE). Strictly above it is skipped. */
export const TEST_BUY_MAX_USD = 0.05;
/** Default: label only at 10x the median or more (with a $0.01 median that is $0.10, above any reading of "average"). */
export const PRICE_LABEL_MULTIPLE = 10;
/** A family needs this many priced listings for its own median; fewer falls back to the overall median. */
export const MIN_FAMILY_LISTINGS = 30;
/** Cron recomputes the reference at most this often (one catalog-wide read). */
export const PRICE_MARKET_EVERY_MS = 12 * 3600_000;
export const PRICE_MARKET_META = "price_market";

export const NOT_SCORED_CODES = {
  priced: "priced_well_above_market",
  untested: "not_yet_test_bought",
  curatedOnly: "scores_for_curated_vendors_only",
} as const;
export type NotScoredCode = (typeof NOT_SCORED_CODES)[keyof typeof NOT_SCORED_CODES];

export const PRICED_LABEL = "Priced well above market average";

const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const STELLAR_USDC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const RLUSD_HEX = "524C555344000000000000000000000000000000";

/** Family and USD per call for one compact accepts entry {n, a, m}; null when it is not a USD-pegged asset Lumi prices. */
export function optionUsd(o: { n?: unknown; a?: unknown; m?: unknown }): { fam: PriceFamily; usd: number } | null {
  const n = String(o?.n ?? "");
  const a = String(o?.a ?? "");
  const m = Number(o?.m);
  if (!Number.isFinite(m) || m <= 0) return null;
  if ((n === "eip155:8453" || n === "base") && a.toLowerCase() === BASE_USDC) return { fam: "base_usdc", usd: m / 1e6 };
  if (n.startsWith("solana") && a === SOLANA_USDC) return { fam: "solana_usdc", usd: m / 1e6 };
  if (n.startsWith("stellar") && (a === STELLAR_USDC_SAC || a === "USDC")) return { fam: "stellar_usdc", usd: m / 1e7 };
  if (n.startsWith("xrpl") && (a.toUpperCase() === RLUSD_HEX || a.toUpperCase() === "RLUSD")) return { fam: "xrpl_rlusd", usd: m };
  return null;
}

/** Cheapest USD price per family for a listing's stored accepts JSON. */
export function listingFamilyPrices(accepts: string | null | undefined): Partial<Record<PriceFamily, number>> {
  const out: Partial<Record<PriceFamily, number>> = {};
  if (!accepts) return out;
  let arr: unknown;
  try { arr = JSON.parse(accepts); } catch { return out; }
  if (!Array.isArray(arr)) return out;
  for (const o of arr) {
    const p = o && typeof o === "object" ? optionUsd(o as any) : null;
    if (!p) continue;
    if (out[p.fam] === undefined || p.usd < out[p.fam]!) out[p.fam] = p.usd;
  }
  return out;
}

export interface MarketBucket { median_usd: number; listings: number }
export interface PriceMarket {
  computed_at: number;
  /** Active (not delisted) catalog listings with at least one USD-priced option. */
  overall: MarketBucket | null;
  families: Partial<Record<PriceFamily, MarketBucket>>;
  min_family_listings: number;
}

export type HistogramRow = { fam: string; usd: number; n: number };

/** Median of a histogram (value, count) list; the mean of the two middle values for an even total. */
export function histogramMedian(rows: { usd: number; n: number }[]): MarketBucket | null {
  const rs = rows.filter((r) => Number.isFinite(r.usd) && r.n > 0).sort((a, b) => a.usd - b.usd);
  const total = rs.reduce((s, r) => s + r.n, 0);
  if (!total) return null;
  const at = (k: number) => { let c = 0; for (const r of rs) { c += r.n; if (c > k) return r.usd; } return rs[rs.length - 1].usd; };
  const med = total % 2 ? at((total - 1) / 2) : (at(total / 2 - 1) + at(total / 2)) / 2;
  return { median_usd: round(med), listings: total };
}

export function marketFromHistogram(rows: HistogramRow[], now: number): PriceMarket {
  const families: Partial<Record<PriceFamily, MarketBucket>> = {};
  for (const f of PRICE_FAMILIES) {
    const b = histogramMedian(rows.filter((r) => r.fam === f));
    if (b) families[f] = b;
  }
  return { computed_at: now, overall: histogramMedian(rows.filter((r) => r.fam === "overall")), families, min_family_listings: MIN_FAMILY_LISTINGS };
}

/** Same histogram as the D1 query, from in-memory rows (tests, node). */
export function histogramFromRows(rows: { id: number; accepts?: string | null }[]): HistogramRow[] {
  const m = new Map<string, number>();
  const add = (fam: string, usd: number) => { const k = `${fam}|${round(usd)}`; m.set(k, (m.get(k) ?? 0) + 1); };
  for (const r of rows) {
    const fp = listingFamilyPrices(r.accepts);
    const vals = Object.entries(fp) as [PriceFamily, number][];
    if (!vals.length) continue;
    for (const [f, usd] of vals) add(f, usd);
    add("overall", Math.min(...vals.map((v) => v[1])));
  }
  return [...m.entries()].map(([k, n]) => { const [fam, usd] = k.split("|"); return { fam, usd: Number(usd), n }; });
}

/**
 * D1/SQLite histogram: per family, the listing's cheapest option price (rounded to 1e-9) with a listing count,
 * plus 'overall' (each listing's cheapest price across families). Bind ?1 = active-since ms.
 */
export const PRICE_HISTOGRAM_SQL = `WITH o AS (
  SELECT c.id AS id, CAST(json_extract(j.value,'$.n') AS TEXT) AS n, CAST(json_extract(j.value,'$.a') AS TEXT) AS a, CAST(json_extract(j.value,'$.m') AS REAL) AS m
  FROM catalog c, json_each(CASE WHEN json_valid(c.accepts) AND json_type(c.accepts) = 'array' THEN c.accepts ELSE '[]' END) j
  WHERE c.last_seen > ?1 AND c.accepts IS NOT NULL
), f AS (
  SELECT id,
    CASE
      WHEN n IN ('eip155:8453','base') AND lower(a) = '${BASE_USDC}' THEN 'base_usdc'
      WHEN n LIKE 'solana%' AND a = '${SOLANA_USDC}' THEN 'solana_usdc'
      WHEN n LIKE 'stellar%' AND a IN ('${STELLAR_USDC_SAC}','USDC') THEN 'stellar_usdc'
      WHEN n LIKE 'xrpl%' AND upper(a) IN ('${RLUSD_HEX}','RLUSD') THEN 'xrpl_rlusd'
    END AS fam,
    CASE
      WHEN n LIKE 'stellar%' THEN m / 1e7
      WHEN n LIKE 'xrpl%' THEN m
      ELSE m / 1e6
    END AS usd
  FROM o WHERE m > 0
), p AS (
  SELECT id, fam, MIN(usd) AS usd FROM f WHERE fam IS NOT NULL GROUP BY id, fam
)
SELECT fam, ROUND(usd, 9) AS usd, COUNT(*) AS n FROM p GROUP BY fam, ROUND(usd, 9)
UNION ALL
SELECT 'overall' AS fam, ROUND(usd, 9) AS usd, COUNT(*) AS n FROM (SELECT id, MIN(usd) AS usd FROM p GROUP BY id) GROUP BY ROUND(usd, 9)`;

/** Public, per-listing comparison with the catalog median (added to catalog lookup entries as price_vs_market). */
export interface PriceVsMarket {
  cheapest_price_usd: number;
  asset_family: PriceFamily;
  market_median_usd: number;
  /** Family medians the listing was compared with (the highest is used), or "overall" when a family is too small. */
  median_basis: string;
  multiple_of_median: number;
  priced_well_above_market: boolean;
}

export function priceVsMarket(accepts: string | null | undefined, market: PriceMarket | null, multiple = PRICE_LABEL_MULTIPLE): PriceVsMarket | null {
  if (!market) return null;
  const fp = listingFamilyPrices(accepts);
  const fams = (Object.keys(fp) as PriceFamily[]).sort((a, b) => fp[a]! - fp[b]!);
  if (!fams.length) return null;
  const cheapest = fp[fams[0]]!;
  // Compare with the highest median among the families the listing accepts: the label must hold whichever way the buyer pays.
  let med = 0;
  const basis: string[] = [];
  for (const f of fams) {
    const b = market.families[f];
    const use = b && b.listings >= market.min_family_listings ? { v: b.median_usd, k: f as string } : market.overall ? { v: market.overall.median_usd, k: "overall" } : null;
    if (!use) continue;
    if (use.v > med) { med = use.v; basis.length = 0; basis.push(use.k); } else if (use.v === med && !basis.includes(use.k)) basis.push(use.k);
  }
  if (!(med > 0)) return null;
  const mult = cheapest / med;
  return {
    cheapest_price_usd: round(cheapest),
    asset_family: fams[0],
    market_median_usd: med,
    median_basis: basis.join(","),
    multiple_of_median: Math.floor(mult * 10) / 10,
    priced_well_above_market: cheapest > TEST_BUY_MAX_USD && mult >= multiple,
  };
}

export interface NotScoredReason { not_scored_reason: NotScoredCode; not_scored_note: string }

function usd(v: number): string {
  let s = String(Number(v.toFixed(6)));
  if (!s.includes(".")) s += ".00";
  else if (s.split(".")[1].length < 2) s += "0";
  return `$${s}`;
}

function basisName(b: string): string {
  return b.split(",").map((k) => (k === "overall" ? "all priced" : FAMILY_NAMES[k as PriceFamily] ?? k)).join(" / ");
}

export function pricedNote(p: PriceVsMarket, host = false): string {
  return `${PRICED_LABEL}: the ${host ? "lowest price among this host's listings" : "cheapest price for this listing"} is ${usd(p.cheapest_price_usd)} per call, ${p.multiple_of_median}x the ${usd(p.market_median_usd)} median for ${basisName(p.median_basis)} listings in Lumi's catalog. Lumi has not test-bought it yet. Not a finding about the seller, and never a score input.`;
}
export const UNTESTED_NOTE = "Not yet test-bought: Lumi has no conclusive paid test-buy of this listing yet. Numeric scores need one. Not a negative finding.";
export const CURATED_ONLY_NOTE = "Lumi has test-bought this listing; numeric scores exist for curated vendors only. Not a negative finding.";

type EntryLike = { price_vs_market?: PriceVsMarket | null; purchases?: { conclusive?: boolean }[] | null; test_buys?: { count?: number } | null };

const bought = (e: EntryLike) => (Array.isArray(e.purchases) && e.purchases.some((p) => p?.conclusive)) || (e.test_buys?.count ?? 0) > 0;

/**
 * The not-scored reason for a check. exact = the exact listing's catalog entry (if any); domainEntries = the host's
 * entries when there is no exact match, with complete = every listing of the host is in domainEntries.
 * The priced label only applies when every listing considered qualifies and none was test-bought.
 */
export function notScoredReason(input: { exact?: EntryLike | null; domainEntries?: EntryLike[]; complete?: boolean; conclusiveBuys?: number }): NotScoredReason {
  const list = input.exact ? [input.exact] : input.complete ? input.domainEntries ?? [] : [];
  if ((input.conclusiveBuys ?? 0) > 0 || (input.exact && bought(input.exact))) return { not_scored_reason: NOT_SCORED_CODES.curatedOnly, not_scored_note: CURATED_ONLY_NOTE };
  if (list.length && list.every((e) => e.price_vs_market?.priced_well_above_market && !bought(e))) {
    // describe the cheapest listing so the note holds for every listing of the host
    const p = list.map((e) => e.price_vs_market!).sort((a, b) => a.cheapest_price_usd - b.cheapest_price_usd || a.multiple_of_median - b.multiple_of_median)[0];
    return { not_scored_reason: NOT_SCORED_CODES.priced, not_scored_note: pricedNote(p, !input.exact && list.length > 1) };
  }
  return { not_scored_reason: NOT_SCORED_CODES.untested, not_scored_note: UNTESTED_NOTE };
}

function round(v: number) { return Math.round(v * 1e9) / 1e9; }

/** Public description of the not-scored reasons (docs, /v1/verdict/rules). */
export function notScoredDoc(multiple = PRICE_LABEL_MULTIPLE): string {
  return `When a check's score is null (status not_scored), score.not_scored_reason and score.not_scored_note say why: ${NOT_SCORED_CODES.priced} ("${PRICED_LABEL}": Lumi has not test-bought the listing, its cheapest price is above the $${TEST_BUY_MAX_USD.toFixed(2)} per call Lumi's routine test-buys pay, and at least ${multiple}x the catalog median for the asset it accepts; medians are per asset family (Base USDC, Solana USDC, Stellar USDC, XRPL RLUSD) over active priced catalog listings, with the overall median when a family has fewer than ${MIN_FAMILY_LISTINGS} listings, recomputed about every ${PRICE_MARKET_EVERY_MS / 3600_000} h), ${NOT_SCORED_CODES.untested} (every other untested listing, whatever its price) or ${NOT_SCORED_CODES.curatedOnly}. For a bare domain the priced reason needs every listing of the host to qualify. Disclosure only, not a finding about the seller: it never changes a score, label, tier or badge. The badge SVG still says 'not scored'.`;
}
