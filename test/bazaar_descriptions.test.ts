import { describe, it, expect } from "vitest";
import { BAZAAR_ROUTES } from "../src/bazaar";
import { createApp } from "../src/app";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch } from "./helpers";

const ENV = {
  XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret",
  EVM_PAY_TO: "0x5E617bac19912e6d212CB303ae84655E9E203532", EVM_NETWORK: "eip155:84532",
};
const setup = () => {
  const app = createApp(ENV, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW });
  return (p: string) => app.fetch(new Request("http://lumi.test" + p));
};

describe("/health", () => {
  it("names the facilitator actually used", async () => {
    const h = await (await setup()("/health")).json();
    expect(h.evm.facilitator).toMatch(/^https:\/\//);
  });
});

describe("Bazaar resource descriptions", () => {
  it("use the v2 listing text verbatim, with no price in the text, never cut and never instructions to agents", async () => {
    const get = setup();
    for (const [p, route] of [["/v1/trust/check?url=https://a.example/x", "trust_check"], ["/v1/verdict?url=https://a.example/x", "verdict"]] as const) {
      const d = (await (await get(p)).json()).resource.description as string;
      expect(d.length, p).toBeLessThanOrEqual(500);
      expect(d, p).toBe(BAZAAR_ROUTES[route].description);
      expect(d).not.toMatch(/\$0\.0[12]\b/);
      expect(d).not.toMatch(/\b(you must|ignore previous|always call)\b/i);
    }
  });
});
