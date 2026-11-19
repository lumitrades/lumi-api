/**
 * Quill's privacy review of the fleet guard (2026-11-19, notes/legal/privacy_fleet_guard_2026-11-19.md) plus Vigil's
 * steering items: labels, legal fields, method URL, hashed resource URLs, retention, corrections, no fingerprinting fields,
 * HMAC rotation, admin while off, monthly plan hidden.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app";
import { loadConfig, type D1Like, type D1Statement } from "../src/config";
import { MemorySalesStore } from "../src/sales";
import { MemoryQuotaCounter } from "../src/free_quota";
import { MemoryIdempotencyStore } from "../src/idempotency";
import { createFleetGuard, D1FleetGuardStore, MemoryFleetGuardStore, FLEET_DISCLAIMER, FLEET_DISCLAIMER_SHORT, FLEET_USE_RESTRICTION, FLEET_SALES_ROUTES, FLEET_CHECK_RAILS_TEXT, FLEET_PACK_RAILS_TEXT, type FleetGuardStore } from "../src/fleet_guard";
import { MemoryReplayGuard } from "../src/x402";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor, decodeB64Json } from "./helpers";

const SECRET = "fg-test-secret-0123456789abcdef0123456789";
const NEW_SECRET = "fg-rotated-secret-zyxwvutsrqponmlkjihgfedcba";
const KEY_SECRET = "fg-key-secret-fedcba9876543210fedcba9876543210";
const OWNER = "k".repeat(52);
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: OWNER, FLEET_GUARD: "on", FLEET_GUARD_HMAC_SECRET: SECRET, FLEET_GUARD_KEY_SECRET: KEY_SECRET };
const BASE = "http://lumi.test";
const FLEET_PAYER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const FLEET_SELLER = "seller-in-fleet.example";
const CLEAN = "clean-seller.example";
const EVM = "0x" + "12".repeat(20);
const DAY = 86_400_000;
const FORBIDDEN = /scripted|one buyer|independent demand|seller's income|first_seen|wallets"|sellers_paid|confidence"|"cluster_id"|"F1"/i;

class SqliteD1 implements D1Like {
  db = new DatabaseSync(":memory:");
  constructor(migrations: string[]) { for (const m of migrations) this.db.exec(readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8")); }
  prepare(sql: string): D1Statement { return this.stmt(sql, []); }
  private stmt(sql: string, args: unknown[]): D1Statement {
    // Same limit as Cloudflare D1: at most 100 bound parameters per statement.
    if (args.length > 100) throw new Error(`D1_ERROR: too many SQL variables (${args.length} > 100)`);
    const db = this.db;
    const a = args.map((v) => (v === undefined ? null : v)) as any[];
    return {
      bind: (...v: unknown[]) => this.stmt(sql, v),
      run: async () => { const r = db.prepare(sql).run(...a); return { meta: { changes: Number(r.changes) } } as any; },
      all: async <T>() => ({ results: db.prepare(sql).all(...a) as T[] }),
      first: async <T>() => ((db.prepare(sql).get(...a) as T) ?? null),
    };
  }
  async batch(st: D1Statement[]) { for (const s of st) await s.run(); return []; }
}

function setup(o: { env?: Record<string, unknown>; store?: FleetGuardStore; clock?: { t: number } } = {}) {
  const clock = o.clock ?? { t: NOW };
  const store = o.store ?? new MemoryFleetGuardStore();
  const sales = new MemorySalesStore();
  const fac = happyFacilitator();
  const app = createApp({ ...ENV, ...(o.env ?? {}) } as any, {
    fetch: makeFetch(fac), now: () => clock.t, log: () => {}, fleetGuardStore: store as any, salesStore: sales,
    quotaCounter: new MemoryQuotaCounter(() => clock.t), idempotencyStore: new MemoryIdempotencyStore(),
  });
  const get = (p: string, h: Record<string, string> = {}) => app.fetch(new Request(BASE + p, { headers: h }));
  const admin = (method: string, p: string, body: unknown, owner = true) => app.fetch(new Request(BASE + p, {
    method, body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...(owner ? { Authorization: `Bearer ${OWNER}` } : {}) },
  }));
  const load = (subjects = [{ value: FLEET_PAYER, role: "payer" }, { value: FLEET_SELLER, role: "seller" }]) => admin("POST", "/v1/fleet/admin/members", { cluster: { id: "F1", basis: "funding path + payer overlap" }, subjects });
  const check = async (subjects: string) => {
    const q: any = await (await get(`/v1/fleet/check?subject=${subjects}`)).json();
    const r = await get(`/v1/fleet/check?subject=${subjects}`, { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts[0]) });
    const text = await r.text();
    return { r, text, b: JSON.parse(text) as any, q };
  };
  // the fake facilitator returns one tx hash for every settle: forget recorded settles between paid checks in a test
  const reset = () => { if (store instanceof MemoryFleetGuardStore) store.settles.clear(); };
  return { app, get, admin, load, check, reset, store, sales, clock, fac };
}

const legalOk = (b: any) => {
  expect(b.method_url).toBe(`${BASE}/v1/fleet/methodology`);
  expect(b.disclaimer).toBe(FLEET_DISCLAIMER);
  expect(b.disclaimer).toMatch(/Not OFAC/);
  expect(b.disclaimer).toMatch(/Not a consumer report/);
  expect(b.disclaimer).toMatch(/no warranty/i);
  expect(b.use_restriction).toBe(FLEET_USE_RESTRICTION);
  expect(b.use_restriction).toMatch(/15 U\.S\.C\. 1681b/);
  for (const w of ["credit", "employment", "insurance", "tenancy"]) expect(b.use_restriction).toContain(w);
  expect(b.disputes).toContain("hello@lumitrades.io");
};

describe("Quill 1 + 7: only three label values, no score, no intent wording, no fingerprinting fields", () => {
  it("match / No match / Insufficient data", async () => {
    const s = setup();
    expect((await s.load()).status).toBe(200);
    const { r, text, b } = await s.check(`${FLEET_PAYER},${CLEAN},${EVM}`);
    expect(r.status).toBe(200);
    const day = new Date(NOW).toISOString().slice(0, 10);
    expect(b.results.map((x: any) => x.label)).toEqual([
      `Pattern match: automated cluster, as of ${day}, method ${BASE}/v1/fleet/methodology`,
      "No match",          // a domain: Lumi has domain clusters, this one is not in them
      "Insufficient data", // an EVM address: Lumi has no EVM clusters loaded
    ]);
    expect(b.results.map((x: any) => x.match)).toEqual([true, false, null]);
    for (const x of b.results) expect(Object.keys(x).sort()).toEqual(["as_of", "index", "label", "match", "role", "subject_kind"]);
    expect(text).not.toMatch(FORBIDDEN);
    expect(text).not.toMatch(/score/i);
    legalOk(b);
  });

  it("docs, methodology and discovery carry no intent wording either", async () => {
    const s = setup();
    for (const p of ["/v1/fleet", "/v1/fleet/methodology", "/.well-known/x402"]) {
      const t = await (await s.get(p)).text();
      expect(t, p).not.toMatch(/scripted|one buyer|independent demand|seller's income/i);
    }
  });
});

describe("Quill 2: disclaimer, FCRA use restriction and a resolving method_url on every fleet response", () => {
  it("paid, free, prepaid-key, key info and pack responses", async () => {
    const s = setup();
    await s.load();
    legalOk((await s.check(CLEAN)).b);
    legalOk(await (await s.get(`/v1/fleet/check/free?subject=${CLEAN}`, { "CF-Connecting-IP": "1.1.1.1" })).json());
    const q: any = await (await s.get("/v1/fleet/pack")).json();
    s.reset();
    const pack: any = await (await s.get("/v1/fleet/pack", { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts[0]) })).json();
    legalOk(pack);
    expect(pack.auto_renew).toBe(false);
    legalOk(await (await s.get(`/v1/fleet/check?subject=${CLEAN}`, { "X-Lumi-Fleet-Key": pack.key })).json());
    legalOk(await (await s.get("/v1/fleet/key", { "X-Lumi-Fleet-Key": pack.key })).json());
    legalOk(await (await s.get("/v1/fleet")).json());
  });

  it("the method URL resolves, and the trust methodology page carries the fleet section only when on", async () => {
    const s = setup();
    const m = await s.get("/v1/fleet/methodology");
    expect(m.status).toBe(200);
    const mb: any = await m.json();
    expect(mb.url).toBe(`${BASE}/v1/fleet/methodology`);
    expect(mb.labels).toMatchObject({ no_match: "No match", insufficient_data: "Insufficient data" });
    expect(JSON.stringify(mb.retention)).toMatch(/90 days/);
    expect(JSON.stringify(mb.retention)).toMatch(/30 days after the key expires/);
    legalOk(mb);
    const tm: any = await (await s.get("/v1/trust/methodology")).json();
    expect(tm.fleet_guard?.url).toBe(`${BASE}/v1/fleet/methodology`);
    const off = setup({ env: { FLEET_GUARD: "off" } });
    expect((await off.get("/v1/fleet/methodology")).status).toBe(404);
    const tOff: any = await (await off.get("/v1/trust/methodology")).json();
    expect(tOff).not.toHaveProperty("fleet_guard");
  });
});

describe("Quill 3: the subject is always hashed in invoice / resource URLs", () => {
  it("one short subject: resource URL has n and qh only", async () => {
    const s = setup();
    for (const subj of [CLEAN, FLEET_PAYER, EVM]) {
      const r = await s.get(`/v1/fleet/check?subject=${subj}`);
      const body = await r.clone().text();
      const hdr = JSON.stringify(decodeB64Json(r.headers.get("PAYMENT-REQUIRED")));
      const q = JSON.parse(body);
      expect(q.resource.url).toMatch(/^http:\/\/lumi\.test\/v1\/fleet\/check\?n=1&qh=[0-9a-f]{32}$/);
      expect(body).not.toContain(subj);
      expect(hdr).not.toContain(subj);
    }
  });
});

describe("Quill 4 + 5: retention (90 days; keys 30 days after expiry) and owner deletion", () => {
  async function retention(store: FleetGuardStore) {
    const clock = { t: NOW };
    const s = setup({ store, clock });
    await s.load();
    await store.recordSettle("TX_OLD", "fleet_check", "ph", NOW);
    await store.mintKey({ key_hash: "kh_exp", plan: "fleet_pack", calls: 10, used: 0, expires_at: NOW + 70 * DAY, paid_tx: "TXK", payer_hmac: null, created_at: NOW });
    await s.sales.insert({ route: "fleet_check", routeKey: null, rail: "xrpl", network: "xrpl:1", asset: "XRP", amount: "1", usd: 0.0005, payer: null, tx: "S1", facilitator: null, client: null, isTest: false, ts: NOW } as any);
    await s.sales.insert({ route: "high_value_check", routeKey: null, rail: "xrpl", network: "xrpl:1", asset: "XRP", amount: "1", usd: 0.25, payer: null, tx: "S2", facilitator: null, client: null, isTest: false, ts: NOW } as any);
    const fg = createFleetGuard({
      cfg: loadConfig(ENV as any), env: ENV, store, counter: new MemoryQuotaCounter(() => clock.t), isOwner: async () => true, now: () => clock.t, log: () => {},
      paywall: () => ({ fetch: makeFetch(happyFacilitator()), replay: new MemoryReplayGuard() }), sales: s.sales,
    });
    clock.t = NOW + 89 * DAY;
    expect(await fg.purge()).toEqual({ settles: 0, members: 0, clusters: 0, keys: 0, sales: 0 });
    clock.t = NOW + 91 * DAY;
    const r = await fg.purge();
    expect(r).toEqual({ settles: 1, members: 2, clusters: 1, keys: 0, sales: 1 });
    clock.t = NOW + 101 * DAY;
    expect((await fg.purge()).keys).toBe(1); // expired at day 70, deleted 30 days later
    expect(s.sales.rows.map((x) => x.route)).toEqual(["high_value_check"]);
    // memberships are gone: the domain kind is no longer covered either
    expect((await store.members([])).size).toBe(0);
    expect((await store.coveredKinds()).size).toBe(0);
  }
  it("memory store", async () => { await retention(new MemoryFleetGuardStore()); });
  it("D1 store (real migration)", async () => { await retention(new D1FleetGuardStore(new SqliteD1(["0034_fleet_guard.sql"]))); });

  it("a reconfirmed membership restarts its 90-day clock and its as-of date", async () => {
    const clock = { t: NOW };
    const store = new MemoryFleetGuardStore();
    const s = setup({ store, clock });
    await s.load();
    clock.t = NOW + 60 * DAY;
    await s.load();
    const fg = createFleetGuard({ cfg: loadConfig(ENV as any), env: ENV, store, counter: new MemoryQuotaCounter(() => clock.t), isOwner: async () => true, now: () => clock.t, log: () => {}, paywall: () => ({ fetch: makeFetch(happyFacilitator()), replay: new MemoryReplayGuard() }) });
    clock.t = NOW + 120 * DAY;
    expect((await fg.purge()).members).toBe(0);
    clock.t = NOW + 151 * DAY;
    expect((await fg.purge()).members).toBe(2);
  });

  it("owner deletion by subject and by cluster; non-owner refused", async () => {
    const s = setup();
    await s.load();
    expect((await s.admin("DELETE", "/v1/fleet/admin/members", { subjects: [FLEET_PAYER] }, false)).status).toBe(401);
    const d: any = await (await s.admin("DELETE", "/v1/fleet/admin/members", { subjects: [FLEET_PAYER] })).json();
    expect(d.removed).toBe(1);
    const c: any = await (await s.admin("DELETE", "/v1/fleet/admin/members", { cluster: "F1" })).json();
    expect(c.removed).toBe(1);
    s.reset();
    const { b } = await s.check(`${FLEET_PAYER},${FLEET_SELLER}`);
    expect(b.results.map((x: any) => x.label)).toEqual(["Insufficient data", "Insufficient data"]);
  });

  it("the nightly purge runs even when FLEET_GUARD is off", async () => {
    const store = new MemoryFleetGuardStore();
    let purged = 0;
    const orig = store.purge.bind(store);
    store.purge = async (t: number) => { purged++; return orig(t); };
    const nightly = Date.UTC(2026, 10, 20, 3, 0, 0);
    const app = createApp({ ...ENV, FLEET_GUARD: "off" } as any, { fetch: makeFetch(happyFacilitator()), now: () => nightly, log: () => {}, fleetGuardStore: store, salesStore: new MemorySalesStore(), quotaCounter: new MemoryQuotaCounter(() => nightly) });
    await app.scheduled();
    expect(purged).toBe(1);
  });
});

describe("deletions are never served stale from another isolate", () => {
  it("isolate A answered a match; the owner deletes via isolate B; A's next answer is not a match", async () => {
    const store = new MemoryFleetGuardStore();
    const A = setup({ store }); const B = setup({ store });
    await B.load();
    A.reset();
    expect((await A.check(FLEET_SELLER)).b.results[0].match).toBe(true);
    await B.admin("DELETE", "/v1/fleet/admin/members", { subjects: [FLEET_SELLER] });
    A.reset();
    expect((await A.check(FLEET_SELLER)).b.results[0].match).not.toBe(true);
  });
});

describe("D1 parameter limit (live member load of 104 failed with 500 on 2026-11-19)", () => {
  it("loads, looks up and deletes 150 members through the real-SQL store with D1's 100-parameter limit", async () => {
    const store = new D1FleetGuardStore(new SqliteD1(["0034_fleet_guard.sql"]));
    const s = setup({ store });
    const subjects = Array.from({ length: 150 }, (_, i) => ({ value: `m${i}.fleet-test.example`, role: "payer" }));
    const r = await s.load(subjects);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).members).toBe(150);
    // a reload checks overrides for all 150 again (chunked)
    expect(((await (await s.load(subjects)).json()) as any).members).toBe(150);
    const { b } = await s.check(subjects.slice(0, 20).map((x) => x.value).join(","));
    expect(b.results.every((x: any) => x.match === true)).toBe(true);
    const d: any = await (await s.admin("DELETE", "/v1/fleet/admin/members", { subjects: subjects.map((x) => x.value) })).json();
    expect(d.removed).toBe(150);
  });
});

describe("Quill 6: owner correction / exclusion applies at once", () => {
  it("override wins at once, blocks reloading that subject, and can be cleared", async () => {
    const s = setup();
    await s.load();
    expect((await s.check(FLEET_PAYER)).b.results[0].match).toBe(true);
    expect((await s.admin("POST", "/v1/fleet/admin/override", { subject: FLEET_PAYER, label: "No match" }, false)).status).toBe(401);
    expect((await s.admin("POST", "/v1/fleet/admin/override", { subject: FLEET_PAYER, label: "Pattern match" })).status).toBe(400);
    expect((await s.admin("POST", "/v1/fleet/admin/override", { subject: FLEET_PAYER, label: "No match" })).status).toBe(200);
    s.reset();
    expect((await s.check(FLEET_PAYER)).b.results[0]).toMatchObject({ label: "No match", match: false, role: null });
    // a later member load skips the overridden subject
    const l: any = await (await s.load()).json();
    expect(l.skipped_overridden).toBe(1);
    expect((await s.admin("POST", "/v1/fleet/admin/override", { subject: FLEET_PAYER, label: null })).status).toBe(200);
    s.reset();
    // override cleared; the membership was removed when the override was set (no xrpl members left: Insufficient data)
    expect((await s.check(FLEET_PAYER)).b.results[0]).toMatchObject({ label: "Insufficient data", match: null });
  });
});

describe("Quill 8: HMAC rotation (current + previous secret)", () => {
  it("lookups, overrides and deletions match hashes made with the previous secret", async () => {
    const store = new MemoryFleetGuardStore();
    await setup({ store }).load(); // loaded under the old secret
    const rotated = setup({ store, env: { FLEET_GUARD_HMAC_SECRET: NEW_SECRET, FLEET_GUARD_HMAC_SECRET_PREV: SECRET } });
    rotated.reset();
    expect((await rotated.check(FLEET_PAYER)).b.results[0].match).toBe(true);
    const noPrev = setup({ store, env: { FLEET_GUARD_HMAC_SECRET: NEW_SECRET } });
    noPrev.reset();
    expect((await noPrev.check(FLEET_PAYER)).b.results[0].match).not.toBe(true);
    // deletion under the rotated config removes the old-secret row
    const d: any = await (await rotated.admin("DELETE", "/v1/fleet/admin/members", { subjects: [FLEET_SELLER] })).json();
    expect(d.removed).toBe(1);
    // an override written during rotation is found under either secret
    await rotated.admin("POST", "/v1/fleet/admin/override", { subject: FLEET_PAYER, label: "Insufficient data" });
    const old = setup({ store });
    old.reset();
    expect((await old.check(FLEET_PAYER)).b.results[0].label).toBe("Insufficient data");
  });
});

describe("Vigil final: PREV-only overrides are re-keyed under the current secret", () => {
  it("an override survives removing PREV after one lookup", async () => {
    const store = new MemoryFleetGuardStore();
    const old = setup({ store });
    await old.load();
    expect((await old.admin("POST", "/v1/fleet/admin/override", { subject: FLEET_PAYER, label: "No match" })).status).toBe(200);
    expect(store.overrideMap.size).toBe(1); // old-secret hash only
    const rotated = setup({ store, env: { FLEET_GUARD_HMAC_SECRET: NEW_SECRET, FLEET_GUARD_HMAC_SECRET_PREV: SECRET } });
    rotated.reset();
    expect((await rotated.check(FLEET_PAYER)).b.results[0].label).toBe("No match");
    expect(store.overrideMap.size).toBe(2); // re-keyed under the new secret
    const noPrev = setup({ store, env: { FLEET_GUARD_HMAC_SECRET: NEW_SECRET } });
    noPrev.reset();
    expect((await noPrev.check(FLEET_PAYER)).b.results[0]).toMatchObject({ label: "No match", match: false });
  });
});

describe("Vigil final: admin owner check comes before the configuration 503", () => {
  it("non-owner gets 401 even when the HMAC secret is missing; owner gets 503", async () => {
    const s = setup({ env: { FLEET_GUARD: "off", FLEET_GUARD_HMAC_SECRET: undefined } });
    for (const [m, p] of [["POST", "/v1/fleet/admin/members"], ["DELETE", "/v1/fleet/admin/members"], ["POST", "/v1/fleet/admin/override"]]) {
      const r = await s.admin(m, p, {}, false);
      expect(r.status, `${m} ${p}`).toBe(401);
      expect(await r.text()).not.toMatch(/not_configured/);
      expect((await s.admin(m, p, {})).status, `${m} ${p}`).toBe(503);
    }
  });
});

describe("Vigil final: the recently-valid marker slides while a key is in use", () => {
  it("a key used continuously past 10 minutes is not locked out by 11 junk keys from its bucket", async () => {
    // Mint 1 minute into a 10-minute lockout window, so a lockout tripped at 9.5 min lasts until 19 min.
    const start = Math.ceil(NOW / 600_000) * 600_000 + 60_000;
    const clock = { t: start };
    const s = setup({ clock });
    const q: any = await (await s.get("/v1/fleet/pack")).json();
    const key = ((await (await s.get("/v1/fleet/pack", { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts[0]) })).json()) as any).key;
    const ip = { "CF-Connecting-IP": "2001:db8:77:1::5" };
    const use = async (label: string) => expect((await s.get(`/v1/fleet/check?subject=${CLEAN}`, { "X-Lumi-Fleet-Key": key, ...ip })).status, label).toBe(200);
    for (let m = 0; m <= 9; m++) { clock.t = start + m * 60_000; await use(`minute ${m}`); }
    clock.t = start + 9.5 * 60_000;
    const junk: number[] = [];
    for (let i = 0; i < 11; i++) junk.push((await s.get("/v1/fleet/key", { "X-Lumi-Fleet-Key": `junk-${i}`, ...ip })).status);
    expect(junk.at(-1)).toBe(429); // the bucket is locked out until minute 19
    // Past the 10 minutes since mint: still served, because each use extended the marker.
    for (const m of [10.5, 12, 15, 18]) { clock.t = start + m * 60_000; await use(`minute ${m}`); }
    expect((await s.get("/v1/fleet/key", { "X-Lumi-Fleet-Key": unknownKeyLike(), ...ip })).status).toBe(429);
  });
});

const unknownKeyLike = () => "fgk_" + "e".repeat(40);

describe("Quill final: legal notes in the 402 body, not in the PAYMENT-REQUIRED header", () => {
  it("body carries disclaimer, use_restriction and method_url; header bytes unchanged from b4bfccf", async () => {
    const FULL = { EVM_PAY_TO: "0x5E617bac19912e6d212CB303ae84655E9E203532", EVM_NETWORK: "eip155:8453", EVM_FACILITATOR_URL: "https://evm-fac.test", EVM_CDP_ONLY_ROUTES: "none",
      STELLAR_PAY_TO: "GCKTH26VNR4H4WLCXS5DX6563XRQQXWP5QKQWFD6CHOGTZJ2N5GKBU2L", STELLAR_NETWORK: "stellar:pubnet", STELLAR_FACILITATOR_URL: "https://st-fac.test", STELLAR_FACILITATOR_API_KEY: "test-key", PUBLIC_BASE_URL: "https://api.lumitrades.io", FLEET_GUARD_MONTHLY: "on" };
    const s = setup({ env: FULL });
    // Header lengths measured on b4bfccf (before the body fields) with this exact config and clock.
    const baseline: Record<string, number> = {
      "/v1/fleet/check?subject=a.io": 2988, // 2026-11-19: no Base accept (was 3592; the rails note is body-only)
      "/v1/fleet/check?subject=a.io,b.io,c.io": 2996, // 2026-11-19: no Base accept (was 3600)
      "/v1/fleet/pack": 3448,
      "/v1/fleet/plan/monthly": 3504,
    };
    for (const [p, len] of Object.entries(baseline)) {
      const r = await s.get(p);
      expect(r.status, p).toBe(402);
      const b: any = await r.json();
      expect(b.disclaimer, p).toBe(FLEET_DISCLAIMER_SHORT);
      expect(b.disclaimer).toMatch(/Not OFAC\/AML screening, not a consumer report/);
      expect(b.use_restriction, p).toBe(FLEET_USE_RESTRICTION);
      expect(b.method_url, p).toBe("https://api.lumitrades.io/v1/fleet/methodology");
      const h = r.headers.get("PAYMENT-REQUIRED")!;
      expect(h.length, p).toBe(len);
      expect(new TextEncoder().encode(h).length, p).toBeLessThan(4096);
      const hp = decodeB64Json(h);
      for (const k of ["disclaimer", "use_restriction", "method_url"]) expect(hp, p).not.toHaveProperty(k);
    }
    // other routes' 402s are untouched
    const t: any = await (await s.get("/v1/trust/check/high-value?url=https://a.example/x&amount=4")).json();
    expect(t).not.toHaveProperty("use_restriction");
  });
});

describe("Vigil steering 1: owner admin works while FLEET_GUARD is off", () => {
  it("load, override and delete return 200 while public routes stay absent", async () => {
    const store = new MemoryFleetGuardStore();
    const off = setup({ store, env: { FLEET_GUARD: "off" } });
    expect((await off.load()).status).toBe(200);
    expect((await off.admin("POST", "/v1/fleet/admin/override", { subject: CLEAN, label: "No match" })).status).toBe(200);
    expect((await off.admin("DELETE", "/v1/fleet/admin/members", { subjects: [FLEET_SELLER] })).status).toBe(200);
    expect((await off.admin("POST", "/v1/fleet/admin/members", {}, false)).status).toBe(401);
    expect((await off.get(`/v1/fleet/check?subject=${CLEAN}`)).status).toBe(404);
    expect((await off.get("/v1/fleet")).status).toBe(404);
    // the members loaded while off answer once switched on
    const on = setup({ store });
    on.reset();
    expect((await on.check(FLEET_PAYER)).b.results[0].match).toBe(true);
  });
  it("still fails closed without the HMAC secret", async () => {
    const s = setup({ env: { FLEET_GUARD: "off", FLEET_GUARD_HMAC_SECRET: undefined } });
    expect((await s.load()).status).toBe(503);
  });
  it("wrangler.toml commits FLEET_GUARD = \"on\" in production (launched 2026-11-19) and \"off\" on testnet", () => {
    const t = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    const top = t.slice(t.indexOf("[vars]"), t.indexOf("[env.testnet]"));
    const testnet = t.slice(t.indexOf("[env.testnet]"));
    expect(top).toMatch(/^FLEET_GUARD = "on"/m);
    expect(testnet).toMatch(/^FLEET_GUARD = "off"/m);
  });
});

describe("pricing text and the monthly plan", () => {
  it("docs say 0.0005 USD per call and the $4 / 10,000 / 365 days / no auto-renew pack; monthly hidden unless on", async () => {
    const d: any = await (await setup().get("/v1/fleet")).json();
    expect(d.price).toMatch(/^0\.0005 USD per call/);
    expect(d.pack.text).toBe("$4 pack of 10,000 calls, lasts 365 days, no auto-renew.");
    expect(d.pack.auto_renew).toBe(false);
    expect(JSON.stringify(d)).not.toMatch(/monthly|\$49|"49"/);
    expect(JSON.stringify(await (await setup().get("/v1/fleet/methodology")).json())).not.toMatch(/monthly|49/);
    expect(JSON.stringify(await (await setup().get("/.well-known/x402")).json())).not.toMatch(/fleet\/plan\/monthly/);
    const on: any = await (await setup({ env: { FLEET_GUARD_MONTHLY: "on" } }).get("/v1/fleet")).json();
    expect(on.monthly).toMatchObject({ usd: "49", auto_renew: false });
  });
});

void FLEET_SALES_ROUTES;

describe("2026-11-19: per-call check is not offered in Base USDC (below the facilitator minimum); the pack still is", () => {
  const FULL = { EVM_PAY_TO: "0x5E617bac19912e6d212CB303ae84655E9E203532", EVM_NETWORK: "eip155:8453", EVM_FACILITATOR_URL: "https://evm-fac.test", EVM_CDP_ONLY_ROUTES: "none",
    STELLAR_PAY_TO: "GCKTH26VNR4H4WLCXS5DX6563XRQQXWP5QKQWFD6CHOGTZJ2N5GKBU2L", STELLAR_NETWORK: "stellar:pubnet", STELLAR_FACILITATOR_URL: "https://st-fac.test", STELLAR_FACILITATOR_API_KEY: "test-key", PUBLIC_BASE_URL: "https://api.lumitrades.io" };
  const nets = (pr: any) => pr.accepts.map((a: any) => a.network).sort();

  it("check 402 (body and header) has XRPL + Stellar accepts only, a rails note, and no Base how_to_pay", async () => {
    const s = setup({ env: FULL });
    for (const p of ["/v1/fleet/check?subject=a.io", "/v1/fleet/check?subject=a.io,b.io", "/v1/fleet/check?subject=0x" + "1".repeat(40)]) {
      const r = await s.get(p);
      expect(r.status, p).toBe(402);
      const b: any = await r.json();
      const h = decodeB64Json(r.headers.get("PAYMENT-REQUIRED"));
      for (const pr of [b, h]) {
        expect(nets(pr), p).toEqual(["stellar:pubnet", "xrpl:1", "xrpl:1", "xrpl:1"]);
        expect(pr.accepts.some((a: any) => String(a.network).startsWith("eip155:")), p).toBe(false);
        expect(pr, p).not.toHaveProperty("how_to_pay");
      }
      expect(b.note, p).toBe(FLEET_CHECK_RAILS_TEXT); // body-only key; the header stays the x402 PaymentRequired
      expect(h, p).not.toHaveProperty("note");
      expect(new TextEncoder().encode(r.headers.get("PAYMENT-REQUIRED")!).length, p).toBeLessThan(4096);
    }
  });

  it("pack 402 still offers Base USDC (500-unit floor does not apply: $4 = 4,000,000 units)", async () => {
    const s = setup({ env: FULL });
    const r = await s.get("/v1/fleet/pack");
    expect(r.status).toBe(402);
    const b: any = await r.json();
    expect(nets(b)).toEqual(["eip155:8453", "stellar:pubnet", "xrpl:1", "xrpl:1", "xrpl:1"]);
    expect(b.accepts.find((a: any) => a.network === "eip155:8453").amount).toBe("4000000");
    expect(b).toHaveProperty("how_to_pay");
  });

  it("a Base USDC payment presented to the check is refused before any facilitator call and never served", async () => {
    const s = setup({ env: FULL });
    const pack: any = await (await s.get("/v1/fleet/pack")).json();
    const evm = { ...pack.accepts.find((a: any) => a.network === "eip155:8453"), amount: "500" };
    const r = await s.get("/v1/fleet/check?subject=a.io", { "PAYMENT-SIGNATURE": paymentHeaderFor(evm) });
    expect(r.status).not.toBe(200);
    expect(s.fac.calls.length).toBe(0);
    const b: any = await r.json();
    expect(b.kind).not.toBe("lumi_fleet_check");
  });

  it("XRPL per-call payment still works", async () => {
    const s = setup({ env: FULL });
    const { r, b } = await s.check("a.io");
    expect(r.status).toBe(200);
    expect(b.kind).toBe("lumi_fleet_check");
  });

  it("docs, methodology and /.well-known/x402 say per call is XRPL / Stellar and the pack is also on Base", async () => {
    const s = setup({ env: FULL });
    const d: any = await (await s.get("/v1/fleet")).json();
    expect(d.check.rails).toEqual(["xrpl", "stellar"]);
    expect(d.check.payment).toBe(FLEET_CHECK_RAILS_TEXT);
    expect(d.pack.rails).toEqual(["base", "xrpl", "stellar"]);
    expect(d.pack.payment).toBe(FLEET_PACK_RAILS_TEXT);
    const m: any = await (await s.get("/v1/fleet/methodology")).json();
    expect(m.payment).toContain("Base USDC is not offered per call");
    const wk: any = await (await s.get("/.well-known/x402")).json();
    const fr = wk.resources.find((x: any) => String(x.url ?? x.resource ?? "").includes("/v1/fleet/check"));
    expect(fr.description).toMatch(/per call on XRPL or Stellar/);
    expect(fr.description).toMatch(/also payable in Base USDC/);
  });
});
