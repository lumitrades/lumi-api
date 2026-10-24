import { describe, it, expect, vi, afterEach } from "vitest";
import { createApp } from "../src/app";
import { MemoryTrafficStore } from "../src/traffic";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { NOW, PAY_TO, FACILITATOR, DATA, happyFacilitator, makeFetch } from "./helpers";

const BASE = "https://api.lumitrades.io";
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PUBLIC_BASE_URL: BASE };

describe("free check: what the server keeps about a request", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs and traffic stats hold no payTo, amount, network, seller URL or query string", async () => {
    const logs: unknown[] = [];
    const consoleCalls: unknown[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { consoleCalls.push(a); });
    const trafficStore = new MemoryTrafficStore();
    const app = createApp(ENV as any, { trafficStore, catalogStore: new MemoryCatalogStore(), now: () => NOW, fetch: makeFetch(happyFacilitator()), log: (e: unknown) => logs.push(e) } as any);
    const payTo = "rPrivacyCanaryPayTo1111111111111";
    const seller = "https://canary-seller.example/private/path?token=canary-token";
    const q = new URLSearchParams({ url: seller, payTo, amount: "0.0377", network: "xrpl:0" });
    for (let i = 0; i < 3; i++) {
      const req = new Request(`${BASE}/v1/check?${q}`, { headers: { "CF-Connecting-IP": "203.0.113.9" } });
      const res = await app.fetch(req);
      expect(res.status).toBe(200);
      app.logTraffic(req, res);
    }
    await new Promise((r) => setTimeout(r, 10)); // logTraffic is fire-and-forget
    await app.flushTraffic();
    expect(trafficStore.counted).toBe(3);
    const kept = JSON.stringify({ logs, consoleCalls, traffic: trafficStore.list, rows: trafficStore.rows });
    for (const secret of [payTo, "0.0377", "canary-seller", "canary-token", "/private/path", "203.0.113.9"]) expect(kept).not.toContain(secret);
    expect(Object.keys(trafficStore.list[0].b.paths)).toEqual(["/v1/check"]);
  });
});
