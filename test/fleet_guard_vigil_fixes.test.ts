/**
 * Regression tests for Vigil's fleet-guard review (2026-11-19): MED-1/2/3 and the cheap LOW items. Several cases are
 * Vigil's probes (/tmp/fg-review/test/zz_vigil_probe.test.ts) turned into assertions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app";
import { loadConfig, type D1Like, type D1Statement } from "../src/config";
import { MemorySalesStore } from "../src/sales";
import { MemoryQuotaCounter } from "../src/free_quota";
import { D1IdempotencyStore, MemoryIdempotencyStore } from "../src/idempotency";
import { createFleetGuard, D1FleetGuardStore, MemoryFleetGuardStore, ipBucket, redactLogEvent, fleetGuardOn, FLEET_GUARD } from "../src/fleet_guard";
import { MemoryReplayGuard, PAYMENT_REQUIRED_HEADER_SOFT_LIMIT } from "../src/x402";
import { DATA, FACILITATOR, PAY_TO, PAYER, NOW, happyFacilitator, makeFetch, paymentHeaderFor, decodeB64Json } from "./helpers";

const SECRET = "fg-test-secret-0123456789abcdef0123456789";
const OWNER = "k".repeat(52);
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: OWNER, FLEET_GUARD: "on", FLEET_GUARD_HMAC_SECRET: SECRET };
const FULL = { ...ENV, EVM_PAY_TO: "0x5E617bac19912e6d212CB303ae84655E9E203532", EVM_NETWORK: "eip155:8453", EVM_FACILITATOR_URL: "https://evm-fac.test", EVM_CDP_ONLY_ROUTES: "none",
  STELLAR_PAY_TO: "GCKTH26VNR4H4WLCXS5DX6563XRQQXWP5QKQWFD6CHOGTZJ2N5GKBU2L", STELLAR_NETWORK: "stellar:pubnet", STELLAR_FACILITATOR_URL: "https://st-fac.test", STELLAR_FACILITATOR_API_KEY: "test-key", PUBLIC_BASE_URL: "https://api.lumitrades.io", FLEET_GUARD_MONTHLY: "on" };
const BASE = "http://lumi.test";
const IK = "pack-buy-0000000000000001";

/** D1Like over node:sqlite with the real migrations, so tests read the rows exactly as D1 would store them. */
class SqliteD1 implements D1Like {
  db = new DatabaseSync(":memory:");
  constructor(migrations: string[]) { for (const m of migrations) this.db.exec(readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8")); }
  prepare(sql: string): D1Statement { return this.stmt(sql, []); }
  private stmt(sql: string, args: unknown[]): D1Statement {
    const db = this.db;
    const a = args.map((v) => (v === undefined ? null : v)) as any[];
    return {
      bind: (...v: unknown[]) => this.stmt(sql, v),
      run: async () => db.prepare(sql).run(...a),
      all: async <T>() => ({ results: db.prepare(sql).all(...a) as T[] }),
      first: async <T>() => ((db.prepare(sql).get(...a) as T) ?? null),
    };
  }
  async batch(st: D1Statement[]) { for (const s of st) await s.run(); return []; }
  dump(): string {
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    return JSON.stringify(tables.map((t) => this.db.prepare(`SELECT * FROM "${t.name}"`).all()));
  }
}

function setup(o: { env?: Record<string, unknown>; d1?: boolean; store?: MemoryFleetGuardStore } = {}) {
  const logs: any[] = [];
  const d1 = o.d1 ? new SqliteD1(["0012_idempotency.sql", "0034_fleet_guard.sql"]) : null;
  const idem = d1 ? new D1IdempotencyStore(d1) : new MemoryIdempotencyStore();
  const store = d1 ? new D1FleetGuardStore(d1) : (o.store ?? new MemoryFleetGuardStore());
  let useCalls = 0;
  const oc = store.useCredits.bind(store);
  store.useCredits = async (keyHash: string, n: number, t: number) => { useCalls++; return oc(keyHash, n, t); };
  const fac = happyFacilitator();
  const app = createApp({ ...ENV, ...(o.env ?? {}) } as any, {
    fetch: makeFetch(fac), now: () => NOW, log: (e) => logs.push(e), fleetGuardStore: store, salesStore: new MemorySalesStore(),
    quotaCounter: new MemoryQuotaCounter(() => NOW), idempotencyStore: idem,
  });
  const get = (p: string, h: Record<string, string> = {}) => app.fetch(new Request(BASE + p, { headers: h }));
  return { app, get, logs, idem, store, d1, fac, uses: () => useCalls };
}

async function buyPack(s: ReturnType<typeof setup>, extra: Record<string, string> = { "Idempotency-Key": IK }) {
  const q: any = await (await s.get("/v1/fleet/pack")).json();
  const header = paymentHeaderFor(q.accepts[0]);
  const r = await s.get("/v1/fleet/pack", { "PAYMENT-SIGNATURE": header, ...extra });
  return { q, header, r, body: (await r.clone().json()) as any };
}

describe("MED-1: no raw payer address in the shared idempotency table", () => {
  it("fleet pack: the saved D1 row's PAYMENT-RESPONSE decodes without a payer", async () => {
    const s = setup({ d1: true });
    const { r } = await buyPack(s);
    expect(r.status).toBe(200);
    const rows = s.d1!.db.prepare("SELECT headers, body FROM idempotency").all() as { headers: string; body: string }[];
    expect(rows.length).toBe(1);
    const pr = decodeB64Json(JSON.parse(rows[0].headers)["PAYMENT-RESPONSE"]);
    expect(pr).toMatchObject({ success: true, transaction: "A".repeat(64), network: "xrpl:1" });
    expect(pr).not.toHaveProperty("payer");
    expect(JSON.stringify(pr)).not.toContain(PAYER);
    expect(s.d1!.dump()).not.toContain(PAYER);
  });

  it("live routes: the saved row has no payer; the live response and the replay are otherwise unchanged", async () => {
    const s = setup({ d1: true, env: { FLEET_GUARD: undefined } });
    const path = "/v1/trust/check/high-value?url=https://a.example/x&amount=4";
    const req: any = (await (await s.get(path)).json()).accepts[0];
    const h = { "PAYMENT-SIGNATURE": paymentHeaderFor(req), "Idempotency-Key": "retry-key-0123456789abcdef" };
    const first = await s.get(path, h);
    expect(first.status).toBe(200);
    const firstBody = await first.text();
    const live = decodeB64Json(first.headers.get("PAYMENT-RESPONSE"));
    expect(live.payer).toBe(PAYER); // the paying client still gets its own receipt in full
    const row = s.d1!.db.prepare("SELECT headers FROM idempotency").get() as { headers: string };
    const saved = decodeB64Json(JSON.parse(row.headers)["PAYMENT-RESPONSE"]);
    const { payer: _p, ...rest } = live;
    expect(saved).toEqual(rest);
    expect(row.headers).not.toContain(PAYER);
    const again = await s.get(path, h);
    expect(again.status).toBe(200);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await again.text()).toBe(firstBody);
    expect(s.fac.calls.filter((c) => c.path === "/settle").length).toBe(1);
  });
});

describe("MED-2: pack keys are derived from the settled tx and never stored in plaintext", () => {
  it("a junk-payment replay with the same Idempotency-Key and invoiceId gets no key", async () => {
    const s = setup({ d1: true });
    const { q, body } = await buyPack(s);
    expect(body.key).toMatch(/^fgk_[0-9a-f]{40}$/);
    expect(s.d1!.dump()).not.toContain(body.key);
    const forged = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { garbage: true }, payload: { signedTxBlob: "DEAD", invoiceId: q.accepts[0].extra.invoiceId } })).toString("base64");
    const r2 = await s.get("/v1/fleet/pack", { "PAYMENT-SIGNATURE": forged, "Idempotency-Key": IK, "CF-Connecting-IP": "9.9.9.9" });
    const t2 = await r2.text();
    expect(r2.status).toBe(409);
    expect(r2.headers.get("Idempotent-Replayed")).toBeNull();
    expect(t2).not.toContain(body.key);
    expect(t2).not.toMatch(/fgk_[0-9a-f]{40}/);
    // Same invoiceId inside a different but well-formed payment: also refused.
    const other = Buffer.from(JSON.stringify({ x402Version: 2, accepted: q.accepts[0], payload: { signedTxBlob: "12000023", invoiceId: q.accepts[0].extra.invoiceId } })).toString("base64");
    const r3 = await s.get("/v1/fleet/pack", { "PAYMENT-SIGNATURE": other, "Idempotency-Key": IK });
    expect(r3.status).toBe(409);
    expect(await r3.text()).not.toMatch(/fgk_[0-9a-f]{40}/);
  });

  it("a legitimate retry (same key, same signed payment) recomputes the same working key without settling again", async () => {
    const s = setup({ d1: true });
    const { header, body } = await buyPack(s);
    const again = await s.get("/v1/fleet/pack", { "PAYMENT-SIGNATURE": header, "Idempotency-Key": IK });
    expect(again.status).toBe(200);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    const b2: any = await again.json();
    expect(b2.key).toBe(body.key);
    expect(b2.calls).toBe(FLEET_GUARD.pack.calls);
    expect(s.fac.calls.filter((c) => c.path === "/settle").length).toBe(1);
    expect(decodeB64Json(again.headers.get("PAYMENT-RESPONSE"))).not.toHaveProperty("payer");
    const k = await s.get("/v1/fleet/key", { "X-Lumi-Fleet-Key": b2.key });
    expect(k.status).toBe(200);
    expect(((await k.json()) as any).remaining).toBe(FLEET_GUARD.pack.calls);
    const row = s.d1!.db.prepare("SELECT body FROM idempotency").get() as { body: string };
    expect(row.body).not.toMatch(/fgk_[0-9a-f]{40}/);
    expect(JSON.parse(row.body).key).toBe("derived_from_tx");
  });

  it("the key depends on the server secret and the tx (not guessable from the public tx hash)", async () => {
    const a = await buyPack(setup());
    const b = await buyPack(setup({ env: { FLEET_GUARD_HMAC_SECRET: SECRET.replace("0", "9") } }));
    expect(a.body.key).not.toBe(b.body.key);
    expect(a.body.key).not.toContain("A".repeat(16).toLowerCase());
  });
});

describe("MED-3: per-network limits on prepaid keys", () => {
  it("prepaid checks: 60/min per IP, taken before the key is hashed", async () => {
    const s = setup();
    const { body } = await buyPack(s, {});
    const st: number[] = [];
    for (let i = 0; i < 62; i++) st.push((await s.get("/v1/fleet/check?subject=a.example", { "X-Lumi-Fleet-Key": body.key, "CF-Connecting-IP": "7.7.7.7" })).status);
    expect(st.slice(0, 60).every((x) => x === 200)).toBe(true);
    expect(st[60]).toBe(429);
    expect(s.uses()).toBe(60);
    // Another network is unaffected.
    expect((await s.get("/v1/fleet/check?subject=a.example", { "X-Lumi-Fleet-Key": body.key, "CF-Connecting-IP": "8.8.8.8" })).status).toBe(200);
  });

  it("random keys: a tighter failed-key limit returns 429 and stops further lookups", async () => {
    const s = setup();
    const st: Record<number, number> = {};
    for (let i = 0; i < 200; i++) {
      const k = "fgk_" + i.toString(16).padStart(40, "0");
      const r = await s.get("/v1/fleet/check?subject=a.example", { "X-Lumi-Fleet-Key": k, "CF-Connecting-IP": "7.7.7.7" });
      st[r.status] = (st[r.status] ?? 0) + 1;
    }
    expect(st[402]).toBe(FLEET_GUARD.keyFailPer10Min);
    expect(st[429]).toBe(200 - FLEET_GUARD.keyFailPer10Min);
    expect(s.uses()).toBeLessThanOrEqual(FLEET_GUARD.keyFailPer10Min + 1);
  });

  it("/v1/fleet/key: 60/min per IP, and failed keys are limited", async () => {
    const s = setup();
    const { body } = await buyPack(s, {});
    const st: number[] = [];
    for (let i = 0; i < 61; i++) st.push((await s.get("/v1/fleet/key", { "X-Lumi-Fleet-Key": body.key, "CF-Connecting-IP": "6.6.6.6" })).status);
    expect(st.slice(0, 60).every((x) => x === 200)).toBe(true);
    expect(st[60]).toBe(429);
    const st2: Record<number, number> = {};
    for (let i = 0; i < 50; i++) {
      const r = await s.get("/v1/fleet/key", { "X-Lumi-Fleet-Key": "fgk_" + i.toString(16).padStart(40, "0"), "CF-Connecting-IP": "5.5.5.5" });
      st2[r.status] = (st2[r.status] ?? 0) + 1;
    }
    expect(st2[404]).toBe(FLEET_GUARD.keyFailPer10Min);
    expect(st2[429]).toBe(50 - FLEET_GUARD.keyFailPer10Min);
    const bad: number[] = [];
    for (let i = 0; i < 12; i++) bad.push((await s.get("/v1/fleet/key", { "X-Lumi-Fleet-Key": "nope", "CF-Connecting-IP": "4.4.4.4" })).status);
    expect(bad.filter((x) => x === 401).length).toBe(FLEET_GUARD.keyFailPer10Min);
    expect(bad.slice(FLEET_GUARD.keyFailPer10Min).every((x) => x === 429)).toBe(true);
  });
});

describe("LOW-5: free-check buckets", () => {
  it("groups IPv6 by /64 and ignores X-Forwarded-For", async () => {
    const s = setup();
    let v6 = 0, xff = 0;
    for (let i = 0; i < 30; i++) if ((await s.get("/v1/fleet/check/free?subject=a.example", { "CF-Connecting-IP": `2001:db8:1:2::${i.toString(16)}` })).status === 200) v6++;
    for (let i = 0; i < 30; i++) if ((await s.get("/v1/fleet/check/free?subject=a.example", { "X-Forwarded-For": `10.0.${i}.1` })).status === 200) xff++;
    expect(v6).toBe(FLEET_GUARD.free.perIpMinute);
    expect(xff).toBe(FLEET_GUARD.free.perIpMinute);
  });
  it("ipBucket", () => {
    expect(ipBucket("2001:db8:1:2::1")).toBe("v6:2001:0db8:0001:0002::/64");
    expect(ipBucket("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe("v6:2001:0db8:0001:0002::/64");
    expect(ipBucket("2001:db8:1:3::1")).not.toBe(ipBucket("2001:db8:1:2::1"));
    expect(ipBucket("::1")).toBe("v6:0000:0000:0000:0000::/64");
    expect(ipBucket("fe80::1%eth0")).toBe("v6:fe80:0000:0000:0000::/64");
    expect(ipBucket("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(ipBucket("64:ff9b::1.2.3.4")).toBe("v6:0064:ff9b:0000:0000::/64");
    expect(ipBucket("1.2.3.4")).toBe("1.2.3.4");
    for (const bad of [null, "", "999.1.1.1", "1:2:3", "1::2::3", "zz::1", "1:2:3:4:5:6:7:8:9", "hello"]) expect(ipBucket(bad)).toBe("unknown");
  });
});

describe("LOW-1 / LOW-2: settle-record failure and underpay", () => {
  function direct(over: { recordSettleThrows?: boolean } = {}) {
    const cfg = loadConfig(ENV as any);
    const logs: any[] = [];
    const store = new MemoryFleetGuardStore();
    if (over.recordSettleThrows) store.recordSettle = async () => { throw new Error("d1 down"); };
    const fg = createFleetGuard({
      cfg, env: ENV, store, counter: new MemoryQuotaCounter(() => NOW), isOwner: async () => false, now: () => NOW, log: (e) => logs.push(e),
      paywall: () => ({ fetch: makeFetch(happyFacilitator()), replay: new MemoryReplayGuard(), log: (e) => logs.push(e) }),
    });
    const call = async (p: string, h: Record<string, string> = {}) => (await fg.handle(new Request(BASE + p, { headers: h }), new URL(BASE + p).pathname, BASE))!;
    return { cfg, fg, logs, store, call };
  }
  const xrp = (q: any) => q.accepts.find((a: any) => a.asset === "XRP");

  it("underpay after settle (XRP fell >20% since the quote) returns 409 with the tx hash, not 402", async () => {
    const d = direct();
    d.cfg.xrpRate = { usd: 1, source: "test", as_of: new Date().toISOString() };
    const q: any = await (await d.call("/v1/fleet/pack")).json();
    expect(xrp(q).amount).toBe("4000000");
    d.cfg.xrpRate = { usd: 0.5, source: "test", as_of: new Date().toISOString() };
    const r = await d.call("/v1/fleet/pack", { "PAYMENT-SIGNATURE": paymentHeaderFor(xrp(q)) });
    expect(r.status).toBe(409);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
    const b: any = await r.json();
    expect(b).toMatchObject({ error: "amount_below_minimum", tx: "A".repeat(64) });
    expect(JSON.stringify(b)).not.toMatch(/fgk_/);
    expect(d.logs.some((l) => l.event === "fleet_guard_alert" && l.kind === "underpaid")).toBe(true);
  });

  it("a small XRP fall inside the invoice lifetime is still served", async () => {
    const d = direct();
    d.cfg.xrpRate = { usd: 1, source: "test", as_of: new Date().toISOString() };
    const q: any = await (await d.call("/v1/fleet/pack")).json();
    d.cfg.xrpRate = { usd: 0.9, source: "test", as_of: new Date().toISOString() };
    const r = await d.call("/v1/fleet/pack", { "PAYMENT-SIGNATURE": paymentHeaderFor(xrp(q)) });
    expect(r.status).toBe(200);
  });

  it("a failed settle-record write still serves the paid answer and raises an alert", async () => {
    const d = direct({ recordSettleThrows: true });
    const q: any = await (await d.call("/v1/fleet/check?subject=a.example")).json();
    const r = await d.call("/v1/fleet/check?subject=a.example", { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts[0]) });
    expect(r.status).toBe(200);
    expect(d.logs.find((l) => l.event === "fleet_guard_alert" && l.kind === "settle_record_failed")).toMatchObject({ tx: "A".repeat(64) });
    expect(JSON.stringify(d.logs.filter((l) => l.svc === "fleet_guard"))).not.toContain(PAYER);
  });
});

describe("LOW-3: fleet-guard log allow-list", () => {
  it("drops unknown fields and masks addresses outside tx", () => {
    const evm = "0x" + "ab".repeat(20);
    const out = redactLogEvent({ event: "x402_payer_mismatch", route: "fleet_pack", tx: "A".repeat(64), signed: evm, facilitator: PAYER, payer: PAYER, error: `bad ${evm}`, extra: "x" });
    expect(out).toEqual({ event: "x402_payer_mismatch", route: "fleet_pack", tx: "A".repeat(64), facilitator: "[address]", payer: "redacted", error: "bad [address]" });
    expect(redactLogEvent({ event: "x", tx: "0x" + "b".repeat(64) }).tx).toBe("0x" + "b".repeat(64));
  });
});

describe("flag parsing and PAYMENT-REQUIRED size", () => {
  it("FLEET_GUARD must be exactly \"on\"", async () => {
    for (const v of ["On ", "ON", " on", "on ", "true", "1", undefined]) {
      expect(fleetGuardOn({ FLEET_GUARD: v })).toBe(false);
      expect((await setup({ env: { FLEET_GUARD: v } }).get("/v1/fleet/check?subject=a.example")).status).toBe(404);
    }
    expect(fleetGuardOn({ FLEET_GUARD: "on" })).toBe(true);
    const s = setup({ env: { FLEET_GUARD_MONTHLY: "On" } });
    expect((await s.get("/v1/fleet/plan/monthly")).status).toBe(404);
  });

  it("all five accepts (Base USDC, XRP, RLUSD, USDC on XRPL, Stellar USDC) stay under 4,096 bytes in the worst case", async () => {
    const s = setup({ env: FULL });
    /** A valid domain of exactly `len` characters (labels of 59 characters at most) ending in "<tag>.io". */
    const domain = (len: number, tag: string) => {
      const chars = Array.from({ length: len - 3 }, (_, i) => ((i + 1) % 60 === 0 ? "." : "x"));
      const out = chars.join("").slice(0, len - 3 - tag.length) + tag;
      return out.replace(/\.$/, "y") + ".io";
    };
    const sub = (n: number, want: number) => {
      const total = Math.min(want, n * FLEET_GUARD.subjectMaxChars + n - 1);
      const each = Math.floor((total - (n - 1)) / n);
      let extra = total - (n - 1) - each * n;
      const list = Array.from({ length: n }, (_, i) => domain(each + (extra-- > 0 ? 1 : 0), String(i).padStart(2, "0")));
      expect(list.join(",").length).toBe(total);
      return list.join(",");
    };
    const evm7 = Array.from({ length: 7 }, (_, i) => "0x" + String(i).repeat(40)).join(",");
    const paths = [
      "/v1/fleet/check?subject=a.io",
      `/v1/fleet/check?subject=${evm7}`,
      ...[2, 5, 10, 15, 20].map((n) => `/v1/fleet/check?subject=${sub(n, FLEET_GUARD.echoMaxChars)}`),
      ...[2, 20].map((n) => `/v1/fleet/check?subject=${sub(n, FLEET_GUARD.echoMaxChars + 1)}`),
      `/v1/fleet/check?subject=${sub(20, 2000)}`,
      "/v1/fleet/pack",
      "/v1/fleet/plan/monthly",
    ];
    let worst = 0;
    for (const p of paths) {
      const r = await s.get(p);
      expect(r.status, p).toBe(402);
      const h = r.headers.get("PAYMENT-REQUIRED")!;
      const pr = decodeB64Json(h);
      expect(pr.accepts.map((a: any) => a.network).sort()).toEqual(["eip155:8453", "stellar:pubnet", "xrpl:1", "xrpl:1", "xrpl:1"]);
      expect(new TextEncoder().encode(h).length, p).toBeLessThan(4096);
      expect(h.length, p).toBeLessThanOrEqual(PAYMENT_REQUIRED_HEADER_SOFT_LIMIT);
      worst = Math.max(worst, h.length);
    }
    expect(worst).toBeGreaterThan(3500); // the cases above really are the large ones
    expect(worst).toBeLessThan(4096 - 128); // keep headroom below the 4 KB proxy limit
  });
});
