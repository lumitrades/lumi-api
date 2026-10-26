import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch } from "./helpers";

const EVM_PAY_TO = "0x5E617bac19912e6d212CB303ae84655E9E203532";
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", EVM_PAY_TO, EVM_NETWORK: "eip155:84532" };
const BASE = "http://lumi.test";

function setup(now = NOW) {
  const fac = happyFacilitator();
  const app = createApp(ENV, { fetch: makeFetch(fac), log: () => {}, now: () => now });
  const get = (p: string) => app.fetch(new Request(BASE + p));
  const rpc = async (body: unknown, headers: Record<string, string> = {}) => {
    const r = await app.fetch(new Request(BASE + "/a2a", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  return { get, rpc, fac };
}

const send1 = (parts: unknown[]) => ({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId: "m1", role: "ROLE_USER", parts } } });
const send03 = (parts: unknown[]) => ({ jsonrpc: "2.0", id: "a", method: "message/send", params: { message: { kind: "message", messageId: "m1", role: "user", parts } } });

describe("A2A agent card", () => {
  it("serves the card at /.well-known/agent-card.json and /.well-known/agent.json", async () => {
    const { get } = setup();
    const r = await get("/.well-known/agent-card.json");
    expect(r.status).toBe(200);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const card = await r.json();
    expect(await (await get("/.well-known/agent.json")).json()).toEqual(card);
    expect(card).toMatchObject({
      name: "Lumi Trades",
      version: "1.2.0",
      provider: { organization: "Lumi Trades", url: "https://lumitrades.io" },
      documentationUrl: `${BASE}/skill.md`,
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: expect.arrayContaining(["text/plain"]),
      defaultOutputModes: expect.arrayContaining(["application/json"]),
      // 0.3 compatibility
      protocolVersion: "0.3.0",
      url: `${BASE}/a2a`,
      preferredTransport: "JSONRPC",
    });
    expect(card.description).toMatch(/XRP Ledger/);
    expect(card.description).toMatch(/USDC on Base Sepolia/);
    expect(card.supportedInterfaces).toEqual([
      { url: `${BASE}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      { url: `${BASE}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "0.3" },
    ]);
    expect(card.skills.map((s: any) => s.id)).toEqual(["trust_check", "vendor_trust", "vendor_report", "catalog", "seller_monitoring", "trust_feed", "samples", "quote"]);
    const cardText = JSON.stringify(card);
    expect(cardText).not.toMatch(/institutional|funding|fear.?greed|Watch Plus|\$12\b|\$9\b|\$29\b|market data|trust layer/i);
    expect(card.iconUrl).toBe("https://lumitrades.io/assets/icon-512.png");
    for (const s of card.skills) expect(s).toMatchObject({ id: expect.any(String), name: expect.any(String), description: expect.any(String), tags: expect.any(Array) });
    const x402 = card.capabilities.extensions.find((e: any) => e.uri === "https://x402.org");
    expect(x402.params.networks.map((n: any) => n.network)).toEqual(["eip155:84532", "xrpl:1"]);
    expect(x402.params.networks[0]).toMatchObject({ pay_to: EVM_PAY_TO });
    const mcp = card.capabilities.extensions.find((e: any) => e.uri === "https://modelcontextprotocol.io");
    expect(mcp.params.url).toBe(`${BASE}/mcp`);
  });
});

describe("A2A JSON-RPC", () => {
  it("SendMessage (1.0): free skills answer inline as a Message", async () => {
    const { rpc, fac } = setup();
    const r = await rpc(send1([{ data: { skill: "samples" } }]), { "A2A-Version": "1.0" });
    expect(r.status).toBe(200);
    const m = r.body.result.message;
    expect(m).toMatchObject({ role: "ROLE_AGENT", metadata: { skill: "samples" } });
    expect(m.contextId).toBeTruthy();
    const cat = await rpc(send1([{ data: { skill: "catalog" } }]));
    expect(cat.body.result.message.parts[1].data.networks.map((n: any) => n.network)).toEqual(["eip155:84532", "xrpl:1"]);
    expect(fac.calls).toHaveLength(0);
  });

  it("message/send (0.3): paid skill returns live x402 terms for every network, nothing charged", async () => {
    const { rpc, fac } = setup();
    const r = await rpc(send03([{ kind: "data", data: { skill: "trust_check", url: "https://a.example/x" } }]));
    const m = r.body.result;
    expect(m).toMatchObject({ kind: "message", role: "agent", metadata: { skill: "trust_check" } });
    const d = m.parts[1].data;
    expect(d).toMatchObject({ status: "payment_required", charged: false, url: `${BASE}/v1/trust/check?url=https%3A%2F%2Fa.example%2Fx` });
    expect(d.options.map((o: any) => [o.network, o.asset, o.amount])).toEqual([
      ["eip155:84532", "USDC", "0.02"], ["xrpl:1", "XRP", "0.015"], ["xrpl:1", "RLUSD", "0.02"], ["xrpl:1", "USDC", "0.02"],
    ]);
    expect(d.x402.x402Version).toBe(2);
    expect(fac.calls).toHaveLength(0);
  });

  it("quotes paths, never offers a retired one, and refuses stale data without a quote", async () => {
    const { rpc } = setup();
    const q = await rpc(send1([{ data: { skill: "quote", path: "/v1/verdict?url=https%3A%2F%2Fa.example%2Fx" } }]));
    expect(q.body.result.message.parts[1].data.url).toBe(`${BASE}/v1/verdict?url=https%3A%2F%2Fa.example%2Fx`);
    const gone = await rpc(send1([{ data: { skill: "signal", coin: "XRP" } }]));
    expect(JSON.stringify(gone.body)).toMatch(/gone/);
    expect(JSON.stringify(gone.body)).not.toMatch(/"accepts"/);
    for (const skill of ["institutional", "funding", "fear_greed"]) {
      const s = await rpc(send1([{ data: { skill } }]));
      expect(JSON.stringify(s.body), skill).toMatch(/gone/);
      expect(JSON.stringify(s.body), skill).not.toMatch(/"accepts"/);
    }
    const retired = await rpc(send1([{ data: { skill: "sentiment" } }]));
    expect(JSON.stringify(retired.body)).toMatch(/gone/);
    expect(JSON.stringify(retired.body)).not.toMatch(/"accepts"/);
  });

  it("returns spec errors for unsupported methods and versions", async () => {
    const { rpc, get } = setup();
    expect((await rpc({ jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: "x" } })).body.error.code).toBe(-32001);
    expect((await rpc({ jsonrpc: "2.0", id: 3, method: "SendStreamingMessage", params: {} })).body.error.code).toBe(-32004);
    expect((await rpc({ jsonrpc: "2.0", id: 4, method: "Nope" })).body.error.code).toBe(-32601);
    expect((await rpc(send1([{ text: "hi" }]), { "A2A-Version": "9.9" })).body.error.code).toBe(-32009);
    expect((await rpc({ jsonrpc: "2.0", id: 5, method: "SendMessage", params: {} })).body.error.code).toBe(-32602);
    expect((await get("/a2a")).status).toBe(405);
  });
});
