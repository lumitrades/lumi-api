/**
 * x402 v2 resource-server ("merchant") side for the XRPL `exact` scheme,
 * written for the Workers runtime (fetch + Web Crypto only, no Node APIs).
 *
 * Wire format mirrors the reference XRPL implementation (T54 `x402-xrpl`,
 * PyPI/npm 0.3.x) so its buyer SDKs work unchanged:
 *   402 body + `PAYMENT-REQUIRED` header (base64 JSON PaymentRequired)
 *   client retries with `PAYMENT-SIGNATURE` (base64 JSON PaymentPayload holding a
 *   presigned XRPL Payment blob bound to our invoiceId)
 *   we call facilitator POST /verify then POST /settle, then serve the data with a
 *   `PAYMENT-RESPONSE` header (base64 JSON SettlementResponse incl. the tx hash).
 *
 * Difference from the reference FastAPI/Express middleware: invoices are
 * stateless HMAC tokens instead of an in-memory store, because Worker isolates
 * do not share memory. One-time redemption is enforced by a ReplayGuard
 * (Durable Object in production; memory for a single Node process).
 */

import type { SaleEvent } from "./sales";
import type { Config, DurableObjectNamespaceLike, IouOption, KVLike } from "./config";
import { isPaymentPayloadV2 } from "@x402/core/schemas";
import { cdpAuthHeaders, decodeExtensionResponses } from "./cdp";
import { IDEMPOTENCY_HEADER, IDEMPOTENCY_MAX_BODY, IDEMPOTENCY_TTL_MS, PAYMENT_IDENTIFIER, PAYMENT_IDENTIFIER_DECLARATION, idempotencyKey, sha256Hex, type IdempotencyStore } from "./idempotency";

export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";
/** Legacy/alias header name used in some x402 docs. */
export const HEADER_X_PAYMENT = "X-PAYMENT";

export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  /** Bazaar service metadata (optional, additive). */
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions: Record<string, unknown>;
}

export interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface Settlement {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

export interface Quote {
  /** Route + parameters this quote is for, e.g. "signal:XRP". Bound into the invoice. */
  routeKey: string;
  amountDrops: string;
  /** Optional stablecoin prices keyed by symbol (IOU value strings); offered for each matching cfg.ious entry. */
  amountsIou?: Partial<Record<string, string>>;
  /** Optional Base USDC price in atomic units (6 decimals); offered when cfg.evm is set. */
  amountEvm?: string;
  /** Optional Stellar USDC price in atomic units (7 decimals); offered when cfg.stellar is set. */
  amountStellar?: string;
  description: string;
  resourceUrl: string;
  /** x402 Bazaar discovery extension for this route (see bazaar.ts); a generic GET/JSON declaration when absent. */
  bazaar?: Record<string, unknown>;
  /** Bazaar service metadata copied onto `resource` (serviceName, tags, iconUrl). */
  service?: { serviceName?: string; tags?: string[]; iconUrl?: string };
  /** Free, truncated samples of every product (top-level `samples` in every 402 body/header, plus a Link header). */
  samplesUrl?: string;
  /** Live XRP pricing: the XRP amount is carried (MAC-protected) in the invoice id so a rate change between the
   *  402 and the paid retry cannot invalidate the quote. */
  liveDrops?: boolean;
  /** XRP/USD rate used to value XRP sales in the ledger. */
  xrpUsd?: number;
  /** Optional top-level hint in the 402 body/header (e.g. for a literally probed path template). */
  note?: string;
  /** The data behind this quote counts as stale after this time (ms): a payment is then refused before verify/settle (never charged). */
  staleAfterMs?: number;
  /** When the data behind the quote was produced (wall clock ms), for data_age_seconds in a stale refusal. */
  asOfMs?: number;
  /** Extra 402 extensions merged next to `bazaar` (e.g. the "sign-in-with-x" free-trial challenge). */
  extensions?: Record<string, unknown>;
  /** Optional top-level free-trial status (e.g. why a SIGN-IN-WITH-X trial attempt was not granted). */
  trial?: Record<string, unknown>;
}

// ---------------------------------------------------------------- encoding

export function b64encodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decodeUtf8(s: string): string {
  const bin = atob(s.trim());
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Deterministic JSON (sorted keys, no spaces), matching the reference SDK's header encoding. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function encodeHeader(obj: unknown): string {
  return b64encodeUtf8(canonicalJson(obj));
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------- invoices

const INVOICE_PREFIX = "lumi1";

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  return b64url(sig.slice(0, 16));
}

function macInput(cfg: Config, routeKey: string, amount: string, exp: string, nonce: string): string {
  return [INVOICE_PREFIX, routeKey, amount, cfg.network, cfg.payTo, exp, nonce].join("|");
}

/** invoiceId = lumi1.<routeKey>.<expiry base36>.<nonce>.<mac>, or lumi1.<routeKey>.<exp>.<nonce>.<drops>.<mac> (live XRP pricing) */
/** Every price offered in the quote is bound into the invoice MAC (one invoice covers all accepted assets). */
function quoteAmounts(cfg: Config, quote: Quote): string {
  const ious = offeredIous(cfg, quote).map(([o, amt]) => `,${o.symbol}:${o.currency}:${o.issuer}:${amt}`).join("");
  const evm = cfg.evm && quote.amountEvm ? `,EVM:${cfg.evm.network}:${cfg.evm.asset}:${cfg.evm.payTo}:${quote.amountEvm}` : "";
  const st = cfg.stellar && quote.amountStellar ? `,STELLAR:${cfg.stellar.network}:${cfg.stellar.asset}:${cfg.stellar.payTo}:${quote.amountStellar}` : "";
  return `XRP:${quote.amountDrops}${ious}${evm}${st}`;
}

function offeredIous(cfg: Config, quote: Quote): [IouOption, string][] {
  return cfg.ious.flatMap((o) => {
    const amt = quote.amountsIou?.[o.symbol];
    return amt ? [[o, amt] as [IouOption, string]] : [];
  });
}

export async function issueInvoiceId(cfg: Config, quote: Quote, nowMs = Date.now()): Promise<string> {
  const exp = Math.floor(nowMs / 1000 + cfg.invoiceTtlSeconds).toString(36);
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(9)));
  const mac = await hmac(cfg.invoiceSecret, macInput(cfg, quote.routeKey, quoteAmounts(cfg, quote), exp, nonce));
  return quote.liveDrops
    ? [INVOICE_PREFIX, quote.routeKey, exp, nonce, quote.amountDrops, mac].join(".")
    : [INVOICE_PREFIX, quote.routeKey, exp, nonce, mac].join(".");
}

export type InvoiceCheck =
  | { ok: true; expiresAt: number; amountDrops?: string }
  | { ok: false; reason: "malformed_invoice" | "invalid_invoice" | "invoice_expired" | "invoice_route_mismatch" };

export async function checkInvoiceId(
  cfg: Config,
  invoiceId: string,
  quote: Quote,
  nowMs = Date.now(),
): Promise<InvoiceCheck> {
  const parts = invoiceId.split(".");
  if ((parts.length !== 5 && parts.length !== 6) || parts[0] !== INVOICE_PREFIX) return { ok: false, reason: "malformed_invoice" };
  const [, routeKey, exp, nonce] = parts;
  const mac = parts[parts.length - 1];
  const drops = parts.length === 6 ? parts[4] : undefined;
  if (drops !== undefined && !/^[1-9]\d{0,11}$/.test(drops)) return { ok: false, reason: "malformed_invoice" };
  const q = drops ? { ...quote, amountDrops: drops } : quote;
  const expected = await hmac(cfg.invoiceSecret, macInput(cfg, routeKey, quoteAmounts(cfg, q), exp, nonce));
  if (!timingSafeEqual(mac, expected)) return { ok: false, reason: "invalid_invoice" };
  if (routeKey !== quote.routeKey) return { ok: false, reason: "invoice_route_mismatch" };
  const expiresAt = parseInt(exp, 36) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt < nowMs) return { ok: false, reason: "invoice_expired" };
  return drops ? { ok: true, expiresAt, amountDrops: drops } : { ok: true, expiresAt };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- replay guard

/**
 * Each invoice may be redeemed once. This MUST be enforced here: the facilitator
 * treats re-settling an already-validated blob as success (XRPL submission is
 * idempotent on the tx hash), so it will not stop a replayed PAYMENT-SIGNATURE.
 */
export interface ReplayGuard {
  /** Cheap pre-check (may have false negatives). */
  isUsed(invoiceId: string): Promise<boolean>;
  /** Atomically claim the invoice. Returns false if it was already claimed. */
  claim(invoiceId: string, ttlSeconds: number): Promise<boolean>;
}

/** Per-isolate memory guard. Correct for a single Node process; NOT across Worker isolates. */
export class MemoryReplayGuard implements ReplayGuard {
  private mem = new Map<string, number>();

  async isUsed(id: string): Promise<boolean> {
    const until = this.mem.get(id);
    return until !== undefined && until > Date.now();
  }

  async claim(id: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    for (const [k, until] of this.mem) if (until <= now) this.mem.delete(k);
    if (await this.isUsed(id)) return false;
    this.mem.set(id, now + ttlSeconds * 1000);
    return true;
  }
}

/** Memory + Workers KV. KV is eventually consistent, so a fast cross-region replay can slip through. */
export class KvReplayGuard extends MemoryReplayGuard {
  constructor(private kv: KVLike) {
    super();
  }
  async isUsed(id: string): Promise<boolean> {
    return (await super.isUsed(id)) || (await this.kv.get(`inv:${id}`)) !== null;
  }
  async claim(id: string, ttlSeconds: number): Promise<boolean> {
    if (await this.isUsed(id)) return false;
    await super.claim(id, ttlSeconds);
    await this.kv.put(`inv:${id}`, "1", { expirationTtl: Math.max(60, ttlSeconds) });
    return true;
  }
}

/** Strongly consistent guard backed by the InvoiceGuard Durable Object (16 shards). */
export class DurableObjectReplayGuard extends MemoryReplayGuard {
  constructor(private ns: DurableObjectNamespaceLike) {
    super();
  }
  private stub(id: string) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return this.ns.get(this.ns.idFromName(`shard-${h % 16}`));
  }
  async claim(id: string, ttlSeconds: number): Promise<boolean> {
    if (await super.isUsed(id)) return false;
    const res = await this.stub(id).fetch("https://invoice-guard/claim", {
      method: "POST",
      body: JSON.stringify({ id, ttlSeconds }),
    });
    if (res.status !== 200 && res.status !== 409) throw new Error(`invoice guard HTTP ${res.status}`);
    const ok = res.status === 200;
    if (ok) await super.claim(id, ttlSeconds);
    return ok;
  }
}

export function makeReplayGuard(opts: { durableObject?: DurableObjectNamespaceLike; kv?: KVLike }): ReplayGuard {
  if (opts.durableObject) return new DurableObjectReplayGuard(opts.durableObject);
  if (opts.kv) return new KvReplayGuard(opts.kv);
  return new MemoryReplayGuard();
}

// ---------------------------------------------------------------- requirements

/** XRP requirement (first XRPL option; Base USDC, when configured, is accepts[0]). */
export function buildRequirements(cfg: Config, quote: Quote, invoiceId: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: cfg.network,
    amount: quote.amountDrops,
    asset: "XRP",
    payTo: cfg.payTo,
    maxTimeoutSeconds: cfg.invoiceTtlSeconds,
    extra: { invoiceId, sourceTag: cfg.sourceTag },
  };
}

/**
 * All accepted options for a quote: Base USDC first (when configured; the option most x402 buyers and the Bazaar expect),
 * then XRP, then each XRPL stablecoin (RLUSD, USDC: issued tokens, 40-hex currency code, issuer in extra.issuer, amount
 * as the IOU value string), matching the x402-xrpl SDK's IOU wire format. XRPL SDKs pick their option by network/asset.
 */
export function buildAccepts(cfg: Config, quote: Quote, invoiceId: string): PaymentRequirements[] {
  const evm = buildEvmRequirement(cfg, quote, invoiceId);
  const out: PaymentRequirements[] = evm ? [evm] : [];
  out.push(buildRequirements(cfg, quote, invoiceId));
  for (const [o, amount] of offeredIous(cfg, quote)) {
    out.push({
      scheme: "exact",
      network: cfg.network,
      amount,
      asset: o.currency,
      payTo: cfg.payTo,
      maxTimeoutSeconds: cfg.invoiceTtlSeconds,
      extra: { invoiceId, sourceTag: cfg.sourceTag, issuer: o.issuer, symbol: o.symbol },
    });
  }
  const st = buildStellarRequirement(cfg, quote, invoiceId);
  if (st) out.push(st);
  return out;
}

/**
 * Stellar USDC option (after the XRPL options): x402 v2 `exact` scheme on Stellar (@x402/stellar): the buyer signs a
 * SEP-41 `transfer(from, payTo, amount)` on the USDC Stellar Asset Contract; the facilitator (OpenZeppelin Channels)
 * sponsors the network fee (`extra.areFeesSponsored`, required by the client) and submits it. `amount` has 7 decimals.
 */
export function buildStellarRequirement(cfg: Config, quote: Quote, invoiceId: string): PaymentRequirements | null {
  if (!cfg.stellar || !quote.amountStellar) return null;
  return {
    scheme: "exact",
    network: cfg.stellar.network,
    amount: quote.amountStellar,
    asset: cfg.stellar.asset,
    payTo: cfg.stellar.payTo,
    maxTimeoutSeconds: cfg.invoiceTtlSeconds,
    extra: { areFeesSponsored: true, invoiceId, symbol: "USDC", decimals: cfg.stellar.decimals },
  };
}

export const isStellarRequirement = (r: { network?: unknown }) => typeof r.network === "string" && r.network.startsWith("stellar:");

/**
 * Base USDC option (accepts[0] when configured): x402 v2 `exact` scheme for EVM, EIP-3009 transferWithAuthorization.
 * `amount` is in atomic units (6 decimals), `asset` is the USDC contract, `extra.name`/`extra.version` are the token's
 * EIP-712 domain (what @x402/evm signs against). `extra.invoiceId` binds the payment to this quote: standard x402 clients
 * echo `accepted` back unchanged, so the invoice comes back with it.
 */
export function buildEvmRequirement(cfg: Config, quote: Quote, invoiceId: string): PaymentRequirements | null {
  if (!cfg.evm || !quote.amountEvm) return null;
  return {
    scheme: "exact",
    network: cfg.evm.network,
    amount: quote.amountEvm,
    asset: cfg.evm.asset,
    payTo: cfg.evm.payTo,
    maxTimeoutSeconds: cfg.invoiceTtlSeconds,
    extra: { name: cfg.evm.eip712.name, version: cfg.evm.eip712.version, invoiceId, symbol: "USDC", decimals: cfg.evm.decimals },
  };
}

export const isEvmRequirement = (r: { network?: unknown }) => typeof r.network === "string" && r.network.startsWith("eip155:");

/** Human label for a requirement's asset. */
export function assetLabel(req: PaymentRequirements): string {
  return req.asset === "XRP" ? "XRP" : String(req.extra?.symbol ?? req.asset);
}

export async function buildPaymentRequired(cfg: Config, quote: Quote, error: string): Promise<PaymentRequired> {
  const invoiceId = await issueInvoiceId(cfg, quote);
  return {
    x402Version: 2,
    error,
    resource: { url: quote.resourceUrl, description: quote.description, mimeType: "application/json", ...(quote.service ?? {}) },
    accepts: buildAccepts(cfg, quote, invoiceId),
    extensions: { bazaar: quote.bazaar ?? BAZAAR_GET_JSON, [PAYMENT_IDENTIFIER]: PAYMENT_IDENTIFIER_DECLARATION, ...(quote.extensions ?? {}) },
    // Top level (not in `resource`, which clients echo to the facilitator): a free, zero-cost next step for hesitant buyers.
    ...(quote.samplesUrl ? { samples: quote.samplesUrl } : {}),
    ...(quote.note ? { note: quote.note } : {}),
    ...(quote.trial ? { trial: quote.trial } : {}),
  } as PaymentRequired;
}

/** x402 Bazaar discovery extension: every paid route is a plain GET returning JSON (inputs are in the URL path). */
const BAZAAR_GET_JSON = {
  info: { input: { type: "http", method: "GET" }, output: { type: "json" } },
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      input: {
        type: "object",
        properties: { type: { type: "string", const: "http" }, method: { type: "string", enum: ["GET"] } },
        required: ["type", "method"],
      },
      output: { type: "object", properties: { type: { type: "string" } } },
    },
    required: ["input"],
  },
};

// ---------------------------------------------------------------- responses

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": `${HEADER_PAYMENT_REQUIRED}, ${HEADER_PAYMENT_RESPONSE}, X-Correlation-ID, Retry-After, Idempotent-Replayed, X-Lumi-Product-Line, X-Lumi-Notice`,
};

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...headers },
  });
}

export async function paymentRequiredResponse(cfg: Config, quote: Quote, error: string): Promise<Response> {
  // Body uses the same canonical (sorted-key) order as the header, so naive string comparisons of the two match.
  const body = JSON.parse(canonicalJson(await buildPaymentRequired(cfg, quote, error)));
  return json(402, body, {
    [HEADER_PAYMENT_REQUIRED]: encodeHeader(body),
    "Cache-Control": "no-store",
    ...(quote.samplesUrl ? { Link: `<${quote.samplesUrl}>; rel="describedby"; title="free samples"` } : {}),
  });
}

function decodePaymentPayload(header: string): PaymentPayload | null {
  try {
    const obj = JSON.parse(b64decodeUtf8(header));
    if (!obj || typeof obj !== "object" || typeof obj.accepted !== "object" || obj.accepted === null) return null;
    return obj as PaymentPayload;
  } catch {
    return null;
  }
}

function sameRequirements(a: PaymentRequirements, b: PaymentRequirements): boolean {
  if (isStellarRequirement(a) || isStellarRequirement(b)) {
    return (
      a.scheme === b.scheme &&
      a.network === b.network &&
      String(a.amount) === String(b.amount) &&
      a.asset === b.asset &&
      a.payTo === b.payTo &&
      Number(a.maxTimeoutSeconds) === Number(b.maxTimeoutSeconds) &&
      a.extra?.invoiceId === b.extra?.invoiceId
    );
  }
  if (isEvmRequirement(a) || isEvmRequirement(b)) {
    const lc = (v: unknown) => String(v ?? "").toLowerCase();
    return (
      a.scheme === b.scheme &&
      a.network === b.network &&
      String(a.amount) === String(b.amount) &&
      lc(a.asset) === lc(b.asset) &&
      lc(a.payTo) === lc(b.payTo) &&
      Number(a.maxTimeoutSeconds) === Number(b.maxTimeoutSeconds) &&
      a.extra?.invoiceId === b.extra?.invoiceId &&
      a.extra?.name === b.extra?.name &&
      a.extra?.version === b.extra?.version
    );
  }
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    String(a.amount) === String(b.amount) &&
    a.asset === b.asset &&
    a.payTo === b.payTo &&
    Number(a.maxTimeoutSeconds) === Number(b.maxTimeoutSeconds) &&
    a.extra?.invoiceId === b.extra?.invoiceId &&
    (a.asset === "XRP" || a.extra?.issuer === b.extra?.issuer)
  );
}

function dropsToXrpStr(drops: string): string {
  const n = BigInt(drops);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export interface PaywallDeps {
  fetch: typeof fetch;
  replay: ReplayGuard;
  log?: (event: Record<string, unknown>) => void;
  /** Called once per successful settlement (sales ledger + alert). Errors are swallowed; it never blocks serving. */
  onSale?: (sale: SaleEvent) => Promise<void> | void;
  /** Idempotent-retry cache (Idempotency-Key / payment-identifier). Absent = retries rely on the replay guard alone. */
  idempotency?: IdempotencyStore;
}

/** USD list price of a quote (its stablecoin amount), so XRP and USDC sales can be summed on one scale. */
export function quoteUsd(quote: Quote): number | undefined {
  const iou = quote.amountsIou?.USDC ?? quote.amountsIou?.RLUSD;
  if (iou && Number.isFinite(Number(iou))) return Number(iou);
  if (quote.amountEvm && /^\d+$/.test(quote.amountEvm)) return Number(quote.amountEvm) / 1e6;
  if (quote.amountStellar && /^\d+$/.test(quote.amountStellar)) return Number(quote.amountStellar) / 1e7;
  return undefined;
}

async function emitSale(deps: PaywallDeps, sale: SaleEvent): Promise<void> {
  if (!deps.onSale || !sale.tx) return;
  try {
    await deps.onSale(sale);
  } catch (e) {
    deps.log?.({ event: "sale_record_error", tx: sale.tx, error: String(e) });
  }
}

const LEGACY_UNKNOWN = /^(submit_failed:|submit_missing_tx_hash|validation_failed:)/;

/**
 * Gate `serve` behind an x402 payment. `serve` only runs after the facilitator
 * reports a successful on-ledger settlement for exactly this quote.
 *
 * Idempotent retries: with an Idempotency-Key header (or payment-identifier extension id) and a payment, a served
 * response is cached; the same key + same payment returns it again without settling, the same key + a different payment
 * is refused with 409 (never charged). See src/idempotency.ts.
 */
export async function requirePayment(
  request: Request,
  cfg: Config,
  deps: PaywallDeps,
  quote: Quote,
  serve: (settlement: Settlement, paid: PaymentRequirements) => Promise<Response> | Response,
): Promise<Response> {
  const header = request.headers.get(HEADER_PAYMENT_SIGNATURE) || request.headers.get(HEADER_X_PAYMENT);
  const store = deps.idempotency;
  if (!header) return requirePaymentOnce(request, cfg, deps, quote, serve);
  const payload = decodePaymentPayload(header);
  const k = idempotencyKey(request, payload as { extensions?: Record<string, unknown> } | null);
  if (k.invalid) {
    return json(400, {
      error: "invalid_idempotency_key",
      detail: `${k.invalid === IDEMPOTENCY_HEADER ? "The Idempotency-Key header" : "The payment-identifier id"} must be 16-128 characters: letters, digits, - or _.`,
      note: "Not charged.",
    });
  }
  if (!k.key || !store) return requirePaymentOnce(request, cfg, deps, quote, serve);

  const invoiceId =
    (typeof payload?.payload?.invoiceId === "string" && payload.payload.invoiceId) ||
    (typeof payload?.accepted?.extra?.invoiceId === "string" && (payload.accepted.extra.invoiceId as string)) ||
    "";
  const keyHash = await sha256Hex(k.key);
  const paymentHash = await sha256Hex(invoiceId ? `invoice:${invoiceId}` : `header:${header}`);
  const replay = (r: { status: number; headers: Record<string, string>; body: string }) =>
    new Response(r.body, { status: r.status, headers: { ...CORS, ...r.headers, "Cache-Control": "no-store", "Idempotent-Replayed": "true" } });
  const lookup = async () => {
    try {
      return await store.get(keyHash, Date.now());
    } catch (e) {
      deps.log?.({ event: "idempotency_store_error", phase: "get", error: String(e).slice(0, 200) });
      return null;
    }
  };

  const hit = await lookup();
  if (hit) {
    if (hit.payment_hash !== paymentHash) {
      return json(409, {
        error: "idempotency_key_reused",
        detail: "This idempotency key was already used with a different payment. Use a new key for a new purchase.",
        note: "Not charged.",
      });
    }
    deps.log?.({ event: "idempotent_replay", route: quote.routeKey });
    return replay(hit);
  }

  const resp = await requirePaymentOnce(request, cfg, deps, quote, serve);
  if (resp.status === 200 && resp.headers.get(HEADER_PAYMENT_RESPONSE)) {
    const body = await resp.text();
    const headers: Record<string, string> = {};
    for (const h of ["Content-Type", HEADER_PAYMENT_RESPONSE, "Access-Control-Expose-Headers"]) {
      const v = resp.headers.get(h);
      if (v) headers[h] = v;
    }
    if (body.length <= IDEMPOTENCY_MAX_BODY) {
      const t = Date.now();
      await store
        .put({ key_hash: keyHash, payment_hash: paymentHash, route: quote.routeKey, status: 200, headers, body, created_at: t, expires_at: t + IDEMPOTENCY_TTL_MS })
        .catch((e) => deps.log?.({ event: "idempotency_store_error", phase: "put", error: String(e).slice(0, 200) }));
    }
    return new Response(body, { status: resp.status, headers: resp.headers });
  }
  // A concurrent duplicate lost the invoice race: once the winner has stored its response, serve that instead of a 402.
  if (resp.status === 402) {
    const err = await resp.clone().json().then((b: { error?: string }) => b?.error).catch(() => undefined);
    if (err === "invoice_already_used") {
      const again = await lookup();
      if (again && again.payment_hash === paymentHash) return replay(again);
    }
  }
  return resp;
}

async function requirePaymentOnce(
  request: Request,
  cfg: Config,
  deps: PaywallDeps,
  quote0: Quote,
  serve: (settlement: Settlement, paid: PaymentRequirements) => Promise<Response> | Response,
): Promise<Response> {
  let quote = quote0;
  const header = request.headers.get(HEADER_PAYMENT_SIGNATURE) || request.headers.get(HEADER_X_PAYMENT);
  if (!header) return paymentRequiredResponse(cfg, quote, "PAYMENT-SIGNATURE header is required");
  const staleNow = staleRefusal(quote);
  if (staleNow) return staleNow;

  const payload = decodePaymentPayload(header);
  // An unusable payment header re-quotes (402 + full accepts + PAYMENT-REQUIRED) so a client SDK can fix it and retry.
  if (!payload) return paymentRequiredResponse(cfg, quote, "invalid_payment_signature_header");
  if (payload.x402Version !== 2) return paymentRequiredResponse(cfg, quote, "invalid_x402_version");

  const invoiceId =
    (typeof payload.payload?.invoiceId === "string" && payload.payload.invoiceId) ||
    (typeof payload.accepted.extra?.invoiceId === "string" && (payload.accepted.extra.invoiceId as string)) ||
    "";
  if (!invoiceId) return paymentRequiredResponse(cfg, quote, "missing_invoiceId");

  const check = await checkInvoiceId(cfg, invoiceId, quote);
  if (!check.ok) return paymentRequiredResponse(cfg, quote, check.reason);
  // Live XRP pricing: honour the XRP amount this invoice was issued with (MAC-checked above).
  if (check.amountDrops) quote = { ...quote, amountDrops: check.amountDrops };

  const expected = buildAccepts(cfg, quote, invoiceId).find((r) => sameRequirements(r, payload.accepted));
  if (!expected) {
    return paymentRequiredResponse(cfg, quote, "payment_requirements_mismatch");
  }
  if (await deps.replay.isUsed(invoiceId)) {
    return paymentRequiredResponse(cfg, quote, "invoice_already_used");
  }
  // Base (EVM) payments take their own path; everything below is the unchanged XRPL flow.
  if (isEvmRequirement(expected)) return requireEvmPayment(payload, expected, invoiceId, check.expiresAt, cfg, deps, quote, serve);
  if (isStellarRequirement(expected)) return requireStellarPayment(payload, expected, invoiceId, check.expiresAt, cfg, deps, quote, serve);

  const facilitatorBody = JSON.stringify({ paymentPayload: payload, paymentRequirements: expected });
  const post = (path: string) =>
    deps.fetch(`${cfg.facilitatorUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: facilitatorBody,
    });

  // ---- verify (no money moves; safe to retry)
  let verifyResp: Response;
  try {
    verifyResp = await post("/verify");
  } catch {
    return transient("facilitator_unavailable");
  }
  if (verifyResp.status === 408 || verifyResp.status === 429 || verifyResp.status >= 500) {
    return transient("facilitator_unavailable", verifyResp.headers.get("Retry-After"));
  }
  const verifyJson = (await verifyResp.json().catch(() => null)) as Record<string, unknown> | null;
  if (verifyResp.status !== 200 || !verifyJson || typeof verifyJson.isValid !== "boolean") {
    return json(502, { error: "invalid_verify_response", retryable: false, phase: "verify", settlementAttempted: false });
  }
  if (!verifyJson.isValid) {
    const reason = String(verifyJson.invalidReason || "verify_failed");
    if (reason === "verifiable_intent_denied") {
      return json(403, { error: reason, retryable: false, phase: "verify", settlementAttempted: false });
    }
    return paymentRequiredResponse(cfg, quote, `verify_failed:${reason}`);
  }

  // Atomically claim the invoice before settling, so a replayed or concurrent
  // duplicate PAYMENT-SIGNATURE can never be served twice.
  const ttl = Math.max(60, Math.ceil((check.expiresAt - Date.now()) / 1000) + 60);
  let claimed: boolean;
  try {
    claimed = await deps.replay.claim(invoiceId, ttl);
  } catch {
    return transient("invoice_guard_unavailable");
  }
  if (!claimed) return paymentRequiredResponse(cfg, quote, "invoice_already_used");
  const staleXrpl = staleRefusal(quote);
  if (staleXrpl) return staleXrpl;

  // ---- settle (submits the presigned Payment to the XRP Ledger)
  let settleResp: Response;
  try {
    settleResp = await post("/settle");
  } catch {
    return settlementUnknown();
  }
  const settleJson = (await settleResp.json().catch(() => null)) as Record<string, unknown> | null;
  if (settleResp.status !== 200) {
    if (settleJson?.settlementAttempted === true) return settlementUnknown();
    return json(502, {
      error: `settle_http_error:${settleResp.status}`,
      reason: "settlement_status_unknown",
      retryable: false,
      phase: "settle",
      settlementAttempted: true,
    });
  }
  if (!settleJson || typeof settleJson.success !== "boolean") return settlementUnknown();
  if (!settleJson.success) {
    if (LEGACY_UNKNOWN.test(String(settleJson.errorReason || ""))) return settlementUnknown();
    return paymentRequiredResponse(cfg, quote, `settle_failed:${settleJson.errorReason ?? "unknown"}`);
  }

  const settlement: Settlement = {
    success: true,
    transaction: String(settleJson.transaction || ""),
    network: String(settleJson.network || cfg.network),
    payer: typeof settleJson.payer === "string" ? settleJson.payer : undefined,
  };
  deps.log?.({
    event: "x402_settled",
    route: quote.routeKey,
    asset: assetLabel(expected),
    amount: expected.amount,
    amountDrops: expected.asset === "XRP" ? quote.amountDrops : undefined,
    network: settlement.network,
    tx: settlement.transaction,
    payer: settlement.payer,
  });
  await emitSale(deps, {
    route: quote.routeKey.split(":")[0],
    routeKey: quote.routeKey,
    rail: "xrpl",
    network: settlement.network,
    asset: assetLabel(expected),
    amount: expected.asset === "XRP" ? dropsToXrpStr(expected.amount) : expected.amount,
    // XRP sales are valued at the XRP actually received times the XRP/USD rate; stablecoins at face value.
    usd: expected.asset === "XRP" && quote.xrpUsd ? Math.round((Number(expected.amount) / 1e6) * quote.xrpUsd * 1e6) / 1e6 : expected.asset === "XRP" ? undefined : Number(expected.amount) || quoteUsd(quote),
    payer: settlement.payer,
    tx: settlement.transaction,
    facilitator: "t54",
  });

  const resp = await serve(settlement, expected);
  const out = new Response(resp.body, resp);
  out.headers.set(HEADER_PAYMENT_RESPONSE, settleResp.headers.get(HEADER_PAYMENT_RESPONSE) || encodeHeader(settlement));
  out.headers.set("Cache-Control", "no-store");
  return out;
}

/** Data went stale between the quote and the payment: refuse before anything is settled (never charged). */
export function staleRefusal(quote: Quote, now = Date.now()): Response | null {
  if (quote.staleAfterMs === undefined || now <= quote.staleAfterMs) return null;
  return json(
    503,
    {
      error: "stale_data",
      detail: "The data behind this quote passed its stale_after time, so the payment was not settled.",
      data_age_seconds: quote.asOfMs !== undefined ? Math.max(0, Math.round((now - quote.asOfMs) / 1000)) : null,
      retry_after_seconds: 300,
      stale_after: new Date(quote.staleAfterMs).toISOString(),
      retryable: true,
      settlementAttempted: false,
      note: "Not charged.",
    },
    { "Retry-After": "300" },
  );
}

function transient(reason: string, retryAfter?: string | null): Response {
  const ra = Math.max(0, Number(retryAfter) || 5);
  const correlationId = crypto.randomUUID();
  return json(
    503,
    { error: reason, reason, retryable: true, retryAfter: ra, correlationId, phase: "verify", settlementAttempted: false },
    { "Retry-After": String(ra), "X-Correlation-ID": correlationId },
  );
}

function settlementUnknown(): Response {
  const correlationId = crypto.randomUUID();
  return json(
    409,
    {
      error: "settlement_status_unknown",
      reason: "settlement_status_unknown",
      retryable: false,
      correlationId,
      phase: "settle",
      settlementAttempted: true,
    },
    { "X-Correlation-ID": correlationId },
  );
}

// ---------------------------------------------------------------- Base (EVM) flow

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const NONCE_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT_RE = /^\d{1,78}$/;
/** Seconds an EIP-3009 authorization must still be valid for when we start, so settlement can land on-chain. */
const MIN_VALIDITY_SECONDS = 10;

export interface Eip3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/** The x402 `exact` EVM payload (EIP-3009 transferWithAuthorization), or null when the shape is wrong. */
export function parseEip3009(payload: PaymentPayload): { authorization: Eip3009Authorization; signature: string } | null {
  const p = payload.payload as Record<string, any> | undefined;
  const a = p?.authorization;
  if (!a || typeof a !== "object" || typeof p?.signature !== "string" || !/^0x[0-9a-fA-F]{130,}$/.test(p.signature)) return null;
  const auth = Object.fromEntries(
    ["from", "to", "value", "validAfter", "validBefore", "nonce"].map((k) => [k, typeof a[k] === "number" ? String(a[k]) : a[k]]),
  ) as Eip3009Authorization;
  if (!ADDRESS_RE.test(auth.from ?? "") || !ADDRESS_RE.test(auth.to ?? "") || !NONCE_RE.test(auth.nonce ?? "")) return null;
  if (![auth.value, auth.validAfter, auth.validBefore].every((v) => typeof v === "string" && UINT_RE.test(v))) return null;
  return { authorization: auth, signature: p.signature };
}

/**
 * Base USDC settlement through an x402 facilitator (Coinbase CDP when its API key is configured, PayAI as the automatic keyless fallback). Same guarantees as the XRPL path:
 * the paid body is already built (freshness gate ran before the 402), the invoice is claimed exactly once in the
 * replay guard before settlement, and the EIP-3009 authorization nonce is claimed too, so one signed authorization
 * can never be redeemed against two invoices even if a facilitator treats a re-settle as success.
 */
async function requireEvmPayment(
  payload: PaymentPayload,
  expected: PaymentRequirements,
  invoiceId: string,
  expiresAt: number,
  cfg: Config,
  deps: PaywallDeps,
  quote: Quote,
  serve: (settlement: Settlement, paid: PaymentRequirements) => Promise<Response> | Response,
): Promise<Response> {
  const evm = cfg.evm!;
  // Malformed EVM payloads re-quote (402 + accepts) like every other unusable payment, so the client can retry.
  if (!isPaymentPayloadV2(payload)) return paymentRequiredResponse(cfg, quote, "invalid_payment_payload");
  const parsed = parseEip3009(payload);
  if (!parsed) return paymentRequiredResponse(cfg, quote, "invalid_evm_payload");
  const { authorization: auth } = parsed;
  if (auth.to.toLowerCase() !== evm.payTo.toLowerCase()) return paymentRequiredResponse(cfg, quote, "authorization_payto_mismatch");
  if (BigInt(auth.value) !== BigInt(expected.amount)) return paymentRequiredResponse(cfg, quote, "authorization_amount_mismatch");
  const nowS = Math.floor(Date.now() / 1000);
  if (BigInt(auth.validBefore) < BigInt(nowS + MIN_VALIDITY_SECONDS)) return paymentRequiredResponse(cfg, quote, "authorization_expired");
  if (BigInt(auth.validAfter) > BigInt(nowS + 5)) return paymentRequiredResponse(cfg, quote, "authorization_not_yet_valid");

  const nonceKey = `eip3009:${expected.network}:${expected.asset.toLowerCase()}:${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`;
  if (await deps.replay.isUsed(nonceKey)) return paymentRequiredResponse(cfg, quote, "authorization_already_used");

  const fac = evmFacilitators(cfg, payload, expected, quote, deps);

  // ---- verify (no money moves; safe to retry). Facilitators answer an invalid payment with 200 or 400 + isValid:false.
  // CDP first (when configured); any CDP-side failure falls back to the keyless facilitator.
  let verified: FacilitatorCall | null = null;
  for (const f of fac) {
    const r = await f.call("verify");
    const last = f === fac[fac.length - 1];
    if (r.kind === "error") {
      if (!last) {
        deps.log?.({ event: "x402_facilitator_fallback", phase: "verify", from: f.name, status: r.status ?? null, reason: r.reason });
        continue;
      }
      if (r.reason === "bad_json") {
        return json(502, { error: "invalid_verify_response", retryable: false, phase: "verify", settlementAttempted: false });
      }
      return transient("facilitator_unavailable", r.retryAfter);
    }
    const v = r.json;
    if (typeof v.isValid !== "boolean" || (v.isValid && r.status !== 200)) {
      if (!last) {
        deps.log?.({ event: "x402_facilitator_fallback", phase: "verify", from: f.name, status: r.status, reason: "invalid_verify_response" });
        continue;
      }
      return json(502, { error: "invalid_verify_response", retryable: false, phase: "verify", settlementAttempted: false });
    }
    if (!v.isValid) {
      const reason = String(v.invalidReason || "verify_failed");
      if (!last && facilitatorSideReason(reason)) {
        deps.log?.({ event: "x402_facilitator_fallback", phase: "verify", from: f.name, status: r.status, reason });
        continue;
      }
      return paymentRequiredResponse(cfg, quote, `verify_failed:${reason}`);
    }
    verified = { facilitator: f, response: r };
    break;
  }
  if (!verified) return transient("facilitator_unavailable");

  // ---- one-time redemption: the invoice and the authorization nonce
  const ttl = Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000) + 60);
  const nonceTtl = Math.max(ttl, Math.min(86_400 * 7, Number(auth.validBefore) - nowS + 60));
  try {
    if (!(await deps.replay.claim(invoiceId, ttl))) return paymentRequiredResponse(cfg, quote, "invoice_already_used");
    if (!(await deps.replay.claim(nonceKey, nonceTtl))) return paymentRequiredResponse(cfg, quote, "authorization_already_used");
  } catch {
    return transient("invoice_guard_unavailable");
  }
  const staleEvm = staleRefusal(quote);
  if (staleEvm) return staleEvm;

  // ---- settle (the facilitator submits transferWithAuthorization on Base) with the facilitator that verified.
  // Fallback after a CDP settle failure is safe: an EIP-3009 authorization (from + nonce) can execute on-chain at most
  // once, so a second facilitator can never move the buyer's USDC twice; it either settles the not-yet-used
  // authorization or fails, which is reported as settlement_status_unknown exactly as before.
  let settleFac = verified.facilitator;
  let s = await settleFac.call("settle");
  if (settleFac !== fac[fac.length - 1] && cdpSettleShouldFallBack(s)) {
    const next = fac[fac.indexOf(settleFac) + 1];
    deps.log?.({
      event: "x402_facilitator_fallback",
      phase: "settle",
      from: settleFac.name,
      status: s.status ?? null,
      reason: s.kind === "error" ? s.reason : String(s.json.errorReason ?? "unknown"),
    });
    settleFac = next;
    s = await settleFac.call("settle");
  }
  if (s.kind === "error" && s.status === undefined) return settlementUnknown();
  const settleResp = { status: s.status!, headers: s.headers! };
  const settleJson = s.kind === "ok" ? s.json : null;
  if (settleFac.name === "cdp") logBazaar(deps, quote, "settle", s.headers);
  const tx = typeof settleJson?.transaction === "string" ? settleJson.transaction : "";
  if (!settleJson || typeof settleJson.success !== "boolean") return settlementUnknown();
  if (!settleJson.success || settleResp.status !== 200) {
    // A definite refusal (nothing submitted) gets a fresh quote; anything that may have reached the chain is "unknown".
    const definite = !settleJson.success && !tx && settleResp.status >= 200 && settleResp.status < 500 && settleResp.status !== 408 && settleResp.status !== 429;
    if (!definite) return settlementUnknown();
    return paymentRequiredResponse(cfg, quote, `settle_failed:${String(settleJson.errorReason ?? "unknown")}`);
  }

  const settlement: Settlement = {
    success: true,
    transaction: tx,
    network: String(settleJson.network || expected.network),
    // The signed EIP-3009 `from` is the account that was debited. Facilitators may echo it lowercased (PayAI does),
    // so report the payer exactly as signed (EIP-55 checksummed from @x402/evm) and log any facilitator disagreement.
    payer: auth.from,
  };
  const facPayer = typeof settleJson.payer === "string" ? settleJson.payer : "";
  if (facPayer && facPayer.toLowerCase() !== auth.from.toLowerCase()) {
    deps.log?.({ event: "x402_payer_mismatch", route: quote.routeKey, signed: auth.from, facilitator: facPayer, tx });
  }
  deps.log?.({
    event: "x402_settled",
    route: quote.routeKey,
    asset: assetLabel(expected),
    amount: expected.amount,
    network: settlement.network,
    tx: settlement.transaction,
    payer: settlement.payer,
    facilitator: settleFac.name,
  });
  await emitSale(deps, {
    route: quote.routeKey.split(":")[0],
    routeKey: quote.routeKey,
    rail: "base",
    network: settlement.network,
    asset: "USDC",
    amount: (Number(expected.amount) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""),
    usd: quoteUsd(quote),
    payer: settlement.payer,
    tx: settlement.transaction,
    facilitator: settleFac.name,
  });

  const resp = await serve(settlement, expected);
  const out = new Response(resp.body, resp);
  out.headers.set(HEADER_PAYMENT_RESPONSE, settleResp.headers.get(HEADER_PAYMENT_RESPONSE) || encodeHeader(settlement));
  out.headers.set("Cache-Control", "no-store");
  return out;
}

// ---------------------------------------------------------------- EVM facilitators (CDP primary, keyless fallback)

type FacilitatorResult =
  | { kind: "ok"; status: number; headers: Headers; json: Record<string, unknown> }
  | { kind: "error"; status?: number; headers?: Headers; retryAfter?: string | null; reason: string };

interface EvmFacilitator {
  name: "cdp" | "fallback";
  call(phase: "verify" | "settle"): Promise<FacilitatorResult>;
}
interface FacilitatorCall {
  facilitator: EvmFacilitator;
  response: FacilitatorResult;
}

/** Verify/settle invalid reasons that say "this facilitator can't handle it" (try the next one) rather than "this payment is bad". */
function facilitatorSideReason(reason: string): boolean {
  return /bazaar|extension|unsupported|not_supported|unauthori[sz]ed|forbidden|internal|unexpected|unknown_error|rate_limit|invalid_x402_version|invalid_payment_requirements/i.test(
    reason,
  );
}

/** After CDP settle: fall back on transport errors, auth/5xx/429 answers and facilitator-side refusals without a tx hash. */
function cdpSettleShouldFallBack(r: FacilitatorResult): boolean {
  if (r.kind === "error") return true;
  if (typeof r.json.transaction === "string" && r.json.transaction) return false;
  if (r.json.success === true && r.status === 200) return false;
  if (r.status === 401 || r.status === 403 || r.status === 404 || r.status === 429 || r.status >= 500) return true;
  return r.json.success === false && facilitatorSideReason(String(r.json.errorReason ?? ""));
}

function logBazaar(deps: PaywallDeps, quote: Quote, phase: string, headers?: Headers) {
  const ext = decodeExtensionResponses(headers?.get("EXTENSION-RESPONSES") ?? null);
  const bazaar = ext?.bazaar as Record<string, unknown> | undefined;
  if (bazaar) deps.log?.({ event: "x402_bazaar", phase, route: quote.routeKey, status: bazaar.status ?? null, reason: bazaar.rejectedReason ?? null });
}

/**
 * The ordered facilitator list for a Base payment. CDP gets the payload with the server's own `resource` and
 * `extensions.bazaar` (what the Bazaar indexes; clients may omit or alter their echo), the keyless facilitator gets
 * the payload exactly as the client sent it.
 */
function evmFacilitators(cfg: Config, payload: PaymentPayload, expected: PaymentRequirements, quote: Quote, deps: PaywallDeps): EvmFacilitator[] {
  const evm = cfg.evm!;
  const make = (name: EvmFacilitator["name"], baseUrl: string, paymentPayload: PaymentPayload, auth: boolean): EvmFacilitator => {
    const body = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: expected });
    return {
      name,
      async call(phase) {
        const url = `${baseUrl}/${phase}`;
        let resp: Response;
        try {
          const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
          if (auth) Object.assign(headers, await cdpAuthHeaders(evm.cdp!.credentials, "POST", url));
          resp = await deps.fetch(url, { method: "POST", headers, body });
        } catch (err) {
          return { kind: "error", reason: auth && !(err instanceof TypeError) ? "cdp_auth_error" : "network_error" };
        }
        if (name === "cdp" && phase === "verify") logBazaar(deps, quote, phase, resp.headers);
        const retryAfter = resp.headers.get("Retry-After");
        const j = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
        if (phase === "verify" && (resp.status === 408 || resp.status === 429 || resp.status >= 500)) {
          return { kind: "error", status: resp.status, headers: resp.headers, retryAfter, reason: `http_${resp.status}` };
        }
        if (phase === "verify" && name === "cdp" && (resp.status === 401 || resp.status === 403 || resp.status === 404)) {
          return { kind: "error", status: resp.status, headers: resp.headers, retryAfter, reason: `http_${resp.status}` };
        }
        if (!j || typeof j !== "object") return { kind: "error", status: resp.status, headers: resp.headers, retryAfter, reason: "bad_json" };
        return { kind: "ok", status: resp.status, headers: resp.headers, json: j };
      },
    };
  };
  const list: EvmFacilitator[] = [];
  if (evm.cdp) {
    const forCdp: PaymentPayload = {
      ...payload,
      resource: { url: quote.resourceUrl, description: quote.description, mimeType: "application/json", ...(quote.service ?? {}) },
      extensions: { ...(payload.extensions ?? {}), bazaar: quote.bazaar ?? BAZAAR_GET_JSON },
    };
    list.push(make("cdp", evm.cdp.url, forCdp, true));
  }
  list.push(make("fallback", evm.facilitatorUrl, payload, false));
  return list;
}

// ---------------------------------------------------------------- Stellar flow

const STELLAR_XDR_RE = /^[A-Za-z0-9+/]+={0,2}$/;


/**
 * Stellar USDC settlement through the OpenZeppelin Channels x402 facilitator (Bearer API key). Same guarantees as the
 * other rails: the invoice is claimed once in the replay guard before settlement, and the signed transaction itself is
 * claimed too (sha256 of its XDR), so one signed transfer can never be redeemed against two invoices. The facilitator
 * checks the transfer's asset, `to` = payTo and amount against the requirements; a Soroban auth entry is single-use
 * on-chain, so a re-submitted transfer cannot move the buyer's USDC twice.
 */
async function requireStellarPayment(
  payload: PaymentPayload,
  expected: PaymentRequirements,
  invoiceId: string,
  expiresAt: number,
  cfg: Config,
  deps: PaywallDeps,
  quote: Quote,
  serve: (settlement: Settlement, paid: PaymentRequirements) => Promise<Response> | Response,
): Promise<Response> {
  const st = cfg.stellar!;
  const xdr = (payload.payload as Record<string, unknown> | undefined)?.transaction;
  if (typeof xdr !== "string" || xdr.length < 32 || xdr.length > 20_000 || !STELLAR_XDR_RE.test(xdr)) {
    return paymentRequiredResponse(cfg, quote, "invalid_stellar_payload");
  }
  const txKey = `stellar:${expected.network}:${await sha256Hex(xdr)}`;
  if (await deps.replay.isUsed(txKey)) return paymentRequiredResponse(cfg, quote, "authorization_already_used");

  // The facilitator gets the requirements exactly as offered (incl. extra.invoiceId), never the client's echo.
  const body = JSON.stringify({ x402Version: 2, paymentPayload: { ...payload, accepted: expected }, paymentRequirements: expected });
  const post = (phase: "verify" | "settle") =>
    deps.fetch(`${st.facilitatorUrl}/${phase}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${st.apiKey}` },
      body,
    });

  // ---- verify (no money moves; safe to retry)
  let verifyResp: Response;
  try {
    verifyResp = await post("verify");
  } catch {
    return transient("facilitator_unavailable");
  }
  if (verifyResp.status === 401 || verifyResp.status === 403 || verifyResp.status === 408 || verifyResp.status === 429 || verifyResp.status >= 500) {
    deps.log?.({ event: "x402_stellar_facilitator", phase: "verify", status: verifyResp.status });
    return transient("facilitator_unavailable", verifyResp.headers.get("Retry-After"));
  }
  const v = (await verifyResp.json().catch(() => null)) as Record<string, unknown> | null;
  if (!v || typeof v.isValid !== "boolean" || (v.isValid && verifyResp.status !== 200)) {
    return json(502, { error: "invalid_verify_response", retryable: false, phase: "verify", settlementAttempted: false });
  }
  if (!v.isValid) return paymentRequiredResponse(cfg, quote, `verify_failed:${String(v.invalidReason || "verify_failed")}`);
  const verifiedPayer = typeof v.payer === "string" ? v.payer : undefined;

  // ---- one-time redemption: the invoice and the signed transaction
  const ttl = Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000) + 60);
  try {
    if (!(await deps.replay.claim(invoiceId, ttl))) return paymentRequiredResponse(cfg, quote, "invoice_already_used");
    if (!(await deps.replay.claim(txKey, Math.max(ttl, 86_400)))) return paymentRequiredResponse(cfg, quote, "authorization_already_used");
  } catch {
    return transient("invoice_guard_unavailable");
  }
  const stale = staleRefusal(quote);
  if (stale) return stale;

  // ---- settle (the facilitator submits the fee-sponsored transfer on Stellar)
  let settleResp: Response;
  try {
    settleResp = await post("settle");
  } catch {
    return settlementUnknown();
  }
  const s = (await settleResp.json().catch(() => null)) as Record<string, unknown> | null;
  const tx = typeof s?.transaction === "string" ? s.transaction : "";
  if (!s || typeof s.success !== "boolean") return settlementUnknown();
  if (!s.success || settleResp.status !== 200) {
    const definite = !s.success && !tx && settleResp.status >= 200 && settleResp.status < 500 && settleResp.status !== 408 && settleResp.status !== 429;
    if (!definite) return settlementUnknown();
    return paymentRequiredResponse(cfg, quote, `settle_failed:${String(s.errorReason ?? "unknown")}`);
  }
  const settlement: Settlement = {
    success: true,
    transaction: tx,
    network: String(s.network || expected.network),
    payer: typeof s.payer === "string" ? s.payer : verifiedPayer,
  };
  deps.log?.({ event: "x402_settled", route: quote.routeKey, asset: "USDC", amount: expected.amount, network: settlement.network, tx, payer: settlement.payer, facilitator: "openzeppelin" });
  await emitSale(deps, {
    route: quote.routeKey.split(":")[0],
    routeKey: quote.routeKey,
    rail: "stellar",
    network: settlement.network,
    asset: "USDC",
    amount: (Number(expected.amount) / 1e7).toFixed(7).replace(/0+$/, "").replace(/\.$/, ""),
    usd: quoteUsd(quote),
    payer: settlement.payer,
    tx,
    facilitator: "openzeppelin",
  });

  const resp = await serve(settlement, expected);
  const out = new Response(resp.body, resp);
  out.headers.set(HEADER_PAYMENT_RESPONSE, settleResp.headers.get(HEADER_PAYMENT_RESPONSE) || encodeHeader(settlement));
  out.headers.set("Cache-Control", "no-store");
  return out;
}
