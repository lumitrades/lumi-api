/**
 * Tier 1: anonymous delivery outcome (ON by default; see config.js for the off switches).
 * The payload is built from an allow-list, so nothing else can ride along.
 */
import { randomBytes } from "node:crypto";
import { loadConfig } from "./config.js";
import { kitHeader, DEFAULT_API } from "./version.js";

export const OUTCOME_FIELDS = Object.freeze(["v", "subject", "delivered", "status_class", "token"]);
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const VENDOR_RE = /^vendor:[a-z0-9][a-z0-9-]{0,63}$/;

/** Reduce a URL or host to its bare hostname. Paths, queries, ports and credentials are dropped. */
export function subjectOf(target) {
  if (!target) return null;
  const s = String(target).trim().toLowerCase();
  if (VENDOR_RE.test(s)) return s;
  let host = s;
  try { if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) { const u = new URL(s); if (u.protocol !== "http:" && u.protocol !== "https:") return null; host = u.hostname; } } catch { return null; }
  return HOST_RE.test(host) ? host : null;
}
export function statusClassOf(status) {
  if (status === "timeout" || status === "network") return status;
  const n = Number(status);
  if (!Number.isInteger(n) || n < 200 || n > 599) return undefined;
  return `${Math.floor(n / 100)}xx`;
}
/** Exactly the allowed keys. token is fresh random per event (unlinkable; only used server-side to drop replays). */
export function buildOutcome({ target, delivered, status } = {}) {
  const subject = subjectOf(target);
  if (!subject || typeof delivered !== "boolean") return null;
  const status_class = statusClassOf(status);
  return { v: 1, subject, delivered, ...(status_class ? { status_class } : {}), token: randomBytes(16).toString("base64url") };
}

/**
 * Send one tier-1 outcome. Returns { sent: false, reason } when telemetry is off or the input has no valid subject.
 * Never throws and never blocks a payment: short timeout, errors swallowed.
 */
export async function reportOutcome(o, { api = DEFAULT_API, fetchImpl = fetch, config, configPath, env, timeoutMs = 2000 } = {}) {
  const cfg = config ?? loadConfig(configPath, env);
  if (cfg.telemetry !== true) return { sent: false, reason: "telemetry_off" };
  const body = buildOutcome(o);
  if (!body) return { sent: false, reason: "no_valid_subject" };
  try {
    const res = await fetchImpl(api.replace(/\/+$/, "") + "/v1/check/outcome", {
      method: "POST", headers: { "Content-Type": "application/json", "Lumi-Kit": kitHeader() }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    return { sent: true, status: res.status };
  } catch { return { sent: false, reason: "network_error" }; }
}
