/**
 * Live mechanical signals for the top-50 coin universe, computed in the Worker from public exchange candles
 * (Coinbase Exchange, Kraken; no keys). Same scoring as Lumi's site (scripts/signals.py, assets/signals.js):
 * RSI(14), MACD(12,26,9), EMA20/50 (+EMA200 on 1d), Bollinger(20,2) %B + squeeze, StochRSI(14,14,3,3),
 * volume vs 20-period average. Timeframes 1h (fresh), 4h (built from 1h), 1d.
 *
 * Budget (Workers Free: 50 subrequests, ~10 ms CPU per invocation): a one-minute cron refreshes the LIVE_CHUNK coins whose
 * rows are oldest (one 1h candle request each) plus up to LIVE_DAILY_CHUNK daily-candle refreshes, so every coin's
 * 1h/4h read is at most ~13 min old and its 1d read at most a few hours old. Mechanical readings, not predictions.
 */
import type { D1Like } from "./config";
import { BIAS_RULE, biasFromScore } from "./bias";

export type Candle = [t: number, o: number, h: number, l: number, c: number, v: number | null];
export interface LiveCoin { id: string; symbol: string; name: string; source: "coinbase" | "kraken"; product: string }

const C = (id: string, symbol: string, name: string, product?: string): LiveCoin => ({ id, symbol, name, source: "coinbase", product: product ?? `${symbol}-USD` });
const K = (id: string, symbol: string, name: string, product: string): LiveCoin => ({ id, symbol, name, source: "kraken", product });

/** Top-50 by market cap (CoinGecko, 2026-10-23) excluding stablecoins, wrapped/staked/yield tokens and coins with no
 * public USD candles, plus every coin on Lumi's site. Stable ids = CoinGecko ids. */
export const LIVE_UNIVERSE: LiveCoin[] = [
  C("bitcoin", "BTC", "Bitcoin"), C("ethereum", "ETH", "Ethereum"), C("binancecoin", "BNB", "BNB"), C("ripple", "XRP", "XRP"),
  K("tron", "TRX", "TRON", "TRXUSD"), C("zcash", "ZEC", "Zcash"), C("hyperliquid", "HYPE", "Hyperliquid"),
  C("dogecoin", "DOGE", "Dogecoin"), K("monero", "XMR", "Monero", "XXMRZUSD"), C("chainlink", "LINK", "Chainlink"), C("cardano", "ADA", "Cardano"),
  C("near", "NEAR", "NEAR Protocol"), C("stellar", "XLM", "Stellar"), C("bitcoin-cash", "BCH", "Bitcoin Cash"), C("litecoin", "LTC", "Litecoin"),
  C("uniswap", "UNI", "Uniswap"), C("avalanche-2", "AVAX", "Avalanche"), C("sui", "SUI", "Sui"), C("hedera-hashgraph", "HBAR", "Hedera"),
  C("bittensor", "TAO", "Bittensor"), C("shiba-inu", "SHIB", "Shiba Inu"), C("crypto-com-chain", "CRO", "Cronos"), C("quant-network", "QNT", "Quant"),
  C("ethena", "ENA", "Ethena"), C("aave", "AAVE", "Aave"), C("pump-fun", "PUMP", "Pump.fun"), C("worldcoin-wld", "WLD", "Worldcoin"),
  C("ondo-finance", "ONDO", "Ondo"), C("polkadot", "DOT", "Polkadot"), C("pepe", "PEPE", "Pepe"), K("mantle", "MNT", "Mantle", "MNTUSD"),
  C("aster-2", "ASTER", "Aster"), C("sky", "SKY", "Sky"), C("morpho", "MORPHO", "Morpho"), C("internet-computer", "ICP", "Internet Computer"),
  C("arbitrum", "ARB", "Arbitrum"), C("ethereum-classic", "ETC", "Ethereum Classic"), K("kaspa", "KAS", "Kaspa", "KASUSD"), C("algorand", "ALGO", "Algorand"),
  C("polygon-ecosystem-token", "POL", "POL (ex-MATIC)"), C("cosmos", "ATOM", "Cosmos Hub"), C("render-token", "RENDER", "Render"), C("filecoin", "FIL", "Filecoin"),
  C("injective-protocol", "INJ", "Injective"), C("aptos", "APT", "Aptos"), C("optimism", "OP", "Optimism"),
  C("axelar", "AXL", "Axelar"), K("xdce-crowd-sale", "XDC", "XDC Network", "XDCUSD"), K("zebec-network", "ZBCN", "Zebec Network", "ZBCNUSD"),
];

export const LIVE_CHUNK = 4;
export const LIVE_DAILY_CHUNK = 1;
/** A live row older than this is not served (the route falls back to the site file or refuses, never charged). */
export const LIVE_MAX_AGE_MS = 75 * 60_000;
/** Daily-candle analysis is refreshed when older than this. */
export const DAILY_REFRESH_MS = 4 * 3600_000;
/** Every coin is recomputed about this often (50 coins, LIVE_CHUNK per one-minute cron). */
export const LIVE_CYCLE_MS = 13 * 60_000;
/** Candles kept per timeframe (Kraken returns 720; Coinbase 300): bounds CPU per coin. */
const MAX_BARS = 300;

export const TF_WEIGHTS: Record<string, number> = { "1h": 0.25, "4h": 0.35, "1d": 0.4 };
export const METHOD = {
  timeframe_weights: TF_WEIGHTS,
  labels: BIAS_RULE,
  points:
    "RSI +-1/+-0.5, MACD hist +-1 (+-0.5 fresh cross), EMA stack +-1 (+-0.5 mixed), EMA200 +-1 (1d), " +
    "Bollinger %B outside bands +-0.5, StochRSI turn +-0.5, volume >=1.5x avg +-0.5; score = points / max",
};

/** Retired market reading (feeds retired 2026-10-25): neutral bias wording only, no buy/sell labels. */
export function label(score: number): string {
  return biasFromScore(score) ?? "n/a";
}

// ------------------------------------------------------------------ indicators (port of signals.py)
function emaSeries(v: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(v.length).fill(null);
  if (v.length < n) return out;
  const k = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += v[i];
  e /= n;
  out[n - 1] = e;
  for (let i = n; i < v.length; i++) out[i] = e = v[i] * k + e * (1 - k);
  return out;
}

function rsiSeries(v: number[], n = 14): (number | null)[] {
  const out: (number | null)[] = new Array(v.length).fill(null);
  if (v.length <= n) return out;
  let ag = 0, al = 0;
  for (let i = 1; i <= n; i++) {
    const d = v[i] - v[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= n; al /= n;
  out[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    ag = (ag * (n - 1) + Math.max(d, 0)) / n;
    al = (al * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

const rd = (x: number | null | undefined, d = 4) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));
const sig = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? null : Number(x.toPrecision(6)));

export interface TfResult {
  price: number | null; candle_time: string; bars: number; indicators: Record<string, Record<string, unknown>>;
  points: number; max_points: number; score: number; label?: string;
}

export function analyze(candles: Candle[], tf: string): TfResult {
  const closes = candles.map((c) => c[4]);
  const price = closes[closes.length - 1];
  const res: Record<string, Record<string, unknown>> = {};
  let pts = 0, mx = 0;

  const rs = rsiSeries(closes);
  const v = rs[rs.length - 1];
  if (v != null) {
    const p = v <= 30 ? 1 : v >= 70 ? -1 : v >= 50 ? 0.5 : -0.5;
    const st = v <= 30 ? "oversold" : v >= 70 ? "overbought" : v >= 50 ? "bullish momentum" : "bearish momentum";
    res.rsi = { value: rd(v, 1), state: st, points: p };
    pts += p; mx += 1;
  }

  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  const valid: number[] = [];
  for (let i = 0; i < closes.length; i++) if (e12[i] != null && e26[i] != null) valid.push((e12[i] as number) - (e26[i] as number));
  if (valid.length >= 12) {
    const sg = emaSeries(valid, 9);
    const hist = valid.map((m, i) => (sg[i] != null ? m - (sg[i] as number) : null));
    const hnow = hist[hist.length - 1] as number;
    let cross: string | null = null;
    for (let i = 1; i < 4; i++) {
      const a = hist[hist.length - i - 1], b = hist[hist.length - i];
      if (a != null && b != null && ((a <= 0 && 0 < b) || (a >= 0 && 0 > b))) { cross = b > 0 ? "bullish" : "bearish"; break; }
    }
    const p = (hnow > 0 ? 1 : -1) + (cross === "bullish" ? 0.5 : cross === "bearish" ? -0.5 : 0);
    const st = cross === "bullish" ? "fresh bullish cross" : cross === "bearish" ? "fresh bearish cross" : hnow > 0 ? "above signal" : "below signal";
    res.macd = { value: sig(valid[valid.length - 1]), signal: sig(sg[sg.length - 1]), hist: sig(hnow), cross, state: st, points: p };
    pts += p; mx += 1.5;
  }

  const e20 = emaSeries(closes, 20).at(-1), e50 = emaSeries(closes, 50).at(-1);
  if (e20 != null && e50 != null) {
    let p: number, st: string;
    if (price > e20 && e20 > e50) [p, st] = [1, "price > EMA20 > EMA50 (uptrend)"];
    else if (price < e20 && e20 < e50) [p, st] = [-1, "price < EMA20 < EMA50 (downtrend)"];
    else [p, st] = price > e50 ? [0.5, "mixed, above EMA50"] : [-0.5, "mixed, below EMA50"];
    res.ema = { ema20: sig(e20), ema50: sig(e50), state: st, points: p };
    pts += p; mx += 1;
  }
  if (tf === "1d") {
    const e200 = emaSeries(closes, 200).at(-1);
    if (e200 != null) {
      const p = price > e200 ? 1 : -1;
      res.ema200 = { ema200: sig(e200), state: p > 0 ? "above EMA200" : "below EMA200", points: p };
      pts += p; mx += 1;
    }
  }

  if (closes.length >= 20) {
    const bbAt = (end: number) => {
      let m = 0;
      for (let i = end - 20; i < end; i++) m += closes[i];
      m /= 20;
      let s = 0;
      for (let i = end - 20; i < end; i++) s += (closes[i] - m) ** 2;
      return [m, Math.sqrt(s / 20)];
    };
    const [m, sd] = bbAt(closes.length);
    const up = m + 2 * sd, lo = m - 2 * sd;
    const pb = up > lo ? (price - lo) / (up - lo) : 0.5;
    const bw = m ? (up - lo) / m : 0;
    const histBw: number[] = [];
    for (let end = Math.max(20, closes.length - 120); end <= closes.length; end++) {
      const [mm, ss] = bbAt(end);
      histBw.push(mm ? (4 * ss) / mm : 0);
    }
    const squeeze = histBw.length >= 40 && bw <= [...histBw].sort((a, b) => a - b)[Math.floor(histBw.length * 0.2)];
    const p = pb > 1 ? -0.5 : pb < 0 ? 0.5 : 0;
    const st = (pb > 1 ? "above upper band (stretched)" : pb < 0 ? "below lower band (stretched)" : pb >= 0.5 ? "upper half" : "lower half") + (squeeze ? " · squeeze" : "");
    res.bb = { pct_b: rd(pb, 2), bandwidth_pct: rd(bw * 100, 2), upper: sig(up), lower: sig(lo), squeeze, state: st, points: p };
    pts += p; mx += 0.5;
  }

  const rv = rs.filter((x): x is number => x != null);
  if (rv.length >= 20) {
    const raw: number[] = [];
    for (let i = 13; i < rv.length; i++) {
      let lo_ = Infinity, hi_ = -Infinity;
      for (let j = i - 13; j <= i; j++) { if (rv[j] < lo_) lo_ = rv[j]; if (rv[j] > hi_) hi_ = rv[j]; }
      raw.push(hi_ === lo_ ? 0.5 : (rv[i] - lo_) / (hi_ - lo_));
    }
    const k: number[] = [];
    for (let i = 2; i < raw.length; i++) k.push((raw[i - 2] + raw[i - 1] + raw[i]) / 3);
    const d: number[] = [];
    for (let i = 2; i < k.length; i++) d.push((k[i - 2] + k[i - 1] + k[i]) / 3);
    const K_ = k[k.length - 1] * 100, D_ = d[d.length - 1] * 100;
    const p = K_ < 20 && K_ > D_ ? 0.5 : K_ > 80 && K_ < D_ ? -0.5 : 0;
    const st = p > 0 ? "oversold, turning up" : p < 0 ? "overbought, turning down" : K_ < 20 ? "oversold" : K_ > 80 ? "overbought" : "neutral";
    res.stochrsi = { k: rd(K_, 1), d: rd(D_, 1), state: st, points: p };
    pts += p; mx += 0.5;
  }

  const vols = candles.slice(0, -1).map((c) => c[5]);
  if (vols.length >= 21 && vols.slice(-21).every((x) => x != null)) {
    const avg = (vols.slice(-21, -1) as number[]).reduce((a, b) => a + b, 0) / 20;
    const last = candles[candles.length - 2];
    const ratio = avg ? (vols[vols.length - 1] as number) / avg : null;
    if (ratio != null) {
      const upC = last[4] >= last[1];
      const p = ratio >= 1.5 ? (upC ? 0.5 : -0.5) : 0;
      const st = ratio >= 1.5 ? `high volume on ${upC ? "green" : "red"} candle` : ratio < 0.6 ? "low volume" : "normal volume";
      res.volume = { ratio: rd(ratio, 2), state: st, points: p };
      pts += p; mx += 0.5;
    }
  }

  const score = mx ? pts / mx : 0;
  return {
    price: sig(price), candle_time: new Date(candles[candles.length - 1][0] * 1000).toISOString().replace(".000Z", "Z"),
    bars: candles.length, indicators: res, points: Math.round(pts * 100) / 100, max_points: mx, score: Math.round(score * 1000) / 1000,
  };
}

export function resample(c: Candle[], secs: number): Candle[] {
  const out = new Map<number, Candle>();
  for (const [t, o, h, l, cl, v] of c) {
    const k = t - (t % secs);
    const b = out.get(k);
    if (!b) out.set(k, [k, o, h, l, cl, v]);
    else { b[2] = Math.max(b[2], h); b[3] = Math.min(b[3], l); b[4] = cl; b[5] = v == null || b[5] == null ? null : b[5] + v; }
  }
  let rows = [...out.values()].sort((a, b) => a[0] - b[0]);
  if (rows.length > 1 && c.length && c[0][0] % secs) rows = rows.slice(1);
  return rows;
}

// ------------------------------------------------------------------ candles
const UA = { Accept: "application/json", "User-Agent": "lumi-api-live/1.0 (+https://lumitrades.io)" };

/** Primary venue (Coinbase or Kraken), then OKX spot (SYM-USDT) when the primary errors or rate-limits. */
export async function fetchCandles(f: typeof fetch, coin: LiveCoin, tf: "1h" | "1d"): Promise<Candle[]> {
  try {
    return await fetchPrimary(f, coin, tf);
  } catch (e) {
    try {
      return await fetchOkx(f, coin, tf);
    } catch {
      throw e;
    }
  }
}

async function fetchOkx(f: typeof fetch, coin: LiveCoin, tf: "1h" | "1d"): Promise<Candle[]> {
  const r = await f(`https://www.okx.com/api/v5/market/candles?instId=${coin.symbol}-USDT&bar=${tf === "1h" ? "1H" : "1Dutc"}&limit=300`, { headers: UA });
  if (!r.ok) throw new Error(`okx ${coin.symbol} ${tf}: HTTP ${r.status}`);
  const d = (await r.json()) as { code?: string; data?: string[][] };
  if (d.code !== "0" || !d.data?.length) throw new Error(`okx ${coin.symbol} ${tf}: code ${d.code}`);
  return d.data.map((x) => [Math.floor(Number(x[0]) / 1000), +x[1], +x[2], +x[3], +x[4], +x[5]] as Candle).sort((a, b) => a[0] - b[0]);
}

async function fetchPrimary(f: typeof fetch, coin: LiveCoin, tf: "1h" | "1d"): Promise<Candle[]> {
  if (coin.source === "coinbase") {
    const r = await f(`https://api.exchange.coinbase.com/products/${coin.product}/candles?granularity=${tf === "1h" ? 3600 : 86400}`, { headers: UA });
    if (!r.ok) throw new Error(`coinbase ${coin.product} ${tf}: HTTP ${r.status}`);
    const rows = (await r.json()) as number[][];
    return rows.map((x) => [x[0], x[3], x[2], x[1], x[4], x[5]] as Candle).sort((a, b) => a[0] - b[0]);
  }
  const r = await f(`https://api.kraken.com/0/public/OHLC?pair=${coin.product}&interval=${tf === "1h" ? 60 : 1440}`, { headers: UA });
  if (!r.ok) throw new Error(`kraken ${coin.product} ${tf}: HTTP ${r.status}`);
  const d = (await r.json()) as { error?: string[]; result?: Record<string, unknown> };
  if (d.error?.length) throw new Error(`kraken ${coin.product}: ${d.error.join(",")}`);
  const key = Object.keys(d.result ?? {}).find((k) => k !== "last");
  const rows = (key ? d.result![key] : []) as (string | number)[][];
  return rows.slice(-MAX_BARS).map((x) => [Number(x[0]), +x[1], +x[2], +x[3], +x[4], +x[6]] as Candle);
}

/** Price block derived from 1h candles (the open, still-forming candle's close is the latest trade price). */
export function priceFrom1h(h1: Candle[]) {
  const last = h1[h1.length - 1];
  const day = h1.slice(-24);
  const ago = h1.length > 24 ? h1[h1.length - 25][4] : day[0][1];
  const vol = day.every((c) => c[5] != null) ? day.reduce((a, c) => a + (c[5] as number) * c[4], 0) : null;
  return {
    usd: sig(last[4]),
    change_24h_pct: ago ? rd(((last[4] - ago) / ago) * 100, 2) : null,
    high_24h: sig(Math.max(...day.map((c) => c[2]))),
    low_24h: sig(Math.min(...day.map((c) => c[3]))),
    volume_24h_usd: vol == null ? null : Math.round(vol),
  };
}

// ------------------------------------------------------------------ store
export interface LiveRow {
  id: string; symbol: string; name: string; source: string;
  score: number | null; label: string; price: ReturnType<typeof priceFrom1h> | null;
  timeframes: Record<string, TfResult>; computed_at: number; daily_at: number; error?: string | null;
  /** Last refresh attempt (ms), set when it failed, so a failing coin does not hog every slice. */
  attempt_at?: number;
}

/** Scheduling columns only (no doc parse): what the cron needs to pick the stalest coins cheaply. */
export interface LiveIndex { id: string; computed_at: number; daily_at: number; attempt_at: number }

export interface LiveStore {
  all(): Promise<LiveRow[]>;
  index(): Promise<LiveIndex[]>;
  getMany(ids: string[]): Promise<LiveRow[]>;
  get(id: string): Promise<LiveRow | null>;
  put(rows: LiveRow[]): Promise<void>;
}

export class MemoryLiveStore implements LiveStore {
  rows = new Map<string, LiveRow>();
  async all() { return [...this.rows.values()]; }
  async index() { return [...this.rows.values()].map((r) => ({ id: r.id, computed_at: r.computed_at, daily_at: r.daily_at, attempt_at: r.attempt_at ?? 0 })); }
  async getMany(ids: string[]) { return ids.map((id) => this.rows.get(id)).filter((r): r is LiveRow => !!r); }
  async get(id: string) { return this.rows.get(id) ?? null; }
  async put(rows: LiveRow[]) { for (const r of rows) this.rows.set(r.id, r); }
}

export class D1LiveStore implements LiveStore {
  constructor(private db: D1Like) {}
  private parse(x: Record<string, unknown>): LiveRow {
    return { ...(JSON.parse(String(x.doc)) as LiveRow), computed_at: Number(x.computed_at), daily_at: Number(x.daily_at) };
  }
  async all() {
    const out = await this.db.prepare("SELECT doc, computed_at, daily_at FROM live_signals").all();
    return (out.results ?? []).map((x) => this.parse(x));
  }
  async index() {
    const out = await this.db.prepare("SELECT id, computed_at, daily_at, COALESCE(json_extract(doc, '$.attempt_at'), 0) AS attempt_at FROM live_signals").all();
    return (out.results ?? []).map((x) => ({ id: String(x.id), computed_at: Number(x.computed_at), daily_at: Number(x.daily_at), attempt_at: Number(x.attempt_at) }));
  }
  async getMany(ids: string[]) {
    if (!ids.length) return [];
    const out = await this.db.prepare(`SELECT doc, computed_at, daily_at FROM live_signals WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
    return (out.results ?? []).map((x) => this.parse(x));
  }
  async get(id: string) {
    const x = await this.db.prepare("SELECT doc, computed_at, daily_at FROM live_signals WHERE id = ?").bind(id).first();
    return x ? this.parse(x) : null;
  }
  async put(rows: LiveRow[]) {
    if (!rows.length) return;
    await this.db.batch(
      rows.map((r) =>
        this.db
          .prepare("INSERT INTO live_signals (id, computed_at, daily_at, doc) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET computed_at=excluded.computed_at, daily_at=excluded.daily_at, doc=excluded.doc")
          .bind(r.id, r.computed_at, r.daily_at, JSON.stringify(r)),
      ),
    );
  }
}

// ------------------------------------------------------------------ refresh
function combine(tfs: Record<string, TfResult>): { score: number | null; label: string } {
  let tot = 0, w = 0;
  for (const [tf, wt] of Object.entries(TF_WEIGHTS)) {
    const t = tfs[tf];
    if (!t) continue;
    tot += t.score * wt; w += wt;
  }
  const score = w ? Math.round((tot / w) * 1000) / 1000 : null;
  return { score, label: score == null ? "n/a" : label(score) };
}

/** Recompute one coin. `prev` supplies the cached 1d analysis when it is still fresh. */
export async function computeCoin(f: typeof fetch, coin: LiveCoin, prev: LiveRow | null, now: number, refreshDaily: boolean): Promise<LiveRow> {
  const [h1, d1] = await Promise.all([fetchCandles(f, coin, "1h"), refreshDaily ? fetchCandles(f, coin, "1d") : Promise.resolve(null)]);
  if (h1.length < 35) throw new Error(`${coin.symbol}: only ${h1.length} 1h candles`);
  const tfs: Record<string, TfResult> = {};
  const a1 = analyze(h1, "1h");
  tfs["1h"] = { ...a1, label: label(a1.score) };
  const h4 = resample(h1, 14400);
  if (h4.length >= 35) { const a = analyze(h4, "4h"); tfs["4h"] = { ...a, label: label(a.score) }; }
  let dailyAt = prev?.daily_at ?? 0;
  if (d1 && d1.length >= 35) { const a = analyze(d1, "1d"); tfs["1d"] = { ...a, label: label(a.score) }; dailyAt = now; }
  else if (prev?.timeframes?.["1d"] && now - dailyAt < 2 * DAILY_REFRESH_MS) tfs["1d"] = prev.timeframes["1d"];
  return { id: coin.id, symbol: coin.symbol, name: coin.name, source: coin.source, ...combine(tfs), price: priceFrom1h(h1), timeframes: tfs, computed_at: now, daily_at: dailyAt, error: null };
}

/** One cron slice: the LIVE_CHUNK stalest coins (missing first), daily candles for up to LIVE_DAILY_CHUNK of them. */
export async function refreshLive(store: LiveStore, f: typeof fetch, now: number, chunk = LIVE_CHUNK, dailyChunk = LIVE_DAILY_CHUNK) {
  const idx = new Map((await store.index()).map((r) => [r.id, r]));
  const tried = (id: string) => { const r = idx.get(id); return Math.max(r?.computed_at ?? 0, r?.attempt_at ?? 0); };
  const order = [...LIVE_UNIVERSE].sort((a, b) => tried(a.id) - tried(b.id)).slice(0, chunk);
  const rows = new Map((await store.getMany(order.map((c) => c.id).filter((id) => idx.has(id)))).map((r) => [r.id, r]));
  const dailyDue = new Set(
    order.filter((c) => now - (idx.get(c.id)?.daily_at ?? 0) > DAILY_REFRESH_MS)
      .sort((a, b) => (idx.get(a.id)?.daily_at ?? 0) - (idx.get(b.id)?.daily_at ?? 0))
      .slice(0, dailyChunk).map((c) => c.id),
  );
  const done: LiveRow[] = [];
  const errors: string[] = [];
  const results = await Promise.allSettled(order.map((c) => computeCoin(f, c, rows.get(c.id) ?? null, now, dailyDue.has(c.id))));
  results.forEach((r, i) => {
    if (r.status === "fulfilled") return void done.push(r.value);
    const c = order[i];
    const msg = String(r.reason?.message ?? r.reason).slice(0, 120);
    errors.push(`${c.symbol}: ${msg}`);
    const prev = rows.get(c.id);
    done.push(prev ? { ...prev, error: msg, attempt_at: now }
      : { id: c.id, symbol: c.symbol, name: c.name, source: c.source, score: null, label: "n/a", price: null, timeframes: {}, computed_at: 0, daily_at: 0, error: msg, attempt_at: now });
  });
  await store.put(done);
  return { refreshed: done.filter((r) => r.computed_at === now).map((r) => r.symbol), daily: dailyDue.size, errors };
}

export function liveCoin(idOrSymbol: string): LiveCoin | undefined {
  const q = idOrSymbol.trim().toLowerCase();
  return LIVE_UNIVERSE.find((c) => c.id === q || c.symbol.toLowerCase() === q);
}

export const isFresh = (r: LiveRow | null | undefined, now: number): r is LiveRow => !!r && now - r.computed_at <= LIVE_MAX_AGE_MS && !!r.timeframes?.["1h"];
