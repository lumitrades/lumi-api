/**
 * Lumi Check tier-1 delivery outcomes (ON by default in the kit, one off switch): anonymous, aggregate-only.
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
export const OUTCOME_RETENTION_DAYS = 90;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const VENDOR_RE = /^vendor:[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export interface OutcomeCount { day: string; subject: string; delivered: number; failed: number; by_class: Record<string, number> }
export interface OutcomeStore {
  add(rows: OutcomeCount[]): Promise<void>;
  list(sinceDay: string, limit: number): Promise<OutcomeCount[]>;
  purge(beforeDay: string): Promise<number>;
}
export class MemoryOutcomeStore implements OutcomeStore {
  rows = new Map<string, OutcomeCount>();
  async add(rows: OutcomeCount[]) {
    for (const r of rows) {
      const k = `${r.day}|${r.subject}`, c = this.rows.get(k) ?? { day: r.day, subject: r.subject, delivered: 0, failed: 0, by_class: {} };
      c.delivered += r.delivered; c.failed += r.failed;
      for (const [s, n] of Object.entries(r.by_class)) c.by_class[s] = (c.by_class[s] ?? 0) + n;
      this.rows.set(k, c);
    }
  }
  async list(d: string, n: number) { return [...this.rows.values()].filter((r) => r.day >= d).slice(0, n).map((r) => ({ ...r, by_class: { ...r.by_class } })); }
  async purge(d: string) { let n = 0; for (const [k, r] of this.rows) if (r.day < d) { this.rows.delete(k); n++; } return n; }
}
export class D1OutcomeStore implements OutcomeStore {
  constructor(private db: D1Like) {}
  async add(rows: OutcomeCount[]) {
    if (!rows.length) return;
    const cols = STATUS_CLASSES.map((c) => "s_" + c);
    const sql = `INSERT INTO check_outcomes (day, subject, delivered, failed, ${cols.join(", ")}) VALUES (?1, ?2, ?3, ?4, ${cols.map((_, i) => "?" + (i + 5)).join(", ")}) ` +
      `ON CONFLICT (day, subject) DO UPDATE SET delivered = delivered + excluded.delivered, failed = failed + excluded.failed, ${cols.map((c) => `${c} = ${c} + excluded.${c}`).join(", ")}`;
    await this.db.batch(rows.map((r) => this.db.prepare(sql).bind(r.day, r.subject, r.delivered, r.failed, ...STATUS_CLASSES.map((c) => r.by_class[c] ?? 0))));
  }
  async list(d: string, n: number) {
    const rs = ((await this.db.prepare("SELECT * FROM check_outcomes WHERE day >= ?1 ORDER BY day DESC LIMIT ?2").bind(d, n).all<any>()).results ?? []);
    return rs.map((r: any) => ({ day: r.day, subject: r.subject, delivered: Number(r.delivered), failed: Number(r.failed), by_class: Object.fromEntries(STATUS_CLASSES.map((c) => [c, Number(r["s_" + c] ?? 0)]).filter(([, n]) => (n as number) > 0)) }));
  }
  async purge(d: string) { const r: any = await this.db.prepare("DELETE FROM check_outcomes WHERE day < ?1").bind(d).run(); return Number(r?.meta?.changes ?? 0); }
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

/** Per-isolate buffer of counters, flushed by the cron (one D1 batch), plus a 10-minute replay set for tokens. */
export function createOutcomes(store: OutcomeStore, now: () => number) {
  const buf = new Map<string, OutcomeCount>();
  const seen = new Map<string, number>();
  const day = () => new Date(now()).toISOString().slice(0, 10);
  function record(p: Extract<OutcomeParse, { ok: true }>): "recorded" | "replay" {
    const t = now();
    if (p.token) {
      for (const [k, at] of seen) if (t - at > 600_000) seen.delete(k);
      if (seen.has(p.token)) return "replay";
      if (seen.size < 50_000) seen.set(p.token, t);
    }
    const k = `${day()}|${p.subject}`, c = buf.get(k) ?? { day: day(), subject: p.subject, delivered: 0, failed: 0, by_class: {} };
    if (p.delivered) c.delivered++; else c.failed++;
    if (p.status_class) c.by_class[p.status_class] = (c.by_class[p.status_class] ?? 0) + 1;
    buf.set(k, c);
    return "recorded";
  }
  async function flush() {
    if (!buf.size) return 0;
    const rows = [...buf.values()]; buf.clear();
    await store.add(rows);
    return rows.length;
  }
  return { record, flush, store, purge: () => store.purge(new Date(now() - OUTCOME_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10)) };
}
export type Outcomes = ReturnType<typeof createOutcomes>;
