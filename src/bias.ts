/**
 * Neutral, non-advice wording for Lumi's market readings (signal, lite, scan, levels, slate, brief, market).
 *
 * The indicator score is unchanged; only its label is reworded: the old five buy/sell labels collapse into a
 * momentum/trend bias (positive / neutral / negative) that is always shown next to the score. Free text from the
 * site (commentary, bias notes, newsletter lines) is reworded the same way, and any sentence that reads like a trade
 * plan (entries, stops, targets, leverage, break-even, long/short setups, scenario price levels) is dropped.
 */

export type Bias = "positive bias" | "neutral bias" | "negative bias";
export const BIASES: Bias[] = ["positive bias", "neutral bias", "negative bias"];

/** Thresholds on the score (-1..1); same cut-offs as before, without the buy/sell names. */
export const BIAS_RULE = "score >= 0.15 positive bias; > -0.15 neutral bias; else negative bias (score from -1 to 1)";
export const BIAS_NOTE = "Momentum/trend reading from mechanical indicators: a description of recent price action, not a forecast and not a recommendation to buy, sell or hold.";

export function biasFromScore(score: number | null | undefined): Bias | null {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  return score >= 0.15 ? "positive bias" : score > -0.15 ? "neutral bias" : "negative bias";
}

/** Map a legacy label (Strong Buy / Buy / Neutral / Sell / Strong Sell, any case) to a bias; the score wins when present. */
export function biasLabel(label: unknown, score?: number | null): Bias | null {
  const fromScore = biasFromScore(score);
  if (fromScore) return fromScore;
  const l = String(label ?? "").trim().toLowerCase();
  if (/^(strong\s+)?buy$|bull/.test(l)) return "positive bias";
  if (/^(strong\s+)?sell$|bear/.test(l)) return "negative bias";
  if (l === "neutral") return "neutral bias";
  return null;
}

/** long/short (paper-idea direction) as a bias. */
export function biasFromDirection(direction: unknown): Bias | null {
  const d = String(direction ?? "").toLowerCase();
  return d === "long" ? "positive bias" : d === "short" ? "negative bias" : null;
}

const WORDS: [RegExp, string][] = [
  [/\bstrong\s+buy\b/gi, "positive bias"],
  [/\bstrong\s+sell\b/gi, "negative bias"],
  [/\bbull(?:ish)?\s+market\b/gi, "uptrend"],
  [/\bbear\s+market\b/gi, "downturn"],
  [/\bbullish(?:ly)?\b/gi, "positive"],
  [/\bbearish(?:ly)?\b/gi, "negative"],
  [/\bbulls\b/gi, "buyers"],
  [/\bbears\b/gi, "sellers"],
  [/\bbull\b/gi, "upside"],
  [/\bbear\b/gi, "downside"],
];

/** Sentences that read like a trade plan (or a price-scenario level) are dropped from free text. */
const TRADE_PLAN =
  /\b(price\s+targets?|targets?|take[- ]profit|stop(?:[- ]loss)?s?|stopped\s+out|entry|entries|entry\s+zone|re-?entry|leverage[d]?|\d+(?:\.\d+)?\s?x\s+(?:long|short)|break[- ]?even|move\s+(?:the\s+)?stop|paper[- ]trades?|trade\s+ideas?|setups?|go(?:ing)?\s+long|go(?:ing)?\s+short|(?:a|the|to)\s+(?:long|short)(?![- ]?(?:term|time|run|while|way|list|lived|dated|squeeze))\b|longs?\s+(?:needs?|from|at|above|below|into)|shorts?\s+(?:needs?|from|at|above|below|into)|scenario|projection|base\s+case)\b/i;

export function neutralWords(s: string): string {
  let out = s;
  for (const [re, to] of WORDS) out = out.replace(re, (m) => (m[0] === m[0].toUpperCase() && m[0] !== m[0].toLowerCase() ? to[0].toUpperCase() + to.slice(1) : to));
  return out;
}

const splitSentences = (s: string) =>
  s
    .split(/(?<=[.!?;])\s+(?=[A-Z0-9"'(\[$~*])/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Reword bull/bear and buy/sell language and drop trade-plan sentences; null when nothing neutral is left. */
export function neutralText(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const kept = splitSentences(s).filter((x) => !TRADE_PLAN.test(x));
  const out = neutralWords(kept.join(" ")).trim();
  return out ? out : null;
}

export function isTradePlanText(s: string): boolean {
  return TRADE_PLAN.test(s);
}

/** Recursively apply neutralText to every string (arrays drop emptied strings). Used on free-text blocks only. */
export function neutralDeep<T>(v: T): T {
  if (typeof v === "string") return (neutralText(v) ?? "") as unknown as T;
  if (Array.isArray(v)) return v.map((x) => neutralDeep(x)).filter((x) => !(typeof x === "string" && x === "")) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = neutralDeep(x);
    return out as T;
  }
  return v;
}
