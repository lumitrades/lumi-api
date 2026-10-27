/**
 * The test-buy runners (Lumi's tools repo) keep a byte-identical copy of src/trust/judge.ts as delivery_judge.ts, so the
 * API and the runners judge a paid response with one rule. This fails if the copy drifts.
 * Path: LUMI_TOOLS_JUDGE (required to exist when set), else /workspace/tools/delivery_judge.ts when present (skipped
 * elsewhere, e.g. CI without the tools checkout).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const api = fileURLToPath(new URL("../src/trust/judge.ts", import.meta.url));
const envPath = process.env.LUMI_TOOLS_JUDGE;
const toolsPath = envPath || "/workspace/tools/delivery_judge.ts";
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("tools copy of the delivery judge", () => {
  it.skipIf(!envPath && !existsSync(toolsPath))("is byte-identical to src/trust/judge.ts", () => {
    expect(existsSync(toolsPath), `missing ${toolsPath}`).toBe(true);
    expect(sha(toolsPath), `${toolsPath} differs from src/trust/judge.ts; copy it byte-for-byte`).toBe(sha(api));
  });
});
