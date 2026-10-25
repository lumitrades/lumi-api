/**
 * Free "probe-checked" run (box-side, local only). No payment is ever signed or sent; no PAYMENT-SIGNATURE header.
 *
 *   python3 tools/probe_checked_targets.py           # build $PC_DIR/targets.json from read-only inputs
 *   npx tsx tools/probe_checked.ts                   # probe, write $PC_DIR/probe_results.json (nothing posted anywhere)
 *
 * Politeness: at most one unpaid request per endpoint per run (one endpoint per host), robots.txt honoured per host,
 * one in-flight request per host, global concurrency PC_CONC (default 48), 10 s timeouts, identifying User-Agent.
 */
import { readFileSync, writeFileSync } from "node:fs";
import tls from "node:tls";
import { evaluateQuote, historyBand, type QuoteEval } from "../src/trust/probe_checked";
import { isPlatformHost } from "../src/trust/catalog";

const PC = process.env.PC_DIR ?? "/tmp/pc";
const CONC = Number(process.env.PC_CONC ?? 48);
const UA = "LumiTrustProbe/0.9 (+https://api.lumitrades.io/v1/trust/methodology; unpaid quote check)";
const T = 10_000;

const input = JSON.parse(readFileSync(`${PC}/targets.json`, "utf8"));
const hosts: any[] = input.hosts;
const limitN = Number(process.env.PC_LIMIT ?? 0);
const work = limitN ? hosts.slice(0, limitN) : hosts;

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let i = 0, done = 0;
  const tick = setInterval(() => process.stderr.write(`  ${done}/${items.length}\n`), 30_000);
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k).catch(() => {}); done++; } }));
  clearInterval(tick);
}

// ---------------------------------------------------------------- robots.txt
export function robotsAllows(txt: string, path: string, agent = "lumitrustprobe"): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; p: string }[] }[] = [];
  let cur: (typeof groups)[number] | null = null, lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") { if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (!cur) continue;
    if (k === "disallow" && v) cur.rules.push({ allow: false, p: v });
    if (k === "allow" && v) cur.rules.push({ allow: true, p: v });
  }
  const g = groups.find((x) => x.agents.some((a) => a !== "*" && agent.includes(a))) ?? groups.find((x) => x.agents.includes("*"));
  if (!g) return true;
  const match = (p: string) => { const re = new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")); return re.test(path); };
  let best: { allow: boolean; p: string } | null = null;
  for (const r of g.rules) if (match(r.p) && (!best || r.p.length > best.p.length || (r.p.length === best.p.length && r.allow))) best = r;
  return best ? best.allow : true;
}

async function get(url: string, init: RequestInit = {}) {
  return fetch(url, { redirect: "manual", ...init, headers: { "User-Agent": UA, Accept: "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(T) });
}
const decodeB64Json = (h: string) => JSON.parse(Buffer.from(h.trim(), "base64").toString("utf8"));

interface HostResult {
  host: string; reg: string; robots: "allowed" | "disallowed" | "none";
  wellknown?: { status: number | null; resources: string[]; ok: boolean };
  probe?: { url: string; method: string; status: number | null; latency_ms: number | null; error: string | null; quote: QuoteEval | null; complete_402: boolean | null; pay_tos_all: string[] };
}
const results: HostResult[] = [];
let newHosts: any[] = [];
let requests = 0;

async function doHost(h: any) {
  const r: HostResult = { host: h.host, reg: h.reg, robots: "none" };
  results.push(r);
  let robots = "";
  try { requests++; const rr = await get(`https://${h.host}/robots.txt`, { headers: { Accept: "text/plain" } }); if (rr.status === 200 && (rr.headers.get("content-type") ?? "").includes("text/plain")) { robots = (await rr.text()).slice(0, 200_000); } else await rr.body?.cancel().catch(() => {}); } catch { /* none */ }
  const allowed = (p: string) => !robots || robotsAllows(robots, p);
  if (h.wellknown) {
    if (allowed("/.well-known/x402")) {
      try {
        requests++;
        const w = await get(`https://${h.host}/.well-known/x402`);
        let res: string[] = [];
        if (w.status === 200) {
          try { const j: any = JSON.parse((await w.text()).slice(0, 2_000_000)); const arr = Array.isArray(j?.resources) ? j.resources : Array.isArray(j?.endpoints) ? j.endpoints : Array.isArray(j) ? j : []; res = arr.map((x: any) => (typeof x === "string" ? x : x?.resource ?? x?.url)).filter((x: any) => typeof x === "string" && /^https?:\/\//.test(x)).slice(0, 5000); } catch { /* not json */ }
        } else await w.body?.cancel().catch(() => {});
        r.wellknown = { status: w.status, resources: res, ok: res.length > 0 };
      } catch { r.wellknown = { status: null, resources: [], ok: false }; }
    }
  }
  const t = h.target ?? (r.wellknown?.resources?.length ? { url: r.wellknown.resources[0], method: "GET", src: "wellknown" } : null);
  if (!t) return;
  let path = "/";
  try { const u = new URL(t.url); path = u.pathname + u.search; } catch { return; }
  if (!allowed(path)) { r.robots = "disallowed"; r.probe = { url: t.url, method: t.method, status: null, latency_ms: null, error: "robots_disallowed", quote: null, complete_402: null, pay_tos_all: [] }; return; }
  r.robots = robots ? "allowed" : "none";
  const t0 = Date.now();
  const p: NonNullable<HostResult["probe"]> = { url: t.url, method: t.method, status: null, latency_ms: null, error: null, quote: null, complete_402: null, pay_tos_all: [] };
  r.probe = p;
  try {
    requests++;
    const isPost = t.method === "POST";
    const resp = await get(t.url, { method: isPost ? "POST" : "GET", body: isPost ? "{}" : undefined, headers: isPost ? { "Content-Type": "application/json" } : {} });
    p.latency_ms = Date.now() - t0; p.status = resp.status;
    let pr: any = null;
    if (resp.status === 402) {
      try { const hh = resp.headers.get("PAYMENT-REQUIRED") ?? resp.headers.get("payment-required"); if (hh) pr = decodeB64Json(hh); else { const txt = await resp.text(); if (txt.length <= 262_144) pr = JSON.parse(txt); } } catch { /* unreadable */ }
    }
    if (!resp.bodyUsed) await resp.body?.cancel().catch(() => {});
    p.quote = evaluateQuote(resp.status, pr, { price_usd: t.price ?? null, pay_tos: t.pay_tos ?? [] });
    if (pr && Array.isArray(pr.accepts)) {
      p.pay_tos_all = [...new Set(pr.accepts.map((a: any) => `${a?.network}|${String(a?.payTo ?? "").toLowerCase()}`))] as string[];
      const a0 = pr.accepts.find((a: any) => a && typeof a === "object") ?? {};
      const desc = a0.description ?? pr.resource?.description ?? pr.description;
      const schema = a0.outputSchema ?? pr.extensions?.bazaar ?? pr.resource?.outputSchema ?? a0.extra?.schema;
      p.complete_402 = typeof desc === "string" && desc.trim().length >= 20 && schema != null;
    }
  } catch (e) {
    p.latency_ms = Date.now() - t0;
    p.error = /timeout|abort/i.test(String(e)) ? "unreachable" : "network_error";
  }
}

function tlsCheck(host: string): Promise<{ ok: boolean; days_left: number | null; error?: string }> {
  return new Promise((res) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: T }, () => {
      const c = s.getPeerCertificate();
      const left = c?.valid_to ? Math.floor((Date.parse(c.valid_to) - Date.now()) / 86_400_000) : null;
      res({ ok: s.authorized, days_left: left, error: s.authorized ? undefined : String(s.authorizationError) });
      s.end();
    });
    s.on("error", (e) => res({ ok: false, days_left: null, error: String(e.message).slice(0, 80) }));
    s.on("timeout", () => { s.destroy(); res({ ok: false, days_left: null, error: "timeout" }); });
  });
}

async function rdap(domain: string): Promise<{ registered_at: number | null; error: string | null }> {
  try {
    const r = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { headers: { Accept: "application/rdap+json, application/json", "User-Agent": UA }, signal: AbortSignal.timeout(T) });
    if (!r.ok) { await r.body?.cancel().catch(() => {}); return { registered_at: null, error: `rdap HTTP ${r.status}` }; }
    const j: any = await r.json();
    const ev = (j.events ?? []).find((e: any) => e.eventAction === "registration");
    const t = ev ? Date.parse(ev.eventDate) : NaN;
    return Number.isFinite(t) ? { registered_at: t, error: null } : { registered_at: null, error: "no registration date" };
  } catch { return { registered_at: null, error: "rdap unavailable" }; }
}

async function rpcBatch(calls: { method: string; params: any[] }[]) {
  const body = calls.map((c, id) => ({ jsonrpc: "2.0", id, ...c }));
  const r = await fetch(process.env.BASE_RPC ?? "https://mainnet.base.org", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const j: any[] = await r.json();
  const out: any[] = []; for (const x of j) out[x.id] = x.result ?? null; return out;
}

async function main() {
  const started = Date.now();
  console.error(`hosts ${work.length}, conc ${CONC}`);
  await pool(work, CONC, doHost);
  // well-known files can point at hosts not in any listing: one probe per new host
  const known = new Set(hosts.map((h) => h.host));
  const extra = new Map<string, any>();
  for (const r of results) for (const u of r.wellknown?.resources ?? []) {
    try { const h = new URL(u).hostname.toLowerCase().replace(/^www\./, ""); if (!known.has(h) && !extra.has(h)) extra.set(h, { host: h, reg: h, sources: ["wellknown"], target: { url: u, method: "GET", src: "wellknown" }, wellknown: false }); } catch { /* skip */ }
  }
  newHosts = [...extra.values()];
  await pool(newHosts, CONC, doHost);
  console.error(`http phase done in ${Math.round((Date.now() - started) / 1000)} s, requests ${requests}`);

  // TLS + RDAP per registrable domain that answered a readable quote
  const quoting = results.filter((r) => r.probe?.quote?.x402);
  const tlsHosts = [...new Map(quoting.map((r) => [r.reg, r.host])).entries()];
  const tlsOut: Record<string, any> = {};
  await pool(tlsHosts, 32, async ([reg, host]) => { tlsOut[reg] = await tlsCheck(host); });
  const rdapDomains = tlsHosts.map(([reg]) => reg).filter((d) => !isPlatformHost(d) && d.includes("."));
  const rdapOut: Record<string, any> = {};
  if (!process.env.PC_SKIP_RDAP) await pool(rdapDomains, 6, async (d) => { rdapOut[d] = await rdap(d); });
  console.error(`tls ${tlsHosts.length}, rdap ${rdapDomains.length} (${Object.values(rdapOut).filter((x: any) => x.registered_at).length} dated)`);

  // payTo public history (Base only): x402scan settlement index membership, else outgoing nonce / contract code. Counts only.
  const onchain = new Set<string>(input.onchain.map((o: any) => o.recipient));
  const basePayTos = [...new Set(quoting.flatMap((r) => r.probe!.pay_tos_all).filter((k) => /^(base|eip155:8453)\|0x[0-9a-f]{40}$/.test(k)).map((k) => k.split("|")[1]))];
  const hist: Record<string, string> = {};
  const need = basePayTos.filter((a) => !onchain.has(a));
  for (const a of basePayTos) if (onchain.has(a)) hist[a] = "x402_settlements_30d";
  for (let i = 0; i < need.length; i += 25) {
    const chunk = need.slice(i, i + 25);
    try {
      const res = await rpcBatch(chunk.flatMap((a) => [{ method: "eth_getTransactionCount", params: [a, "latest"] }, { method: "eth_getCode", params: [a, "latest"] }]));
      chunk.forEach((a, k) => { const n = res[2 * k] != null ? parseInt(res[2 * k], 16) : null; const code = res[2 * k + 1]; hist[a] = code && code !== "0x" ? "contract" : historyBand(n); });
    } catch { chunk.forEach((a) => (hist[a] = "unknown")); }
    await new Promise((r) => setTimeout(r, 400));
  }
  writeFileSync(`${PC}/probe_results.json`, JSON.stringify({ new_hosts: newHosts.map((h) => h.host), started, finished: Date.now(), requests, results, tls: tlsOut, rdap: rdapOut, pay_to_history: hist }));
  console.error(`done in ${Math.round((Date.now() - started) / 1000)} s; payTos ${basePayTos.length} (${need.length} via RPC)`);
}
if (process.argv[1]?.endsWith("probe_checked.ts")) main();
