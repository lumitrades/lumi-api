import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { MemorySalesStore } from "../src/sales";
import { MemoryQuotaCounter, type QuotaCounter } from "../src/free_quota";
import { FLEET_GUARD, MemoryFleetGuardStore, normalizeSubject, parseQuery, checkPriceUsd } from "../src/fleet_guard";
import { PAYMENT_REQUIRED_HEADER_SOFT_LIMIT } from "../src/x402";
import { DATA, FACILITATOR, PAY_TO, PAYER, NOW, happyFacilitator, makeFetch, paymentHeaderFor, decodeB64Json, jsonResponse, type FakeFacilitator } from "./helpers";

const OWNER = "k".repeat(52);
const SECRET = "fg-test-secret-0123456789abcdef0123456789";
const KEY_SECRET = "fg-key-secret-fedcba9876543210fedcba9876543210";
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: OWNER, FLEET_GUARD: "on", FLEET_GUARD_HMAC_SECRET: SECRET, FLEET_GUARD_KEY_SECRET: KEY_SECRET };
const BASE = "http://lumi.test";
const FLEET_PAYER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const FLEET_SELLER = "seller-in-fleet.example";
const CLEAN = "clean-seller.example";

function setup(o: { env?: Record<string, string | undefined>; fac?: FakeFacilitator; counter?: QuotaCounter; store?: MemoryFleetGuardStore } = {}) {
  const logs: any[] = [];
  const store = o.store ?? new MemoryFleetGuardStore();
  const sales = new MemorySalesStore();
  const fac = o.fac ?? happyFacilitator();
  const app = createApp({ ...ENV, ...(o.env ?? {}) } as any, {
    fetch: makeFetch(fac), now: () => NOW, log: (e) => logs.push(e), fleetGuardStore: store, salesStore: sales,
    quotaCounter: o.counter ?? new MemoryQuotaCounter(() => NOW),
  });
  const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(BASE + path, { headers }));
  return { app, get, store, sales, fac, logs };
}

async function loadFleet(s: ReturnType<typeof setup>) {
  const r = await s.app.fetch(new Request(BASE + "/v1/fleet/admin/members", {
    method: "POST", headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
    body: JSON.stringify({ cluster: { id: "F1", wallets: 104, sellers_paid: 3, first_seen: "2026-08-25", basis: "funding path + 100% payer overlap" }, subjects: [{ value: FLEET_PAYER, role: "payer" }, { value: FLEET_SELLER, role: "seller" }] }),
  }));
  expect(r.status).toBe(200);
}

/** Pay a quoted 402 with the given accepts entry (default: first). */
async function pay(s: ReturnType<typeof setup>, path: string, extra: Record<string, string> = {}) {
  const q = await s.get(path);
  expect(q.status).toBe(402);
  const body: any = await q.json();
  const accepted = body.accepts[0];
  return { accepted, res: await s.get(path, { "PAYMENT-SIGNATURE": paymentHeaderFor(accepted), ...extra }) };
}

describe("fleet guard: parsing", () => {
  it("normalizes subjects and bounds input", () => {
    expect(normalizeSubject("https://WWW.Seller.Example/v1/x")).toEqual({ kind: "domain", norm: "seller.example" });
    expect(normalizeSubject("0x" + "AB".repeat(20))?.norm).toBe("0x" + "ab".repeat(20));
    expect(normalizeSubject(FLEET_PAYER)?.kind).toBe("xrpl");
    expect(normalizeSubject("a".repeat(200))).toBeNull();
    expect(parseQuery(new URL(BASE + "/v1/fleet/check?subject=" + Array(21).fill("a.example").join(","))).ok).toBe(false);
    expect(parseQuery(new URL(BASE + "/v1/fleet/check?subject=" + "x".repeat(3000))).ok).toBe(false);
    expect(checkPriceUsd(1)).toBe("0.0005");
    expect(checkPriceUsd(20)).toBe("0.01");
  });
});

describe("fleet guard: switches", () => {
  it("is not handled unless FLEET_GUARD=on, and fails closed without the HMAC secret", async () => {
    const off = setup({ env: { FLEET_GUARD: undefined } });
    const r = await off.get("/v1/fleet/check?subject=a.example");
    expect(r.status).not.toBe(402);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
    const wk: any = await (await off.get("/.well-known/x402")).json();
    expect(JSON.stringify(wk.resources)).not.toContain("/v1/fleet");
    const noSecret = setup({ env: { FLEET_GUARD_HMAC_SECRET: undefined } });
    expect((await noSecret.get("/v1/fleet/check?subject=a.example")).status).toBe(503);
    const on = setup();
    const wk2: any = await (await on.get("/.well-known/x402")).json();
    expect(JSON.stringify(wk2.resources)).toContain("/v1/fleet/check");
  });
});

describe("fleet guard: 402 quote", () => {
  it("quotes 0.0005 per subject from server config, no lookup before payment, header a few KB", async () => {
    const s = setup();
    let lookups = 0;
    const orig = s.store.members.bind(s.store);
    s.store.members = async (h) => { lookups++; return orig(h); };
    for (const n of [1, 20]) {
      const subj = Array.from({ length: n }, (_, i) => `${"x".repeat(60)}.${"y".repeat(48)}-${String(i).padStart(2, "0")}.example`).join(",");
      const r = await s.get(`/v1/fleet/check?subject=${subj}`);
      expect(r.status).toBe(402);
      const h = r.headers.get("PAYMENT-REQUIRED")!;
      expect(h.length).toBeLessThan(4096);
      expect(h.length).toBeLessThan(PAYMENT_REQUIRED_HEADER_SOFT_LIMIT);
      const pr = decodeB64Json(h);
      expect(pr.accepts.length).toBeGreaterThan(0);
      for (const a of pr.accepts) expect(a.payTo).toBe(PAY_TO);
      const iou = pr.accepts.find((a: any) => a.asset !== "XRP");
      if (iou) expect(Number(iou.amount)).toBeCloseTo(0.0005 * n, 8);
    }
    expect(lookups).toBe(0);
    expect((await s.get("/v1/fleet/check")).status).toBe(400);
  });
});

describe("fleet guard: paid path", () => {
  it("settles before serving, answers membership, keeps payer data out of body, header, logs and sales", async () => {
    const s = setup();
    await loadFleet(s);
    const { res } = await pay(s, `/v1/fleet/check?subject=${FLEET_PAYER},${FLEET_SELLER},${CLEAN}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const b = JSON.parse(text);
    expect(b.results.map((r: any) => r.fleet_member)).toEqual([true, true, false]);
    expect(b.results[0].role).toBe("payer");
    expect(b.results[1].cluster.id).toBe("F1");
    expect(b.access).toMatchObject({ mode: "x402", charged: true, price_usd: "0.0015" });
    expect(Date.parse(b.valid_until) - Date.parse(b.as_of)).toBe(3600_000);
    expect(text).not.toContain(PAYER);
    expect(text).not.toContain(FLEET_PAYER);
    const prh = res.headers.get("PAYMENT-RESPONSE");
    expect(prh && JSON.stringify(decodeB64Json(prh))).not.toContain(PAYER);
    expect(JSON.stringify(s.logs)).not.toContain(PAYER);
    expect(s.sales.rows.length).toBe(1);
    expect(JSON.stringify(s.sales.rows)).not.toContain(PAYER);
    expect(s.fac.calls.filter((c) => c.path === "/settle").length).toBe(1);
    // Members are stored as HMACs only.
    expect(JSON.stringify([...s.store.memberMap.entries()])).not.toContain(FLEET_PAYER);
    expect(JSON.stringify([...s.store.settles.entries()])).not.toContain(PAYER);
  });

  it("binds a long batch by query hash: paying it for a different batch is refused", async () => {
    const s = setup();
    const mk = (t: string) => Array.from({ length: 20 }, (_, i) => `${t.repeat(60)}.${"y".repeat(48)}-${String(i).padStart(2, "0")}.example`).join(",");
    const q: any = await (await s.get(`/v1/fleet/check?subject=${mk("a")}`)).json();
    expect(q.resource.url).toContain("qh=");
    const other = await s.get(`/v1/fleet/check?subject=${mk("b")}`, { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts[0]) });
    expect(other.status).toBe(402);
    expect(s.fac.calls.length).toBe(0);
    const ok = await s.get(`/v1/fleet/check?subject=${mk("a")}`, { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts[0]) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).count).toBe(20);
  });

  it("refuses a replayed payment header (invoice claimed once, settled once)", async () => {
    const s = setup();
    const path = `/v1/fleet/check?subject=${CLEAN}`;
    const { accepted, res } = await pay(s, path);
    expect(res.status).toBe(200);
    const again = await s.get(path, { "PAYMENT-SIGNATURE": paymentHeaderFor(accepted) });
    expect(again.status).toBe(402);
    expect(((await again.json()) as any).error).toBe("invoice_already_used");
    expect(s.fac.calls.filter((c) => c.path === "/settle").length).toBe(1);
  });

  it("refuses a second answer for an already-recorded tx hash and raises an alert", async () => {
    const s = setup(); // happyFacilitator returns the same tx hash for every settle
    const path = `/v1/fleet/check?subject=${CLEAN}`;
    expect((await pay(s, path)).res.status).toBe(200);
    const second = await pay(s, path);
    expect(second.res.status).toBe(409);
    expect(s.logs.some((e) => e.event === "fleet_guard_alert" && e.kind === "replay")).toBe(true);
  });

  it("does not serve a cached answer without payment", async () => {
    const s = setup();
    await loadFleet(s);
    const path = `/v1/fleet/check?subject=${FLEET_SELLER}`;
    expect((await pay(s, path)).res.status).toBe(200);
    let lookups = 0;
    const orig = s.store.members.bind(s.store);
    s.store.members = async (h) => { lookups++; return orig(h); };
    const unpaid = await s.get(path);
    expect(unpaid.status).toBe(402);
    expect(await unpaid.text()).not.toContain("fleet_member");
  });

  it("rejects a payment that does not match the server-set requirements", async () => {
    const s = setup();
    const path = `/v1/fleet/check?subject=${CLEAN}`;
    const q: any = await (await s.get(path)).json();
    const tampered = { ...q.accepts[0], payTo: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe" };
    const r = await s.get(path, { "PAYMENT-SIGNATURE": paymentHeaderFor(tampered) });
    expect(r.status).toBe(402);
    expect(((await r.json()) as any).error).toBe("payment_requirements_mismatch");
    const cheap = { ...q.accepts[0], amount: q.accepts[0].asset === "XRP" ? "1" : "0.0001" };
    expect(((await (await s.get(path, { "PAYMENT-SIGNATURE": paymentHeaderFor(cheap) })).json()) as any).error).toBe("payment_requirements_mismatch");
    expect(s.fac.calls.length).toBe(0);
  });

  it("rate-limits the paid path before any verify", async () => {
    const deny: QuotaCounter = { take: async () => ({ allowed: false, counts: [], blocked: 0 }) };
    const s = setup({ counter: deny });
    const r = await s.get(`/v1/fleet/check?subject=${CLEAN}`);
    expect(r.status).toBe(429);
    expect(s.fac.calls.length).toBe(0);
  });
});

describe("fleet guard: packs and plans", () => {
  it("sells a $4 pack of 10k credits tied to one payment; credits decrement atomically under concurrency", async () => {
    const s = setup();
    const q: any = await (await s.get("/v1/fleet/pack")).json();
    const iou = q.accepts.find((a: any) => a.asset !== "XRP");
    if (iou) expect(iou.amount).toBe("4");
    const { res } = await pay(s, "/v1/fleet/pack", { "Idempotency-Key": "pack-buy-0000000001" });
    expect(res.status).toBe(200);
    const k: any = await res.json();
    expect(k.key).toMatch(/^fgk_[0-9a-f]{40}$/);
    expect(k.calls).toBe(FLEET_GUARD.pack.calls);
    expect(JSON.stringify([...s.store.keys.values()])).not.toContain(k.key);
    // Shrink the pack to 3 credits and fire 6 concurrent calls: exactly 3 are served.
    const row = [...s.store.keys.values()][0];
    row.calls = 3;
    const rs = await Promise.all(Array.from({ length: 6 }, () => s.get(`/v1/fleet/check?subject=${CLEAN}`, { "X-Lumi-Fleet-Key": k.key })));
    expect(rs.filter((r) => r.status === 200).length).toBe(3);
    expect(rs.filter((r) => r.status === 402).length).toBe(3);
    expect(row.used).toBe(3);
    const info: any = await (await s.get("/v1/fleet/key", { "X-Lumi-Fleet-Key": k.key })).json();
    expect(info.remaining).toBe(0);
  });

  it("a batch consumes one credit per subject and refuses when not enough remain", async () => {
    const store = new MemoryFleetGuardStore();
    const s = setup({ store });
    const k: any = await (await pay(s, "/v1/fleet/pack")).res.json();
    [...store.keys.values()][0].calls = 2;
    expect((await s.get(`/v1/fleet/check?subject=a.example,b.example,c.example`, { "X-Lumi-Fleet-Key": k.key })).status).toBe(402);
    expect((await s.get(`/v1/fleet/check?subject=a.example,b.example`, { "X-Lumi-Fleet-Key": k.key })).status).toBe(200);
  });

  it("never mints two keys from one settled tx", async () => {
    const s = setup();
    expect((await pay(s, "/v1/fleet/pack")).res.status).toBe(200);
    const again = await pay(s, "/v1/fleet/pack"); // fresh invoice, same tx from the fake facilitator
    expect(again.res.status).toBe(409);
    expect(s.store.keys.size).toBe(1);
  });

  it("idempotent pack retry returns the same key without settling again", async () => {
    const s = setup();
    const q: any = await (await s.get("/v1/fleet/pack")).json();
    const h = { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts[0]), "Idempotency-Key": "pack-buy-0000000002" };
    const a: any = await (await s.get("/v1/fleet/pack", h)).json();
    const b: any = await (await s.get("/v1/fleet/pack", h)).json();
    expect(b.key).toBe(a.key);
    expect(s.fac.calls.filter((c) => c.path === "/settle").length).toBe(1);
  });

  it("monthly plan is off by default and $49 when switched on", async () => {
    expect((await setup().get("/v1/fleet/plan/monthly")).status).toBe(404);
    const s = setup({ env: { FLEET_GUARD_MONTHLY: "on" } });
    const r = await s.get("/v1/fleet/plan/monthly");
    expect(r.status).toBe(402);
    const iou = ((await r.json()) as any).accepts.find((a: any) => a.asset !== "XRP");
    if (iou) expect(iou.amount).toBe("49");
  });
});

describe("fleet guard: free checks", () => {
  it("caps per IP and per hashed wallet; a fresh wallet from the same IP gets nothing new", async () => {
    const s = setup();
    const ip = (n: number) => ({ "CF-Connecting-IP": `203.0.113.${n}` });
    let served = 0;
    for (let i = 0; i < 15; i++) {
      // Spread over minutes is not possible with a fixed clock: per-minute cap (5) bites first, so use distinct IPs per 5.
      const r = await s.get(`/v1/fleet/check/free?subject=${CLEAN}`, { ...ip(1), "X-Lumi-Wallet": `rWallet${i}` });
      if (r.status === 200) served++;
    }
    expect(served).toBe(FLEET_GUARD.free.perIpMinute);
    // Same wallet from many IPs is capped per wallet per day.
    let w = 0;
    for (let i = 0; i < 15; i++) if ((await s.get(`/v1/fleet/check/free?subject=${CLEAN}`, { ...ip(10 + i), "X-Lumi-Wallet": "rSameWallet" })).status === 200) w++;
    expect(w).toBe(FLEET_GUARD.free.perWalletDay);
    expect((await s.get(`/v1/fleet/check/free?subject=a.example,b.example`, ip(99))).status).toBe(400);
  });

  it("fails closed when the counter is unavailable", async () => {
    const broken: QuotaCounter = { take: async () => { throw new Error("DO down"); } };
    const s = setup({ counter: broken });
    expect((await s.get(`/v1/fleet/check/free?subject=${CLEAN}`)).status).toBe(429);
  });
});

describe("fleet guard: admin", () => {
  it("is owner-only", async () => {
    const s = setup();
    const r = await s.app.fetch(new Request(BASE + "/v1/fleet/admin/members", { method: "POST", body: "{}" }));
    expect(r.status).toBe(401);
  });
});

// keep jsonResponse import used for custom facilitators in future cases
void jsonResponse;
