import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config";
import { issueInvoiceId, checkInvoiceId, encodeHeader, b64decodeUtf8, canonicalJson, MemoryReplayGuard, KvReplayGuard, DurableObjectReplayGuard, type Quote } from "../src/x402";
import { PAY_TO, fakeDurableObjectNamespace } from "./helpers";

const cfg = loadConfig({ XRPL_NETWORK: "xrpl:1", PAY_TO, INVOICE_SECRET: "test-secret" });
const quote: Quote = { routeKey: "signal:XRP", amountDrops: "20000", description: "d", resourceUrl: "http://x/v1/institutional" };

describe("stateless invoices", () => {
  it("round-trips", async () => {
    const id = await issueInvoiceId(cfg, quote);
    expect(id).toMatch(/^lumi1\.signal:XRP\./);
    expect(await checkInvoiceId(cfg, id, quote)).toMatchObject({ ok: true });
  });

  it("rejects tampering, other routes, other prices, other secrets, and expiry", async () => {
    const id = await issueInvoiceId(cfg, quote);
    const parts = id.split(".");
    expect((await checkInvoiceId(cfg, [...parts.slice(0, 4), "AAAAAAAAAAAAAAAAAAAAAA"].join("."), quote)).ok).toBe(false);
    expect(await checkInvoiceId(cfg, id, { ...quote, routeKey: "signal:BTC" })).toMatchObject({ ok: false });
    expect(await checkInvoiceId(cfg, id, { ...quote, amountDrops: "1" })).toMatchObject({ ok: false, reason: "invalid_invoice" });
    const other = loadConfig({ XRPL_NETWORK: "xrpl:1", PAY_TO, INVOICE_SECRET: "other" });
    expect(await checkInvoiceId(other, id, quote)).toMatchObject({ ok: false, reason: "invalid_invoice" });
    const old = await issueInvoiceId(cfg, quote, Date.now() - 3600_000);
    expect(await checkInvoiceId(cfg, old, quote)).toMatchObject({ ok: false, reason: "invoice_expired" });
    expect(await checkInvoiceId(cfg, "garbage", quote)).toMatchObject({ ok: false, reason: "malformed_invoice" });
  });
});

describe("encoding", () => {
  it("encodes headers as base64 of sorted-key JSON (like the reference SDK)", () => {
    const h = encodeHeader({ b: 1, a: { d: "é", c: [2, 1] } });
    expect(b64decodeUtf8(h)).toBe('{"a":{"c":[2,1],"d":"é"},"b":1}');
    expect(canonicalJson({ z: undefined, y: null })).toBe('{"y":null}');
  });
});

describe("replay guards", () => {
  it("memory: claims once", async () => {
    const g = new MemoryReplayGuard();
    expect(await g.claim("x", 60)).toBe(true);
    expect(await g.claim("x", 60)).toBe(false);
    expect(await g.isUsed("x")).toBe(true);
  });

  it("KV: visible to other isolates sharing the namespace", async () => {
    const store = new Map<string, string>();
    const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) };
    expect(await new KvReplayGuard(kv).claim("x", 60)).toBe(true);
    expect(await new KvReplayGuard(kv).claim("x", 60)).toBe(false);
  });

  it("Durable Object: atomic across isolates, including concurrent claims", async () => {
    const ns = fakeDurableObjectNamespace();
    const results = await Promise.all(Array.from({ length: 5 }, () => new DurableObjectReplayGuard(ns).claim("same", 60)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await new DurableObjectReplayGuard(ns).claim("other", 60)).toBe(true);
  });
});
