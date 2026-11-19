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
const KEY_SECRET = "fg-key-secret-fedcba9876543210fedcba9876543210";
const OWNER = "k".repeat(52);
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: OWNER, FLEET_GUARD: "on", FLEET_GUARD_HMAC_SECRET: SECRET, FLEET_GUARD_KEY_SECRET: KEY_SECRET };
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

  it("live routes: the saved row (headers and body) has no payer; the paying client's own response is unchanged", async () => {
    const s = setup({ d1: true, env: { FLEET_GUARD: undefined } });
    const path = "/v1/trust/check/high-value?url=https://a.example/x&amount=4";
    const req: any = (await (await s.get(path)).json()).accepts[0];
    const h = { "PAYMENT-SIGNATURE": paymentHeaderFor(req), "Idempotency-Key": "retry-key-0123456789abcdef" };
    const first = await s.get(path, h);
    expect(first.status).toBe(200);
    const firstBody = JSON.parse(await first.text());
    const live = decodeB64Json(first.headers.get("PAYMENT-RESPONSE"));
    expect(live.payer).toBe(PAYER); // the paying client still gets its own receipt in full
    expect(firstBody.payment.payer).toBe(PAYER);
    const row = s.d1!.db.prepare("SELECT headers, body FROM idempotency").get() as { headers: string; body: string };
    const saved = decodeB64Json(JSON.parse(row.headers)["PAYMENT-RESPONSE"]);
    const { payer: _p, ...rest } = live;
    expect(saved).toEqual(rest);
    const savedBody = JSON.parse(row.body);
    expect(savedBody.payment).toBeTruthy();
    expect(savedBody.payment).not.toHaveProperty("payer");
    expect(row.headers).not.toContain(PAYER);
    expect(row.body).not.toContain(PAYER);
    expect(s.d1!.dump()).not.toContain(PAYER);
    // A real retry (same key, byte-identical signed header) still replays, without the payer.
    const again = await s.get(path, h);
    expect(again.status).toBe(200);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    const againText = await again.text();
    expect(againText).not.toContain(PAYER);
    const expected = JSON.parse(JSON.stringify(firstBody)); delete expected.payment.payer;
    expect(JSON.parse(againText)).toEqual(expected);
    expect(s.fac.calls.filter((c) => c.path === "/settle").length).toBe(1);
  });

  it("trust route: a junk payment with the same Idempotency-Key and invoiceId gets no answer", async () => {
    const s = setup({ d1: true, env: { FLEET_GUARD: undefined } });
    const path = "/v1/trust/check/high-value?url=https://a.example/x&amount=4";
    const req: any = (await (await s.get(path)).json()).accepts[0];
    const IKT = "victim-key-0123456789abcdef";
    const first = await s.get(path, { "PAYMENT-SIGNATURE": paymentHeaderFor(req), "Idempotency-Key": IKT });
    expect(first.status).toBe(200);
    const victim = await first.text();
    const forged = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { garbage: true }, payload: { signedTxBlob: "DEAD", invoiceId: req.extra.invoiceId } })).toString("base64");
    const sameShape = Buffer.from(JSON.stringify({ x402Version: 2, accepted: req, payload: { signedTxBlob: "12000023", invoiceId: req.extra.invoiceId } })).toString("base64");
    for (const junk of [forged, sameShape]) {
      const r = await s.get(path, { "PAYMENT-SIGNATURE": junk, "Idempotency-Key": IKT, "CF-Connecting-IP": "9.9.9.9" });
      expect([402, 409]).toContain(r.status);
      expect(r.headers.get("Idempotent-Replayed")).toBeNull();
      const t = await r.text();
      expect(t).not.toContain(PAYER);
      expect(t).not.toContain('"payment"');
      expect(t).not.toBe(victim);
    }
    expect(s.fac.calls.filter((c) => c.path === "/settle").length).toBe(1);
  });

  it("the idempotency cache is scoped by route: the same key on another route is a fresh purchase, not a replay", async () => {
    const s = setup({ env: { FLEET_GUARD: undefined } });
    const IKT = "shared-key-0123456789abcdef";
    const p1 = "/v1/trust/check/high-value?url=https://a.example/x&amount=4";
    const p2 = "/v1/verdict?url=https://a.example/x";
    const q1: any = (await (await s.get(p1)).json()).accepts[0];
    expect((await s.get(p1, { "PAYMENT-SIGNATURE": paymentHeaderFor(q1), "Idempotency-Key": IKT })).status).toBe(200);
    const q2: any = (await (await s.get(p2)).json()).accepts[0];
    const r2 = await s.get(p2, { "PAYMENT-SIGNATURE": paymentHeaderFor(q2), "Idempotency-Key": IKT });
    expect(r2.status).toBe(200);
    expect(r2.headers.get("Idempotent-Replayed")).toBeNull();
    expect((s.idem as MemoryIdempotencyStore).rows.size).toBe(2);
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

  it("the key depends on FLEET_GUARD_KEY_SECRET and the tx, not on the payer/subject HMAC secret", async () => {
    const a = await buyPack(setup());
    const b = await buyPack(setup({ env: { FLEET_GUARD_KEY_SECRET: KEY_SECRET.replace("f", "0") } }));
    const c = await buyPack(setup({ env: { FLEET_GUARD_HMAC_SECRET: SECRET.replace("0", "9") } }));
    expect(a.body.key).toMatch(/^fgk_[0-9a-f]{40}$/);
    expect(a.body.key).not.toBe(b.body.key);
    expect(a.body.key).toBe(c.body.key);
  });

  it("fails closed without a usable FLEET_GUARD_KEY_SECRET: packs and plans are not quoted, checks still work", async () => {
    for (const v of [undefined, "short", SECRET]) {
      const s = setup({ env: { FLEET_GUARD_KEY_SECRET: v, FLEET_GUARD_MONTHLY: "on" } });
      for (const p of ["/v1/fleet/pack", "/v1/fleet/plan/monthly"]) {
        const r = await s.get(p);
        expect(r.status).toBe(503);
        expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
        expect(((await r.json()) as any).error).toBe("fleet_keys_not_configured");
      }
      const q: any = await (await s.get("/v1/fleet/pack")).json();
      const paid = await s.get("/v1/fleet/pack", { "PAYMENT-SIGNATURE": paymentHeaderFor({ extra: { invoiceId: "x" } }) });
      expect(paid.status).toBe(503);
      expect(q.accepts).toBeUndefined();
      expect(s.fac.calls.length).toBe(0);
      expect((await s.get("/v1/fleet/check?subject=a.example")).status).toBe(402);
      const doc: any = await (await s.get("/v1/fleet")).json();
      expect(doc.pack).toBeUndefined();
      expect(doc.monthly).toBeUndefined();
    }
  });
});

describe("MED-3: limits on prepaid keys", () => {
  const unknownKey = (i: number) => "fgk_" + i.toString(16).padStart(40, "0");

  it("valid keys: limited per key at keyPerMinute (1,200), not by the 60/min per-network cap", async () => {
    const s = setup();
    const { body } = await buyPack(s, {});
    const st: Record<number, number> = {};
    for (let i = 0; i < FLEET_GUARD.keyPerMinute + 1; i++) {
      const r = await s.get("/v1/fleet/check?subject=a.example", { "X-Lumi-Fleet-Key": body.key, "CF-Connecting-IP": "7.7.7.7" });
      st[r.status] = (st[r.status] ?? 0) + 1;
    }
    expect(st[200]).toBe(FLEET_GUARD.keyPerMinute);
    expect(st[429]).toBe(1);
    expect(s.uses()).toBe(FLEET_GUARD.keyPerMinute);
  });

  it("keys not yet known valid: 60/min per network (61 distinct real keys from one network → the 61st is 429)", async () => {
    const s = setup();
    const raws: string[] = [];
    for (let i = 0; i < FLEET_GUARD.keyIpPerMinute + 1; i++) {
      const raw = "fgk_" + (i + 1).toString(16).padStart(40, "a");
      const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, "0")).join("");
      await s.store.mintKey({ key_hash: h, plan: "fleet_pack", calls: 10, used: 0, expires_at: NOW + 86_400_000, paid_tx: "T" + i, payer_hmac: null, created_at: NOW });
      raws.push(raw);
    }
    const st: number[] = [];
    for (const raw of raws) st.push((await s.get("/v1/fleet/key", { "X-Lumi-Fleet-Key": raw, "CF-Connecting-IP": "6.6.6.6" })).status);
    expect(st.slice(0, FLEET_GUARD.keyIpPerMinute).every((x) => x === 200)).toBe(true);
    expect(st[FLEET_GUARD.keyIpPerMinute]).toBe(429);
    // once known valid, they are no longer under the per-network cap
    expect((await s.get("/v1/fleet/key", { "X-Lumi-Fleet-Key": raws[0], "CF-Connecting-IP": "6.6.6.6" })).status).toBe(200);
  });

  it("a freshly minted key works from a network locked out by bad keys", async () => {
    const s = setup();
    const { body } = await buyPack(s, {});
    const st: number[] = [];
    for (let i = 0; i < FLEET_GUARD.keyIpPerMinute; i++) st.push((await s.get("/v1/fleet/check?subject=a.example", { "X-Lumi-Fleet-Key": "nope-" + i, "CF-Connecting-IP": "3.3.3.3" })).status);
    // bad-format keys are failures: 10 × 401 then 429 (lockout)
    expect(st.filter((x) => x === 401).length).toBe(FLEET_GUARD.keyFailPer10Min);
    // the valid key still works from the locked-out network (minted keys are marked valid)
    expect((await s.get("/v1/fleet/check?subject=a.example", { "X-Lumi-Fleet-Key": body.key, "CF-Connecting-IP": "3.3.3.3" })).status).toBe(200);
  });

  it("random keys: a tighter failed-key limit returns 429 and stops further lookups", async () => {
    const s = setup();
    const st: Record<number, number> = {};
    for (let i = 0; i < 200; i++) {
      const r = await s.get("/v1/fleet/check?subject=a.example", { "X-Lumi-Fleet-Key": unknownKey(i), "CF-Connecting-IP": "7.7.7.7" });
      st[r.status] = (st[r.status] ?? 0) + 1;
    }
    expect(st[402]).toBe(FLEET_GUARD.keyFailPer10Min);
    expect(st[429]).toBe(200 - FLEET_GUARD.keyFailPer10Min);
    expect(s.uses()).toBeLessThanOrEqual(FLEET_GUARD.keyFailPer10Min + 1);
  });

  it("a shared NAT / /64 / unknown bucket locked out by bad keys does not lock out a recently valid key (other isolate too)", async () => {
    const counter = new MemoryQuotaCounter(() => NOW);
    const store = new MemoryFleetGuardStore();
    const mk = () => createApp(ENV as any, { fetch: makeFetch(happyFacilitator()), now: () => NOW, log: () => {}, fleetGuardStore: store, salesStore: new MemorySalesStore(), quotaCounter: counter, idempotencyStore: new MemoryIdempotencyStore() });
    const A = mk(); const B = mk();
    const get = (app: ReturnType<typeof mk>, p: string, h: Record<string, string>) => app.fetch(new Request(BASE + p, { headers: h }));
    const q: any = await (await get(A, "/v1/fleet/pack", {})).json();
    const key = ((await (await get(A, "/v1/fleet/pack", { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts[0]) })).json()) as any).key;
    expect((await get(A, "/v1/fleet/key", { "X-Lumi-Fleet-Key": key, "CF-Connecting-IP": "8.8.8.8" })).status).toBe(200);
    const nets: Record<string, string>[] = [{ "CF-Connecting-IP": "2001:db8:9:9::1" }, {}];
    for (const ipH of nets) {
      // lock the network out on isolate B (shared /64 and the header-less "unknown" bucket)
      const st: number[] = [];
      for (let i = 0; i < 15; i++) st.push((await get(B, "/v1/fleet/key", { "X-Lumi-Fleet-Key": unknownKey(1000 + i), ...ipH })).status);
      expect(st.slice(-3).every((x) => x === 429)).toBe(true);
      expect((await get(B, "/v1/fleet/key", { "X-Lumi-Fleet-Key": unknownKey(5000), ...ipH })).status).toBe(429);
      // the valid key, first time on isolate B and on this network: recognised through the shared marker
      expect((await get(B, "/v1/fleet/key", { "X-Lumi-Fleet-Key": key, ...ipH })).status).toBe(200);
      expect((await get(B, "/v1/fleet/check?subject=a.example", { "X-Lumi-Fleet-Key": key, ...ipH })).status).toBe(200);
    }
  });

  it("/v1/fleet/key: bad-format keys are failures too", async () => {
    const s = setup();
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
