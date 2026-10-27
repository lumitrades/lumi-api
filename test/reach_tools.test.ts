import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkips, advanceCursor, cursorFrom, alreadyPosted } from "../tools/reach_lib";
import { apiBase, PROD_API } from "../tools/reach_import";

const logOf = (events: { ts: string; resource: string }[]) => {
  const f = join(mkdtempSync(join(tmpdir(), "reach-")), "log.jsonl");
  writeFileSync(f, events.map((e) => JSON.stringify({ event: "skip", reason: "HTTP 404 (expected 402)", ...e })).join("\n") + "\n");
  return f;
};

describe("reach_import LUMI_API guard", () => {
  it("defaults to production and accepts the exact production origin", () => {
    expect(apiBase(undefined)).toBe(PROD_API);
    expect(apiBase("https://api.lumitrades.io")).toBe(PROD_API);
  });
  it("refuses any other host, so the owner key never leaves production", () => {
    for (const u of ["https://evil.example", "http://api.lumitrades.io", "https://api.lumitrades.io/", "https://api.lumitrades.io.evil.example", "https://api.lumitrades.io@evil.example", "", " https://api.lumitrades.io"])
      expect(() => apiBase(u)).toThrow(/refused/);
  });
});

describe("reach_lib cursor by (timestamp, resource)", () => {
  it("events sharing a timestamp across a 200-check batch boundary are not dropped", () => {
    const ev: { ts: string; resource: string }[] = [];
    for (let i = 0; i < 198; i++) ev.push({ ts: `2026-10-27T03:00:${String(Math.floor(i / 10)).padStart(2, "0")}.000Z`, resource: `https://s${i}.example/x` });
    const T = "2026-10-27T03:59:00.000Z";
    for (let i = 0; i < 5; i++) ev.push({ ts: T, resource: `https://tie${i}.example/x` }); // checks 198..202 share T
    ev.push({ ts: "2026-10-27T04:00:00.000Z", resource: "https://later.example/x" });
    const f = logOf(ev);
    const all = readSkips([f]).checks;
    expect(all).toHaveLength(204);
    const first = all.slice(0, 200); // first POST batch ends inside the tie at T
    const cur = advanceCursor(undefined, first)!;
    expect(cur.ts).toBe(T);
    expect(cur.resources).toHaveLength(2);
    // the run stops after batch 1 (e.g. HTTP 500); the next run must still see the 3 unposted ties + the later event
    const rest = readSkips([f], cursorFrom({ last_ts: cur.ts, last_resources: cur.resources })).checks;
    expect(rest.map((c) => c.resource)).toEqual(["https://tie2.example/x", "https://tie3.example/x", "https://tie4.example/x", "https://later.example/x"]);
    // nothing is re-posted: union of batches == all, no overlap
    expect(new Set([...first, ...rest].map((c) => c.checked_at + " " + c.resource)).size).toBe(204);
  });
  it("cursor carries resources when consecutive batches end on the same timestamp", () => {
    const T = "2026-10-27T03:59:00.000Z";
    const a = advanceCursor(undefined, [{ resource: "r1", reason: "", checked_at: T }]);
    const b = advanceCursor(a, [{ resource: "r2", reason: "", checked_at: T }]);
    expect(b).toEqual({ ts: T, resources: ["r1", "r2"] });
    expect(alreadyPosted(b, T, "r1") && alreadyPosted(b, T, "r2") && !alreadyPosted(b, T, "r3")).toBe(true);
  });
  it("legacy cursor (last_ts only) keeps the old meaning: everything at or before it was posted", () => {
    const c = cursorFrom({ last_ts: "2026-10-27T03:58:10.801Z", at: "x" });
    expect(alreadyPosted(c, "2026-10-27T03:58:10.801Z", "any")).toBe(true);
    expect(alreadyPosted(c, "2026-10-27T03:58:10.802Z", "any")).toBe(false);
    expect(readSkips([logOf([{ ts: "2026-10-27T03:58:10.801Z", resource: "https://a.example/" }, { ts: "2026-10-27T03:58:11.000Z", resource: "https://b.example/" }])], "2026-10-27T03:58:10.801Z").checks.map((x) => x.resource)).toEqual(["https://b.example/"]);
  });
});
