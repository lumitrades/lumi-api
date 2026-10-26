/**
 * Free samples (GET /v1/samples): a truncated, clearly labelled sample of every paid product, built from the same
 * prepared body the paywall serves. Arrays are cut to 2 entries, long text is clipped, the payment block is absent.
 */
import type { Config, PaidRoute } from "./config";
import { dropsToXrp } from "./config";
import { PAID_ENDPOINTS } from "./catalog";
import { LINE_LABEL, productLine } from "./lines";

export const SAMPLE_LABEL = "SAMPLE: truncated free preview, not the full product. Pay per call (x402) for the full, current response.";
const MAX_ITEMS = 2;
const MAX_STR = 240;
const MAX_MD = 700;

export interface Truncation {
  [path: string]: number;
}

/** Recursively cut arrays to MAX_ITEMS and long strings; records each cut array's full length by JSON path. */
export function truncate(v: unknown, path = "", cut: Truncation = {}, depth = 0): unknown {
  if (Array.isArray(v)) {
    if (v.length > MAX_ITEMS) cut[path || "."] = v.length;
    return v.slice(0, MAX_ITEMS).map((x, i) => truncate(x, `${path}[${i}]`, cut, depth + 1));
  }
  if (typeof v === "string") return v.length > MAX_STR ? `${v.slice(0, MAX_STR).trimEnd()}… [sample: truncated]` : v;
  if (v && typeof v === "object") {
    if (depth > 6) return "[sample: omitted]";
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = truncate(x, path ? `${path}.${k}` : k, cut, depth + 1);
    return out;
  }
  return v;
}

export function productSample(route: PaidRoute, body: Record<string, unknown>) {
  const { markdown, payment: _p, access: _a, ...rest } = body as Record<string, unknown>;
  const cut: Truncation = {};
  const sample = truncate(rest, "", cut) as Record<string, unknown>;
  if (typeof markdown === "string" && markdown) {
    sample.markdown = markdown.length > MAX_MD ? `${markdown.slice(0, MAX_MD).trimEnd()}\n\n… [sample: truncated]` : markdown;
  }
  const omitted = reshape(route, sample);
  return { sample, truncated: { arrays: cut, ...(omitted.length ? { omitted } : {}) } };
}

export const SAMPLE_ARGS: Partial<Record<PaidRoute, string>> = { vendor_report: "printmoneylab", trust_check: "url=https%3A%2F%2Fapi.lumitrades.io%2Fv1%2Fverdict" };

export function sampleEntry(cfg: Config, base: string, route: PaidRoute) {
  const e = PAID_ENDPOINTS.find((x) => x.route === route);
  if (!e) throw new Error(`no catalog entry for ${route}`);
  const arg = SAMPLE_ARGS[route];
  const path = arg ? (e.path.includes("{") ? e.path.replace(/\{[^}]+\}/, arg) : `${e.path}?${arg}`) : e.path;
  return {
    route,
    name: e.name,
    product_line: LINE_LABEL[productLine(route)],
    full_url: `${base}${path}`,
    price: {
      usd: cfg.evm?.prices[route] ?? cfg.ious.find((o) => o.symbol === "USDC")?.prices[route] ?? cfg.ious.find((o) => o.symbol === "RLUSD")?.prices[route] ?? null,
      xrp: dropsToXrp(cfg.pricesDrops[route]),
    },
  };
}

/** Route-specific trims so a sample previews the product without replacing it. Returns the omitted field paths. */
function reshape(_route: PaidRoute, _s: Record<string, any>): string[] {
  return [];
}
