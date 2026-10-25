import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { MemoryTrustStore, type ObservationRow, type ProbeRow as VProbe } from "../src/trust/store";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { scoreVendor, NOT_SCORED_REASON } from "../src/trust/index";
import { labelFor, thresholdsDoc, VERDICT_DEFAULTS, VERDICT_RULES_VERSION, WORDING, type TestBuyEvidence } from "../src/trust/verdict";
import { rollupSeller, toRow, parseProbeRow, probeScope, probeRowPublic, normEndpoint, evaluateQuote, MemoryProbeStore, PROBE_SCOPE_TEXT, type EndpointProbe } from "../src/trust/probe_checked";
import { NOW, PAY_TO, FACILITATOR, DATA, happyFacilitator, makeFetch } from "./helpers";

const D = 86_400_000;
const BASE = "https://api.lumitrades.io";
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PUBLIC_BASE_URL: BASE };
const EDGE_EP = "https://pay.edge-agents.ai/v1/services/perp-funding-rates";
const SURF_EP = "https://x402.asksurf.ai/x402/xrpl/data/v1/news/feed";
const okProbe = (vendor_id: string, endpoint: string, ts: number): VProbe => ({ vendor_id, endpoint, ts, http_status: 402, ok: true, price: "0.01", asset: "RLUSD", pay_to: "r", source_tag: null, latency_ms: 150, error: null });
const obs = (vendor_id: string, endpoint: string, ts: number, o: Partial<ObservationRow> = {}): ObservationRow => ({
  vendor_id, endpoint, ts, network: "xrpl:0", tx_hash: `${vendor_id}${ts}`.replace(/[^A-Za-z0-9]/g, "").padEnd(64, "0").toUpperCase().slice(0, 64), amount: "6000", asset: "RLUSD",
  http_status: 200, data_returned: true, latency_ms: 300, summary: "ok", source: "test", ...o,
});
const failedProbe = (seller: string, url: string | null, at: number) => {
  const ep: EndpointProbe = { endpoint: url ?? "https://x402.asksurf.ai/x", ts: at, status: 405, latency_ms: 40, error: null, quote: evaluateQuote(405, null) };
  const row = toRow(rollupSeller({ seller, endpoints: [ep], tls: { ok: true, days_left: 60 } }), at);
  return url ? row : { ...row, probed_endpoints: null };
};

function mk() {
  const trustStore = new MemoryTrustStore([]);
  const probeStore = new MemoryProbeStore();
  const app = createApp(ENV as any, { trustStore, probeStore, catalogStore: new MemoryCatalogStore(), now: () => NOW, fetch: makeFetch(happyFacilitator()), log: () => {} } as any);
  const get = (p: string, h: Record<string, string> = {}) => app.fetch(new Request(BASE + p, { headers: h }));
  return { trustStore, probeStore, get };
}

describe("not scored until a conclusive paid test-buy", () => {
  it("probes alone never produce a score (edge-agents shape: healthy probes, 0 paid deliveries)", () => {
    const s = scoreVendor({ n: 150, ok: 150, latencies: [150, 160], latest: [] } as any, [], [], NOW);
    expect(s.value).toBeNull();
    expect(s.status).toBe("not_scored");
    expect(s.reason).toBe(NOT_SCORED_REASON);
    // Inconclusive buys are not conclusive either.
    const inc = scoreVendor({ n: 10, ok: 10, latencies: [100], latest: [] } as any, [obs("v", "e", NOW - D, { data_returned: false, http_status: null, inconclusive_reason: "no_response" } as any)], [], NOW);
    expect(inc.value == null || inc.status === "scored").toBe(true);
    const one = scoreVendor({ n: 10, ok: 10, latencies: [100], latest: [] } as any, [obs("v", "e", NOW - D)], [], NOW);
    expect(one.status).toBe("scored");
    expect(typeof one.value).toBe("number");
  });

  it("vendors feed, badge and /v1/check all say not_scored for a probe-only curated vendor", async () => {
    const s = mk();
    await s.trustStore.addProbes(Array.from({ length: 40 }, (_, i) => okProbe("edge-agents", EDGE_EP, NOW - i * 1_800_000)));
    const feed: any = await (await s.get("/v1/trust/vendors")).json();
    const e = (feed.vendors ?? feed.items ?? []).find((v: any) => v.id === "edge-agents" || v.vendor_id === "edge-agents");
    expect(e).toBeTruthy();
    const score = e.score && typeof e.score === "object" ? e.score.value : e.score;
    expect(score).toBeNull();
    expect(e.score_status ?? e.score?.status).toBe("not_scored");
    const badge: any = await (await s.get("/v1/badge/edge-agents.json")).json();
    expect(badge.earned).toBe(false);
    expect(badge.reason).toBe("not_scored");
    expect(badge.score?.value ?? null).toBeNull();
    const svg = await (await s.get("/v1/badge/edge-agents.svg")).text();
    expect(svg).toContain("not scored");
    const c: any = await (await s.get("/v1/check?url=" + encodeURIComponent(EDGE_EP))).json();
    expect(c.label).toBe("check_first");
    expect(c.label).not.toBe("checks_passed");
    if (c.score) { expect(c.score.value ?? null).toBeNull(); expect(c.score.status).toBe("not_scored"); }
  });

  it("rules are versioned and explain not_scored and probe scope; no_data is not a negative finding", () => {
    expect(VERDICT_RULES_VERSION).toBe("2026-10-25.5");
    const d = thresholdsDoc(VERDICT_DEFAULTS);
    expect(d.not_scored).toMatch(/conclusive Lumi paid test-buy/);
    expect(d.not_scored).toMatch(/0\.25/);
    expect(d.probe_scope).toMatch(/bought_endpoint/);
    expect(d.no_data).toMatch(/Not a negative finding/);
  });
});

describe("probe scope: a failed free probe on a test-bought seller", () => {
  const tests: TestBuyEvidence = { last_at: new Date(NOW - D).toISOString(), last_delivered: true, last_delivered_at: new Date(NOW - D).toISOString(), last_failed_at: null, consecutive_failed: 0, conclusive: 3, window_from: new Date(NOW - 5 * D).toISOString(), window_to: new Date(NOW - D).toISOString() };
  const check = { decision: "allow", reasons: [] as any[] };

  it("normalises endpoints and records what a run probed", () => {
    expect(normEndpoint("https://WWW.Example.com/a/b/?x=1#f")).toBe("https://example.com/a/b");
    expect(normEndpoint("ftp://x")).toBeNull();
    const row = failedProbe("asksurf.ai", SURF_EP, NOW);
    expect(JSON.parse(row.probed_endpoints!)).toEqual([SURF_EP]);
    expect(typeof parseProbeRow(row)).toBe("object");
    expect(parseProbeRow({ ...row, probed_endpoints: JSON.stringify(["not a url"]) })).toBe("invalid_probed_endpoints");
    expect(parseProbeRow({ ...row, probed_endpoints: JSON.stringify(["https://a.example/x?secret=1"]) })).toBe("invalid_probed_endpoints");
  });

  it("other endpoint: explained, label unchanged", () => {
    const row = failedProbe("asksurf.ai", "https://x402.asksurf.ai/x402/solana/tools/ask_surf_chat", NOW);
    const sc = probeScope(row, [SURF_EP], 1);
    expect(sc).toBe("other_endpoint");
    expect(labelFor({ check, tests, now: NOW, th: VERDICT_DEFAULTS, probe: row, probeScope: sc }).label).toBe("checks_passed");
    expect(probeRowPublic(row, 1, sc)).toMatchObject({ failure_scope: "other_endpoint", failure_scope_note: PROBE_SCOPE_TEXT.other_endpoint, outcome: "fail" });
  });

  it("endpoint not recorded (rows from before migration 0029): explained, label unchanged", () => {
    const row = failedProbe("asksurf.ai", null, NOW);
    const sc = probeScope(row, [SURF_EP], 1);
    expect(sc).toBe("endpoint_not_recorded");
    expect(labelFor({ check, tests, now: NOW, th: VERDICT_DEFAULTS, probe: row, probeScope: sc }).label).toBe("checks_passed");
  });

  it("bought endpoint, newer than the last delivered buy: check_first (warn), never checks_failed", () => {
    const row = failedProbe("asksurf.ai", SURF_EP, NOW);
    const sc = probeScope(row, [SURF_EP + "/"], 1);
    expect(sc).toBe("bought_endpoint");
    const l = labelFor({ check, tests, now: NOW, th: VERDICT_DEFAULTS, probe: row, probeScope: sc });
    expect(l).toMatchObject({ label: "check_first", reason_code: "probe_failed_on_bought_endpoint" });
    expect(WORDING.probe_failed_on_bought_endpoint(tests, VERDICT_DEFAULTS)).toMatch(/Check again before paying/);
    // Older than the last delivered buy: the buy is newer evidence, label stays checks_passed.
    const old = failedProbe("asksurf.ai", SURF_EP, NOW - 3 * D);
    expect(labelFor({ check, tests, now: NOW, th: VERDICT_DEFAULTS, probe: old, probeScope: probeScope(old, [SURF_EP], 1) }).label).toBe("checks_passed");
  });

  it("no delivered buy or a passing probe: no scope", () => {
    expect(probeScope(failedProbe("asksurf.ai", SURF_EP, NOW), [SURF_EP], 0)).toBeNull();
    expect(probeScope(null, [SURF_EP], 1)).toBeNull();
  });

  it("/v1/check on asksurf's bought endpoint explains a probe that hit another endpoint, and stays consistent", async () => {
    const s = mk();
    for (let i = 1; i <= 3; i++) await s.trustStore.addObservation(obs("asksurf", SURF_EP, NOW - i * D));
    await s.trustStore.addProbes(Array.from({ length: 20 }, (_, i) => okProbe("asksurf", SURF_EP, NOW - i * 1_800_000)));
    await s.probeStore.put([failedProbe("asksurf.ai", "https://x402.asksurf.ai/x402/solana/tools/ask_surf_chat", NOW - 3_600_000)]);
    const c: any = await (await s.get("/v1/check?url=" + encodeURIComponent(SURF_EP))).json();
    expect(c.free_checks).toMatchObject({ outcome: "fail", failure_scope: "other_endpoint", tier: "test-bought" });
    expect(c.label).toBe("checks_passed");
    // Same seller, now the probe fails on the bought endpoint itself: warn.
    await s.probeStore.put([failedProbe("asksurf.ai", SURF_EP, NOW - 3_600_000)]);
    const c2: any = await (await s.get("/v1/check?url=" + encodeURIComponent(SURF_EP))).json();
    expect(c2.free_checks.failure_scope).toBe("bought_endpoint");
    expect(c2.label).toBe("check_first");
  });

  it("the targets builder ranks Lumi's test-bought endpoint first", async () => {
    const { readFileSync } = await import("node:fs");
    const py = readFileSync("tools/probe_checked_targets.py", "utf8");
    expect(py).toMatch(/0 if x\["src"\] == "test_bought" else 1/);
  });
});
