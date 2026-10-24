#!/usr/bin/env node
/**
 * lumi-scan: Lumi Check CLI (v0, DRAFT).
 *   keygen [--out path]                         create a contributor key (prints the PUBLIC key only)
 *   quote <url> [--method POST --body '{}']     free 402 quote check (never pays)
 *   wanted [--network xrpl:0] [--limit 5]       what Lumi would like tested next
 *   report --endpoint URL --network N --tx HASH --status 200 --outcome delivered [--submit]
 *                                               passive: receipt for a purchase you already made
 *   buy <url> [--network N] [--live] [--submit] optional capped test-buy (dry run unless --live)
 *   me | share-demand on|off                    your badge and receipts / opt in to aggregate-only demand stats
 *   check <url> [--pay-to X --amount 0.01 --network N]   free signed pre-pay check (allow / warn / block); after the
 *                                               FIRST check, asks once: "Share your results ...? [Y/n]" (terminal only)
 *   setup [--sharing on|off] [--telemetry on|off] show what is shared, then save your choices
 *   telemetry on|off|status                     tier 1 anonymous delivery outcomes ("share your results"; OFF until you say yes)
 *   sharing on|off|status                       tier 2 full signed receipts (OFF by default; shares a public transaction ID; badge only)
 *   account delete [--confirm <key_id>]         delete your contributor account (asks you to type your key id)
 *   prove-wallet --network N [--submit]         sign a wallet-control proof (send it with your registration, or --submit)
 * Env: LUMI_CHECK_TELEMETRY=on|off (tier 1; overrides the saved answer, and the question is not asked), LUMI_NO_PROMPT=1 (never ask), LUMI_SHARE_RECEIPTS=1 (tier 2 on), LUMI_KIT_CONFIG, LUMI_API, LUMI_KIT_KEY (contributor key file), LUMI_KIT_XRPL_SEED(_FILE), LUMI_KIT_STELLAR_SECRET(_FILE), LUMI_KIT_EVM_KEY(_FILE),
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
  // Sharing is OFF until the user says yes. The one-time question comes right AFTER the first check's result (see `check`).
  const onOff = (v) => (v === "on" ? true : v === "off" ? false : undefined);
  if (cmd === "setup") {
    console.error(kit.DISCLOSURE + "\n");
    const patch = {};
    const t = onOff(flag("telemetry")), sh = onOff(flag("sharing"));
    if (t !== undefined) patch.telemetry = t;
    if (sh !== undefined) patch.share_receipts = sh;
    if (t === undefined && sh === undefined && process.stdin.isTTY) {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const a1 = (await rl.question(kit.renderShareQuestion({ color: !process.env.NO_COLOR }).trimStart())).trim().toLowerCase();
      console.error("\n" + kit.TIER2_NOTICE);
      const a2 = (await rl.question("Turn ON tier 2 (shares a transaction ID that is publicly linkable on-chain)? [y/N] ")).trim().toLowerCase();
      rl.close();
      patch.telemetry = kit.parseShareAnswer(a1) !== false;
      patch.share_receipts = a2 === "y" || a2 === "yes";
    }
    if (patch.telemetry !== undefined) Object.assign(patch, { share_answered_at: new Date().toISOString(), share_answered_via: "setup" });
    const saved = kit.saveConfig(patch);
    const eff = kit.loadConfig();
    return out({ saved: kit.defaultConfigPath(), telemetry: eff.telemetry, share_receipts: eff.share_receipts, fail_mode: saved.fail_mode, timeout_ms: saved.timeout_ms,
      ...(eff.telemetry !== saved.telemetry || eff.share_receipts !== saved.share_receipts ? { note: "An environment variable overrides the saved file." } : {}) });
  }
  if (cmd === "telemetry" || cmd === "sharing") {
    const key = cmd === "telemetry" ? "telemetry" : "share_receipts";
    const v = onOff(pos[0]);
    if (v !== undefined) {
      if (cmd === "telemetry") kit.recordShareChoice(v, { via: "command" }); // an explicit choice: the first-check question will not be asked
      else {
        if (v) console.error(kit.TIER2_NOTICE + "\n");
        kit.saveConfig({ [key]: v });
      }
    }
    const eff = kit.loadConfig();
    const envName = cmd === "telemetry" ? "LUMI_CHECK_TELEMETRY" : "LUMI_SHARE_RECEIPTS";
    return out({ [key]: eff[key], tier: cmd === "telemetry" ? 1 : 2, config: kit.defaultConfigPath(),
      ...(cmd === "telemetry" ? { answered: eff.share_answered, source: eff.telemetry_source } : {}),
      ...(v !== undefined && eff[key] !== v ? { note: `${envName} is set and overrides the saved file.` } : {}),
      what: cmd === "telemetry" ? "seller host + delivered yes/no + status class, fresh random token; nothing else" : "full signed delivery receipts: chain + transaction ID (public on-chain, linkable to your wallet); badge only, nothing of monetary value" });
  }
  if (cmd === "check") {
    const lumi = kit.createLumiCheck({ api: process.env.LUMI_API });
    out(await lumi.check({ url: pos[0], payTo: flag("pay-to"), amountUsd: flag("amount") ? Number(flag("amount")) : undefined, network: flag("network") }).then(({ receipt, ...r }) => r));
    // The result is on screen; now (first check only) ask the one-time sharing question. No terminal: stay off, one hint.
    await kit.maybeAskToShare();
    return;
  }
  if (cmd === "prove-wallet") {
    const network = flag("network");
    if (!network) { out({ error: "network_required", hint: "--network xrpl:0 | eip155:8453 | stellar:pubnet" }); process.exitCode = 2; return; }
    const k = kit.loadKey(keyPath());
    const proof = await kit.walletProof(await signer(network), k.public_key);
    if (has("submit")) return out(await client().proveWallet(proof));
    return out({ proof, next: "Send this proof with your public key when you register (wallet_proofs), or run again with --submit once you have a key_id." });
  }
  if (cmd === "account" && pos[0] === "delete") {
    const c = client(), id = kit.loadKey(keyPath()).key_id;
    console.error(kit.ACCOUNT_DELETE_NOTICE + "\n");
    let typed = flag("confirm");
    if (typed === undefined) {
      if (!process.stdin.isTTY) { console.error("Not a terminal: pass --confirm <your key_id> to delete. Nothing was sent."); process.exitCode = 2; return; }
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      typed = (await rl.question(`Type your key id (${id}) to delete this account, or press Enter to cancel: `)).trim();
      rl.close();
    }
    if (typed !== id) { console.error("Cancelled: the key id did not match. Nothing was sent."); process.exitCode = 1; return; }
    const r = await c.deleteAccount(typed);
    if (r.deleted) console.error(`Deleted. The key file ${keyPath()} can no longer sign anything; you can delete it.`);
    return out(r);
  }
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
    if (!has("submit")) return out({ receipt: r, note: "Not submitted. Add --submit to send it to Lumi (needs tier 2 sharing on: `lumi-scan sharing on`)." });
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
  console.log("usage: lumi-scan check <url> | setup | telemetry on|off|status | sharing on|off|status | account delete | keygen | quote <url> | wanted | report ... | buy <url> [--live] | me | share-demand on|off");
  process.exitCode = cmd ? 2 : 0;
}
main().catch((e) => { console.error(kit.redact("error: " + (e?.message ?? e))); process.exitCode = 1; });
