import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app";
import { FACILITATOR, DATA, NOW, happyFacilitator, makeFetch } from "./helpers";

const BASE = "https://lumi.test";
function setup() {
  const env = { XRPL_NETWORK: "xrpl:1", PAY_TO: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH", FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PUBLIC_BASE_URL: BASE };
  const app = createApp(env as any, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW } as any);
  return (p: string) => app.fetch(new Request(BASE + p)).then((r) => r.text());
}
const PAGES = ["/v1/trust/methodology", "/llms.txt", "/skill.md", "/openapi.json", "/v1/trust/receipts/verify", "/.well-known/agent-card.json"];

describe("receipt and test-buy cap wording", () => {
  it("never says /v1/trust/check serves signed receipts", async () => {
    const get = setup();
    for (const p of PAGES) {
      const t = await get(p);
      expect(t, p).not.toMatch(/served in paid (\/v1\/)?trust\/check|purchases\[\]\.receipt in \/v1\/trust\/check|trust\/check\?url=<resource> \(\$0\.004; purchases\[\]\.receipt\)|receipts \(free lookup, paid check/i);
    }
  });
  it("methodology points receipts at vendor reports, Feed lookups and the free verifier", async () => {
    const m = JSON.parse(await setup()("/v1/trust/methodology"));
    const r = JSON.stringify(m);
    expect(r).toMatch(/vendors\/printmoneylab\/report/);
    expect(r).toMatch(/\/v1\/feed\/lookup/);
    expect(r).toMatch(/POST [^"]*\/v1\/trust\/receipts\/verify/);
  });
  it("public test-buy caps are the current per-chain ones (spend cut 2026-10-28) and no stale cap is stated", async () => {
    const get = setup();
    const both = (await get("/llms.txt")) + (await get("/v1/trust/methodology"));
    for (const stale of [/0\.30 RLUSD/, /0\.10 XRP/, /0\.15 USDC/, /about \$0\.50 a day/, /\$0\.10 per day/, /shared (hard |daily )?caps?\b/]) {
      expect(both).not.toMatch(stale);
    }
    expect(both).toMatch(/0\.15 RLUSD \+ 0\.05 XRP/);
    expect(both).toMatch(/Base 0\.30 USDC/);
    expect(both).toMatch(/0\.08 USDC/);
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).not.toMatch(/0\.40 RLUSD|0\.30 RLUSD|0\.15 RLUSD/); // the README no longer restates the cap; docs and methodology are the source
  });
});
