/**
 * InvoiceGuard Durable Object: a strongly consistent "redeemed once" set for
 * x402 invoice ids. A Durable Object processes requests one at a time, so the
 * read-then-write in /claim is atomic. Entries expire via an alarm.
 *
 * Also a small fixed-window counter for the free basic trust check (POST /quota, see src/free_quota.ts). It runs on
 * separate object names ("quota-<n>"), never the invoice shards, and stores only hashed caller ids: no D1 writes.
 */

interface DOStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(opts?: { prefix?: string; limit?: number }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
}
interface DOState {
  storage: DOStorage;
}

export class InvoiceGuard {
  constructor(private state: DOState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/quota") return this.quota(request);
    if (request.method === "POST" && url.pathname === "/used") return this.used(request);
    if (request.method !== "POST" || url.pathname !== "/claim") return new Response("not found", { status: 404 });
    const { id, ttlSeconds } = (await request.json()) as { id?: string; ttlSeconds?: number };
    if (!id || typeof id !== "string" || id.length > 256) return new Response("bad request", { status: 400 });

    const key = `inv:${id}`;
    const now = Date.now();
    const until = await this.state.storage.get<number>(key);
    if (until !== undefined && until > now) return new Response("already claimed", { status: 409 });

    await this.state.storage.put(key, now + Math.max(60, Number(ttlSeconds) || 600) * 1000);
    if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(now + 3600_000);
    return new Response("claimed", { status: 200 });
  }

  /** POST /used {id}: 200 if this id is already claimed and unexpired, 404 if not, 400 if the body is bad. Read-only. */
  private async used(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
    const id = body?.id;
    if (!id || typeof id !== "string" || id.length > 256) return new Response("bad request", { status: 400 });
    const until = await this.state.storage.get<number>(`inv:${id}`);
    return new Response(until !== undefined && until > Date.now() ? "used" : "unused", {
      status: until !== undefined && until > Date.now() ? 200 : 404,
    });
  }

  /**
   * POST /quota {keys:[{key,max,resetAt}]}: all-or-nothing take. If any window is already at its max nothing is counted and
   * {allowed:false, blocked:<index>} is returned; otherwise every window is incremented. Single-threaded, so exact.
   */
  private async quota(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { keys?: { key?: unknown; max?: unknown; resetAt?: unknown }[] } | null;
    const keys = Array.isArray(body?.keys) ? body!.keys : [];
    if (!keys.length || keys.length > 8) return new Response("bad request", { status: 400 });
    const now = Date.now();
    const parsed = keys.map((k) => ({ key: `q:${String(k?.key ?? "").slice(0, 200)}`, max: Number(k?.max), resetAt: Number(k?.resetAt) }));
    if (parsed.some((k) => k.key === "q:" || !(k.max >= 0) || !(k.resetAt > now))) return new Response("bad request", { status: 400 });
    const cur = await Promise.all(parsed.map(async (k) => {
      const v = await this.state.storage.get<{ n: number; until: number }>(k.key);
      return v && v.until > now ? v.n : 0;
    }));
    const blocked = parsed.findIndex((k, i) => cur[i] >= k.max);
    if (blocked >= 0) return Response.json({ allowed: false, counts: cur, blocked });
    const counts = cur.map((n) => n + 1);
    for (let i = 0; i < parsed.length; i++) await this.state.storage.put(parsed[i].key, { n: counts[i], until: parsed[i].resetAt });
    if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(now + 3600_000);
    return Response.json({ allowed: true, counts });
  }

  /** Hourly cleanup of expired invoice ids and expired quota windows. */
  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.state.storage.list<number>({ prefix: "inv:" });
    const expired = [...entries].filter(([, until]) => until <= now).map(([k]) => k);
    const quotas = await this.state.storage.list<{ n: number; until: number }>({ prefix: "q:" });
    const qExpired = [...quotas].filter(([, v]) => !(v?.until > now)).map(([k]) => k);
    const all = [...expired, ...qExpired];
    for (let i = 0; i < all.length; i += 128) await this.state.storage.delete(all.slice(i, i + 128));
    if (entries.size > expired.length || quotas.size > qExpired.length) await this.state.storage.setAlarm(now + 3600_000);
  }
}
