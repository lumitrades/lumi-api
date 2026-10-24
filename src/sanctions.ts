/**
 * OFAC sanctions screen for payTo addresses (Lumi never test-buys from, and never "allows", a listed address).
 *
 * Data: U.S. Treasury OFAC SDN list, Advanced XML ("Digital Currency Address - <ASSET>" features), extracted by
 * scripts/ofac_refresh.py into data/ofac_sdn_addresses.json (EVM lower-cased, XRPL classic, Stellar G-keys).
 * Source: https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ADVANCED.XML
 *
 * D1-friendly: the bundled snapshot is a Set built once per isolate (O(1) lookups, no table, no per-request reads).
 * Optional fresher copy: a KV value (binding SANCTIONS_KV, key SANCTIONS_KV_KEY) in the same JSON shape, read at most
 * once per SANCTIONS_KV_TTL_MS per isolate and UNIONED with the bundled snapshot (a refresh can add, never silently drop).
 *
 * Normalisation: EVM 0x addresses compare lower-case; XRPL X-addresses (and "r...:tag" / "r...?dt=") map to the
 * classic r-address; Stellar muxed M-addresses map to their G account and lower-case input is upper-cased.
 */
import snapshot from "../data/ofac_sdn_addresses.json";

export const SANCTIONS_REASON = "sanctioned_address";
export const SANCTIONS_SOURCE = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ADVANCED.XML";
export const SANCTIONS_KV_KEY = "ofac_sdn_addresses";
export const SANCTIONS_KV_TTL_MS = 6 * 3_600_000;

export interface SanctionsDoc { source?: string; publication_date?: string | null; fetched_at?: string; evm?: string[]; xrpl?: string[]; stellar?: string[] }
export interface KVLike { get(key: string, type: "json"): Promise<unknown> }
export interface SanctionHit { address: string; normalized: string; format: AddressFormat; list: string; publication_date: string | null }
import type { AddressFormat } from "./sanctions_addr";

export { normalizeAddress, xAddressToClassic, muxedToAccount } from "./sanctions_addr";
import { normalizeAddress } from "./sanctions_addr";

// ---------------------------------------------------------------- the screen
export interface SanctionsScreen {
  /** Synchronous O(1) check against the loaded set. */
  check(address: string | null | undefined): SanctionHit | null;
  /** First hit among several addresses (e.g. every payTo a listing names). */
  checkAny(addresses: Iterable<string | null | undefined>): SanctionHit | null;
  /** Load / refresh the optional KV copy (no-op without KV or within the TTL). Never throws. */
  ready(): Promise<void>;
  /** Refuse-and-log helper: logs one structured line per refusal (the address is public list data). */
  refuse(where: string, hit: SanctionHit, extra?: Record<string, unknown>): void;
  info(): { source: string; publication_date: string | null; counts: Record<string, number>; kv: boolean };
}

export function createSanctionsScreen(opts: { doc?: SanctionsDoc; kv?: KVLike; kvKey?: string; now?: () => number; log?: (e: Record<string, unknown>) => void } = {}): SanctionsScreen {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((e: Record<string, unknown>) => console.warn(JSON.stringify(e)));
  const base = opts.doc ?? (snapshot as SanctionsDoc);
  const set = new Set<string>();
  let pub: string | null = base.publication_date ?? null;
  let kvAt = 0, kvLoaded = false;
  const add = (d: SanctionsDoc) => {
    for (const a of [...(d.evm ?? []), ...(d.xrpl ?? []), ...(d.stellar ?? [])]) { const n = normalizeAddress(a); if (n) set.add(n.normalized); }
  };
  add(base);
  const check = (address: string | null | undefined): SanctionHit | null => {
    if (!address) return null;
    const n = normalizeAddress(address);
    return n && set.has(n.normalized) ? { address: String(address), ...n, list: "OFAC SDN", publication_date: pub } : null;
  };
  return {
    check,
    checkAny(addresses) { for (const a of addresses) { const h = check(a); if (h) return h; } return null; },
    async ready() {
      if (!opts.kv || now() - kvAt < SANCTIONS_KV_TTL_MS) return;
      kvAt = now();
      try {
        const d = (await opts.kv.get(opts.kvKey ?? SANCTIONS_KV_KEY, "json")) as SanctionsDoc | null;
        if (d && Array.isArray(d.evm)) { add(d); kvLoaded = true; if (d.publication_date && (!pub || d.publication_date > pub)) pub = d.publication_date; }
      } catch { /* keep the bundled snapshot */ }
    },
    refuse(where, hit, extra = {}) {
      log({ event: "sanctioned_address_refused", where, address: hit.normalized, format: hit.format, list: hit.list, publication_date: hit.publication_date, ...extra });
    },
    info: () => ({ source: base.source ?? SANCTIONS_SOURCE, publication_date: pub, counts: { addresses: set.size }, kv: kvLoaded }),
  };
}

/** Reason entry for verdicts (trust check, pre-pay check). */
export function sanctionedReason(hit: SanctionHit) {
  return {
    code: SANCTIONS_REASON,
    severity: "block" as const,
    detail: `${hit.normalized} is listed as a digital-currency address on the U.S. Treasury OFAC SDN list${hit.publication_date ? ` (publication of ${hit.publication_date})` : ""}. Do not pay it. Source: ${SANCTIONS_SOURCE}`,
  };
}
