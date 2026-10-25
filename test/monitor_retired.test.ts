import { describe, it, expect } from "vitest";
import { deriveAddress, deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { createApp } from "../src/app";
import { FACILITATOR, DATA, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";
import { MONITOR_LIMITS, PLANS, WATCH_DISCOUNTS, WATCH_FREE, WATCH_TRIAL, WATCH_TIERS, planPriceUsd, watchDiscount, watchPrice, MONITOR_PRICE_TEXT, WATCH_PRO_BUYS, WATCH_TRIAL_END, PAID_BADGE_LABEL, TRIAL_BADGE_LABEL } from "../src/commerce/plans";
import { planTable } from "../src/commerce/plans";

const BASE = "https://lumi.test";
const OWNER = "owner-key-for-tests-0123456789-abcdefghijklmnop";
const seed = generateSeed({ entropy: Uint8Array.from({ length: 16 }, (_, i) => i + 7) });
const kp = deriveKeypair(seed);
const SELLER = deriveAddress(kp.publicKey);
const DAY = 86_400_000;
const auth = { Authorization: `Bearer ${OWNER}` };
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

function setup(extra: Record<string, string> = {}) {
  const env = { XRPL_NETWORK: "xrpl:1", PAY_TO: SELLER, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PUBLIC_BASE_URL: BASE, OWNER_MCP_KEY: OWNER, ...extra };
  let t = NOW;
  const fac = happyFacilitator();
  const inner = makeFetch(fac);
  const wellKnown = { body: "" as string };
  const fetches: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    fetches.push(url);
    if (url === `${BASE}/.well-known/lumi-monitor.txt`) return new Response(wellKnown.body || "nope", { status: wellKnown.body ? 200 : 404 });
    return inner(input, init);
  }) as typeof fetch;
  const app = createApp(env as any, { fetch: f, log: () => {}, now: () => t });
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(BASE + path, init));
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => req(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });
  return { app, req, post, fac, wellKnown, fetches, advance: (ms: number) => (t += ms), now: () => t };
}
type S = ReturnType<typeof setup>;

async function enroll(s: S, endpoints: unknown[] = [{ url: `${BASE}/v1/fear-greed` }]) {
  const { message } = await (await s.req(`/v1/monitor/challenge?pay_to=${SELLER}`)).json();
  const r = await s.post("/v1/monitor/enroll", { message, signature: sign(hex(message), kp.privateKey), public_key: kp.publicKey, endpoints });
  expect(r.status).toBe(201);
  return r.json();
}
async function quote(s: S, path: string) {
  const q = await s.req(path);
  return { status: q.status, body: await q.json() };
}
async function pay(s: S, path: string) {
  const q = await quote(s, path);
  expect(q.status).toBe(402);
  const xrp = q.body.accepts.find((a: any) => a.asset === "XRP");
  const r = await s.req(path, { headers: { "PAYMENT-SIGNATURE": paymentHeaderFor(xrp) } });
  return { status: r.status, body: await r.json() };
}
const iou = (q: any) => q.accepts.find((a: any) => a.asset !== "XRP").amount;
const settles = (s: S) => s.fac.calls.filter((c: any) => c.path === "/settle").length;
async function trialProof(s: S, domain = "lumi.test") {
  const c = await (await s.req(`/v1/monitor/trial/challenge?pay_to=${SELLER}&domain=${domain}`)).json();
  return { c, proof: { message: c.message, signature: sign(hex(c.message), kp.privateKey), public_key: kp.publicKey } };
}

describe("Monitor ($9) and Monitor Plus ($29) retired 2026-10-25", () => {
  it("never quotes them: 410 plan_retired with or without an enrolment or a payment header, nothing settled", async () => {
    const s = setup();
    const e = await enroll(s);
    for (const plan of ["monitor", "monitor_plus"]) {
      for (const q of ["", `?enrollment=${e.enrollment_id}`]) {
        const r = await s.req(`/v1/monitor/subscribe/${plan}${q}`);
        expect(r.status, plan + q).toBe(410);
        expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
        expect(await r.json()).toMatchObject({ error: "plan_retired", plan, note: "Not charged." });
      }
      const fake = { scheme: "exact", network: "xrpl:1", asset: "XRP", amount: "9000000", payTo: SELLER, maxTimeoutSeconds: 60, extra: {} };
      const paid = await s.req(`/v1/monitor/subscribe/${plan}?enrollment=${e.enrollment_id}`, { headers: { "PAYMENT-SIGNATURE": paymentHeaderFor(fake) } });
      expect(paid.status).toBe(410);
    }
    expect(s.fac.calls).toHaveLength(0);
    // the Watch tiers are still sold
    expect((await quote(s, `/v1/monitor/subscribe/watch_plus?enrollment=${e.enrollment_id}&endpoints=1`)).status).toBe(402);
    expect(Object.keys(e.pay).sort()).toEqual(["audit", "watch", "watch_plus", "watch_pro"]);
    expect(Object.keys(e.plans)).not.toContain("monitor");
    expect(Object.keys(e.plans)).not.toContain("monitor_plus");
  });

  it("is not listed anywhere public", async () => {
    const s = setup();
    const docs = [
      await (await s.req("/")).text(), await (await s.req("/.well-known/x402")).text(), await (await s.req("/openapi.json")).text(),
      await (await s.req("/v1/monitor")).text(), await (await s.req("/skill.md")).text(), await (await s.req("/llms.txt")).text(),
      JSON.stringify(planTable()),
    ];
    for (const d of docs) {
      expect(d).not.toMatch(/subscribe\/monitor(_plus)?\b/);
      expect(d).not.toMatch(/"monitor_plus"|Monitor Plus \$|\$29\b/);
    }
  });

  it("rows bought before the retirement keep working to their term end", async () => {
    const s = setup({ SALES_TEST_WALLETS: SELLER });
    const e = await enroll(s);
    (PLANS.monitor_plus as any).retired = false; // simulate a purchase made before 2026-10-25
    try {
      expect((await pay(s, `/v1/monitor/subscribe/monitor_plus?enrollment=${e.enrollment_id}`)).status).toBe(201);
    } finally {
      (PLANS.monitor_plus as any).retired = true;
    }
    const st = await (await s.req(`/v1/monitor/status/${e.enrollment_id}.json`)).json();
    expect(st.tier).toBe("monitor_plus");
    const due = await (await s.req("/v1/owner/monitor/due", { headers: auth })).json();
    expect(due.tasks.some((t: any) => t.enrollment_id === e.enrollment_id)).toBe(true);
    // ...but it cannot be renewed
    expect((await s.req(`/v1/monitor/subscribe/monitor_plus?enrollment=${e.enrollment_id}`)).status).toBe(410);
  });
});
