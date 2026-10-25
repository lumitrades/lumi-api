/**
 * Free samples (GET /v1/samples): a truncated, clearly labelled sample of every paid product, built from the same
 * prepared body the paywall serves. Arrays are cut to 2 entries, long text is clipped, the payment block is absent.
 */
import type { Config, PaidRoute } from "./config";
import { dropsToXrp } from "./config";
import { PAID_ENDPOINTS, EXAMPLE_COIN } from "./catalog";
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

/** Institutional Brief sample: headline + big picture + 2 items + the full list of sources. */
export function institutionalSample(body: Record<string, any>) {
  const items: any[] = Array.isArray(body.items) ? body.items : [];
  const sources = [...new Set(items.flatMap((i) => [i.source_url, ...(Array.isArray(i.additional_sources) ? i.additional_sources : [])]).filter((u) => typeof u === "string"))];
  return {
    sample: {
      kind: body.kind ?? "institutional",
      timestamp: body.timestamp ?? null,
      source: body.source ?? null,
      as_of: body.as_of ?? null,
      data_age_seconds: body.data_age_seconds ?? null,
      next_update: body.next_update ?? null,
      stale_after: body.stale_after ?? null,
      title: body.title,
      date: body.date ?? null,
      coverage_window: body.coverage_window ?? null,
      headline: items[0]?.headline ?? (Array.isArray(body.big_picture) ? body.big_picture[0] : null) ?? null,
      big_picture: body.big_picture ?? [],
      items: items.slice(0, MAX_ITEMS),
      sources,
      disclaimer: body.disclaimer ?? null,
    },
    truncated: {
      items: items.length,
      omitted: ["coin_map", "alignments", "theses_tracked", "connections", "no_notable_news", "watch_next", "markdown"].filter((k) => k in body),
    },
  };
}

export function productSample(route: PaidRoute, body: Record<string, unknown>) {
  if (route === "institutional") return institutionalSample(body as Record<string, any>);
  const { markdown, payment: _p, access: _a, ...rest } = body as Record<string, unknown>;
  const cut: Truncation = {};
  const sample = truncate(rest, "", cut) as Record<string, unknown>;
  if (typeof markdown === "string" && markdown) {
    sample.markdown = markdown.length > MAX_MD ? `${markdown.slice(0, MAX_MD).trimEnd()}\n\n… [sample: truncated]` : markdown;
  }
  const omitted = reshape(route, sample);
  return { sample, truncated: { arrays: cut, ...(omitted.length ? { omitted } : {}) } };
}

export const SAMPLE_ARGS: Partial<Record<PaidRoute, string>> = { signal: EXAMPLE_COIN, levels: EXAMPLE_COIN, lite: EXAMPLE_COIN, vendor_report: "printmoneylab", trust_check: "url=https%3A%2F%2Fapi.lumitrades.io%2Fv1%2Fbrief" };

export function sampleEntry(cfg: Config, base: string, route: PaidRoute) {
  const e = PAID_ENDPOINTS.find((x) => x.route === route)!;
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

const OMIT = "[sample: omitted, in the paid response]";

/** Fields removed from every paper-trade object in free samples: unrealised P/L, mark price and status. */
export const SAMPLE_TRADE_HIDDEN = ["unrealized_pnl_pct", "pnl_pct", "mark_price", "status", "exit_price", "targets_hit", "outcome", "result", "r_multiple"];

/** Recursively drop SAMPLE_TRADE_HIDDEN keys from objects that look like trade ideas (have a direction or entry). Returns the count removed. */
export function stripTradeOutcome(v: unknown, depth = 0): number {
  if (depth > 8 || !v || typeof v !== "object") return 0;
  let n = 0;
  if (Array.isArray(v)) {
    for (const x of v) n += stripTradeOutcome(x, depth + 1);
    return n;
  }
  const o = v as Record<string, unknown>;
  const tradeLike = "direction" in o || "entry" in o || "entry_zone" in o || "stop" in o || ("conviction" in o && "bias" in o);
  for (const k of Object.keys(o)) {
    if (tradeLike && SAMPLE_TRADE_HIDDEN.includes(k)) {
      delete o[k];
      n++;
    } else n += stripTradeOutcome(o[k], depth + 1);
  }
  return n;
}

/** Route-specific trims so a sample previews the product without replacing it. Returns the omitted field paths. */
function reshape(route: PaidRoute, s: Record<string, any>): string[] {
  const omitted: string[] = [];
  const drop = (obj: Record<string, any> | undefined, key: string, label: string) => {
    if (obj && key in obj) {
      obj[key] = OMIT;
      omitted.push(label);
    }
  };
  if (route === "signal" && s.timeframes && typeof s.timeframes === "object") {
    const keys = Object.keys(s.timeframes);
    for (const k of keys.slice(1)) drop(s.timeframes, k, `timeframes.${k}`);
    if (keys[0]) drop(s.timeframes[keys[0]], "indicators", `timeframes.${keys[0]}.indicators`);
  }
  // Paper-trade samples never show live P/L or outcome-like status (the track record is not public in samples).
  if (route === "slate" || route === "brief") {
    const n = stripTradeOutcome(s);
    if (n) omitted.push("watchlist unrealized_pnl_pct, mark_price and status (not shown in free samples)");
  }
  if (route === "levels") {
    for (const k of ["support", "resistance"]) if (Array.isArray(s[k]) && s[k].length > 1) { s[k] = s[k].slice(0, 1); omitted.push(`${k}[1..]`); }
  }
  return omitted;
}
