import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { loadConfig, PAID_ROUTES } from "../src/config";
import { PLANS } from "../src/commerce/plans";
import { XRPL_DESTINATION_TAGS, destinationTagFor, productOfDestinationTag, productOfRouteKey, XRPL_DESTINATION_TAG_UNMAPPED } from "../src/xrpl_destination_tags";
import { DATA, FACILITATOR, PAY_TO, happyFacilitator, makeFetch, paymentHeaderFor, NOW } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret" };
const BASE = "http://lumi.test";
const VERDICT = "/v1/verdict?url=https://a.example/x";
const HV = "/v1/trust/check/high-value?url=https://a.example/x&amount=4";

function setup(env: Record<string, string> = {}) {
  const fac = happyFacilitator();
  const app = createApp({ ...ENV, ...env }, { fetch: makeFetch(fac), log: () => {}, now: () => NOW });
  const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(BASE + path, { headers }));
  return { get, fac };
}
const xrplAccepts = async (get: any, path: string) => ((await (await get(path)).json()).accepts as any[]).filter((a) => String(a.network).startsWith("xrpl:"));

describe("XRPL destination tag mapping", () => {
  it("maps every paid route and plan to a distinct tag", () => {
    for (const r of PAID_ROUTES) expect(XRPL_DESTINATION_TAGS[r], r).toBeTypeOf("number");
    for (const p of Object.keys(PLANS)) expect(XRPL_DESTINATION_TAGS[p], p).toBeTypeOf("number");
    const tags = Object.values(XRPL_DESTINATION_TAGS);
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags).not.toContain(XRPL_DESTINATION_TAG_UNMAPPED);
    for (const t of tags) expect(Number.isInteger(t) && t > 0 && t <= 0xffffffff).toBe(true);
  });
  it("derives the product from the routeKey prefix", () => {
    expect(productOfRouteKey("receipts:probe")).toBe("receipts");
    expect(destinationTagFor("watch:abc:n1:t1")).toBe(2003);
    expect(destinationTagFor("verdict")).toBe(1003);
    expect(destinationTagFor("nope:x")).toBe(XRPL_DESTINATION_TAG_UNMAPPED);
    expect(productOfDestinationTag(1004)).toBe("receipts");
    expect(productOfDestinationTag(5864)).toBeUndefined();
  });
  it("parses the rollout env", () => {
    expect(loadConfig(ENV).xrplDestTagRoutes).toEqual([]);
    expect(loadConfig({ ...ENV, XRPL_DEST_TAG_ROUTES: "ALL" }).xrplDestTagRoutes).toBe("all");
    expect(loadConfig({ ...ENV, XRPL_DEST_TAG_ROUTES: " receipts, verdict " }).xrplDestTagRoutes).toEqual(["receipts", "verdict"]);
    expect(loadConfig(ENV).xrplDestTagSourceTag).toBeUndefined();
    expect(loadConfig({ ...ENV, XRPL_DEST_TAG_SOURCE_TAG: "none" }).xrplDestTagSourceTag).toBeUndefined();
    expect(loadConfig({ ...ENV, XRPL_DEST_TAG_SOURCE_TAG: "804681468" }).xrplDestTagSourceTag).toBe(804681468);
    expect(() => loadConfig({ ...ENV, XRPL_DEST_TAG_SOURCE_TAG: "-1" })).toThrow();
  });
});

describe("XRPL accepts tags", () => {
  it("off by default: sourceTag 5864, no destinationTag", async () => {
    const { get } = setup();
    for (const a of await xrplAccepts(get, VERDICT)) {
      expect(a.extra.sourceTag).toBe(5864);
      expect(a.extra).not.toHaveProperty("destinationTag");
    }
  });
  it("one-route rollout tags only that product (XRP, RLUSD and USDC)", async () => {
    const { get } = setup({ XRPL_DEST_TAG_ROUTES: "verdict" });
    const v = await xrplAccepts(get, VERDICT);
    expect(v).toHaveLength(3);
    for (const a of v) {
      expect(a.extra.destinationTag).toBe(1003);
      expect(a.extra).not.toHaveProperty("sourceTag");
      expect(a.extra.invoiceId).toBe(v[0].extra.invoiceId);
    }
    expect(v[1].extra).toMatchObject({ symbol: "RLUSD" });
    for (const a of await xrplAccepts(get, HV)) {
      expect(a.extra.sourceTag).toBe(5864);
      expect(a.extra).not.toHaveProperty("destinationTag");
    }
  });
  it("all: every product tagged; explicit SourceTag override is honoured", async () => {
    const { get } = setup({ XRPL_DEST_TAG_ROUTES: "all", XRPL_DEST_TAG_SOURCE_TAG: "804681468" });
    for (const [p, tag] of [[VERDICT, 1003], [HV, 1002]] as const) {
      for (const a of await xrplAccepts(get, p)) expect(a.extra).toMatchObject({ destinationTag: tag, sourceTag: 804681468 });
    }
  });
  it("sends the tagged requirements to the facilitator and settles", async () => {
    const { get, fac } = setup({ XRPL_DEST_TAG_ROUTES: "verdict" });
    for (const i of [0, 1]) {
      const req = (await xrplAccepts(get, VERDICT))[i]; // XRP, then RLUSD (fresh invoice each: one invoice pays once)
      fac.calls.length = 0;
      const r = await get(VERDICT, { "PAYMENT-SIGNATURE": paymentHeaderFor(req) });
      expect(r.status).toBe(200);
      const v = fac.calls.find((c) => c.path === "/verify")!;
      expect(v.body.paymentRequirements.extra.destinationTag).toBe(1003);
      expect(v.body.paymentRequirements.extra).not.toHaveProperty("sourceTag");
    }
  });
  it("an accept echoed without the destinationTag still resolves to the tagged requirements", async () => {
    const { get, fac } = setup({ XRPL_DEST_TAG_ROUTES: "verdict" });
    const [xrp] = await xrplAccepts(get, VERDICT);
    const { destinationTag: _d, ...extra } = xrp.extra;
    const r = await get(VERDICT, { "PAYMENT-SIGNATURE": paymentHeaderFor({ ...xrp, extra }) });
    expect(r.status).toBe(200);
    expect(fac.calls.find((c) => c.path === "/verify")!.body.paymentRequirements.extra.destinationTag).toBe(1003);
  });
});
