/** Shared helpers for the commerce routes (monitoring + feed). */
import type { SanctionsScreen } from "../sanctions";
import type { Config } from "../config";
import { b64decodeUtf8, json, type PaywallDeps } from "../x402";
import type { SaleOutcome, SendEmailBinding } from "../sales";
import type { CommerceStore } from "./store";
import type { CatalogStore } from "../trust/catalog";
import type { EvidenceStore } from "../trust/evidence";
import type { ReceiptStore } from "../trust/receipts";

export interface WaitUntil { waitUntil(p: Promise<unknown>): void }

export interface CommerceDeps {
  store: CommerceStore;
  cfg: Config;
  /** External fetch (webhooks, ledger). */
  fetch: typeof fetch;
  /** Fetch that answers Lumi's own hosts in-process (a Worker cannot fetch its own route). */
  endpointFetch: (url: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  isOwner: (req: Request) => Promise<boolean>;
  xrplRpc: string[];
  catalogStore: CatalogStore;
  evidence?: EvidenceStore;
  receipts?: ReceiptStore;
  paywall: (ctx?: WaitUntil) => PaywallDeps;
  /** Reports whether a settled payment was credited, for alerts deferred until then (Founder pack; see sales.ts). */
  saleOutcome?: (tx: string, o: SaleOutcome) => void;
  email: { from?: string; binding?: SendEmailBinding; makeMessage?: (from: string, to: string, raw: string) => unknown };
  extraTestWallets: string[];
  testPriceUsd: string;
  /** XRPL accounts whose signature Lumi accepts on audit reports (Lumi's payTo). */
  reportSigners: string[];
  log: (e: Record<string, unknown>) => void;
  /** OFAC SDN screen (src/sanctions.ts): listed payTos are refused at enrolment and never test-bought. */
  sanctions?: SanctionsScreen;
}

export const NO_STORE = { "Cache-Control": "no-store" };
export const POST_CORS = { "Access-Control-Allow-Origin": "*" };

export const bad = (error: string, detail?: string, extra: Record<string, unknown> = {}) => json(400, { error, ...(detail ? { detail } : {}), ...extra, note: "Not charged." }, NO_STORE);

export async function readJson(request: Request, max = 32_000): Promise<Record<string, any> | null> {
  const t = await request.text().catch(() => "");
  if (!t || t.length > max) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function bearer(request: Request): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1]?.trim() || request.headers.get("X-Lumi-Key")?.trim() || undefined;
}

/** https only, a DNS name (no IP literal, no localhost / internal names), no credentials. */
export function safeHttpsUrl(u: unknown): string | null {
  if (typeof u !== "string" || u.length > 500) return null;
  let x: URL;
  try { x = new URL(u); } catch { return null; }
  if (x.protocol !== "https:" || x.username || x.password) return null;
  const h = x.hostname.toLowerCase();
  if (!h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")) return null;
  if (/(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(h)) return null;
  return x.toString();
}

export function safeEmail(e: unknown): string | null {
  if (typeof e !== "string") return null;
  const v = e.trim();
  return v.length <= 200 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i.test(v) ? v : null;
}

/** Parse the 402 terms of an endpoint (PAYMENT-REQUIRED header, else JSON body). */
export async function parse402(r: Response): Promise<{ accepts: any[] } | null> {
  const h = r.headers.get("PAYMENT-REQUIRED");
  if (h) { try { const v = JSON.parse(b64decodeUtf8(h)); if (Array.isArray(v?.accepts)) return v; } catch { /* body */ } }
  try { const v: any = await r.json(); if (Array.isArray(v?.accepts)) return v; } catch { /* none */ }
  return null;
}

const STABLE = new Set(["USDC", "RLUSD"]);
/** USD value of one accepts[] option, or null when it cannot be priced (unknown token). */
export function acceptUsd(a: any, xrpUsd: number): number | null {
  const n = String(a?.network ?? "");
  const amt = String(a?.amount ?? a?.maxAmountRequired ?? "");
  if (n.startsWith("eip155:")) return /^\d+$/.test(amt) ? Number(amt) / 1e6 : null;
  if (n.startsWith("xrpl:")) {
    if (a?.asset === "XRP") return /^\d+$/.test(amt) ? (Number(amt) / 1e6) * xrpUsd : null;
    const sym = String(a?.extra?.symbol ?? "").toUpperCase();
    return STABLE.has(sym) && Number.isFinite(Number(amt)) ? Number(amt) : null;
  }
  return null;
}
export function acceptAsset(a: any): string {
  if (String(a?.network ?? "").startsWith("eip155:")) return "USDC";
  return a?.asset === "XRP" ? "XRP" : String(a?.extra?.symbol ?? a?.asset ?? "?");
}

export const monthKey = (t: number) => new Date(t).toISOString().slice(0, 7);
