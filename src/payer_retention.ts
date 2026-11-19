/**
 * Customer payer-data retention: HMAC matching, a recurring nightly purge of raw
 * wallet columns, log/webhook redaction helpers, and an owner access/deletion path.
 *
 * Default window is 90 days after the later of the last payment or key/plan expiry
 * (or created_at / last rotation when a free key has no expiry). Configurable via
 * PAYER_RETENTION_DAYS. Accounting fields (tx, amount, asset, date, route) are kept.
 * Logs and the sale-alert webhook never include a raw payer. No secrets are logged.
 */
import type { D1Like } from "./config";
import type { SaleRow } from "./sales";
import type { CommerceStore, FeedKey, FeedPayment, PackRefusalRow, PlanRow } from "./commerce/store";
import type { SalesStore } from "./sales";
import type { TrialStore, TrialUse } from "./trial";

export const DEFAULT_PAYER_RETENTION_DAYS = 90;
export const MIN_PAYER_HMAC_SECRET_LEN = 32;
/** Domain-separated HMAC input. Distinct from fleet-guard hashes if both secrets exist. */
export const PAYER_HMAC_PREFIX = "lumi-payer-v1|";

export function payerRetentionDays(raw?: string | null): number {
  const n = raw == null || String(raw).trim() === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : DEFAULT_PAYER_RETENTION_DAYS;
}

export function payerHmacSecretOk(secret?: string | null): secret is string {
  return typeof secret === "string" && secret.trim().length >= MIN_PAYER_HMAC_SECRET_LEN;
}

/** Lowercase + trim so EVM checksums and mixed-case XRPL/Stellar forms match one HMAC. */
export function normalizePayer(addr: string): string {
  return addr.trim().toLowerCase();
}

/** A submitted wallet for owner access/deletion: non-empty, no whitespace, plausible length. */
export function submittedWallet(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const w = raw.trim();
  if (w.length < 24 || w.length > 128 || /\s/.test(w)) return null;
  return w;
}

export async function hmacPayer(secret: string, addr: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret.trim()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(PAYER_HMAC_PREFIX + normalizePayer(addr))));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Current secret first, then previous (rotation). Duplicates dropped. */
export async function hmacPayerAll(secrets: Array<string | undefined | null>, addr: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of secrets) {
    if (!payerHmacSecretOk(s)) continue;
    const h = await hmacPayer(s, addr);
    if (!seen.has(h)) { seen.add(h); out.push(h); }
  }
  return out;
}

export function payerSecretsFromEnv(env: { PAYER_HMAC_SECRET?: string; PAYER_HMAC_SECRET_PREV?: string }): { current?: string; prev?: string; all: string[] } {
  const current = payerHmacSecretOk(env.PAYER_HMAC_SECRET) ? env.PAYER_HMAC_SECRET.trim() : undefined;
  const prev = payerHmacSecretOk(env.PAYER_HMAC_SECRET_PREV) ? env.PAYER_HMAC_SECRET_PREV.trim() : undefined;
  const all = [current, prev].filter((s, i, a): s is string => !!s && a.indexOf(s) === i);
  return { current, prev, all };
}

export async function bindPayer(secret: string | undefined, addr: string | null | undefined): Promise<{ payer: string | null; payer_hmac: string | null }> {
  const payer = addr && addr.trim() ? addr : null;
  if (!payer) return { payer: null, payer_hmac: null };
  if (!payerHmacSecretOk(secret)) return { payer, payer_hmac: null };
  return { payer, payer_hmac: await hmacPayer(secret, payer) };
}

/** Identity key used to group rows: prefer HMAC, else the normalised raw address. */
export function payerIdent(hmac?: string | null, raw?: string | null): string | null {
  if (hmac && hmac.trim()) return `h:${hmac.trim()}`;
  if (raw && raw.trim()) return `r:${normalizePayer(raw)}`;
  return null;
}

export interface TableCounts {
  sales: number;
  feed_keys: number;
  feed_payments: number;
  monitor_plans: number;
  monitor_pack_refusals: number;
  trial_uses: number;
}

export interface PurgeResult {
  retention_days: number;
  backfilled: TableCounts;
  nulled: TableCounts;
  /** Always true: tx, amount, asset, date and route are left in place. */
  kept_accounting: true;
}

export interface PayerRecord {
  table: keyof TableCounts;
  /** Payment or use time (ISO), when known. */
  at?: string;
  tx?: string;
  amount?: string;
  asset?: string;
  route?: string;
  key_id?: string;
  plan?: string;
  plan_ends_at?: string | null;
  has_raw: boolean;
}

export interface PayerInventory {
  matched: boolean;
  hmac_matched: boolean;
  raw_matched: boolean;
  retention_days: number;
  records: PayerRecord[];
  raw_still_stored: number;
  note: string;
}

export interface EraseResult {
  matched: boolean;
  hmac_matched: boolean;
  raw_nulled: number;
  tables: TableCounts;
  kept_accounting: true;
  note: string;
}

const ZERO: TableCounts = { sales: 0, feed_keys: 0, feed_payments: 0, monitor_plans: 0, monitor_pack_refusals: 0, trial_uses: 0 };
const copyCounts = (c: TableCounts = ZERO): TableCounts => ({ ...c });

function iso(ts: number | null | undefined): string | undefined {
  return typeof ts === "number" && Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : undefined;
}

export interface PayerRetentionOpts {
  secret?: string;
  secretPrev?: string;
  retentionDays: number;
  now: number;
}

export interface PayerMemoryStores {
  sales?: { rows: SaleRow[] };
  commerce?: {
    fkeys: Map<string, FeedKey>;
    pays: FeedPayment[];
    plans: PlanRow[];
    refusals: PackRefusalRow[];
  };
  trials?: { rows: TrialUse[] };
  erasure?: Array<{ ts: number; wallet_hmac: string; raw_nulled: number; tables_json: string; note?: string | null }>;
}

function secretsOf(opts: PayerRetentionOpts): string[] {
  return [opts.secret, opts.secretPrev].filter((s, i, a): s is string => payerHmacSecretOk(s) && a.indexOf(s) === i);
}

async function hashOpen(secret: string | undefined, addr: string | null | undefined): Promise<string | null> {
  if (!payerHmacSecretOk(secret) || !addr || !addr.trim()) return null;
  return hmacPayer(secret, addr);
}

// ---------------------------------------------------------------- memory path

export async function backfillMemory(stores: PayerMemoryStores, secret: string | undefined): Promise<TableCounts> {
  const out = copyCounts();
  if (!payerHmacSecretOk(secret)) return out;
  const fill = async (raw: string | null | undefined, existing: string | null | undefined): Promise<string | null | undefined> => {
    if (existing && existing.trim()) return existing;
    if (!raw || !raw.trim()) return existing ?? null;
    return hmacPayer(secret, raw);
  };
  if (stores.sales) {
    for (const r of stores.sales.rows) {
      if (r.payer && !r.payerHmac) { r.payerHmac = await hmacPayer(secret, r.payer); out.sales++; }
    }
  }
  if (stores.commerce) {
    for (const k of stores.commerce.fkeys.values()) {
      if ((k.wallet || k.wallet_lc) && !k.wallet_hmac) { k.wallet_hmac = await hmacPayer(secret, (k.wallet || k.wallet_lc)!); out.feed_keys++; }
    }
    for (const p of stores.commerce.pays) {
      if (p.payer && !p.payer_hmac) { p.payer_hmac = await hmacPayer(secret, p.payer); out.feed_payments++; }
    }
    for (const p of stores.commerce.plans) {
      if (p.payer && !p.payer_hmac) { p.payer_hmac = await hmacPayer(secret, p.payer); out.monitor_plans++; }
    }
    for (const p of stores.commerce.refusals) {
      if (p.payer && !p.payer_hmac) { p.payer_hmac = await hmacPayer(secret, p.payer); out.monitor_pack_refusals++; }
    }
  }
  if (stores.trials) {
    for (const r of stores.trials.rows) {
      if (r.wallet && !r.wallet_hmac) { r.wallet_hmac = await hmacPayer(secret, r.wallet); out.trial_uses++; }
    }
  }
  void fill;
  return out;
}

function retainMap(stores: PayerMemoryStores): Map<string, number> {
  const m = new Map<string, number>();
  const add = (id: string | null, ts: number | null | undefined) => {
    if (!id || typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return;
    m.set(id, Math.max(m.get(id) ?? 0, ts));
  };
  if (stores.sales) for (const r of stores.sales.rows) add(payerIdent(r.payerHmac, r.payer), r.ts);
  if (stores.commerce) {
    const keyById = stores.commerce.fkeys;
    const payByKey = new Map<string, number>();
    for (const p of stores.commerce.pays) {
      add(payerIdent(p.payer_hmac, p.payer), p.ts);
      payByKey.set(p.key_id, Math.max(payByKey.get(p.key_id) ?? 0, p.ts));
    }
    for (const k of keyById.values()) {
      const id = payerIdent(k.wallet_hmac, k.wallet_lc || k.wallet);
      add(id, k.plan_ends_at);
      add(id, k.created_at);
      add(id, k.rotated_at);
      add(id, payByKey.get(k.id));
      // A payment on this key also holds the key's expiry for that payer.
      const lastPay = payByKey.get(k.id);
      if (lastPay && id) {
        /* already added */
      }
      if (k.plan_ends_at) {
        for (const p of stores.commerce.pays) {
          if (p.key_id === k.id) add(payerIdent(p.payer_hmac, p.payer), k.plan_ends_at);
        }
      }
    }
    for (const p of stores.commerce.plans) {
      const id = payerIdent(p.payer_hmac, p.payer);
      add(id, p.created_at);
      add(id, p.ends_at);
    }
    for (const p of stores.commerce.refusals) add(payerIdent(p.payer_hmac, p.payer), p.created_at);
  }
  if (stores.trials) for (const r of stores.trials.rows) add(payerIdent(r.wallet_hmac, r.wallet), r.ts);
  return m;
}

export async function purgeMemory(stores: PayerMemoryStores, opts: PayerRetentionOpts): Promise<PurgeResult> {
  const backfilled = await backfillMemory(stores, opts.secret);
  const retain = retainMap(stores);
  const cutoffOf = (id: string | null) => (id && retain.has(id) ? retain.get(id)! + opts.retentionDays * 86_400_000 : null);
  const due = (id: string | null) => {
    const c = cutoffOf(id);
    return c != null && opts.now >= c;
  };
  const nulled = copyCounts();
  if (stores.sales) {
    for (const r of stores.sales.rows) {
      if (r.payer && due(payerIdent(r.payerHmac, r.payer))) { r.payer = null; nulled.sales++; }
    }
  }
  if (stores.commerce) {
    for (const k of stores.commerce.fkeys.values()) {
      if ((k.wallet || k.wallet_lc) && due(payerIdent(k.wallet_hmac, k.wallet_lc || k.wallet))) {
        k.wallet = null; k.wallet_lc = null; nulled.feed_keys++;
      }
    }
    for (const p of stores.commerce.pays) {
      if (p.payer && due(payerIdent(p.payer_hmac, p.payer))) { p.payer = null; nulled.feed_payments++; }
    }
    for (const p of stores.commerce.plans) {
      if (p.payer && due(payerIdent(p.payer_hmac, p.payer))) { p.payer = null; nulled.monitor_plans++; }
    }
    for (const p of stores.commerce.refusals) {
      if (p.payer && due(payerIdent(p.payer_hmac, p.payer))) { p.payer = null; nulled.monitor_pack_refusals++; }
    }
  }
  if (stores.trials) {
    for (const r of stores.trials.rows) {
      if (r.wallet && due(payerIdent(r.wallet_hmac, r.wallet))) { r.wallet = ""; nulled.trial_uses++; }
    }
  }
  return { retention_days: opts.retentionDays, backfilled, nulled, kept_accounting: true };
}

function memoryMatches(stores: PayerMemoryStores, hmacs: string[], wallet: string): {
  sales: SaleRow[];
  keys: FeedKey[];
  pays: FeedPayment[];
  plans: PlanRow[];
  refusals: PackRefusalRow[];
  trials: TrialUse[];
  hmacMatched: boolean;
  rawMatched: boolean;
} {
  const lc = normalizePayer(wallet);
  const hset = new Set(hmacs);
  let hmacMatched = false, rawMatched = false;
  const hitH = (h?: string | null, raw?: string | null) => {
    const hOk = !!(h && hset.has(h));
    const rOk = !!(raw && normalizePayer(raw) === lc);
    if (hOk) hmacMatched = true;
    if (rOk) rawMatched = true;
    return hOk || rOk;
  };
  const sales = stores.sales?.rows.filter((r) => hitH(r.payerHmac, r.payer)) ?? [];
  const keys = stores.commerce ? [...stores.commerce.fkeys.values()].filter((k) => hitH(k.wallet_hmac, k.wallet_lc || k.wallet)) : [];
  const pays = stores.commerce?.pays.filter((p) => hitH(p.payer_hmac, p.payer) || keys.some((k) => k.id === p.key_id)) ?? [];
  const plans = stores.commerce?.plans.filter((p) => hitH(p.payer_hmac, p.payer)) ?? [];
  const refusals = stores.commerce?.refusals.filter((p) => hitH(p.payer_hmac, p.payer)) ?? [];
  const trials = stores.trials?.rows.filter((r) => hitH(r.wallet_hmac, r.wallet)) ?? [];
  return { sales, keys, pays, plans, refusals, trials, hmacMatched, rawMatched };
}

function inventoryFromMatches(m: ReturnType<typeof memoryMatches>, retentionDays: number): PayerInventory {
  const records: PayerRecord[] = [];
  for (const r of m.sales) records.push({ table: "sales", at: iso(r.ts), tx: r.tx, amount: r.amount, asset: r.asset, route: r.routeKey ?? r.route, has_raw: !!r.payer });
  for (const k of m.keys) records.push({ table: "feed_keys", at: iso(k.created_at), key_id: k.id, plan: k.plan, plan_ends_at: iso(k.plan_ends_at) ?? null, has_raw: !!(k.wallet || k.wallet_lc) });
  for (const p of m.pays) records.push({ table: "feed_payments", at: iso(p.ts), tx: p.tx, amount: p.amount ?? undefined, asset: p.asset ?? undefined, key_id: p.key_id, has_raw: !!p.payer });
  for (const p of m.plans) records.push({ table: "monitor_plans", at: iso(p.created_at), tx: p.paid_tx, amount: p.paid_amount, asset: p.paid_asset, plan: p.plan, plan_ends_at: iso(p.ends_at) ?? null, has_raw: !!p.payer });
  for (const p of m.refusals) records.push({ table: "monitor_pack_refusals", at: iso(p.created_at), tx: p.paid_tx, amount: p.paid_amount, asset: p.paid_asset, plan: p.plan, has_raw: !!p.payer });
  for (const r of m.trials) records.push({ table: "trial_uses", at: iso(r.ts), route: r.route, has_raw: !!r.wallet });
  const raw_still_stored = records.filter((r) => r.has_raw).length;
  const matched = records.length > 0;
  return {
    matched,
    hmac_matched: m.hmacMatched,
    raw_matched: m.rawMatched,
    retention_days: retentionDays,
    records,
    raw_still_stored,
    note: "Inventory for the submitted wallet. Raw addresses are not returned. Accounting fields (tx, amount, asset, date, route) stay after a deletion. hello@lumitrades.io.",
  };
}

export async function inventoryMemory(stores: PayerMemoryStores, wallet: string, opts: PayerRetentionOpts): Promise<PayerInventory> {
  if (opts.secret) await backfillMemory(stores, opts.secret);
  const hmacs = await hmacPayerAll(secretsOf(opts), wallet);
  return inventoryFromMatches(memoryMatches(stores, hmacs, wallet), opts.retentionDays);
}

export async function eraseMemory(stores: PayerMemoryStores, wallet: string, opts: PayerRetentionOpts): Promise<EraseResult> {
  if (opts.secret) await backfillMemory(stores, opts.secret);
  const hmacs = await hmacPayerAll(secretsOf(opts), wallet);
  const m = memoryMatches(stores, hmacs, wallet);
  const tables = copyCounts();
  const nullOne = (has: boolean, key: keyof TableCounts) => { if (has) tables[key]++; };
  for (const r of m.sales) { nullOne(!!r.payer, "sales"); r.payer = null; }
  for (const k of m.keys) { nullOne(!!(k.wallet || k.wallet_lc), "feed_keys"); k.wallet = null; k.wallet_lc = null; }
  for (const p of m.pays) { nullOne(!!p.payer, "feed_payments"); p.payer = null; }
  for (const p of m.plans) { nullOne(!!p.payer, "monitor_plans"); p.payer = null; }
  for (const p of m.refusals) { nullOne(!!p.payer, "monitor_pack_refusals"); p.payer = null; }
  for (const r of m.trials) { nullOne(!!r.wallet, "trial_uses"); r.wallet = ""; }
  const raw_nulled = Object.values(tables).reduce((a, b) => a + b, 0);
  const hmac = hmacs[0] ?? (payerHmacSecretOk(opts.secret) ? await hashOpen(opts.secret, wallet) : "unknown");
  stores.erasure?.push({ ts: opts.now, wallet_hmac: hmac || "unknown", raw_nulled, tables_json: JSON.stringify(tables), note: "owner_delete" });
  return {
    matched: m.sales.length + m.keys.length + m.pays.length + m.plans.length + m.refusals.length + m.trials.length > 0,
    hmac_matched: m.hmacMatched,
    raw_nulled,
    tables,
    kept_accounting: true,
    note: "Raw wallet columns nulled. tx, amount, asset, date, route and HMACs are kept. A record of this request is stored as the HMAC only.",
  };
}

// ---------------------------------------------------------------- D1 path

async function allRows<T>(db: D1Like, sql: string, ...args: unknown[]): Promise<T[]> {
  try {
    return ((await db.prepare(sql).bind(...args).all<T>()).results ?? []) as T[];
  } catch (e) {
    if (/no such (table|column)/i.test(String(e))) return [];
    throw e;
  }
}

async function runCatch(db: D1Like, sql: string, ...args: unknown[]): Promise<number> {
  try {
    const r = (await db.prepare(sql).bind(...args).run()) as { meta?: { changes?: number } };
    return r?.meta?.changes ?? 0;
  } catch (e) {
    if (/no such (table|column)/i.test(String(e))) return 0;
    throw e;
  }
}

export async function backfillD1(db: D1Like, secret: string | undefined): Promise<TableCounts> {
  const out = copyCounts();
  if (!payerHmacSecretOk(secret)) return out;
  const fill = async (table: keyof TableCounts, idCol: string, rawCol: string, hmacCol: string) => {
    const rows = await allRows<{ id: string; raw: string }>(db, `SELECT ${idCol} AS id, ${rawCol} AS raw FROM ${table} WHERE ${rawCol} IS NOT NULL AND TRIM(${rawCol}) != '' AND (${hmacCol} IS NULL OR ${hmacCol} = '')`);
    for (const row of rows) {
      const h = await hmacPayer(secret, row.raw);
      out[table] += await runCatch(db, `UPDATE ${table} SET ${hmacCol} = ?2 WHERE ${idCol} = ?1 AND (${hmacCol} IS NULL OR ${hmacCol} = '')`, row.id, h);
    }
  };
  // sales uses integer id; tx is unique too but id is the PK.
  {
    const rows = await allRows<{ id: number; raw: string }>(db, "SELECT id, payer AS raw FROM sales WHERE payer IS NOT NULL AND TRIM(payer) != '' AND (payer_hmac IS NULL OR payer_hmac = '')");
    for (const row of rows) {
      const h = await hmacPayer(secret, row.raw);
      out.sales += await runCatch(db, "UPDATE sales SET payer_hmac = ?2 WHERE id = ?1 AND (payer_hmac IS NULL OR payer_hmac = '')", row.id, h);
    }
  }
  await fill("feed_keys", "id", "wallet", "wallet_hmac");
  // Some legacy rows may only have wallet_lc.
  {
    const rows = await allRows<{ id: string; raw: string }>(db, "SELECT id, COALESCE(wallet, wallet_lc) AS raw FROM feed_keys WHERE (wallet_hmac IS NULL OR wallet_hmac = '') AND COALESCE(wallet, wallet_lc) IS NOT NULL AND TRIM(COALESCE(wallet, wallet_lc)) != ''");
    for (const row of rows) {
      const h = await hmacPayer(secret, row.raw);
      out.feed_keys += await runCatch(db, "UPDATE feed_keys SET wallet_hmac = ?2 WHERE id = ?1 AND (wallet_hmac IS NULL OR wallet_hmac = '')", row.id, h);
    }
  }
  {
    const rows = await allRows<{ id: string; raw: string }>(db, "SELECT tx AS id, payer AS raw FROM feed_payments WHERE payer IS NOT NULL AND TRIM(payer) != '' AND (payer_hmac IS NULL OR payer_hmac = '')");
    for (const row of rows) {
      const h = await hmacPayer(secret, row.raw);
      out.feed_payments += await runCatch(db, "UPDATE feed_payments SET payer_hmac = ?2 WHERE tx = ?1 AND (payer_hmac IS NULL OR payer_hmac = '')", row.id, h);
    }
  }
  {
    const rows = await allRows<{ id: string; raw: string }>(db, "SELECT id, payer AS raw FROM monitor_plans WHERE payer IS NOT NULL AND TRIM(payer) != '' AND (payer_hmac IS NULL OR payer_hmac = '')");
    for (const row of rows) {
      const h = await hmacPayer(secret, row.raw);
      out.monitor_plans += await runCatch(db, "UPDATE monitor_plans SET payer_hmac = ?2 WHERE id = ?1 AND (payer_hmac IS NULL OR payer_hmac = '')", row.id, h);
    }
  }
  {
    const rows = await allRows<{ id: string; raw: string }>(db, "SELECT paid_tx AS id, payer AS raw FROM monitor_pack_refusals WHERE payer IS NOT NULL AND TRIM(payer) != '' AND (payer_hmac IS NULL OR payer_hmac = '')");
    for (const row of rows) {
      const h = await hmacPayer(secret, row.raw);
      out.monitor_pack_refusals += await runCatch(db, "UPDATE monitor_pack_refusals SET payer_hmac = ?2 WHERE paid_tx = ?1 AND (payer_hmac IS NULL OR payer_hmac = '')", row.id, h);
    }
  }
  {
    const rows = await allRows<{ id: string; raw: string }>(db, "SELECT nonce AS id, wallet AS raw FROM trial_uses WHERE wallet IS NOT NULL AND TRIM(wallet) != '' AND (wallet_hmac IS NULL OR wallet_hmac = '')");
    for (const row of rows) {
      const h = await hmacPayer(secret, row.raw);
      out.trial_uses += await runCatch(db, "UPDATE trial_uses SET wallet_hmac = ?2 WHERE nonce = ?1 AND (wallet_hmac IS NULL OR wallet_hmac = '')", row.id, h);
    }
  }
  return out;
}

async function retainMapD1(db: D1Like): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  const add = (id: string | null, ts: number | null | undefined) => {
    if (!id || typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return;
    m.set(id, Math.max(m.get(id) ?? 0, ts));
  };
  for (const r of await allRows<{ hmac: string | null; raw: string | null; ts: number }>(db, "SELECT payer_hmac AS hmac, payer AS raw, ts FROM sales")) {
    add(payerIdent(r.hmac, r.raw), r.ts);
  }
  const payByKey = new Map<string, { ts: number; id: string | null }[]>();
  for (const r of await allRows<{ hmac: string | null; raw: string | null; ts: number; key_id: string }>(db, "SELECT payer_hmac AS hmac, payer AS raw, ts, key_id FROM feed_payments")) {
    const id = payerIdent(r.hmac, r.raw);
    add(id, r.ts);
    const list = payByKey.get(r.key_id) ?? [];
    list.push({ ts: r.ts, id });
    payByKey.set(r.key_id, list);
  }
  for (const k of await allRows<{ hmac: string | null; raw: string | null; plan_ends_at: number | null; created_at: number; rotated_at: number | null; id: string }>(
    db, "SELECT wallet_hmac AS hmac, COALESCE(wallet, wallet_lc) AS raw, plan_ends_at, created_at, rotated_at, id FROM feed_keys",
  )) {
    const id = payerIdent(k.hmac, k.raw);
    add(id, k.plan_ends_at ?? undefined);
    add(id, k.created_at);
    add(id, k.rotated_at ?? undefined);
    for (const p of payByKey.get(k.id) ?? []) {
      add(id, p.ts);
      add(p.id, k.plan_ends_at ?? undefined);
    }
  }
  for (const r of await allRows<{ hmac: string | null; raw: string | null; created_at: number; ends_at: number }>(db, "SELECT payer_hmac AS hmac, payer AS raw, created_at, ends_at FROM monitor_plans")) {
    const id = payerIdent(r.hmac, r.raw);
    add(id, r.created_at);
    add(id, r.ends_at);
  }
  for (const r of await allRows<{ hmac: string | null; raw: string | null; created_at: number }>(db, "SELECT payer_hmac AS hmac, payer AS raw, created_at FROM monitor_pack_refusals")) {
    add(payerIdent(r.hmac, r.raw), r.created_at);
  }
  for (const r of await allRows<{ hmac: string | null; raw: string | null; ts: number }>(db, "SELECT wallet_hmac AS hmac, wallet AS raw, ts FROM trial_uses")) {
    add(payerIdent(r.hmac, r.raw), r.ts);
  }
  return m;
}

export async function purgeD1(db: D1Like, opts: PayerRetentionOpts): Promise<PurgeResult> {
  const backfilled = await backfillD1(db, opts.secret);
  const retain = await retainMapD1(db);
  const due = (id: string | null) => {
    if (!id || !retain.has(id)) return false;
    return opts.now >= retain.get(id)! + opts.retentionDays * 86_400_000;
  };
  const nulled = copyCounts();
  const bump = async (table: keyof TableCounts, sql: string, key: string | number) => {
    nulled[table] += await runCatch(db, sql, key);
  };
  for (const r of await allRows<{ id: number; hmac: string | null; raw: string | null }>(db, "SELECT id, payer_hmac AS hmac, payer AS raw FROM sales WHERE payer IS NOT NULL AND TRIM(payer) != ''")) {
    if (due(payerIdent(r.hmac, r.raw))) await bump("sales", "UPDATE sales SET payer = NULL WHERE id = ?1", r.id);
  }
  for (const r of await allRows<{ id: string; hmac: string | null; raw: string | null }>(db, "SELECT id, wallet_hmac AS hmac, COALESCE(wallet, wallet_lc) AS raw FROM feed_keys WHERE (wallet IS NOT NULL AND TRIM(wallet) != '') OR (wallet_lc IS NOT NULL AND TRIM(wallet_lc) != '')")) {
    if (due(payerIdent(r.hmac, r.raw))) await bump("feed_keys", "UPDATE feed_keys SET wallet = NULL, wallet_lc = NULL WHERE id = ?1", r.id);
  }
  for (const r of await allRows<{ id: string; hmac: string | null; raw: string | null }>(db, "SELECT tx AS id, payer_hmac AS hmac, payer AS raw FROM feed_payments WHERE payer IS NOT NULL AND TRIM(payer) != ''")) {
    if (due(payerIdent(r.hmac, r.raw))) await bump("feed_payments", "UPDATE feed_payments SET payer = NULL WHERE tx = ?1", r.id);
  }
  for (const r of await allRows<{ id: string; hmac: string | null; raw: string | null }>(db, "SELECT id, payer_hmac AS hmac, payer AS raw FROM monitor_plans WHERE payer IS NOT NULL AND TRIM(payer) != ''")) {
    if (due(payerIdent(r.hmac, r.raw))) await bump("monitor_plans", "UPDATE monitor_plans SET payer = NULL WHERE id = ?1", r.id);
  }
  for (const r of await allRows<{ id: string; hmac: string | null; raw: string | null }>(db, "SELECT paid_tx AS id, payer_hmac AS hmac, payer AS raw FROM monitor_pack_refusals WHERE payer IS NOT NULL AND TRIM(payer) != ''")) {
    if (due(payerIdent(r.hmac, r.raw))) await bump("monitor_pack_refusals", "UPDATE monitor_pack_refusals SET payer = NULL WHERE paid_tx = ?1", r.id);
  }
  for (const r of await allRows<{ id: string; hmac: string | null; raw: string | null }>(db, "SELECT nonce AS id, wallet_hmac AS hmac, wallet AS raw FROM trial_uses WHERE wallet IS NOT NULL AND TRIM(wallet) != ''")) {
    if (due(payerIdent(r.hmac, r.raw))) await bump("trial_uses", "UPDATE trial_uses SET wallet = '' WHERE nonce = ?1", r.id);
  }
  return { retention_days: opts.retentionDays, backfilled, nulled, kept_accounting: true };
}

type D1MatchRow = { table: keyof TableCounts; at?: number | null; tx?: string | null; amount?: string | null; asset?: string | null; route?: string | null; key_id?: string | null; plan?: string | null; plan_ends_at?: number | null; has_raw: number };

function inList(n: number, offset = 1): string {
  return Array.from({ length: n }, (_, i) => `?${i + offset}`).join(", ");
}

export async function inventoryD1(db: D1Like, wallet: string, opts: PayerRetentionOpts): Promise<PayerInventory> {
  if (opts.secret) await backfillD1(db, opts.secret);
  const hmacs = await hmacPayerAll(secretsOf(opts), wallet);
  const lc = normalizePayer(wallet);
  const records: PayerRecord[] = [];
  let hmacMatched = false, rawMatched = false;
  const mark = (hmac: string | null | undefined, raw: string | null | undefined) => {
    if (hmac && hmacs.includes(hmac)) hmacMatched = true;
    if (raw && normalizePayer(raw) === lc) rawMatched = true;
  };
  const args = [...hmacs, lc];
  const hmacPred = (col: string) => (hmacs.length ? `${col} IN (${inList(hmacs.length)}) OR ` : "") + `LOWER(TRIM(${col.replace("_hmac", "").replace("wallet", "COALESCE(wallet, wallet_lc)")})) = ?${hmacs.length + 1}`;
  // Explicit predicates per table to keep SQL obvious and safe.
  const hIn = hmacs.length ? `payer_hmac IN (${inList(hmacs.length)}) OR ` : "";
  const wIn = hmacs.length ? `wallet_hmac IN (${inList(hmacs.length)}) OR ` : "";
  void hmacPred;
  for (const r of await allRows<{ ts: number; tx: string; amount: string; asset: string; route: string; route_key: string | null; payer: string | null; payer_hmac: string | null }>(
    db, `SELECT ts, tx, amount, asset, route, route_key, payer, payer_hmac FROM sales WHERE ${hIn}LOWER(TRIM(payer)) = ?${hmacs.length + 1}`, ...args,
  )) {
    mark(r.payer_hmac, r.payer);
    records.push({ table: "sales", at: iso(r.ts), tx: r.tx, amount: r.amount, asset: r.asset, route: r.route_key ?? r.route, has_raw: !!r.payer });
  }
  const keys = await allRows<{ id: string; created_at: number; plan: string; plan_ends_at: number | null; wallet: string | null; wallet_lc: string | null; wallet_hmac: string | null }>(
    db, `SELECT id, created_at, plan, plan_ends_at, wallet, wallet_lc, wallet_hmac FROM feed_keys WHERE ${wIn}LOWER(TRIM(COALESCE(wallet, wallet_lc))) = ?${hmacs.length + 1}`, ...args,
  );
  const keyIds = keys.map((k) => k.id);
  for (const k of keys) {
    mark(k.wallet_hmac, k.wallet_lc || k.wallet);
    records.push({ table: "feed_keys", at: iso(k.created_at), key_id: k.id, plan: k.plan, plan_ends_at: iso(k.plan_ends_at) ?? null, has_raw: !!(k.wallet || k.wallet_lc) });
  }
  const payPred = `${hIn}LOWER(TRIM(payer)) = ?${hmacs.length + 1}` + (keyIds.length ? ` OR key_id IN (${inList(keyIds.length, args.length + 1)})` : "");
  for (const r of await allRows<{ ts: number; tx: string; amount: string | null; asset: string | null; key_id: string; payer: string | null; payer_hmac: string | null }>(
    db, `SELECT ts, tx, amount, asset, key_id, payer, payer_hmac FROM feed_payments WHERE ${payPred}`, ...args, ...keyIds,
  )) {
    mark(r.payer_hmac, r.payer);
    records.push({ table: "feed_payments", at: iso(r.ts), tx: r.tx, amount: r.amount ?? undefined, asset: r.asset ?? undefined, key_id: r.key_id, has_raw: !!r.payer });
  }
  for (const r of await allRows<{ created_at: number; paid_tx: string; paid_amount: string; paid_asset: string; plan: string; ends_at: number; payer: string | null; payer_hmac: string | null }>(
    db, `SELECT created_at, paid_tx, paid_amount, paid_asset, plan, ends_at, payer, payer_hmac FROM monitor_plans WHERE ${hIn}LOWER(TRIM(payer)) = ?${hmacs.length + 1}`, ...args,
  )) {
    mark(r.payer_hmac, r.payer);
    records.push({ table: "monitor_plans", at: iso(r.created_at), tx: r.paid_tx, amount: r.paid_amount, asset: r.paid_asset, plan: r.plan, plan_ends_at: iso(r.ends_at) ?? null, has_raw: !!r.payer });
  }
  for (const r of await allRows<{ created_at: number; paid_tx: string; paid_amount: string; paid_asset: string; plan: string; payer: string | null; payer_hmac: string | null }>(
    db, `SELECT created_at, paid_tx, paid_amount, paid_asset, plan, payer, payer_hmac FROM monitor_pack_refusals WHERE ${hIn}LOWER(TRIM(payer)) = ?${hmacs.length + 1}`, ...args,
  )) {
    mark(r.payer_hmac, r.payer);
    records.push({ table: "monitor_pack_refusals", at: iso(r.created_at), tx: r.paid_tx, amount: r.paid_amount, asset: r.paid_asset, plan: r.plan, has_raw: !!r.payer });
  }
  for (const r of await allRows<{ ts: number; route: string; wallet: string | null; wallet_hmac: string | null }>(
    db, `SELECT ts, route, wallet, wallet_hmac FROM trial_uses WHERE ${wIn}LOWER(TRIM(wallet)) = ?${hmacs.length + 1}`, ...args,
  )) {
    mark(r.wallet_hmac, r.wallet);
    records.push({ table: "trial_uses", at: iso(r.ts), route: r.route, has_raw: !!r.wallet });
  }
  return {
    matched: records.length > 0,
    hmac_matched: hmacMatched,
    raw_matched: rawMatched,
    retention_days: opts.retentionDays,
    records,
    raw_still_stored: records.filter((r) => r.has_raw).length,
    note: "Inventory for the submitted wallet. Raw addresses are not returned. Accounting fields (tx, amount, asset, date, route) stay after a deletion. hello@lumitrades.io.",
  };
}

export async function eraseD1(db: D1Like, wallet: string, opts: PayerRetentionOpts): Promise<EraseResult> {
  if (opts.secret) await backfillD1(db, opts.secret);
  const hmacs = await hmacPayerAll(secretsOf(opts), wallet);
  const lc = normalizePayer(wallet);
  const args = [...hmacs, lc];
  const hIn = hmacs.length ? `payer_hmac IN (${inList(hmacs.length)}) OR ` : "";
  const wIn = hmacs.length ? `wallet_hmac IN (${inList(hmacs.length)}) OR ` : "";
  const tables = copyCounts();
  tables.sales = await runCatch(db, `UPDATE sales SET payer = NULL WHERE payer IS NOT NULL AND TRIM(payer) != '' AND (${hIn}LOWER(TRIM(payer)) = ?${hmacs.length + 1})`, ...args);
  tables.feed_keys = await runCatch(db, `UPDATE feed_keys SET wallet = NULL, wallet_lc = NULL WHERE (wallet IS NOT NULL OR wallet_lc IS NOT NULL) AND (${wIn}LOWER(TRIM(COALESCE(wallet, wallet_lc))) = ?${hmacs.length + 1})`, ...args);
  tables.feed_payments = await runCatch(db, `UPDATE feed_payments SET payer = NULL WHERE payer IS NOT NULL AND TRIM(payer) != '' AND (${hIn}LOWER(TRIM(payer)) = ?${hmacs.length + 1})`, ...args);
  tables.monitor_plans = await runCatch(db, `UPDATE monitor_plans SET payer = NULL WHERE payer IS NOT NULL AND TRIM(payer) != '' AND (${hIn}LOWER(TRIM(payer)) = ?${hmacs.length + 1})`, ...args);
  tables.monitor_pack_refusals = await runCatch(db, `UPDATE monitor_pack_refusals SET payer = NULL WHERE payer IS NOT NULL AND TRIM(payer) != '' AND (${hIn}LOWER(TRIM(payer)) = ?${hmacs.length + 1})`, ...args);
  tables.trial_uses = await runCatch(db, `UPDATE trial_uses SET wallet = '' WHERE wallet IS NOT NULL AND TRIM(wallet) != '' AND (${wIn}LOWER(TRIM(wallet)) = ?${hmacs.length + 1})`, ...args);
  const raw_nulled = Object.values(tables).reduce((a, b) => a + b, 0);
  const hmac = hmacs[0] ?? "unknown";
  await runCatch(db, "INSERT INTO payer_erasure_requests (ts, wallet_hmac, raw_nulled, tables_json, note) VALUES (?1, ?2, ?3, ?4, ?5)", opts.now, hmac, raw_nulled, JSON.stringify(tables), "owner_delete");
  const matched = raw_nulled > 0 || (await inventoryD1(db, wallet, { ...opts, secret: undefined })).matched;
  return {
    matched,
    hmac_matched: hmacs.length > 0 && (tables.sales + tables.feed_keys + tables.feed_payments + tables.monitor_plans + tables.monitor_pack_refusals + tables.trial_uses > 0 || hmacs.length > 0),
    raw_nulled,
    tables,
    kept_accounting: true,
    note: "Raw wallet columns nulled. tx, amount, asset, date, route and HMACs are kept. A record of this request is stored as the HMAC only.",
  };
}

// ---------------------------------------------------------------- facade used by the scheduled handler and owner routes

export function memoryStoresFrom(sales: SalesStore, commerce: CommerceStore, trials: TrialStore): PayerMemoryStores | null {
  const s = sales as SalesStore & { rows?: SaleRow[] };
  const c = commerce as CommerceStore & { fkeys?: Map<string, FeedKey>; pays?: FeedPayment[]; plans?: PlanRow[]; refusals?: PackRefusalRow[] };
  const t = trials as TrialStore & { rows?: TrialUse[] };
  if (!Array.isArray(s.rows) && !c.fkeys && !Array.isArray(t.rows)) return null;
  return {
    sales: Array.isArray(s.rows) ? { rows: s.rows } : undefined,
    commerce: c.fkeys && c.pays && c.plans && c.refusals ? { fkeys: c.fkeys, pays: c.pays, plans: c.plans, refusals: c.refusals } : undefined,
    trials: Array.isArray(t.rows) ? { rows: t.rows } : undefined,
    erasure: [],
  };
}

export async function purgeCustomerPayers(opts: PayerRetentionOpts & { db?: D1Like | null; memory?: PayerMemoryStores | null }): Promise<PurgeResult> {
  if (opts.db) return purgeD1(opts.db, opts);
  if (opts.memory) return purgeMemory(opts.memory, opts);
  return { retention_days: opts.retentionDays, backfilled: copyCounts(), nulled: copyCounts(), kept_accounting: true };
}

export async function inventoryPayer(opts: PayerRetentionOpts & { db?: D1Like | null; memory?: PayerMemoryStores | null; wallet: string }): Promise<PayerInventory> {
  if (opts.db) return inventoryD1(opts.db, opts.wallet, opts);
  if (opts.memory) return inventoryMemory(opts.memory, opts.wallet, opts);
  return { matched: false, hmac_matched: false, raw_matched: false, retention_days: opts.retentionDays, records: [], raw_still_stored: 0, note: "No customer store is configured." };
}

export async function erasePayer(opts: PayerRetentionOpts & { db?: D1Like | null; memory?: PayerMemoryStores | null; wallet: string }): Promise<EraseResult> {
  if (opts.db) return eraseD1(opts.db, opts.wallet, opts);
  if (opts.memory) return eraseMemory(opts.memory, opts.wallet, opts);
  return { matched: false, hmac_matched: false, raw_nulled: 0, tables: copyCounts(), kept_accounting: true, note: "No customer store is configured." };
}

/** Drop raw payer / wallet fields from a log or webhook object. Keeps tx and other accounting fields. */
export function stripPayerFields<T extends Record<string, unknown>>(obj: T): Omit<T, "payer" | "payerHmac" | "payer_hmac" | "wallet" | "wallet_lc" | "wallet_hmac" | "signed" | "facilitatorPayer"> {
  const out = { ...obj } as Record<string, unknown>;
  delete out.payer;
  delete out.payerHmac;
  delete out.payer_hmac;
  delete out.wallet;
  delete out.wallet_lc;
  delete out.wallet_hmac;
  delete out.signed;
  return out as Omit<T, "payer" | "payerHmac" | "payer_hmac" | "wallet" | "wallet_lc" | "wallet_hmac" | "signed" | "facilitatorPayer">;
}
