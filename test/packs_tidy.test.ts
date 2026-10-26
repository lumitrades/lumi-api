import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { deriveAddress, deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { createApp } from "../src/app";
import { FACILITATOR, DATA, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";
import { founderCompanyKeys } from "../src/commerce/monitor";
import { MemoryCommerceStore } from "../src/commerce/store";
import { MemoryTrustStore, type ObservationRow, type ProbeRow } from "../src/trust/store";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { testedBadgeRules, BADGE_WINDOW_DAYS } from "../src/trust/check";
import { COUNTING_TEXT } from "../src/commerce/counting";
import { REFUSED_ALERT_NOTE } from "../src/sales";
import { VERSION } from "../src/docs";

const BASE = "https://lumi.test";
const OWNER = "owner-key-for-tests-0123456789-abcdefghijklmnop";
const HOOK = "https://hooks.example.test/sales";
const seed = generateSeed({ entropy: Uint8Array.from({ length: 16 }, (_, i) => i + 7) });
const kp = deriveKeypair(seed);
const SELLER = deriveAddress(kp.publicKey);
const D = 86_400_000;
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO: SELLER, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PUBLIC_BASE_URL: BASE, OWNER_MCP_KEY: OWNER };

function setup(extra: Record<string, string> = {}, opts: Record<string, unknown> = {}) {
  let t = NOW;
  const fac = happyFacilitator();
  const inner = makeFetch(fac);
  const hooks: any[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === HOOK) { hooks.push(JSON.parse(String(init?.body))); return new Response("ok"); }
    return inner(input, init);
  }) as typeof fetch;
  const app = createApp({ ...ENV, ...extra } as any, { fetch: f, log: () => {}, now: () => t, ...opts } as any);
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} };
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(BASE + path, init), ctx as any);
  const post = (path: string, body: unknown) => req(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  return { app, req, post, fac, hooks, settle: () => Promise.all(pending), advance: (ms: number) => (t += ms) };
}
type S = ReturnType<typeof setup>;

async function enroll(s: S) {
  const { message } = await (await s.req(`/v1/monitor/challenge?pay_to=${SELLER}`)).json();
  const r = await s.post("/v1/monitor/enroll", { message, signature: sign(hex(message), kp.privateKey), public_key: kp.publicKey, endpoints: [{ url: `${BASE}/v1/verdict?url=https://a.example/x` }] });
  expect(r.status).toBe(201);
  return r.json();
}
async function pay(s: S, path: string) {
  const q = await s.req(path);
  expect(q.status).toBe(402);
  const xrp = (await q.json()).accepts.find((a: any) => a.asset === "XRP");
  const r = await s.req(path, { headers: { "PAYMENT-SIGNATURE": paymentHeaderFor(xrp) } });
  return { status: r.status, body: await r.json() };
}

const obs = (vendor_id: string, ts: number, o: Partial<ObservationRow> = {}): ObservationRow => ({
  vendor_id, endpoint: `https://api.${vendor_id}.com/x`, ts, network: "xrpl:0", tx_hash: `${vendor_id}${ts}`.padEnd(64, "0"), amount: "1000", asset: "XRP",
  http_status: 200, data_returned: true, latency_ms: 100, summary: "ok", source: "test", ...o,
});
const probe = (vendor_id: string, ts: number): ProbeRow => ({ vendor_id, endpoint: `https://api.${vendor_id}.com/x`, ts, http_status: 402, ok: true, price: "1000", asset: "XRP", pay_to: "r", source_tag: null, latency_ms: 50 } as ProbeRow);

describe("Tested by Lumi badge: dated by the latest conclusive Lumi test-buy, rules documented from the code", () => {
  async function badgeApp() {
    const trustStore = new MemoryTrustStore([]);
    const s = setup({}, { trustStore, catalogStore: new MemoryCatalogStore() });
    // Latest conclusive test-buy 3 days ago (an inconclusive one after it does not move the date).
    for (let i = 3; i <= 7; i++) await trustStore.addObservation(obs("printmoneylab", NOW - i * D));
    await trustStore.addObservation(obs("printmoneylab", NOW - D, { http_status: null as any, data_returned: false, tx_hash: "inc".padEnd(64, "0") }));
    await trustStore.addProbes(Array.from({ length: 20 }, (_, i) => probe("printmoneylab", NOW - i * 3_600_000)));
    return { s, trustStore };
  }

  it("SVG and JSON show the last test-buy date, not the render date; JSON carries lapses_at and the exact rules", async () => {
    const { s } = await badgeApp();
    const last = new Date(NOW - 3 * D).toISOString().slice(0, 10);
    const today = new Date(NOW).toISOString().slice(0, 10);
    const b = await (await s.req("/v1/badge/printmoneylab.json")).json();
    expect(b.earned).toBe(true);
    expect(b.last_test_buy).toMatchObject({ date: last, result: "delivered", at: new Date(NOW - 3 * D).toISOString() });
    expect(b.lapses_at).toBe(new Date(NOW - 3 * D + BADGE_WINDOW_DAYS * D).toISOString());
    expect(b.rules).toEqual(testedBadgeRules());
    expect(b.signed.payload.last_test_buy.date).toBe(last);
    const svg = await (await s.req("/v1/badge/printmoneylab.svg")).text();
    expect(svg).toContain(`tested ${last}`);
    expect(svg).not.toContain(today);
  });

  it("lapses 30 days after the last conclusive test-buy", async () => {
    const { s } = await badgeApp();
    s.advance(28 * D); // newest conclusive buy now 31 days old
    const b = await (await s.req("/v1/badge/printmoneylab.json")).json();
    expect(b.earned).toBe(false);
  });

  it("/v1/badge, OpenAPI, llms.txt and skill.md describe the live rules and the current /v1 paths", async () => {
    const s = setup();
    const docs = await (await s.req("/v1/badge")).json();
    expect(docs.rules).toEqual(testedBadgeRules());
    expect(docs.monitored_badge.rules).toEqual(COUNTING_TEXT);
    expect(docs.summary).toContain("last 30 days");
    expect(docs.legacy).toContain("301");
    expect(docs.endpoints.svg).toBe(`${BASE}/v1/badge/{key}.svg`);
    const oa = await (await s.req("/openapi.json")).json();
    expect(oa.paths["/v1/badge/{key}.svg"].get.description).toContain("latest conclusive test-buy");
    expect(oa.paths["/v1/monitor/badge/{file}"].get.description).toContain("one counted test-buy per endpoint per UTC day");
    for (const p of ["/llms.txt", "/skill.md"]) {
      const txt = await (await s.req(p)).text();
      expect(txt).toContain("gone 30 days after it");
      expect(txt).toContain("one counted test-buy per endpoint per UTC day");
      expect(txt).toContain("paying never changes a score");
      expect(txt).not.toMatch(/conclusive paid test-buys and the latest test-buy delivered; removed automatically/);
      expect(txt).toContain("/v1/badge/{key}.svg");
    }
    const legacy = await s.req("/badge/printmoneylab.svg?x=1");
    expect(legacy.status).toBe(301);
    expect(legacy.headers.get("Location")).toBe(`${BASE}/v1/badge/printmoneylab.svg?x=1`);
  });
});

describe("tidy: pack prices, 429 headers, version, trial naming", () => {
  it("the pack list formats every checkout price with two decimals", async () => {
    const s = setup();
    const packs = (await (await s.req("/v1/monitor/packs")).json()).packs;
    const by = Object.fromEntries(packs.map((p: any) => [p.plan, p.checkout_usd]));
    expect(by).toEqual({ retest_pack: "6.50", founder_pack: "5.00" });
  });

  it("the free-lookup 429 sends each header once (Retry-After kept)", async () => {
    const s = setup();
    let r: Response | null = null;
    for (let i = 0; i < 40; i++) {
      r = await s.req("/v1/trust/vendors?domain=example.com", { headers: { "X-Lumi-Key": "k1" } });
      if (r.status === 429) break;
    }
    expect(r!.status).toBe(429);
    expect(r!.headers.get("Retry-After")).toMatch(/^\d+$/);
    const expose = r!.headers.get("Access-Control-Expose-Headers")!;
    const parts = expose.split(",").map((x) => x.trim());
    expect(new Set(parts).size).toBe(parts.length);
    expect(r!.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("health reports the bumped version", async () => {
    const s = setup();
    expect(VERSION).toBe("1.2.0");
    expect((await (await s.req("/health")).json()).version).toBe("1.2.0");
  });

  it("no user-facing 'Watch Plus trial' naming is left", () => {
    for (const f of ["mcp/README.md", "mcp/src/index.js", "src/commerce/plans.ts", "src/docs.ts", "src/commerce/discovery.ts", "src/commerce/monitor.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/Watch Plus (free )?trial/i);
    }
  });
});

describe("Founder pack sale alert waits for the place claim", () => {
  const en = (id: string, pay_to: string) => ({ id, network: "xrpl:1", pay_to, pay_to_lc: pay_to.toLowerCase(), domain: null, proof: "", nonce: id, endpoints: [{ url: `https://api.${id}.com/x`, method: "GET", price_usd: "0.01", asset: null, amount: null, checked_at: null, source: "seller" }], webhook_url: null, webhook_secret: null, email: null, token_hash: "h" + id, is_test: false, created_at: NOW }) as any;
  const claim = (store: MemoryCommerceStore, e: any, tx: string) => store.claimFounder({ keys: [...founderCompanyKeys(e)], enrollment_id: e.id, plan_id: `p_${tx}`, paid_tx: tx, t: NOW, seats: 10, maxPurchases: 12 });
  const path = (id: string) => `/v1/monitor/subscribe/founder_pack?enrollment=${id}`;
  const ALERTS = { SALES_WEBHOOK_URL: HOOK, SALES_ALERT_TESTS: "1" };

  it("refused at settlement: one alert, marked refused / no credit / needs owner review", async () => {
    const store = new MemoryCommerceStore();
    for (let i = 0; i < 9; i++) await claim(store, en(`c${i}`, `rC${i}`), `t${i}`);
    const s = setup(ALERTS, { commerceStore: store });
    const e = await enroll(s);
    const ok = s.fac.settle;
    s.fac.settle = async (b: any) => { await claim(store, en("racer", "rRacer"), "racer_tx"); return ok(b); };
    const r = await pay(s, path(e.enrollment_id));
    expect(r.status).toBe(409);
    await s.settle();
    expect(s.hooks).toHaveLength(1);
    expect(s.hooks[0].text.startsWith(`[${REFUSED_ALERT_NOTE} (founder_offer_full)] Lumi sale: founder_pack`)).toBe(true);
    expect(s.hooks[0].note).toContain("no credit");
  });

  it("place claimed: one plain sale alert, sent after the claim", async () => {
    const store = new MemoryCommerceStore();
    const s = setup(ALERTS, { commerceStore: store });
    const e = await enroll(s);
    const r = await pay(s, path(e.enrollment_id));
    expect(r.status).toBe(201);
    await s.settle();
    expect(s.hooks).toHaveLength(1);
    expect(s.hooks[0].text).toMatch(/^Lumi sale: founder_pack/);
    expect(s.hooks[0].note).toBeUndefined();
  });
});
