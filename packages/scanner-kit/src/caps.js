/**
 * Spend caps for optional test-buys. Enforced locally before any payment is signed. Defaults are deliberately tiny.
 * Amounts are per asset unit (XRP, RLUSD, USDC). Hard ceilings cannot be raised by config.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_CAPS = { per_buy: 0.01, per_day: 0.05, buys_per_day: 3 };
export const HARD_CEILING = { per_buy: 0.05, per_day: 0.5, buys_per_day: 10 };
export const defaultStatePath = () => join(process.env.LUMI_KIT_HOME || join(homedir(), ".lumi-scanner-kit"), "spend.json");

export function capsFrom(env = process.env) {
  const n = (v, d) => (v != null && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const c = { per_buy: n(env.LUMI_KIT_MAX_PER_BUY, DEFAULT_CAPS.per_buy), per_day: n(env.LUMI_KIT_MAX_PER_DAY, DEFAULT_CAPS.per_day), buys_per_day: n(env.LUMI_KIT_MAX_BUYS_PER_DAY, DEFAULT_CAPS.buys_per_day) };
  return { per_buy: Math.min(c.per_buy, HARD_CEILING.per_buy), per_day: Math.min(c.per_day, HARD_CEILING.per_day), buys_per_day: Math.min(c.buys_per_day, HARD_CEILING.buys_per_day) };
}

const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
export function loadState(path = defaultStatePath()) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return { day: today(), spent: {}, buys: 0, log: [] }; }
}
export function saveState(s, path = defaultStatePath()) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(s, null, 2) + "\n"); }

/** Can we spend `amount` of `asset` now? Returns { ok, reason?, remaining }. */
export function checkSpend(state, asset, amount, caps, t = Date.now()) {
  const s = state.day === today(t) ? state : { day: today(t), spent: {}, buys: 0, log: [] };
  const spent = Number(s.spent?.[asset] ?? 0);
  const remaining = Math.max(0, caps.per_day - spent);
  if (!(amount > 0)) return { ok: false, reason: "amount_invalid", remaining };
  if (amount > caps.per_buy + 1e-12) return { ok: false, reason: `per-buy cap ${caps.per_buy} ${asset}`, remaining };
  if (spent + amount > caps.per_day + 1e-12) return { ok: false, reason: `per-day cap ${caps.per_day} ${asset} (spent ${spent})`, remaining };
  if (s.buys >= caps.buys_per_day) return { ok: false, reason: `buys-per-day cap ${caps.buys_per_day}`, remaining };
  return { ok: true, remaining, state: s };
}
export function recordSpend(state, asset, amount, tx, t = Date.now()) {
  const s = state.day === today(t) ? state : { day: today(t), spent: {}, buys: 0, log: [] };
  s.spent[asset] = Math.round((Number(s.spent[asset] ?? 0) + amount) * 1e9) / 1e9;
  s.buys++;
  s.log = [...(s.log ?? []).slice(-50), { at: new Date(t).toISOString(), asset, amount, tx }];
  return s;
}
