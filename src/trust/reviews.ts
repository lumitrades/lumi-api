/**
 * Human review and re-test requests for checks_failed (legal review 2026-10-25: M14 and §3.4).
 *
 * - Test-buy and stored-quote based checks_failed (REVIEW_GATED codes) is never auto-published: until a person at Lumi
 *   approves it, the shared check core shows check_first with `checks_failed_pending_review`. This applies to every seller
 *   alike; the seller's relationship with Lumi (competitor, customer, paying seller) is stored for the reviewer only.
 * - Facts about the caller's own quote (payTo not the seller's, price over the listing) and OFAC hits stay immediate.
 * - A re-test request (email, contact form, signed reply, or owner on the seller's behalf) pauses checks_failed for
 *   APPEAL_PAUSE_HOURS (shown as check_first / `retest_requested`) and asks for a re-buy.
 *
 * Writes: one INSERT OR IGNORE the first time a seller's evidence needs review (memoised per isolate); reads only when a
 * check would otherwise publish a gated checks_failed, or for /v1/verdict (to show a seller reply).
 */
import type { D1Like } from "../config";
import { APPEAL_PAUSE_HOURS, failureStreak } from "./verdict";

export const REVIEW_GATED = ["paid_no_data", "quote_pays_unlisted_address"];
export type ReviewState = "pending" | "approved" | "rejected";
export interface ReviewRow { host: string; evidence: string; state: ReviewState; codes: string; relationship: string | null; created_at: number; decided_at: number | null; note: string | null }
export interface AppealRow { host: string; opened_at: number; until_at: number; source: string; reply: string | null; rebuy: string | null }

export interface ReviewStore {
  reviewsFor(host: string): Promise<ReviewRow[]>;
  appealFor(host: string): Promise<AppealRow | null>;
  addPending(r: ReviewRow): Promise<void>;
  decide(host: string, evidence: string, state: ReviewState, note: string | null, t: number): Promise<boolean>;
  list(state: string, limit: number): Promise<ReviewRow[]>;
  openAppeal(a: AppealRow): Promise<void>;
  setRebuy(host: string, rebuy: string): Promise<void>;
  appeals(limit: number): Promise<AppealRow[]>;
}

export class MemoryReviewStore implements ReviewStore {
  rows = new Map<string, ReviewRow>();
  ap = new Map<string, AppealRow>();
  writes = 0;
  async reviewsFor(host: string) { return [...this.rows.values()].filter((r) => r.host === host); }
  async appealFor(host: string) { return this.ap.get(host) ?? null; }
  async addPending(r: ReviewRow) { this.writes++; const k = `${r.host}|${r.evidence}`; if (!this.rows.has(k)) this.rows.set(k, { ...r }); }
  async decide(host: string, evidence: string, state: ReviewState, note: string | null, t: number) {
    const r = this.rows.get(`${host}|${evidence}`); if (!r) return false; r.state = state; r.note = note; r.decided_at = t; this.writes++; return true;
  }
  async list(state: string, limit: number) { return [...this.rows.values()].filter((r) => state === "all" || r.state === state).sort((a, b) => b.created_at - a.created_at).slice(0, limit); }
  async openAppeal(a: AppealRow) { this.writes++; this.ap.set(a.host, { ...a }); }
  async setRebuy(host: string, rebuy: string) { const a = this.ap.get(host); if (a) { a.rebuy = rebuy; this.writes++; } }
  async appeals(limit: number) { return [...this.ap.values()].sort((a, b) => b.opened_at - a.opened_at).slice(0, limit); }
}

export class D1ReviewStore implements ReviewStore {
  constructor(private db: D1Like) {}
  async reviewsFor(host: string) { return ((await this.db.prepare("SELECT * FROM verdict_reviews WHERE host = ?1 LIMIT 20").bind(host).all<ReviewRow>()).results ?? []); }
  async appealFor(host: string) { return await this.db.prepare("SELECT * FROM verdict_appeals WHERE host = ?1").bind(host).first<AppealRow>(); }
  async addPending(r: ReviewRow) {
    await this.db.prepare("INSERT OR IGNORE INTO verdict_reviews (host, evidence, state, codes, relationship, created_at) VALUES (?1, ?2, 'pending', ?3, ?4, ?5)")
      .bind(r.host, r.evidence, r.codes, r.relationship, r.created_at).run();
  }
  async decide(host: string, evidence: string, state: ReviewState, note: string | null, t: number) {
    const x = await this.db.prepare("UPDATE verdict_reviews SET state = ?3, note = ?4, decided_at = ?5 WHERE host = ?1 AND evidence = ?2 RETURNING host").bind(host, evidence, state, note, t).first();
    return !!x;
  }
  async list(state: string, limit: number) {
    const st = state === "all" ? this.db.prepare("SELECT * FROM verdict_reviews ORDER BY created_at DESC LIMIT ?1").bind(limit) : this.db.prepare("SELECT * FROM verdict_reviews WHERE state = ?2 ORDER BY created_at DESC LIMIT ?1").bind(limit, state);
    return (await st.all<ReviewRow>()).results ?? [];
  }
  async openAppeal(a: AppealRow) {
    await this.db.prepare("INSERT INTO verdict_appeals (host, opened_at, until_at, source, reply, rebuy) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(host) DO UPDATE SET opened_at = excluded.opened_at, until_at = excluded.until_at, source = excluded.source, reply = COALESCE(excluded.reply, verdict_appeals.reply), rebuy = excluded.rebuy")
      .bind(a.host, a.opened_at, a.until_at, a.source, a.reply, a.rebuy).run();
  }
  async setRebuy(host: string, rebuy: string) { await this.db.prepare("UPDATE verdict_appeals SET rebuy = ?2 WHERE host = ?1").bind(host, rebuy).run(); }
  async appeals(limit: number) { return ((await this.db.prepare("SELECT * FROM verdict_appeals ORDER BY opened_at DESC LIMIT ?1").bind(limit).all<AppealRow>()).results ?? []); }
}

/** Evidence key: new evidence (a new failing streak, a success in between) needs a new review. */
export function evidenceKey(code: string, exact: any): string {
  const e = exact?.catalog?.entries?.[0];
  if (code === "paid_no_data") return `paid_no_data:${failureStreak(e?.purchases ?? [], 0).streakStartAt ?? "none"}`;
  return `${code}:${e?.resource ?? "domain"}`;
}

export type GateInfo = {
  review: { state: ReviewState | "none"; evidence: string } | null;
  retest: { requested_at: string; paused_until: string; rebuy: string | null } | null;
};

/**
 * Applies human review and re-test pauses to a trustVerdict result in place (same object, so all three endpoints see it).
 * relationship is stored for the reviewer and never read for the outcome.
 */
export function createReviewGate(store: ReviewStore | null, now: () => number, log?: (e: Record<string, unknown>) => void) {
  const pendingMemo = new Set<string>();
  return async function gate(v: Record<string, any>, exact: any, host: string, relationship: string | null): Promise<GateInfo> {
    const reasons: any[] = Array.isArray(v.reasons) ? v.reasons : [];
    const blocks = reasons.filter((r) => r.severity === "block");
    const gated = blocks.filter((r) => REVIEW_GATED.includes(r.code));
    if (!gated.length || blocks.length !== gated.length) return { review: null, retest: null }; // nothing gated, or an immediate block stands
    const t = now();
    const downgrade = (code: string, detail: string) => {
      for (const r of gated) r.severity = "warn";
      reasons.unshift({ code, severity: "warn", detail });
      v.verdict = "warn";
    };
    if (!store) { downgrade("checks_failed_pending_review", "A person at Lumi reviews this before checks_failed is shown."); return { review: { state: "pending", evidence: "" }, retest: null }; }
    let appeal: AppealRow | null = null; let reviews: ReviewRow[] = [];
    try { [appeal, reviews] = await Promise.all([store.appealFor(host), store.reviewsFor(host)]); } catch (e) { log?.({ event: "review_read_error", error: String(e) }); }
    if (appeal && appeal.until_at > t) {
      downgrade("retest_requested", `The seller asked for a re-test on ${new Date(appeal.opened_at).toISOString().slice(0, 10)}; checks_failed is paused until ${new Date(appeal.until_at).toISOString()} while Lumi re-buys.`);
      return { review: null, retest: { requested_at: new Date(appeal.opened_at).toISOString(), paused_until: new Date(appeal.until_at).toISOString(), rebuy: appeal.rebuy } };
    }
    const keys = gated.map((r) => evidenceKey(r.code, exact));
    const rows = keys.map((k) => reviews.find((r) => r.evidence === k));
    if (rows.every((r) => r?.state === "approved")) return { review: { state: "approved", evidence: keys.join(",") }, retest: null };
    if (rows.every((r) => r?.state === "rejected")) {
      // The reviewer found the failure not attributable to the seller (e.g. Lumi-side): it no longer counts.
      for (const r of gated) r.severity = "info";
      v.verdict = reasons.some((r) => r.severity === "warn") ? "warn" : reasons.some((r) => ["not_observed", "not_quote_checked"].includes(r.code)) ? "unknown" : "allow";
      return { review: { state: "rejected", evidence: keys.join(",") }, retest: null };
    }
    downgrade("checks_failed_pending_review", "Lumi's evidence meets the bar for checks_failed; a person at Lumi reviews it before it is shown.");
    for (let i = 0; i < keys.length; i++) {
      const memo = `${host}|${keys[i]}`;
      if (rows[i] || pendingMemo.has(memo)) continue;
      pendingMemo.add(memo);
      try { await store.addPending({ host, evidence: keys[i], state: "pending", codes: gated[i].code, relationship, created_at: t, decided_at: null, note: null }); }
      catch (e) { pendingMemo.delete(memo); log?.({ event: "review_write_error", error: String(e) }); }
    }
    return { review: { state: "pending", evidence: keys.join(",") }, retest: null };
  };
}

export const appealUntil = (t: number) => t + APPEAL_PAUSE_HOURS * 3_600_000;
