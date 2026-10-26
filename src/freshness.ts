/**
 * "You only pay when you get data." Before any 402 quote (and therefore before any settlement), every input file a
 * route needs must be present, non-empty and recent. Otherwise the API answers 503 `stale_data` / `data_unavailable`
 * with "Not charged." and no payment is ever requested or settled.
 */

import type { DataFile, Json } from "./data";
import { isSignedObject } from "./signed";

const H = 3_600_000;

/** Where each published file keeps its generation time. */
export function fileTimestamp(file: DataFile, d: Json): string | null {
  const v =
    file === "prices" ? d?.updated_utc
    : file === "ideas" ? (d?.as_of ?? d?.slate?.as_of)
    : file === "analysis" ? d?.as_of
    : d?.generated_utc;
  return typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null;
}

/**
 * Max age per file. The site refreshes market data at least 4x a day (6 AM, 12 PM, 6 PM, 11 PM CT; the trade tracker
 * every 30 min), so the longest normal gap is ~7 h overnight; analysis is hand-written per update.
 */
export function maxAgeMs(file: DataFile, baseHours: number): number | null {
  switch (file) {
    case "prices":
    case "signals":
    case "context":
    case "ideas":
      return baseHours * H;
    case "analysis":
    case "events":
    case "brief":
      return baseHours * 4 * H;
    case "institutional_brief":
      return baseHours * 3 * H; // daily product: 36 h at the default 12 h base (one missed run tolerated, two are not)
    default:
      return null; // coins.json: static list, no freshness requirement
  }
}

/**
 * Routes sold on a once-a-day publishing schedule: their inputs are accepted up to this many hours old (one daily
 * ~6 AM CT run plus slack). Beyond that they are still 503 "Not charged.".
 */
export const DAILY_ROUTE_MAX_AGE_HOURS: Record<string, number> = {}; // the once-a-day routes (slate, brief) were retired 2026-10-25

function withFloor(max: number | null, floorHours: number): number | null {
  return max === null ? null : Math.max(max, floorHours * H);
}

/** Files are present, non-empty objects, with a timestamp no older than their max age (and not absurdly in the future). */
export function staleInputs(loaded: Record<string, Json>, files: DataFile[], now: number, baseHours: number, floorHours = 0) {
  const problems: { file: string; problem: string; as_of?: string }[] = [];
  for (const f of files) {
    const d = loaded[f];
    if (!d || typeof d !== "object" || Object.keys(d).length === 0) {
      problems.push({ file: `${f}.json`, problem: "missing_or_empty" });
      continue;
    }
    const max = withFloor(maxAgeMs(f, baseHours), floorHours);
    if (max === null) continue;
    const ts = fileTimestamp(f, d);
    if (!ts) {
      problems.push({ file: `${f}.json`, problem: "no_timestamp" });
      continue;
    }
    const age = now - Date.parse(ts);
    if (age > max) problems.push({ file: `${f}.json`, problem: `stale (older than ${Math.round(max / H)}h)`, as_of: ts });
    else if (age < -H) problems.push({ file: `${f}.json`, problem: "timestamp_in_future", as_of: ts });
  }
  return problems;
}

/** Minimum real content each product must carry before it can be sold. */
export function hasContent(route: string, body: Json): boolean {
  if (!body || typeof body !== "object") return false;
  switch (route) {
    case "signal":
      return typeof body.label === "string" || Object.keys(body.timeframes ?? {}).length > 0;
    case "levels":
      return (body.support?.length ?? 0) + (body.resistance?.length ?? 0) > 0 || !!body.commentary;
    case "slate":
      return Array.isArray(body.ideas) && (body.ideas.length > 0 || (Array.isArray(body.no_setup) ? body.no_setup.length : 0) > 0);
    case "brief":
      return typeof body.bitcoin?.usd === "number" && !!body.markdown;
    case "institutional":
      return (body.items?.length ?? 0) + (body.no_notable_news?.length ?? 0) > 0 && (body.big_picture?.length ?? 0) > 0 && !!body.markdown;
    case "vendor_report":
      return body.kind === "trust_vendor_report" && ((body.quote_checks?.rows?.length ?? 0) + (body.paid_test_buys?.count ?? 0)) > 0;
    case "scan":
      return Array.isArray(body.coins) && body.coins.length > 0;
    case "lite":
      return typeof body.label === "string";
    case "trust_check":
      return typeof body.verdict === "string";
    case "funding":
      return Array.isArray(body.coins) && body.coins.length > 0;
    case "fear_greed":
      return typeof body.value === "number";
    default:
      return false;
  }
}

// ---------------------------------------------------------------- freshness metadata on every paid response

/** Lumi's site publishing schedule (US Central): market data, events and context. */
export const SITE_HOURS_CT = [6, 12, 18, 23];
/** A scheduled run publishes about this long after the hour. */
const SITE_LAG_MS = 25 * 60_000;
const MIN = 60_000;

/** Local hour in America/Chicago (DST-aware via Intl). */
export function chicagoHour(t: number): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "2-digit", hourCycle: "h23" }).format(new Date(t));
  return Number(h) % 24;
}

/** Expected time of the next scheduled site refresh after `t` (ms). */
export function nextSiteUpdate(t: number): number {
  const start = Math.floor(t / H) * H;
  for (let k = 0; k < 30; k++) {
    const c = start + k * H;
    if (c + SITE_LAG_MS > t && SITE_HOURS_CT.includes(chicagoHour(c))) return c + SITE_LAG_MS;
  }
  return t + 6 * H;
}

/** Next 30-minute cron boundary (trust probes), plus a couple of minutes. */
export function nextHalfHour(t: number): number {
  const c = Math.floor(t / (30 * MIN)) * 30 * MIN + 30 * MIN;
  return c + 2 * MIN;
}

export interface FreshnessMeta {
  /** When the data in this response was produced (oldest required input), ISO 8601 UTC. */
  as_of: string;
  /** Seconds between as_of and this response. */
  data_age_seconds: number;
  /** Expected time of the next refresh of these inputs. */
  next_update: string;
  /** After this time the inputs count as stale and the call is not sold (503 "Not charged."). */
  stale_after: string;
}

export const isoS = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export function metaFrom(asOf: number, staleAfter: number, nextUpdate: number, now: number): FreshnessMeta {
  return {
    as_of: isoS(asOf),
    data_age_seconds: Math.max(0, Math.round((now - asOf) / 1000)),
    next_update: isoS(Math.min(Math.max(nextUpdate, now), Math.max(staleAfter, now))),
    stale_after: isoS(staleAfter),
  };
}

/** Freshness metadata for a route built from published site files (the oldest required input binds). */
export function fileMeta(loaded: Record<string, Json>, files: DataFile[], now: number, baseHours: number, floorHours = 0): FreshnessMeta | null {
  let asOf = Infinity;
  let staleAfter = Infinity;
  let next = Infinity;
  for (const f of files) {
    const max = withFloor(maxAgeMs(f, baseHours), floorHours);
    const ts = loaded[f] ? fileTimestamp(f, loaded[f]) : null;
    if (max === null || !ts) continue;
    const t = Date.parse(ts);
    asOf = Math.min(asOf, t);
    staleAfter = Math.min(staleAfter, t + max);
    next = Math.min(next, f === "institutional_brief" ? (t + 24 * H > now ? t + 24 * H : now + H) : nextSiteUpdate(now));
  }
  if (!Number.isFinite(asOf)) return null;
  return metaFrom(asOf, staleAfter, next, now);
}

/** Put the common fields first: kind, timestamp, source, freshness, then the product. */
export function withMeta(body: Record<string, unknown>, meta: FreshnessMeta | null): Record<string, unknown> {
  if (!meta) return body;
  const { kind, timestamp, source, ...rest } = body;
  return { kind, timestamp, source, ...meta, ...rest, ...meta };
}

const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Normalise every full date-time string to ISO 8601 UTC ("2026-10-22T23:20:00Z"); dates and free text are untouched. */
export function isoTimestamps<T>(v: T, depth = 0): T {
  if (typeof v === "string") {
    if (!ISO_DT.test(v)) return v;
    const t = Date.parse(v);
    return (Number.isNaN(t) ? v : isoS(t)) as unknown as T;
  }
  if (depth > 12 || !v || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => isoTimestamps(x, depth + 1)) as unknown as T;
  if (isSignedObject(v)) return v; // signed receipts are served exactly as signed
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = k === "markdown" ? x : isoTimestamps(x, depth + 1);
  return out as T;
}
