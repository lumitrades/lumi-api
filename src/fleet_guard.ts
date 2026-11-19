/**
 * Fleet guard (DRAFT 2026-11-19, branch fleet-guard-2026-11-19, NOT deployed; off unless FLEET_GUARD=on):
 * "is this payer or seller part of a known scripted payment fleet?" — a cheap, hourly-cacheable pre-purchase check.
 *
 *   GET  /v1/fleet                       free doc (prices, caps, endpoints)
 *   GET  /v1/fleet/check?subject=a[,b..] paid x402, 0.0005 USD per subject (max FLEET_GUARD.batchMax), settled before serving;
 *                                        or prepaid with X-Lumi-Fleet-Key (one credit per subject, decremented atomically)
 *   GET  /v1/fleet/check/free?subject=a  free, capped per hashed IP AND per hashed wallet header AND globally (fail-closed)
 *   GET  /v1/fleet/pack                  paid x402, $4 → key with 10,000 credits (Idempotency-Key honoured by the paywall)
 *   GET  /v1/fleet/plan/monthly          paid x402, $49 → key with a 30-day fair-use cap (only when FLEET_GUARD_MONTHLY=on)
 *   GET  /v1/fleet/key                   remaining credits for X-Lumi-Fleet-Key (free)
 *   POST /v1/fleet/admin/members         owner only: load a cluster's members (raw values are HMACed in memory, never stored)
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
 *  - Retention: settle records FLEET_GUARD.retentionDays, spent/expired keys FLEET_GUARD.keyRetentionDays (purgeFleetGuard).
 *
 * Vigil re-review fixes (2026-11-19):
 *  - MED-1: the shared idempotency table stores PAYMENT-RESPONSE without `payer` (x402.ts redactPaymentResponseHeader).
 *  - MED-2: pack/plan keys = "fgk_" + HMAC(secret, plan + settled tx)[0..40]; the idempotency row keeps a placeholder and a
 *    replay recomputes the key from the cached tx hash. Fleet replays are bound to sha256 of the full signed payment header.
 *  - MED-3: prepaid checks and /v1/fleet/key: FLEET_GUARD.keyIpPerMinute per network before the key is hashed, and
 *    FLEET_GUARD.keyFailPer10Min failed keys per network, then 429 with no further lookups.
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
  /** Per network (/64 for IPv6), per minute, across prepaid checks and /v1/fleet/key, taken before the key is hashed. */
  keyIpPerMinute: 60,
  /** Failed prepaid keys (bad format or unknown) per network per 10 minutes; over it, failures get 429. */
  keyFailPer10Min: 10,
  retentionDays: 90,
  keyRetentionDays: 30,
  adminMaxMembers: 5_000,
  /** Canonical queries up to this many characters are echoed in the invoice URL; longer ones bind a hash (header size). */
  echoMaxChars: 200,
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

export interface ClusterInfo { id: string; wallets: number; sellers_paid: number; first_seen: string | null; basis: string }
export interface MemberRow { subject_hmac: string; cluster_id: string; role: "payer" | "seller" }
export interface FleetKeyRow { key_hash: string; plan: string; calls: number; used: number; expires_at: number; paid_tx: string; payer_hmac: string | null; created_at: number }

export interface FleetGuardStore {
  members(hmacs: string[]): Promise<Map<string, { role: "payer" | "seller"; cluster: ClusterInfo }>>;
  upsertCluster(c: ClusterInfo, now: number): Promise<void>;
  upsertMembers(rows: MemberRow[], now: number): Promise<number>;
  /** Records a settled tx once. false = this tx was already recorded (replay): refuse. */
  recordSettle(tx: string, route: string, payerHmac: string | null, now: number): Promise<boolean>;
  /** Mints a key tied to exactly one settled tx. false = a key for this tx already exists. */
  mintKey(row: FleetKeyRow): Promise<boolean>;
  /** Atomically consume n credits. null = unknown/expired key or not enough credits left. */
  useCredits(keyHash: string, n: number, now: number): Promise<{ remaining: number; plan: string; expires_at: number } | null>;
  key(keyHash: string): Promise<FleetKeyRow | null>;
  purge(now: number): Promise<void>;
}

export class MemoryFleetGuardStore implements FleetGuardStore {
  clusters = new Map<string, ClusterInfo>();
  memberMap = new Map<string, MemberRow>();
  settles = new Map<string, { route: string; payer_hmac: string | null; at: number }>();
  keys = new Map<string, FleetKeyRow>();
  async members(hmacs: string[]) {
    const out = new Map<string, { role: "payer" | "seller"; cluster: ClusterInfo }>();
    for (const h of hmacs) {
      const m = this.memberMap.get(h);
      const c = m && this.clusters.get(m.cluster_id);
      if (m && c) out.set(h, { role: m.role, cluster: c });
    }
    return out;
  }
  async upsertCluster(c: ClusterInfo) { this.clusters.set(c.id, c); }
  async upsertMembers(rows: MemberRow[]) { for (const r of rows) this.memberMap.set(r.subject_hmac, r); return rows.length; }
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
    for (const [tx, s] of this.settles) if (s.at < now - FLEET_GUARD.retentionDays * DAY) this.settles.delete(tx);
    for (const [h, k] of this.keys) if (k.expires_at < now - FLEET_GUARD.keyRetentionDays * DAY) this.keys.delete(h);
  }
}

export class D1FleetGuardStore implements FleetGuardStore {
  constructor(private db: D1Like) {}
  async members(hmacs: string[]) {
    const out = new Map<string, { role: "payer" | "seller"; cluster: ClusterInfo }>();
    if (!hmacs.length) return out;
    const q = `SELECT m.subject_hmac, m.role, c.id, c.wallets, c.sellers_paid, c.first_seen, c.basis FROM fleet_guard_members m JOIN fleet_guard_clusters c ON c.id = m.cluster_id WHERE m.subject_hmac IN (${hmacs.map(() => "?").join(",")})`;
    const r = await this.db.prepare(q).bind(...hmacs).all<any>();
    for (const x of r.results) out.set(x.subject_hmac, { role: x.role, cluster: { id: x.id, wallets: Number(x.wallets), sellers_paid: Number(x.sellers_paid), first_seen: x.first_seen ?? null, basis: x.basis } });
    return out;
  }
  async upsertCluster(c: ClusterInfo, now: number) {
    await this.db.prepare("INSERT INTO fleet_guard_clusters (id, wallets, sellers_paid, first_seen, basis, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET wallets = excluded.wallets, sellers_paid = excluded.sellers_paid, first_seen = excluded.first_seen, basis = excluded.basis, updated_at = excluded.updated_at")
      .bind(c.id, c.wallets, c.sellers_paid, c.first_seen, c.basis, now).run();
  }
  async upsertMembers(rows: MemberRow[], now: number) {
    for (let i = 0; i < rows.length; i += 50) {
      await this.db.batch(rows.slice(i, i + 50).map((r) => this.db.prepare("INSERT INTO fleet_guard_members (subject_hmac, cluster_id, role, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(subject_hmac) DO UPDATE SET cluster_id = excluded.cluster_id, role = excluded.role").bind(r.subject_hmac, r.cluster_id, r.role, now)));
    }
    return rows.length;
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
    await this.db.batch([
      this.db.prepare("DELETE FROM fleet_guard_settles WHERE settled_at < ?").bind(now - FLEET_GUARD.retentionDays * DAY),
      this.db.prepare("DELETE FROM fleet_guard_keys WHERE expires_at < ?").bind(now - FLEET_GUARD.keyRetentionDays * DAY),
    ]);
  }
}

export const purgeFleetGuard = (store: FleetGuardStore, now: number) => store.purge(now);

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

export interface Answer {
  subject_kind: SubjectKind;
  fleet_member: boolean;
  role: "payer" | "seller" | null;
  cluster: { id: string; wallets: number; sellers_paid: number; first_seen: string | null; basis: string } | null;
  advice: string;
}

// ---------------------------------------------------------------- service

export interface FleetGuardEnv { FLEET_GUARD?: string; FLEET_GUARD_HMAC_SECRET?: string; FLEET_GUARD_MONTHLY?: string }
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
}

type Plan = { id: string; usd: string; calls: number; days: number };

export function createFleetGuard(d: FleetGuardDeps) {
  const now = d.now ?? Date.now;
  const log = (e: Record<string, unknown>) => d.log?.({ ...e, svc: "fleet_guard" });
  const alert = (kind: string, extra: Record<string, unknown> = {}) => log({ event: "fleet_guard_alert", kind, ...extra });
  const cache = d.cache ?? new AnswerCache();
  const secret = () => (d.env.FLEET_GUARD_HMAC_SECRET ?? "").trim();
  const monthlyOn = () => d.env.FLEET_GUARD_MONTHLY === "on";
  const subjHmac = (s: Subject) => hmacHex(secret(), `fg-subj:${s.kind === "domain" ? "d" : "a"}:${s.norm}`);
  const payerHmac = async (p?: string | null) => (p ? hmacHex(secret(), `fg-payer:${/^0x/i.test(p) ? p.toLowerCase() : p}`) : null);
  const ipHmac = async (r: Request) => hmacHex(secret(), `fg-ip:${ipBucket(r.headers.get("CF-Connecting-IP"))}`);
  /**
   * Pack/plan keys are derived, never stored (Vigil MED-2): HMAC(secret, plan + settled tx hash). Lumi keeps only the
   * key's SHA-256; an idempotent retry recomputes the key from the tx hash in the cached PAYMENT-RESPONSE.
   */
  const deriveKey = async (planId: string, tx: string) => "fgk_" + (await hmacHex(secret(), `fg-key:${planId}:${tx}`)).slice(0, 40);
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
        if (!tx || typeof j.plan !== "string") { alert("idempotent_key_unrecoverable", { route: j.plan }); return null; }
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
   * Prepaid-key gate (Vigil MED-3), before any key is hashed or looked up: FLEET_GUARD.keyIpPerMinute per network across
   * prepaid checks and /v1/fleet/key, and no lookups at all for a network that is over its failed-key limit. Fail-open on
   * a counter outage (paid keys keep working); the failed-key block is also remembered in this isolate.
   */
  const failBlocked = new Map<string, number>();
  const tenMinEnd = () => Math.floor(now() / 600_000) * 600_000 + 600_000;
  async function keyGate(request: Request): Promise<{ ip: string; blocked: boolean }> {
    const ip = await ipHmac(request);
    const until = failBlocked.get(ip);
    if (until !== undefined) { if (until > now()) return { ip, blocked: true }; failBlocked.delete(ip); }
    const ok = await take(obj(ip), [{ key: `fg-ki:${ip}`, max: FLEET_GUARD.keyIpPerMinute, resetAt: minuteEnd() }], false);
    return { ip, blocked: !ok };
  }
  /** Counts one failed key for this network; returns a 429 once over the limit (and blocks further lookups). */
  async function keyFailed(ip: string): Promise<Response | null> {
    const ok = await take(obj(ip), [{ key: `fg-kf:${ip}`, max: FLEET_GUARD.keyFailPer10Min, resetAt: tenMinEnd() }], false);
    if (ok) return null;
    if (failBlocked.size > 10_000) failBlocked.clear();
    failBlocked.set(ip, tenMinEnd());
    log({ event: "fleet_guard_key_fail_limited" });
    return json(429, { error: "too_many_invalid_keys", retry_after_s: 600, note: "Not charged." }, { ...NO_STORE, "Retry-After": "600" });
  }

  async function answers(subjects: Subject[]): Promise<{ results: (Answer & { index: number })[]; cacheHits: number }> {
    const t = now();
    const keys = await Promise.all(subjects.map(subjHmac));
    const out: (Answer | null)[] = keys.map((k) => cache.get(`${FLEET_GUARD.version}:${k}`, t)?.v ?? null);
    const cacheHits = out.filter(Boolean).length;
    const miss = keys.filter((_, i) => !out[i]);
    if (miss.length) {
      const found = await d.store.members([...new Set(miss)]);
      keys.forEach((k, i) => {
        if (out[i]) return;
        const m = found.get(k);
        const a: Answer = m
          ? { subject_kind: subjects[i].kind, fleet_member: true, role: m.role, cluster: { ...m.cluster }, advice: m.role === "payer" ? "Payer is part of a known scripted fleet: treat its volume as one buyer, not many." : "Seller's income is mostly from a known scripted fleet: its sales count is not independent demand." }
          : { subject_kind: subjects[i].kind, fleet_member: false, role: null, cluster: null, advice: "Not in any fleet Lumi tracks (absence is not proof of independence)." };
        cache.set(`${FLEET_GUARD.version}:${k}`, a, t);
        out[i] = a;
      });
    }
    return { results: out.map((a, i) => ({ index: i, ...(a as Answer) })), cacheHits };
  }

  async function body(subjects: Subject[], access: Record<string, unknown>) {
    const { results, cacheHits } = await answers(subjects);
    const t = now();
    return {
      kind: "lumi_fleet_check",
      version: FLEET_GUARD.version,
      as_of: new Date(t).toISOString(),
      valid_until: new Date(t + FLEET_GUARD.cacheTtlSec * 1000).toISOString(),
      count: results.length,
      results,
      cache: { ttl_s: FLEET_GUARD.cacheTtlSec, hits: cacheHits, note: "Cache once per subject per hour; repeat calls inside valid_until are not needed." },
      access,
      method: "Payers are clustered by funding path and payer overlap across sellers on public ledgers. Automated observation, not an accusation.",
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
      idempotencyBinding: "signed_header",
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

    // Prepaid key: rate limit per key, then one atomic decrement of n credits, then serve.
    if (keyRaw && !hasPayment(request)) {
      const gate = await keyGate(request);
      if (gate.blocked) return rateLimited();
      if (!/^fgk_[0-9a-f]{40}$/.test(keyRaw)) return (await keyFailed(gate.ip)) ?? json(401, { error: "invalid_fleet_key", note: "Not charged." }, NO_STORE);
      const kh = await sha256Hex(keyRaw);
      if (!(await take(obj(kh), [{ key: `fg-k:${kh}`, max: FLEET_GUARD.keyPerMinute, resetAt: minuteEnd() }], false))) return rateLimited();
      const used = await d.store.useCredits(kh, n, now());
      if (!used) {
        // Unknown, expired or exhausted: an exhausted real key is not a guess, but the store cannot tell them apart cheaply.
        if (!(await d.store.key(kh))) { const lim = await keyFailed(gate.ip); if (lim) return lim; }
        return json(402, { error: "fleet_key_exhausted_or_expired", buy_pack: `${base}/v1/fleet/pack`, note: "Not charged." }, NO_STORE);
      }
      return json(200, await body(parsed.subjects, { mode: "prepaid", plan: used.plan, credits_used: n, credits_remaining: used.remaining, key_expires_at: new Date(used.expires_at).toISOString() }), NO_STORE);
    }

    // x402: bounded rate limit per hashed IP before anything else; no lookup until the payment has settled.
    const ip = await ipHmac(request);
    if (!(await take(obj(ip), [{ key: `fg-p:${ip}`, max: FLEET_GUARD.paidPerMinute, resetAt: minuteEnd() }], false))) return rateLimited();
    const usd = checkPriceUsd(n);
    // The invoice binds this URL. Long batches bind a hash of the normalized query instead of echoing it, so the
    // PAYMENT-REQUIRED header stays a few KB whatever the batch (the paid retry recomputes the same value).
    const resourceUrl = parsed.canonical.length <= FLEET_GUARD.echoMaxChars
      ? `${base}/v1/fleet/check?subject=${encodeURIComponent(parsed.canonical)}`
      : `${base}/v1/fleet/check?n=${n}&qh=${(await sha256Hex(`${FLEET_GUARD.version}|${parsed.canonical}`)).slice(0, 32)}`;
    const quote = quoteFor(`fleet_check:n${n}`, usd, resourceUrl, `Lumi fleet guard: is this payer or seller part of a known scripted payment fleet? ${n} subject(s), $${FLEET_GUARD.priceUsd} each, cache 1h.`);
    if (!hasPayment(request)) {
      return paymentRequiredResponse(d.cfg, quote, "PAYMENT-SIGNATURE header is required", {
        pack: { url: `${base}/v1/fleet/pack`, usd: FLEET_GUARD.pack.usd, calls: FLEET_GUARD.pack.calls },
        free: `${base}/v1/fleet/check/free?subject=<one subject>`,
      });
    }
    return paid(request, ctx, quote, FLEET_GUARD.minUsd * n, async () => json(200, await body(parsed.subjects, { mode: "x402", charged: true, price_usd: usd }), NO_STORE));
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
    return json(200, await body(parsed.subjects, { mode: "free", charged: false }), NO_STORE);
  }

  async function buy(request: Request, base: string, plan: Plan, path: string, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const ip = await ipHmac(request);
    if (!(await take(obj(ip), [{ key: `fg-b:${ip}`, max: 30, resetAt: minuteEnd() }], false))) return rateLimited();
    const quote = quoteFor(plan.id, plan.usd, `${base}${path}`, `Lumi fleet guard ${plan.id === FLEET_GUARD.pack.id ? "pack" : "monthly plan"}: ${plan.calls.toLocaleString("en-US")} checks, valid ${plan.days} days.`);
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
      return json(200, {
        kind: "lumi_fleet_key", plan: plan.id, key: raw, header: FLEET_KEY_HEADER, calls: plan.calls, expires_at: new Date(row.expires_at).toISOString(),
        note: "Lumi stores only its SHA-256. A retry with the same Idempotency-Key and the same signed payment returns it again within 24 hours. One credit per subject; send it as the header on /v1/fleet/check.",
      }, NO_STORE);
    });
  }

  async function admin(request: Request): Promise<Response> {
    if (!(await d.isOwner(request))) return json(401, { error: "owner_only" }, NO_STORE);
    const text = await request.text().catch(() => "");
    if (text.length > 600_000) return json(413, { error: "body_too_large" }, NO_STORE);
    let b: any; try { b = JSON.parse(text); } catch { return json(400, { error: "invalid_json" }, NO_STORE); }
    const c = b?.cluster;
    if (!c || typeof c.id !== "string" || !/^F\d{1,4}$/.test(c.id)) return json(400, { error: "cluster.id must look like F1" }, NO_STORE);
    const subs = Array.isArray(b.subjects) ? b.subjects : [];
    if (!subs.length || subs.length > FLEET_GUARD.adminMaxMembers) return json(400, { error: `1 to ${FLEET_GUARD.adminMaxMembers} subjects` }, NO_STORE);
    const rows: MemberRow[] = [];
    for (const s of subs) {
      const n = typeof s?.value === "string" ? normalizeSubject(s.value) : null;
      if (!n || (s.role !== "payer" && s.role !== "seller")) return json(400, { error: "each subject needs value and role payer|seller" }, NO_STORE);
      rows.push({ subject_hmac: await subjHmac(n), cluster_id: c.id, role: s.role });
    }
    const t = now();
    await d.store.upsertCluster({ id: c.id, wallets: Number(c.wallets) || 0, sellers_paid: Number(c.sellers_paid) || 0, first_seen: typeof c.first_seen === "string" ? c.first_seen.slice(0, 10) : null, basis: String(c.basis ?? "funding path + payer overlap").slice(0, 200) }, t);
    const count = await d.store.upsertMembers(rows, t);
    log({ event: "fleet_guard_members_loaded", cluster: c.id, count });
    return json(200, { ok: true, cluster: c.id, members: count, stored: "hmac_only" }, NO_STORE);
  }

  function doc(base: string) {
    return {
      kind: "lumi_fleet_guard", version: FLEET_GUARD.version,
      summary: "Is this payer or seller part of a known scripted payment fleet? Cache the answer for an hour.",
      check: { url: `${base}/v1/fleet/check?subject=<address, domain or URL>[,...]`, price_usd_per_subject: FLEET_GUARD.priceUsd, batch_max: FLEET_GUARD.batchMax, cache_ttl_s: FLEET_GUARD.cacheTtlSec },
      free: { url: `${base}/v1/fleet/check/free?subject=<one subject>`, cap: `${FLEET_GUARD.free.perIpDay}/day per network and per wallet header, ${FLEET_GUARD.free.perIpMinute}/min` },
      pack: { url: `${base}/v1/fleet/pack`, usd: FLEET_GUARD.pack.usd, calls: FLEET_GUARD.pack.calls, valid_days: FLEET_GUARD.pack.days },
      ...(monthlyOn() ? { monthly: { url: `${base}/v1/fleet/plan/monthly`, usd: FLEET_GUARD.monthly.usd, fair_use_calls: FLEET_GUARD.monthly.calls, days: FLEET_GUARD.monthly.days, auto_renew: false } } : {}),
      privacy: "Payer addresses are never stored or logged in the clear (keyed HMAC). Answers contain no payer data.",
    };
  }

  return {
    on: () => fleetGuardOn(d.env),
    discovery(base: string) {
      if (!fleetGuardOn(d.env)) return [];
      return [{ name: "Fleet guard", url: `${base}/v1/fleet/check?subject=api.example.com`, mimeType: "application/json", method: "GET", description: `Is this payer or seller part of a known scripted payment fleet? $${FLEET_GUARD.priceUsd} per subject, cache 1h; ${FLEET_GUARD.pack.calls.toLocaleString("en-US")}-check pack $${FLEET_GUARD.pack.usd}.` }];
    },
    async handle(request: Request, path: string, base: string, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response | null> {
      if (!path.startsWith("/v1/fleet") || !fleetGuardOn(d.env)) return null;
      if (!secret() || secret().length < 32) return json(503, { error: "fleet_guard_not_configured", note: "Not charged." }, NO_STORE);
      const url = new URL(request.url);
      const get = request.method === "GET" || request.method === "HEAD";
      if (path === "/v1/fleet" && get) return json(200, doc(base), { "Cache-Control": "public, max-age=300" });
      if (path === "/v1/fleet/check" && get) return check(request, url, base, ctx);
      if (path === "/v1/fleet/check/free" && get) return freeCheck(request, url, base);
      if (path === "/v1/fleet/pack" && get) return buy(request, base, FLEET_GUARD.pack, path, ctx);
      if (path === "/v1/fleet/plan/monthly" && get) {
        if (!monthlyOn()) return json(404, { error: "plan_not_offered", note: "Not charged." }, NO_STORE);
        return buy(request, base, FLEET_GUARD.monthly, path, ctx);
      }
      if (path === "/v1/fleet/key" && get) {
        const gate = await keyGate(request);
        if (gate.blocked) return rateLimited();
        const k = request.headers.get(FLEET_KEY_HEADER)?.trim() ?? "";
        if (!/^fgk_[0-9a-f]{40}$/.test(k)) return (await keyFailed(gate.ip)) ?? json(401, { error: "invalid_fleet_key" }, NO_STORE);
        const row = await d.store.key(await sha256Hex(k));
        if (!row) return (await keyFailed(gate.ip)) ?? json(404, { error: "unknown_key" }, NO_STORE);
        return json(200, { plan: row.plan, calls: row.calls, used: row.used, remaining: Math.max(0, row.calls - row.used), expires_at: new Date(row.expires_at).toISOString() }, NO_STORE);
      }
      if (path === "/v1/fleet/admin/members" && request.method === "POST") return admin(request);
      return json(404, { error: "not_found" }, NO_STORE);
    },
    purge: () => d.store.purge(now()),
  };
}
export type FleetGuard = ReturnType<typeof createFleetGuard>;
export type { KVLike };
