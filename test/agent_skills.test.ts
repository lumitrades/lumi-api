import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { AGENT_SKILL_DESCRIPTION, AGENT_SKILL_NAME, agentSkillsIndex, skillMd } from "../src/docs";
import { sha256Hex } from "../src/idempotency";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret" };
const BASE = "http://lumi.test";
const mk = () => createApp(ENV as any, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW });

describe("GET /.well-known/agent-skills/index.json", () => {
  it("returns 200 with the drafted check-x402-seller-before-paying entry and a digest that matches /skill.md", async () => {
    const app = mk();
    const r = await app.fetch(new Request(BASE + "/.well-known/agent-skills/index.json"));
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    expect(body.skills).toHaveLength(1);
    const skill = body.skills[0];
    expect(skill.name).toBe(AGENT_SKILL_NAME);
    expect(skill.name).toBe("check-x402-seller-before-paying");
    expect(skill.type).toBe("skill-md");
    expect(skill.description).toBe(AGENT_SKILL_DESCRIPTION);
    expect(skill.url).toBe(`${BASE}/skill.md`);
    expect(skill.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const skillRes = await app.fetch(new Request(BASE + "/skill.md"));
    expect(skillRes.status).toBe(200);
    const skillBody = await skillRes.text();
    expect(skill.digest).toBe(`sha256:${await sha256Hex(skillBody)}`);
    const built = await agentSkillsIndex(BASE, skillBody);
    expect(built).toEqual(body);
  });
});
