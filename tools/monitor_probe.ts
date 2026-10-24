/**
 * Box-side monitor probe (owner-only). Unpaid x402 quote checks for every active monitoring plan, rolled up per
 * endpoint per UTC day and posted to the Worker at most once per run, so D1 sees ~1 row per endpoint per day.
 *
 *   npx tsx tools/monitor_probe.ts                 # DRY RUN (default): probe, print the rollup payload, post nothing
 *   MONITOR_PROBE_POST=1 npx tsx tools/monitor_probe.ts   # also POST /v1/owner/monitor/uptime
 *
 * Env: LUMI_API_URL (default https://api.lumitrades.io), LUMI_OWNER_KEY or LUMI_OWNER_KEY_FILE (never printed),
 *      MONITOR_PROBE_STATE (default ./.monitor_probe_state.json).
 * It never sends a PAYMENT-SIGNATURE: no money moves. Test-buys stay with the existing owner runner (GET /v1/owner/monitor/due).
 * Not scheduled: suggested cadence is every 15 min (the shortest tier interval); each target is only probed when due.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export interface ProbeTarget { enrollment_id: string; endpoint: string; method: string; body?: Record<string, unknown>; every_ms: number; plan: string; network: string; pay_to: string }
export interface Sample { enrollment_id: string; endpoint: string; ts: number; ok: boolean; ms: number; amount?: string | null; asset?: string | null; pay_to?: string | null; error?: string }
export interface DayRollup { enrollment_id: string; endpoint: string; day: string; checks: number; ok: number; p50_ms: number | null; p95_ms: number | null; quote_amount: string | null; quote_asset: string | null; quote_pay_to: string | null }
export interface Transition { enrollment_id: string; endpoint: string; kind: "quote_down" | "quote_recovered" | "pay_to_changed" | "price_changed" | "latency_p95_high"; ts: number; detail?: string }
export interface EpState { last_ts: number; ok: boolean | null; fails: number; pay_to: string | null; amount: string | null; latency_high?: boolean }
export interface ProbeState { eps: Record<string, EpState>; samples: Sample[] }

export const key = (x: { enrollment_id: string; endpoint: string }) => `${x.enrollment_id}|${x.endpoint}`;
export const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

/** Targets whose tier interval has elapsed since their last probe. */
export function dueTargets(targets: ProbeTarget[], state: ProbeState, now: number): ProbeTarget[] {
  return targets.filter((t) => { const s = state.eps[key(t)]; return !s || now - s.last_ts >= t.every_ms - 30_000; });
}

/** Parse an unpaid 402 into the cheapest accept on the target's network (or overall). */
export function parseQuote(status: number, body: any, network: string): { ok: boolean; amount: string | null; asset: string | null; pay_to: string | null; error?: string } {
  if (status !== 402) return { ok: false, amount: null, asset: null, pay_to: null, error: `http_${status}` };
  const accepts: any[] = Array.isArray(body?.accepts) ? body.accepts : [];
  if (!accepts.length) return { ok: false, amount: null, asset: null, pay_to: null, error: "no_accepts" };
  const a = accepts.find((x) => String(x?.network ?? "") === network) ?? accepts[0];
  if (!a?.payTo || a?.amount == null) return { ok: false, amount: null, asset: null, pay_to: null, error: "invalid_accept" };
  return { ok: true, amount: String(a.amount), asset: String(a.asset ?? ""), pay_to: String(a.payTo) };
}

/** One roll-up row per enrollment, endpoint and UTC day. */
export function rollup(samples: Sample[]): DayRollup[] {
  const g = new Map<string, Sample[]>();
  for (const s of samples) { const k = `${key(s)}|${dayOf(s.ts)}`; (g.get(k) ?? g.set(k, []).get(k)!).push(s); }
  return [...g.values()].map((xs) => {
    const last = [...xs].sort((a, b) => b.ts - a.ts).find((x) => x.ok) ?? null;
    const ms = xs.filter((x) => x.ok).map((x) => x.ms);
    return { enrollment_id: xs[0].enrollment_id, endpoint: xs[0].endpoint, day: dayOf(xs[0].ts), checks: xs.length, ok: xs.filter((x) => x.ok).length, p50_ms: pct(ms, 50), p95_ms: pct(ms, 95), quote_amount: last?.amount ?? null, quote_asset: last?.asset ?? null, quote_pay_to: last?.pay_to ?? null };
  });
}

/** State-change alerts. quote_down needs 2 consecutive failures (one blip is not an outage). */
export function detectTransitions(prev: EpState | undefined, s: Sample, p95LimitMs = 5000, recentMs: number[] = []): { next: EpState; transitions: Transition[] } {
  const out: Transition[] = [];
  const fails = s.ok ? 0 : (prev?.fails ?? 0) + 1;
  const wasDown = prev?.ok === false && (prev?.fails ?? 0) >= 2;
  const base = { enrollment_id: s.enrollment_id, endpoint: s.endpoint, ts: s.ts };
  if (!s.ok && fails === 2) out.push({ ...base, kind: "quote_down", detail: s.error });
  if (s.ok && wasDown) out.push({ ...base, kind: "quote_recovered" });
  if (s.ok && prev?.pay_to && s.pay_to && prev.pay_to !== s.pay_to) out.push({ ...base, kind: "pay_to_changed", detail: `${prev.pay_to} -> ${s.pay_to}` });
  if (s.ok && prev?.amount && s.amount && prev.amount !== s.amount) out.push({ ...base, kind: "price_changed", detail: `${prev.amount} -> ${s.amount}` });
  const p95 = pct([...recentMs, ...(s.ok ? [s.ms] : [])], 95);
  const high = p95 != null && recentMs.length >= 4 && p95 > p95LimitMs;
  if (high && !prev?.latency_high) out.push({ ...base, kind: "latency_p95_high", detail: `p95 ${p95} ms` });
  return { next: { last_ts: s.ts, ok: s.ok, fails, pay_to: s.ok ? s.pay_to ?? null : prev?.pay_to ?? null, amount: s.ok ? s.amount ?? null : prev?.amount ?? null, latency_high: high }, transitions: out };
}

async function probe(t: ProbeTarget, f: typeof fetch = fetch): Promise<Sample> {
  const t0 = Date.now();
  try {
    const r = await f(t.endpoint, { method: t.method, headers: { Accept: "application/json", ...(t.body ? { "Content-Type": "application/json" } : {}) }, ...(t.body ? { body: JSON.stringify(t.body) } : {}), redirect: "manual", signal: AbortSignal.timeout(20_000) });
    const ms = Date.now() - t0;
    let body: any = null;
    try { body = await r.json(); } catch { /* header-only 402 */ }
    const hdr = r.headers.get("PAYMENT-REQUIRED");
    if ((!body || !body.accepts) && hdr) { try { body = JSON.parse(Buffer.from(hdr, "base64").toString("utf8")); } catch { /* ignore */ } }
    const q = parseQuote(r.status, body, t.network);
    return { enrollment_id: t.enrollment_id, endpoint: t.endpoint, ts: t0, ms, ok: q.ok, amount: q.amount, asset: q.asset, pay_to: q.pay_to, ...(q.error ? { error: q.error } : {}) };
  } catch (e) {
    return { enrollment_id: t.enrollment_id, endpoint: t.endpoint, ts: t0, ms: Date.now() - t0, ok: false, error: String((e as Error)?.name ?? e).slice(0, 40) };
  }
}

async function main() {
  const API = process.env.LUMI_API_URL ?? "https://api.lumitrades.io";
  const ownerKey = (process.env.LUMI_OWNER_KEY ?? (process.env.LUMI_OWNER_KEY_FILE ? readFileSync(process.env.LUMI_OWNER_KEY_FILE, "utf8") : "")).trim();
  if (!ownerKey) { console.error("Set LUMI_OWNER_KEY or LUMI_OWNER_KEY_FILE."); process.exit(2); }
  const post = process.env.MONITOR_PROBE_POST === "1";
  const file = process.env.MONITOR_PROBE_STATE ?? "./.monitor_probe_state.json";
  const state: ProbeState = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { eps: {}, samples: [] };
  const h = { Authorization: `Bearer ${ownerKey}`, Accept: "application/json" };
  const r = await fetch(`${API}/v1/owner/monitor/probes`, { headers: h });
  if (!r.ok) { console.error(`probes: HTTP ${r.status}`); process.exit(1); }
  const { targets } = (await r.json()) as { targets: ProbeTarget[] };
  const now = Date.now();
  const due = dueTargets(targets, state, now);
  const transitions: Transition[] = [];
  for (const t of due) {
    const s = await probe(t);
    state.samples.push(s);
    const recent = state.samples.filter((x) => key(x) === key(t) && x.ok && x.ts > now - 86_400_000).map((x) => x.ms);
    const d = detectTransitions(state.eps[key(t)], s, 5000, recent);
    state.eps[key(t)] = d.next;
    transitions.push(...d.transitions);
  }
  // keep today's and yesterday's samples only; the Worker upserts the whole day's rollup each time
  const keepFrom = Date.parse(`${dayOf(now - 86_400_000)}T00:00:00Z`);
  state.samples = state.samples.filter((x) => x.ts >= keepFrom);
  const days = rollup(state.samples);
  const payload = { days, transitions: transitions.slice(0, 25) };
  console.log(JSON.stringify({ targets: targets.length, probed: due.length, rollups: days.length, transitions: transitions.length, mode: post ? "post" : "dry-run" }));
  if (!post) { console.log(JSON.stringify(payload, null, 2)); writeFileSync(file, JSON.stringify(state)); return; }
  const w = await fetch(`${API}/v1/owner/monitor/uptime`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  console.log(`uptime: HTTP ${w.status} ${(await w.text()).slice(0, 500)}`);
  if (w.ok) writeFileSync(file, JSON.stringify(state));
}

if (process.argv[1] && /monitor_probe\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
