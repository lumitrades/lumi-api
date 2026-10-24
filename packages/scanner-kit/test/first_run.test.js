// One-time "share your results" question after the first check: off until yes, asked once, never in non-interactive runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { execFileSync, spawnSync } from "node:child_process";
import * as kit from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "lk-fr-"));
function tty(isTTY = true) {
  const stdin = new PassThrough(); stdin.isTTY = isTTY;
  const stderr = new PassThrough(); stderr.isTTY = isTTY;
  let text = ""; stderr.on("data", (d) => { text += d; });
  return { stdin, stderr, get text() { return text; } };
}
const answer = (io, line, ms = 20) => setTimeout(() => io.stdin.write(line + "\n"), ms);

test("question text: exact wording, Yes is the highlighted default, one line on what is shared and how to turn it off", () => {
  assert.equal(kit.SHARE_QUESTION, "Share your results to help improve Lumi's public trust list?");
  const plain = kit.renderShareQuestion();
  assert.ok(plain.trimEnd().endsWith("Share your results to help improve Lumi's public trust list? [Y/n]"));
  assert.match(kit.SHARE_DETAIL, /seller's host, delivered yes\/no and status class/);
  assert.match(kit.SHARE_DETAIL, /No wallet addresses, amounts/);
  assert.match(kit.SHARE_DETAIL, /Turn off any time: lumi-scan telemetry off/);
  assert.ok(kit.renderShareQuestion({ color: true }).includes("[\x1b[1;32mY\x1b[0m/n]")); // highlighted Y
  for (const [a, v] of [["", true], ["y", true], [" YES ", true], ["n", false], ["No", false], ["maybe", null]]) assert.equal(kit.parseShareAnswer(a), v, a);
});

test("Enter means yes: saved locally, sharing turns on, and the question never shows again", async () => {
  const p = join(tmp(), "config.json"); const io = tty();
  answer(io, "");
  const r = await kit.maybeAskToShare({ configPath: p, env: { NO_COLOR: "1" }, stdin: io.stdin, stderr: io.stderr });
  assert.deepEqual(r, { asked: true, saved: true, shared: true });
  assert.match(io.text, /\[Y\/n\]/); assert.match(io.text, /Sharing is on/);
  const saved = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(saved.telemetry, true); assert.equal(typeof saved.share_answered_at, "string"); assert.equal(saved.share_answered_via, "first_check_prompt");
  assert.equal(saved.share_receipts, false); // tier 2 is a separate opt-in, untouched by this answer
  const io2 = tty();
  assert.deepEqual(await kit.maybeAskToShare({ configPath: p, env: {}, stdin: io2.stdin, stderr: io2.stderr }), { asked: false });
  assert.equal(io2.text, "");
});

test("'n' is saved as no: sharing stays off and is never asked again", async () => {
  const p = join(tmp(), "config.json"); const io = tty();
  answer(io, "n");
  assert.deepEqual(await kit.maybeAskToShare({ configPath: p, env: {}, stdin: io.stdin, stderr: io.stderr }), { asked: true, saved: true, shared: false });
  const cfg = kit.loadConfig(p, {});
  assert.equal(cfg.telemetry, false); assert.equal(cfg.share_answered, true);
  assert.equal(kit.shareQuestionState(cfg, { stdin: { isTTY: true }, stderr: { isTTY: true }, env: {} }), "none");
});

test("unclear answer asks again; EOF saves nothing and leaves sharing off", async () => {
  const p = join(tmp(), "config.json"); const io = tty();
  answer(io, "maybe"); answer(io, "y", 60);
  assert.equal((await kit.maybeAskToShare({ configPath: p, env: {}, stdin: io.stdin, stderr: io.stderr })).shared, true);
  const p2 = join(tmp(), "config.json"); const io2 = tty();
  setTimeout(() => io2.stdin.end(), 20);
  assert.deepEqual(await kit.maybeAskToShare({ configPath: p2, env: {}, stdin: io2.stdin, stderr: io2.stderr }), { asked: true, saved: false, shared: false });
  assert.equal(existsSync(p2), false);
  assert.equal(kit.loadConfig(p2, {}).telemetry, false);
});

test("non-interactive runs never assume yes: no TTY, CI or LUMI_NO_PROMPT stay off and print one hint", async () => {
  for (const [isTTY, env] of [[false, {}], [true, { CI: "true" }], [true, { GITHUB_ACTIONS: "true" }], [true, { LUMI_NO_PROMPT: "1" }]]) {
    const p = join(tmp(), "config.json"); const io = tty(isTTY);
    const r = await kit.maybeAskToShare({ configPath: p, env, stdin: io.stdin, stderr: io.stderr });
    assert.deepEqual(r, { asked: false, hinted: true }, JSON.stringify(env));
    assert.equal(io.text, kit.SHARE_HINT + "\n");
    assert.match(io.text, /lumi-scan telemetry on/); assert.match(io.text, /LUMI_CHECK_TELEMETRY=on/);
    assert.equal(existsSync(p), false); // nothing saved, so a later interactive check can still ask
    assert.equal(kit.loadConfig(p, env).telemetry, false);
  }
  assert.equal(kit.isCi({ CI: "false" }), false);
});

test("LUMI_CHECK_TELEMETRY decides without asking: on/off accepted, anything else ignored (stays off)", async () => {
  const p = join(tmp(), "config.json");
  for (const v of ["on", "1", "true", "yes"]) assert.equal(kit.loadConfig(p, { LUMI_CHECK_TELEMETRY: v }).telemetry, true, v);
  for (const v of ["off", "0", "false", "no", "banana", ""]) assert.equal(kit.loadConfig(p, { LUMI_CHECK_TELEMETRY: v }).telemetry, false, v);
  const io = tty();
  assert.deepEqual(await kit.maybeAskToShare({ configPath: p, env: { LUMI_CHECK_TELEMETRY: "off" }, stdin: io.stdin, stderr: io.stderr }), { asked: false });
  kit.recordShareChoice(true, { path: p });
  assert.equal(kit.loadConfig(p, { LUMI_CHECK_TELEMETRY: "off" }).telemetry, false); // env wins over the saved yes
});

test("library use while unanswered: nothing is sent, one hint per process", async () => {
  const { _resetHintForTests } = await import("../src/first_run.js");
  _resetHintForTests();
  const p = join(tmp(), "config.json");
  const calls = []; const f = async (u, i) => { calls.push(u); return new Response("{}", { status: 202 }); };
  const err = { text: "", write(s) { this.text += s; } };
  const cfg = kit.loadConfig(p, {});
  assert.equal(kit.hintOnce(cfg, { stderr: err }), true);
  assert.equal(kit.hintOnce(cfg, { stderr: err }), false);
  assert.equal(err.text.split("\n").filter(Boolean).length, 1);
  assert.equal((await kit.reportOutcome({ target: "a.example", delivered: true }, { fetchImpl: f, configPath: p, env: {} })).sent, false);
  assert.equal(calls.length, 0);
  assert.equal(kit.hintOnce(kit.loadConfig(p, { LUMI_CHECK_TELEMETRY: "off" }), { stderr: err }), false);
});

test("sharing never changes the check: the request to Lumi is identical with sharing on or off", async () => {
  const seen = [];
  const f = async (u, init) => { seen.push({ u: String(u), h: JSON.stringify(init?.headers ?? {}) }); return new Response("{}", { status: 503 }); };
  const args = { url: "https://s.example/x?q=1", payTo: "0x1111111111111111111111111111111111111111", amountUsd: 0.01, network: "eip155:8453" };
  await kit.createLumiCheck({ fetchImpl: f, publicKeys: ["00".repeat(32)], config: { telemetry: true } }).check(args);
  await kit.createLumiCheck({ fetchImpl: f, publicKeys: ["00".repeat(32)], config: { telemetry: false } }).check(args);
  assert.equal(seen.length, 2); assert.deepEqual(seen[0], seen[1]);
});

const cli = new URL("../bin/lumi-scan.js", import.meta.url).pathname;
const cliEnv = (p, extra = {}) => { const e = { ...process.env, LUMI_API: "http://127.0.0.1:9", LUMI_KIT_CONFIG: p, ...extra }; for (const k of ["LUMI_CHECK_TELEMETRY", "LUMI_SHARE_RECEIPTS", "CI", "GITHUB_ACTIONS", "LUMI_NO_PROMPT"]) if (!(k in extra)) delete e[k]; return e; };

test("CLI check without a terminal: result on stdout, one hint on stderr, nothing saved, sharing off", () => {
  const p = join(tmp(), "config.json");
  const r = spawnSync(process.execPath, [cli, "check", "https://s.example/x"], { env: cliEnv(p), encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).decision, "warn"); // fail-open: Lumi unreachable in the test
  assert.equal(r.stderr.split(kit.SHARE_HINT).length - 1, 1);
  assert.ok(!r.stderr.includes("[Y/n]"));
  assert.equal(existsSync(p), false);
});

test("CLI telemetry on|off is an explicit answer (no question afterwards) and status reports it", () => {
  const p = join(tmp(), "config.json");
  const st = JSON.parse(execFileSync(process.execPath, [cli, "telemetry", "status"], { env: cliEnv(p), encoding: "utf8" }));
  assert.equal(st.telemetry, false); assert.equal(st.answered, false); assert.equal(st.source, "default");
  const on = JSON.parse(execFileSync(process.execPath, [cli, "telemetry", "on"], { env: cliEnv(p), encoding: "utf8" }));
  assert.equal(on.telemetry, true); assert.equal(on.answered, true);
  assert.equal(JSON.parse(readFileSync(p, "utf8")).share_answered_via, "command");
  const r = spawnSync(process.execPath, [cli, "check", "https://s.example/x"], { env: cliEnv(p), encoding: "utf8" });
  assert.ok(!r.stderr.includes(kit.SHARE_HINT) && !r.stderr.includes("[Y/n]"));
  execFileSync(process.execPath, [cli, "telemetry", "off"], { env: cliEnv(p) });
  assert.equal(kit.loadConfig(p, {}).telemetry, false);
});
