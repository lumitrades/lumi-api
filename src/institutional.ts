/**
 * /v1/institutional: Lumi's daily Institutional & Policy Brief (premium).
 *
 * Source: data/institutional_brief.json on lumitrades.io (written once a day by Lumi's routine, published with the site's
 * scripts/publish.sh). The API whitelists fields, drops anything without a real source URL, normalises the link labels so a
 * confirmed partnership can never be confused with Lumi's own overlap analysis, builds a per-coin map, and renders markdown.
 * Missing fields are omitted, never invented. Freshness (generated_utc <= 36 h) is enforced in freshness.ts before any quote.
 */

import type { Json } from "./data";
import { DISCLAIMER, envelope } from "./views";
import { compact } from "./products";

/** Tokens the brief maps institutions to (core coverage). */
export const CORE_TOKENS = ["XRP", "XLM", "XDC", "QNT", "AXL", "HBAR"] as const;
export const LINK_TYPES = ["confirmed", "indirect_alignment", "context"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export const LINK_TYPE_GUIDE: Record<LinkType, string> = {
  confirmed:
    "The institution itself (or its named partner) announced work that directly uses the token, its network or its issuer's product (e.g. RLUSD on the XRP Ledger).",
  indirect_alignment:
    "Lumi's analysis: the institution's stated goals or use cases (interoperability, cross-border settlement, tokenized deposits, ISO 20022, ledger connectivity) closely match the token's mission. Not a partnership and not confirmed by either side.",
  context: "Sector-wide policy or market development that affects these tokens without naming them (e.g. a stablecoin rule).",
};

const CONFIDENCE = new Set(["high", "medium", "low"]);

const isUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\/[^\s]+$/i.test(v);
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown): string[] => arr(v).map(s).filter((x): x is string => !!x);
const tokens = (v: unknown): string[] => strs(v).map((x) => (/^[a-z0-9-]+$/i.test(x) && x.length <= 12 ? x.toUpperCase() : x));
const enumOr = (v: unknown, ok: Set<string>): string | null => (typeof v === "string" && ok.has(v.toLowerCase()) ? v.toLowerCase() : null);

export function linkType(v: unknown): LinkType | "unspecified" {
  const t = typeof v === "string" ? v.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (t === "indirect" || t === "alignment") return "indirect_alignment";
  return (LINK_TYPES as readonly string[]).includes(t) ? (t as LinkType) : "unspecified";
}

function itemView(i: Json) {
  if (!s(i?.entity) || !s(i?.headline) || !isUrl(i?.source_url)) return null; // real sources only
  return {
    entity: s(i.entity),
    headline: s(i.headline),
    date: isDate(i.date) ? i.date : null,
    source_url: i.source_url,
    additional_sources: arr(i.additional_sources).filter(isUrl),
    why_it_matters: s(i.why_it_matters),
    coins: tokens(i.coins),
    link_type: linkType(i.link_type),
    link_basis: s(i.link_basis),
    confidence: enumOr(i.confidence, CONFIDENCE),
  };
}

/** Lumi's overlap analysis: both sides quoted/paraphrased, both sourced. Always indirect_alignment. */
function alignmentView(a: Json) {
  if (!s(a?.entity) || !s(a?.coin) || !s(a?.institution_says) || !s(a?.token_says)) return null;
  if (!isUrl(a.institution_source_url) || !isUrl(a.token_source_url)) return null;
  return {
    entity: s(a.entity),
    coin: s(a.coin)!.toUpperCase(),
    theme: s(a.theme),
    institution_says: s(a.institution_says),
    institution_source_url: a.institution_source_url,
    token_says: s(a.token_says),
    token_source_url: a.token_source_url,
    overlap: s(a.overlap),
    link_type: "indirect_alignment" as const,
    confidence: enumOr(a.confidence, CONFIDENCE),
  };
}

/** An analytical thesis being tracked: labelled as such, never as fact; needs at least one source. */
function thesisView(t: Json) {
  const sources = arr(t?.sources).filter(isUrl);
  if (!s(t?.title) || !s(t?.text) || !sources.length) return null;
  return { title: s(t.title), text: s(t.text), status: "analytical_thesis", evidence_this_window: s(t.evidence_this_window), sources };
}

type ItemV = NonNullable<ReturnType<typeof itemView>>;
type AlignV = NonNullable<ReturnType<typeof alignmentView>>;

function coinMap(items: ItemV[], alignments: AlignV[]) {
  const out: Record<string, unknown> = {};
  for (const coin of CORE_TOKENS) {
    const row = (i: ItemV) => ({ entity: i.entity, headline: i.headline, date: i.date, source_url: i.source_url });
    const mine = items.filter((i) => i.coins.includes(coin));
    const confirmed = mine.filter((i) => i.link_type === "confirmed").map(row);
    const indirect = [
      ...mine.filter((i) => i.link_type === "indirect_alignment").map(row),
      ...alignments.filter((a) => a.coin === coin).map((a) => ({ entity: a.entity, headline: a.theme ?? a.overlap, source_url: a.institution_source_url })),
    ];
    const context = mine.filter((i) => i.link_type === "context" || i.link_type === "unspecified").map(row);
    out[coin] =
      confirmed.length + indirect.length + context.length
        ? { confirmed, indirect_alignment: indirect, context }
        : { note: "No institutional items for this token in this window." };
  }
  return out;
}

export function institutionalView(d: Json) {
  if (!d || typeof d !== "object") return null;
  const items = arr(d.items).map(itemView).filter((x): x is ItemV => !!x);
  const alignments = arr(d.alignments).map(alignmentView).filter((x): x is AlignV => !!x);
  const body = compact({
    title: "Lumi Trades: Institutional & Policy Brief",
    date: isDate(d.date) ? d.date : null,
    as_of: d.generated_utc ?? null,
    coverage_window: d.coverage_window && isDate(d.coverage_window.from) && isDate(d.coverage_window.to) ? { from: d.coverage_window.from, to: d.coverage_window.to } : null,
    core_tokens: [...CORE_TOKENS],
    big_picture: strs(d.big_picture),
    items,
    coin_map: coinMap(items, alignments),
    alignments,
    theses_tracked: arr(d.theses).map(thesisView).filter(Boolean),
    connections: arr(d.connections)
      .map((c: Json) => (s(c?.text) ? { theme: s(c.theme), text: s(c.text), entities: strs(c.entities) } : null))
      .filter(Boolean),
    no_notable_news: arr(d.no_notable_news)
      .map((n: Json) => (s(n?.entity) ? { entity: s(n.entity), note: s(n.note) ?? "No notable news in this window." } : null))
      .filter(Boolean),
    watch_next: arr(d.watch_next)
      .map((w: Json) => (s(w?.event) && isDate(w?.date) ? { date: w.date, end_date: isDate(w.end_date) ? w.end_date : null, event: s(w.event), source_url: isUrl(w.source_url) ? w.source_url : null } : null))
      .filter(Boolean),
    link_types: LINK_TYPE_GUIDE,
    method:
      "Sourced from official releases, filings, speeches and reputable outlets in the coverage window. Institutions are linked to tokens either because " +
      "they announced it (confirmed) or because their stated goals closely match a token's mission (indirect_alignment: Lumi's analysis, not a partnership). " +
      "Institutions only; neutral and apolitical. No price or market-direction calls.",
    brief_note: s(d.disclaimer),
  });
  // Always rendered from the whitelisted fields (2026-10-25): the site's own markdown can carry wording (impact / direction)
  // that the API no longer publishes, so it is never passed through.
  const env = envelope("institutional", body as Record<string, unknown>);
  const md = institutionalMarkdown(env as Json);
  return { ...env, markdown: md && !md.includes(DISCLAIMER) ? `${md.trimEnd()}\n\n_${DISCLAIMER}_\n` : md };
}

const LABEL: Record<string, string> = { confirmed: "confirmed", indirect_alignment: "indirect alignment (Lumi analysis)", context: "context", unspecified: "context" };

/** Render the (already sanitized) institutional brief as markdown. */
export function institutionalMarkdown(b: Json): string {
  const L: string[] = [];
  L.push(`# Lumi Trades: Institutional & Policy Brief, ${b.date ?? String(b.timestamp).slice(0, 10)}`);
  if (b.coverage_window) L.push(`_Coverage window: ${b.coverage_window.from} to ${b.coverage_window.to}_`);
  if (b.big_picture?.length) {
    L.push("", "## Big picture");
    for (const p of b.big_picture) L.push(`- ${p}`);
  }
  if (b.items?.length) {
    L.push("", "## Per-player items");
    for (const i of b.items) {
      const extra = (i.additional_sources ?? []).map((u: string, n: number) => `[${n + 2}](${u})`).join(", ");
      L.push(
        "",
        `**${i.entity}: ${i.headline}**${i.date ? ` (${i.date})` : ""} · [source](${i.source_url})${extra ? `, ${extra}` : ""}`,
        `${i.why_it_matters ? `${i.why_it_matters} ` : ""}_Coins:_ ${(i.coins ?? []).join(", ") || "n/a"} · _Link:_ ${LABEL[i.link_type] ?? i.link_type}${i.confidence ? ` · _Confidence:_ ${i.confidence}` : ""}`,
      );
      if (i.link_basis) L.push(`_Basis:_ ${i.link_basis}`);
    }
  }
  if (b.alignments?.length) {
    L.push("", "## Indirect alignment (Lumi's analysis, not confirmed partnerships)");
    for (const a of b.alignments) {
      L.push(`- **${a.entity} ↔ ${a.coin}${a.theme ? ` (${a.theme})` : ""}.** ${a.entity}: "${a.institution_says}" ([source](${a.institution_source_url})). ${a.coin}: "${a.token_says}" ([source](${a.token_source_url})).${a.overlap ? ` ${a.overlap}` : ""}`);
    }
  }
  if (b.theses_tracked?.length) {
    L.push("", "## Theses being tracked (analysis, not fact)");
    for (const t of b.theses_tracked) L.push(`- **${t.title}.** ${t.text}${t.evidence_this_window ? ` This window: ${t.evidence_this_window}` : ""} (${t.sources.map((u: string, n: number) => `[${n + 1}](${u})`).join(", ")})`);
  }
  if (b.coin_map) {
    L.push("", "## By token");
    for (const [coin, m] of Object.entries<Json>(b.coin_map)) {
      if (m.note) { L.push(`- **${coin}:** ${m.note}`); continue; }
      const part = (k: string, label: string) => (m[k]?.length ? `${label}: ${m[k].map((x: Json) => x.entity).join(", ")}` : null);
      L.push(`- **${coin}:** ${[part("confirmed", "confirmed"), part("indirect_alignment", "indirect alignment"), part("context", "context")].filter(Boolean).join("; ")}`);
    }
  }
  if (b.no_notable_news?.length) {
    L.push("", "## No notable news this window");
    for (const n of b.no_notable_news) L.push(`- **${n.entity}:** ${n.note}`);
  }
  if (b.connections?.length) {
    L.push("", "## Connections");
    for (const c of b.connections) L.push(`- ${c.theme ? `**${String(c.theme).replace(/_/g, " ")}.** ` : ""}${c.text}`);
  }
  if (b.watch_next?.length) {
    L.push("", "## What to watch next");
    for (const w of b.watch_next) L.push(`- **${w.date}${w.end_date ? ` to ${w.end_date}` : ""}:** ${w.event}${w.source_url ? ` ([source](${w.source_url}))` : ""}`);
  }
  L.push("", `_Source: Lumi Trades (lumitrades.io), generated ${b.as_of ?? b.timestamp}. ${b.brief_note ? `${b.brief_note} ` : ""}${DISCLAIMER}_`, "");
  return L.join("\n");
}
