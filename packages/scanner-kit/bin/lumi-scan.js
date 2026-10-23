#!/usr/bin/env node
/**
 * lumi-scan: Lumi Scanner Kit CLI (v0, DRAFT).
 *   keygen [--out path]                         create a contributor key (prints the PUBLIC key only)
 *   quote <url> [--method POST --body '{}']     free 402 quote check (never pays)
 *   wanted [--network xrpl:0] [--limit 5]       what Lumi would like tested next
 *   report --endpoint URL --network N --tx HASH --status 200 --outcome delivered [--submit]
 *                                               passive: receipt for a purchase you already made
 *   buy <url> [--network N] [--live] [--submit] optional capped test-buy (dry run unless --live)
 *   me | share-demand on|off                    your credits / opt in to aggregate-only demand stats
 * Env: LUMI_API, LUMI_KIT_KEY (contributor key file), LUMI_KIT_XRPL_SEED(_FILE), LUMI_KIT_STELLAR_SECRET(_FILE), LUMI_KIT_EVM_KEY(_FILE),
 *      LUMI_KIT_MAX_PER_BUY, LUMI_KIT_MAX_PER_DAY, LUMI_KIT_MAX_BUYS_PER_DAY.
 * Wallet secrets are read from env or a file and are never printed or sent anywhere.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import * as kit from "../src/index.js";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => { const i = argv.indexOf("--" + n); return i > 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes("--" + n);
const pos = argv.slice(1).filter((a, i, l) => !a.startsWith("--") && !(l[i - 1] ?? "").startsWith("--"));
const out = (o) => console.log(kit.redact(JSON.stringify(o, null, 2)));
const keyPath = () => flag("key") || process.env.LUMI_KIT_KEY || join(homedir(), ".lumi-scanner-kit", "contributor_key.json");
const client = () => { const k = kit.loadKey(keyPath()); if (!k.key_id) throw new Error(`no key_id in ${keyPath()}: add the key_id Lumi issued`); return kit.createLumiClient({ api: process.env.LUMI_API, keyId: k.key_id, privateKey: k.private_key }); };
const signer = async (network) => kit.signerFor(network, await kit.secretFromEnv(network));

async function main() {
  if (cmd === "keygen") {
    const p = flag("out") || keyPath();
    const k = kit.generateKey();
    kit.saveKey(p, k);
    return out({ saved: p, public_key: k.public_key, next: "Send Lumi this public key and the wallet addresses you pay from. Add the key_id you receive to the key file." });
  }
  if (cmd === "quote") return out(await kit.checkQuote(pos[0], { method: flag("method") ?? "GET", body: flag("body") }).then(({ accepts, payment_required, ...r }) => r));
  if (cmd === "wanted") return out(await client().wanted({ network: flag("network"), limit: flag("limit") }));
  if (cmd === "me") return out(await client().me());
  if (cmd === "share-demand") return out(await client().shareDemand(pos[0] === "on"));
  if (cmd === "report") {
    const network = flag("network");
    const r = await kit.reportPurchase({
      endpoint: flag("endpoint"), network, tx_hash: flag("tx"), pay_to: flag("pay-to"), http_status: Number(flag("status") ?? 0), outcome: flag("outcome") ?? "delivered",
      latency_ms: flag("latency") ? Number(flag("latency")) : undefined, observed_at: flag("observed-at"), signer: await signer(network), mode: "passive",
    });
    if (!has("submit")) return out({ receipt: r, note: "Not submitted. Add --submit to send it to Lumi." });
    return out(await client().submit(r, "passive"));
  }
  if (cmd === "buy") {
    const networks = (flag("networks") ?? flag("network") ?? "xrpl:0").split(",");
    const res = await kit.testBuy({ url: pos[0], method: flag("method") ?? "GET", body: flag("body"), networks, network: flag("network"), live: has("live"), secretFor: (n) => kit.secretFromEnv(n) });
    if (!res.ok || res.dry_run) { const { quote, ...rest } = res; return out({ ...rest, quotes: quote?.quotes }); }
    const s = await signer(res.plan.network);
    const receipt = await kit.reportPurchase({
      endpoint: pos[0], network: res.plan.network, tx_hash: res.tx_hash, pay_to: res.plan.pay_to, http_status: res.http_status, outcome: res.outcome, latency_ms: res.measurements.latency_ms,
      observed_at: res.observed_at, measurements: res.measurements, signer: s, mode: "test_buy",
    });
    if (!has("submit")) return out({ tx_hash: res.tx_hash, outcome: res.outcome, receipt, note: "Not submitted. Add --submit to send it to Lumi." });
    return out({ tx_hash: res.tx_hash, outcome: res.outcome, lumi: await client().submit(receipt, "test_buy") });
  }
  console.log("usage: lumi-scan keygen | quote <url> | wanted | report ... | buy <url> [--live] | me | share-demand on|off");
  process.exitCode = cmd ? 2 : 0;
}
main().catch((e) => { console.error(kit.redact("error: " + (e?.message ?? e))); process.exitCode = 1; });
