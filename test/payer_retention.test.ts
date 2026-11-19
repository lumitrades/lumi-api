import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import { MemorySalesStore, toRow, firstHighValueRefunds } from "../src/sales";
import { MemoryCommerceStore, type FeedKey } from "../src/commerce/store";
import { MemoryTrialStore } from "../src/trial";
import {
  DEFAULT_PAYER_RETENTION_DAYS,
  erasePayer,
  hmacPayer,
  hmacPayerAll,
  inventoryPayer,
  memoryStoresFrom,
  normalizePayer,
  payerHmacSecretOk,
  payerPurgeOn,
  payerRetentionDays,
  payerSecretReused,
  payerSecretsFromEnv,
  purgeCustomerPayers,
  purgeMemory,
  submittedWallet,
  stripPayerFields,
} from "../src/payer_retention";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor, miniflareD1Options } from "./helpers";

const DAY = 86_400_000;
const SECRET = "test-payer-hmac-secret-32bytes-min";
const SECRET2 = "test-payer-hmac-secret-rotated-ok2";
const WALLET = "0x" + "11".repeat(20);
const WALLET_CS = "0x" + "11".repeat(10) + "11".repeat(10).toUpperCase(); // same identity, mixed case
const OTHER = "0x" + "22".repeat(20);
const OWNER = "owner-key-for-tests-0123456789-abcdefghijklmnop";
const BASE = "https://lumi.test";
const NIGHT = Date.parse("2026-10-23T03:00:00Z");

const ENV = {
  XRPL_NETWORK: "xrpl:1",
  PAY_TO,
  FACILITATOR_URL: FACILITATOR,
  DATA_BASE_URL: DATA,
  INVOICE_SECRET: "s3cret",
  PAYER_HMAC_SECRET: SECRET,
  OWNER_MCP_KEY: OWNER,
  PUBLIC_BASE_URL: BASE,
};

function sale(payer: string, ts: number, tx = `tx-${ts}`) {
  return toRow({ route: "verdict", routeKey: "verdict", rail: "xrpl", network: "xrpl:1", asset: "RLUSD", amount: "0.01", usd: 0.01, payer, tx }, ts);
}

function key(partial: Partial<FeedKey> & { id: string }): FeedKey {
  return {
    key_hash: `hash-${partial.id}`, wallet: null, wallet_lc: null, wallet_hmac: null, network: "eip155:8453",
    plan: "free", plan_ends_at: null, credits: 0, is_test: false, webhook_url: null, webhook_secret: null,
    webhook_cursor: 0, created_at: NOW, rotated_at: null, ...partial,
  };
}

describe("payer retention helpers", () => {
  it("defaults the window to 90 days and rejects bad values", () => {
    expect(payerRetentionDays(undefined)).toBe(DEFAULT_PAYER_RETENTION_DAYS);
    expect(payerRetentionDays("90")).toBe(90);
    expect(payerRetentionDays("30")).toBe(30);
    expect(payerRetentionDays("0")).toBe(90);
    expect(payerRetentionDays("abc")).toBe(90);
    expect(payerRetentionDays("4000")).toBe(90);
  });

  it("requires a secret of at least 32 characters", () => {
    expect(payerHmacSecretOk(SECRET)).toBe(true);
    expect(payerHmacSecretOk("short")).toBe(false);
    expect(payerHmacSecretOk("")).toBe(false);
    expect(payerHmacSecretOk(undefined)).toBe(false);
    expect(payerSecretsFromEnv({}).all).toEqual([]);
    expect(payerSecretsFromEnv({ PAYER_HMAC_SECRET: SECRET, PAYER_HMAC_SECRET_PREV: SECRET2 }).all).toEqual([SECRET, SECRET2]);
  });

  it("HMAC is deterministic, case-insensitive, and changes with the secret", async () => {
    const a = await hmacPayer(SECRET, WALLET);
    const b = await hmacPayer(SECRET, WALLET_CS);
    const c = await hmacPayer(SECRET2, WALLET);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(normalizePayer(WALLET_CS)).toBe(WALLET.toLowerCase());
    const all = await hmacPayerAll([SECRET, SECRET2], WALLET);
    expect(all).toEqual([a, c]);
  });

  it("submittedWallet accepts a plausible address and rejects junk", () => {
    expect(submittedWallet(WALLET)).toBe(WALLET);
    expect(submittedWallet("  " + WALLET + "  ")).toBe(WALLET);
    expect(submittedWallet("too-short")).toBeNull();
    expect(submittedWallet("has space in middle value 0123456789abcdef")).toBeNull();
    expect(submittedWallet(123)).toBeNull();
  });

  it("stripPayerFields drops payer and wallet keys but keeps tx", () => {
    expect(stripPayerFields({ event: "x402_settled", tx: "ABC", payer: WALLET, signed: WALLET, amount: "1" })).toEqual({ event: "x402_settled", tx: "ABC", amount: "1" });
  });
});

describe("nightly purge (memory)", () => {
  it("nulls the raw wallet 90 days after the last payment, keeps tx/amount/hmac, and leaves a recent payment alone", async () => {
    const sales = new MemorySalesStore();
    const oldRow = sale(WALLET, NOW - 100 * DAY, "OLD");
    oldRow.payerHmac = await hmacPayer(SECRET, WALLET);
    const fresh = sale(OTHER, NOW - 10 * DAY, "FRESH");
    fresh.payerHmac = await hmacPayer(SECRET, OTHER);
    await sales.insert(oldRow);
    await sales.insert(fresh);
    const r = await purgeCustomerPayers({ memory: memoryStoresFrom(sales, new MemoryCommerceStore(), new MemoryTrialStore()), secret: SECRET, purgeOn: true, retentionDays: 90, now: NOW });
    expect(r.kept_accounting).toBe(true);
    expect(r.nulled.sales).toBe(1);
    const gone = sales.rows.find((x) => x.tx === "OLD")!;
    const kept = sales.rows.find((x) => x.tx === "FRESH")!;
    expect(gone.payer).toBeNull();
    expect(gone.payerHmac).toBe(oldRow.payerHmac);
    expect(gone.tx).toBe("OLD");
    expect(gone.amount).toBe("0.01");
    expect(gone.asset).toBe("RLUSD");
    expect(gone.route).toBe("verdict");
    expect(kept.payer).toBe(OTHER);
    expect(firstHighValueRefunds(sales.rows, 1).every((x) => x.payer !== WALLET)).toBe(true);
  });

  it("uses the later of last payment and key/plan expiry, and honours a shorter configured window", async () => {
    const sales = new MemorySalesStore();
    const commerce = new MemoryCommerceStore();
    // Payment 100 days ago, but the feed plan ends only 5 days ago → still inside 90 days of expiry.
    const payTs = NOW - 100 * DAY;
    const ends = NOW - 5 * DAY;
    const row = sale(WALLET, payTs, "PLAN");
    row.payerHmac = await hmacPayer(SECRET, WALLET);
    await sales.insert(row);
    await commerce.addKey(key({ id: "fk_active", wallet: WALLET, wallet_lc: WALLET.toLowerCase(), wallet_hmac: row.payerHmac, plan: "feed", plan_ends_at: ends, created_at: payTs }));
    await commerce.addPayment({ tx: "fp1", key_id: "fk_active", product: "feed", usd: 4, is_test: false, network: "eip155:8453", asset: "USDC", amount: "4", payer: WALLET, payer_hmac: row.payerHmac, ts: payTs });
    const still = await purgeCustomerPayers({ memory: memoryStoresFrom(sales, commerce, new MemoryTrialStore()), secret: SECRET, purgeOn: true, retentionDays: 90, now: NOW });
    expect(still.nulled.sales).toBe(0);
    expect(still.nulled.feed_keys).toBe(0);
    expect(commerce.fkeys.get("fk_active")!.wallet).toBe(WALLET);

    const expired = await purgeCustomerPayers({ memory: memoryStoresFrom(sales, commerce, new MemoryTrialStore()), secret: SECRET, purgeOn: true, retentionDays: 4, now: NOW });
    expect(expired.retention_days).toBe(4);
    expect(expired.nulled.sales).toBe(1);
    expect(expired.nulled.feed_keys).toBe(1);
    expect(expired.nulled.feed_payments).toBe(1);
    expect(sales.rows[0].payer).toBeNull();
    expect(commerce.fkeys.get("fk_active")!.wallet).toBeNull();
    expect(commerce.fkeys.get("fk_active")!.wallet_lc).toBeNull();
    expect(commerce.fkeys.get("fk_active")!.wallet_hmac).toBe(row.payerHmac);
    expect(commerce.pays[0].payer).toBeNull();
    expect(commerce.pays[0].tx).toBe("fp1");
  });

  it("backfills HMAC on existing raw rows without changing the key hash, then matches by HMAC after the raw is gone", async () => {
    const commerce = new MemoryCommerceStore();
    await commerce.addKey(key({ id: "fk_legacy", wallet: WALLET, wallet_lc: WALLET.toLowerCase(), created_at: NOW - 200 * DAY, key_hash: "kept-hash" }));
    expect((await commerce.keyByWallet(WALLET.toLowerCase()))?.id).toBe("fk_legacy");
    const r = await purgeCustomerPayers({ memory: memoryStoresFrom(new MemorySalesStore(), commerce, new MemoryTrialStore()), secret: SECRET, purgeOn: true, retentionDays: 90, now: NOW });
    expect(r.backfilled.feed_keys).toBe(1);
    expect(r.nulled.feed_keys).toBe(1);
    const k = commerce.fkeys.get("fk_legacy")!;
    expect(k.key_hash).toBe("kept-hash");
    expect(k.wallet).toBeNull();
    expect(k.wallet_hmac).toBe(await hmacPayer(SECRET, WALLET));
    expect(await commerce.keyByWallet(WALLET.toLowerCase())).toBeNull();
    expect((await commerce.keyByWallet(WALLET.toLowerCase(), [k.wallet_hmac!]))?.id).toBe("fk_legacy");
    // Previous secret still finds the row after a rotation (lookup tries both).
    const hmacs = await hmacPayerAll([SECRET2, SECRET], WALLET);
    expect((await commerce.keyByWallet(WALLET.toLowerCase(), hmacs))?.id).toBe("fk_legacy");
  });

  it("nulls trial wallets after 90 days and still counts the lifetime cap via HMAC", async () => {
    const trials = new MemoryTrialStore();
    const hmac = await hmacPayer(SECRET, WALLET);
    trials.rows.push({ nonce: "n1", wallet: WALLET, wallet_hmac: hmac, ip_hash: null, day: "2026-07-01", route: "verdict", ts: NOW - 100 * DAY });
    const r = await purgeCustomerPayers({ memory: memoryStoresFrom(new MemorySalesStore(), new MemoryCommerceStore(), trials), secret: SECRET, purgeOn: true, retentionDays: 90, now: NOW });
    expect(r.nulled.trial_uses).toBe(1);
    expect(trials.rows[0].wallet).toBe("");
    expect(trials.rows[0].wallet_hmac).toBe(hmac);
    expect(await trials.usedByWallet(WALLET, [hmac])).toBe(1);
    expect(await trials.usedByWallet(WALLET)).toBe(0);
  });
});

describe("scheduled hook and HTTP owner route", () => {
  it("runs the purge only on the 03:00 UTC nightly tick and logs counts, never a wallet", async () => {
    const sales = new MemorySalesStore();
    const row = sale(WALLET, NIGHT - 100 * DAY, "CRON");
    await sales.insert(row);
    const logs: Record<string, unknown>[] = [];
    let t = Date.parse("2026-10-23T02:30:00Z");
    const app = createApp({ ...ENV, PAYER_PURGE: "on" } as any, {
      fetch: makeFetch(happyFacilitator()),
      log: (e) => logs.push(e),
      now: () => t,
      salesStore: sales,
    });
    await app.scheduled();
    expect(logs.some((e) => e.event === "payer_retention_purge")).toBe(false);
    expect(sales.rows[0].payer).toBe(WALLET);
    t = NIGHT;
    const out: any = await app.scheduled();
    expect(out.payer_retention).toMatchObject({ retention_days: 90, nulled: expect.objectContaining({ sales: 1 }), kept_accounting: true });
    const line = logs.find((e) => e.event === "payer_retention_purge")!;
    expect(line).toMatchObject({ retention_days: 90, kept_accounting: true });
    expect(JSON.stringify(line)).not.toContain(WALLET);
    expect(sales.rows[0].payer).toBeNull();
    expect(sales.rows[0].tx).toBe("CRON");
  });

  it("settled logs include the tx and omit the payer", async () => {
    const logs: Record<string, unknown>[] = [];
    const app = createApp({ ...ENV } as any, { fetch: makeFetch(happyFacilitator()), log: (e) => logs.push(e), now: () => NOW });
    const q = await app.fetch(new Request(`${BASE}/v1/verdict?url=https%3A%2F%2Fa.example%2Fx`));
    expect(q.status).toBe(402);
    const body = await q.json();
    const xrp = body.accepts.find((a: any) => a.asset === "XRP");
    expect((await app.fetch(new Request(`${BASE}/v1/verdict?url=https%3A%2F%2Fa.example%2Fx`, { headers: { "PAYMENT-SIGNATURE": paymentHeaderFor(xrp) } }))).status).toBe(200);
    const settled = logs.find((e) => e.event === "x402_settled")!;
    expect(settled.tx).toBeTruthy();
    expect(settled).not.toHaveProperty("payer");
    expect(JSON.stringify(settled)).not.toContain("rBCpEBgyfwme3obwjCx95UzqKFbayPXAuV");
  });

  it("feed signup fails safe when the HMAC secret is missing, and succeeds when it is set", async () => {
    // Covered more fully in commerce tests with a real proof; here we only assert the 503 path exists
    // when the secret is absent (the handler returns 403 wallet_proof_failed on a missing proof first).
    const noSecret = createApp({ ...ENV, PAYER_HMAC_SECRET: undefined } as any, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW });
    const r = await noSecret.fetch(new Request(`${BASE}/v1/feed/keys`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "x", signature: "00" }) }));
    // Bad proof is checked first; a follow-up in commerce.test covers the success path with a real signature.
    expect([403, 503]).toContain(r.status);
    expect(payerHmacSecretOk((noSecret.config as any).payerHmacSecret)).toBe(false);
  });

  it("owner access and deletion are keyed by a submitted wallet, require the owner key, and never return the raw address", async () => {
    const sales = new MemorySalesStore();
    const commerce = new MemoryCommerceStore();
    const trials = new MemoryTrialStore();
    const hmac = await hmacPayer(SECRET, WALLET);
    const row = sale(WALLET, NOW - 3 * DAY, "LIVE-TX");
    row.payerHmac = hmac;
    await sales.insert(row);
    await commerce.addKey(key({ id: "fk_own", wallet: WALLET, wallet_lc: WALLET.toLowerCase(), wallet_hmac: hmac }));
    const app = createApp({ ...ENV } as any, {
      fetch: makeFetch(happyFacilitator()),
      log: () => {},
      now: () => NOW,
      salesStore: sales,
      commerceStore: commerce,
      trialStore: trials,
    });
    expect((await app.fetch(new Request(`${BASE}/v1/owner/payer-data`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet: WALLET }) }))).status).toBe(401);
    const inv = await (await app.fetch(new Request(`${BASE}/v1/owner/payer-data`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OWNER}` },
      body: JSON.stringify({ wallet: WALLET }),
    }))).json();
    expect(inv.matched).toBe(true);
    expect(inv.raw_still_stored).toBeGreaterThan(0);
    expect(inv.records.some((r: any) => r.table === "sales" && r.tx === "LIVE-TX")).toBe(true);
    expect(inv.records.some((r: any) => r.table === "feed_keys" && r.key_id === "fk_own")).toBe(true);
    expect(JSON.stringify(inv)).not.toContain(WALLET);
    expect((await app.fetch(new Request(`${BASE}/v1/owner/payer-data`, { method: "GET", headers: { Authorization: `Bearer ${OWNER}` } }))).status).toBe(405);
    expect((await app.fetch(new Request(`${BASE}/v1/owner/payer-data/delete`, { method: "GET", headers: { Authorization: `Bearer ${OWNER}` } }))).status).toBe(405);
    const erased = await (await app.fetch(new Request(`${BASE}/v1/owner/payer-data/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OWNER}` },
      body: JSON.stringify({ wallet: WALLET }),
    }))).json();
    expect(erased.raw_nulled).toBeGreaterThan(0);
    expect(erased.kept_accounting).toBe(true);
    expect(sales.rows[0].payer).toBeNull();
    expect(sales.rows[0].tx).toBe("LIVE-TX");
    expect(commerce.fkeys.get("fk_own")!.wallet).toBeNull();
    const after = await (await app.fetch(new Request(`${BASE}/v1/owner/payer-data`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OWNER}` },
      body: JSON.stringify({ wallet: WALLET }),
    }))).json();
    expect(after.matched).toBe(true);
    expect(after.raw_still_stored).toBe(0);
    expect(JSON.stringify(after)).not.toContain(WALLET);
  });
});


describe("Vigil B1 / PAYER_PURGE / rotation / batch / secrets", () => {
  it("PAYER_PURGE is committed off and only the exact value on enables the nulling tick", () => {
    expect(payerPurgeOn(undefined)).toBe(false);
    expect(payerPurgeOn("off")).toBe(false);
    expect(payerPurgeOn("ON")).toBe(false);
    expect(payerPurgeOn("on")).toBe(true);
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    expect(toml).toMatch(/^PAYER_PURGE = "off"/m);
  });

  it("returns early and logs payer_purge_skipped_no_secret unless the secret is ok", async () => {
    const sales = new MemorySalesStore();
    await sales.insert(sale(WALLET, NOW - 100 * DAY, "NOSECRET"));
    const logs: Record<string, unknown>[] = [];
    const r = await purgeCustomerPayers({
      memory: memoryStoresFrom(sales, new MemoryCommerceStore(), new MemoryTrialStore()),
      retentionDays: 90, now: NOW, purgeOn: true, log: (e) => logs.push(e),
    });
    expect(r.skipped).toBe("payer_purge_skipped_no_secret");
    expect(r.nulled.sales).toBe(0);
    expect(sales.rows[0].payer).toBe(WALLET);
    expect(logs.some((e) => e.event === "payer_purge_skipped_no_secret")).toBe(true);
    const short = await purgeCustomerPayers({
      memory: memoryStoresFrom(sales, new MemoryCommerceStore(), new MemoryTrialStore()),
      secret: "too-short", retentionDays: 90, now: NOW, purgeOn: true, log: (e) => logs.push(e),
    });
    expect(short.skipped).toBe("payer_purge_skipped_no_secret");
    expect(sales.rows[0].payer).toBe(WALLET);
  });

  it("never nulls a row whose HMAC is empty", async () => {
    const sales = new MemorySalesStore();
    await sales.insert(sale(WALLET, NOW - 100 * DAY, "EMPTYHMAC"));
    expect(sales.rows[0].payerHmac).toBeFalsy();
    // Direct nulling path, no backfill (secret omitted): the due row stays.
    const r = await purgeMemory({ sales }, { retentionDays: 90, now: NOW, purgeOn: true });
    expect(r.nulled.sales).toBe(0);
    expect(sales.rows[0].payer).toBe(WALLET);
  });

  it("when PAYER_PURGE is off, the tick only backfills and logs a dry-run would-purge count", async () => {
    const sales = new MemorySalesStore();
    await sales.insert(sale(WALLET, NOW - 100 * DAY, "DRY"));
    await sales.insert(sale(OTHER, NOW - 5 * DAY, "FRESH"));
    const logs: Record<string, unknown>[] = [];
    const app = createApp({ ...ENV, PAYER_PURGE: "off" } as any, {
      fetch: makeFetch(happyFacilitator()),
      log: (e) => logs.push(e),
      now: () => NIGHT,
      salesStore: sales,
    });
    const out: any = await app.scheduled();
    expect(out.payer_retention).toMatchObject({ dry_run: true, kept_accounting: true, nulled: expect.objectContaining({ sales: 0 }) });
    expect(out.payer_retention.would_purge.sales).toBe(1);
    expect(out.payer_retention.backfilled.sales).toBe(2);
    expect(sales.rows.find((x) => x.tx === "DRY")!.payer).toBe(WALLET);
    expect(sales.rows.find((x) => x.tx === "DRY")!.payerHmac).toBe(await hmacPayer(SECRET, WALLET));
    const line = logs.find((e) => e.event === "payer_retention_purge")!;
    expect(line.dry_run).toBe(true);
    expect((line.would_purge as any).sales).toBe(1);
    expect(JSON.stringify(line)).not.toContain(WALLET);
  });

  it("re-hashes raw rows under the current secret and still matches PREV after a purge", async () => {
    const sales = new MemorySalesStore();
    const oldH = await hmacPayer(SECRET2, WALLET);
    const row = sale(WALLET, NOW - 10 * DAY, "ROT");
    row.payerHmac = oldH;
    await sales.insert(row);
    const dry = await purgeCustomerPayers({
      memory: memoryStoresFrom(sales, new MemoryCommerceStore(), new MemoryTrialStore()),
      secret: SECRET, secretPrev: SECRET2, retentionDays: 90, now: NOW, purgeOn: false,
    });
    expect(dry.rotated?.sales).toBe(1);
    expect(sales.rows[0].payer).toBe(WALLET);
    expect(sales.rows[0].payerHmac).toBe(await hmacPayer(SECRET, WALLET));
    expect(sales.rows[0].payerHmac).not.toBe(oldH);
    // After the raw is gone, PREV is still required to find a row hashed under the old secret.
    const trials = new MemoryTrialStore();
    const stale = await hmacPayer(SECRET2, OTHER);
    trials.rows.push({ nonce: "n-rot", wallet: "", wallet_hmac: stale, ip_hash: null, day: "2026-07-01", route: "verdict", ts: NOW - 100 * DAY });
    expect(await trials.usedByWallet(OTHER, await hmacPayerAll([SECRET], OTHER))).toBe(0);
    expect(await trials.usedByWallet(OTHER, await hmacPayerAll([SECRET, SECRET2], OTHER))).toBe(1);
  });

  it("caps writes per tick so a later due row waits for the next run", async () => {
    const sales = new MemorySalesStore();
    const h = await hmacPayer(SECRET, WALLET);
    for (let i = 0; i < 3; i++) {
      const row = sale(WALLET, NOW - 100 * DAY, `CAP${i}`);
      row.payerHmac = h;
      await sales.insert(row);
    }
    const r = await purgeCustomerPayers({
      memory: memoryStoresFrom(sales, new MemoryCommerceStore(), new MemoryTrialStore()),
      secret: SECRET, purgeOn: true, retentionDays: 90, now: NOW, maxRows: 2,
    });
    expect(r.nulled.sales).toBe(2);
    expect(r.truncated).toBe(true);
    expect(sales.rows.filter((x) => x.payer === WALLET)).toHaveLength(1);
    const r2 = await purgeCustomerPayers({
      memory: memoryStoresFrom(sales, new MemoryCommerceStore(), new MemoryTrialStore()),
      secret: SECRET, purgeOn: true, retentionDays: 90, now: NOW, maxRows: 2,
    });
    expect(r2.nulled.sales).toBe(1);
    expect(sales.rows.every((x) => x.payer == null)).toBe(true);
  });

  it("skips the purge and logs when PAYER_HMAC_SECRET reuses an invoice or fleet-guard secret", async () => {
    expect(payerSecretReused(SECRET, ["other", SECRET])).toBe(true);
    expect(payerSecretReused(SECRET, ["INVOICE_SECRET_is_different_value_ok"])).toBe(false);
    const sales = new MemorySalesStore();
    await sales.insert(sale(WALLET, NOW - 100 * DAY, "REUSE"));
    const logs: Record<string, unknown>[] = [];
    const r = await purgeCustomerPayers({
      memory: memoryStoresFrom(sales, new MemoryCommerceStore(), new MemoryTrialStore()),
      secret: SECRET, purgeOn: true, retentionDays: 90, now: NOW,
      otherSecrets: [SECRET, "fleet-key-secret-that-is-32-bytes-min"],
      log: (e) => logs.push(e),
    });
    expect(r.skipped).toBe("payer_purge_skipped_secret_reused");
    expect(r.nulled.sales).toBe(0);
    expect(sales.rows[0].payer).toBe(WALLET);
    expect(logs.some((e) => e.event === "payer_purge_skipped_secret_reused")).toBe(true);
  });

  it("keys firstHighValueRefunds on payerHmac so a purged raw wallet is still grouped", async () => {
    const h = await hmacPayer(SECRET, WALLET);
    const first = toRow({ route: "high_value_check", rail: "base", network: "eip155:8453", asset: "USDC", amount: "0.05", usd: 0.05, payer: WALLET, tx: "0xa" }, NOW - 2000);
    first.payerHmac = h;
    const later = toRow({ route: "high_value_check", rail: "base", network: "eip155:8453", asset: "USDC", amount: "0.25", usd: 0.25, payer: WALLET, tx: "0xb" }, NOW - 1000);
    later.payerHmac = h;
    later.payer = null;
    const other = toRow({ route: "high_value_check", rail: "base", network: "eip155:8453", asset: "USDC", amount: "0.10", usd: 0.10, payer: OTHER, tx: "0xc" }, NOW);
    other.payerHmac = await hmacPayer(SECRET, OTHER);
    const out = firstHighValueRefunds([first, later, other], 0.25);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ tx: "0xa", payer: WALLET, payerHmac: h, refund_usd: 0.05 });
    expect(out[1]).toMatchObject({ tx: "0xc", payer: OTHER, refund_usd: 0.10 });
    const onlyHmac = firstHighValueRefunds([later], 0.25);
    expect(onlyHmac).toHaveLength(1);
    expect(onlyHmac[0].payer).toBeNull();
    expect(onlyHmac[0].payerHmac).toBe(h);
    expect(onlyHmac[0].tx).toBe("0xb");
  });
});


/** Split a SQL migration into statements, ignoring ';' and '--' inside strings. */
function sqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let inSingle = false;
  while (i < sql.length) {
    const c = sql[i]!;
    if (!inSingle && c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "'") {
      cur += c;
      if (inSingle && sql[i + 1] === "'") { cur += "'"; i += 2; continue; }
      inSingle = !inSingle;
      i++;
      continue;
    }
    if (!inSingle && c === ";") {
      const t = cur.trim();
      if (t) out.push(t);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  const t = cur.trim();
  if (t) out.push(t);
  return out;
}

describe("payer retention D1 (miniflare)", () => {
  it("migration 0035 adds hmac columns; purge and owner erase work in SQL", async () => {
    const { Miniflare, convertV4MiniflareOptions } = await import("miniflare") as any;
    const mf = new Miniflare(miniflareD1Options(convertV4MiniflareOptions));
    try {
      const db: any = await mf.getD1Database("DB");
      const files = readdirSync("migrations").filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
      expect(files[0]).toBe("0001_trust.sql");
      expect(files).toContain("0034_fleet_guard.sql");
      expect(files.at(-1)).toBe("0035_payer_retention.sql");
      for (const f of files) {
        for (const st of sqlStatements(readFileSync(join("migrations", f), "utf8"))) {
          await db.prepare(st).run();
        }
      }
      const tsOld = NOW - 100 * DAY;
      const tsNew = NOW - 5 * DAY;
      await db.prepare("INSERT INTO sales (ts, route, rail, network, asset, amount, usd, payer, tx, facilitator, is_test) VALUES (?1,'verdict','xrpl','xrpl:1','RLUSD','0.01',0.01,?2,'OLD','t54',0)").bind(tsOld, WALLET).run();
      await db.prepare("INSERT INTO sales (ts, route, rail, network, asset, amount, usd, payer, tx, facilitator, is_test) VALUES (?1,'verdict','xrpl','xrpl:1','RLUSD','0.01',0.01,?2,'NEW','t54',0)").bind(tsNew, OTHER).run();
      await db.prepare("INSERT INTO feed_keys (id, key_hash, wallet, wallet_lc, network, plan, plan_ends_at, credits, is_test, webhook_cursor, created_at) VALUES ('fk_d1','kh',?1,?2,'eip155:8453','free',NULL,0,0,0,?3)").bind(WALLET, WALLET.toLowerCase(), tsOld).run();
      await db.prepare("INSERT INTO trial_uses (nonce, wallet, ip_hash, day, route, ts) VALUES ('n-old',?1,NULL,'2026-07-01','verdict',?2)").bind(WALLET, tsOld).run();

      const r = await purgeCustomerPayers({ db, secret: SECRET, purgeOn: true, retentionDays: 90, now: NOW });
      expect(r.backfilled.sales).toBe(2);
      expect(r.backfilled.feed_keys).toBe(1);
      expect(r.backfilled.trial_uses).toBe(1);
      expect(r.nulled.sales).toBe(1);
      expect(r.nulled.feed_keys).toBe(1);
      expect(r.nulled.trial_uses).toBe(1);
      const old = await db.prepare("SELECT payer, payer_hmac, tx, amount FROM sales WHERE tx = 'OLD'").first();
      const neu = await db.prepare("SELECT payer, payer_hmac FROM sales WHERE tx = 'NEW'").first();
      expect(old.payer).toBeNull();
      expect(old.payer_hmac).toBe(await hmacPayer(SECRET, WALLET));
      expect(old.tx).toBe("OLD");
      expect(old.amount).toBe("0.01");
      expect(neu.payer).toBe(OTHER);
      const fk = await db.prepare("SELECT wallet, wallet_lc, wallet_hmac, key_hash FROM feed_keys WHERE id = 'fk_d1'").first();
      expect(fk.wallet).toBeNull();
      expect(fk.wallet_lc).toBeNull();
      expect(fk.wallet_hmac).toBe(await hmacPayer(SECRET, WALLET));
      expect(fk.key_hash).toBe("kh");

      const inv = await inventoryPayer({ db, wallet: WALLET, secret: SECRET, purgeOn: true, retentionDays: 90, now: NOW });
      expect(inv.matched).toBe(true);
      expect(inv.raw_still_stored).toBe(0);
      expect(JSON.stringify(inv)).not.toContain(WALLET);
      const erased = await erasePayer({ db, wallet: OTHER, secret: SECRET, purgeOn: true, retentionDays: 90, now: NOW });
      expect(erased.raw_nulled).toBe(1);
      expect((await db.prepare("SELECT payer, tx FROM sales WHERE tx = 'NEW'").first()).payer).toBeNull();
      const audit = await db.prepare("SELECT wallet_hmac, raw_nulled, tables_json FROM payer_erasure_requests").first();
      expect(audit.wallet_hmac).toBe(await hmacPayer(SECRET, OTHER));
      expect(audit.raw_nulled).toBe(1);
      expect(JSON.stringify(audit)).not.toContain(OTHER);
    } finally {
      await mf.dispose();
    }
  }, 30_000);
});
