/**
 * Free basic trust check quota (GET /v1/trust/check): FREE_TRUST_CHECK_LIMITS per hashed IP and per hashed client key/wallet
 * header, per UTC day, plus a per-minute burst limit and a whole-service daily ceiling.
 *
 * Storage: the existing InvoiceGuard Durable Object (POST /quota on object names "quota-<n>", 16 of them), NOT D1: the D1
 * rate_limits table costs 3 row writes per counted request and the Free plan's D1 write budget is already the tightest limit.
 * One DO request per free check (two when a key/wallet header is sent). The global ceiling is enforced per DO object
 * (globalPerDay / 16), so it is approximate by design.
 *
 * Fail-open: if the DO errors or times out, the check is served and the error logged (a buyer's safety answer must not
 * disappear because a counter is unavailable). Without a DO binding (Node runtime, tests) an in-memory counter is used.
 */
import { FREE_TRUST_CHECK_LIMITS, type DurableObjectNamespaceLike } from "./config";

export interface QuotaKey { key: string; max: number; resetAt: number }
export interface QuotaTake { allowed: boolean; counts: number[]; blocked?: number }
export interface QuotaCounter { take(object: string, keys: QuotaKey[]): Promise<QuotaTake> }

export const QUOTA_OBJECTS = 16;
const DAY = 86_400_000;

/** In-process counter: tests and the Node runtime (single process). Same all-or-nothing semantics as the DO. */
export class MemoryQuotaCounter implements QuotaCounter {
  private m = new Map<string, { n: number; until: number }>();
  constructor(private now: () => number = Date.now) {}
  async take(object: string, keys: QuotaKey[]): Promise<QuotaTake> {
    const t = this.now();
    const ks = keys.map((k) => `${object}|${k.key}`);
    const cur = ks.map((k) => { const v = this.m.get(k); return v && v.until > t ? v.n : 0; });
    const blocked = keys.findIndex((k, i) => cur[i] >= k.max);
    if (blocked >= 0) return { allowed: false, counts: cur, blocked };
    const counts = cur.map((n) => n + 1);
    ks.forEach((k, i) => this.m.set(k, { n: counts[i], until: keys[i].resetAt }));
    if (this.m.size > 50_000) for (const [k, v] of this.m) if (v.until <= t) this.m.delete(k);
    return { allowed: true, counts };
  }
}

export class DurableObjectQuotaCounter implements QuotaCounter {
  constructor(private ns: DurableObjectNamespaceLike, private timeoutMs = 1500) {}
  async take(object: string, keys: QuotaKey[]): Promise<QuotaTake> {
    const stub = this.ns.get(this.ns.idFromName(object));
    const res = await stub.fetch("https://invoice-guard/quota", { method: "POST", body: JSON.stringify({ keys }), signal: AbortSignal.timeout(this.timeoutMs) } as RequestInit);
    if (res.status !== 200) throw new Error(`quota DO HTTP ${res.status}`);
    return (await res.json()) as QuotaTake;
  }
}

export type FreeQuotaResult = {
  allowed: boolean;
  /** Daily limit and what is left for the most constrained identity (IP or key), for RateLimit-* headers. */
  limit: number;
  remaining: number;
  /** Epoch ms when the blocking window (or the daily window) resets. */
  resetAt: number;
  /** Which window blocked: "minute" | "day" | "key_day" | "global"; absent when allowed. */
  reason?: "minute" | "day" | "key_day" | "global";
  /** Counter unavailable: served anyway (fail-open). */
  failOpen?: boolean;
};

async function hmacHex(secret: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const KEY_HEADERS = ["X-Lumi-Key", "X-Wallet", "X-Lumi-Wallet"];

/** Hashed caller ids (raw IPs and keys are never stored or logged). */
export async function callerIds(request: Request, secret: string): Promise<{ ip: string; key: string | null }> {
  const ipRaw = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? "unknown";
  let k = "";
  for (const h of KEY_HEADERS) { k = request.headers.get(h)?.trim() ?? ""; if (k) break; }
  if (!k) k = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  return { ip: await hmacHex(secret, `fq-ip:${ipRaw}`), key: k ? await hmacHex(secret, `fq-key:${k.slice(0, 200).toLowerCase()}`) : null };
}

const objectFor = (id: string) => `quota-${parseInt(id.slice(0, 6), 16) % QUOTA_OBJECTS}`;

export function createFreeQuota(opts: { counter: QuotaCounter; secret: string; now?: () => number; log?: (e: Record<string, unknown>) => void; limits?: { perDay: number; perMinute: number; globalPerDay: number }; prefix?: string }) {
  const L = opts.limits ?? FREE_TRUST_CHECK_LIMITS;
  const now = opts.now ?? Date.now;
  /** Counter key prefix: "tc" (free trust check, default) or another free route with its own allowance. */
  const P = opts.prefix ?? "tc";
  /** Isolate-local memo of identities already over their daily limit: repeat callers skip the DO call until reset. */
  const denied = new Map<string, number>();
  return {
    limits: L,
    async take(request: Request): Promise<FreeQuotaResult> {
      const t = now();
      const day = Math.floor(t / DAY);
      const dayReset = (day + 1) * DAY;
      const minute = Math.floor(t / 60_000);
      const minuteReset = (minute + 1) * 60_000;
      const ids = await callerIds(request, opts.secret);
      for (const id of [ids.ip, ids.key]) {
        const until = id ? denied.get(id) : undefined;
        if (until !== undefined) {
          if (until > t) return { allowed: false, limit: L.perDay, remaining: 0, resetAt: until, reason: id === ids.ip ? "day" : "key_day" };
          denied.delete(id!);
        }
      }
      try {
        const ipKeys: QuotaKey[] = [
          { key: `${P}:m:${minute}:${ids.ip}`, max: L.perMinute, resetAt: minuteReset },
          { key: `${P}:d:${day}:${ids.ip}`, max: L.perDay, resetAt: dayReset },
          { key: `${P}:g:${day}`, max: Math.ceil(L.globalPerDay / QUOTA_OBJECTS), resetAt: dayReset },
        ];
        const r = await opts.counter.take(objectFor(ids.ip), ipKeys);
        if (!r.allowed) {
          const reason = r.blocked === 0 ? "minute" : r.blocked === 1 ? "day" : "global";
          if (reason === "day") denied.set(ids.ip, dayReset);
          return { allowed: false, limit: L.perDay, remaining: 0, resetAt: reason === "minute" ? minuteReset : dayReset, reason };
        }
        let remaining = Math.max(0, L.perDay - r.counts[1]);
        if (ids.key) {
          const kr = await opts.counter.take(objectFor(ids.key), [{ key: `${P}:k:${day}:${ids.key}`, max: L.perDay, resetAt: dayReset }]);
          if (!kr.allowed) { denied.set(ids.key, dayReset); return { allowed: false, limit: L.perDay, remaining: 0, resetAt: dayReset, reason: "key_day" }; }
          remaining = Math.min(remaining, Math.max(0, L.perDay - kr.counts[0]));
        }
        if (denied.size > 10_000) denied.clear();
        return { allowed: true, limit: L.perDay, remaining, resetAt: dayReset };
      } catch (e) {
        opts.log?.({ event: "free_quota_error", error: String((e as Error)?.message ?? e) });
        return { allowed: true, limit: L.perDay, remaining: L.perDay, resetAt: dayReset, failOpen: true };
      }
    },
  };
}
export type FreeQuota = ReturnType<typeof createFreeQuota>;

/** IETF RateLimit header fields (draft-ietf-httpapi-ratelimit-headers) plus the plain X- names some clients read. */
export function rateLimitHeaders(q: FreeQuotaResult, t: number): Record<string, string> {
  const reset = String(Math.max(0, Math.ceil((q.resetAt - t) / 1000)));
  return {
    "RateLimit-Limit": String(q.limit),
    "RateLimit-Remaining": String(q.remaining),
    "RateLimit-Reset": reset,
    "RateLimit-Policy": `${q.limit};w=86400`,
    "X-RateLimit-Limit": String(q.limit),
    "X-RateLimit-Remaining": String(q.remaining),
    "X-RateLimit-Reset": reset,
  };
}
