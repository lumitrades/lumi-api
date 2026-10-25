import { BAZAAR_ROUTES } from "../src/bazaar";
import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { institutionalView, linkType } from "../src/institutional";
import { maxAgeMs } from "../src/freshness";
import { DATA, FACILITATOR, PAY_TO, NOW, fixture, happyFacilitator, makeFetch, paymentHeaderFor, decodeB64Json, type FakeFacilitator } from "./helpers";

const KEY = "k".repeat(20) + "0123456789abcdef0123456789abcdef";
const EVM_PAY_TO = "0x5E617bac19912e6d212CB303ae84655E9E203532";
const ENV = {
  XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret",
  PRIVATE_NAMES: "Canaryname", OWNER_MCP_KEY: KEY, EVM_PAY_TO, EVM_NETWORK: "eip155:84532",
};
const BASE = "http://lumi.test";
const H = 3_600_000;

function setup(opts: { override?: Record<string, unknown>; now?: number; fac?: FakeFacilitator } = {}) {
  const fac = opts.fac ?? happyFacilitator();
  const app = createApp(ENV, { fetch: makeFetch(fac, { override: opts.override }), log: () => {}, now: () => opts.now ?? NOW });
  const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(BASE + path, { headers }));
  let n = 0;
  const mcp = async (name: string, args: unknown = {}, headers: Record<string, string> = {}) => {
    const r = await app.fetch(new Request(BASE + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }),
    }));
    return (await r.json()).result;
  };
  const a2a = async (parts: unknown[]) => {
    const r = await app.fetch(new Request(BASE + "/a2a", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId: "m", role: "ROLE_USER", parts } } }),
    }));
    return (await r.json()).result.message.parts;
  };
  return { get, mcp, a2a, fac };
}

describe("/v1/institutional: 402 terms ($0.10)", () => {
  it("quotes 0.077 XRP, 0.10 RLUSD, 0.10 USDC on XRPL and 0.10 USDC on Base", async () => {
    const { get, fac } = setup();
    const r = await get("/v1/institutional");
    expect(r.status).toBe(402);
    const body = await r.json();
    expect(decodeB64Json(r.headers.get("PAYMENT-REQUIRED"))).toEqual(body);
    expect(body.resource.url).toBe(`${BASE}/v1/institutional`);
    expect(body.accepts.map((a: any) => [a.network, a.extra?.symbol ?? a.asset, a.amount])).toEqual([
      ["eip155:84532", "USDC", "100000"], ["xrpl:1", "XRP", "77000"], ["xrpl:1", "RLUSD", "0.1"], ["xrpl:1", "USDC", "0.1"],
    ]);
    expect(new Set(body.accepts.map((a: any) => a.extra.invoiceId)).size).toBe(1);
    expect(fac.calls).toHaveLength(0);
  });

  it("is listed in the free catalog, discovery, OpenAPI and skill.md", async () => {
    const { get } = setup();
    const idx = await (await get("/")).json();
    const row = idx.paid_endpoints.find((p: any) => p.path === "/v1/institutional");
    expect(row).toMatchObject({ price_xrp: "0.077", price_drops: "77000", price_rlusd: "0.1", price_usdc: "0.1", price_base_usdc: "0.1" });
    expect(row.summary).toMatch(/^Use this when you need .*central banks.*regulators/s);
    expect(idx.mcp.tools.paid).toContain("lumi_institutional_brief");
    const oa = await (await get("/openapi.json")).json();
    const op = oa.paths["/v1/institutional"].get;
    expect(op["x-payment-info"].price).toEqual({ mode: "fixed", currency: "USD", amount: "0.100000" });
    expect(op.parameters[0]).toMatchObject({ name: "format" });
    const wk = await (await get("/.well-known/x402")).json();
    expect(wk.resources.map((r: any) => r.url)).toContain(`${BASE}/v1/institutional`);
    const skill = await (await get("/skill.md")).text();
    expect(skill).toContain("GET /v1/institutional");
    expect(skill).toContain("0.077 XRP");
  });
});

describe("/v1/institutional: payload", () => {
  async function paid(path = "/v1/institutional", override?: Record<string, unknown>) {
    const { get, fac } = setup({ override });
    const q = await (await get(path)).json();
    const r = await get(path, { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts[2]) });
    expect(r.status).toBe(200);
    expect(fac.calls.map((c) => c.path)).toEqual(["/verify", "/settle"]);
    return r;
  }

  it("returns sourced items with link types, a per-token map, markdown and the disclaimer", async () => {
    const b = await (await paid()).json();
    expect(b.kind).toBe("institutional");
    expect(b.date).toBe("2026-10-22");
    expect(b.as_of).toBe("2026-10-22T12:00:00Z");
    expect(b.items).toHaveLength(12);
    for (const i of b.items) {
      expect(i.source_url).toMatch(/^https:\/\//);
      expect(["confirmed", "indirect_alignment", "context"]).toContain(i.link_type);
    }
    expect(b.items.find((i: any) => i.entity === "BIS").link_type).toBe("indirect_alignment");
    expect(b.coin_map.XRP.confirmed.map((x: any) => x.entity)).toEqual(expect.arrayContaining(["Cross River Bank", "Ripple"]));
    expect(b.coin_map.XRP.indirect_alignment.map((x: any) => x.entity)).toContain("BIS");
    expect(b.coin_map.QNT).toEqual({ note: "No institutional items for this token in this window." });
    expect(Object.keys(b.coin_map)).toEqual(["XRP", "XLM", "XDC", "QNT", "AXL", "HBAR"]);
    expect(b.link_types.indirect_alignment).toMatch(/Not a partnership/);
    expect(b.no_notable_news.map((n: any) => n.entity)).toContain("Securitize");
    expect(b.watch_next.length).toBeGreaterThan(3);
    expect(b.markdown).toContain("# Lumi Trades: Institutional & Policy Brief, 2026-10-22");
    expect(b.markdown).toContain("indirect alignment (Lumi analysis)");
    expect(b.markdown).toContain("Not financial advice");
    expect(b.disclaimer).toMatch(/Not financial advice/);
    expect(b.payment).toMatchObject({ asset: "RLUSD", amount: "0.1" });
  });

  it("?format=md returns text/markdown with the receipt", async () => {
    const r = await paid("/v1/institutional?format=md");
    expect(r.headers.get("Content-Type")).toMatch(/text\/markdown/);
    expect(r.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
    const t = await r.text();
    expect(t).toContain("## By token");
    expect(t).toContain("_Paid: 0.1 RLUSD");
  });

  it("scrubs private names and personal-holdings text from the published file", async () => {
    const f = fixture("institutional_brief");
    f.big_picture = [...f.big_picture, "Canaryname thinks this is big.", "We hold a large bag."];
    f.items[0].why_it_matters += " My holdings are up.";
    const b = await (await paid("/v1/institutional", { institutional_brief: f })).json();
    expect(JSON.stringify(b)).not.toMatch(/canaryname|my holdings|we hold/i);
  });
});

describe("/v1/institutional: never charged when stale or missing", () => {
  it("allows 36 h at the default 12 h base", () => {
    expect(maxAgeMs("institutional_brief", 12)).toBe(36 * H);
  });

  it("serves up to 36 h old; refuses older with 503 stale_data, no quote, payment header ignored", async () => {
    const ok = setup({ now: Date.parse("2026-10-22T12:00:00Z") + 35 * H });
    // other inputs are not needed by this route, so only the brief's age matters
    expect((await ok.get("/v1/institutional")).status).toBe(402);

    const { get, fac } = setup({ now: Date.parse("2026-10-22T12:00:00Z") + 37 * H });
    const r = await get("/v1/institutional");
    expect(r.status).toBe(503);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(await r.json()).toMatchObject({ error: "stale_data", note: "Not charged.", inputs: [{ file: "institutional_brief.json" }] });
    const fresh = setup();
    const q = await (await fresh.get("/v1/institutional")).json();
    const paidStale = await get("/v1/institutional", { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts[0]) });
    expect(paidStale.status).toBe(503);
    expect(fac.calls).toHaveLength(0);
  });

  it("missing file, no timestamp, or no content: 503 not charged", async () => {
    for (const o of [null, { ...fixture("institutional_brief"), generated_utc: undefined }, { generated_utc: "2026-10-22T12:00:00Z", big_picture: [], items: [] }]) {
      const { get, fac } = setup({ override: { institutional_brief: o } });
      const r = await get("/v1/institutional");
      expect(r.status).toBe(503);
      expect((await r.json()).note).toBe("Not charged.");
      expect(fac.calls).toHaveLength(0);
    }
  });
});

describe("institutionalView rules", () => {
  it("drops unsourced items and alignments, normalises link types, keeps theses labelled as analysis", () => {
    const v: any = institutionalView({
      generated_utc: "2026-10-22T12:00:00Z",
      date: "2026-10-22",
      big_picture: ["x"],
      items: [
        { entity: "A", headline: "h", source_url: "https://a.example/1", coins: ["xrp"], link_type: "Indirect Alignment" },
        { entity: "B", headline: "no source", coins: ["XRP"], link_type: "confirmed" },
        { entity: "C", headline: "h", source_url: "javascript:alert(1)", link_type: "confirmed" },
        { entity: "D", headline: "h", source_url: "https://d.example", coins: ["QNT"], link_type: "partner!" },
      ],
      alignments: [
        { entity: "IMF", coin: "xrp", theme: "shared ledger", institution_says: "a", institution_source_url: "https://imf.example", token_says: "b", token_source_url: "https://xrpl.example" },
        { entity: "IMF", coin: "XLM", institution_says: "a", token_says: "b", institution_source_url: "https://imf.example" },
      ],
      theses: [{ title: "T", text: "t", sources: ["https://s.example"] }, { title: "No source", text: "t", sources: [] }],
    });
    expect(v.items.map((i: any) => [i.entity, i.link_type, i.coins])).toEqual([["A", "indirect_alignment", ["XRP"]], ["D", "unspecified", ["QNT"]]]);
    expect(v.alignments).toHaveLength(1);
    expect(v.alignments[0]).toMatchObject({ coin: "XRP", link_type: "indirect_alignment" });
    expect(v.coin_map.XRP.indirect_alignment.map((x: any) => x.entity)).toEqual(["A", "IMF"]);
    expect(v.coin_map.QNT.context[0].entity).toBe("D");
    expect(v.theses_tracked).toEqual([{ title: "T", text: "t", status: "analytical_thesis", sources: ["https://s.example"] }]);
    expect(v.markdown).toContain("Indirect alignment (Lumi's analysis, not confirmed partnerships)");
    expect(v.markdown).toContain("Theses being tracked (analysis, not fact)");
    expect(linkType("confirmed")).toBe("confirmed");
  });

  it("ignores a provided markdown field (it can carry impact wording), renders from whitelisted fields, appends the disclaimer", () => {
    const v: any = institutionalView({ generated_utc: "2026-10-22T12:00:00Z", big_picture: ["x"], items: [], no_notable_news: [{ entity: "R3" }], markdown: "# Hand-written\nBullish: go long XRP." });
    expect(v.markdown).not.toContain("Hand-written");
    expect(v.markdown).not.toMatch(/long|bullish/i);
    expect(v.markdown).toMatch(/^# Lumi Trades: Institutional & Policy Brief/);
    expect(v.markdown).toContain("Not financial advice");
    expect(v.no_notable_news[0].note).toBe("No notable news in this window.");
  });
});

describe("institutional brief over MCP and A2A", () => {
  it("public MCP call returns the price and how to pay; owner key gets the brief free", async () => {
    const { mcp, fac } = setup();
    const pub = await mcp("lumi_institutional_brief");
    expect(pub.isError).toBe(true);
    expect(pub.content[0].text).toMatch(/0\.1 USDC on Base Sepolia, or 0\.077 XRP or 0\.1 RLUSD or 0\.1 USDC on the XRP Ledger/);
    expect(pub.content[0].text).toContain(`${BASE}/v1/institutional`);
    const own = await mcp("lumi_institutional_brief", {}, { Authorization: `Bearer ${KEY}` });
    expect(own.isError).toBeUndefined();
    const b = JSON.parse(own.content[0].text);
    expect(b).toMatchObject({ kind: "institutional", access: { mode: "owner", charged: false } });
    const md = await mcp("lumi_institutional_brief", { format: "md" }, { Authorization: `Bearer ${KEY}` });
    expect(md.content[0].text).toMatch(/^# Lumi Trades: Institutional & Policy Brief/);
    expect(fac.calls).toHaveLength(0);
  });

  it("A2A routes institutional questions to the institutional skill; market questions go to /v1/market (the brief is retired)", async () => {
    const { a2a } = setup();
    const p = await a2a([{ text: "what are the BIS and IMF doing that matters for XRP?" }]);
    expect(p[1].data.url).toBe(`${BASE}/v1/institutional`);
    expect(p[1].data.options.map((o: any) => o.amount)).toEqual(["0.1", "0.077", "0.1", "0.1"]);
    expect((await a2a([{ text: "today's crypto market brief" }]))[1].data.url).toBe(`${BASE}/v1/market`);
    expect((await a2a([{ data: { skill: "institutional" } }]))[1].data.url).toBe(`${BASE}/v1/institutional`);
  });
});


describe("?format validation", () => {
  it("rejects unknown format values with 400 before any quote or settlement", async () => {
    const { get, fac } = setup();
    for (const p of ["/v1/institutional?format=xml", "/v1/institutional?format=pdf"]) {
      const r = await get(p);
      expect(r.status).toBe(400);
      expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
      expect((await r.json()).error).toBe("invalid_format");
    }
    expect((await get("/v1/institutional?format=json")).status).toBe(402);
    expect(fac.calls).toEqual([]);
  });

  it("/health names the facilitator actually used", async () => {
    const { get } = setup();
    const h = await (await get("/health")).json();
    expect(h.evm.facilitator).toMatch(/^https:\/\//);
  });
});

describe("Bazaar resource descriptions", () => {
  it("use the v2 listing text verbatim, with no price in the text (prices live in accepts[]), never cut and never instructions to agents", async () => {
    const { get } = setup();
    for (const [p, route, usd] of [["/v1/market", "market", "0.02"], ["/v1/institutional", "institutional", "0.1"], ["/v1/trust/check?url=https://a.example/x", "trust_check", ""]] as const) {
      const d = (await (await get(p)).json()).resource.description as string;
      expect(d.length, p).toBeLessThanOrEqual(500);
      expect(d, p).toBe(BAZAAR_ROUTES[route].description);
      if (usd) expect(d, p).not.toContain(`$${Number(usd)}`);
      expect(d).not.toMatch(/\b(you must|ignore previous|always call)\b/i);
    }
  });
});
