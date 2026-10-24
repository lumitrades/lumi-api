/**
 * Box-side OFAC guard for the test-buy runners (/workspace/tools/catalog_buys.ts, trust_testbuys.ts, monitor_runs.ts).
 * Call assertPayToAllowed(payTo, where) right before signing any payment: it throws SanctionedAddressError for an
 * OFAC SDN-listed address and appends one JSON line to the refusal log. The address set is the union of the box copy
 * written daily by scripts/ofac_refresh_daily.sh ($LUMI_OFAC_DIR or ~/.lumi/ofac/ofac_sdn_addresses.json) and the
 * repo snapshot (data/ofac_sdn_addresses.json), loaded once per process. A missing/unreadable box copy falls back to
 * the snapshot; if NEITHER loads, every payment is refused (fail closed).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAddress } from "../src/sanctions_addr";

export class SanctionedAddressError extends Error {
  constructor(public address: string, public where: string, public publication_date: string | null) {
    super(`sanctioned_address: ${address} is on the OFAC SDN list; payment refused (${where})`);
  }
}

const DIR = process.env.LUMI_OFAC_DIR || join(homedir(), ".lumi", "ofac");
const BOX_FILE = join(DIR, "ofac_sdn_addresses.json");
const REPO_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "ofac_sdn_addresses.json");
const LOG = process.env.LUMI_SANCTIONS_LOG || join(DIR, "refused.log");
const STALE_MS = 3 * 86_400_000;

let loaded: { set: Set<string>; pub: string | null; files: string[]; stale: boolean } | null = null;

export function loadSanctionsSet(files = [BOX_FILE, REPO_FILE]) {
  const set = new Set<string>(), used: string[] = [];
  let pub: string | null = null, stale = false;
  for (const f of files) {
    try {
      if (!existsSync(f)) continue;
      const d = JSON.parse(readFileSync(f, "utf8"));
      for (const a of [...(d.evm ?? []), ...(d.xrpl ?? []), ...(d.stellar ?? [])]) { const n = normalizeAddress(String(a)); if (n) set.add(n.normalized); }
      if (d.publication_date && (!pub || d.publication_date > pub)) pub = d.publication_date;
      if (f === BOX_FILE && Date.now() - statSync(f).mtimeMs > STALE_MS) stale = true;
      used.push(f);
    } catch { /* try the next file */ }
  }
  return { set, pub, files: used, stale };
}

function log(e: Record<string, unknown>) {
  try { mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n"); } catch { /* logging never unblocks a payment */ }
}

/** Throws (and logs) when payTo is OFAC-listed, or when no list could be loaded at all. */
export function assertPayToAllowed(payTo: string, where: string, extra: Record<string, unknown> = {}): void {
  loaded ??= loadSanctionsSet();
  if (loaded.stale) { log({ event: "sanctions_list_stale", files: loaded.files }); loaded.stale = false; }
  if (!loaded.files.length) {
    log({ event: "sanctions_list_unavailable", where, pay_to: payTo, ...extra });
    throw new SanctionedAddressError(payTo, `${where}: no OFAC list loaded (fail closed)`, null);
  }
  const n = normalizeAddress(payTo);
  if (n && loaded.set.has(n.normalized)) {
    log({ event: "sanctioned_address_refused", where, pay_to: n.normalized, format: n.format, list: "OFAC SDN", publication_date: loaded.pub, ...extra });
    throw new SanctionedAddressError(n.normalized, where, loaded.pub);
  }
}

/** Non-throwing variant for candidate filtering. */
export function isSanctioned(payTo: string): boolean {
  try { assertPayToAllowed(payTo, "filter"); return false; } catch (e) { return e instanceof SanctionedAddressError; }
}
