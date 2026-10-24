/**
 * Local kit config: ~/.lumi-scanner-kit/config.json (protocol path, unchanged). Two sharing tiers:
 *
 * Tier 1, delivery outcomes: ON by default. After each check the kit sends ONLY
 *   { v: 1, subject: <seller host or vendor:id>, delivered: true|false, status_class?: "2xx"|"3xx"|"4xx"|"5xx"|"timeout"|"network", token: <fresh random per event> }
 *   No wallet address, amount, tx hash, URL path or query, payload, or stable client id. It earns nothing.
 *   Off switch (any one): `lumi-scan telemetry off`, config `"telemetry": false`, or env LUMI_CHECK_TELEMETRY=off.
 *
 * Tier 2, full signed receipts: OFF by default, opt-in. The only thing that earns free Lumi Check credits.
 *   On: `lumi-scan setup` or `lumi-scan sharing on`. Off: `lumi-scan sharing off`, config `"share_receipts": false`,
 *   or env LUMI_SHARE_RECEIPTS=0. While off, nothing about your purchases is sent.
 *
 * Env always wins over the file.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_CONFIG = Object.freeze({ telemetry: true, share_receipts: false, fail_mode: "open", timeout_ms: 2500 });
export const defaultConfigPath = () => process.env.LUMI_KIT_CONFIG || join(homedir(), ".lumi-scanner-kit", "config.json");
const OFF = /^(0|false|off|no|disabled?)$/i, ON = /^(1|true|on|yes|enabled?)$/i;

function readFile(path) {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")) ?? {}; } catch { return {}; }
}
export function loadConfig(path = defaultConfigPath(), env = process.env) {
  const file = readFile(path);
  const cfg = { ...DEFAULT_CONFIG, ...file, telemetry: file.telemetry !== false, share_receipts: file.share_receipts === true };
  const t = env.LUMI_CHECK_TELEMETRY;
  if (t !== undefined && t !== "") cfg.telemetry = !OFF.test(t.trim());
  const s = env.LUMI_SHARE_RECEIPTS;
  if (s !== undefined && s !== "") cfg.share_receipts = ON.test(s.trim());
  if (cfg.fail_mode !== "closed") cfg.fail_mode = "open";
  const ms = Number(cfg.timeout_ms);
  cfg.timeout_ms = Number.isFinite(ms) && ms >= 100 && ms <= 30_000 ? ms : DEFAULT_CONFIG.timeout_ms;
  cfg.first_run = !existsSync(path);
  return cfg;
}
export function saveConfig(patch, path = defaultConfigPath()) {
  const cur = readFile(path);
  const next = { ...DEFAULT_CONFIG, ...cur, ...patch, updated_at: new Date().toISOString() };
  delete next.first_run;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}
export const sharingEnabled = (path, env) => loadConfig(path, env).share_receipts === true;
export const telemetryEnabled = (path, env) => loadConfig(path, env).telemetry === true;
export const SHARING_OFF_ERROR = "receipt sharing (tier 2) is off, which is the default. Nothing was sent. Turn it on with `lumi-scan sharing on` (or `lumi-scan setup`).";

/** Plain-language disclosure shown at first run, in `lumi-scan setup`, and in the README. */
export const DISCLOSURE = [
  "Lumi Check sharing:",
  "  Tier 1 (ON by default): after each check, an anonymous delivery outcome: the seller's host (or Lumi vendor id),",
  "    delivered yes/no and a coarse status class (2xx/4xx/5xx/timeout). No wallet address, amount, tx hash, URL path",
  "    or query, payload, or stable ID; each report carries a fresh random token. Turn it off any time:",
  "    `lumi-scan telemetry off`, or LUMI_CHECK_TELEMETRY=off, or \"telemetry\": false in ~/.lumi-scanner-kit/config.json.",
  "  Tier 2 (OFF by default, opt-in): full signed delivery receipts. This is the only thing that earns free Lumi Check",
  "    credits. Turn on with `lumi-scan sharing on`; off with `lumi-scan sharing off`. No cash rewards.",
].join("\n");

/** Shown by `lumi-scan account delete` before the confirm prompt. Keep in sync with README "Deleting your account" and TERMS. */
export const ACCOUNT_DELETE_NOTICE = [
  "Delete your Lumi Check contributor account. This cannot be undone.",
  "Deleted now: your key (it can never sign again), label, public key, registered wallets, own domains, demand opt-in,",
  "  activity date, free check credits (balance, earned batches and spends), your leaderboard entry, and every receipt you",
  "  shared, except receipts Lumi already cited in a published, dated test result.",
  "Kept, with no link to you: those cited receipts (your wallet signature, payer address and kit details are removed),",
  "  and anonymous per-seller daily summaries (they never had a link to you). Payments on a public blockchain cannot be deleted by anyone.",
].join("\n");
