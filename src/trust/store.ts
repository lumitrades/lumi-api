/** Trust-layer storage: D1 in production, in-memory for tests and the Node server. */
import type { D1Like } from "../config";

export interface ProbeRow {
  vendor_id: string;
  endpoint: string;
  ts: number;
  http_status: number | null;
  ok: boolean;
  price: string | null;
  asset: string | null;
  pay_to: string | null;
  source_tag: boolean | null;
  latency_ms: number | null;
  error: string | null;
}

export interface ObservationRow {
  vendor_id: string;
  endpoint: string;
  ts: number;
  network: string;
  tx_hash: string;
  amount: string;
  asset: string;
  http_status: number | null;
  data_returned: boolean;
  latency_ms: number | null;
  summary: string;
  source: string;
  /** Set when Lumi never saw an HTTP response (Lumi-side): delivery unknown, never "no data" (delivery.ts). */
  inconclusive?: string | null;
  corrected_at?: number | null;
  summary_before?: string | null;
}

/** A signed XRPL test payment the seller's endpoint did not accept or settle (never on-ledger). Informational; never scored. */
export interface UnsettledAttemptRow {
  vendor_id: string;
  endpoint: string;
  ts: number; // when Lumi signed and sent it (ms)
  network: string;
  tx_hash: string;
  amount: string | null;
  asset: string | null;
  http_status: number | null;
  detail: string | null;
}

export interface UnsettledSummary {
  count: number;
  first: number | null;
  last: number | null;
}

export interface ReportRow {
  id: string;
  vendor_id: string;
  network: string;
  tx_hash: string;
  reporter: string;
  tx_ts: number | null;
  amount: string | null;
  asset: string | null;
  http_status: number | null;
  outcome: string;
  excerpt: string | null;
  signed: boolean;
  verified: boolean;
  reason: string | null;
  ip_hash: string | null;
  ts: number;
}

export interface ReplyRow {
  id: string;
  vendor_id: string;
  text: string;
  via: string;
  verified: boolean;
  ts: number;
}

export interface TipRow {
  id: string;
  text: string;
  coins: string | null;
  urls: string | null;
  ip_hash: string | null;
  ts: number;
}

export interface ProbeSummary {
  n: number;
  ok: number;
  /** Latencies of successful probes (most recent first, at most 500). */
  latencies: number[];
  /** Most recent probe per endpoint. */
  latest: ProbeRow[];
}

export type InsertResult = "inserted" | "duplicate";

export interface TrustStore {
  addProbes(rows: ProbeRow[]): Promise<void>;
  probeSummary(vendorId: string, since: number): Promise<ProbeSummary>;
  /** Raw probes since `since`, newest first, at most `limit` rows (paid vendor report). */
  probeHistory(vendorId: string, since: number, limit: number): Promise<ProbeRow[]>;
  addObservation(row: ObservationRow): Promise<InsertResult>;
  observations(vendorId: string, since: number): Promise<ObservationRow[]>;
  /** Badge read path (read-only, one indexed query): the newest `limit` buys across these vendors, any age. */
  latestObservations(vendorIds: string[], limit: number): Promise<ObservationRow[]>;
  /** Owner correction: mark a stored test-buy inconclusive (Lumi-side). Keeps the old summary in summary_before. */
  markObservationInconclusive(tx: string, reason: string, summary: string, at: number): Promise<ObservationRow | null>;
  /** Owner: record a signed test payment the seller did not accept (tx never reached the ledger). */
  addUnsettledAttempt(row: UnsettledAttemptRow): Promise<InsertResult>;
  /** Count + first/last time of a vendor's unsettled attempts (any age). Missing table reads as zero. */
  unsettledAttempts(vendorId: string): Promise<UnsettledSummary>;
  addReport(row: ReportRow): Promise<InsertResult>;
  hasVerifiedReport(txHash: string): Promise<boolean>;
  verifiedReports(vendorId: string, since: number): Promise<ReportRow[]>;
  addReply(row: ReplyRow): Promise<void>;
  verifiedReplies(vendorId: string): Promise<ReplyRow[]>;
  addTip(row: TipRow): Promise<void>;
  /** Increment a fixed-window counter and return the new count. */
  hit(key: string, expires: number): Promise<number>;
  prune(now: number): Promise<void>;
}

const PROBE_KEEP_MS = 90 * 86_400_000;

function latestPerEndpoint(rows: ProbeRow[]): ProbeRow[] {
  const seen = new Map<string, ProbeRow>();
  for (const r of rows) if (!seen.has(r.endpoint)) seen.set(r.endpoint, r);
  return [...seen.values()];
}

export class MemoryTrustStore implements TrustStore {
  probes: ProbeRow[] = [];
  obs: ObservationRow[] = [];
  reports: ReportRow[] = [];
  replies: ReplyRow[] = [];
  tips: TipRow[] = [];
  attempts: UnsettledAttemptRow[] = [];
  counters = new Map<string, { count: number; expires: number }>();

  constructor(seed: ObservationRow[] = []) {
    this.obs = seed.map((o) => ({ ...o }));
  }
  async addProbes(rows: ProbeRow[]) {
    this.probes.push(...rows);
  }
  async probeSummary(vendorId: string, since: number): Promise<ProbeSummary> {
    const rows = this.probes.filter((p) => p.vendor_id === vendorId && p.ts >= since).sort((a, b) => b.ts - a.ts);
    const all = this.probes.filter((p) => p.vendor_id === vendorId).sort((a, b) => b.ts - a.ts);
    return {
      n: rows.length,
      ok: rows.filter((r) => r.ok).length,
      latencies: rows.filter((r) => r.ok && r.latency_ms != null).slice(0, 500).map((r) => r.latency_ms!),
      latest: latestPerEndpoint(all),
    };
  }
  async probeHistory(vendorId: string, since: number, limit: number) {
    return this.probes.filter((p) => p.vendor_id === vendorId && p.ts >= since).sort((a, b) => b.ts - a.ts).slice(0, limit);
  }
  async addObservation(row: ObservationRow): Promise<InsertResult> {
    if (this.obs.some((o) => o.tx_hash === row.tx_hash)) return "duplicate";
    this.obs.push({ ...row });
    return "inserted";
  }
  async markObservationInconclusive(tx: string, reason: string, summary: string, at: number) {
    const o = this.obs.find((x) => x.tx_hash === tx);
    if (!o) return null;
    if (o.summary_before == null) o.summary_before = o.summary;
    Object.assign(o, { inconclusive: reason, summary, corrected_at: at, data_returned: false });
    return { ...o };
  }
  async observations(vendorId: string, since: number) {
    return this.obs.filter((o) => o.vendor_id === vendorId && o.ts >= since).sort((a, b) => b.ts - a.ts);
  }
  async latestObservations(vendorIds: string[], limit: number) {
    return this.obs.filter((o) => vendorIds.includes(o.vendor_id)).sort((a, b) => b.ts - a.ts).slice(0, limit).map((o) => ({ ...o }));
  }
  async addUnsettledAttempt(row: UnsettledAttemptRow): Promise<InsertResult> {
    if (this.attempts.some((a) => a.tx_hash === row.tx_hash)) return "duplicate";
    this.attempts.push({ ...row });
    return "inserted";
  }
  async unsettledAttempts(vendorId: string): Promise<UnsettledSummary> {
    const ts = this.attempts.filter((a) => a.vendor_id === vendorId).map((a) => a.ts);
    return { count: ts.length, first: ts.length ? Math.min(...ts) : null, last: ts.length ? Math.max(...ts) : null };
  }
  async addReport(row: ReportRow): Promise<InsertResult> {
    if (row.verified && this.reports.some((r) => r.verified && r.tx_hash === row.tx_hash)) return "duplicate";
    this.reports.push({ ...row });
    return "inserted";
  }
  async hasVerifiedReport(txHash: string) {
    return this.reports.some((r) => r.verified && r.tx_hash === txHash);
  }
  async verifiedReports(vendorId: string, since: number) {
    return this.reports.filter((r) => r.verified && r.vendor_id === vendorId && r.ts >= since).sort((a, b) => b.ts - a.ts);
  }
  async addReply(row: ReplyRow) {
    this.replies.push({ ...row });
  }
  async verifiedReplies(vendorId: string) {
    return this.replies.filter((r) => r.verified && r.vendor_id === vendorId).sort((a, b) => b.ts - a.ts);
  }
  async addTip(row: TipRow) {
    this.tips.push({ ...row });
  }
  async hit(key: string, expires: number) {
    const c = this.counters.get(key);
    const next = { count: (c?.count ?? 0) + 1, expires };
    this.counters.set(key, next);
    return next.count;
  }
  async prune(now: number) {
    for (const [k, v] of this.counters) if (v.expires < now) this.counters.delete(k);
    this.probes = this.probes.filter((p) => p.ts >= now - PROBE_KEEP_MS);
  }
}

const b = (v: unknown) => v === 1 || v === true;
const isUnique = (e: unknown) => /UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e));

function probeFrom(r: Record<string, any>): ProbeRow {
  return {
    vendor_id: r.vendor_id, endpoint: r.endpoint, ts: Number(r.ts), http_status: r.http_status ?? null, ok: b(r.ok),
    price: r.price ?? null, asset: r.asset ?? null, pay_to: r.pay_to ?? null,
    source_tag: r.source_tag == null ? null : b(r.source_tag), latency_ms: r.latency_ms ?? null, error: r.error ?? null,
  };
}
function obsFrom(r: Record<string, any>): ObservationRow {
  return { ...(r as ObservationRow), ts: Number(r.ts), data_returned: b(r.data_returned) };
}
function reportFrom(r: Record<string, any>): ReportRow {
  return { ...(r as ReportRow), ts: Number(r.ts), signed: b(r.signed), verified: b(r.verified) };
}

export class D1TrustStore implements TrustStore {
  constructor(private db: D1Like) {}

  async addProbes(rows: ProbeRow[]) {
    if (!rows.length) return;
    const sql = "INSERT INTO probes (vendor_id, endpoint, ts, http_status, ok, price, asset, pay_to, source_tag, latency_ms, error) VALUES (?,?,?,?,?,?,?,?,?,?,?)";
    await this.db.batch(rows.map((r) =>
      this.db.prepare(sql).bind(r.vendor_id, r.endpoint, r.ts, r.http_status, r.ok ? 1 : 0, r.price, r.asset, r.pay_to, r.source_tag == null ? null : r.source_tag ? 1 : 0, r.latency_ms, r.error),
    ));
  }
  async probeSummary(vendorId: string, since: number): Promise<ProbeSummary> {
    const counts = await this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(ok),0) AS ok FROM probes WHERE vendor_id = ? AND ts >= ?").bind(vendorId, since).first<{ n: number; ok: number }>();
    const lat = await this.db.prepare("SELECT latency_ms FROM probes WHERE vendor_id = ? AND ts >= ? AND ok = 1 AND latency_ms IS NOT NULL ORDER BY ts DESC LIMIT 500").bind(vendorId, since).all<{ latency_ms: number }>();
    const recent = await this.db.prepare("SELECT * FROM probes WHERE vendor_id = ? ORDER BY ts DESC LIMIT 12").bind(vendorId).all();
    return {
      n: Number(counts?.n ?? 0),
      ok: Number(counts?.ok ?? 0),
      latencies: lat.results.map((r) => Number(r.latency_ms)),
      latest: latestPerEndpoint(recent.results.map(probeFrom)),
    };
  }
  async probeHistory(vendorId: string, since: number, limit: number) {
    const r = await this.db.prepare("SELECT * FROM probes WHERE vendor_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?").bind(vendorId, since, limit).all();
    return r.results.map(probeFrom);
  }
  async addObservation(r: ObservationRow): Promise<InsertResult> {
    try {
      await this.db
        .prepare("INSERT INTO observations (vendor_id, endpoint, ts, network, tx_hash, amount, asset, http_status, data_returned, latency_ms, summary, source, inconclusive) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(r.vendor_id, r.endpoint, r.ts, r.network, r.tx_hash, r.amount, r.asset, r.http_status, r.data_returned ? 1 : 0, r.latency_ms, r.summary, r.source, r.inconclusive ?? null)
        .run();
      return "inserted";
    } catch (e) {
      if (isUnique(e)) return "duplicate";
      throw e;
    }
  }
  async markObservationInconclusive(tx: string, reason: string, summary: string, at: number) {
    await this.db
      .prepare("UPDATE observations SET summary_before = COALESCE(summary_before, summary), inconclusive = ?2, summary = ?3, corrected_at = ?4, data_returned = 0 WHERE tx_hash = ?1")
      .bind(tx, reason, summary, at).run();
    const r = await this.db.prepare("SELECT * FROM observations WHERE tx_hash = ?1").bind(tx).first<Record<string, any>>();
    return r ? obsFrom(r) : null;
  }
  async addUnsettledAttempt(r: UnsettledAttemptRow): Promise<InsertResult> {
    try {
      await this.db
        .prepare("INSERT INTO unsettled_attempts (tx_hash, vendor_id, endpoint, ts, network, amount, asset, http_status, detail) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(r.tx_hash, r.vendor_id, r.endpoint, r.ts, r.network, r.amount, r.asset, r.http_status, r.detail)
        .run();
      return "inserted";
    } catch (e) {
      if (isUnique(e)) return "duplicate";
      throw e;
    }
  }
  async unsettledAttempts(vendorId: string): Promise<UnsettledSummary> {
    try {
      const r = await this.db.prepare("SELECT COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last FROM unsettled_attempts WHERE vendor_id = ?").bind(vendorId).first<{ n: number; first: number | null; last: number | null }>();
      const n = Number(r?.n ?? 0);
      return { count: n, first: n ? Number(r!.first) : null, last: n ? Number(r!.last) : null };
    } catch (e) {
      if (/no such table/i.test(String(e))) return { count: 0, first: null, last: null }; // migration 0015 not applied yet
      throw e;
    }
  }
  async observations(vendorId: string, since: number) {
    const r = await this.db.prepare("SELECT * FROM observations WHERE vendor_id = ? AND ts >= ? ORDER BY ts DESC LIMIT 500").bind(vendorId, since).all();
    return r.results.map(obsFrom);
  }
  async latestObservations(vendorIds: string[], limit: number) {
    const ids = vendorIds.slice(0, 10);
    if (!ids.length) return [];
    const r = await this.db
      .prepare(`SELECT vendor_id, endpoint, ts, network, tx_hash, amount, asset, http_status, data_returned, latency_ms, summary, source, inconclusive, corrected_at FROM observations WHERE vendor_id IN (${ids.map(() => "?").join(",")}) ORDER BY ts DESC LIMIT ${Math.max(1, Math.min(50, limit))}`)
      .bind(...ids).all();
    return (r.results as Record<string, any>[]).map(obsFrom);
  }

  async addReport(r: ReportRow): Promise<InsertResult> {
    try {
      await this.db
        .prepare("INSERT INTO reports (id, vendor_id, network, tx_hash, reporter, tx_ts, amount, asset, http_status, outcome, excerpt, signed, verified, reason, ip_hash, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(r.id, r.vendor_id, r.network, r.tx_hash, r.reporter, r.tx_ts, r.amount, r.asset, r.http_status, r.outcome, r.excerpt, r.signed ? 1 : 0, r.verified ? 1 : 0, r.reason, r.ip_hash, r.ts)
        .run();
      return "inserted";
    } catch (e) {
      if (isUnique(e)) return "duplicate";
      throw e;
    }
  }
  async hasVerifiedReport(txHash: string) {
    return !!(await this.db.prepare("SELECT 1 AS x FROM reports WHERE tx_hash = ? AND verified = 1 LIMIT 1").bind(txHash).first());
  }
  async verifiedReports(vendorId: string, since: number) {
    const r = await this.db.prepare("SELECT * FROM reports WHERE vendor_id = ? AND verified = 1 AND ts >= ? ORDER BY ts DESC LIMIT 500").bind(vendorId, since).all();
    return r.results.map(reportFrom);
  }
  async addReply(r: ReplyRow) {
    await this.db.prepare("INSERT INTO replies (id, vendor_id, text, via, verified, ts) VALUES (?,?,?,?,?,?)").bind(r.id, r.vendor_id, r.text, r.via, r.verified ? 1 : 0, r.ts).run();
  }
  async verifiedReplies(vendorId: string) {
    const r = await this.db.prepare("SELECT * FROM replies WHERE vendor_id = ? AND verified = 1 ORDER BY ts DESC LIMIT 20").bind(vendorId).all();
    return r.results.map((x: Record<string, any>) => ({ ...(x as ReplyRow), ts: Number(x.ts), verified: b(x.verified) }));
  }
  async addTip(t: TipRow) {
    await this.db.prepare("INSERT INTO tips (id, text, coins, urls, ip_hash, ts) VALUES (?,?,?,?,?,?)").bind(t.id, t.text, t.coins, t.urls, t.ip_hash, t.ts).run();
  }
  async hit(key: string, expires: number) {
    const r = await this.db
      .prepare("INSERT INTO rate_limits (key, count, expires) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count")
      .bind(key, expires)
      .first<{ count: number }>();
    return Number(r?.count ?? 1);
  }
  async prune(now: number) {
    await this.db.batch([
      this.db.prepare("DELETE FROM rate_limits WHERE expires < ?").bind(now),
      this.db.prepare("DELETE FROM probes WHERE ts < ?").bind(now - PROBE_KEEP_MS),
    ]);
  }
}
