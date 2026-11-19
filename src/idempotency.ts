/**
 * Idempotent retries on paid routes. A client may send an `Idempotency-Key` header, or the x402 `payment-identifier`
 * extension id (payload.extensions["payment-identifier"].info.id). After a paid call is served, its response is cached
 * under a hash of (route, key) together with a hash of the full signed payment header. A retry with the same key and the
 * byte-identical payment header on the same route gets the cached response (header `Idempotent-Replayed: true`) and is
 * never settled again; the same key with any other payment (even one copying the invoiceId) is refused with 409 before
 * anything is verified or settled. Stored rows and replays carry no payer address (PAYMENT-RESPONSE `payer` and the
 * body's `payment.payer` are stripped). Rows live 24 hours.
 */
import type { D1Like } from "./config";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const PAYMENT_IDENTIFIER = "payment-identifier";
export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
/** Responses larger than this are served but not cached (a retry then falls back to the replay guard: never charged twice). */
export const IDEMPOTENCY_MAX_BODY = 512 * 1024;

/** 402 extension declaration (x402 payment-identifier extension; optional for clients). */
export const PAYMENT_IDENTIFIER_DECLARATION = {
  info: { required: false },
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      required: { type: "boolean" },
      id: { type: "string", minLength: 16, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" },
    },
    required: ["required"],
  },
};

export interface IdempotencyRecord {
  key_hash: string;
  payment_hash: string;
  route: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  created_at: number;
  expires_at: number;
}

export interface IdempotencyStore {
  get(keyHash: string, now: number): Promise<IdempotencyRecord | null>;
  /** Insert; an unexpired row for the same key is kept (first writer wins). */
  put(rec: IdempotencyRecord): Promise<void>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  rows = new Map<string, IdempotencyRecord>();
  async get(k: string, now: number) {
    const r = this.rows.get(k);
    return r && r.expires_at > now ? r : null;
  }
  async put(rec: IdempotencyRecord) {
    const old = this.rows.get(rec.key_hash);
    if (old && old.expires_at > rec.created_at) return;
    this.rows.set(rec.key_hash, rec);
  }
}

export class D1IdempotencyStore implements IdempotencyStore {
  constructor(private db: D1Like) {}
  async get(k: string, now: number) {
    const x = await this.db
      .prepare("SELECT key_hash, payment_hash, route, status, headers, body, created_at, expires_at FROM idempotency WHERE key_hash = ? AND expires_at > ?")
      .bind(k, now)
      .first<Record<string, unknown>>();
    if (!x) return null;
    let headers: Record<string, string> = {};
    try { headers = JSON.parse(String(x.headers)); } catch { /* keep empty */ }
    return {
      key_hash: String(x.key_hash), payment_hash: String(x.payment_hash), route: String(x.route), status: Number(x.status),
      headers, body: String(x.body), created_at: Number(x.created_at), expires_at: Number(x.expires_at),
    };
  }
  async put(r: IdempotencyRecord) {
    await this.db
      .prepare(
        "INSERT INTO idempotency (key_hash, payment_hash, route, status, headers, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(key_hash) DO UPDATE SET payment_hash = excluded.payment_hash, route = excluded.route, status = excluded.status, headers = excluded.headers, " +
          "body = excluded.body, created_at = excluded.created_at, expires_at = excluded.expires_at WHERE idempotency.expires_at <= excluded.created_at",
      )
      .bind(r.key_hash, r.payment_hash, r.route, r.status, JSON.stringify(r.headers), r.body, r.created_at, r.expires_at)
      .run();
    // Opportunistic cleanup of expired rows (cheap: indexed).
    await this.db.prepare("DELETE FROM idempotency WHERE expires_at <= ?").bind(r.created_at).run().catch(() => {});
  }
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The client's retry key: the Idempotency-Key header wins over the payment-identifier extension id. */
export function idempotencyKey(request: Request, payload: { extensions?: Record<string, unknown> } | null): { key?: string; invalid?: string } {
  const h = request.headers.get(IDEMPOTENCY_HEADER);
  if (h !== null) return IDEMPOTENCY_KEY_RE.test(h.trim()) ? { key: `h:${h.trim()}` } : { invalid: IDEMPOTENCY_HEADER };
  const ext = payload?.extensions?.[PAYMENT_IDENTIFIER] as { info?: { id?: unknown } } | undefined;
  const id = ext?.info?.id;
  if (id === undefined || id === null) return {};
  return typeof id === "string" && IDEMPOTENCY_KEY_RE.test(id) ? { key: `p:${id}` } : { invalid: PAYMENT_IDENTIFIER };
}
