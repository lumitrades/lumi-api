import { describe, it, expect } from "vitest";
import { deriveAddress, deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { createApp } from "../src/app";
import { FACILITATOR, DATA, NOW, happyFacilitator, makeFetch } from "./helpers";

const BASE = "https://lumi.test";
const kp = deriveKeypair(generateSeed({ entropy: Uint8Array.from({ length: 16 }, (_, i) => i + 7) }));
const SELLER = deriveAddress(kp.publicKey);
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

function setup() {
  const env = { XRPL_NETWORK: "xrpl:1", PAY_TO: SELLER, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PUBLIC_BASE_URL: BASE, OWNER_MCP_KEY: "owner-key-for-tests-0123456789-abcdefghijklmnop" };
  const app = createApp(env as any, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW } as any);
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(BASE + path, init));
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => req(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });
  return { req, post };
}

describe("L-12 POST /v1/monitor/replies without auth", () => {
  it("returns 401 (not 404 unknown_enrollment) when no credentials are sent", async () => {
    const s = setup();
    for (const body of [{ enrollment_id: "bogus", finding_id: 1, text: "hi" }, {}]) {
      const r = await s.post("/v1/monitor/replies", body);
      expect(r.status).toBe(401);
      expect(r.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect((await r.json()).error).toBe("management_token_required");
    }
    const raw = await s.req("/v1/monitor/replies", { method: "POST", body: "not json" });
    expect(raw.status).toBe(401);
  });

  it("with a token but an unknown enrollment still says unknown_enrollment; a real token still works", async () => {
    const s = setup();
    const r = await s.post("/v1/monitor/replies", { enrollment_id: "bogus", finding_id: 1, text: "hi" }, { Authorization: "Bearer x" });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("unknown_enrollment");

    const { message } = await (await s.req(`/v1/monitor/challenge?pay_to=${SELLER}`)).json();
    const e = await s.post("/v1/monitor/enroll", { message, signature: sign(hex(message), kp.privateKey), public_key: kp.publicKey, endpoints: [{ url: `${BASE}/v1/verdict?url=https://a.example/x` }] });
    expect(e.status).toBe(201);
    const { enrollment_id } = await e.json();
    const wrong = await s.post("/v1/monitor/replies", { enrollment_id, finding_id: 1, text: "hi" }, { Authorization: "Bearer wrong" });
    expect(wrong.status).toBe(401);
  });
});

describe("L-9 feed challenge wallet errors", () => {
  it("malformed wallet -> invalid_wallet; missing wallet -> wallet_required", async () => {
    const s = setup();
    const bad = await s.req("/v1/feed/challenge?wallet=notanaddress");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_wallet");
    const none = await s.req("/v1/feed/challenge");
    expect(none.status).toBe(400);
    expect((await none.json()).error).toBe("wallet_required");
    const ok = await s.req(`/v1/feed/challenge?wallet=${SELLER}`);
    expect(ok.status).toBe(200);
  });
});
