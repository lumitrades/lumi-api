/**
 * npm run demo:buyer:create
 *
 * Generates the LABELED DEMO "demo buyer" XRPL wallet used to show a real mainnet x402
 * payment to api.lumitrades.io. The seed is written ONLY to DEMO_BUYER_FILE (default
 * ~/.lumi/demo_buyer.json, mode 600, outside the repo). Prints only the address.
 * Refuses to overwrite an existing file. Generating a wallet is offline; nothing is submitted.
 */
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { Wallet } from "xrpl";

const FILE = process.env.DEMO_BUYER_FILE || `${process.env.HOME}/.lumi/demo_buyer.json`;

if (existsSync(FILE)) {
  console.error(`refusing: ${FILE} already exists (delete it deliberately if you really want a new wallet)`);
  process.exit(1);
}
const w = Wallet.generate();
mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
writeFileSync(
  FILE,
  JSON.stringify(
    {
      label: "Lumi API DEMO BUYER (mainnet). Self-payments for demos only; not organic usage.",
      address: w.classicAddress,
      seed: w.seed,
      public_key: w.publicKey,
      network: "xrpl:0",
      created: new Date().toISOString(),
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
chmodSync(FILE, 0o600);
console.log(w.classicAddress);
