/**
 * Demand-test trial keys (12 Nov 2026): a short-lived allowlist that waives payment on the paid trust
 * routes (high-value, verdict, receipts, batch, vendor report) for named builders.
 *
 * A valid `X-Lumi-Trial-Key` header skips the 402, does not settle, and is never written to the sales
 * ledger (so it is never revenue). Caps: 50 waived calls per key, expiry 21 Nov 2026 11:59:59.999 PM
 * America/Chicago. Usage is logged per key (hash + label) so 24 Nov can count real calls.
 *
 * The plaintext key is never stored. D1 (or the in-memory store in tests) keeps only the SHA-256 hash
 * and a public builder label. The normal 402 path is unchanged when the header is absent, unknown,
 * expired or exhausted. Paying (PAYMENT-SIGNATURE / X-PAYMENT) always wins over a trial key.
 *
 * This is separate from the SIWX free trial in src/trial.ts (3 calls per new wallet).
 */
import type { D1Like, PaidRoute } from "./config";

export const DEMAND_TRIAL_HEADER = "X-Lumi-Trial-Key";
/** 21 Nov 2026, 11:59:59.999 PM America/Chicago (CST, UTC−6). */
export const DEMAND_TRIAL_EXPIRES_AT_MS = 1_795_327_199_999;
export const DEMAND_TRIAL_CAP = 50;
export const DEMAND_TRIAL_ROUTES: readonly PaidRoute[] = [
  "high_value_check",
  "verdict",
  "receipts",
  "batch_check",
  "vendor_report",
];
const KEY_RE = /^ltk_[0-9a-f]{64}$/;

export function demandTrialEligible(route: PaidRoute): boolean {
  return (DEMAND_TRIAL_ROUTES as readonly string[]).includes(route);
}

/** Read the trial key from a request. Returns null when the header is missing or the wrong shape (do not hash junk). */
export function readDemandTrialKey(request: Request): string | null {
  const raw = request.headers.get(DEMAND_TRIAL_HEADER)?.trim() ?? "";
  if (!raw) return null;
  return KEY_RE.test(raw) ? raw : null;
}

export async function hashDemandTrialKey(key: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type DemandTrialClaim =
  | { ok: true; label: string; used: number; remaining: number; cap: number; expires_at: number }
  | { ok: false; reason: "unknown_key" | "expired" | "exhausted" | "store_unavailable" };

export interface DemandTrialUse {
  key_hash: string;
  label: string;
  route: string;
  path?: string;
  ts: number;
}

export interface DemandTrialStore {
  /** Atomically consume one call if the key exists, is unexpired and under cap. */
  claim(keyHash: string, route: string, path: string | undefined, ts: number): Promise<DemandTrialClaim>;
  /** Current used/cap/expiry for a hash, or null if unknown. Does not consume a call. */
  peek(keyHash: string): Promise<{ label: string; used: number; cap: number; expires_at: number } | null>;
  uses?(keyHash?: string): Promise<DemandTrialUse[]>;
}

export class MemoryDemandTrialStore implements DemandTrialStore {
  keys = new Map<string, { label: string; cap: number; used: number; expires_at: number }>();
  rows: DemandTrialUse[] = [];

  seed(keyHash: string, label: string, cap = DEMAND_TRIAL_CAP, expiresAt = DEMAND_TRIAL_EXPIRES_AT_MS): this {
    this.keys.set(keyHash, { label, cap, used: 0, expires_at: expiresAt });
    return this;
  }

  async peek(keyHash: string) {
    const k = this.keys.get(keyHash);
    return k ? { ...k } : null;
  }

  async claim(keyHash: string, route: string, path: string | undefined, ts: number): Promise<DemandTrialClaim> {
    const k = this.keys.get(keyHash);
    if (!k) return { ok: false, reason: "unknown_key" };
    if (ts > k.expires_at) return { ok: false, reason: "expired" };
    if (k.used >= k.cap) return { ok: false, reason: "exhausted" };
    k.used += 1;
    this.rows.push({ key_hash: keyHash, label: k.label, route, path, ts });
    return { ok: true, label: k.label, used: k.used, remaining: Math.max(0, k.cap - k.used), cap: k.cap, expires_at: k.expires_at };
  }

  async uses(keyHash?: string) {
    return keyHash ? this.rows.filter((r) => r.key_hash === keyHash) : [...this.rows];
  }
}

export class D1DemandTrialStore implements DemandTrialStore {
  constructor(private db: D1Like) {}

  async peek(keyHash: string) {
    const row = await this.db
      .prepare("SELECT label, used, cap, expires_at FROM demand_trial_keys WHERE key_hash = ?")
      .bind(keyHash)
      .first<{ label: string; used: number; cap: number; expires_at: number }>();
    return row
      ? { label: String(row.label), used: Number(row.used), cap: Number(row.cap), expires_at: Number(row.expires_at) }
      : null;
  }

  async claim(keyHash: string, route: string, path: string | undefined, ts: number): Promise<DemandTrialClaim> {
    const existing = await this.peek(keyHash);
    if (!existing) return { ok: false, reason: "unknown_key" };
    if (ts > existing.expires_at) return { ok: false, reason: "expired" };
    if (existing.used >= existing.cap) return { ok: false, reason: "exhausted" };
    let res: { meta?: { changes?: number } };
    try {
      res = (await this.db
        .prepare("UPDATE demand_trial_keys SET used = used + 1 WHERE key_hash = ? AND used < cap AND expires_at >= ?")
        .bind(keyHash, ts)
        .run()) as { meta?: { changes?: number } };
    } catch (e) {
      return { ok: false, reason: "store_unavailable" };
    }
    if ((res?.meta?.changes ?? 0) !== 1) {
      const again = await this.peek(keyHash);
      if (!again) return { ok: false, reason: "unknown_key" };
      if (ts > again.expires_at) return { ok: false, reason: "expired" };
      return { ok: false, reason: "exhausted" };
    }
    const after = await this.peek(keyHash);
    if (!after) return { ok: false, reason: "store_unavailable" };
    try {
      await this.db
        .prepare("INSERT INTO demand_trial_uses (key_hash, label, route, path, ts) VALUES (?,?,?,?,?)")
        .bind(keyHash, after.label, route, path ?? null, ts)
        .run();
    } catch {
      // The cap was already consumed; the use row is best-effort so a log miss does not undo the waiver.
    }
    return {
      ok: true,
      label: after.label,
      used: after.used,
      remaining: Math.max(0, after.cap - after.used),
      cap: after.cap,
      expires_at: after.expires_at,
    };
  }

  async uses(keyHash?: string) {
    const out = keyHash
      ? ((await this.db
          .prepare("SELECT key_hash, label, route, path, ts FROM demand_trial_uses WHERE key_hash = ? ORDER BY ts")
          .bind(keyHash)
          .all()) as { results?: Record<string, unknown>[] })
      : ((await this.db
          .prepare("SELECT key_hash, label, route, path, ts FROM demand_trial_uses ORDER BY ts")
          .all()) as { results?: Record<string, unknown>[] });
    return (out.results ?? []).map((r) => ({
      key_hash: String(r.key_hash),
      label: String(r.label),
      route: String(r.route),
      path: r.path == null ? undefined : String(r.path),
      ts: Number(r.ts),
    }));
  }
}

/** Access block added to a waived response. No builder label, no key. */
export function demandTrialAccess(c: Extract<DemandTrialClaim, { ok: true }>) {
  return {
    mode: "demand_trial" as const,
    charged: false,
    trial: 1 as const,
    is_test: 0 as const,
    trial_calls_used: c.used,
    trial_calls_remaining: c.remaining,
    expires_at: new Date(c.expires_at).toISOString(),
  };
}
