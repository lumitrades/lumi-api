/** Signed client for Lumi's contributor API. Every request is signed with the contributor key (not a wallet key). */
import { signRequest } from "./contributor_key.js";
import { kitHeader, DEFAULT_API } from "./version.js";

export function createLumiClient({ api = DEFAULT_API, keyId, privateKey, fetchImpl = fetch }) {
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
    submit: (receipt, mode) => call("POST", "/v1/contrib/submissions", { mode, receipt }),
    wanted: (o = {}) => call("GET", "/v1/contrib/wanted" + (o.network || o.limit ? "?" + new URLSearchParams({ ...(o.network ? { network: o.network } : {}), ...(o.limit ? { limit: String(o.limit) } : {}) }) : "")),
    me: () => call("GET", "/v1/contrib/me"),
    shareDemand: (v) => call("POST", "/v1/contrib/me", { share_demand: !!v }),
  };
}
