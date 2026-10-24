/**
 * Lumi Check tier-1 delivery outcomes (OFF in the kit until the user says yes to a one-time question): anonymous, aggregate-only.
 *
 * Accepted body (anything else is rejected, so a client cannot leak more than this by accident):
 *   { v: 1, subject: "<seller host>" | "vendor:<id>", delivered: boolean, status_class?: "2xx"|"3xx"|"4xx"|"5xx"|"timeout"|"network", token?: "<random, per event>" }
 * No wallet address, amount, tx hash, URL path or query, payload, IP or stable client id is accepted or stored.
 * token is a fresh random value per event, used only to drop replays for 10 minutes; it links nothing.
 * Stored as per-day, per-subject counters only. Tier-1 outcomes are NOT an input to any score, tier, ranking or badge
 * (they are unauthenticated and therefore spoofable); they are a coarse signal for Lumi's own test-buy queue.
 */
import type { D1Like } from "../config";

export const OUTCOME_FIELDS = ["v", "subject", "delivered", "status_class", "token"] as const;
export const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx", "timeout", "network"] as const;
/** Raw tier-1 rows are deleted this many days after their UTC day, and only once that day is rolled up (approved by the owner). */
export const OUTCOME_RETENTION_DAYS = 90;
/** Daily summaries (check_outcome_daily) are kept long-term: never purged. */
export const OUTCOME_SUMMARY_RETENTION = "forever" as const;
/** Nightly job bounds (catch-up after downtime is spread over nights; keeps each run small). */
export const ROLLUP_MAX_DAYS_PER_RUN = 14;
/** Buffered rows older than this are dropped at flush (an isolate idle for days): keeps purged days write-free. */
export const OUTCOME_MAX_LATE_DAYS = 2;
const DAY_MS = 86_400_000;
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const nextDay = (d: string) => dayOf(Date.parse(d + "T00:00:00Z") + DAY_MS);
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const VENDOR_RE = /^vendor:[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export interface OutcomeCount { day: string; subject: string; delivered: number; failed: number; by_class: Record<string, number> }
/** Long-term daily summary: one row per subject per UTC day, kept forever (no purge). checks = null: per-seller check counts are not logged. */
export interface OutcomeSummary extends OutcomeCount { reports: number; checks: number | null }
export interface RollupDay { day: string; rolled_at: number; dirty: boolean; purged_at: number | null }

/**
 * Raw tier-1 counters (check_outcomes, per day + subject) plus the nightly rollup into check_outcome_daily.
 * D1 cost rules: every query is keyed by the (day, subject) primary key, the check_rollup_days primary key, or a
 * partial index (dirty days, unpurged days). Each raw day is read once by its rollup (and once more only if a late
 * flush marked it dirty); nothing scans a whole table.
 */
export interface OutcomeStore {
  /** Upsert raw counters. Rows for an already rolled-up day mark that day dirty so it is rolled up again. */
  add(rows: OutcomeCount[]): Promise<void>;
  list(sinceDay: string, limit: number): Promise<OutcomeCount[]>;
  summaries(sinceDay: string, limit: number): Promise<OutcomeSummary[]>;
  /** Latest rolled-up day (cursor), earliest raw day (bootstrap). */
  lastRolledDay(): Promise<string | null>;
  firstRawDay(): Promise<string | null>;
  /** Idempotent: summaries for `day` are REPLACED from the raw rows, so re-running never double counts. Returns summary rows written. */
  rollup(day: string, at: number): Promise<number>;
  dirtyDays(limit: number): Promise<string[]>;
  /** Rolled-up, clean, not yet purged days before `beforeDay`. */
  purgeCandidates(beforeDay: string, limit: number): Promise<string[]>;
  /** Delete raw rows for one day, ONLY if that day is rolled up and clean. Returns raw rows deleted. */
  purgeDay(day: string, at: number): Promise<number>;
  rollupDay(day: string): Promise<RollupDay | null>;
}

const sumOf = (r: OutcomeCount): OutcomeSummary => ({ ...r, by_class: { ...r.by_class }, reports: r.delivered + r.failed, checks: null });

export class MemoryOutcomeStore implements OutcomeStore {
  rows = new Map<string, OutcomeCount>();
  daily = new Map<string, OutcomeSummary>();
  days = new Map<string, RollupDay>();
  /** Raw rows read by rollup/purge (to assert "each raw day read once"). */
  rawReads = 0;
  async add(rows: OutcomeCount[]) {
    for (const r of rows) {
      const k = `${r.day}|${r.subject}`, c = this.rows.get(k) ?? { day: r.day, subject: r.subject, delivered: 0, failed: 0, by_class: {} };
      c.delivered += r.delivered; c.failed += r.failed;
      for (const [s, n] of Object.entries(r.by_class)) c.by_class[s] = (c.by_class[s] ?? 0) + n;
      this.rows.set(k, c);
      const d = this.days.get(r.day);
      if (d && d.purged_at === null) d.dirty = true;
    }
  }
  async list(d: string, n: number) { return [...this.rows.values()].filter((r) => r.day >= d).slice(0, n).map((r) => ({ ...r, by_class: { ...r.by_class } })); }
  async summaries(d: string, n: number) { return [...this.daily.values()].filter((r) => r.day >= d).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.subject.localeCompare(b.subject))).slice(0, n).map((r) => ({ ...r, by_class: { ...r.by_class } })); }
  async lastRolledDay() { return [...this.days.keys()].sort().at(-1) ?? null; }
  async firstRawDay() { return [...this.rows.values()].map((r) => r.day).sort()[0] ?? null; }
  async rollup(day: string, at: number) {
    this.days.set(day, { day, rolled_at: at, dirty: false, purged_at: this.days.get(day)?.purged_at ?? null });
    let n = 0;
    for (const r of this.rows.values()) if (r.day === day) { this.rawReads++; this.daily.set(`${day}|${r.subject}`, sumOf(r)); n++; }
    return n;
  }
  async dirtyDays(n: number) { return [...this.days.values()].filter((d) => d.dirty).map((d) => d.day).sort().slice(0, n); }
  async purgeCandidates(before: string, n: number) { return [...this.days.values()].filter((d) => d.day < before && d.purged_at === null && !d.dirty).map((d) => d.day).sort().slice(0, n); }
  async purgeDay(day: string, at: number) {
    const d = this.days.get(day);
    if (!d || d.dirty) return 0;
    let n = 0;
    for (const [k, r] of this.rows) if (r.day === day) { this.rows.delete(k); n++; }
    d.purged_at = at;
    return n;
  }
  async rollupDay(day: string) { const d = this.days.get(day); return d ? { ...d } : null; }
}

const CLASS_COLS = STATUS_CLASSES.map((c) => "s_" + c);
const classesOf = (r: any) => Object.fromEntries(STATUS_CLASSES.map((c) => [c, Number(r["s_" + c] ?? 0)]).filter(([, n]) => (n as number) > 0));

export class D1OutcomeStore implements OutcomeStore {
  constructor(private db: D1Like) {}
  async add(rows: OutcomeCount[]) {
    if (!rows.length) return;
    const sql = `INSERT INTO check_outcomes (day, subject, delivered, failed, ${CLASS_COLS.join(", ")}) VALUES (?1, ?2, ?3, ?4, ${CLASS_COLS.map((_, i) => "?" + (i + 5)).join(", ")}) ` +
      `ON CONFLICT (day, subject) DO UPDATE SET delivered = delivered + excluded.delivered, failed = failed + excluded.failed, ${CLASS_COLS.map((c) => `${c} = ${c} + excluded.${c}`).join(", ")}`;
    // Late rows for a rolled-up day (an isolate flushed after the nightly rollup) mark that day dirty: a PK lookup that
    // changes 0 rows on the normal path (one per distinct day in the flush, usually one).
    const days = [...new Set(rows.map((r) => r.day))];
    await this.db.batch([
      ...rows.map((r) => this.db.prepare(sql).bind(r.day, r.subject, r.delivered, r.failed, ...STATUS_CLASSES.map((c) => r.by_class[c] ?? 0))),
      ...days.map((d) => this.db.prepare("UPDATE check_rollup_days SET dirty = 1 WHERE day = ?1 AND dirty = 0 AND purged_at IS NULL").bind(d)),
    ]);
  }
  async list(d: string, n: number) {
    const rs = ((await this.db.prepare("SELECT * FROM check_outcomes WHERE day >= ?1 ORDER BY day DESC LIMIT ?2").bind(d, n).all<any>()).results ?? []);
    return rs.map((r: any) => ({ day: r.day, subject: r.subject, delivered: Number(r.delivered), failed: Number(r.failed), by_class: classesOf(r) }));
  }
  async summaries(d: string, n: number) {
    const rs = ((await this.db.prepare("SELECT * FROM check_outcome_daily WHERE day >= ?1 ORDER BY day DESC, subject LIMIT ?2").bind(d, n).all<any>()).results ?? []);
    return rs.map((r: any) => ({ day: r.day, subject: r.subject, reports: Number(r.reports), checks: r.checks === null || r.checks === undefined ? null : Number(r.checks), delivered: Number(r.delivered), failed: Number(r.failed), by_class: classesOf(r) }));
  }
  async lastRolledDay() { return (await this.db.prepare("SELECT MAX(day) d FROM check_rollup_days").first<{ d: string | null }>())?.d ?? null; }
  async firstRawDay() { return (await this.db.prepare("SELECT MIN(day) d FROM check_outcomes").first<{ d: string | null }>())?.d ?? null; }
  async rollup(day: string, at: number) {
    // One transaction: mark the day clean, then REPLACE its summaries from one indexed read of the raw day.
    const res: any = await this.db.batch([
      this.db.prepare("INSERT INTO check_rollup_days (day, rolled_at, dirty, purged_at) VALUES (?1, ?2, 0, NULL) ON CONFLICT (day) DO UPDATE SET rolled_at = excluded.rolled_at, dirty = 0").bind(day, at),
      this.db.prepare(
        `INSERT INTO check_outcome_daily (day, subject, reports, checks, delivered, failed, ${CLASS_COLS.join(", ")}) ` +
        `SELECT day, subject, delivered + failed, NULL, delivered, failed, ${CLASS_COLS.join(", ")} FROM check_outcomes WHERE day = ?1 ` +
        `ON CONFLICT (day, subject) DO UPDATE SET reports = excluded.reports, checks = excluded.checks, delivered = excluded.delivered, failed = excluded.failed, ${CLASS_COLS.map((c) => `${c} = excluded.${c}`).join(", ")}`,
      ).bind(day),
    ]);
    return Number(Array.isArray(res) ? res[1]?.meta?.changes ?? 0 : 0);
  }
  async dirtyDays(n: number) { return ((await this.db.prepare("SELECT day FROM check_rollup_days WHERE dirty = 1 ORDER BY day LIMIT ?1").bind(n).all<{ day: string }>()).results ?? []).map((r) => r.day); }
  async purgeCandidates(before: string, n: number) {
    return ((await this.db.prepare("SELECT day FROM check_rollup_days WHERE purged_at IS NULL AND day < ?1 AND dirty = 0 ORDER BY day LIMIT ?2").bind(before, n).all<{ day: string }>()).results ?? []).map((r) => r.day);
  }
  async purgeDay(day: string, at: number) {
    // The guard is in the DELETE itself: rows go only if their day is rolled up and clean.
    const res: any = await this.db.batch([
      this.db.prepare("DELETE FROM check_outcomes WHERE day = ?1 AND EXISTS (SELECT 1 FROM check_rollup_days WHERE day = ?1 AND dirty = 0)").bind(day),
      this.db.prepare("UPDATE check_rollup_days SET purged_at = ?2 WHERE day = ?1 AND dirty = 0").bind(day, at),
    ]);
    return Number(Array.isArray(res) ? res[0]?.meta?.changes ?? 0 : 0);
  }
  async rollupDay(day: string) {
    const r = await this.db.prepare("SELECT * FROM check_rollup_days WHERE day = ?1").bind(day).first<any>();
    return r ? { day: r.day, rolled_at: Number(r.rolled_at), dirty: !!r.dirty, purged_at: r.purged_at === null ? null : Number(r.purged_at) } : null;
  }
}

export type OutcomeParse = { ok: true; subject: string; delivered: boolean; status_class: string | null; token: string | null } | { ok: false; error: string; field?: string };

/** Strict validation: unknown fields are an error (never silently stored). */
export function parseOutcome(b: unknown): OutcomeParse {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, error: "invalid_body" };
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(OUTCOME_FIELDS as readonly string[]).includes(k)) return { ok: false, error: "field_not_allowed", field: k };
  if (o.v !== 1) return { ok: false, error: "unsupported_version" };
  const subject = typeof o.subject === "string" ? o.subject.trim().toLowerCase() : "";
  if (!HOST_RE.test(subject) && !VENDOR_RE.test(subject)) return { ok: false, error: "invalid_subject", field: "subject" };
  if (typeof o.delivered !== "boolean") return { ok: false, error: "delivered_boolean_required", field: "delivered" };
  const sc = o.status_class;
  if (sc !== undefined && sc !== null && !(STATUS_CLASSES as readonly string[]).includes(String(sc))) return { ok: false, error: "invalid_status_class", field: "status_class" };
  const tok = o.token;
  if (tok !== undefined && tok !== null && !(typeof tok === "string" && TOKEN_RE.test(tok))) return { ok: false, error: "invalid_token", field: "token" };
  return { ok: true, subject, delivered: o.delivered, status_class: (sc as string | undefined) ?? null, token: (tok as string | undefined) ?? null };
}

/** Per-isolate buffer of counters (flushed every 2 minutes, on day change or by the cron: one D1 batch), plus a 10-minute replay set for tokens. */
export function createOutcomes(store: OutcomeStore, now: () => number, opts: { flushMs?: number } = {}) {
  const buf = new Map<string, OutcomeCount>();
  const seen = new Map<string, number>();
  let opened = 0;
  const day = () => dayOf(now());
  function record(p: Extract<OutcomeParse, { ok: true }>): "recorded" | "replay" {
    const t = now();
    if (p.token) {
      for (const [k, at] of seen) if (t - at > 600_000) seen.delete(k);
      if (seen.has(p.token)) return "replay";
      if (seen.size < 50_000) seen.set(p.token, t);
    }
    if (!buf.size) opened = t;
    const k = `${day()}|${p.subject}`, c = buf.get(k) ?? { day: day(), subject: p.subject, delivered: 0, failed: 0, by_class: {} };
    if (p.delivered) c.delivered++; else c.failed++;
    if (p.status_class) c.by_class[p.status_class] = (c.by_class[p.status_class] ?? 0) + 1;
    buf.set(k, c);
    return "recorded";
  }
  /** True when the open buffer should be written (age, size, or it holds an earlier UTC day). */
  function due() {
    if (!buf.size) return false;
    const today = day();
    return now() - opened >= (opts.flushMs ?? 120_000) || buf.size >= 200 || [...buf.values()].some((r) => r.day !== today);
  }
  async function flush() {
    if (!buf.size) return 0;
    const oldest = dayOf(now() - OUTCOME_MAX_LATE_DAYS * DAY_MS);
    const rows = [...buf.values()].filter((r) => r.day >= oldest); buf.clear();
    if (rows.length) await store.add(rows);
    return rows.length;
  }
  /**
   * Nightly: roll up every closed UTC day not yet rolled (cursor = last rolled day), re-roll days a late flush marked
   * dirty, then purge raw rows older than OUTCOME_RETENTION_DAYS for rolled-up, clean days only. Idempotent.
   */
  async function nightly() {
    await flush();
    const t = now(), yesterday = dayOf(t - DAY_MS);
    const last = await store.lastRolledDay();
    let d = last ? nextDay(last) : await store.firstRawDay();
    const rolled: string[] = [];
    let summaries = 0;
    while (d && d <= yesterday && rolled.length < ROLLUP_MAX_DAYS_PER_RUN) { summaries += await store.rollup(d, t); rolled.push(d); d = nextDay(d); }
    const rerolled: string[] = [];
    for (const dd of await store.dirtyDays(ROLLUP_MAX_DAYS_PER_RUN)) if (dd <= yesterday) { summaries += await store.rollup(dd, t); rerolled.push(dd); }
    const before = dayOf(t - OUTCOME_RETENTION_DAYS * DAY_MS);
    let purged = 0;
    const purgedDays: string[] = [];
    for (const pd of await store.purgeCandidates(before, ROLLUP_MAX_DAYS_PER_RUN)) { purged += await store.purgeDay(pd, t); purgedDays.push(pd); }
    return { rolled, rerolled, summaries, purged_days: purgedDays, purged_raw_rows: purged, raw_retention_days: OUTCOME_RETENTION_DAYS, summaries_kept: OUTCOME_SUMMARY_RETENTION };
  }
  return { record, due, flush, nightly, store };
}
export type Outcomes = ReturnType<typeof createOutcomes>;
