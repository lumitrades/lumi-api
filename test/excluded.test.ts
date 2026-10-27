import { describe, it, expect } from "vitest";
import { toListing, MemoryCatalogStore, excludingStore } from "../src/trust/catalog";
import { isExcludedHost, isExcludedPayTo, isExcludedUrl } from "../src/trust/excluded";
import { NOW } from "./helpers";

// excluded-seller-1 (permanent internal filter)
const X_PAY = "0x9DBE9AE85F9E518D4DF0A8B10BBB0C786726D05A";
const ext = (resource: string, payTo: string) => ({
  resource, description: "x", accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "10000", payTo }],
});

describe("permanent seller exclusions", () => {
  it("matches host suffix and payTo case-insensitively", () => {
    expect(isExcludedHost("Foo.AgentChecklist.workers.dev")).toBe(true);
    expect(isExcludedHost("agentchecklist.workers.dev")).toBe(true);
    expect(isExcludedHost("notagentchecklist.workers.dev")).toBe(false);
    expect(isExcludedUrl("https://X.agentchecklist.workers.dev/a?b=1")).toBe(true);
    expect(isExcludedPayTo(X_PAY)).toBe(true);
    expect(isExcludedPayTo("0x" + "1".repeat(40))).toBe(false);
  });
  it("store never writes, returns or records buys for an excluded seller from any source", async () => {
    const mem = new MemoryCatalogStore();
    const s = excludingStore(mem);
    const ok = toListing(ext("https://ok.example.org/a", "0x" + "1".repeat(40)))!;
    const byHost = toListing(ext("https://sub.agentchecklist.workers.dev/x", "0x" + "2".repeat(40)))!;
    const byPay = toListing(ext("https://other.example.net/y", X_PAY))!;
    for (const src of [undefined, "ext:402index", "ext:payai", "ext:dexter"]) await s.upsert([ok, byHost, byPay], NOW, src as any);
    expect(mem.rows.map((r) => r.resource)).toEqual(["https://ok.example.org/a"]);
    // rows that predate the filter are hidden from every read
    await mem.upsert([byPay], NOW);
    expect((await s.range(0, 100)).map((r) => r.resource)).toEqual(["https://ok.example.org/a"]);
    expect(await s.byResource("https://other.example.net/y")).toBeNull();
    expect((await s.byPayTos([X_PAY.toLowerCase()], 10)).length).toBe(0);
    expect((await s.top("score" as any, 10)).some((r: any) => r.resource.includes("other.example.net"))).toBe(false);
  });
});
