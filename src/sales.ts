/**
 * Sales ledger: one D1 row per settled x402 payment (both rails), an owner-only summary, and an optional
 * best-effort alert (webhook and/or Cloudflare send_email). Recording never blocks or fails a paid response.
 */
import type { D1Like } from "./config";

/** Lumi's own wallets: their payments are test-buys / Bazaar refreshes and are excluded from revenue. */
export const OWN_WALLETS = [
  "0x7722DfAE6bbed2Fd02Dc07455c2f5BF14bE25E4a", // Base buyer (test-buys, Bazaar refresh)
  "0x5E617bac19912e6d212CB303ae84655E9E203532", // Base main (pay-to)
  "rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM", // XRPL main (pay-to)
  "rpvsTYDZmX1j1ndmEFG6YjjZZwp6VRtQRz", // XRPL demo buyer (test-buys)
  "GCKTH26VNR4H4WLCXS5DX6563XRQQXWP5QKQWFD6CHOGTZJ2N5GKBU2L", // Stellar wallet (pay-to + test-buyer)
  "4LDMGj8V3zCtsXhcNynncstLbfncPhF3GG46eken8EFC", // Solana buyer (test-buys; public address)
];

export interface SaleEvent {
  route: string;
  routeKey?: string;
  rail: "xrpl" | "base" | "stellar";
  network: string;
  asset: string;
  /** Decimal units (XRP, not drops; USDC, not atomic). */
  amount: string;
  usd?: number;
  payer?: string;
  tx: string;
  facilitator?: string;
  /** Client type of the paying request: "<ua_class>: <UA family>" (<= 40 chars, from the User-Agent; never an IP). */
  client?: string;
  ts?: number;
}

export interface SaleRow extends Required<Omit<SaleEvent, "routeKey" | "usd" | "payer" | "facilitator" | "client">> {
  routeKey: string | null;
  client: string | null;
  usd: number | null;
  payer: string | null;
  facilitator: string | null;
  isTest: boolean;
}

export interface SalesStore {
  insert(row: SaleRow): Promise<boolean>;
  since(tsMs: number): Promise<SaleRow[]>;
}

export class MemorySalesStore implements SalesStore {
  rows: SaleRow[] = [];
  async insert(row: SaleRow): Promise<boolean> {
    if (this.rows.some((r) => r.tx === row.tx)) return false;
    this.rows.push(row);
    return true;
  }
  async since(tsMs: number): Promise<SaleRow[]> {
    return this.rows.filter((r) => r.ts >= tsMs).sort((a, b) => b.ts - a.ts);
  }
}

export class D1SalesStore implements SalesStore {
  constructor(private db: D1Like) {}
  async insert(r: SaleRow): Promise<boolean> {
    let res: { meta?: { changes?: number } } | undefined;
    try {
      res = (await this.db
        .prepare(
          "INSERT OR IGNORE INTO sales (ts, route, route_key, rail, network, asset, amount, usd, payer, tx, facilitator, is_test, client) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(r.ts, r.route, r.routeKey, r.rail, r.network, r.asset, r.amount, r.usd, r.payer, r.tx, r.facilitator, r.isTest ? 1 : 0, r.client)
        .run()) as { meta?: { changes?: number } } | undefined;
    } catch (e) {
      // Migration 0023 (sales.client) not applied yet: record the sale without the client column rather than lose it.
      if (!/no (such )?column|has no column named client/i.test(String(e))) throw e;
      res = (await this.db
        .prepare(
          "INSERT OR IGNORE INTO sales (ts, route, route_key, rail, network, asset, amount, usd, payer, tx, facilitator, is_test) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(r.ts, r.route, r.routeKey, r.rail, r.network, r.asset, r.amount, r.usd, r.payer, r.tx, r.facilitator, r.isTest ? 1 : 0)
        .run()) as { meta?: { changes?: number } } | undefined;
    }
    return (res?.meta?.changes ?? 1) > 0;
  }
  async since(tsMs: number): Promise<SaleRow[]> {
    const out = (await this.db
      .prepare("SELECT * FROM sales WHERE ts >= ? ORDER BY ts DESC LIMIT 5000")
      .bind(tsMs)
      .all()) as { results?: Record<string, unknown>[] };
    return (out.results ?? []).map((x) => ({
      ts: Number(x.ts),
      route: String(x.route),
      routeKey: (x.route_key as string) ?? null,
      rail: x.rail as "xrpl" | "base" | "stellar",
      network: String(x.network),
      asset: String(x.asset),
      amount: String(x.amount),
      usd: x.usd == null ? null : Number(x.usd),
      payer: (x.payer as string) ?? null,
      tx: String(x.tx),
      facilitator: (x.facilitator as string) ?? null,
      client: (x.client as string) ?? null,
      isTest: Number(x.is_test) === 1,
    }));
  }
}

/** Record a sale, retrying once on a transient D1 error (a single D1 "internal error" lost the first Stellar sale row).
 *  Returns true when the row was written or already existed; throws only when both attempts fail. */
export async function insertWithRetry(store: SalesStore, row: SaleRow, waitMs = 250): Promise<boolean> {
  try {
    return await store.insert(row);
  } catch {
    await new Promise((r) => setTimeout(r, waitMs));
    return store.insert(row);
  }
}

export function isOwnWallet(addr: string | null | undefined, extra: string[] = []): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  return [...OWN_WALLETS, ...extra].some((w) => w.toLowerCase() === a);
}

export function toRow(e: SaleEvent, now: number, extraTestWallets: string[] = []): SaleRow {
  return {
    ts: e.ts ?? now,
    route: e.route,
    routeKey: e.routeKey ?? null,
    rail: e.rail,
    network: e.network,
    asset: e.asset,
    amount: e.amount,
    usd: typeof e.usd === "number" && Number.isFinite(e.usd) ? e.usd : null,
    payer: e.payer ?? null,
    tx: e.tx,
    facilitator: e.facilitator ?? null,
    client: e.client ? e.client.slice(0, 40) : null,
    isTest: isOwnWallet(e.payer, extraTestWallets),
  };
}

const DAY = 86_400_000;
const round = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

function windowStats(rows: SaleRow[]) {
  const byAsset: Record<string, number> = {};
  let usd = 0;
  for (const r of rows) {
    byAsset[r.asset] = round((byAsset[r.asset] ?? 0) + Number(r.amount));
    usd += r.usd ?? 0;
  }
  return { sales: rows.length, usd_list_total: round(usd, 4), by_asset: byAsset, payers: new Set(rows.map((r) => r.payer ?? "?")).size };
}

/** Owner summary: today (UTC), 7d, 30d and by-route, excluding Lumi's own test wallets. */
export async function salesSummary(store: SalesStore, now: number, opts: { includeTests?: boolean; recent?: number; refusedTx?: Iterable<string> } = {}) {
  const fetched = await store.since(now - 30 * DAY);
  // Payments refused at settlement (e.g. a Founder pack that lost the place race): settled on-chain but nothing was
  // delivered or credited, so they are not revenue. Listed separately until handled by hand (owner decides any refund).
  const refusedSet = new Set(opts.refusedTx ?? []);
  const refused = fetched.filter((r) => refusedSet.has(r.tx));
  const all = fetched.filter((r) => !refusedSet.has(r.tx));
  const real = opts.includeTests ? all : all.filter((r) => !r.isTest);
  const tests = all.filter((r) => r.isTest);
  const dayStart = Math.floor(now / DAY) * DAY;
  const byRoute: Record<string, ReturnType<typeof windowStats>> = {};
  for (const route of [...new Set(real.map((r) => r.route))].sort()) byRoute[route] = windowStats(real.filter((r) => r.route === route));
  const byRail: Record<string, ReturnType<typeof windowStats>> = {};
  for (const rail of [...new Set(real.map((r) => r.rail))].sort()) byRail[rail] = windowStats(real.filter((r) => r.rail === rail));
  return {
    generated_at: new Date(now).toISOString(),
    excludes_test_wallets: !opts.includeTests,
    test_wallets: OWN_WALLETS,
    today_utc: windowStats(real.filter((r) => r.ts >= dayStart)),
    last_7d: windowStats(real.filter((r) => r.ts >= now - 7 * DAY)),
    last_30d: windowStats(real),
    by_route_30d: byRoute,
    by_rail_30d: byRail,
    refused_at_settlement_30d: { ...windowStats(refused), excluded_from_revenue: true, txs: refused.map((r) => r.tx), note: "Paid but refused at settlement (no credit added). Not revenue. Any refund needs the owner's approval; nothing is refunded automatically." },
    test_sales_30d: { sales: tests.length, usd_list_total: round(tests.reduce((s, r) => s + (r.usd ?? 0), 0), 4) },
    recent: real.slice(0, opts.recent ?? 20).map((r) => ({
      ts: new Date(r.ts).toISOString(),
      route: r.routeKey ?? r.route,
      rail: r.rail,
      amount: `${r.amount} ${r.asset}`,
      usd: r.usd,
      payer: r.payer,
      tx: r.tx,
      ...(r.client ? { client: r.client } : {}),
      ...(r.isTest ? { is_test: true } : {}),
    })),
    note: "usd_list_total sums each sale's USD value: stablecoins at face value, XRP at the XRP actually received times the XRP/USD rate at settlement. Test wallets (Lumi's own wallets and demo buyers) and payments refused at settlement are excluded from revenue.",
  };
}

// ---------------------------------------------------------------- alert (opt-in, best effort)

export interface SendEmailBinding {
  send(message: unknown): Promise<void>;
}

export interface AlertConfig {
  webhookUrl?: string;
  email?: string;
  emailFrom?: string;
  emailBinding?: SendEmailBinding;
  includeTests?: boolean;
  /** Builds the send_email message (tests inject this; production uses cloudflare:email's EmailMessage). */
  makeMessage?: (from: string, to: string, raw: string) => unknown;
}

async function loadEmailMessage(): Promise<(from: string, to: string, raw: string) => unknown> {
  const mod = (await import("cloudflare:email")) as { EmailMessage: new (from: string, to: string, raw: string) => unknown };
  return (from, to, raw) => new mod.EmailMessage(from, to, raw);
}

export function alertText(r: SaleRow): string {
  return `Lumi sale: ${r.routeKey ?? r.route} paid ${r.amount} ${r.asset} on ${r.rail === "base" ? "Base" : r.rail === "stellar" ? "Stellar" : "XRPL"}${r.usd != null ? ` (~$${r.usd})` : ""}${r.isTest ? " [test wallet]" : ""} tx ${r.tx}`;
}

export function alertEnabled(cfg: AlertConfig): boolean {
  return Boolean(cfg.webhookUrl || (cfg.email && cfg.emailBinding && cfg.emailFrom));
}

/** Sends the alert to whatever is configured. Never throws. */
export async function sendSaleAlert(cfg: AlertConfig, row: SaleRow, doFetch: typeof fetch): Promise<string[]> {
  if (row.isTest && !cfg.includeTests) return [];
  const sent: string[] = [];
  const text = alertText(row);
  if (cfg.webhookUrl) {
    try {
      // Slack / Discord / generic: `text` and `content` cover the common incoming-webhook formats.
      const r = await doFetch(cfg.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, content: text, sale: { ...row, ts: new Date(row.ts).toISOString() } }),
      });
      if (r.ok) sent.push("webhook");
    } catch {
      /* best effort */
    }
  }
  if (cfg.email && cfg.emailFrom && cfg.emailBinding) {
    try {
      const mime = [
        `From: Lumi API <${cfg.emailFrom}>`,
        `To: ${cfg.email}`,
        `Subject: ${text.slice(0, 120)}`,
        `Message-ID: <${row.tx.slice(0, 40)}.${row.ts}@lumitrades.io>`,
        `Date: ${new Date(row.ts).toUTCString()}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        text,
        "",
      ].join("\r\n");
      const make = cfg.makeMessage ?? (await loadEmailMessage());
      await cfg.emailBinding.send(make(cfg.emailFrom, cfg.email, mime));
      sent.push("email");
    } catch (e) {
      // Best effort; the recipient is private, so it is redacted from the log line.
      console.log(JSON.stringify({ event: "sale_alert_email_error", error: String((e as Error)?.message ?? e).split(cfg.email).join("<recipient>").slice(0, 200) }));
    }
  }
  return sent;
}

/** Plain-text email via the same send_email binding as sale alerts (monitoring alerts, renewal reminders). Never throws.
 *  Cloudflare send_email only delivers to verified Email Routing destinations, so delivery to arbitrary addresses can fail;
 *  the result says whether it was accepted. The recipient is never logged. */
export async function sendPlainEmail(
  cfg: { emailFrom?: string; emailBinding?: SendEmailBinding; makeMessage?: (from: string, to: string, raw: string) => unknown },
  to: string,
  subject: string,
  text: string,
  msgId: string,
): Promise<boolean> {
  if (!cfg.emailFrom || !cfg.emailBinding || !to) return false;
  try {
    const mime = [
      `From: Lumi API <${cfg.emailFrom}>`,
      `To: ${to}`,
      `Subject: ${subject.replace(/[\r\n]+/g, " ").slice(0, 140)}`,
      `Message-ID: <${msgId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60)}@lumitrades.io>`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      text,
      "",
    ].join("\r\n");
    const make = cfg.makeMessage ?? (await loadEmailMessage());
    await cfg.emailBinding.send(make(cfg.emailFrom, to, mime));
    return true;
  } catch (e) {
    console.log(JSON.stringify({ event: "plain_email_error", error: String((e as Error)?.message ?? e).split(to).join("<recipient>").slice(0, 200) }));
    return false;
  }
}
