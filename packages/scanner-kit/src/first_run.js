/**
 * One-time "share your results" question, asked right AFTER the user's first `lumi-scan check` has printed its result.
 *
 * - Sharing (tier 1 delivery outcomes) is OFF until the user says yes. Nothing is sent before that.
 * - Yes is the highlighted default: `[Y/n]`, Enter means yes.
 * - The answer is saved in the kit config ("telemetry" + "share_answered_at"), so the question never shows again.
 * - Never asked when there is no way to ask (stdin or stderr not a terminal, CI, MCP server mode, library use) or when
 *   LUMI_CHECK_TELEMETRY is set. Those runs stay off and print one hint on how to turn it on.
 * - The answer only controls what is shared. It never changes how any score is computed.
 */
import { loadConfig, recordShareChoice, defaultConfigPath } from "./config.js";

export const SHARE_QUESTION = "Share your results to help improve Lumi's public trust list?";
export const SHARE_DETAIL =
  "Shares only the seller's host, delivered yes/no and status class after paid calls. No wallet addresses, amounts, tx hashes or URL paths. Turn off any time: lumi-scan telemetry off";
export const SHARE_HINT =
  "Lumi Check: result sharing is off (not asked: no terminal). To help improve Lumi's public trust list, run `lumi-scan telemetry on` or set LUMI_CHECK_TELEMETRY=on. Shares only seller host, delivered yes/no and status class; no wallet addresses or amounts.";

const CI_VARS = ["CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "TF_BUILD"];
export function isCi(env = process.env) {
  return CI_VARS.some((k) => { const v = String(env[k] ?? "").trim().toLowerCase(); return v !== "" && v !== "0" && v !== "false"; });
}

/** "ask" (interactive, unanswered), "hint" (unanswered, no way to ask) or "none" (answered or env-controlled). */
export function shareQuestionState(cfg, { stdin = process.stdin, stderr = process.stderr, env = process.env } = {}) {
  if (cfg.share_answered || cfg.telemetry_source === "env") return "none";
  if (!stdin?.isTTY || !stderr?.isTTY || isCi(env) || /^(1|true|yes)$/i.test(String(env.LUMI_NO_PROMPT ?? ""))) return "hint";
  return "ask";
}

/** Render the question. Yes is highlighted (bold green "Y") when color is allowed. */
export function renderShareQuestion({ color = false } = {}) {
  const yes = color ? "\x1b[1;32mY\x1b[0m" : "Y";
  const dim = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  return `\n${dim(SHARE_DETAIL)}\n${SHARE_QUESTION} [${yes}/n] `;
}

/** "" / y / yes -> true; n / no -> false; anything else -> null (ask again). */
export function parseShareAnswer(a) {
  const s = String(a ?? "").trim().toLowerCase();
  if (s === "" || s === "y" || s === "yes") return true;
  if (s === "n" || s === "no") return false;
  return null;
}

/**
 * Call after the first check's result has been shown. Returns { asked, shared?, saved?, hinted? }.
 * Streams and env are injectable for tests.
 */
export async function maybeAskToShare({ configPath = defaultConfigPath(), env = process.env, stdin = process.stdin, stderr = process.stderr, now } = {}) {
  const cfg = loadConfig(configPath, env);
  const state = shareQuestionState(cfg, { stdin, stderr, env });
  if (state === "none") return { asked: false };
  if (state === "hint") { stderr.write(SHARE_HINT + "\n"); return { asked: false, hinted: true }; }
  const color = !env.NO_COLOR && env.TERM !== "dumb";
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: stdin, output: stderr });
  const CLOSED = Symbol("closed");
  const closed = new Promise((res) => rl.once("close", () => res(CLOSED))); // EOF / Ctrl-D: nothing saved
  let answer = null;
  try {
    for (let i = 0; i < 3 && answer === null; i++) {
      const raw = await Promise.race([rl.question(i === 0 ? renderShareQuestion({ color }) : "Please answer y or n [Y/n] ").catch(() => CLOSED), closed]);
      if (raw === CLOSED) break;
      answer = parseShareAnswer(raw);
    }
  } finally { rl.close(); }
  if (answer === null) {
    stderr.write("Not saved; sharing stays off. You can choose any time with `lumi-scan telemetry on|off`.\n");
    return { asked: true, saved: false, shared: false };
  }
  recordShareChoice(answer, { path: configPath, via: "first_check_prompt", now });
  stderr.write(answer
    ? `Thanks. Sharing is on (saved in ${configPath}). Turn off any time: lumi-scan telemetry off\n`
    : `OK, sharing stays off (saved in ${configPath}). Turn on any time: lumi-scan telemetry on\n`);
  return { asked: true, saved: true, shared: answer };
}

let hintedThisProcess = false;
/** For code paths that can never ask (library, MCP server): print the hint at most once per process, and only while unanswered. */
export function hintOnce(cfg, { stderr = process.stderr } = {}) {
  if (hintedThisProcess || cfg.share_answered || cfg.telemetry_source === "env" || cfg.telemetry === true) return false;
  hintedThisProcess = true;
  try { stderr.write(SHARE_HINT.replace("(not asked: no terminal)", "(not asked here)") + "\n"); } catch {}
  return true;
}
export function _resetHintForTests() { hintedThisProcess = false; }
