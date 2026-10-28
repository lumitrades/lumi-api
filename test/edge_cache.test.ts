import { describe, expect, it } from "vitest";
import { bufferResponse, fromStored, readHit, toStored } from "../src/edge_cache";

describe("edge cache headers", () => {
  it("keeps the app's Cache-Control on hits even if the edge rewrites it", async () => {
    const res = new Response('{"ok":true}', { status: 200, headers: { "Cache-Control": "public, max-age=300", "Content-Type": "application/json" } });
    const b = await bufferResponse(res);
    const stored = toStored(b, 1_000)!;
    expect(stored.headers.get("X-Lumi-Cache-Control")).toBe("public, max-age=300");
    const h = new Headers(stored.headers);
    h.set("Cache-Control", "public, max-age=14400"); // what Cloudflare's Browser Cache TTL does on a hit
    const hit = new Response(await stored.text(), { status: 200, headers: h });
    const body = (await readHit(hit, 1_000))!;
    const out = fromStored(hit, body, "hit", false);
    expect(out.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(out.headers.has("X-Lumi-Cache-Control")).toBe(false);
    expect(out.headers.has("X-Lumi-Body-Length")).toBe(false);
    expect(await out.json()).toEqual({ ok: true });
  });
});
