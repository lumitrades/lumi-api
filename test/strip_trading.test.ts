import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";
import { thresholdsDoc, VERDICT_RULES_VERSION } from "../src/trust/verdict";
import { biasLabel, neutralText } from "../src/bias";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PRIVATE_NAMES: "Canaryname" };
const BASE = "http://lumi.test";

function setup(env: Record<string, string> = {}) {
  const app = createApp({ ...ENV, ...env }, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW });
  return (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(BASE + path, { headers }));
}
async function paid(path: string) {
  const get = setup();
  const req = (await (await get(path)).json()).accepts[0];
  const r = await get(path, { "PAYMENT-SIGNATURE": paymentHeaderFor(req) });
  expect(r.status, path).toBe(200);
  return r.json();
}

// Keys and words that describe a trade plan or a buy/sell rating.
const TRADE_KEYS = /"(entry|entry_zone|entries|stop|stop_loss|targets?|price_targets?|leverage|scenarios|projection|bull|base|bear|invalidation|move_stop|breakeven|paper_trades|direction)":/i;
const TRADE_WORDS = /strong buy|strong sell|\bbullish\b|\bbearish\b|move (the )?stop|break-?even|price target|entry zone|\bleverage\b/i;

describe("trading content stripped from slate, signal, levels, scan and brief", () => {
  for (const p of ["/v1/slate", "/v1/signal/XRP", "/v1/signal/BTC", "/v1/lite/XRP", "/v1/levels/XRP", "/v1/levels/BTC", "/v1/brief", "/v1/market"]) {
    it(`${p}: no targets, stops, entries, leverage, scenarios, Strong Buy/Sell or bull/bear; no SOL`, async () => {
      const b = await paid(p);
      const s = JSON.stringify(b, (k, v) => (k === "url" ? undefined : v)); // third-party source URLs are kept verbatim
      expect(s, p).not.toMatch(TRADE_KEYS);
      expect(s, p).not.toMatch(TRADE_WORDS);
      expect(s, p).not.toMatch(/"SOL"|\bsolana\b/i);
      expect(b.disclaimer ?? b.notice, p).toBeTruthy();
    });
  }
  it("signal labels are positive/neutral/negative bias with the score", async () => {
    const b = await paid("/v1/signal/XRP");
    expect(b.label).toMatch(/^(positive|neutral|negative) bias$/);
  });
  it("SOL is not served (signal 404/400, not in coins or scan)", async () => {
    const get = setup();
    const r = await get("/v1/signal/SOL");
    expect([400, 404]).toContain(r.status);
    const coins: any = await (await get("/v1/coins")).json();
    expect(JSON.stringify(coins)).not.toMatch(/"SOL"|solana/i);
  });
  it("bias helpers", () => {
    expect(biasLabel("Strong Buy", 80)).toBe("positive bias");
    expect(biasLabel("Sell", -30)).toBe("negative bias");
    expect(biasLabel("Neutral", 0)).toBe("neutral bias");
    expect(neutralText("Bullish breakout; entry 1.20, stop 1.10, targets 1.40.") ?? "").not.toMatch(TRADE_WORDS);
  });
  it("docs, skill.md and discovery carry no trade-plan wording, no old brand names and no SOL", async () => {
    const get = setup();
    for (const p of ["/skill.md", "/openapi.json", "/.well-known/agent-card.json", "/.well-known/x402", "/v1/samples", "/", "/catalog", "/llms.txt"]) {
      const res = await get(p);
      if (res.status === 404) continue;
      const s = await res.text();
      expect(s, p).not.toMatch(/Lumi Market Ideas|Lumi Trust\b/);
      expect(s, p).not.toMatch(/quote-verified|purchase-verified|verified (agent )?reports|paper-trade|51 coins/i);
      expect(s, p).not.toMatch(/strong buy|strong sell|paper-trade ideas|entry zone|price target/i);
    }
  });
});

describe("verdict rules, docs MCP section, openapi 400", () => {
  it("rules say on-chain payer activity can add a warning and paying Lumi never changes a result", () => {
    const d: any = thresholdsDoc({ payMaxAgeDays: 14 } as any);
    expect(d.rules_version).toBe(VERDICT_RULES_VERSION);
    expect(d.never_considered).not.toMatch(/on-chain payment activity/);
    expect(d.never_considered).toMatch(/Paying Lumi never changes a result/);
    expect(d.on_chain_payers).toMatch(/no_organic_payers/);
    expect(d.on_chain_payers).toMatch(/check_first/);
  });
  it("skill.md and /: lumi_verdict is $0.01 when paid; local MCP pays on Base and the XRP Ledger", async () => {
    const get = setup({ VERDICT_PRICING: "paid" });
    const skill = await (await get("/skill.md")).text();
    const mcpLine = skill.split("\n").find((l) => l.includes("Free tools:"))!;
    expect(mcpLine).not.toContain("lumi_verdict");
    expect(skill).toMatch(/`lumi_verdict` \(\$0\.01\)/);
    const idx: any = await (await get("/", { Accept: "application/json" })).json();
    expect(idx.mcp.tools.free).not.toContain("lumi_verdict");
    expect(idx.mcp.tools.paid).toContain("lumi_verdict");
    expect(idx.mcp.stdio.pays_with).toMatch(/Base/);
    expect(idx.mcp.stdio.pays_with).toMatch(/XRP Ledger/);
  });
  it("openapi documents a 400 for /v1/verdict (paid) with an example body", async () => {
    const oa: any = await (await setup({ VERDICT_PRICING: "paid" })("/openapi.json")).json();
    const r400 = oa.paths["/v1/verdict"].get.responses["400"];
    expect(r400.description).toMatch(/url/);
    expect(r400.content["application/json"].example.error).toBe("invalid_query");
  });
});
