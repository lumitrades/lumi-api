import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateSeed, deriveKeypair, deriveAddress, sign as xrplSign } from "ripple-keypairs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { createApp } from "../src/app";
import { createTrust, scoreVendor, TRUST_POST_PATHS } from "../src/trust";
import { MemoryTrustStore, type ObservationRow, type ReportRow } from "../src/trust/store";
import { SEED_OBSERVATIONS } from "../src/trust/seed";
import { VENDORS, vendorById } from "../src/vendors";
import { recoverEvmSigner, sha256Hex, utf8Hex, verifyXrplSignature, RLUSD } from "../src/trust/verify";

const OWNER = "o".repeat(16) + "0123456789abcdef0123456789abcdef";
const BUYER = "rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM";
const RPC = "https://rpc.test/";
const BASE_RPC = "https://base.test/";
const BASE = "http://lumi.test";
const NOW = Date.parse("2026-10-22T18:00:00Z");
const DAY = 86_400_000;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

type TxFixture = { from: string; to: string; delivered: string | { currency: string; issuer: string; value: string }; pub?: string; ts?: number; result?: string; validated?: boolean };

function setup(opts: { txs?: Record<string, TxFixture>; regularKeys?: Record<string, string>; ledgerDown?: boolean; vendorFetch?: (url: string, init?: RequestInit) => Response | Promise<Response>; base?: Record<string, any>; now?: () => number } = {}) {
  const store = new MemoryTrustStore(SEED_OBSERVATIONS);
  const logs: any[] = [];
  const fetchCalls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    fetchCalls.push({ url, init });
    if (url === RPC) {
      if (opts.ledgerDown) return new Response("down", { status: 503 });
      const body = JSON.parse(String(init?.body));
      if (body.method === "tx") {
        const h = body.params[0].transaction;
        const t = opts.txs?.[h];
        if (!t) return Response.json({ result: { error: "txnNotFound", status: "error" } });
        return Response.json({
          result: {
            hash: h,
            validated: t.validated ?? true,
            close_time_iso: new Date(t.ts ?? NOW - 3_600_000).toISOString().replace(".000Z", "Z"),
            tx_json: { TransactionType: "Payment", Account: t.from, Destination: t.to, SigningPubKey: t.pub ?? "" },
            meta: { TransactionResult: t.result ?? "tesSUCCESS", delivered_amount: t.delivered },
          },
        });
      }
      if (body.method === "account_info") {
        const a = body.params[0].account;
        return Response.json({ result: { account_data: { Account: a, ...(opts.regularKeys?.[a] ? { RegularKey: opts.regularKeys[a] } : {}) } } });
      }
    }
    if (url === BASE_RPC) {
      const body = JSON.parse(String(init?.body));
      if (body.method === "eth_getTransactionReceipt") return Response.json({ jsonrpc: "2.0", id: 1, result: opts.base?.[body.params[0]] ?? null });
      if (body.method === "eth_getBlockByNumber") return Response.json({ jsonrpc: "2.0", id: 2, result: { timestamp: "0x" + Math.floor((NOW - 3_600_000) / 1000).toString(16) } });
    }
    if (opts.vendorFetch) return opts.vendorFetch(url, init);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const now = opts.now ?? (() => NOW);
  const trust = createTrust({ store, fetch: f, now, ownerKey: OWNER, ipSecret: "ip-secret", log: (e) => logs.push(e), xrplRpc: [RPC], baseRpc: BASE_RPC, buyers: [BUYER] });
  const req = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; ip?: string } = {}) =>
    trust.handle(
      new Request(BASE + path, {
        method: init.method ?? "GET",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": init.ip ?? "203.0.113.7", ...init.headers },
        body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
      }),
      path.split("?")[0],
      BASE,
    ) as Promise<Response>;
  return { store, trust, req, logs, fetchCalls };
}

function xrplReporter() {
  const kp = deriveKeypair(generateSeed({ algorithm: "ecdsa-secp256k1" }));
  return { ...kp, address: deriveAddress(kp.publicKey), sign: (m: string) => xrplSign(utf8Hex(m), kp.privateKey) };
}

function evmReporter() {
  const priv = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(priv, false);
  const address = "0x" + hex(keccak_256(pub.slice(1)).slice(-20));
  const sign = (m: string) => {
    const msg = new TextEncoder().encode(m);
    const digest = keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]));
    const s = secp256k1.sign(digest, priv);
    return "0x" + s.toCompactHex() + (27 + s.recovery).toString(16);
  };
  return { address, sign };
}

const ASKSURF_PAYTO = vendorById("asksurf")!.pay_to.xrpl[0];
const SCALP = vendorById("scalpstream")!;
const H = (c: string) => c.repeat(64).slice(0, 64);

describe("trust: public reads", () => {
  it("lists the allowlist in order with seeded evidence, label, methodology and right to reply", async () => {
    const { req } = setup();
    const r = await req("/v1/trust/vendors");
    expect(r.status).toBe(200);
    const d: any = await r.json();
    expect(d.vendors.map((v: any) => v.id)).toEqual(VENDORS.map((v) => v.id));
    expect(d.ordering).toMatch(/not ranked/);
    expect(d.label).toMatch(/automated observations/);
    expect(d.methodology).toBe(`${BASE}/v1/trust/methodology`);
    expect(d.right_to_reply.email).toBe("hello@lumitrades.io");
    const surf = d.vendors.find((v: any) => v.id === "asksurf");
    expect(surf.samples.paid_test_buys).toBe(2);
    expect(surf.confidence).toBe("low");
    expect(surf.last_paid_observation).toMatchObject({ http_status: 502, data_returned: false });
    // Free: only the latest paid test-buy's hash per vendor (older hashes stay in the paid report).
    expect(surf.last_paid_observation.tx_hash).toMatch(/^[0-9A-F]{64}$/);
    expect(surf.last_paid_observation.explorer).toContain(surf.last_paid_observation.tx_hash);
    const scalp = d.vendors.find((v: any) => v.id === "scalpstream");
    expect(scalp.score).toBe(100);
    expect(scalp.last_paid_observation.data_returned).toBe(true);
    const withObs = d.vendors.filter((v: any) => v.last_paid_observation);
    expect((JSON.stringify(d).match(/"tx_hash"/g) ?? []).length).toBe(withObs.length);
    for (const v of d.vendors) if (!v.last_paid_observation) expect(JSON.stringify(v)).not.toMatch(/"tx_hash"|"explorer"/);
    const text = JSON.stringify(d);
    expect(text).not.toMatch(/\b(scam|fraud|untrustworthy)\b/i);
    expect(text).not.toMatch(/ip_hash|excerpt/);
  });

  it("rejects malformed or empty lookup parameters with 400 instead of listing everything", async () => {
    const { req } = setup();
    for (const [q, err] of [["?url=not-a-url", "invalid_url"], ["?domain=", "invalid_domain"], ["?url=", "invalid_url"], ["?payTo=hello", "invalid_pay_to"], ["?domain=not a host", "invalid_domain"]] as const) {
      const r = await req(`/v1/trust/vendors${q}`);
      expect(r.status, q).toBe(400);
      expect(((await r.json()) as any).error).toBe(err);
    }
    expect((await req("/v1/trust/vendors?domain=https://Example.com/x")).status).toBe(200);
  });

  it("marks a vendor unreachable after 3 dead checks (404/410/no answer) on every endpoint", async () => {
    const { req, store } = setup();
    const before: any = await (await req("/v1/trust/vendors/scalpstream")).json();
    expect(before.status).toBe("live");
    const rows = SCALP.endpoints.flatMap((e, i) =>
      [410, null, 404].map((st, k) => ({
        vendor_id: SCALP.id, endpoint: e.url, ts: NOW - (k + 1) * 60_000 - i, http_status: st, ok: false, price: null, asset: null, pay_to: null, source_tag: null, latency_ms: null, error: st === null ? "no answer within 15 s" : null,
      })),
    );
    await store.addProbes(rows as any);
    const d: any = await (await req("/v1/trust/vendors/scalpstream")).json();
    expect(d.status).toBe("unreachable");
    expect(d.status_note).toMatch(/last 3 checks/);
    const list: any = await (await req("/v1/trust/vendors")).json();
    expect(list.vendors.find((v: any) => v.id === "scalpstream").status).toBe("unreachable");
    expect(list.vendors.find((v: any) => v.id === "asksurf").status).toBe("live");
  });

  it("serves one vendor with evidence, explorer links and components; 404 for unknown", async () => {
    const { req } = setup();
    const d: any = await (await req("/v1/trust/vendors/heurist-mesh")).json();
    expect(d.observations[0]).toMatchObject({ data_returned: false, http_status: 200 });
    expect(JSON.stringify(d)).not.toMatch(/07929A44333D9269CD4C92DE6A4A917B0BA28F1A3F244F1992B3F61BDA366BA0|"explorer"/);
    expect(d.evidence).toContain("/v1/trust/vendors/heurist-mesh/report");
    expect(d.score.components.delivery.value).toBe(0);
    expect(d.right_to_reply.endpoint).toContain("/v1/trust/replies");
    expect((await req("/v1/trust/vendors/nope")).status).toBe(404);
    const m: any = await (await req("/v1/trust/methodology")).json();
    expect(m.score.weights).toEqual({ delivery: 0.5, uptime: 0.2, latency: 0.15, agent_reports: 0.15 });
  });

  it("GET on POST paths is 405; unrelated paths fall through", async () => {
    const { req } = setup();
    for (const p of TRUST_POST_PATHS) expect((await req(p)).status).toBe(405);
    expect(await req("/v1/fear-greed")).toBeNull();
  });

  it("seed SQL and TS mirror stay in sync", () => {
    const sql = readFileSync(join(__dirname, "..", "migrations", "0002_seed_2026_10_22.sql"), "utf8");
    const rows = [...sql.matchAll(/\('([a-z-]+)', '([^']+)', (\d+), 'xrpl:0', '([0-9A-F]{64})', '([\d.]+)', '(\w+)', (\d+), ([01]), NULL,\s*\n\s*'((?:[^']|'')*)', 'lumi_buy'\)/g)];
    expect(rows).toHaveLength(SEED_OBSERVATIONS.length);
    rows.forEach((m, i) => {
      const s = SEED_OBSERVATIONS[i];
      expect([m[1], m[2], Number(m[3]), m[4], m[5], m[6], Number(m[7]), m[8] === "1", m[9]]).toEqual([s.vendor_id, s.endpoint, s.ts, s.tx_hash, s.amount, s.asset, s.http_status, s.data_returned, s.summary]);
    });
    for (const s of SEED_OBSERVATIONS) expect(vendorById(s.vendor_id)!.endpoints.some((e) => e.url === s.endpoint)).toBe(true);
  });
});

describe("trust: agent reports", () => {
  const good = (rep: ReturnType<typeof xrplReporter>, tx: string) => ({
    vendor_id: "asksurf", network: "xrpl:0", tx_hash: tx, reporter: rep.address, outcome: "no_data", http_status: 502,
    signature: rep.sign(`lumi-report:xrpl:0:${tx}`), response_excerpt: "private excerpt text",
  });

  it("rejects a bogus tx (not on ledger) with 422, stores it privately, shows nothing", async () => {
    const rep = xrplReporter();
    const { req, store } = setup();
    const r = await req("/v1/reports", { method: "POST", body: good(rep, H("AB")) });
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ accepted: false, verified: false, reason: "tx_not_found" });
    expect(store.reports).toHaveLength(1);
    expect(store.reports[0].verified).toBe(false);
    const d: any = await (await req("/v1/trust/vendors/asksurf")).json();
    expect(d.agent_reports).toEqual([]);
    expect(JSON.stringify(d)).not.toContain("private excerpt");
  });

  it("validates input", async () => {
    const rep = xrplReporter();
    const { req } = setup();
    let ip = 0;
    const post = (b: unknown) => req("/v1/reports", { method: "POST", body: b, ip: `192.0.2.${++ip}` });
    const unk = await post({ ...good(rep, H("AB")), vendor_id: "x" });
    expect(unk.status).toBe(404);
    expect(await unk.json()).not.toHaveProperty("vendors");
    for (const vendor_id of [undefined, "", "  ", 7]) {
      const r = await post({ ...good(rep, H("AB")), vendor_id });
      expect(r.status).toBe(400);
      const b: any = await r.json();
      expect(b).toMatchObject({ error: "invalid_request", field: "vendor_id" });
      expect(b.detail).toMatch(/required/);
      expect(b).not.toHaveProperty("vendors");
    }
    const rr = await req("/v1/trust/replies", { method: "POST", body: { text: "hi" }, ip: "192.0.2.60" });
    expect(rr.status).toBe(400);
    const rb: any = await rr.json();
    expect(rb).toMatchObject({ error: "invalid_request", field: "vendor_id" });
    expect(rb).not.toHaveProperty("vendors");
    expect((await post({ ...good(rep, H("AB")), tx_hash: "zz" })).status).toBe(400);
    expect((await post({ ...good(rep, H("AB")), reporter: "nope" })).status).toBe(400);
    expect((await post({ ...good(rep, H("AB")), outcome: "bad" })).status).toBe(400);
    expect((await post({ ...good(rep, H("AB")), network: "eip155:1" })).status).toBe(400);
    expect((await req("/v1/reports", { method: "POST", body: "{not json", ip: "192.0.2.50" })).status).toBe(400);
    expect((await req("/v1/reports", { method: "POST", body: JSON.stringify({ t: "x".repeat(17_000) }), ip: "192.0.2.51" })).status).toBe(413);
  });

  it("503 and nothing stored when the ledger is unreachable", async () => {
    const rep = xrplReporter();
    const { req, store } = setup({ ledgerDown: true });
    expect((await req("/v1/reports", { method: "POST", body: good(rep, H("AB")) })).status).toBe(503);
    expect(store.reports).toHaveLength(0);
  });

  it("accepts an on-ledger payment signed by the payer, shows it, holds it 24 h, rejects duplicates", async () => {
    const rep = xrplReporter();
    const tx = H("C1");
    const txs = { [tx]: { from: rep.address, to: ASKSURF_PAYTO, delivered: { ...RLUSD, value: "0.006" }, pub: rep.publicKey } };
    const { req } = setup({ txs });
    const r = await req("/v1/reports", { method: "POST", body: good(rep, tx) });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ accepted: true, verified: true });
    const d: any = await (await req("/v1/trust/vendors/asksurf")).json();
    expect(d.agent_reports).toHaveLength(1);
    expect(d.agent_reports[0]).toMatchObject({ amount: "0.006", asset: "RLUSD", outcome: "no_data" });
    expect(d.agent_reports[0].tx_hash).toBeUndefined();
    expect(d.score.samples.verified_reports_counted).toBe(0);
    expect((await req("/v1/reports", { method: "POST", body: good(rep, tx), ip: "198.51.100.1" })).status).toBe(409);
  });

  it("rejects a wrong signer, a sender mismatch and a payment to another address", async () => {
    const rep = xrplReporter();
    const other = xrplReporter();
    const txs = {
      [H("D1")]: { from: rep.address, to: ASKSURF_PAYTO, delivered: "6000", pub: rep.publicKey },
      [H("D2")]: { from: other.address, to: ASKSURF_PAYTO, delivered: "6000", pub: other.publicKey },
      [H("D3")]: { from: rep.address, to: BUYER, delivered: "6000", pub: rep.publicKey },
      [H("D4")]: { from: rep.address, to: ASKSURF_PAYTO, delivered: "6000", pub: rep.publicKey, ts: NOW - 30 * DAY },
    };
    const { req } = setup({ txs });
    const post = async (b: any) => (await (await req("/v1/reports", { method: "POST", body: b })).json() as any).reason;
    expect(await post({ ...good(rep, H("D1")), signature: other.sign(`lumi-report:xrpl:0:${H("D1")}`) })).toBe("bad_signature");
    expect(await post({ ...good(rep, H("D1")), signature: undefined })).toBe("signature_required");
    expect(await post(good(rep, H("D2")))).toBe("sender_mismatch");
    expect(await post(good(rep, H("D3")))).toBe("recipient_not_vendor");
    expect(await post(good(rep, H("D4")))).toBe("tx_too_old");
  });

  it("verifies a Base USDC payment with an EIP-191 signature", async () => {
    const rep = evmReporter();
    const tx = "0x" + "e".repeat(64);
    const pad = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
    const base = {
      [tx]: {
        status: "0x1", blockNumber: "0x10",
        logs: [{ address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", pad(rep.address), pad(SCALP.pay_to.evm![0])], data: "0x" + (10000).toString(16).padStart(64, "0") }],
      },
    };
    const { req } = setup({ base });
    const body = { vendor_id: "scalpstream", network: "eip155:8453", tx_hash: tx, reporter: rep.address, outcome: "delivered", signature: rep.sign(`lumi-report:eip155:8453:${tx}`) };
    const r = await req("/v1/reports", { method: "POST", body });
    expect(r.status).toBe(201);
    const d: any = await (await req("/v1/trust/vendors/scalpstream")).json();
    expect(d.agent_reports[0]).toMatchObject({ amount: "0.01", asset: "USDC" });
  });

  it("rate-limits reports per IP", async () => {
    const rep = xrplReporter();
    const { req } = setup();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await req("/v1/reports", { method: "POST", body: good(rep, H("AB")) })).status);
    expect(codes.slice(0, 5).every((c) => c === 422)).toBe(true);
    expect(codes[5]).toBe(429);
    expect((await req("/v1/reports", { method: "POST", body: good(rep, H("AB")), ip: "198.51.100.9" })).status).toBe(422);
  });
});

describe("trust: tips are private", () => {
  it("stores tips and never serves them", async () => {
    const { req, store, logs } = setup();
    const secret = "TIP-CANARY institutional rumour about bank X";
    const r = await req("/v1/tips", { method: "POST", body: { text: secret, coins: ["xrp"], source_urls: ["https://example.com/a"] } });
    expect(r.status).toBe(202);
    const body: any = await r.json();
    expect(body).toMatchObject({ received: true });
    expect(JSON.stringify(body)).not.toContain("CANARY");
    expect(store.tips[0]).toMatchObject({ text: secret, coins: "XRP" });
    expect(JSON.stringify(logs)).not.toContain("CANARY");
    for (const p of ["/v1/trust/vendors", "/v1/trust/methodology", ...VENDORS.map((v) => `/v1/trust/vendors/${v.id}`)]) {
      expect(await (await req(p)).text()).not.toContain("CANARY");
    }
    expect((await req("/v1/tips")).status).toBe(405);
    expect((await req(`/v1/tips/${body.id}`))).toBeNull();
  });

  it("validates and rate-limits tips", async () => {
    const { req } = setup();
    expect((await req("/v1/tips", { method: "POST", body: { text: "short" }, ip: "192.0.2.1" })).status).toBe(400);
    expect((await req("/v1/tips", { method: "POST", body: { text: "long enough text", source_urls: ["http://x.y"] }, ip: "192.0.2.2" })).status).toBe(400);
    expect((await req("/v1/tips", { method: "POST", body: { text: "long enough text", coins: ["$$"] }, ip: "192.0.2.3" })).status).toBe(400);
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await req("/v1/tips", { method: "POST", body: { text: "long enough text " + i } })).status);
    expect(codes).toEqual([202, 202, 202]);
    expect((await req("/v1/tips", { method: "POST", body: { text: "long enough text 3" } })).status).toBe(429);
  });

  it("through the app: no tip content on MCP or A2A either", async () => {
    const app = createApp({ XRPL_NETWORK: "xrpl:1", PAY_TO: BUYER, INVOICE_SECRET: "s", DATA_BASE_URL: "https://data.test" } as any, { fetch: (async () => new Response("x", { status: 404 })) as any, log: () => {}, now: () => NOW });
    const t = await app.fetch(new Request(BASE + "/v1/tips", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "CANARY-2 private tip text" }) }));
    expect(t.status).toBe(202);
    const mcp = await app.fetch(new Request(BASE + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lumi_vendor_scores", arguments: {} } }) }));
    const mtext = await mcp.text();
    expect(mtext).toContain("asksurf");
    expect(mtext).not.toContain("CANARY");
    const one = await app.fetch(new Request(BASE + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lumi_vendor_scores", arguments: { vendor_id: "scalpstream" } } }) }));
    expect(JSON.parse(JSON.parse(await one.text()).result.content[0].text).id).toBe("scalpstream");
    const a2a = await app.fetch(new Request(BASE + "/a2a", { method: "POST", headers: { "Content-Type": "application/json", "A2A-Version": "1.0" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { role: "ROLE_USER", messageId: "m1", parts: [{ text: "vendor trust scores" }] } } }) }));
    const atext = await a2a.text();
    expect(atext).toContain("vendor_trust");
    expect(atext).not.toContain("CANARY");
    const opt = await app.fetch(new Request(BASE + "/v1/reports", { method: "OPTIONS" }));
    expect(opt.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});

describe("trust: vendor replies", () => {
  it("accepts a reply signed by the RegularKey of a listed pay-to address", async () => {
    const key = xrplReporter();
    const { req } = setup({ regularKeys: { [ASKSURF_PAYTO]: key.address } });
    const text = "Our upstream data provider had an outage on 2026-10-22; fixed since.";
    const sig = key.sign(`lumi-reply:asksurf:${await sha256Hex(text)}`);
    const r = await req("/v1/trust/replies", { method: "POST", body: { vendor_id: "asksurf", text, network: "xrpl:0", address: ASKSURF_PAYTO, public_key: key.publicKey, signature: sig } });
    expect(r.status).toBe(201);
    const d: any = await (await req("/v1/trust/vendors/asksurf")).json();
    expect(d.vendor_replies[0]).toMatchObject({ text, via: `signed:${ASKSURF_PAYTO}` });
  });

  it("rejects a key that is not authorised for the address, and an unlisted address", async () => {
    const key = xrplReporter();
    const { req } = setup();
    const text = "hello";
    const sig = key.sign(`lumi-reply:asksurf:${await sha256Hex(text)}`);
    const a = await req("/v1/trust/replies", { method: "POST", body: { vendor_id: "asksurf", text, address: ASKSURF_PAYTO, public_key: key.publicKey, signature: sig } });
    expect(a.status).toBe(422);
    expect(((await a.json()) as any).reason).toBe("key_not_authorized_for_address");
    const b = await req("/v1/trust/replies", { method: "POST", body: { vendor_id: "asksurf", text, address: key.address, public_key: key.publicKey, signature: sig } });
    expect(((await b.json()) as any).reason).toBe("address_not_listed_for_vendor");
  });

  it("owner can add an emailed reply; public cannot", async () => {
    const { req } = setup();
    const body = { vendor_id: "heurist-mesh", text: "Funding data returns empty when the upstream exchange is rate limited.", via: "email" };
    expect((await req("/v1/trust/replies", { method: "POST", body, headers: { Authorization: `Bearer ${OWNER}` } })).status).toBe(201);
    expect((await req("/v1/trust/replies", { method: "POST", body, headers: { Authorization: "Bearer wrong" } })).status).toBe(400);
    const d: any = await (await req("/v1/trust/vendors/heurist-mesh")).json();
    expect(d.vendor_replies).toHaveLength(1);
  });
});

describe("trust: owner observations ingest", () => {
  const ep = SCALP.endpoints.find((e) => e.test_buy)!.url;
  const tx = H("F7");
  const txs = { [tx]: { from: BUYER, to: SCALP.pay_to.xrpl[0], delivered: "7600" }, [H("F8")]: { from: "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY", to: SCALP.pay_to.xrpl[0], delivered: "7600" } };
  const body = { vendor_id: "scalpstream", endpoint: ep, tx_hash: tx, amount: "0.0076", asset: "XRP", http_status: 200, data_returned: true, latency_ms: 812, summary: "HTTP 200; response contained data (list of 10 candidates)." };
  const auth = { Authorization: `Bearer ${OWNER}` };

  it("requires the owner key", async () => {
    const { req } = setup({ txs });
    expect((await req("/v1/trust/observations", { method: "POST", body })).status).toBe(401);
    expect((await req("/v1/trust/observations", { method: "POST", body, headers: { Authorization: "Bearer " + "x".repeat(48) } })).status).toBe(401);
    expect((await req("/v1/trust/probe", { method: "POST", body: {} })).status).toBe(401);
  });

  it("records a ledger-checked test-buy, then reports duplicates", async () => {
    const { req } = setup({ txs });
    const r = await req("/v1/trust/observations", { method: "POST", body, headers: auth });
    expect(r.status).toBe(201);
    const o: any = (await r.json()).observation;
    expect(o).toMatchObject({ tx_hash: tx, amount: "0.0076", asset: "XRP", data_returned: true, latency_ms: 812, source: "Lumi daily test-buy" });
    expect(o.evidence).toMatch(/^paid 0\.0076 XRP on .*, tx F7F7.*, HTTP 200, response contained data$/);
    expect((await req("/v1/trust/observations", { method: "POST", body, headers: auth })).status).toBe(200);
    const d: any = await (await req("/v1/trust/vendors/scalpstream")).json();
    expect(d.score.samples.paid_test_buys).toBe(2);
  });

  it("D1 write-limit on ingest: 503 storage_unavailable (retryable), not 500; stores nothing; retry later records it once", async () => {
    // Regression (Oct 23 2026): D1's free-tier daily row write limit was exhausted before the 04:24 CT test-buy run;
    // every ingest threw D1_ERROR and surfaced as an opaque 500 internal_error.
    const { req, store, logs } = setup({ txs });
    const orig = store.addObservation.bind(store);
    let down = true;
    store.addObservation = async (row) => {
      if (down) throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.");
      return orig(row);
    };
    const r = await req("/v1/trust/observations", { method: "POST", body, headers: auth });
    expect(r.status).toBe(503);
    expect(r.headers.get("Retry-After")).toBe(String(6 * 3600)); // NOW = 18:00Z -> 6 h to 00:00 UTC
    const j: any = await r.json();
    expect(j).toMatchObject({ error: "storage_unavailable", retryable: true, recorded: false, tx_hash: tx });
    expect(store.obs.some((o) => o.tx_hash === tx)).toBe(false);
    expect(logs.some((l) => l.event === "trust_observation_storage_unavailable")).toBe(true);
    down = false;
    expect((await req("/v1/trust/observations", { method: "POST", body, headers: auth })).status).toBe(201);
    expect((await req("/v1/trust/observations", { method: "POST", body, headers: auth })).status).toBe(200);
    expect(store.obs.filter((o) => o.tx_hash === tx)).toHaveLength(1);
  });

  it("other store errors on ingest still propagate (not masked as storage_unavailable)", async () => {
    const { req, store } = setup({ txs });
    store.addObservation = async () => { throw new Error("D1_ERROR: no such column: inconclusive"); };
    await expect(req("/v1/trust/observations", { method: "POST", body, headers: auth })).rejects.toThrow(/no such column/);
  });

  it("rejects wrong sender, wrong amount, bad wording, unknown endpoint, bogus tx", async () => {
    const { req } = setup({ txs });
    const post = (b: any) => req("/v1/trust/observations", { method: "POST", body: b, headers: auth });
    expect(((await (await post({ ...body, tx_hash: H("F8") })).json()) as any).reason).toBe("sender_not_lumi_wallet");
    expect(((await (await post({ ...body, amount: "0.5" })).json()) as any).reason).toBe("amount_mismatch");
    expect((await post({ ...body, summary: "looks like a scam" })).status).toBe(400);
    expect((await post({ ...body, endpoint: "https://evil.example/" })).status).toBe(400);
    expect((await post({ ...body, data_returned: "yes" })).status).toBe(400);
    expect((await post({ ...body, tx_hash: H("99") })).status).toBe(422);
  });
});

describe("trust: probes", () => {
  it("records valid quotes, wrong pay-to, errors; never sends payment headers", async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
    const { trust, req, fetchCalls } = setup({
      vendorFetch: (url) => {
        const v = VENDORS.find((x) => x.endpoints.some((e) => e.url === url))!;
        if (v.id === "asksurf") return new Response("err", { status: 500 });
        const payTo = v.id === "monid" ? "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY" : v.pay_to.xrpl[0];
        const pr = { x402Version: 2, accepts: [{ scheme: "exact", network: "xrpl:0", asset: RLUSD.currency, amount: "0.01", payTo, extra: { issuer: RLUSD.issuer, sourceTag: 804681468 } }] };
        return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64(pr) } });
      },
    });
    const res = await trust.runProbes();
    const total = VENDORS.reduce((n, v) => n + v.endpoints.length, 0);
    expect(res.probes).toBe(total);
    const vendorCalls = fetchCalls.filter((c) => !c.url.startsWith("https://rpc.test"));
    expect(vendorCalls).toHaveLength(total);
    for (const c of vendorCalls) {
      const h = new Headers(c.init?.headers);
      expect(h.get("PAYMENT-SIGNATURE")).toBeNull();
      expect(h.get("X-PAYMENT")).toBeNull();
      expect(h.get("User-Agent")).toMatch(/LumiTrustProbe/);
    }
    const scalp: any = await (await req("/v1/trust/vendors/scalpstream")).json();
    expect(scalp.latest_probes[0]).toMatchObject({ valid_quote: true, asset: "RLUSD", price: "0.01", source_tag_in_quote: true });
    expect(scalp.score.components.uptime.value).toBe(1);
    const surf: any = await (await req("/v1/trust/vendors/asksurf")).json();
    expect(surf.latest_probes[0]).toMatchObject({ valid_quote: false, http_status: 500 });
    const monid: any = await (await req("/v1/trust/vendors/monid")).json();
    expect(monid.latest_probes[0].note).toMatch(/not listed/);
  });

  it("owner can trigger probes", async () => {
    const { req } = setup();
    const r = await req("/v1/trust/probe", { method: "POST", body: {}, headers: { Authorization: `Bearer ${OWNER}` } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).ran).toBe(true);
  });
});

describe("trust: scoring", () => {
  const obs = (data: boolean, ts = NOW - DAY): ObservationRow => ({ vendor_id: "v", endpoint: "e", ts, network: "xrpl:0", tx_hash: H("A"), amount: "1", asset: "XRP", http_status: 200, data_returned: data, latency_ms: null, summary: "s", source: "lumi_test_buy" });
  const rep = (outcome: string, reporter: string, ts: number): ReportRow => ({ id: reporter + ts, vendor_id: "v", network: "xrpl:0", tx_hash: H("B"), reporter, tx_ts: ts, amount: "1", asset: "XRP", http_status: null, outcome, excerpt: null, signed: true, verified: true, reason: null, ip_hash: null, ts });
  const P = (n: number, ok: number, lat: number[] = []) => ({ n, ok, latencies: lat, latest: [] });

  it("weighted mean of available components; latency curve; confidence", () => {
    expect(scoreVendor(P(0, 0), [], [], NOW).value).toBeNull();
    expect(scoreVendor(P(0, 0), [obs(true), obs(false)], [], NOW)).toMatchObject({ value: 50, confidence: "low" });
    const s = scoreVendor(P(10, 10, [500, 500]), [obs(true), obs(true), obs(true), obs(true), obs(true)], [], NOW);
    expect(s).toMatchObject({ value: 100, confidence: "medium" });
    expect(scoreVendor(P(10, 10, [5000]), [], [], NOW).components.latency).toMatchObject({ value: 0 });
    expect(scoreVendor(P(10, 10, [2750]), [], [], NOW).components.latency).toMatchObject({ value: 0.5 });
  });

  it("confidence counts 90-day paid test-buys (weekly rotation), score stays 30-day", () => {
    const five = [obs(true), obs(true), obs(true), obs(true), obs(true)];
    const s = scoreVendor(P(10, 10, [500]), five, [], NOW, 24);
    expect(s).toMatchObject({ value: 100, confidence: "high", samples: { paid_test_buys: 5, paid_test_buys_90d: 24 } });
    expect(scoreVendor(P(10, 10, [500]), five.slice(0, 4), [], NOW, 12).confidence).toBe("medium");
  });

  it("reports: hold, per-day cap, corroboration weight", () => {
    const t = NOW - 2 * DAY;
    const reports = [rep("delivered", "rA", t), rep("delivered", "rA", t + 1000), rep("no_data", "rB", t), rep("delivered", "rC", NOW - 3600_000)];
    const s = scoreVendor(P(0, 0), [obs(false, t + 3600_000)], reports, NOW);
    // rA counted once (per-day cap), rC still held, rB corroborated (1.5): 1 / (1 + 1.5)
    expect(s.samples.verified_reports_counted).toBe(2);
    expect((s.components.agent_reports as any).value).toBe(0.4);
  });

  it("signature helpers interoperate with real keys", () => {
    const x = xrplReporter();
    expect(verifyXrplSignature("m", x.sign("m"), x.publicKey)).toBe(true);
    expect(verifyXrplSignature("m2", x.sign("m"), x.publicKey)).toBe(false);
    const e = evmReporter();
    expect(recoverEvmSigner("hello", e.sign("hello"))).toBe(e.address);
    expect(recoverEvmSigner("hello2", e.sign("hello"))).not.toBe(e.address);
  });
});

describe("app: storage quota errors map to 503", () => {
  it("an unhandled D1 write-limit error returns 503 storage_unavailable with Retry-After; other errors stay 500", async () => {
    const { isStorageQuotaError, secondsToUtcMidnight } = await import("../src/trust/storage_errors");
    expect(isStorageQuotaError(new Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit."))).toBe(true);
    expect(isStorageQuotaError(new Error("D1_ERROR: no such table: x"))).toBe(false);
    expect(isStorageQuotaError("TypeError: x is undefined")).toBe(false);
    expect(secondsToUtcMidnight(Date.parse("2026-10-23T09:30:00Z"))).toBe(14.5 * 3600);
    expect(secondsToUtcMidnight(Date.parse("2026-10-23T23:59:59.5Z"))).toBe(60);
    const mk = (msg: string) => {
      const s = new MemoryTrustStore(SEED_OBSERVATIONS);
      s.observations = async () => { throw new Error(msg); };
      s.probeSummary = async () => { throw new Error(msg); };
      return createApp({ XRPL_NETWORK: "xrpl:1", PAY_TO: BUYER, FACILITATOR_URL: "https://f.test", DATA_BASE_URL: "https://d.test/data", INVOICE_SECRET: "s" } as any, { trustStore: s, now: () => NOW });
    };
    const a = await mk("D1_ERROR: Your account has exceeded D1's free tier daily row write limit.").fetch(new Request(BASE + "/v1/trust/vendors/asksurf"));
    expect(a.status).toBe(503);
    expect(((await a.json()) as any).error).toBe("storage_unavailable");
    expect(Number(a.headers.get("Retry-After"))).toBeGreaterThanOrEqual(60);
    const b = await mk("boom").fetch(new Request(BASE + "/v1/trust/vendors/asksurf"));
    expect(b.status).toBe(500);
  });
});

describe("trust: opt-in unsettled payment attempts (payment_attempts)", () => {
  const auth = { Authorization: `Bearer ${OWNER}` };
  const EDGE = vendorById("edge-agents")!;
  const ep = EDGE.endpoints[0].url;
  const body = (tx: string, signed_at: string, extra: Record<string, unknown> = {}) => ({ vendor_id: "edge-agents", endpoint: ep, tx_hash: tx, signed_at, amount: "0.01", asset: "RLUSD", http_status: 402, detail: "HTTP 402: No matching payment requirements", ...extra });
  const list = async (req: any) => ((await (await req("/v1/trust/vendors")).json()) as any).vendors as any[];

  it("is opt-in: only edge-agents carries the flag; monid does not", () => {
    expect(EDGE.label_unsettled_payments).toBe(true);
    expect(vendorById("monid")!.label_unsettled_payments).toBeUndefined();
    expect(VENDORS.filter((v) => v.label_unsettled_payments).map((v) => v.id)).toEqual(["edge-agents"]);
  });

  it("requires the owner key and is a trust POST path", async () => {
    const { req } = setup();
    expect(TRUST_POST_PATHS).toContain("/v1/trust/attempts");
    expect((await req("/v1/trust/attempts", { method: "POST", body: body(H("A1"), "2026-10-22T03:00:00Z") })).status).toBe(401);
  });

  it("records never-settled signed payments, dedupes, and lists count + first attempt", async () => {
    const { req } = setup();
    expect((await list(req)).find((v) => v.id === "edge-agents").payment_attempts).toBeUndefined();
    expect((await req("/v1/trust/attempts", { method: "POST", body: body(H("A1"), "2026-10-21T03:08:48.615Z"), headers: auth })).status).toBe(201);
    expect((await req("/v1/trust/attempts", { method: "POST", body: body(H("A2"), "2026-10-22T09:25:07Z", { endpoint: "https://pay.edge-agents.ai/v1/services/macro-no-inflation" }), headers: auth })).status).toBe(201);
    const dup = await req("/v1/trust/attempts", { method: "POST", body: body(H("A1"), "2026-10-21T03:08:48.615Z"), headers: auth });
    expect(dup.status).toBe(200);
    expect(((await dup.json()) as any).duplicate).toBe(true);
    const e = (await list(req)).find((v) => v.id === "edge-agents");
    expect(e.payment_attempts).toMatchObject({ status: "test_payment_not_accepted_yet", label: "Test payment not accepted yet on XRPL", network: "xrpl:0", network_name: "XRPL", count: 2, first_attempt: "2026-10-21T03:08:48.615Z", last_attempt: "2026-10-22T09:25:07.000Z" });
    expect(e.payment_attempts.note).not.toMatch(/scam|fraud/i);
    // never an input to the score
    const { req: req2 } = setup();
    const e2 = (await list(req2)).find((v) => v.id === "edge-agents");
    expect(e.score).toBe(e2.score);
    expect(e.samples).toEqual(e2.samples);
  });

  it("does not label vendors that did not opt in, even with stored attempts", async () => {
    const { req, store } = setup();
    await store.addUnsettledAttempt({ vendor_id: "monid", endpoint: "https://monid-x402-xrpl-production.up.railway.app/x", ts: NOW - DAY, network: "xrpl:0", tx_hash: H("B1"), amount: "0.006", asset: "RLUSD", http_status: 402, detail: null });
    expect((await list(req)).find((v) => v.id === "monid").payment_attempts).toBeUndefined();
  });

  it("disappears once the vendor has a paid test-buy", async () => {
    const { req, store } = setup();
    await store.addUnsettledAttempt({ vendor_id: "edge-agents", endpoint: ep, ts: NOW - DAY, network: "xrpl:0", tx_hash: H("C1"), amount: "0.01", asset: "RLUSD", http_status: 402, detail: null });
    expect((await list(req)).find((v) => v.id === "edge-agents").payment_attempts.count).toBe(1);
    const { req: reqB, store: storeB } = setup();
    await storeB.addUnsettledAttempt({ vendor_id: "edge-agents", endpoint: ep, ts: NOW - DAY, network: "xrpl:0", tx_hash: H("C1"), amount: "0.01", asset: "RLUSD", http_status: 402, detail: null });
    await storeB.addObservation({ vendor_id: "edge-agents", endpoint: ep, ts: NOW - 3_600_000, network: "xrpl:0", tx_hash: H("C2"), amount: "0.01", asset: "RLUSD", http_status: 200, data_returned: true, latency_ms: 500, summary: "HTTP 200; response contained data.", source: "lumi_test_buy" });
    expect((await list(reqB)).find((v) => v.id === "edge-agents").payment_attempts).toBeUndefined();
  });

  it("rejects a payment that settled on-ledger, foreign hosts and bad input", async () => {
    const { req } = setup({ txs: { [H("D1")]: { from: BUYER, to: EDGE.pay_to.xrpl[0], delivered: { currency: RLUSD.currency, issuer: RLUSD.issuer, value: "0.01" } } } });
    const settled = await req("/v1/trust/attempts", { method: "POST", body: body(H("D1"), "2026-10-22T03:00:00Z"), headers: auth });
    expect(settled.status).toBe(409);
    expect(((await settled.json()) as any).reason).toBe("payment_on_ledger");
    expect((await req("/v1/trust/attempts", { method: "POST", body: body(H("D2"), "2026-10-22T03:00:00Z", { endpoint: "https://evil.example/x" }), headers: auth })).status).toBe(400);
    expect((await req("/v1/trust/attempts", { method: "POST", body: body("nothex", "2026-10-22T03:00:00Z"), headers: auth })).status).toBe(400);
    expect((await req("/v1/trust/attempts", { method: "POST", body: body(H("D3"), "2027-01-01T00:00:00Z"), headers: auth })).status).toBe(400);
    expect((await req("/v1/trust/attempts", { method: "POST", body: body(H("D4"), "2026-10-22T03:00:00Z", { detail: "this is a scam" }), headers: auth })).status).toBe(400);
  });

  it("answers 503 when the ledger is unreachable (nothing stored)", async () => {
    const { req, store } = setup({ ledgerDown: true });
    expect((await req("/v1/trust/attempts", { method: "POST", body: body(H("E1"), "2026-10-22T03:00:00Z"), headers: auth })).status).toBe(503);
    expect((await store.unsettledAttempts("edge-agents")).count).toBe(0);
  });
});
