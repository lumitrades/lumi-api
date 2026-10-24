/** Signed client for Lumi's contributor API. Every request is signed with the contributor key (not a wallet key). */
import { signRequest } from "./contributor_key.js";
import { kitHeader, DEFAULT_API } from "./version.js";
import { loadConfig, SHARING_OFF_ERROR } from "./config.js";

/**
 * submit() is tier 2 (full signed receipts): it refuses, sending nothing, unless sharing is on
 * (config share_receipts / LUMI_SHARE_RECEIPTS / `lumi-scan sharing on`). Pass { config } to override in code.
 */
export function createLumiClient({ api = DEFAULT_API, keyId, privateKey, fetchImpl = fetch, config, configPath, env }) {
  if (!keyId || !privateKey) throw new Error("contributor key_id and private key required (run keygen, then ask Lumi to issue your key)");
  const base = api.replace(/\/+$/, "");
  async function call(method, path, bodyObj) {
    const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
    const { ts, signature } = signRequest(privateKey, method, path, body);
    const res = await fetchImpl(base + path, {
      method,
      headers: { "Lumi-Contributor-Key": keyId, "Lumi-Timestamp": ts, "Lumi-Signature": signature, "Lumi-Kit": kitHeader(), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body || undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, ...j };
  }
  return {
    async submit(receipt, mode) {
      const cfg = config ?? loadConfig(configPath, env);
      if (cfg.share_receipts !== true) return { status: 0, sent: false, error: "sharing_off", detail: SHARING_OFF_ERROR };
      return call("POST", "/v1/contrib/submissions", { mode, receipt });
    },
    credits: () => call("GET", "/v1/contrib/credits"),
    spendCredits: (product, input) => call("POST", "/v1/contrib/credits/spend", { product, input }),
    wanted: (o = {}) => call("GET", "/v1/contrib/wanted" + (o.network || o.limit ? "?" + new URLSearchParams({ ...(o.network ? { network: o.network } : {}), ...(o.limit ? { limit: String(o.limit) } : {}) }) : "")),
    me: () => call("GET", "/v1/contrib/me"),
    shareDemand: (v) => call("POST", "/v1/contrib/me", { share_demand: !!v }),
    /** Delete this contributor account (cannot be undone). `confirm` must equal this key's id. */
    async deleteAccount(confirm) {
      if (confirm !== keyId) return { status: 0, deleted: false, error: "confirm_key_id_required", detail: "Pass your own key_id to confirm. Nothing was sent." };
      return call("DELETE", "/v1/contrib/me", { confirm });
    },
  };
}
