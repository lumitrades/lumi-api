/**
 * Fleet guard / wallet pattern check (DRAFT 2026-11-19, branch fleet-guard-2026-11-19, NOT deployed; off unless FLEET_GUARD=on):
 * a dated pattern-match label for a payer or seller identifier: "Pattern match: automated cluster, as of <date>, method <URL>",
 * "No match" or "Insufficient data". No confidence score, no statement of intent, never a list of other members.
 * Every answer carries method_url, disclaimer (not OFAC/AML screening, not a consumer report, dated, no warranty) and the
 * FCRA use_restriction (privacy review 2026-11-19, notes/legal/privacy_fleet_guard_2026-11-19.md).
 *
 *   GET  /v1/fleet                       free doc (prices, caps, endpoints, legal)
 *   GET  /v1/fleet/methodology           free: method, label rules, retention, disputes (the method_url)
 *   GET  /v1/fleet/check?subject=a[,b..] paid x402, 0.0005 USD per call (one subject = one call; max FLEET_GUARD.batchMax);
 *                                        or prepaid with X-Lumi-Fleet-Key (one credit per subject, decremented atomically)
 *   GET  /v1/fleet/check/free?subject=a  free, capped per hashed IP AND per hashed wallet header AND globally (fail-closed)
 *   GET  /v1/fleet/pack                  paid x402, $4 → key with 10,000 calls, lasts 365 days, no auto-renew
 *   GET  /v1/fleet/plan/monthly          paid x402, 30-day fair-use key (only when FLEET_GUARD_MONTHLY=on; not in docs otherwise)
 *   GET  /v1/fleet/key                   remaining credits for X-Lumi-Fleet-Key (free)
 *   POST/DELETE /v1/fleet/admin/members, POST /v1/fleet/admin/override   owner only, work while FLEET_GUARD is off
 *
 * Security rules (Vigil review 2026-11-19):
 *  - Price, asset, payTo and network come from server config only (buildAccepts via requirePayment); the invoice binds the
 *    route key, amounts and the normalized query URL. Replay guard claims the invoice before settle; settlement must succeed
 *    before serve() runs; each settled tx hash is recorded once (fleet_guard_settles PK) and a duplicate is refused + alerted.
 *  - serve() re-checks the paid amount against the floor (0.0005 USD per subject) as defence in depth.
 *  - No raw payer address is stored, logged, echoed in a header, body or error: payers are HMAC-SHA256(FLEET_GUARD_HMAC_SECRET)
 *    and the PAYMENT-RESPONSE header is re-encoded without `payer`. The answer body carries no payer data at all.
 *  - Cache key = route version + HMAC(normalized subject) only. A cache hit is only reachable from serve() (after payment or
 *    a credit decrement), so a cached answer is never free.
 *  - Nothing expensive before payment: before verify we only parse/validate the query (bounded) and take a rate-limit count.
 *  - Retention (nightly, whether or not the flag is on): memberships 90 days from last load/reconfirm, settles 90 days,
 *    the product's sales rows 90 days, keys 30 days after expiry. Overrides (corrections/exclusions) are kept.
 *  - Invoice/resource URLs carry only n and a keyed hash of the query (qh), never a subject.
 *  - HMAC rotation: FLEET_GUARD_HMAC_SECRET_PREV is also tried for lookups, overrides and deletions.
 *
 * Vigil re-review fixes (2026-11-19):
 *  - MED-1: the shared idempotency table stores PAYMENT-RESPONSE without `payer` (x402.ts redactPaymentResponseHeader).
 *  - MED-2: pack/plan keys = "fgk_" + HMAC(FLEET_GUARD_KEY_SECRET, plan + settled tx)[0..40] (own secret; packs off without it); the idempotency row keeps a placeholder and a
 *    replay recomputes the key from the cached tx hash. Fleet replays are bound to sha256 of the full signed payment header.
 *  - MED-3: prepaid checks and /v1/fleet/key: recently valid keys are limited per key (keyPerMinute); unknown or failed
 *    keys get FLEET_GUARD.keyIpPerMinute per network and FLEET_GUARD.keyFailPer10Min failures, then 429 with no lookup.
 *  - LOW-1 alert on a failed settle-record write (still served); LOW-2 underpay after settle is 409 + tx, never 402;
 *    LOW-3 allow-listed paywall log fields; LOW-5 CF-Connecting-IP only, IPv6 per /64, else one "unknown" bucket.
 */
import type { Config, D1Like, KVLike } from "./config";
import { usdToDrops } from "./pricing";
import type { IdempotencyRecord, IdempotencyStore } from "./idempotency";
import {
  b64decodeUtf8, encodeHeader, HEADER_PAYMENT_RESPONSE, HEADER_PAYMENT_SIGNATURE, HEADER_X_PAYMENT, json, paymentRequiredResponse,
  requirePayment, isEvmRequirement, isStellarRequirement, type PaymentRequirements, type PaywallDeps, type Quote, type Settlement,
} from "./x402";
import type { QuotaCounter, QuotaKey } from "./free_quota";

export const FLEET_GUARD = {
  version: "fg1",
  priceUsd: "0.0005",
  /** Floor per subject; serve() refuses anything below (never expected: the amount is server-set and invoice-bound). */
  minUsd: 0.0005,
  cacheTtlSec: 3600,
  batchMax: 20,
  subjectMaxChars: 128,
  queryMaxChars: 2800,
  pack: { id: "fleet_pack", usd: "4", calls: 10_000, days: 365 },
  monthly: { id: "fleet_monthly", usd: "49", calls: 1_500_000, days: 30 },
  free: { perIpDay: 10, perWalletDay: 10, globalDay: 2_000, perIpMinute: 5 },
  /** Per hashed IP (x402 path) or per key (prepaid path), per minute. */
  paidPerMinute: 600,
  keyPerMinute: 1_200,
  /**
   * Keys not yet known to be valid (unknown, bad format or failed): per network (/64 for IPv6), per minute, across prepaid
   * checks and /v1/fleet/key. A recently valid key skips this and the failed-key lockout; it is limited by keyPerMinute.
   */
  keyIpPerMinute: 60,
  /** Failed prepaid keys (bad format or unknown) per network per 10 minutes; over it, unknown keys get 429. */
  keyFailPer10Min: 10,
  retentionDays: 90,
  keyRetentionDays: 30,
  adminMaxMembers: 5_000,
} as const;

const DAY = 86_400_000;
const NO_STORE = { "Cache-Control": "no-store" };
export const FLEET_KEY_HEADER = "X-Lumi-Fleet-Key";
const WALLET_HEADERS = ["X-Lumi-Wallet", "X-Wallet"];

// ---------------------------------------------------------------- hashing / normalization

export async function hmacHex(secret: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Rate-limit bucket for a client address (Vigil LOW-5): CF-Connecting-IP only (never X-Forwarded-For, which the client
 * controls); IPv6 grouped by /64 (one subscriber's allocation); IPv4-mapped IPv6 counted as the IPv4; else "unknown".
 */
export function ipBucket(raw: string | null | undefined): string {
  const ip = (raw ?? "").trim().replace(/%.*$/, "").toLowerCase();
  if (!ip) return "unknown";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.split(".").every((o) => Number(o) <= 255) ? ip : "unknown";
  if (!ip.includes(":") || ip.length > 45) return "unknown";
  let v6 = ip;
  const v4 = v6.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    if (/^(0{0,4}:){0,5}:?ffff:$|^::ffff:$/.test(v4[1])) return ipBucket(v4[2]);
    const o = v4[2].split(".").map(Number);
    if (o.some((x) => x > 255)) return "unknown";
    v6 = v4[1] + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = v6.split("::");
  if (halves.length > 2) return "unknown";
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return "unknown";
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return "unknown";
  return "v6:" + groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":") + "::/64";
}

const ADDRESS_LIKE = /\b(?:r[1-9A-HJ-NP-Za-km-z]{24,34}|0x[0-9a-fA-F]{40}(?![0-9a-fA-F])|G[A-Z2-7]{55})\b/g;
/** Log keys the fleet guard passes through from the shared paywall (Vigil LOW-3); everything else is dropped. */
const LOG_ALLOW = new Set(["event", "route", "phase", "status", "reason", "error", "from", "tx", "network", "asset", "amount", "amountDrops", "facilitator", "svc"]);
export function redactLogEvent(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (k === "payer") { if (v) out.payer = "redacted"; continue; }
    if (!LOG_ALLOW.has(k)) continue;
    out[k] = typeof v === "string" && k !== "tx" ? v.replace(ADDRESS_LIKE, "[address]") : v;
  }
  return out;
}

export type SubjectKind = "xrpl" | "evm" | "stellar" | "solana" | "domain";
export interface Subject { kind: SubjectKind; norm: string }

const XRPL_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const STELLAR_RE = /^G[A-Z2-7]{55}$/;
const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** One payer/seller identifier → a canonical form, or null. XRPL/Solana are case-sensitive; EVM/hosts are lower-cased. */
export function normalizeSubject(raw: string): Subject | null {
  const s = raw.trim();
  if (!s || s.length > FLEET_GUARD.subjectMaxChars) return null;
  if (XRPL_RE.test(s)) return { kind: "xrpl", norm: s };
  if (EVM_RE.test(s)) return { kind: "evm", norm: s.toLowerCase() };
  if (STELLAR_RE.test(s)) return { kind: "stellar", norm: s };
  if (SOLANA_RE.test(s)) return { kind: "solana", norm: s };
  let host = s.toLowerCase();
  if (/^https?:\/\//.test(host)) {
    try { host = new URL(host).hostname; } catch { return null; }
  } else host = host.split("/")[0];
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  return HOST_RE.test(host) ? { kind: "domain", norm: host } : null;
}

export type ParsedQuery = { ok: true; subjects: Subject[]; canonical: string } | { ok: false; error: Record<string, unknown> };

/** Bounded parse of ?subject= (alias ?address=, ?seller=, ?payer=). No I/O. */
export function parseQuery(url: URL, maxSubjects: number = FLEET_GUARD.batchMax): ParsedQuery {
  const bad = (detail: string) => ({ ok: false as const, error: { error: "invalid_query", detail, example: "/v1/fleet/check?subject=api.example.com", note: "Not charged." } });
  if (url.search.length > FLEET_GUARD.queryMaxChars) return bad(`Query too long (max ${FLEET_GUARD.queryMaxChars} characters).`);
  const vals = ["subject", "address", "seller", "payer"].flatMap((k) => url.searchParams.getAll(k));
  const parts = vals.flatMap((v) => v.split(",")).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return bad("Add ?subject=<XRPL / EVM / Stellar / Solana address, seller domain or resource URL> (comma-separate up to " + maxSubjects + ").");
  if (parts.length > maxSubjects) return bad(`At most ${maxSubjects} subjects per call.`);
  const subjects: Subject[] = [];
  for (let i = 0; i < parts.length; i++) {
    const n = normalizeSubject(parts[i]);
    if (!n) return bad(`Subject ${i + 1} is not a supported address, domain or URL (max ${FLEET_GUARD.subjectMaxChars} characters).`);
    subjects.push(n);
  }
  return { ok: true, subjects, canonical: subjects.map((s) => s.norm).join(",") };
}

/** USD price for n subjects, exact to 4 decimals. */
export const checkPriceUsd = (n: number) => (Math.round(n * Number(FLEET_GUARD.priceUsd) * 10_000) / 10_000).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");

// ---------------------------------------------------------------- store

/** Cluster metadata kept internally (never returned): an opaque id and the method basis. No counts, no first-seen date. */
export interface ClusterInfo { id: string; basis: string }
export interface MemberRow { subject_hmac: string; cluster_id: string; role: "payer" | "seller"; subject_kind: SubjectKind }
export interface MemberHit { role: "payer" | "seller"; cluster_id: string; observed_on: string }
export interface FleetKeyRow { key_hash: string; plan: string; calls: number; used: number; expires_at: number; paid_tx: string; payer_hmac: string | null; created_at: number }
/** Owner correction for one subject hash (dispute, exclusion): it wins over any membership and blocks re-loading it. */
export type OverrideLabel = "No match" | "Insufficient data";
export const OVERRIDE_LABELS: readonly OverrideLabel[] = ["No match", "Insufficient data"];

export interface FleetGuardStore {
  /** Memberships for these subject hashes; observed_on = the day the membership was last loaded or reconfirmed (UTC). */
  members(hmacs: string[]): Promise<Map<string, MemberHit>>;
  overrides(hmacs: string[]): Promise<Map<string, OverrideLabel>>;
  /** Subject kinds that have at least one membership (others answer "Insufficient data"). */
  coveredKinds(): Promise<Set<SubjectKind>>;
  upsertCluster(c: ClusterInfo, now: number): Promise<void>;
  /** Inserts or reconfirms (resets added_at, the 90-day clock). Hashes with an override are skipped. */
  upsertMembers(rows: MemberRow[], now: number): Promise<number>;
  deleteMembers(hmacs: string[]): Promise<number>;
  deleteCluster(id: string): Promise<number>;
  /** label null clears the override. */
  setOverride(hmac: string, label: OverrideLabel | null, now: number): Promise<void>;
  /** Records a settled tx once. false = this tx was already recorded (replay): refuse. */
  recordSettle(tx: string, route: string, payerHmac: string | null, now: number): Promise<boolean>;
  /** Mints a key tied to exactly one settled tx. false = a key for this tx already exists. */
  mintKey(row: FleetKeyRow): Promise<boolean>;
  /** Atomically consume n credits. null = unknown/expired key or not enough credits left. */
  useCredits(keyHash: string, n: number, now: number): Promise<{ remaining: number; plan: string; expires_at: number } | null>;
  key(keyHash: string): Promise<FleetKeyRow | null>;
  /** Retention (FLEET_GUARD.retentionDays / keyRetentionDays): settles + their tx hashes, stale memberships, empty clusters, keys. */
  purge(now: number): Promise<{ settles: number; members: number; clusters: number; keys: number }>;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class MemoryFleetGuardStore implements FleetGuardStore {
  clusters = new Map<string, ClusterInfo & { updated_at: number }>();
  memberMap = new Map<string, MemberRow & { added_at: number }>();
  overrideMap = new Map<string, { label: OverrideLabel; at: number }>();
  settles = new Map<string, { route: string; payer_hmac: string | null; at: number }>();
  keys = new Map<string, FleetKeyRow>();
  async members(hmacs: string[]) {
    const out = new Map<string, MemberHit>();
    for (const h of hmacs) {
      const m = this.memberMap.get(h);
      if (m && this.clusters.has(m.cluster_id)) out.set(h, { role: m.role, cluster_id: m.cluster_id, observed_on: dayOf(m.added_at) });
    }
    return out;
  }
  async overrides(hmacs: string[]) {
    const out = new Map<string, OverrideLabel>();
    for (const h of hmacs) { const o = this.overrideMap.get(h); if (o) out.set(h, o.label); }
    return out;
  }
  async coveredKinds() { return new Set([...this.memberMap.values()].map((m) => m.subject_kind)); }
  async upsertCluster(c: ClusterInfo, now: number) { this.clusters.set(c.id, { id: c.id, basis: c.basis, updated_at: now }); }
  async upsertMembers(rows: MemberRow[], now: number) {
    let n = 0;
    for (const r of rows) { if (this.overrideMap.has(r.subject_hmac)) continue; this.memberMap.set(r.subject_hmac, { ...r, added_at: now }); n++; }
    return n;
  }
  async deleteMembers(hmacs: string[]) { let n = 0; for (const h of hmacs) if (this.memberMap.delete(h)) n++; return n; }
  async deleteCluster(id: string) {
    let n = 0;
    for (const [h, m] of this.memberMap) if (m.cluster_id === id) { this.memberMap.delete(h); n++; }
    this.clusters.delete(id);
    return n;
  }
  async setOverride(hmac: string, label: OverrideLabel | null, now: number) {
    if (label) { this.overrideMap.set(hmac, { label, at: now }); this.memberMap.delete(hmac); } else this.overrideMap.delete(hmac);
  }
  async recordSettle(tx: string, route: string, payerHmac: string | null, now: number) {
    if (this.settles.has(tx)) return false;
    this.settles.set(tx, { route, payer_hmac: payerHmac, at: now });
    return true;
  }
  async mintKey(row: FleetKeyRow) {
    for (const k of this.keys.values()) if (k.paid_tx === row.paid_tx) return false;
    this.keys.set(row.key_hash, { ...row });
    return true;
  }
  async useCredits(keyHash: string, n: number, now: number) {
    // Single-threaded check-and-decrement: atomic within one isolate (D1 uses one conditional UPDATE).
    const k = this.keys.get(keyHash);
    if (!k || k.expires_at <= now || k.used + n > k.calls) return null;
    k.used += n;
    return { remaining: k.calls - k.used, plan: k.plan, expires_at: k.expires_at };
  }
  async key(keyHash: string) { return this.keys.get(keyHash) ?? null; }
  async purge(now: number) {
    const out = { settles: 0, members: 0, clusters: 0, keys: 0 };
    const cut = now - FLEET_GUARD.retentionDays * DAY;
    for (const [tx, s] of this.settles) if (s.at < cut) { this.settles.delete(tx); out.settles++; }
    for (const [h, m] of this.memberMap) if (m.added_at < cut) { this.memberMap.delete(h); out.members++; }
    const used = new Set([...this.memberMap.values()].map((m) => m.cluster_id));
    for (const id of this.clusters.keys()) if (!used.has(id)) { this.clusters.delete(id); out.clusters++; }
    for (const [h, k] of this.keys) if (k.expires_at < now - FLEET_GUARD.keyRetentionDays * DAY) { this.keys.delete(h); out.keys++; }
    return out;
  }
}

const changes = (r: unknown) => Number((r as { meta?: { changes?: number }; changes?: number })?.meta?.changes ?? (r as { changes?: number })?.changes ?? 0);

export class D1FleetGuardStore implements FleetGuardStore {
  constructor(private db: D1Like) {}
  private ins = (n: number) => Array(n).fill("?").join(",");
  async members(hmacs: string[]) {
    const out = new Map<string, MemberHit>();
    if (!hmacs.length) return out;
    const q = `SELECT m.subject_hmac, m.role, m.cluster_id, m.added_at FROM fleet_guard_members m JOIN fleet_guard_clusters c ON c.id = m.cluster_id WHERE m.subject_hmac IN (${this.ins(hmacs.length)})`;
    const r = await this.db.prepare(q).bind(...hmacs).all<any>();
    for (const x of r.results) out.set(x.subject_hmac, { role: x.role, cluster_id: x.cluster_id, observed_on: dayOf(Number(x.added_at)) });
    return out;
  }
  async overrides(hmacs: string[]) {
    const out = new Map<string, OverrideLabel>();
    if (!hmacs.length) return out;
    const r = await this.db.prepare(`SELECT subject_hmac, label FROM fleet_guard_overrides WHERE subject_hmac IN (${this.ins(hmacs.length)})`).bind(...hmacs).all<any>();
    for (const x of r.results) out.set(x.subject_hmac, x.label);
    return out;
  }
  async coveredKinds() {
    const r = await this.db.prepare("SELECT DISTINCT subject_kind FROM fleet_guard_members").all<any>();
    return new Set(r.results.map((x) => x.subject_kind as SubjectKind));
  }
  async upsertCluster(c: ClusterInfo, now: number) {
    await this.db.prepare("INSERT INTO fleet_guard_clusters (id, basis, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET basis = excluded.basis, updated_at = excluded.updated_at")
      .bind(c.id, c.basis, now).run();
  }
  async upsertMembers(rows: MemberRow[], now: number) {
    if (!rows.length) return 0;
    const blocked = new Set((await this.overrides([...new Set(rows.map((r) => r.subject_hmac))])).keys());
    const keep = rows.filter((r) => !blocked.has(r.subject_hmac));
    for (let i = 0; i < keep.length; i += 50) {
      await this.db.batch(keep.slice(i, i + 50).map((r) => this.db.prepare("INSERT INTO fleet_guard_members (subject_hmac, cluster_id, role, subject_kind, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(subject_hmac) DO UPDATE SET cluster_id = excluded.cluster_id, role = excluded.role, subject_kind = excluded.subject_kind, added_at = excluded.added_at").bind(r.subject_hmac, r.cluster_id, r.role, r.subject_kind, now)));
    }
    return keep.length;
  }
  async deleteMembers(hmacs: string[]) {
    let n = 0;
    for (let i = 0; i < hmacs.length; i += 50) {
      const part = hmacs.slice(i, i + 50);
      n += changes(await this.db.prepare(`DELETE FROM fleet_guard_members WHERE subject_hmac IN (${this.ins(part.length)})`).bind(...part).run());
    }
    return n;
  }
  async deleteCluster(id: string) {
    const n = changes(await this.db.prepare("DELETE FROM fleet_guard_members WHERE cluster_id = ?").bind(id).run());
    await this.db.prepare("DELETE FROM fleet_guard_clusters WHERE id = ?").bind(id).run();
    return n;
  }
  async setOverride(hmac: string, label: OverrideLabel | null, now: number) {
    if (!label) { await this.db.prepare("DELETE FROM fleet_guard_overrides WHERE subject_hmac = ?").bind(hmac).run(); return; }
    await this.db.batch([
      this.db.prepare("INSERT INTO fleet_guard_overrides (subject_hmac, label, created_at) VALUES (?, ?, ?) ON CONFLICT(subject_hmac) DO UPDATE SET label = excluded.label, created_at = excluded.created_at").bind(hmac, label, now),
      this.db.prepare("DELETE FROM fleet_guard_members WHERE subject_hmac = ?").bind(hmac),
    ]);
  }
  async recordSettle(tx: string, route: string, payerHmac: string | null, now: number) {
    const r = await this.db.prepare("INSERT INTO fleet_guard_settles (tx_hash, route, payer_hmac, settled_at) VALUES (?, ?, ?, ?) ON CONFLICT(tx_hash) DO NOTHING RETURNING tx_hash").bind(tx, route, payerHmac, now).first();
    return !!r;
  }
  async mintKey(k: FleetKeyRow) {
    const r = await this.db.prepare("INSERT INTO fleet_guard_keys (key_hash, plan, calls, used, expires_at, paid_tx, payer_hmac, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING key_hash")
      .bind(k.key_hash, k.plan, k.calls, k.expires_at, k.paid_tx, k.payer_hmac, k.created_at).first();
    return !!r;
  }
  async useCredits(keyHash: string, n: number, now: number) {
    const r = await this.db.prepare("UPDATE fleet_guard_keys SET used = used + ? WHERE key_hash = ? AND expires_at > ? AND used + ? <= calls RETURNING calls - used AS remaining, plan, expires_at")
      .bind(n, keyHash, now, n).first<any>();
    return r ? { remaining: Number(r.remaining), plan: String(r.plan), expires_at: Number(r.expires_at) } : null;
  }
  async key(keyHash: string) { return (await this.db.prepare("SELECT * FROM fleet_guard_keys WHERE key_hash = ?").bind(keyHash).first<FleetKeyRow>()) ?? null; }
  async purge(now: number) {
    const cut = now - FLEET_GUARD.retentionDays * DAY;
    const settles = changes(await this.db.prepare("DELETE FROM fleet_guard_settles WHERE settled_at < ?").bind(cut).run());
    const members = changes(await this.db.prepare("DELETE FROM fleet_guard_members WHERE added_at < ?").bind(cut).run());
    const clusters = changes(await this.db.prepare("DELETE FROM fleet_guard_clusters WHERE id NOT IN (SELECT DISTINCT cluster_id FROM fleet_guard_members)").run());
    const keys = changes(await this.db.prepare("DELETE FROM fleet_guard_keys WHERE expires_at < ?").bind(now - FLEET_GUARD.keyRetentionDays * DAY).run());
    return { settles, members, clusters, keys };
  }
}

export const purgeFleetGuard = (store: FleetGuardStore, now: number) => store.purge(now);
/** Sales routes written by the fleet guard (sales.route): purged on the same 90-day clock. */
export const FLEET_SALES_ROUTES = ["fleet_check", "fleet_pack", "fleet_monthly"] as const;

// ---------------------------------------------------------------- answer cache (per isolate)

export class AnswerCache {
  private m = new Map<string, { at: number; v: Answer }>();
  constructor(private ttlMs = FLEET_GUARD.cacheTtlSec * 1000, private max = 20_000) {}
  /** key = `${version}:${HMAC(normalized subject)}` — never payer data. */
  get(key: string, now: number): { v: Answer; at: number } | null {
    const e = this.m.get(key);
    if (!e) return null;
    if (now - e.at >= this.ttlMs) { this.m.delete(key); return null; }
    return e;
  }
  set(key: string, v: Answer, now: number) {
    if (this.m.size >= this.max) { const first = this.m.keys().next().value; if (first !== undefined) this.m.delete(first); }
    this.m.set(key, { at: now, v });
  }
  get size() { return this.m.size; }
}

/** Cached per subject hash (no subject, no payer data). Rendered into a label per response. */
export interface Answer {
  subject_kind: SubjectKind;
  status: "match" | "no_match" | "insufficient_data";
  role: "payer" | "seller" | null;
  cluster_id: string | null;
  observed_on: string | null;
}

/** The only label values (Quill, 2026-11-19). No confidence score is computed, so none is shown. */
export const LABEL_NO_MATCH = "No match";
export const LABEL_INSUFFICIENT = "Insufficient data";
export const matchLabel = (asOf: string, methodUrl: string) => `Pattern match: automated cluster, as of ${asOf}, method ${methodUrl}`;
export const FLEET_DISCLAIMER =
  "Dated statistical pattern observation of public-ledger payments under Lumi's published method, as of the date shown. Not a finding of intent or wrongdoing. Not OFAC, sanctions, AML or KYC screening and not a substitute for it. Not a consumer report; Lumi is not a consumer reporting agency. False matches and missed matches occur, and absence of a match is not a clearance. Provided as is, with no warranty of any kind. Do not display this result as current after valid_until.";
export const FLEET_USE_RESTRICTION =
  "FCRA: you may not use this result, in whole or in part, as a factor in deciding any individual's eligibility for credit, insurance, employment, housing or tenancy, a government benefit, or any other purpose listed in 15 U.S.C. 1681b, and you may not represent that others may do so. Pass this restriction on to anyone you let see the result.";
export const FLEET_DISPUTES = "To dispute or correct a label, or to ask Lumi to exclude an address that is yours, email hello@lumitrades.io with the address and network. Lumi can only find a hashed record if you give the address.";
export const FLEET_PRICE_TEXT = "0.0005 USD per call (each subject checked is one call; a batch of n subjects costs n x 0.0005 USD).";
export const FLEET_PACK_TEXT = "$4 pack of 10,000 calls, lasts 365 days, no auto-renew.";

// ---------------------------------------------------------------- service

export interface FleetGuardEnv {
  FLEET_GUARD?: string;
  /** Current HMAC secret (subjects, payers, IPs). */
  FLEET_GUARD_HMAC_SECRET?: string;
  /** Previous HMAC secret during a rotation: still matched for lookups, overrides and deletions, never written. */
  FLEET_GUARD_HMAC_SECRET_PREV?: string;
  FLEET_GUARD_KEY_SECRET?: string;
  FLEET_GUARD_MONTHLY?: string;
}
/** Exactly "on" (config.ts contract); "On ", "ON", "true" stay off. */
export const fleetGuardOn = (env: FleetGuardEnv) => env.FLEET_GUARD === "on";

export interface FleetGuardDeps {
  cfg: Config;
  env: FleetGuardEnv;
  store: FleetGuardStore;
  counter: QuotaCounter;
  paywall: (ctx?: { waitUntil(p: Promise<unknown>): void }) => PaywallDeps;
  isOwner: (request: Request) => Promise<boolean>;
  now?: () => number;
  log?: (e: Record<string, unknown>) => void;
  cache?: AnswerCache;
  /** Sales ledger: fleet-guard rows are purged on the 90-day clock. */
  sales?: { purgeRoutes?(routes: readonly string[], beforeMs: number): Promise<number> };
}

type Plan = { id: string; usd: string; calls: number; days: number };

export function createFleetGuard(d: FleetGuardDeps) {
  const now = d.now ?? Date.now;
  const log = (e: Record<string, unknown>) => d.log?.({ ...e, svc: "fleet_guard" });
  const alert = (kind: string, extra: Record<string, unknown> = {}) => log({ event: "fleet_guard_alert", kind, ...extra });
  const cache = d.cache ?? new AnswerCache();
  const secret = () => (d.env.FLEET_GUARD_HMAC_SECRET ?? "").trim();
  const monthlyOn = () => d.env.FLEET_GUARD_MONTHLY === "on";
  const prevSecret = () => {
    const p = (d.env.FLEET_GUARD_HMAC_SECRET_PREV ?? "").trim();
    return p.length >= 32 && p !== secret() ? p : "";
  };
  const subjMsg = (s: Subject) => `fg-subj:${s.kind === "domain" ? "d" : "a"}:${s.norm}`;
  /** [current, previous?]: writes use the current hash; lookups, overrides and deletions match both (rotation). */
  const subjHmacs = async (s: Subject) => {
    const out = [await hmacHex(secret(), subjMsg(s))];
    if (prevSecret()) out.push(await hmacHex(prevSecret(), subjMsg(s)));
    return out;
  };
  const subjHmac = (s: Subject) => hmacHex(secret(), subjMsg(s));
  let kindsCache: { at: number; v: Set<SubjectKind> } | null = null;
  async function coveredKinds(): Promise<Set<SubjectKind>> {
    if (kindsCache && now() - kindsCache.at < 600_000) return kindsCache.v;
    const v = await d.store.coveredKinds();
    kindsCache = { at: now(), v };
    return v;
  }
  const methodUrl = (base: string) => `${base}/v1/fleet/methodology`;
  const legal = (base: string) => ({ method_url: methodUrl(base), disclaimer: FLEET_DISCLAIMER, use_restriction: FLEET_USE_RESTRICTION, disputes: FLEET_DISPUTES });
  const payerHmac = async (p?: string | null) => (p ? hmacHex(secret(), `fg-payer:${/^0x/i.test(p) ? p.toLowerCase() : p}`) : null);
  const ipHmac = async (r: Request) => hmacHex(secret(), `fg-ip:${ipBucket(r.headers.get("CF-Connecting-IP"))}`);
  /**
   * Pack/plan keys are derived, never stored (Vigil MED-2): HMAC(secret, plan + settled tx hash). Lumi keeps only the
   * key's SHA-256; an idempotent retry recomputes the key from the tx hash in the cached PAYMENT-RESPONSE.
   */
  // Separate secret for key derivation (Vigil 2026-11-19): leaking the payer/subject HMAC secret must not reveal pack keys.
  // Missing, short or equal to FLEET_GUARD_HMAC_SECRET = packs and plans are not offered (503, nothing quoted or charged).
  const keySecret = () => {
    const k = (d.env.FLEET_GUARD_KEY_SECRET ?? "").trim();
    return k.length >= 32 && k !== secret() ? k : "";
  };
  const deriveKey = async (planId: string, tx: string) => {
    const k = keySecret();
    if (!k) throw new Error("fleet_guard_key_secret_missing");
    return "fgk_" + (await hmacHex(k, `fg-key:${planId}:${tx}`)).slice(0, 40);
  };
  const KEY_SENTINEL = "derived_from_tx";
  /** Wraps the shared idempotency store: fleet key responses are stored without the key and rehydrated on replay. */
  function fleetIdempotency(base: IdempotencyStore): IdempotencyStore {
    return {
      async put(rec: IdempotencyRecord) {
        let body = rec.body;
        try {
          const j = JSON.parse(body);
          if (j && j.kind === "lumi_fleet_key") { j.key = KEY_SENTINEL; body = JSON.stringify(j); }
        } catch { /* not JSON: stored as is unless it carries a key */ }
        if (/fgk_[0-9a-f]{40}/.test(body)) return; // never store a plaintext key
        await base.put({ ...rec, body });
      },
      async get(keyHash: string, t: number) {
        const r = await base.get(keyHash, t);
        if (!r) return null;
        let j: any;
        try { j = JSON.parse(r.body); } catch { return r; }
        if (!j || j.kind !== "lumi_fleet_key") return r;
        let tx = "";
        try { tx = String(JSON.parse(b64decodeUtf8(r.headers[HEADER_PAYMENT_RESPONSE] ?? "")).transaction ?? ""); } catch { /* below */ }
        if (!tx || typeof j.plan !== "string" || !keySecret()) { alert("idempotent_key_unrecoverable", { route: j.plan }); return null; }
        j.key = await deriveKey(j.plan, tx);
        return { ...r, body: JSON.stringify(j, null, 2) };
      },
    };
  }

  /** Reuses the InvoiceGuard DO quota objects ("quota-0".."quota-15"); keys are fleet-guard prefixed hashes only. */
  const obj = (hex: string) => `quota-${parseInt(hex.slice(0, 2), 16) % 16}`;
  async function take(object: string, keys: QuotaKey[], failClosed: boolean): Promise<boolean> {
    try {
      return (await d.counter.take(object, keys)).allowed;
    } catch (e) {
      log({ event: "fleet_guard_counter_error", failClosed, error: String(e).slice(0, 120) });
      return !failClosed;
    }
  }
  const minuteEnd = () => Math.floor(now() / 60_000) * 60_000 + 60_000;
  const dayEnd = () => Math.floor(now() / DAY) * DAY + DAY;
  const rateLimited = () => json(429, { error: "rate_limited", retry_after_s: 60, note: "Not charged." }, { ...NO_STORE, "Retry-After": "60" });

  /**
   * Prepaid-key access (Vigil MED-3, re-check, and 2026-11-19 order fix). Order, cheapest first:
   *   1. a key hash this isolate saw valid in the last 10 minutes: per-key limit only (FLEET_GUARD.keyPerMinute), so a
   *      shared NAT, /64 or "unknown" bucket cannot lock out a paying customer here;
   *   2. this network's failed-key lockout (isolate memory, no counter call) -> 429;
   *   3. this network's FLEET_GUARD.keyIpPerMinute limit -> 429;
   *   4. only then the shared quota-DO "recently valid" marker (one counter call); valid -> per-key limit.
   * A flood of made-up keys therefore never reaches the shared counter more than keyIpPerMinute times a minute per network.
   * Tradeoff: on a locked or over-limit network, a valid key not yet seen by this isolate waits out the lockout there.
   * Counter outage: fail-open (paid keys keep working); the failed-key block is also remembered in this isolate.
   */
  const failBlocked = new Map<string, number>();
  const validKeys = new Map<string, number>();
  const tenMinEnd = () => Math.floor(now() / 600_000) * 600_000 + 600_000;
  const KEY_RE = /^fgk_[0-9a-f]{40}$/;
  function isolateValid(kh: string): boolean {
    const until = validKeys.get(kh);
    if (until === undefined) return false;
    if (until > now()) return true;
    validKeys.delete(kh);
    return false;
  }
  async function markedValid(kh: string): Promise<boolean> {
    try {
      // max 0 never increments: a read of the marker count.
      const r = await d.counter.take(obj(kh), [{ key: `fg-kv:${kh}`, max: 0, resetAt: dayEnd() + DAY }]);
      if ((r.counts[0] ?? 0) > 0) { validKeys.set(kh, now() + 600_000); return true; }
    } catch { /* treated as unknown: the store lookup still serves valid keys */ }
    return false;
  }
  async function markValid(kh: string) {
    if (validKeys.size > 20_000) validKeys.clear();
    validKeys.set(kh, now() + 600_000);
    await take(obj(kh), [{ key: `fg-kv:${kh}`, max: 1_000_000_000, resetAt: dayEnd() + DAY }], false);
  }
  type KeyAccess = { deny: Response } | { deny?: undefined; ip: string; kh: string; known: boolean };
  async function keyAccess(request: Request, keyRaw: string, badFormat: () => Response): Promise<KeyAccess> {
    const ip = await ipHmac(request);
    const kh = KEY_RE.test(keyRaw) ? await sha256Hex(keyRaw) : null;
    const perKey = async (h: string): Promise<KeyAccess> => {
      if (!(await take(obj(h), [{ key: `fg-k:${h}`, max: FLEET_GUARD.keyPerMinute, resetAt: minuteEnd() }], false))) return { deny: rateLimited() };
      // Sliding expiry: a key in continuous use stays "recently valid" in this isolate, so a lockout tripped on its
      // network later never catches it.
      validKeys.set(h, now() + 600_000);
      return { ip, kh: h, known: true };
    };
    if (kh && isolateValid(kh)) return perKey(kh);
    const until = failBlocked.get(ip);
    if (until !== undefined) { if (until > now()) return { deny: failLimited() }; failBlocked.delete(ip); }
    if (!(await take(obj(ip), [{ key: `fg-ki:${ip}`, max: FLEET_GUARD.keyIpPerMinute, resetAt: minuteEnd() }], false))) return { deny: rateLimited() };
    if (!kh) return { deny: (await keyFailed(ip)) ?? badFormat() };
    if (await markedValid(kh)) return perKey(kh);
    return { ip, kh, known: false };
  }
  const failLimited = () => json(429, { error: "too_many_invalid_keys", retry_after_s: 600, note: "Not charged." }, { ...NO_STORE, "Retry-After": "600" });
  /** Counts one failed key for this network; returns a 429 once over the limit (and blocks further unknown-key lookups). */
  async function keyFailed(ip: string): Promise<Response | null> {
    const ok = await take(obj(ip), [{ key: `fg-kf:${ip}`, max: FLEET_GUARD.keyFailPer10Min, resetAt: tenMinEnd() }], false);
    if (ok) return null;
    if (failBlocked.size > 10_000) failBlocked.clear();
    failBlocked.set(ip, tenMinEnd());
    log({ event: "fleet_guard_key_fail_limited" });
    return failLimited();
  }

  /**
   * Overrides (owner corrections) are read on every call, so a correction applies at once in every isolate; memberships
   * are cached per isolate for an hour. Only the label for the submitted subject is returned: never other members, no
   * counts, no first-seen date.
   */
  async function answers(subjects: Subject[]): Promise<{ results: Answer[]; cacheHits: number }> {
    const t = now();
    const hs = await Promise.all(subjects.map(subjHmacs));
    const ov = await d.store.overrides([...new Set(hs.flat())]);
    // An override found only under the previous secret's hash is re-keyed under the current hash (h[0], computed from the
    // subject in hand), so it survives removing FLEET_GUARD_HMAC_SECRET_PREV.
    for (const h of hs) {
      const cur = ov.get(h[0]);
      const prev = h[1] ? ov.get(h[1]) : undefined;
      if (!cur && prev) {
        ov.set(h[0], prev);
        await d.store.setOverride(h[0], prev, t).catch((e) => log({ event: "fleet_guard_override_rekey_error", error: String(e).slice(0, 120) }));
      }
    }
    const out: (Answer | null)[] = hs.map((h, i) => {
      const o = h.map((x) => ov.get(x)).find(Boolean);
      return o ? { subject_kind: subjects[i].kind, status: o === LABEL_NO_MATCH ? "no_match" : "insufficient_data", role: null, cluster_id: null, observed_on: null } : null;
    });
    let cacheHits = 0;
    hs.forEach((h, i) => {
      if (out[i]) return;
      const c = cache.get(`${FLEET_GUARD.version}:${h[0]}`, t)?.v;
      if (c) { out[i] = c; cacheHits++; }
    });
    const missIdx = out.map((a, i) => (a ? -1 : i)).filter((i) => i >= 0);
    if (missIdx.length) {
      const found = await d.store.members([...new Set(missIdx.flatMap((i) => hs[i]))]);
      const kinds = await coveredKinds();
      for (const i of missIdx) {
        const m = hs[i].map((x) => found.get(x)).find(Boolean);
        const a: Answer = m
          ? { subject_kind: subjects[i].kind, status: "match", role: m.role, cluster_id: m.cluster_id, observed_on: m.observed_on }
          : { subject_kind: subjects[i].kind, status: kinds.has(subjects[i].kind) ? "no_match" : "insufficient_data", role: null, cluster_id: null, observed_on: null };
        // Only non-matches are cached: a match is re-read every call, so an owner deletion or correction is never served
        // stale from another isolate's cache.
        if (a.status !== "match") cache.set(`${FLEET_GUARD.version}:${hs[i][0]}`, a, t);
        out[i] = a;
      }
    }
    return { results: out as Answer[], cacheHits };
  }

  function render(a: Answer, index: number, base: string) {
    const label = a.status === "match" ? matchLabel(a.observed_on ?? "unknown", methodUrl(base)) : a.status === "no_match" ? LABEL_NO_MATCH : LABEL_INSUFFICIENT;
    // No cluster id in responses (Quill 7): two answers sharing an id would tell a caller which identifiers sit together.
    return { index, subject_kind: a.subject_kind, label, match: a.status === "match" ? true : a.status === "no_match" ? false : null, role: a.role, as_of: a.observed_on };
  }

  async function body(subjects: Subject[], access: Record<string, unknown>, base: string) {
    const { results, cacheHits } = await answers(subjects);
    const t = now();
    return {
      kind: "lumi_fleet_check",
      version: FLEET_GUARD.version,
      as_of: new Date(t).toISOString(),
      valid_until: new Date(t + FLEET_GUARD.cacheTtlSec * 1000).toISOString(),
      count: results.length,
      results: results.map((a, i) => render(a, i, base)),
      cache: { ttl_s: FLEET_GUARD.cacheTtlSec, hits: cacheHits, note: "Cache once per subject per hour; repeat calls inside valid_until are not needed." },
      access,
      method: "Statistical pattern match of public-ledger payment events against Lumi's automated-cluster method. See method_url.",
      ...legal(base),
    };
  }

  function quoteFor(route: string, usd: string, resourceUrl: string, description: string): Quote {
    const cfg = d.cfg;
    const rate = cfg.xrpRate?.usd ?? cfg.xrpUsdFallback;
    const atomic6 = String(Math.round(Number(usd) * 1e6));
    const atomic7 = String(Math.round(Number(usd) * 1e7));
    return {
      routeKey: route,
      amountDrops: usdToDrops(usd, rate),
      liveDrops: true,
      xrpUsd: rate,
      amountsIou: Object.fromEntries(cfg.ious.map((o) => [o.symbol, usd])),
      amountEvm: cfg.evm ? atomic6 : undefined,
      amountStellar: cfg.stellar ? atomic7 : undefined,
      description,
      resourceUrl,
      bazaar: { info: { input: { type: "http", method: "GET" }, output: { type: "json" } } },
      service: { serviceName: "Lumi fleet guard", tags: ["x402", "trust", "fleet"] },
    };
  }

  /** Defence in depth: the settled requirement must be at least the floor for its asset (server-set amounts make this hold). */
  function amountOk(paid: PaymentRequirements, minUsd: number, quote: Quote): boolean {
    const a = String(paid.amount);
    if (isEvmRequirement(paid)) return BigInt(a) >= BigInt(Math.round(minUsd * 1e6));
    if (isStellarRequirement(paid)) return BigInt(a) >= BigInt(Math.round(minUsd * 1e7));
    // XRP: the paid drops were fixed by the (MAC-checked) invoice at quote time and the live rate can move before the
    // payment lands, so the floor is the price at a rate 25% above today's (a fall of up to 20% is never "underpaid").
    if (paid.asset === "XRP") {
      const rate = d.cfg.xrpRate?.usd ?? d.cfg.xrpUsdFallback;
      return BigInt(a) > 0n && BigInt(a) >= BigInt(usdToDrops(String(minUsd), rate * 1.25));
    }
    return Number(a) + 1e-12 >= minUsd;
  }

  /** Privacy wrap of the shared paywall: no raw payer in logs, sales rows or the PAYMENT-RESPONSE header. */
  function privateDeps(ctx?: { waitUntil(p: Promise<unknown>): void }): PaywallDeps {
    const base = d.paywall(ctx);
    return {
      ...base,
      // Idempotent replays must present the exact same signed payment, and never get a stored plaintext key (MED-2).
      idempotency: base.idempotency ? fleetIdempotency(base.idempotency) : undefined,
      log: (e) => {
        const rest = redactLogEvent(e as Record<string, unknown>);
        base.log?.(rest);
        if (typeof rest.event === "string" && /settle_failed|settlement_unknown|invoice_already_used/.test(String(rest.error ?? rest.event))) alert("settle_problem", { route: rest.route });
      },
      onSale: base.onSale ? async (sale) => base.onSale!({ ...sale, payer: (await payerHmac(sale.payer)) ?? undefined }) : undefined,
    };
  }

  async function paid(request: Request, ctx: { waitUntil(p: Promise<unknown>): void } | undefined, quote: Quote, minUsd: number, serve: (s: Settlement, payerH: string | null) => Promise<Response>): Promise<Response> {
    const r = await requirePayment(request, d.cfg, privateDeps(ctx), quote, async (s, req) => {
      const ph = await payerHmac(s.payer);
      if (!amountOk(req, minUsd, quote)) {
        alert("underpaid", { route: quote.routeKey.split(":")[0], tx: s.transaction });
        // 409, not 402: the payment settled, so a 402 would invite the client to pay again (Vigil LOW-2).
        return json(409, { error: "amount_below_minimum", tx: s.transaction, note: "Settled amount below the server price. Do not pay again; contact Lumi with this tx hash." }, NO_STORE);
      }
      // Paid and settled: serve even if the settle record cannot be written (the payer must not lose the answer), but alert
      // (Vigil LOW-1). Pack keys stay one-per-tx through mintKey; the replay guard already claimed the invoice.
      const first = await d.store.recordSettle(s.transaction, quote.routeKey.split(":")[0], ph, now()).catch((e) => {
        log({ event: "fleet_guard_store_error", phase: "settle_record", error: String(e).slice(0, 120) });
        alert("settle_record_failed", { route: quote.routeKey.split(":")[0], tx: s.transaction });
        return true;
      });
      if (!first) {
        alert("replay", { route: quote.routeKey.split(":")[0], tx: s.transaction });
        return json(409, { error: "payment_already_used", detail: "This settled transaction already paid for a fleet-guard answer." }, NO_STORE);
      }
      log({ event: "fleet_guard_paid", route: quote.routeKey.split(":")[0], tx: s.transaction, payer_hmac: ph?.slice(0, 16) ?? null });
      return serve(s, ph);
    });
    // Re-encode PAYMENT-RESPONSE without the payer address (the facilitator's own header may carry it).
    const pr = r.headers.get(HEADER_PAYMENT_RESPONSE);
    if (pr) {
      const out = new Response(r.body, r);
      try {
        const j = JSON.parse(atob(pr));
        out.headers.set(HEADER_PAYMENT_RESPONSE, encodeHeader({ success: j.success, transaction: j.transaction, network: j.network }));
      } catch {
        out.headers.delete(HEADER_PAYMENT_RESPONSE);
      }
      return out;
    }
    return r;
  }

  const hasPayment = (r: Request) => !!(r.headers.get(HEADER_PAYMENT_SIGNATURE) || r.headers.get(HEADER_X_PAYMENT));

  async function check(request: Request, url: URL, base: string, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const keyRaw = request.headers.get(FLEET_KEY_HEADER)?.trim();
    const parsed = parseQuery(url);
    if (!parsed.ok) return json(400, parsed.error, NO_STORE);
    const n = parsed.subjects.length;

    // Prepaid key: access gate (per key if recently valid, else per network), one atomic decrement of n credits, serve.
    if (keyRaw && !hasPayment(request)) {
      const a = await keyAccess(request, keyRaw, () => json(401, { error: "invalid_fleet_key", note: "Not charged." }, NO_STORE));
      if (a.deny) return a.deny;
      const used = await d.store.useCredits(a.kh, n, now());
      if (!used) {
        // Unknown, expired or exhausted: an exhausted real key is not a guess, but the store cannot tell them apart cheaply.
        if (!a.known) {
          if (await d.store.key(a.kh)) await markValid(a.kh);
          else { const lim = await keyFailed(a.ip); if (lim) return lim; }
        }
        return json(402, { error: "fleet_key_exhausted_or_expired", buy_pack: `${base}/v1/fleet/pack`, note: "Not charged." }, NO_STORE);
      }
      if (!a.known) await markValid(a.kh);
      return json(200, await body(parsed.subjects, { mode: "prepaid", plan: used.plan, credits_used: n, credits_remaining: used.remaining, key_expires_at: new Date(used.expires_at).toISOString() }, base), NO_STORE);
    }

    // x402: bounded rate limit per hashed IP before anything else; no lookup until the payment has settled.
    const ip = await ipHmac(request);
    if (!(await take(obj(ip), [{ key: `fg-p:${ip}`, max: FLEET_GUARD.paidPerMinute, resetAt: minuteEnd() }], false))) return rateLimited();
    const usd = checkPriceUsd(n);
    // The invoice binds this URL. It never echoes a subject (Quill 2026-11-19): always a keyed hash of the normalized query
    // (HMAC, so an address cannot be confirmed by hashing candidates), recomputed on the paid retry.
    const resourceUrl = `${base}/v1/fleet/check?n=${n}&qh=${(await hmacHex(secret(), `fg-qh:${FLEET_GUARD.version}|${parsed.canonical}`)).slice(0, 32)}`;
    const quote = quoteFor(`fleet_check:n${n}`, usd, resourceUrl, `Lumi wallet pattern check: dated pattern-match label for ${n} identifier(s), ${FLEET_GUARD.priceUsd} USD per call, cache 1h.`);
    if (!hasPayment(request)) {
      return paymentRequiredResponse(d.cfg, quote, "PAYMENT-SIGNATURE header is required", {
        pack: { url: `${base}/v1/fleet/pack`, usd: FLEET_GUARD.pack.usd, calls: FLEET_GUARD.pack.calls },
        free: `${base}/v1/fleet/check/free?subject=<one subject>`,
      });
    }
    return paid(request, ctx, quote, FLEET_GUARD.minUsd * n, async () => json(200, await body(parsed.subjects, { mode: "x402", charged: true, price_usd: usd }, base), NO_STORE));
  }

  async function freeCheck(request: Request, url: URL, base: string): Promise<Response> {
    const parsed = parseQuery(url, 1);
    if (!parsed.ok) return json(400, parsed.error, NO_STORE);
    const ip = await ipHmac(request);
    let wallet = "";
    for (const h of WALLET_HEADERS) { wallet = request.headers.get(h)?.trim() ?? ""; if (wallet) break; }
    const wh = wallet ? await payerHmac(wallet.slice(0, 128)) : null;
    const keys: QuotaKey[] = [
      { key: `fg-fm:${ip}`, max: FLEET_GUARD.free.perIpMinute, resetAt: minuteEnd() },
      { key: `fg-fd:${ip}`, max: FLEET_GUARD.free.perIpDay, resetAt: dayEnd() },
    ];
    // Fail-closed: if the counter is down, free checks stop (paid and prepaid keep working).
    if (!(await take(obj(ip), keys, true))) return json(429, { error: "free_cap_reached", detail: `Free fleet checks are capped at ${FLEET_GUARD.free.perIpDay}/day per network and per wallet.`, paid: `${base}/v1/fleet/check?subject=...`, pack: `${base}/v1/fleet/pack`, note: "Not charged." }, { ...NO_STORE, "Retry-After": "3600" });
    if (wh && !(await take(obj(wh), [{ key: `fg-fw2:${wh}`, max: FLEET_GUARD.free.perWalletDay, resetAt: dayEnd() }], true))) return json(429, { error: "free_cap_reached", note: "Not charged." }, NO_STORE);
    if (!(await take("quota-0", [{ key: "fg-fg", max: FLEET_GUARD.free.globalDay, resetAt: dayEnd() }], true))) return json(429, { error: "free_cap_reached", detail: "Today's free fleet checks are used up.", note: "Not charged." }, NO_STORE);
    return json(200, await body(parsed.subjects, { mode: "free", charged: false }, base), NO_STORE);
  }

  async function buy(request: Request, base: string, plan: Plan, path: string, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    if (!keySecret()) return json(503, { error: "fleet_keys_not_configured", detail: "Packs and plans are not on sale right now; per-call checks still work.", note: "Not charged." }, NO_STORE);
    const ip = await ipHmac(request);
    if (!(await take(obj(ip), [{ key: `fg-b:${ip}`, max: 30, resetAt: minuteEnd() }], false))) return rateLimited();
    const quote = quoteFor(plan.id, plan.usd, `${base}${path}`, `Lumi wallet pattern check ${plan.id === FLEET_GUARD.pack.id ? "pack" : "30-day plan"}: ${plan.calls.toLocaleString("en-US")} calls, lasts ${plan.days} days, no auto-renew.`);
    if (!hasPayment(request)) return paymentRequiredResponse(d.cfg, quote, "PAYMENT-SIGNATURE header is required", { idempotency: "Send Idempotency-Key with the paid retry; a repeat with the same key and payment returns the same key." });
    return paid(request, ctx, quote, Number(plan.usd), async (s, ph) => {
      const raw = await deriveKey(plan.id, s.transaction);
      const t = now();
      const row: FleetKeyRow = { key_hash: await sha256Hex(raw), plan: plan.id, calls: plan.calls, used: 0, expires_at: t + plan.days * DAY, paid_tx: s.transaction, payer_hmac: ph, created_at: t };
      const minted = await d.store.mintKey(row);
      if (!minted) {
        alert("replay", { route: plan.id, tx: s.transaction });
        return json(409, { error: "payment_already_used", detail: "This settled transaction already minted a key." }, NO_STORE);
      }
      await markValid(row.key_hash);
      return json(200, {
        kind: "lumi_fleet_key", plan: plan.id, key: raw, header: FLEET_KEY_HEADER, calls: plan.calls, expires_at: new Date(row.expires_at).toISOString(), auto_renew: false,
        note: "Lumi stores only its SHA-256. A retry with the same Idempotency-Key and the same signed payment returns it again within 24 hours. One credit per subject; send it as the header on /v1/fleet/check.",
        ...legal(base),
      }, NO_STORE);
    });
  }

  async function readJson(request: Request): Promise<{ ok: true; b: any } | { ok: false; r: Response }> {
    const text = await request.text().catch(() => "");
    if (text.length > 600_000) return { ok: false, r: json(413, { error: "body_too_large" }, NO_STORE) };
    try { return { ok: true, b: JSON.parse(text) }; } catch { return { ok: false, r: json(400, { error: "invalid_json" }, NO_STORE) }; }
  }

  /**
   * Owner-only admin (works while FLEET_GUARD is off, so members can be loaded before launch):
   *   POST   /v1/fleet/admin/members  {cluster:{id, basis?}, subjects:[{value, role}]}  load or reconfirm (resets the 90-day clock)
   *   DELETE /v1/fleet/admin/members  {subjects:[value,...]} | {cluster:"F1"}           delete memberships (current + previous HMAC)
   *   POST   /v1/fleet/admin/override {subject, label:"No match"|"Insufficient data"|null} dispute/exclusion: applies at once
   * Raw values are HMACed in memory and never stored or logged.
   */
  async function admin(request: Request, path: string): Promise<Response> {
    if (!(await d.isOwner(request))) return json(401, { error: "owner_only" }, NO_STORE);
    const j = await readJson(request);
    if (!j.ok) return j.r;
    const b = j.b;
    const t = now();
    if (path === "/v1/fleet/admin/override" && request.method === "POST") {
      const n = typeof b?.subject === "string" ? normalizeSubject(b.subject) : null;
      if (!n) return json(400, { error: "subject must be a supported address, domain or URL" }, NO_STORE);
      const label = b.label === null ? null : (OVERRIDE_LABELS as readonly unknown[]).includes(b.label) ? (b.label as OverrideLabel) : undefined;
      if (label === undefined) return json(400, { error: `label must be one of ${OVERRIDE_LABELS.map((x) => JSON.stringify(x)).join(", ")} or null (clear)` }, NO_STORE);
      for (const h of await subjHmacs(n)) await d.store.setOverride(h, label, t);
      log({ event: "fleet_guard_override", action: label ? "set" : "cleared", label });
      return json(200, { ok: true, label, applies: "immediately, every isolate (read on each call)", stored: "hmac_only" }, NO_STORE);
    }
    if (path !== "/v1/fleet/admin/members") return json(404, { error: "not_found" }, NO_STORE);
    if (request.method === "DELETE") {
      if (typeof b?.cluster === "string") {
        if (!/^F\d{1,4}$/.test(b.cluster)) return json(400, { error: "cluster must look like F1" }, NO_STORE);
        const removed = await d.store.deleteCluster(b.cluster);
        kindsCache = null;
        log({ event: "fleet_guard_members_deleted", cluster: b.cluster, count: removed });
        return json(200, { ok: true, cluster: b.cluster, removed, applies: "next call (matches are never cached)" }, NO_STORE);
      }
      const vals = Array.isArray(b?.subjects) ? b.subjects : [];
      if (!vals.length || vals.length > FLEET_GUARD.adminMaxMembers) return json(400, { error: `1 to ${FLEET_GUARD.adminMaxMembers} subjects` }, NO_STORE);
      const hs: string[] = [];
      for (const v of vals) {
        const n = typeof v === "string" ? normalizeSubject(v) : typeof v?.value === "string" ? normalizeSubject(v.value) : null;
        if (!n) return json(400, { error: "each subject must be a supported address, domain or URL" }, NO_STORE);
        hs.push(...(await subjHmacs(n)));
      }
      const removed = await d.store.deleteMembers([...new Set(hs)]);
      kindsCache = null;
      log({ event: "fleet_guard_members_deleted", count: removed });
      return json(200, { ok: true, removed, applies: "next call (matches are never cached)" }, NO_STORE);
    }
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { ...NO_STORE, Allow: "POST, DELETE" });
    const c = b?.cluster;
    if (!c || typeof c.id !== "string" || !/^F\d{1,4}$/.test(c.id)) return json(400, { error: "cluster.id must look like F1" }, NO_STORE);
    const subs = Array.isArray(b.subjects) ? b.subjects : [];
    if (!subs.length || subs.length > FLEET_GUARD.adminMaxMembers) return json(400, { error: `1 to ${FLEET_GUARD.adminMaxMembers} subjects` }, NO_STORE);
    const rows: MemberRow[] = [];
    for (const x of subs) {
      const n = typeof x?.value === "string" ? normalizeSubject(x.value) : null;
      if (!n || (x.role !== "payer" && x.role !== "seller")) return json(400, { error: "each subject needs value and role payer|seller" }, NO_STORE);
      rows.push({ subject_hmac: await subjHmac(n), cluster_id: c.id, role: x.role, subject_kind: n.kind });
    }
    await d.store.upsertCluster({ id: c.id, basis: String(c.basis ?? "funding path + payer overlap").slice(0, 200) }, t);
    const count = await d.store.upsertMembers(rows, t);
    kindsCache = null;
    log({ event: "fleet_guard_members_loaded", cluster: c.id, count, skipped_overridden: rows.length - count });
    return json(200, { ok: true, cluster: c.id, members: count, skipped_overridden: rows.length - count, stored: "hmac_only", retention_days: FLEET_GUARD.retentionDays }, NO_STORE);
  }

  function methodology(base: string) {
    return {
      kind: "lumi_fleet_methodology", version: FLEET_GUARD.version, url: methodUrl(base),
      what: "A dated statistical pattern label for one submitted identifier (wallet address, seller domain or URL): whether, under this method, it matches an automated payment-pattern cluster Lumi observed on public ledgers.",
      method: [
        "Lumi groups public-ledger payment events to x402 sellers it tracks (excluding Lumi's own published test-buy wallets) by funding path and payer overlap across sellers. A group whose timing and funding pattern is consistent with automation is recorded as a cluster with an opaque id.",
        "Each cluster membership is stored only as a keyed hash (HMAC-SHA256) of the normalized identifier, with a role (payer or seller) and the date it was last loaded or reconfirmed. The as-of date in a match label is that date.",
        "A membership is deleted after 90 days unless it is reconfirmed. Owner corrections (disputes, exclusions) win over any membership and apply on the next call.",
      ],
      labels: { match: matchLabel("<date>", methodUrl(base)), no_match: LABEL_NO_MATCH, insufficient_data: LABEL_INSUFFICIENT },
      label_rules: "\"No match\" means no recorded membership for an identifier type Lumi has clusters for; \"Insufficient data\" means Lumi has no clusters for that identifier type, or the label was corrected. No confidence score is computed. Responses never list other cluster members, carry no cluster id, counts or first-seen dates.",
      limits: "Pattern observation, not a finding of intent or wrongdoing. False and missed matches occur. Absence of a match is not a clearance.",
      price: FLEET_PRICE_TEXT,
      pack: keySecret() ? FLEET_PACK_TEXT : undefined,
      retention: {
        memberships_hmac: "90 days from the last load or reconfirmation, then deleted",
        settled_payments: "90 days (transaction hash, route, hashed payer, time), then deleted; transaction hashes are public on-chain, so this is pseudonymous, not anonymous",
        sales_ledger_rows: "90 days for this product, then deleted",
        prepaid_keys: "SHA-256 of the key only; deleted 30 days after the key expires",
        idempotent_retries: "24 hours, without the payer address",
        overrides: "kept as the record of the correction or exclusion (hash only)",
      },
      ...legal(base),
    };
  }

  function doc(base: string) {
    return {
      kind: "lumi_fleet_guard", version: FLEET_GUARD.version,
      summary: "Wallet pattern check: a dated label saying whether a payer or seller identifier matches an automated payment-pattern cluster under Lumi's method. Cache the answer for an hour.",
      labels: [matchLabel("<date>", methodUrl(base)), LABEL_NO_MATCH, LABEL_INSUFFICIENT],
      price: FLEET_PRICE_TEXT,
      check: { url: `${base}/v1/fleet/check?subject=<address, domain or URL>[,...]`, price_usd_per_call: FLEET_GUARD.priceUsd, batch_max: FLEET_GUARD.batchMax, cache_ttl_s: FLEET_GUARD.cacheTtlSec },
      free: { url: `${base}/v1/fleet/check/free?subject=<one subject>`, cap: `${FLEET_GUARD.free.perIpDay}/day per network and per wallet header, ${FLEET_GUARD.free.perIpMinute}/min` },
      ...(keySecret() ? { pack: { url: `${base}/v1/fleet/pack`, usd: FLEET_GUARD.pack.usd, calls: FLEET_GUARD.pack.calls, valid_days: FLEET_GUARD.pack.days, auto_renew: false, text: FLEET_PACK_TEXT } } : {}),
      limits: {
        paid_per_network_per_min: FLEET_GUARD.paidPerMinute,
        prepaid_valid_key_per_min: FLEET_GUARD.keyPerMinute,
        unknown_or_failed_key_per_network_per_min: FLEET_GUARD.keyIpPerMinute,
        failed_keys_per_network_per_10min: FLEET_GUARD.keyFailPer10Min,
      },
      ...(monthlyOn() && keySecret() ? { monthly: { url: `${base}/v1/fleet/plan/monthly`, usd: FLEET_GUARD.monthly.usd, fair_use_calls: FLEET_GUARD.monthly.calls, days: FLEET_GUARD.monthly.days, auto_renew: false } } : {}),
      privacy: "Subjects and payers are stored only as keyed hashes (pseudonymous, not anonymous). Invoice URLs carry a keyed hash of the query, never an address. Answers list no other cluster members and contain no payer data.",
      ...legal(base),
    };
  }

  return {
    on: () => fleetGuardOn(d.env),
    discovery(base: string) {
      if (!fleetGuardOn(d.env)) return [];
      return [{ name: "Wallet pattern check (fleet guard)", url: `${base}/v1/fleet/check?subject=api.example.com`, mimeType: "application/json", method: "GET", description: `Dated pattern-match label (automated cluster / no match / insufficient data) for a payer or seller identifier. ${FLEET_GUARD.priceUsd} USD per call, cache 1h${keySecret() ? `; ${FLEET_PACK_TEXT}` : ""}. Not OFAC/AML screening, not a consumer report.` }];
    },
    methodology: (base: string) => methodology(base),
    async handle(request: Request, path: string, base: string, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response | null> {
      if (!path.startsWith("/v1/fleet")) return null;
      // Owner admin works while the feature is off (deploy step 4 loads members before launch). Everything else: off = absent.
      if (path.startsWith("/v1/fleet/admin/")) {
        // Owner check first: a non-owner learns nothing about configuration.
        if (!(await d.isOwner(request))) return json(401, { error: "owner_only" }, NO_STORE);
        if (!secret() || secret().length < 32) return json(503, { error: "fleet_guard_not_configured" }, NO_STORE);
        return admin(request, path);
      }
      if (!fleetGuardOn(d.env)) return null;
      if (!secret() || secret().length < 32) return json(503, { error: "fleet_guard_not_configured", note: "Not charged." }, NO_STORE);
      const url = new URL(request.url);
      const get = request.method === "GET" || request.method === "HEAD";
      if (path === "/v1/fleet" && get) return json(200, doc(base), { "Cache-Control": "public, max-age=300" });
      if (path === "/v1/fleet/methodology" && get) return json(200, methodology(base), { "Cache-Control": "public, max-age=3600" });
      if (path === "/v1/fleet/check" && get) return check(request, url, base, ctx);
      if (path === "/v1/fleet/check/free" && get) return freeCheck(request, url, base);
      if (path === "/v1/fleet/pack" && get) return buy(request, base, FLEET_GUARD.pack, path, ctx);
      if (path === "/v1/fleet/plan/monthly" && get) {
        if (!monthlyOn()) return json(404, { error: "plan_not_offered", note: "Not charged." }, NO_STORE);
        return buy(request, base, FLEET_GUARD.monthly, path, ctx);
      }
      if (path === "/v1/fleet/key" && get) {
        const k = request.headers.get(FLEET_KEY_HEADER)?.trim() ?? "";
        const a = await keyAccess(request, k, () => json(401, { error: "invalid_fleet_key" }, NO_STORE));
        if (a.deny) return a.deny;
        const row = await d.store.key(a.kh);
        if (!row) return (await keyFailed(a.ip)) ?? json(404, { error: "unknown_key" }, NO_STORE);
        if (!a.known) await markValid(a.kh);
        return json(200, { plan: row.plan, calls: row.calls, used: row.used, remaining: Math.max(0, row.calls - row.used), expires_at: new Date(row.expires_at).toISOString(), auto_renew: false, ...legal(base) }, NO_STORE);
      }
      return json(404, { error: "not_found" }, NO_STORE);
    },
    /** Nightly retention (runs whether or not the feature is on). */
    async purge() {
      const r = await d.store.purge(now());
      const sales = d.sales?.purgeRoutes ? await d.sales.purgeRoutes(FLEET_SALES_ROUTES, now() - FLEET_GUARD.retentionDays * DAY) : 0;
      kindsCache = null;
      log({ event: "fleet_guard_purged", ...r, sales });
      return { ...r, sales };
    },
  };
}
export type FleetGuard = ReturnType<typeof createFleetGuard>;
export type { KVLike };
