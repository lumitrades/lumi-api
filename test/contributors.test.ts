import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { generateSeed, deriveKeypair, deriveAddress, sign } from "ripple-keypairs";
import { ed25519 } from "@noble/curves/ed25519";
import { createApp } from "../src/app";
import { MemoryContributorStore, D1ContributorStore, contribBudgetKey, cmpVersion, cleanMetrics, disputeMessage } from "../src/trust/contributors";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { MemoryReceiptStore } from "../src/trust/receipts";
import { sha256Hex, utf8Hex } from "../src/trust/verify";
import { VENDORS } from "../src/vendors";
// @ts-ignore plain-JS kit (packages/scanner-kit): the same code contributors run
import * as kit from "../packages/scanner-kit/src/index.js";
import { NOW, PAY_TO, FACILITATOR, DATA } from "./helpers";

const OWNER = "o".repeat(52);
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: OWNER };
const BASE = "https://api.test";
const V = VENDORS.find((v) => v.pay_to.xrpl.length && v.endpoints.length)!;
const EP = V.endpoints[0].url;
const VPAY = V.pay_to.xrpl[0];
const V2 = VENDORS.find((v) => v.id !== V.id && v.pay_to.xrpl.length && v.endpoints.length)!;

interface Wallet { seed: string; address: string; publicKey: string; privateKey: string }
const wallet = (n: number): Wallet => { const seed = generateSeed({ entropy: new Uint8Array(16).fill(n) }); const k = deriveKeypair(seed); return { seed, ...k, address: deriveAddress(k.publicKey) }; };
const ckey = (n: number) => { const priv = new Uint8Array(32).fill(n); return { priv: Buffer.from(priv).toString("hex"), pub: Buffer.from(ed25519.getPublicKey(priv)).toString("hex") }; };
const txh = (n: number) => n.toString(16).toUpperCase().padStart(64, "0");

/** Fake XRPL RPC: tx hash -> payment on mainnet. */
function ledger() {
  const txs = new Map<string, { from: string; to: string; value: string; ts: number }>();
  let down = false;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("xrplcluster") || u.includes("ripple.com")) {
      if (down) return new Response("busy", { status: 503 });
      const b = JSON.parse(String(init?.body ?? "{}"));
      if (b.method === "tx") {
        const t = txs.get(b.params[0].transaction);
        if (!t) return Response.json({ result: { error: "txnNotFound" } });
        return Response.json({ result: { validated: true, hash: b.params[0].transaction, close_time_iso: new Date(t.ts).toISOString(), tx_json: { TransactionType: "Payment", Account: t.from, Destination: t.to, SigningPubKey: "" }, meta: { TransactionResult: "tesSUCCESS", delivered_amount: { currency: "524C555344000000000000000000000000000000", issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", value: t.value } } } });
      }
      if (b.method === "account_tx") return Response.json({ result: { transactions: [] } });
      return Response.json({ result: { error: "unknown" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { f, txs, setDown: (v: boolean) => (down = v) };
}

function setup(o: { contribQueue?: any; env?: Record<string, string>; store?: any } = {}) {
  const L = ledger();
  const store = o.store ?? new MemoryContributorStore();
  const catalogStore = new MemoryCatalogStore();
  const receiptStore = new MemoryReceiptStore();
  const app = createApp({ ...ENV, ...(o.env ?? {}) } as any, { fetch: L.f, now: () => NOW, contributorStore: store, catalogStore, receiptStore, contribQueue: o.contribQueue ?? null });
  const owner = (method: string, path: string, body?: unknown) =>
    app.fetch(new Request(BASE + path, { method, headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  async function issue(n: number, wallets: Wallet[], extra: Record<string, unknown> = {}) {
    const k = ckey(n);
    const res = await owner("POST", "/v1/owner/contributors", { label: `c${n}`, public_key: k.pub, wallets: wallets.map((w) => w.address), ...extra });
    const j: any = await res.json();
    expect(res.status, JSON.stringify(j)).toBe(201);
    return { ...k, key_id: j.key_id as string, wallets };
  }
  const signed = (k: { priv: string; key_id: string }, method: string, path: string, body?: unknown, h: Record<string, string> = {}) => {
    const raw = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    const s = kit.signRequest(k.priv, method, path, raw, String(NOW));
    return app.fetch(new Request(BASE + path, { method, headers: { "Lumi-Contributor-Key": k.key_id, "Lumi-Timestamp": s.ts, "Lumi-Signature": s.signature, "Lumi-Kit": kit.kitHeader(), "Content-Type": "application/json", ...h }, body: raw || undefined }));
  };
  /** Kit-built, wallet-signed receipt for a payment that exists on the fake ledger. */
  async function receipt(w: Wallet, n: number, o2: { endpoint?: string; payTo?: string; value?: string; outcome?: string; status?: number; mode?: string; onLedger?: boolean; ts?: number } = {}) {
    const ts = o2.ts ?? NOW - 600_000, value = o2.value ?? "0.001", payTo = o2.payTo ?? VPAY;
    if (o2.onLedger !== false) L.txs.set(txh(n), { from: w.address, to: payTo, value, ts });
    const signer = await kit.signerFor("xrpl:0", w.seed);
    return kit.reportPurchase({
      endpoint: o2.endpoint ?? EP, network: "xrpl:0", tx_hash: txh(n), http_status: o2.status ?? 200, outcome: o2.outcome ?? "delivered", mode: o2.mode ?? "passive", signer,
      measurements: { latency_ms: 420, http_status: 200, response_bytes: 1234, response_sha256: "a".repeat(64), schema_fingerprint: "b".repeat(32), freshness_s: 30, facilitator: "t54", settlement_ms: 2100, junk: "x".repeat(5000) },
      ledger: { payer: w.address, pay_to: payTo, amount: value, asset: "RLUSD", issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", ts, ledger_result: "tesSUCCESS" },
    });
  }
  const submit = async (k: any, r: any, mode = r.x_lumi_contrib.mode) => { const res = await signed(k, "POST", "/v1/contrib/submissions", { mode, receipt: r }); return { status: res.status, j: (await res.json()) as any }; };
  return { app, store, L, owner, issue, signed, receipt, submit, catalogStore, receiptStore };
}

describe("contributor keys (owner only)", () => {
  it("issue, list and revoke need the owner key; revocation is instant", async () => {
    const s = setup();
    const k = ckey(1);
    const anon = await s.app.fetch(new Request(BASE + "/v1/owner/contributors", { method: "POST", body: JSON.stringify({ label: "x", public_key: k.pub, wallets: [wallet(1).address] }) }));
    expect(anon.status).toBe(401);
    expect((await s.app.fetch(new Request(BASE + "/v1/owner/contributors"))).status).toBe(401);
    const c = await s.issue(1, [wallet(1)]);
    expect(c.key_id).toMatch(/^lck_[0-9a-f]{16}$/);
    const list: any = await (await s.owner("GET", "/v1/owner/contributors")).json();
    expect(list.keys).toHaveLength(1);
    expect(list.keys[0].credits_state).toBe("disabled"); // Lumi Check: credits off by default
    expect(JSON.stringify(list)).not.toContain(c.priv);
    expect((await s.signed(c, "GET", "/v1/contrib/me")).status).toBe(200);
    expect((await s.owner("POST", `/v1/owner/contributors/${c.key_id}/revoke`, { reason: "test" })).status).toBe(200);
    const after = await s.signed(c, "GET", "/v1/contrib/me");
    expect(after.status).toBe(403);
    expect(((await after.json()) as any).error).toBe("key_revoked");
  });

  it("a wallet can belong to one active key; bad keys and wallets are refused", async () => {
    const s = setup();
    await s.issue(1, [wallet(1)]);
    const r = await s.owner("POST", "/v1/owner/contributors", { label: "dup", public_key: ckey(2).pub, wallets: [wallet(1).address] });
    expect(r.status).toBe(409);
    expect((await s.owner("POST", "/v1/owner/contributors", { label: "x", public_key: "zz", wallets: [wallet(3).address] })).status).toBe(400);
    expect((await s.owner("POST", "/v1/owner/contributors", { label: "x", public_key: ckey(3).pub, wallets: ["nope"] })).status).toBe(400);
  });
});

describe("signed submissions", () => {
  it("passive receipt from the kit: verified on-ledger, extra fields stored, credits weighted (XRPL + wanted) when credits are re-enabled", async () => {
    const s = setup({ env: { CONTRIB_CREDITS_ENABLED: "true" } });
    const w = wallet(1);
    const c = await s.issue(1, [w]);
    const r = await s.receipt(w, 1);
    const { status, j } = await s.submit(c, r);
    expect(status, JSON.stringify(j)).toBe(202);
    expect(j.finding).toBe("counted");
    expect(j.credit_uusd).toBe(20_000 * 1.5 * 2); // base x XRPL x wanted
    const row = await s.store.byTx(txh(1));
    expect(row.kit_version).toBe(kit.KIT_VERSION);
    const m = JSON.parse(row.metrics);
    expect(m).toMatchObject({ latency_ms: 420, response_bytes: 1234, schema_fingerprint: "b".repeat(32), facilitator: "t54", settlement_ms: 2100, freshness_s: 30 });
    expect(m.junk).toBeUndefined();
    expect(s.store.meta.get(contribBudgetKey(NOW))).toBe("3");
    // own submissions come back via /v1/contrib/me
    const me: any = await (await s.signed(c, "GET", "/v1/contrib/me")).json();
    expect(me.submissions).toHaveLength(1);
    expect(me.submissions[0].metrics.response_sha256).toBe("a".repeat(64));
  });

  it("rejects bad signatures, stale timestamps, unknown keys, retired kits and other wallets", async () => {
    const s = setup({ env: { CONTRIB_KIT_RETIRED: kit.KIT_VERSION } });
    const w = wallet(1);
    const c = await s.issue(1, [w]);
    expect((await s.signed(c, "GET", "/v1/contrib/wanted")).status).toBe(426); // retired kit version
    const s2 = setup();
    const c2 = await s2.issue(1, [w]);
    expect((await s2.signed({ ...c2, priv: ckey(9).priv }, "GET", "/v1/contrib/wanted")).status).toBe(401);
    expect((await s2.signed(c2, "GET", "/v1/contrib/wanted", undefined, { "Lumi-Timestamp": String(NOW - 10 * 60_000) })).status).toBe(401);
    expect((await s2.signed({ ...c2, key_id: "lck_" + "0".repeat(16) }, "GET", "/v1/contrib/wanted")).status).toBe(401);
    const other = wallet(2);
    const r = await s2.receipt(other, 2);
    expect((await s2.submit(c2, r)).j.error).toBe("payer_not_registered_to_key");
    const t = structuredClone(await s2.receipt(w, 3)); t.delivery.outcome = "no_data";
    expect((await s2.submit(c2, t)).j.error).toBe("receipt_invalid");
  });

  it("rejects self-testing: own pay_to, own domain, Lumi's own endpoints", async () => {
    const s = setup();
    const w = wallet(1), seller = wallet(5);
    const c = await s.issue(1, [w, seller], { own_domains: ["myshop.example"] });
    expect((await s.submit(c, await s.receipt(w, 10, { payTo: seller.address }))).j).toMatchObject({ error: "self_testing", reason: "self_test_pay_to" });
    expect((await s.submit(c, await s.receipt(w, 11, { endpoint: "https://api.myshop.example/data", payTo: wallet(6).address }))).j).toMatchObject({ error: "self_testing", reason: "self_test_domain" });
    expect((await s.submit(c, await s.receipt(w, 12, { endpoint: "https://api.lumitrades.io/v1/brief", payTo: wallet(6).address }))).j).toMatchObject({ error: "self_testing", reason: "lumi_endpoint" });
    expect((await s.submit(c, await s.receipt(w, 13, { payTo: PAY_TO }))).j.reason).toBe("lumi_endpoint");
  });

  it("duplicates, Lumi's own buys, per-key/endpoint caps and the on-ledger check", async () => {
    const s = setup();
    const w = wallet(1);
    const c = await s.issue(1, [w]);
    const r = await s.receipt(w, 20);
    expect((await s.submit(c, r)).status).toBe(202);
    expect((await s.submit(c, r)).j.error).toBe("duplicate");
    expect((await s.submit(c, await s.receipt(w, 21))).j.error).toBe("key_endpoint_daily_cap");
    s.receiptStore.buys = [{ tx_hash: txh(22) } as any];
    expect((await s.submit(c, await s.receipt(w, 22, { endpoint: V2.endpoints[0].url, payTo: V2.pay_to.xrpl[0] }))).j.error).toBe("already_recorded_by_lumi");
    expect((await s.submit(c, await s.receipt(w, 23, { endpoint: V2.endpoints[0].url, payTo: V2.pay_to.xrpl[0], onLedger: false }))).j.error).toBe("ledger_tx_not_found");
    const r24 = await s.receipt(w, 24, { endpoint: V2.endpoints[0].url, payTo: V2.pay_to.xrpl[0] });
    s.L.txs.get(txh(24))!.value = "0.5";
    expect((await s.submit(c, r24)).j.error).toBe("ledger_amount_mismatch");
    s.L.setDown(true);
    const d = await s.submit(c, await s.receipt(w, 25, { endpoint: V2.endpoints[0].url, payTo: V2.pay_to.xrpl[0] }));
    expect(d.status).toBe(503);
    expect(d.j.retryable).toBe(true);
    // rejected submissions wrote nothing
    expect(s.store.subs.size).toBe(1);
  });

  it("per-endpoint caps count funding sources, not wallets", async () => {
    const s = setup();
    const hub = wallet(40).address;
    const ks = [];
    for (let i = 1; i <= 3; i++) ks.push(await s.issue(i, [wallet(i)], { funders: { [wallet(i).address]: hub } }));
    expect((await s.submit(ks[0], await s.receipt(wallet(1), 31))).status).toBe(202);
    const second = await s.submit(ks[1], await s.receipt(wallet(2), 32));
    expect(second.j.error).toBe("funding_source_endpoint_daily_cap");
    // independent sources are fine up to the per-endpoint source cap (3)
    const s2 = setup();
    const ks2 = [];
    for (let i = 1; i <= 4; i++) ks2.push(await s2.issue(i, [wallet(i)]));
    for (let i = 0; i < 3; i++) expect((await s2.submit(ks2[i], await s2.receipt(wallet(i + 1), 40 + i))).status).toBe(202);
    expect((await s2.submit(ks2[3], await s2.receipt(wallet(4), 43))).j.error).toBe("endpoint_daily_cap");
  });

  it("negative findings stay unconfirmed until an independent contributor confirms; same-source does not", async () => {
    const s = setup();
    const a = await s.issue(1, [wallet(1)]);
    const b = await s.issue(2, [wallet(2)]);
    const n1 = await s.submit(a, await s.receipt(wallet(1), 50, { outcome: "no_data" }));
    expect(n1.j.finding).toBe("unconfirmed");
    const n2 = await s.submit(b, await s.receipt(wallet(2), 51, { outcome: "error_status", status: 500 }));
    expect(n2.j.finding).toBe("confirmed");
    expect((await s.store.byTx(txh(50))).finding).toBe("confirmed");
    // shared funding source: no confirmation
    const s2 = setup();
    const hub = wallet(40).address;
    const c1 = await s2.issue(1, [wallet(1)], { funders: { [wallet(1).address]: hub } });
    const c2 = await s2.issue(2, [wallet(2)], { funders: { [wallet(2).address]: hub } });
    expect((await s2.submit(c1, await s2.receipt(wallet(1), 52, { outcome: "no_data" }))).j.finding).toBe("unconfirmed");
    expect((await s2.submit(c2, await s2.receipt(wallet(2), 53, { outcome: "no_data", endpoint: V2.endpoints[0].url, payTo: V2.pay_to.xrpl[0] }))).j.finding).toBe("unconfirmed");
    // inconclusive is never a negative
    const s3 = setup();
    const c3 = await s3.issue(1, [wallet(1)]);
    expect((await s3.submit(c3, await s3.receipt(wallet(1), 54, { outcome: "inconclusive", status: 0 }))).j.finding).toBe("counted");
  });

  it("sellers can dispute a contributed finding with their pay_to wallet; the owner resolves it", async () => {
    const s = setup();
    const seller = wallet(7);
    const a = await s.issue(1, [wallet(1)]);
    await s.submit(a, await s.receipt(wallet(1), 60, { outcome: "no_data", payTo: seller.address, endpoint: "https://seller.example/x" }));
    const reason = "We delivered; see logs.";
    const msg = disputeMessage(txh(60), await sha256Hex(reason));
    const bad = await s.app.fetch(new Request(BASE + "/v1/contrib/disputes", { method: "POST", body: JSON.stringify({ tx_hash: txh(60), reason, signer: { key_type: "ripple-keypairs", public_key: wallet(8).publicKey, signature: sign(utf8Hex(msg), wallet(8).privateKey) } }) }));
    expect(bad.status).toBe(401);
    const ok = await s.app.fetch(new Request(BASE + "/v1/contrib/disputes", { method: "POST", body: JSON.stringify({ tx_hash: txh(60), reason, signer: { key_type: "ripple-keypairs", public_key: seller.publicKey, signature: sign(utf8Hex(msg), seller.privateKey) } }) }));
    expect(ok.status).toBe(202);
    expect((await s.store.byTx(txh(60))).finding).toBe("disputed");
    const res = await s.owner("POST", `/v1/owner/contributors/findings/${txh(60)}`, { action: "uphold_dispute" });
    expect(((await res.json()) as any).finding).toBe("contradicted");
  });

  it("unlisted endpoints and repeats earn less; monthly cap; credits are not cash", async () => {
    const s = setup({ env: { CONTRIB_CREDITS_ENABLED: "true", CONTRIB_CREDITS: JSON.stringify({ monthly_cap_uusd: 40_000 }), CONTRIB_CAPS: JSON.stringify({ key_endpoint_daily: 5, source_endpoint_daily: 5 }) } });
    const a = await s.issue(1, [wallet(1)]);
    const u = await s.submit(a, await s.receipt(wallet(1), 70, { endpoint: "https://unknown.example/x", payTo: wallet(9).address }));
    expect(u.j).toMatchObject({ credit_uusd: 0, credit_note: "unlisted_endpoint" });
    expect(u.j.note).toMatch(/not cash/);
    const first = await s.submit(a, await s.receipt(wallet(1), 71));
    expect(first.j.credit_uusd).toBe(40_000); // 60k capped by the 40k monthly cap
    const rep = await s.submit(a, await s.receipt(wallet(1), 72));
    expect(rep.j.credit_uusd).toBe(0);
    expect(rep.j.credit_note).toContain("repeat");
  });

  it("anti-boost: an endpoint dominated by few funding sources is flagged and its findings held", async () => {
    const s = setup({ env: { CONTRIB_CAPS: JSON.stringify({ key_endpoint_daily: 9, source_endpoint_daily: 9, endpoint_daily_sources: 9, flag_min_receipts: 3 }) } });
    const hub = wallet(40).address;
    const ks = [];
    for (let i = 1; i <= 3; i++) ks.push(await s.issue(i, [wallet(i)], { funders: { [wallet(i).address]: hub } }));
    const out = [];
    for (let i = 0; i < 3; i++) out.push(await s.submit(ks[i], await s.receipt(wallet(i + 1), 80 + i)));
    expect(out.map((o) => o.status)).toEqual([202, 202, 202]);
    expect(out[2].j.finding).toBe("held");
    expect(out[2].j.endpoint_flag).toBe("few_funding_sources");
    const flags: any = await (await s.owner("GET", "/v1/owner/contributors/flags")).json();
    expect(flags.flags[0]).toMatchObject({ flag: "few_funding_sources", sources: 1 });
  });

  it("demand data: opt-in only, aggregate only, no key ids, >= 2 contributors per row", async () => {
    const s = setup();
    const a = await s.issue(1, [wallet(1)], { share_demand: true });
    const b = await s.issue(2, [wallet(2)]);
    await s.submit(a, await s.receipt(wallet(1), 90));
    await s.submit(b, await s.receipt(wallet(2), 91, { endpoint: V2.endpoints[0].url, payTo: V2.pay_to.xrpl[0] }));
    let d: any = await (await s.owner("GET", "/v1/owner/contributors/demand")).json();
    expect(d.rows).toEqual([]); // one opted-in contributor per domain: withheld
    expect((await s.signed(b, "POST", "/v1/contrib/me", { share_demand: true })).status).toBe(200);
    await s.submit(b, await s.receipt(wallet(2), 92));
    d = await (await s.owner("GET", "/v1/owner/contributors/demand")).json();
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0]).toMatchObject({ purchases: 2, contributors: 2 });
    expect(JSON.stringify(d)).not.toMatch(/lck_|r[1-9A-HJ-NP-Za-km-z]{24,}/);
  });

  it("wanted list is server-chosen, passive by default, and never lists the contributor's own endpoints", async () => {
    const s = setup();
    const own = wallet(60);
    const c = await s.issue(1, [wallet(1), own], { own_domains: [new URL(V2.endpoints[0].url).hostname] });
    const j: any = await (await s.signed(c, "GET", "/v1/contrib/wanted?limit=10")).json();
    expect(j.default_mode).toBe("passive");
    expect(j.wanted.length).toBeGreaterThan(0);
    expect(j.wanted.every((w: any) => new URL(w.url).hostname !== new URL(V2.endpoints[0].url).hostname)).toBe(true);
    expect(j.wanted[0].network).toBe("xrpl:0");
  });
});

describe("D1 write budget and queue", () => {
  it("contributions use their own daily budget and never touch the catalog writes counter", async () => {
    const s = setup({ env: { CONTRIB_CAPS: JSON.stringify({ write_budget_rows: 7 }) } });
    const a = await s.issue(1, [wallet(1)]);
    expect((await s.submit(a, await s.receipt(wallet(1), 100))).status).toBe(202);
    const r = await s.submit(a, await s.receipt(wallet(1), 101, { endpoint: V2.endpoints[0].url, payTo: V2.pay_to.xrpl[0] }));
    expect(r.status).toBe(503);
    expect(r.j.error).toBe("contrib_write_budget");
    expect(await s.catalogStore.getMeta("writes:" + new Date(NOW).toISOString().slice(0, 10))).toBeNull();
  });

  it("with the queue bound, writes are queued and flushed as one batch", async () => {
    const sent: any[] = [];
    const s = setup({ contribQueue: { send: async (b: unknown) => { sent.push(b); } } });
    const a = await s.issue(1, [wallet(1)]);
    const b = await s.issue(2, [wallet(2)]);
    const r1 = await s.submit(a, await s.receipt(wallet(1), 110));
    expect(r1.j.queued).toBe(true);
    expect(s.store.subs.size).toBe(0);
    expect((await s.submit(a, await s.receipt(wallet(1), 110))).j.error).toBe("duplicate"); // pending set
    await s.submit(b, await s.receipt(wallet(2), 111));
    const before = s.store.writes;
    const rows = await s.app.contribQueue(sent);
    expect(rows).toBe(2 * 3 + 1);
    expect(s.store.subs.size).toBe(2);
    expect(s.store.writes - before).toBe(7);
  });

  it("D1 store: migration 0015 applies and the batched SQL round-trips (miniflare)", async () => {
    const { Miniflare } = await import("miniflare");
    const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('') } }", d1Databases: ["DB"] });
    try {
      const db: any = await mf.getD1Database("DB");
      await db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);");
      const sql = ["0015_contributors.sql", "0016_contrib_retention.sql"].map((f) => readFileSync("migrations/" + f, "utf8")).join(";\n").replace(/--.*$/gm, "");
      for (const st of sql.split(";").map((x) => x.trim()).filter(Boolean)) await db.prepare(st).run();
      const store = new D1ContributorStore(db);
      const s = setup({ store });
      const a = await s.issue(1, [wallet(1)], { share_demand: true });
      expect((await s.submit(a, await s.receipt(wallet(1), 120))).status).toBe(202);
      expect((await s.submit(a, await s.receipt(wallet(1), 120))).j.error).toBe("duplicate");
      const row = await store.byTx(txh(120));
      expect(row?.finding).toBe("counted");
      expect(row?.demand_opt_in).toBe(true);
      expect(await store.getMeta(contribBudgetKey(NOW))).toBe("3");
      const c = await store.counts({ key_id: a.key_id, endpoint_key: row!.endpoint_key, source: row!.source, day: row!.day, since_recent: "2026-01-01", since_month: "2026-10-01", tx_hash: txh(120) });
      expect(c).toMatchObject({ key_day: 1, key_ep_day: 1, ep_day_sources: 1, dup: 1, month_credit: 0 }); // credits disabled by default
      expect(await store.purge("2099-01-01")).toBe(1);
      expect(await store.byTx(txh(120))).toBeNull();
      expect((await s.owner("POST", `/v1/owner/contributors/${a.key_id}/revoke`, { reason: "t", forfeit: true })).status).toBe(200);
      expect((await store.getKey(a.key_id))?.forfeited).toBe(true);
    } finally {
      await mf.dispose();
    }
  }, 30_000);
});

describe("helpers", () => {
  it("version compare and metric cleaning", () => {
    expect(cmpVersion("0.1.0", "0.1.0")).toBe(0);
    expect(cmpVersion("0.0.9", "0.1.0")).toBe(-1);
    expect(cmpVersion("1.0.0", "0.9.9")).toBe(1);
    expect(cleanMetrics({ latency_ms: -1, response_sha256: "nothex", quotes: new Array(20).fill({ network: "xrpl:0" }) })).toMatchObject({ latency_ms: undefined, response_sha256: undefined });
    expect((cleanMetrics({ quotes: new Array(20).fill({ network: "xrpl:0" }) }) as any).quotes).toHaveLength(6);
  });
});

describe("Lumi Check: rewards, privacy and integrity", () => {
  it("credits are off by default: no credit fields, rewards are badges + leaderboard", async () => {
    const s = setup();
    const a = await s.issue(1, [wallet(1)]);
    const { status, j } = await s.submit(a, await s.receipt(wallet(1), 300));
    expect(status, JSON.stringify(j)).toBe(202);
    expect(j.credit_uusd).toBeUndefined();
    expect(j.rewards).toBe("badges_and_leaderboard");
    expect(j.note).toMatch(/No cash/);
    expect((await s.store.byTx(txh(300))).credit_uusd).toBe(0);
    const me: any = await (await s.signed(a, "GET", "/v1/contrib/me")).json();
    expect(me.credits_month_usd).toBeUndefined();
    expect(me.badges).toContain("first_receipt");
    expect(me.leaderboard.rank).toBe(1);
  });

  it("leaderboard: verified receipts only, pseudonymous, one per endpoint per day, revoked keys drop off", async () => {
    const s = setup({ env: { CONTRIB_CAPS: JSON.stringify({ key_endpoint_daily: 5, source_endpoint_daily: 5, endpoint_daily_sources: 9 }) } });
    const a = await s.issue(1, [wallet(1)]);
    const b = await s.issue(2, [wallet(2)]);
    await s.submit(a, await s.receipt(wallet(1), 310));
    await s.submit(a, await s.receipt(wallet(1), 311)); // same endpoint, same day: counts once
    await s.submit(a, await s.receipt(wallet(1), 312, { endpoint: V2.endpoints[0].url, payTo: V2.pay_to.xrpl[0] }));
    await s.submit(b, await s.receipt(wallet(2), 313, { outcome: "no_data", status: 200 })); // unconfirmed negative: not verified
    const lb: any = await (await s.app.fetch(new Request(BASE + "/v1/contrib/leaderboard"))).json();
    expect(lb.rows).toHaveLength(1);
    expect(lb.rows[0]).toMatchObject({ rank: 1, verified_receipts: 2, endpoints: 2, badges: ["first_receipt"] });
    expect(lb.rows[0].handle).toMatch(/^contrib-[0-9a-f]{8}$/);
    expect(JSON.stringify(lb)).not.toContain(a.key_id);
    expect(JSON.stringify(lb)).not.toContain(wallet(1).address);
    expect(lb.note).toMatch(/No cash/);
    await s.owner("POST", `/v1/owner/contributors/${a.key_id}/revoke`, { reason: "t" });
    expect(((await (await s.app.fetch(new Request(BASE + "/v1/contrib/leaderboard"))).json()) as any).rows).toHaveLength(0);
  });

  it("query strings are stripped from stored endpoints and receipt copies, and cannot dodge per-endpoint caps", async () => {
    const s = setup({ env: { CONTRIB_CAPS: JSON.stringify({ key_endpoint_daily: 1 }) } });
    const a = await s.issue(1, [wallet(1)]);
    const r1 = await s.submit(a, await s.receipt(wallet(1), 320, { endpoint: EP + "?email=buyer@example.com" }));
    expect(r1.status, JSON.stringify(r1.j)).toBe(202);
    const row = await s.store.byTx(txh(320));
    expect(row.endpoint).not.toContain("?");
    expect(row.receipt).not.toContain("buyer@example.com");
    expect(JSON.parse(row.receipt).x_lumi_stored.redacted).toEqual(["seller.endpoint.query"]);
    const r2 = await s.submit(a, await s.receipt(wallet(1), 321, { endpoint: EP + "?v=2" }));
    expect(r2.j.error).toBe("key_endpoint_daily_cap");
  });

  it("scoped admin key: CONTRIB_ADMIN_KEY opens contributor admin, OWNER_MCP_KEY then does not", async () => {
    const ADMIN = "a".repeat(52);
    const s = setup({ env: { CONTRIB_ADMIN_KEY: ADMIN } });
    expect((await s.owner("GET", "/v1/owner/contributors")).status).toBe(401);
    const r = await s.app.fetch(new Request(BASE + "/v1/owner/contributors", { headers: { Authorization: `Bearer ${ADMIN}` } }));
    expect(r.status).toBe(200);
    // the contributor admin key is not an owner key elsewhere
    expect((await s.app.fetch(new Request(BASE + "/v1/owner/traffic", { headers: { Authorization: `Bearer ${ADMIN}` } }))).status).toBe(401);
  });

  it("owner purge enforces the 90-day retention", async () => {
    const s = setup();
    const a = await s.issue(1, [wallet(1)]);
    await s.submit(a, await s.receipt(wallet(1), 330));
    const old = { ...(await s.store.byTx(txh(330))), tx_hash: "OLD".padEnd(64, "0"), day: "2026-01-01" };
    s.store.subs.set(old.tx_hash, old);
    const res: any = await (await s.owner("POST", "/v1/owner/contributors/purge")).json();
    expect(res).toMatchObject({ retention_days: 90, deleted: 1 });
    expect(await s.store.byTx(old.tx_hash)).toBeNull();
    expect(await s.store.byTx(txh(330))).not.toBeNull();
  });

  it("tx hash case cannot create a duplicate", async () => {
    const { normTx } = await import("../src/trust/contributors");
    expect(normTx("eip155:8453", "0xABCdef")).toBe("0xabcdef");
    expect(normTx("xrpl:0", "abcdef")).toBe("ABCDEF");
    const s = setup();
    const a = await s.issue(1, [wallet(1)]);
    expect((await s.submit(a, await s.receipt(wallet(1), 340))).status).toBe(202);
    // same payment re-signed with the hash in lower case
    const r = await s.receipt(wallet(1), 340);
    const lower = await kit.signReceipt({ ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== "receipt_hash" && k !== "signer")), payment: { ...r.payment, tx_hash: r.payment.tx_hash.toLowerCase() } }, await kit.signerFor("xrpl:0", wallet(1).seed));
    const d = await s.submit(a, lower);
    expect(d.status).toBe(409);
  });
});
