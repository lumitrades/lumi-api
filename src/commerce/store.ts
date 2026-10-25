/** D1 + in-memory stores for seller monitoring and the licence feed (migrations 0011, 0025). */
import type { D1Like } from "../config";

/** A payment option seen in the endpoint's 402 at enrolment. Only the enrolled network's payTo is proven by signature;
 *  other chains are observed (used for chain rotation on Watch Plus / Pro and for payTo-change alerts on that chain). */
export interface EndpointChain { network: string; pay_to: string; usd: number | null; asset: string | null; proven: boolean }
export interface MonitorEndpoint { url: string; method: "GET" | "POST"; body?: Record<string, unknown>; price_usd: string | null; asset: string | null; amount: string | null; checked_at: number | null; source: "seller" | "catalog"; chains?: EndpointChain[] }
export interface Enrollment {
  id: string; network: string; pay_to: string; pay_to_lc: string; domain: string | null; proof: string; nonce: string;
  endpoints: MonitorEndpoint[]; webhook_url: string | null; webhook_secret: string | null; email: string | null; token_hash: string; is_test: boolean; created_at: number;
}
export interface PlanRow {
  id: string; enrollment_id: string; plan: string; starts_at: number; ends_at: number; paid_tx: string; paid_network: string; paid_asset: string; paid_amount: string;
  payer: string | null; usd: number | null; budget_usd: number; spent_usd: number; is_test: boolean; reminded: number; created_at: number;
  /** Watch tiers: endpoints covered and per-endpoint list price (migration 0025). Null/absent on legacy rows. */
  endpoints?: number | null; unit_usd?: number | null;
}
export interface TrialRow { id: string; enrollment_id: string; plan_id: string; domain_lc: string; pay_to_lc: string; nonce: string; proof: string; created_at: number }
export interface UptimeRow {
  enrollment_id: string; endpoint: string; day: string; checks: number; ok: number; p50_ms: number | null; p95_ms: number | null;
  quote_amount: string | null; quote_asset: string | null; quote_pay_to: string | null;
}
export interface RunRow {
  id?: number; enrollment_id: string; plan_id: string; endpoint: string; ts: number; network: string | null; tx_hash: string | null; amount: string | null; asset: string | null;
  cost_usd: number; http_status: number | null; data_returned: boolean; latency_ms: number | null; outcome: string; quote_pay_to: string | null; quote_price_usd: string | null;
  schema_hash: string | null; note: string | null; funding: string;
}
export interface FindingRow { id?: number; enrollment_id: string; endpoint: string | null; ts: number; kind: string; detail: string; run_id: number | null; delivered: string | null }
export interface ReplyRow { id?: number; enrollment_id: string; finding_id: number; ts: number; text: string }
export interface ReportRow { plan_id: string; enrollment_id: string; report: string; report_hash: string; signature: string; public_key: string; signer: string; created_at: number }
export interface CorrectionRow { id?: number; ts: number; subject: string; summary: string; ref: string | null }
export interface FeedKey {
  id: string; key_hash: string; wallet: string | null; wallet_lc: string | null; network: string | null; plan: "free" | "feed" | "feed_pro"; plan_ends_at: number | null;
  credits: number; is_test: boolean; webhook_url: string | null; webhook_secret: string | null; webhook_cursor: number; created_at: number; rotated_at: number | null;
}
export interface UsageRow { key_id: string; month: string; lookups: number; requests: number; minute: number; minute_requests: number }
export interface FeedPayment { tx: string; key_id: string; product: string; usd: number | null; is_test: boolean; network: string | null; asset: string | null; amount: string | null; payer: string | null; ts: number }
export interface ChangeRow { id?: number; ts: number; resource: string; field: string; old: string | null; new: string | null }

export interface CommerceStore {
  addEnrollment(e: Enrollment): Promise<"inserted" | "nonce_used">;
  enrollment(id: string): Promise<Enrollment | null>;
  enrollmentsByPayTo(lc: string[]): Promise<Enrollment[]>;
  enrollments(limit: number): Promise<Enrollment[]>;
  addPlan(p: PlanRow): Promise<"inserted" | "duplicate">;
  plansFor(enrollmentId: string): Promise<PlanRow[]>;
  /** Distinct non-test enrolments that ever bought `plan` (founder seat count). */
  founderSellers(plan: string): Promise<number>;
  plansEndingAfter(t: number): Promise<PlanRow[]>;
  setReminded(planId: string, n: number): Promise<void>;
  addSpent(planId: string, usd: number): Promise<void>;
  addRun(r: RunRow): Promise<number>;
  runsFor(enrollmentId: string, limit: number): Promise<RunRow[]>;
  addFinding(f: FindingRow): Promise<number>;
  setDelivered(id: number, via: string): Promise<void>;
  findingsFor(enrollmentId: string, limit: number): Promise<FindingRow[]>;
  addReply(r: ReplyRow): Promise<number>;
  repliesFor(enrollmentId: string): Promise<ReplyRow[]>;
  putReport(r: ReportRow): Promise<void>;
  report(planId: string): Promise<ReportRow | null>;
  addCorrection(c: CorrectionRow): Promise<number>;
  corrections(limit: number): Promise<CorrectionRow[]>;
  /** One trial per domain and per payTo: "taken" when either (or the nonce) was used before. */
  addTrial(t: TrialRow): Promise<"inserted" | "taken">;
  trialFor(domainLc: string, payToLc: string): Promise<TrialRow | null>;
  /** Upsert daily probe rollups (one row per enrolment/endpoint/day). */
  putUptime(rows: UptimeRow[]): Promise<number>;
  uptimeFor(enrollmentId: string, fromDay: string, toDay: string): Promise<UptimeRow[]>;
  // feed
  addKey(k: FeedKey): Promise<void>;
  keyById(id: string): Promise<FeedKey | null>;
  keyByHash(h: string): Promise<FeedKey | null>;
  keyByWallet(lc: string): Promise<FeedKey | null>;
  updateKey(id: string, patch: Partial<FeedKey>): Promise<void>;
  addCredits(id: string, n: number): Promise<void>;
  keys(limit: number): Promise<FeedKey[]>;
  addPayment(p: FeedPayment): Promise<"inserted" | "duplicate">;
  payments(limit: number): Promise<FeedPayment[]>;
  usage(keyId: string, month: string): Promise<UsageRow | null>;
  bumpUsage(keyId: string, month: string, lookups: number, minute: number): Promise<void>;
  usageFor(month: string): Promise<UsageRow[]>;
  addChanges(rows: ChangeRow[]): Promise<void>;
  changesSince(ts: number, afterId: number, limit: number): Promise<ChangeRow[]>;
  webhookKeys(now: number): Promise<FeedKey[]>;
}

const b = (v: unknown) => v === 1 || v === true;

export class MemoryCommerceStore implements CommerceStore {
  enrolls = new Map<string, Enrollment>();
  plans: PlanRow[] = [];
  runs: RunRow[] = [];
  findings: FindingRow[] = [];
  replies: ReplyRow[] = [];
  reports = new Map<string, ReportRow>();
  corr: CorrectionRow[] = [];
  fkeys = new Map<string, FeedKey>();
  use = new Map<string, UsageRow>();
  pays: FeedPayment[] = [];
  changes: ChangeRow[] = [];
  trials: TrialRow[] = [];
  uptime = new Map<string, UptimeRow>();
  async addTrial(t: TrialRow) {
    if (this.trials.some((x) => x.domain_lc === t.domain_lc || x.pay_to_lc === t.pay_to_lc || x.nonce === t.nonce)) return "taken" as const;
    this.trials.push({ ...t });
    return "inserted" as const;
  }
  async trialFor(d: string, p: string) { return this.trials.find((x) => x.domain_lc === d || x.pay_to_lc === p) ?? null; }
  async putUptime(rows: UptimeRow[]) { for (const r of rows) this.uptime.set(`${r.enrollment_id}|${r.endpoint}|${r.day}`, { ...r }); return rows.length; }
  async uptimeFor(id: string, from: string, to: string) {
    return [...this.uptime.values()].filter((r) => r.enrollment_id === id && r.day >= from && r.day <= to).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.endpoint.localeCompare(b.endpoint)));
  }
  async addEnrollment(e: Enrollment) {
    if ([...this.enrolls.values()].some((x) => x.nonce === e.nonce)) return "nonce_used" as const;
    this.enrolls.set(e.id, structuredClone(e));
    return "inserted" as const;
  }
  async enrollment(id: string) { const e = this.enrolls.get(id); return e ? structuredClone(e) : null; }
  async enrollmentsByPayTo(lc: string[]) { return [...this.enrolls.values()].filter((e) => lc.includes(e.pay_to_lc)); }
  async enrollments(limit: number) { return [...this.enrolls.values()].sort((a, b) => b.created_at - a.created_at).slice(0, limit); }
  async addPlan(p: PlanRow) { if (this.plans.some((x) => x.paid_tx === p.paid_tx)) return "duplicate" as const; this.plans.push({ ...p }); return "inserted" as const; }
  async founderSellers(plan: string) { return new Set(this.plans.filter((p) => p.plan === plan && !p.is_test).map((p) => p.enrollment_id)).size; }
  async plansFor(id: string) { return this.plans.filter((p) => p.enrollment_id === id).sort((a, b) => b.starts_at - a.starts_at); }
  async plansEndingAfter(t: number) { return this.plans.filter((p) => p.ends_at > t); }
  async setReminded(id: string, n: number) { const p = this.plans.find((x) => x.id === id); if (p) p.reminded = n; }
  async addSpent(id: string, usd: number) { const p = this.plans.find((x) => x.id === id); if (p) p.spent_usd = Math.round((p.spent_usd + usd) * 1e6) / 1e6; }
  async addRun(r: RunRow) { const id = this.runs.length + 1; this.runs.push({ ...r, id }); return id; }
  async runsFor(id: string, limit: number) { return this.runs.filter((r) => r.enrollment_id === id).sort((a, b) => b.ts - a.ts || (b.id! - a.id!)).slice(0, limit); }
  async addFinding(f: FindingRow) { const id = this.findings.length + 1; this.findings.push({ ...f, id }); return id; }
  async setDelivered(id: number, via: string) { const f = this.findings.find((x) => x.id === id); if (f) f.delivered = via; }
  async findingsFor(id: string, limit: number) { return this.findings.filter((f) => f.enrollment_id === id).sort((a, b) => b.ts - a.ts || b.id! - a.id!).slice(0, limit); }
  async addReply(r: ReplyRow) { const id = this.replies.length + 1; this.replies.push({ ...r, id }); return id; }
  async repliesFor(id: string) { return this.replies.filter((r) => r.enrollment_id === id); }
  async putReport(r: ReportRow) { this.reports.set(r.plan_id, { ...r }); }
  async report(id: string) { return this.reports.get(id) ?? null; }
  async addCorrection(c: CorrectionRow) { const id = this.corr.length + 1; this.corr.push({ ...c, id }); return id; }
  async corrections(limit: number) { return [...this.corr].reverse().slice(0, limit); }
  async addKey(k: FeedKey) { this.fkeys.set(k.id, { ...k }); }
  async keyById(id: string) { const k = this.fkeys.get(id); return k ? { ...k } : null; }
  async keyByHash(h: string) { const k = [...this.fkeys.values()].find((x) => x.key_hash === h); return k ? { ...k } : null; }
  async keyByWallet(lc: string) { const k = [...this.fkeys.values()].find((x) => x.wallet_lc === lc); return k ? { ...k } : null; }
  async updateKey(id: string, patch: Partial<FeedKey>) { const k = this.fkeys.get(id); if (k) Object.assign(k, patch); }
  async addCredits(id: string, n: number) { const k = this.fkeys.get(id); if (k) k.credits = Math.max(0, k.credits + n); }
  async keys(limit: number) { return [...this.fkeys.values()].slice(0, limit); }
  async addPayment(p: FeedPayment) { if (this.pays.some((x) => x.tx === p.tx)) return "duplicate" as const; this.pays.push({ ...p }); return "inserted" as const; }
  async payments(limit: number) { return [...this.pays].reverse().slice(0, limit); }
  async usage(k: string, m: string) { const u = this.use.get(`${k}|${m}`); return u ? { ...u } : null; }
  async bumpUsage(k: string, m: string, n: number, minute: number) {
    const u = this.use.get(`${k}|${m}`) ?? { key_id: k, month: m, lookups: 0, requests: 0, minute, minute_requests: 0 };
    u.lookups += n; u.requests += 1;
    if (u.minute === minute) u.minute_requests += 1; else { u.minute = minute; u.minute_requests = 1; }
    this.use.set(`${k}|${m}`, u);
  }
  async usageFor(m: string) { return [...this.use.values()].filter((u) => u.month === m || m === "*"); }
  async addChanges(rows: ChangeRow[]) { for (const r of rows) this.changes.push({ ...r, id: this.changes.length + 1 }); }
  async changesSince(ts: number, afterId: number, limit: number) { return this.changes.filter((c) => c.ts >= ts && c.id! > afterId).slice(0, limit); }
  async webhookKeys(now: number) { return [...this.fkeys.values()].filter((k) => k.plan === "feed_pro" && (k.plan_ends_at ?? 0) > now && k.webhook_url); }
}

function enrollFrom(r: any): Enrollment {
  let endpoints: MonitorEndpoint[] = [];
  try { endpoints = JSON.parse(r.endpoints); } catch { /* empty */ }
  return { ...r, endpoints, is_test: b(r.is_test) };
}
const planFrom = (r: any): PlanRow => ({ ...r, is_test: b(r.is_test) });
const runFrom = (r: any): RunRow => ({ ...r, data_returned: b(r.data_returned) });
const keyFrom = (r: any): FeedKey => ({ ...r, is_test: b(r.is_test) });

export class D1CommerceStore implements CommerceStore {
  constructor(private db: D1Like) {}
  private all = async <T,>(sql: string, ...args: unknown[]) => ((await this.db.prepare(sql).bind(...args).all<T>()).results ?? []) as T[];
  private first = async <T,>(sql: string, ...args: unknown[]) => (await this.db.prepare(sql).bind(...args).first<T>()) ?? null;
  private run = async (sql: string, ...args: unknown[]) => this.db.prepare(sql).bind(...args).run() as Promise<any>;

  async addEnrollment(e: Enrollment) {
    try {
      await this.run(
        `INSERT INTO monitor_enrollments (id, network, pay_to, pay_to_lc, domain, proof, nonce, endpoints, webhook_url, webhook_secret, email, token_hash, is_test, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
        e.id, e.network, e.pay_to, e.pay_to_lc, e.domain, e.proof, e.nonce, JSON.stringify(e.endpoints), e.webhook_url, e.webhook_secret, e.email, e.token_hash, e.is_test ? 1 : 0, e.created_at,
      );
      return "inserted" as const;
    } catch (err) {
      if (/UNIQUE/i.test(String(err))) return "nonce_used" as const;
      throw err;
    }
  }
  async enrollment(id: string) { const r = await this.first<any>("SELECT * FROM monitor_enrollments WHERE id = ?1", id); return r ? enrollFrom(r) : null; }
  async enrollmentsByPayTo(lc: string[]) {
    if (!lc.length) return [];
    const l = lc.slice(0, 50);
    return (await this.all<any>(`SELECT * FROM monitor_enrollments WHERE pay_to_lc IN (${l.map((_, i) => `?${i + 1}`).join(",")})`, ...l)).map(enrollFrom);
  }
  async enrollments(limit: number) { return (await this.all<any>("SELECT * FROM monitor_enrollments ORDER BY created_at DESC LIMIT ?1", limit)).map(enrollFrom); }
  async addPlan(p: PlanRow) {
    const r = await this.run(
      `INSERT OR IGNORE INTO monitor_plans (id, enrollment_id, plan, starts_at, ends_at, paid_tx, paid_network, paid_asset, paid_amount, payer, usd, budget_usd, spent_usd, is_test, reminded, created_at, endpoints, unit_usd)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)`,
      p.id, p.enrollment_id, p.plan, p.starts_at, p.ends_at, p.paid_tx, p.paid_network, p.paid_asset, p.paid_amount, p.payer, p.usd, p.budget_usd, p.spent_usd, p.is_test ? 1 : 0, p.reminded, p.created_at, p.endpoints ?? null, p.unit_usd ?? null,
    );
    return (r?.meta?.changes ?? 1) > 0 ? ("inserted" as const) : ("duplicate" as const);
  }
  async founderSellers(plan: string) { return Number((await this.first<any>("SELECT COUNT(DISTINCT enrollment_id) AS n FROM monitor_plans WHERE plan = ?1 AND is_test = 0", plan))?.n ?? 0); }
  async plansFor(id: string) { return (await this.all<any>("SELECT * FROM monitor_plans WHERE enrollment_id = ?1 ORDER BY starts_at DESC LIMIT 50", id)).map(planFrom); }
  async plansEndingAfter(t: number) { return (await this.all<any>("SELECT * FROM monitor_plans WHERE ends_at > ?1 ORDER BY ends_at LIMIT 500", t)).map(planFrom); }
  async setReminded(id: string, n: number) { await this.run("UPDATE monitor_plans SET reminded = ?2 WHERE id = ?1", id, n); }
  async addSpent(id: string, usd: number) { await this.run("UPDATE monitor_plans SET spent_usd = ROUND(spent_usd + ?2, 6) WHERE id = ?1", id, usd); }
  async addRun(r: RunRow) {
    const x = await this.first<{ id: number }>(
      `INSERT INTO monitor_runs (enrollment_id, plan_id, endpoint, ts, network, tx_hash, amount, asset, cost_usd, http_status, data_returned, latency_ms, outcome, quote_pay_to, quote_price_usd, schema_hash, note, funding)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18) RETURNING id`,
      r.enrollment_id, r.plan_id, r.endpoint, r.ts, r.network, r.tx_hash, r.amount, r.asset, r.cost_usd, r.http_status, r.data_returned ? 1 : 0, r.latency_ms, r.outcome, r.quote_pay_to, r.quote_price_usd, r.schema_hash, r.note, r.funding,
    );
    return x?.id ?? 0;
  }
  async runsFor(id: string, limit: number) { return (await this.all<any>("SELECT * FROM monitor_runs WHERE enrollment_id = ?1 ORDER BY ts DESC, id DESC LIMIT ?2", id, limit)).map(runFrom); }
  async addFinding(f: FindingRow) {
    const x = await this.first<{ id: number }>(
      "INSERT INTO monitor_findings (enrollment_id, endpoint, ts, kind, detail, run_id, delivered) VALUES (?1,?2,?3,?4,?5,?6,?7) RETURNING id",
      f.enrollment_id, f.endpoint, f.ts, f.kind, f.detail, f.run_id, f.delivered,
    );
    return x?.id ?? 0;
  }
  async setDelivered(id: number, via: string) { await this.run("UPDATE monitor_findings SET delivered = ?2 WHERE id = ?1", id, via); }
  async findingsFor(id: string, limit: number) { return this.all<FindingRow>("SELECT * FROM monitor_findings WHERE enrollment_id = ?1 ORDER BY ts DESC, id DESC LIMIT ?2", id, limit); }
  async addReply(r: ReplyRow) {
    const x = await this.first<{ id: number }>("INSERT INTO monitor_replies (enrollment_id, finding_id, ts, text) VALUES (?1,?2,?3,?4) RETURNING id", r.enrollment_id, r.finding_id, r.ts, r.text);
    return x?.id ?? 0;
  }
  async repliesFor(id: string) { return this.all<ReplyRow>("SELECT * FROM monitor_replies WHERE enrollment_id = ?1 ORDER BY ts LIMIT 200", id); }
  async putReport(r: ReportRow) {
    await this.run(
      "INSERT OR REPLACE INTO monitor_reports (plan_id, enrollment_id, report, report_hash, signature, public_key, signer, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
      r.plan_id, r.enrollment_id, r.report, r.report_hash, r.signature, r.public_key, r.signer, r.created_at,
    );
  }
  async report(id: string) { return this.first<ReportRow>("SELECT * FROM monitor_reports WHERE plan_id = ?1", id); }
  async addCorrection(c: CorrectionRow) {
    const x = await this.first<{ id: number }>("INSERT INTO corrections (ts, subject, summary, ref) VALUES (?1,?2,?3,?4) RETURNING id", c.ts, c.subject, c.summary, c.ref);
    return x?.id ?? 0;
  }
  async corrections(limit: number) { return this.all<CorrectionRow>("SELECT * FROM corrections ORDER BY id DESC LIMIT ?1", limit); }
  async addTrial(t: TrialRow) {
    const r = await this.run(
      "INSERT OR IGNORE INTO monitor_trials (id, enrollment_id, plan_id, domain_lc, pay_to_lc, nonce, proof, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
      t.id, t.enrollment_id, t.plan_id, t.domain_lc, t.pay_to_lc, t.nonce, t.proof, t.created_at,
    );
    return (r?.meta?.changes ?? 1) > 0 ? ("inserted" as const) : ("taken" as const);
  }
  async trialFor(d: string, p: string) { return this.first<TrialRow>("SELECT * FROM monitor_trials WHERE domain_lc = ?1 OR pay_to_lc = ?2 LIMIT 1", d, p); }
  async putUptime(rows: UptimeRow[]) {
    if (!rows.length) return 0;
    const sql = `INSERT INTO monitor_uptime_daily (enrollment_id, endpoint, day, checks, ok, p50_ms, p95_ms, quote_amount, quote_asset, quote_pay_to) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
      ON CONFLICT (enrollment_id, endpoint, day) DO UPDATE SET checks = ?4, ok = ?5, p50_ms = ?6, p95_ms = ?7, quote_amount = ?8, quote_asset = ?9, quote_pay_to = ?10`;
    const l = rows.slice(0, 200);
    await this.db.batch(l.map((r) => this.db.prepare(sql).bind(r.enrollment_id, r.endpoint, r.day, r.checks, r.ok, r.p50_ms, r.p95_ms, r.quote_amount, r.quote_asset, r.quote_pay_to)));
    return l.length;
  }
  async uptimeFor(id: string, from: string, to: string) {
    return this.all<UptimeRow>("SELECT * FROM monitor_uptime_daily WHERE enrollment_id = ?1 AND day >= ?2 AND day <= ?3 ORDER BY day DESC, endpoint LIMIT 2000", id, from, to);
  }
  async addKey(k: FeedKey) {
    await this.run(
      `INSERT INTO feed_keys (id, key_hash, wallet, wallet_lc, network, plan, plan_ends_at, credits, is_test, webhook_url, webhook_secret, webhook_cursor, created_at, rotated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
      k.id, k.key_hash, k.wallet, k.wallet_lc, k.network, k.plan, k.plan_ends_at, k.credits, k.is_test ? 1 : 0, k.webhook_url, k.webhook_secret, k.webhook_cursor, k.created_at, k.rotated_at,
    );
  }
  async keyById(id: string) { const r = await this.first<any>("SELECT * FROM feed_keys WHERE id = ?1", id); return r ? keyFrom(r) : null; }
  async keyByHash(h: string) { const r = await this.first<any>("SELECT * FROM feed_keys WHERE key_hash = ?1", h); return r ? keyFrom(r) : null; }
  async keyByWallet(lc: string) { const r = await this.first<any>("SELECT * FROM feed_keys WHERE wallet_lc = ?1 ORDER BY created_at LIMIT 1", lc); return r ? keyFrom(r) : null; }
  async updateKey(id: string, patch: Partial<FeedKey>) {
    const cols = Object.keys(patch).filter((c) => /^[a-z_]+$/.test(c) && c !== "id");
    if (!cols.length) return;
    const vals = cols.map((c) => { const v = (patch as any)[c]; return typeof v === "boolean" ? (v ? 1 : 0) : v; });
    await this.run(`UPDATE feed_keys SET ${cols.map((c, i) => `${c} = ?${i + 2}`).join(", ")} WHERE id = ?1`, id, ...vals);
  }
  async addCredits(id: string, n: number) { await this.run("UPDATE feed_keys SET credits = MAX(0, credits + ?2) WHERE id = ?1", id, n); }
  async keys(limit: number) { return (await this.all<any>("SELECT * FROM feed_keys ORDER BY created_at DESC LIMIT ?1", limit)).map(keyFrom); }
  async addPayment(p: FeedPayment) {
    const r = await this.run(
      "INSERT OR IGNORE INTO feed_payments (tx, key_id, product, usd, is_test, network, asset, amount, payer, ts) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
      p.tx, p.key_id, p.product, p.usd, p.is_test ? 1 : 0, p.network, p.asset, p.amount, p.payer, p.ts,
    );
    return (r?.meta?.changes ?? 1) > 0 ? ("inserted" as const) : ("duplicate" as const);
  }
  async payments(limit: number) { return (await this.all<any>("SELECT * FROM feed_payments ORDER BY ts DESC LIMIT ?1", limit)).map((r) => ({ ...r, is_test: b(r.is_test) })); }
  async usage(k: string, m: string) { return this.first<UsageRow>("SELECT * FROM feed_usage WHERE key_id = ?1 AND month = ?2", k, m); }
  async bumpUsage(k: string, m: string, n: number, minute: number) {
    await this.run(
      `INSERT INTO feed_usage (key_id, month, lookups, requests, minute, minute_requests) VALUES (?1, ?2, ?3, 1, ?4, 1)
       ON CONFLICT (key_id, month) DO UPDATE SET lookups = lookups + ?3, requests = requests + 1,
         minute_requests = CASE WHEN minute = ?4 THEN minute_requests + 1 ELSE 1 END, minute = ?4`,
      k, m, n, minute,
    );
  }
  async usageFor(m: string) { return m === "*" ? this.all<UsageRow>("SELECT * FROM feed_usage LIMIT 500") : this.all<UsageRow>("SELECT * FROM feed_usage WHERE month = ?1 LIMIT 500", m); }
  async addChanges(rows: ChangeRow[]) {
    if (!rows.length) return;
    await this.db.batch(rows.slice(0, 200).map((r) => this.db.prepare("INSERT INTO feed_changes (ts, resource, field, old, new) VALUES (?1,?2,?3,?4,?5)").bind(r.ts, r.resource, r.field, r.old, r.new)));
  }
  async changesSince(ts: number, afterId: number, limit: number) {
    return this.all<ChangeRow>("SELECT * FROM feed_changes WHERE ts >= ?1 AND id > ?2 ORDER BY id LIMIT ?3", ts, afterId, limit);
  }
  async webhookKeys(now: number) {
    return (await this.all<any>("SELECT * FROM feed_keys WHERE plan = 'feed_pro' AND plan_ends_at > ?1 AND webhook_url IS NOT NULL LIMIT 20", now)).map(keyFrom);
  }
}
