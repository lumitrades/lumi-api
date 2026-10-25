import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { generateSeed, deriveKeypair, deriveAddress, sign } from "ripple-keypairs";
import { ed25519 } from "@noble/curves/ed25519";
import { createApp } from "../src/app";
import { MemoryContributorStore, D1ContributorStore, contribBudgetKey, cmpVersion, cleanMetrics, disputeMessage, verifyWalletProof, walletProofMessage, fundingOf } from "../src/trust/contributors";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { MemoryReceiptStore } from "../src/trust/receipts";
import { sha256Hex, utf8Hex } from "../src/trust/verify";
import { VENDORS } from "../src/vendors";
// @ts-ignore plain-JS kit (packages/scanner-kit): the same code contributors run
import * as kit from "../packages/scanner-kit/src/index.js";
import { NOW, PAY_TO, FACILITATOR, DATA, miniflareD1Options } from "./helpers";

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
const CONTRIB_MIGRATIONS = ["0016_contributors.sql", "0017_contrib_retention.sql", "0020_contrib_activity.sql", "0021_contrib_published.sql", "0022_contrib_antigaming.sql"];
/** Own badge view from /v1/contrib/me (badge only: no credits, rank or perks exist). */
const badgeOf = async (s: any, k: any) => ((await (await s.signed(k, "GET", "/v1/contrib/me")).json()) as any).badge;
/** Every contributor with at least one verified contribution (server-side table; there is no public ranking). */
const board = async (s: any) => s.app.contributors.badgeTable();

/** Fake XRPL RPC: tx hash -> payment on mainnet. */
function ledger() {
  const txs = new Map<string, { from: string; to: string; value: string; ts: number }>();
  let down = false;
  const funders = new Map<string, string>(), fundingCalls = new Map<string, number>();
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
      if (b.method === "account_tx") {
        const acct = b.params[0].account; fundingCalls.set(acct, (fundingCalls.get(acct) ?? 0) + 1);
        const fu = funders.get(acct);
        return Response.json({ result: { transactions: fu ? [{ close_time_iso: new Date(NOW - 90 * 86_400_000).toISOString(), tx_json: { TransactionType: "Payment", Account: fu, Destination: acct } }] : [] } });
      }
      return Response.json({ result: { error: "unknown" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { f, txs, funders, fundingCalls, setDown: (v: boolean) => (down = v) };
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
    const wallet_proofs: Record<string, unknown> = {};
    for (const w of wallets) if (w.seed) wallet_proofs[w.address] = await kit.walletProof(await kit.signerFor("xrpl:0", w.seed), k.pub);
    const res = await owner("POST", "/v1/owner/contributors", { label: `c${n}`, public_key: k.pub, wallets: wallets.map((w) => w.address), wallet_proofs, ...extra });
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
    expect(list.keys[0]).toMatchObject({ submissions: 0, badge_removed: false });
    expect(list.rules.rewards).toBe("badge_only");
    expect(JSON.stringify(list)).not.toMatch(/"[a-z_]*(credit|leaderboard|perk)[a-z_]*"\s*:/i); // no such fields
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
  it("passive receipt from the kit: payment block is chain + tx hash only, verified on-ledger, extra fields stored", async () => {
    const s = setup();
    const w = wallet(1);
    const c = await s.issue(1, [w]);
    const r = await s.receipt(w, 1);
    expect(r.payment).toEqual({ network: "xrpl:0", tx_hash: txh(1) });
    expect(r.x_lumi_contrib.measurements.quotes).toBeUndefined();
    const { status, j } = await s.submit(c, r);
    expect(status, JSON.stringify(j)).toBe(202);
    expect(j.finding).toBe("counted");
    expect(j.rewards).toBe("badge_only");
    expect(JSON.stringify(j)).not.toMatch(/"[a-z_]*(credit|leaderboard|perk)[a-z_]*"\s*:/i);
    const row = await s.store.byTx(txh(1));
    expect(row.amount).toBeUndefined();
    expect(row.asset).toBeUndefined();
    expect(row.kit_version).toBe(kit.KIT_VERSION);
    const m = JSON.parse(row.metrics);
    expect(m).toMatchObject({ latency_ms: 420, response_bytes: 1234, schema_fingerprint: "b".repeat(32), facilitator: "t54", settlement_ms: 2100, freshness_s: 30 });
    expect(m.junk).toBeUndefined();
    expect(s.store.meta.get(contribBudgetKey(NOW))).toBe("5"); // 4 for the submission + 1 activity touch (first today)
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
    expect((await s.submit(c, await s.receipt(w, 12, { endpoint: "https://api.lumitrades.io/v1/market", payTo: wallet(6).address }))).j).toMatchObject({ error: "self_testing", reason: "lumi_endpoint" });
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
    // the ledger must show the SIGNING wallet paying the seller
    const r24 = await s.receipt(w, 24, { endpoint: V2.endpoints[0].url, payTo: V2.pay_to.xrpl[0] });
    s.L.txs.get(txh(24))!.from = wallet(9).address;
    expect((await s.submit(c, r24)).j.error).toBe("ledger_no_transfer_from_signer_to_pay_to");
    const r26 = await s.receipt(w, 26, { endpoint: V2.endpoints[0].url, payTo: V2.pay_to.xrpl[0] });
    s.L.txs.get(txh(26))!.value = "0";
    expect((await s.submit(c, r26)).j.error).toMatch(/^ledger_(nothing_delivered|zero_amount)$/);
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

  it("receipts that carry an amount, asset or payer are refused; nothing about the payer or amount is shown back", async () => {
    const s = setup();
    const a = await s.issue(1, [wallet(1)]);
    const r: any = await s.receipt(wallet(1), 70);
    const { receipt_hash: _h, signer: _sg, ...body } = r;
    const fat = await kit.signReceipt({ ...body, payment: { ...body.payment, amount: "0.001", asset: "RLUSD", payer: wallet(1).address } }, await kit.signerFor("xrpl:0", wallet(1).seed));
    const bad = await s.submit(a, fat);
    expect(bad.status).toBe(422);
    expect(bad.j).toMatchObject({ error: "receipt_payment_fields_not_allowed", fields: ["amount", "asset", "payer"] });
    // price data hidden in measurements is refused too (the stored copy is the signed receipt)
    const priced = await kit.signReceipt({ ...body, x_lumi_contrib: { ...body.x_lumi_contrib, measurements: { latency_ms: 5, quotes: [{ amount: "0.001", pay_to: "rX" }] } } }, await kit.signerFor("xrpl:0", wallet(1).seed));
    const bad2 = await s.submit(a, priced);
    expect(bad2.status).toBe(422);
    expect(bad2.j).toMatchObject({ error: "receipt_payment_fields_not_allowed", fields: ["x_lumi_contrib.measurements.quotes"] });
    expect((await s.submit(a, r)).status).toBe(202);
    const me: any = await (await s.signed(a, "GET", "/v1/contrib/me")).json();
    expect(me.submissions[0]).not.toHaveProperty("amount");
    expect(me.submissions[0]).not.toHaveProperty("payer");
    const own: any = await (await s.owner("GET", `/v1/owner/contributors/${a.key_id}/submissions`)).json();
    expect(JSON.stringify(own)).not.toContain(wallet(1).address);
    expect(JSON.stringify(own)).not.toContain("0.001");
    const pub: any = await (await s.app.fetch(new Request(BASE + "/v1/contrib/badge/" + me.badge.handle))).json();
    expect(JSON.stringify(pub)).not.toContain(wallet(1).address);
    expect(JSON.stringify(pub)).not.toContain(txh(70));
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
    const s = setup({ env: { CONTRIB_CAPS: JSON.stringify({ write_budget_rows: 10 }) } });
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
    expect(rows).toBe(2 * 4 + 2 + 1); // 2 submissions + 2 activity touches + budget meta
    expect(s.store.subs.size).toBe(2);
    expect(s.store.writes - before).toBe(11);
  });

  it("D1 store: migration 0015 applies and the batched SQL round-trips (miniflare)", async () => {
    const { Miniflare, convertV4MiniflareOptions } = await import("miniflare") as any;
    const mf = new Miniflare(miniflareD1Options(convertV4MiniflareOptions));
    try {
      const db: any = await mf.getD1Database("DB");
      await db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);");
      const sql = CONTRIB_MIGRATIONS.map((f) => readFileSync("migrations/" + f, "utf8")).join(";\n").replace(/--.*$/gm, "");
      for (const st of sql.split(";").map((x) => x.trim()).filter(Boolean)) await db.prepare(st).run();
      const store = new D1ContributorStore(db);
      const s = setup({ store });
      const a = await s.issue(1, [wallet(1)], { share_demand: true });
      expect((await s.submit(a, await s.receipt(wallet(1), 120))).status).toBe(202);
      expect((await s.submit(a, await s.receipt(wallet(1), 120))).j.error).toBe("duplicate");
      const row = await store.byTx(txh(120));
      expect(row?.finding).toBe("counted");
      expect(row?.demand_opt_in).toBe(true);
      expect(await store.getMeta(contribBudgetKey(NOW))).toBe("5"); // + activity touch
      expect((await store.getKey(a.key_id))?.last_active_day).toBe(new Date(NOW).toISOString().slice(0, 10));
      const c = await store.counts({ key_id: a.key_id, endpoint_key: row!.endpoint_key, source: row!.source, day: row!.day, tx_hash: txh(120) });
      expect(c).toMatchObject({ key_day: 1, key_ep_day: 1, ep_day_sources: 1, dup: 1 });
      const cols = (await db.prepare("PRAGMA table_info(contributor_submissions)").all()).results.map((x: any) => x.name);
      expect(cols).not.toContain("amount");
      expect(cols).not.toContain("asset");
      expect(cols.filter((x: string) => x.startsWith("credit"))).toEqual([]);
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
    // prices, amounts and pay_to addresses are never kept from measurements
    expect((cleanMetrics({ quotes: [{ network: "xrpl:0", amount: "0.01", pay_to: "rX" }] }) as any).quotes).toBeUndefined();
  });
});

describe("Lumi Check: rewards, privacy and integrity", () => {
  it("rewards are badge-only: a public badge and a verified-contribution count, nothing of monetary value", async () => {
    const s = setup();
    const a = await s.issue(1, [wallet(1)]);
    const { status, j } = await s.submit(a, await s.receipt(wallet(1), 300));
    expect(status, JSON.stringify(j)).toBe(202);
    expect(j.rewards).toBe("badge_only");
    expect(j.note).toMatch(/nothing of monetary value/);
    const me: any = await (await s.signed(a, "GET", "/v1/contrib/me")).json();
    expect(me.rewards).toBe("badge_only");
    expect(me.badge).toMatchObject({ badges: ["first_receipt"], verified_contributions: 1 });
    expect(me.badge.handle).toMatch(/^contrib-[0-9a-f]{8}$/);
    expect(JSON.stringify(me)).not.toMatch(/"[a-z_]*(credit|leaderboard|rank|perk|early_access)[a-z_]*"\s*:/i);
  });

  it("public badge: verified receipts only, pseudonymous, one per endpoint per day, no ranking, revoked keys drop off", async () => {
    const s = setup({ env: { CONTRIB_CAPS: JSON.stringify({ key_endpoint_daily: 5, source_endpoint_daily: 5, endpoint_daily_sources: 9 }) } });
    const a = await s.issue(1, [wallet(1)]);
    const b = await s.issue(2, [wallet(2)]);
    await s.submit(a, await s.receipt(wallet(1), 310));
    await s.submit(a, await s.receipt(wallet(1), 311, { ts: NOW - 300_000 })); // same endpoint, same day: counts once
    await s.submit(a, await s.receipt(wallet(1), 312, { endpoint: V2.endpoints[0].url, payTo: V2.pay_to.xrpl[0] }));
    await s.submit(b, await s.receipt(wallet(2), 313, { outcome: "no_data", status: 200 })); // unconfirmed negative: not verified
    const handle = (await badgeOf(s, a)).handle;
    const res = await s.app.fetch(new Request(BASE + "/v1/contrib/badge/" + handle));
    expect(res.status).toBe(200);
    const pub: any = await res.json();
    expect(pub).toMatchObject({ kind: "contributor_badge", handle, badges: ["first_receipt"], verified_contributions: 2 });
    expect(pub.rank).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain(a.key_id);
    expect(JSON.stringify(pub)).not.toContain(wallet(1).address);
    expect((await badgeOf(s, b)).verified_contributions).toBe(0);
    expect((await s.app.fetch(new Request(BASE + "/v1/contrib/badge/" + (await badgeOf(s, b)).handle))).status).toBe(404);
    await s.owner("POST", `/v1/owner/contributors/${a.key_id}/revoke`, { reason: "t" });
    expect((await s.app.fetch(new Request(BASE + "/v1/contrib/badge/" + handle))).status).toBe(404);
  });

  it("query strings are stripped from stored endpoints and receipt copies, and cannot dodge per-endpoint caps", async () => {
    const s = setup({ env: { CONTRIB_CAPS: JSON.stringify({ key_endpoint_daily: 1 }) } });
    const a = await s.issue(1, [wallet(1)]);
    // The kit already keeps origin + path; simulate an older or third-party client that signs the full URL.
    const kitR: any = await s.receipt(wallet(1), 320, { endpoint: EP + "?email=buyer@example.com" });
    expect(kitR.seller.endpoint).toBe(EP);
    const { receipt_hash: _h, signer: _sg, ...body } = kitR;
    const raw = await kit.signReceipt({ ...body, seller: { ...body.seller, endpoint: EP + "?email=buyer@example.com" } }, await kit.signerFor("xrpl:0", wallet(1).seed));
    const r1 = await s.submit(a, raw);
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

describe("badge only: no credits, perks or rankings", () => {
  it("accounts are kept while active: receipts record activity; the inactive review is a non-destructive placeholder", async () => {
    const s = setup();
    const a = await s.issue(1, [wallet(1)]);
    const b = await s.issue(2, [wallet(2)]);
    await s.submit(a, await s.receipt(wallet(1), 480));
    const today = new Date(NOW).toISOString().slice(0, 10);
    expect((await s.store.getKey(a.key_id)).last_active_day).toBe(today);
    const kb = s.store.keys.get(b.key_id);
    kb.created_at = NOW - 400 * 86_400_000; kb.last_active_day = new Date(NOW - 366 * 86_400_000).toISOString().slice(0, 10);
    const old = { ...(await s.store.byTx(txh(480))), tx_hash: "OLDA".padEnd(64, "0"), day: "2025-01-01" };
    s.store.subs.set(old.tx_hash, old);
    const purge: any = await (await s.owner("POST", "/v1/owner/contributors/purge")).json();
    expect(purge.deleted).toBe(1);
    expect(await s.store.getKey(b.key_id)).not.toBeNull(); // the 90-day purge never removes accounts
    const r: any = await (await s.owner("GET", "/v1/owner/contributors/inactive")).json();
    expect(r).toMatchObject({ active_window_days: 365, total_keys: 2, active: 1, action: expect.stringContaining("nothing is deleted") });
    expect(r.inactive.map((x: any) => x.key_id)).toEqual([b.key_id]);
    expect((await s.store.getKey(b.key_id)).status).toBe("active"); // nothing revoked or deleted
    expect(s.store.keys.size).toBe(2);
    expect((await s.app.fetch(new Request(BASE + "/v1/owner/contributors/inactive"))).status).toBe(401);
  });

  it("no perks: contributors get the same /v1/check limit as everyone; credit, bounty and leaderboard routes do not exist", async () => {
    const s = setup();
    const a = await s.issue(1, [wallet(1)]);
    await s.submit(a, await s.receipt(wallet(1), 430));
    const q = "/v1/check?url=" + encodeURIComponent("https://unknown.example/x");
    let anonLimited = false;
    for (let i = 0; i < 31; i++) if ((await s.app.fetch(new Request(BASE + q))).status === 429) anonLimited = true;
    expect(anonLimited).toBe(true);
    expect((await s.signed(a, "GET", q)).status).toBe(429); // a contributor signature changes nothing
    for (const [m, p] of [["GET", "/v1/contrib/credits"], ["POST", "/v1/contrib/credits/spend"]] as const) expect((await s.signed(a, m, p, m === "POST" ? { product: "trust_check" } : undefined)).status).toBe(404);
    for (const p of ["/v1/contrib/bounties", "/v1/contrib/leaderboard"]) expect((await s.app.fetch(new Request(BASE + p))).status).toBe(401);
    expect(s.app.contributors.rules.rewards).toBe("badge_only");
  });
});

describe("account deletion (contributor self-service + owner on email request)", () => {
  const lb = board;
  async function seeded(s: any) {
    const a = await s.issue(1, [wallet(1)], { share_demand: true, own_domains: ["mine.example"] });
    const b = await s.issue(2, [wallet(2)]);
    await s.submit(a, await s.receipt(wallet(1), 700));
    await s.submit(a, await s.receipt(wallet(1), 701, { endpoint: V2.endpoints[0].url, payTo: V2.pay_to.xrpl[0] }));
    await s.submit(b, await s.receipt(wallet(2), 702, { endpoint: V2.endpoints[0].url, payTo: V2.pay_to.xrpl[0] }));
    expect((await s.owner("POST", `/v1/owner/contributors/findings/${txh(701)}`, { action: "mark_published" })).status).toBe(200);
    return { a, b };
  }

  it("self-service: needs the signed key and a typed confirm; deletes profile, wallets, badge and unpublished rows; anonymises published ones", async () => {
    const s = setup();
    const { a, b } = await seeded(s);
    expect((await lb(s))).toHaveLength(2);
    // unsigned or wrong confirm: nothing happens
    expect((await s.app.fetch(new Request(BASE + "/v1/contrib/me", { method: "DELETE", body: JSON.stringify({ confirm: a.key_id }) }))).status).toBe(401);
    const bad = await s.signed(a, "DELETE", "/v1/contrib/me", { confirm: b.key_id });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBe("confirm_key_id_required");
    expect(s.store.subs.size).toBe(3);

    const res = await s.signed(a, "DELETE", "/v1/contrib/me", { confirm: a.key_id });
    const j: any = await res.json();
    expect(res.status, JSON.stringify(j)).toBe(200);
    expect(j).toMatchObject({ deleted: true, status: "deleted", submissions_deleted: 1, submissions_anonymised: 1, wallets_deleted: 1 });

    // profile gone: tombstone only
    const k = s.store.keys.get(a.key_id);
    expect(k).toMatchObject({ status: "deleted", label: "", public_key: "", wallets: [], own_domains: [], share_demand: false, last_active_day: null, revoke_reason: "deleted_by_contributor" });
    expect(await s.store.wallets([wallet(1).address])).toEqual([]);
    // unpublished row deleted; published row kept without any contributor link
    expect(s.store.subs.get(txh(700))).toBeUndefined();
    const kept: any = s.store.subs.get(txh(701));
    expect(kept).toMatchObject({ key_id: "deleted", payer: "", source: "", demand_opt_in: false, kit_version: null });
    expect(kept.published_at).toBe(NOW);
    const all = JSON.stringify([...s.store.subs.values()].filter((x: any) => x.key_id !== b.key_id)) + JSON.stringify([...s.store.keys.values()].filter((x: any) => x.key_id !== b.key_id));
    expect(all).not.toContain(wallet(1).address);
    expect(all).not.toContain(a.pub);
    expect(all).not.toContain("mine.example");
    const rc = JSON.parse(kept.receipt);
    expect(rc.signer).toBeUndefined();
    expect(rc.payment.payer).toBeUndefined();
    expect(rc.payment.tx_hash).toBe(txh(701));
    expect(rc.x_lumi_stored.anonymised_at).toBeTruthy();
    // badge gone, other contributor untouched
    const rows = await lb(s);
    expect(rows).toHaveLength(1);
    expect(s.store.subs.get(txh(702))?.key_id).toBe(b.key_id);
    // the key can never sign again
    const after = await s.signed(a, "GET", "/v1/contrib/me");
    expect(after.status).toBe(403);
    expect(((await after.json()) as any).error).toBe("key_deleted");
    // the wallet is free to register again under a new key
    await s.issue(3, [wallet(1)]);
  });

  it("owner route for email requests: by key id or wallet, needs confirm: true; unknown is 404", async () => {
    const s = setup();
    const { a, b } = await seeded(s);
    expect((await s.app.fetch(new Request(BASE + "/v1/owner/contributors/delete", { method: "POST", body: JSON.stringify({ key_id: a.key_id, confirm: true }) }))).status).toBe(401);
    expect((await s.owner("POST", "/v1/owner/contributors/delete", { key_id: a.key_id })).status).toBe(400);
    expect((await s.owner("POST", "/v1/owner/contributors/delete", { wallet: wallet(9).address, confirm: true })).status).toBe(404);
    const r = await s.owner("POST", "/v1/owner/contributors/delete", { wallet: wallet(1).address, confirm: true, request_ref: "email 2026-10-23" });
    const j: any = await r.json();
    expect(r.status).toBe(200);
    expect(j).toMatchObject({ deleted: true, submissions_deleted: 1, submissions_anonymised: 1, request_ref: "email 2026-10-23" });
    expect(s.store.keys.get(a.key_id)?.revoke_reason).toBe("deleted_by_owner");
    const r2: any = await (await s.owner("POST", "/v1/owner/contributors/delete", { key_id: b.key_id, confirm: true })).json();
    expect(r2).toMatchObject({ deleted: true, submissions_deleted: 1, submissions_anonymised: 0 });
    expect(await lb(s)).toEqual([]);
    expect([...s.store.subs.keys()]).toEqual([txh(701)]);
  });

  it("a queued submission accepted before deletion is dropped, not resurrected", async () => {
    const sent: any[] = [];
    const s = setup({ contribQueue: { send: async (x: unknown) => { sent.push(x); } } });
    const a = await s.issue(1, [wallet(1)]);
    expect((await s.submit(a, await s.receipt(wallet(1), 710))).j.queued).toBe(true);
    expect((await s.signed(a, "DELETE", "/v1/contrib/me", { confirm: a.key_id })).status).toBe(200);
    await s.app.contribQueue(sent);
    expect(s.store.subs.size).toBe(0);
    expect(s.store.keys.get(a.key_id)?.last_active_day).toBeNull();
  });

  it("D1 store: erase in one batch, published rows anonymised (miniflare)", async () => {
    const { Miniflare, convertV4MiniflareOptions } = await import("miniflare") as any;
    const mf = new Miniflare(miniflareD1Options(convertV4MiniflareOptions));
    try {
      const db: any = await mf.getD1Database("DB");
      await db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);");
      const sql = CONTRIB_MIGRATIONS.map((f) => readFileSync("migrations/" + f, "utf8")).join(";\n").replace(/--.*$/gm, "");
      for (const st of sql.split(";").map((x) => x.trim()).filter(Boolean)) await db.prepare(st).run();
      const store = new D1ContributorStore(db);
      const s = setup({ store });
      const { a, b } = await seeded(s);
      expect((await store.byTx(txh(701)))?.published_at).toBe(NOW);
      const j: any = await (await s.signed(a, "DELETE", "/v1/contrib/me", { confirm: a.key_id })).json();
      expect(j).toMatchObject({ deleted: true, submissions_deleted: 1, submissions_anonymised: 1, wallets_deleted: 1 });
      expect(await store.byTx(txh(700))).toBeNull();
      const kept = await store.byTx(txh(701));
      expect(kept).toMatchObject({ key_id: "deleted", payer: "", source: "" });
      expect(kept!.receipt).not.toContain(wallet(1).address);
      expect(await store.getKey(a.key_id)).toMatchObject({ status: "deleted", label: "", public_key: "", wallets: [], own_domains: [] });
      expect(await store.wallets([wallet(1).address])).toEqual([]);
      expect((await store.byTx(txh(702)))?.key_id).toBe(b.key_id);
      expect((await s.signed(a, "GET", "/v1/contrib/me")).status).toBe(403);
    } finally {
      await mf.dispose();
    }
  }, 30_000);
});

describe("score-gaming gaps: wallet proofs, funding clusters, seller-funded wallets, near-duplicates", () => {
  const loose = { CONTRIB_CAPS: JSON.stringify({ key_endpoint_daily: 9, source_endpoint_daily: 9, endpoint_daily_sources: 9 }) };

  it("(1) registration needs a wallet-control proof bound to the contributor key; fake or replayed proofs are refused", async () => {
    const s = setup();
    const k = ckey(1), w = wallet(1);
    const none = await s.owner("POST", "/v1/owner/contributors", { label: "x", public_key: k.pub, wallets: [w.address] });
    const j: any = await none.json();
    expect(none.status).toBe(400);
    expect(j).toMatchObject({ error: "wallet_proof_required", wallets: [{ address: w.address, message_to_sign: walletProofMessage(k.pub, w.address) }] });
    // a proof made for ANOTHER contributor key can't be replayed
    const other = await kit.walletProof(await kit.signerFor("xrpl:0", w.seed), ckey(2).pub);
    expect((await s.owner("POST", "/v1/owner/contributors", { label: "x", public_key: k.pub, wallets: [w.address], wallet_proofs: { [w.address]: other } })).status).toBe(400);
    // a proof signed by a different wallet's key is refused
    const wrong = await kit.walletProof(await kit.signerFor("xrpl:0", wallet(2).seed), k.pub);
    expect((await s.owner("POST", "/v1/owner/contributors", { label: "x", public_key: k.pub, wallets: [w.address], wallet_proofs: { [w.address]: wrong } })).status).toBe(400);
    // the real one works
    const good = await kit.walletProof(await kit.signerFor("xrpl:0", w.seed), k.pub);
    const ok = await s.owner("POST", "/v1/owner/contributors", { label: "x", public_key: k.pub, wallets: [w.address], wallet_proofs: { [w.address]: good } });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as any).funding[0].proven).toBe(true);
  });

  it("(1) proofs verify for EVM (EIP-191, any case) and Stellar (ed25519) wallets", async () => {
    const pk = ckey(5).pub;
    const evm = await kit.signerFor("eip155:8453", "0x" + "11".repeat(32));
    const ep = await kit.walletProof(evm, pk);
    expect(ep.address).toBe(evm.address.toLowerCase());
    expect(verifyWalletProof(pk, evm.address.toLowerCase(), ep)).toBe(true);
    expect(verifyWalletProof(ckey(6).pub, evm.address.toLowerCase(), ep)).toBe(false);
    const seed = new Uint8Array(32).fill(7);
    // @ts-ignore plain JS
    const { encodePublic } = await import("../packages/scanner-kit/src/strkey.js");
    const g = encodePublic(ed25519.getPublicKey(seed));
    const sig = Buffer.from(ed25519.sign(new TextEncoder().encode(walletProofMessage(pk, g)), seed)).toString("base64");
    expect(verifyWalletProof(pk, g, { key_type: "stellar-ed25519", signature: sig })).toBe(true);
    expect(verifyWalletProof(pk, g, { key_type: "eip191", signature: sig })).toBe(false);
    expect(verifyWalletProof(pk, g, null)).toBe(false);
  });

  it("(1) allow_unproven wallets get zero weight (no badge progress) until a proof is sent", async () => {
    const s = setup();
    const k = ckey(1), w = wallet(1);
    const res = await s.owner("POST", "/v1/owner/contributors", { label: "x", public_key: k.pub, wallets: [w.address], allow_unproven: true });
    const j: any = await res.json();
    expect(res.status).toBe(201);
    expect(j.unproven_wallets).toEqual([w.address]);
    const a = { ...k, key_id: j.key_id as string };
    const r = await s.submit(a, await s.receipt(w, 900));
    expect(r.status).toBe(202);
    expect(r.j).toMatchObject({ weight: 0, weight_note: "wallet_unproven", counts: false });
    expect((await badgeOf(s, a)).verified_contributions).toBe(0);
    expect(await board(s)).toHaveLength(0);
    // prove it later: wrong proof refused, right proof accepted, next receipt counts
    expect((await s.signed(a, "POST", "/v1/contrib/me/wallet-proof", await kit.walletProof(await kit.signerFor("xrpl:0", wallet(2).seed), k.pub))).status).toBe(403);
    const bad = { ...(await kit.walletProof(await kit.signerFor("xrpl:0", w.seed), ckey(9).pub)) };
    expect((await s.signed(a, "POST", "/v1/contrib/me/wallet-proof", bad)).status).toBe(401);
    const pr = await s.signed(a, "POST", "/v1/contrib/me/wallet-proof", await kit.walletProof(await kit.signerFor("xrpl:0", w.seed), k.pub));
    expect(pr.status).toBe(200);
    const r2 = await s.submit(a, await s.receipt(w, 901, { endpoint: V2.endpoints[0].url, payTo: V2.pay_to.xrpl[0] }));
    expect(r2.j.weight).toBe(1);
    expect((await badgeOf(s, a)).verified_contributions).toBe(1);
    expect(await board(s)).toHaveLength(1);
  });

  it("(2) Base first funder from the explorer: earliest inbound ETH or USDC transfer", async () => {
    const me = "0x" + "ab".repeat(20), early = "0x" + "01".repeat(20), late = "0x" + "02".repeat(20);
    const calls: string[] = [];
    const f = (async (u: string) => {
      calls.push(String(u));
      if (String(u).includes("action=txlist")) return Response.json({ status: "1", result: [
        { from: me, to: late, value: "5", timeStamp: "100", isError: "0" }, // outbound: ignored
        { from: late.toUpperCase().replace("0X", "0x"), to: me.toUpperCase().replace("0X", "0x"), value: "7", timeStamp: "300", isError: "0" },
      ] });
      return Response.json({ status: "1", result: [{ from: early, to: me, value: "1000", timeStamp: "200", contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }] });
    }) as any;
    expect(await fundingOf(f, { xrplRpc: [], stellarHorizon: "https://h", baseExplorer: "https://explorer.test/api" }, me)).toEqual({ funder: early, funded_at: 200_000 });
    expect(calls.every((u) => u.startsWith("https://explorer.test/api?module=account&"))).toBe(true);
    expect(calls.some((u) => u.includes("contractaddress=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"))).toBe(true);
    const down = (async () => new Response("challenge", { status: 403 })) as any;
    expect(await fundingOf(down, { xrplRpc: [], stellarHorizon: "https://h" }, me)).toEqual({ funder: null, funded_at: null });
  });

  it("(2) wallets sharing a funder form one cluster: one count per seller per day across keys; lookups are cached", async () => {
    const s = setup({ env: loose });
    const F = wallet(50).address;
    s.L.funders.set(wallet(1).address, F); s.L.funders.set(wallet(2).address, F);
    const a = await s.issue(1, [wallet(1)]);
    const b = await s.issue(2, [wallet(2)]);
    const cl: any = await (await s.owner("GET", "/v1/owner/contributors/clusters")).json();
    expect(cl.clusters).toEqual([{ source: F, keys: [a.key_id, b.key_id], wallets: [wallet(1).address, wallet(2).address] }]);
    expect((await s.submit(a, await s.receipt(wallet(1), 910))).j.weight).toBe(1);
    const sib = await s.submit(b, await s.receipt(wallet(2), 911, { endpoint: new URL(EP).origin + "/cluster-other" }));
    expect(sib.status).toBe(202);
    expect(sib.j).toMatchObject({ weight: 0, weight_note: "same_cluster" });
    expect((await badgeOf(s, a)).verified_contributions).toBe(1);
    expect((await badgeOf(s, b)).verified_contributions).toBe(0);
    expect((await board(s)).map((r: any) => r.verified)).toEqual([1]);
    // a different seller still counts for the sibling
    expect((await s.submit(b, await s.receipt(wallet(2), 912, { endpoint: V2.endpoints[0].url, payTo: V2.pay_to.xrpl[0] }))).j.weight).toBe(1);
    // seller pay_to funding looked up once, then served from the cache
    expect(s.L.fundingCalls.get(VPAY)).toBe(1);
    expect(s.store.funding.get(wallet(1).address)?.funder).toBe(F);
  });

  it("(2) a wallet funded by an already-registered wallet joins that wallet's cluster (one hop), and earlier wallets re-point", async () => {
    const s = setup({ env: loose });
    const a = await s.issue(1, [wallet(1)]);
    s.L.funders.set(wallet(2).address, wallet(1).address);
    const b = await s.issue(2, [wallet(2)]);
    expect((await s.store.wallets([wallet(2).address]))[0].source).toBe(wallet(1).address);
    // wallet(3) registered first with funder wallet(4); wallet(4) later registers funded by F: wallet(3) moves to F's cluster
    const F = wallet(60).address;
    s.L.funders.set(wallet(3).address, wallet(4).address);
    await s.issue(3, [wallet(3)]);
    s.L.funders.set(wallet(4).address, F);
    await s.issue(4, [wallet(4)]);
    expect((await s.store.wallets([wallet(3).address]))[0].source).toBe(F);
    expect(b.key_id).not.toBe(a.key_id);
  });

  it("(3) receipts from wallets funded by the seller's pay_to (or its funder) get zero weight; ignored funders don't link", async () => {
    const s = setup({ env: loose });
    s.L.funders.set(wallet(1).address, VPAY); // seller funded the buyer directly
    const a = await s.issue(1, [wallet(1)]);
    const r = await s.submit(a, await s.receipt(wallet(1), 920));
    expect(r.j).toMatchObject({ weight: 0, weight_note: "seller_funded" });
    expect((await badgeOf(s, a)).verified_contributions).toBe(0);
    expect(await board(s)).toHaveLength(0);
    // seller and buyer share a funder (the seller's cluster)
    const X = wallet(70).address;
    s.L.funders.set(V2.pay_to.xrpl[0], X); s.L.funders.set(wallet(2).address, X);
    const b = await s.issue(2, [wallet(2)]);
    expect((await s.submit(b, await s.receipt(wallet(2), 921, { endpoint: V2.endpoints[0].url, payTo: V2.pay_to.xrpl[0] }))).j.weight_note).toBe("seller_funded");
    // an exchange hot wallet funding both is ignored
    const s2 = setup({ env: { ...loose, CONTRIB_FUNDER_IGNORE: X } });
    s2.L.funders.set(V2.pay_to.xrpl[0], X); s2.L.funders.set(wallet(2).address, X);
    const b2 = await s2.issue(2, [wallet(2)]);
    expect((await s2.submit(b2, await s2.receipt(wallet(2), 922, { endpoint: V2.endpoints[0].url, payTo: V2.pay_to.xrpl[0] }))).j.weight).toBe(1);
  });

  it("(3) a negative from a zero-weight receipt never confirms another contributor's negative", async () => {
    const s = setup({ env: loose });
    const a = await s.issue(1, [wallet(1)]);
    s.L.funders.set(wallet(2).address, VPAY);
    const b = await s.issue(2, [wallet(2)]);
    expect((await s.submit(a, await s.receipt(wallet(1), 930, { outcome: "no_data" }))).j.finding).toBe("unconfirmed");
    const r = await s.submit(b, await s.receipt(wallet(2), 931, { outcome: "no_data" }));
    expect(r.j).toMatchObject({ finding: "unconfirmed", weight_note: "seller_funded" });
    expect((await s.store.byTx(txh(930)))?.finding).toBe("unconfirmed");
  });

  it("(4) near-duplicates: same paying wallet + seller inside the window is refused, stored or still queued", async () => {
    const s = setup({ env: loose });
    const a = await s.issue(1, [wallet(1)]);
    expect((await s.submit(a, await s.receipt(wallet(1), 940, { ts: NOW - 600_000 }))).status).toBe(202);
    const nd = await s.submit(a, await s.receipt(wallet(1), 941, { ts: NOW - 540_000 })); // new tx hash, 60s later
    expect(nd.status).toBe(409);
    expect(nd.j).toMatchObject({ error: "near_duplicate", window_s: 120 });
    // amounts are not part of the receipt any more, so a different amount inside the window is still one purchase
    expect((await s.submit(a, await s.receipt(wallet(1), 942, { ts: NOW - 540_000, value: "0.002" }))).j.error).toBe("near_duplicate");
    expect((await s.submit(a, await s.receipt(wallet(1), 943, { ts: NOW - 300_000 }))).status).toBe(202); // outside the window
    const sent: any[] = [];
    const q = setup({ env: loose, contribQueue: { send: async (b: unknown) => { sent.push(b); } } });
    const qa = await q.issue(1, [wallet(1)]);
    expect((await q.submit(qa, await q.receipt(wallet(1), 944))).j.queued).toBe(true);
    expect((await q.submit(qa, await q.receipt(wallet(1), 945))).j.error).toBe("near_duplicate");
  });

  it("rate limit: uses the Workers Rate Limiting binding when bound (no D1 writes), else the in-isolate limiter", async () => {
    let n = 0;
    const s = setup({ env: { CONTRIB_RATE_LIMITER: { limit: async () => ({ success: ++n <= 2 }) } } as any });
    const a = await s.issue(1, [wallet(1)]);
    expect((await s.signed(a, "GET", "/v1/contrib/me")).status).toBe(200);
    expect((await s.signed(a, "GET", "/v1/contrib/me")).status).toBe(200);
    const w0 = s.store.writes;
    const r = await s.signed(a, "GET", "/v1/contrib/me");
    expect(r.status).toBe(429);
    expect(s.store.writes).toBe(w0);
    const s2 = setup({ env: { CONTRIB_CAPS: JSON.stringify({ per_minute: 2 }) } });
    const b = await s2.issue(1, [wallet(1)]);
    for (let i = 0; i < 2; i++) expect((await s2.signed(b, "GET", "/v1/contrib/me")).status).toBe(200);
    expect((await s2.signed(b, "GET", "/v1/contrib/me")).status).toBe(429);
  });

  it("anonymous tier-1 outcome counts never feed scores or badges", async () => {
    const s = setup();
    const a = await s.issue(1, [wallet(1)]);
    for (let i = 0; i < 5; i++) {
      const r = await s.app.fetch(new Request(BASE + "/v1/check/outcome", { method: "POST", body: JSON.stringify({ v: 1, subject: new URL(EP).hostname, delivered: true, status_class: "2xx" }), headers: { "Content-Type": "application/json", "CF-Connecting-IP": "9.9.9." + i } }));
      expect(r.status).toBe(202);
    }
    expect(await board(s)).toHaveLength(0);
    expect((await badgeOf(s, a)).verified_contributions).toBe(0);
    expect(s.store.subs.size).toBe(0);
  });

  it("D1: nearDup, clusterSeller, wallet proofs and the funding cache round-trip (miniflare, migration 0022)", async () => {
    const { Miniflare, convertV4MiniflareOptions } = await import("miniflare") as any;
    const mf = new Miniflare(miniflareD1Options(convertV4MiniflareOptions));
    try {
      const db: any = await mf.getD1Database("DB");
      await db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);");
      const sql = CONTRIB_MIGRATIONS.map((f) => readFileSync("migrations/" + f, "utf8")).join(";\n").replace(/--.*$/gm, "");
      for (const st of sql.split(";").map((x) => x.trim()).filter(Boolean)) await db.prepare(st).run();
      const store = new D1ContributorStore(db);
      const s = setup({ store, env: loose });
      const F = wallet(50).address;
      s.L.funders.set(wallet(1).address, F); s.L.funders.set(wallet(2).address, F);
      const a = await s.issue(1, [wallet(1)]);
      const b = await s.issue(2, [wallet(2)]);
      expect((await store.wallets([wallet(1).address]))[0]).toMatchObject({ proven: true, source: F });
      expect(await store.getFunding(wallet(1).address)).toMatchObject({ funder: F });
      expect((await store.clusters())[0]).toMatchObject({ source: F });
      expect((await s.submit(a, await s.receipt(wallet(1), 950))).j.weight).toBe(1);
      expect((await s.submit(a, await s.receipt(wallet(1), 951, { ts: NOW - 560_000 }))).j.error).toBe("near_duplicate");
      expect((await s.submit(b, await s.receipt(wallet(2), 952, { endpoint: new URL(EP).origin + "/cluster-other" }))).j.weight_note).toBe("same_cluster");
      expect((await store.byTx(txh(952)))).toMatchObject({ weight: 0, weight_note: "same_cluster" });
      // index plan: nearDup on (key_id, day), clusterSeller on (source, day): no table scan
      const plan = async (q: string) => JSON.stringify((await db.prepare("EXPLAIN QUERY PLAN " + q).all()).results);
      expect(await plan("SELECT COUNT(*) FROM contributor_submissions WHERE key_id = 'k' AND day >= 'd' AND payer = 'p' AND pay_to = 'q' AND ABS(ledger_ts - 1) <= 2")).toMatch(/USING INDEX/);
      expect(await plan("SELECT COUNT(*) FROM contributor_submissions WHERE source = 's' AND day = 'd' AND key_id != 'k' AND weight != 0 AND (pay_to = 'q' OR domain = 'x')")).toMatch(/contributor_submissions_source_day/);
    } finally { await mf.dispose(); }
  });
});
