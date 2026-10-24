/** Free x402 quote check: an unpaid request, read the 402 and list what each chain would cost. Never pays. */
const NET_LABEL = { "xrpl:0": "XRPL", "eip155:8453": "Base", "stellar:pubnet": "Stellar" };
const RLUSD_HEX = "524C555344000000000000000000000000000000";

export function decodeHeaderJson(v) {
  if (!v) return null;
  try { return JSON.parse(Buffer.from(v, "base64").toString("utf8")); } catch { try { return JSON.parse(v); } catch { return null; } }
}

/** Human amount for one accepts[] entry (XRP drops, RLUSD decimal, USDC 6 or 7 decimals). */
export function quoteAmount(a) {
  const amt = String(a.amount ?? a.maxAmountRequired ?? "");
  const asset = String(a.asset ?? "");
  if (a.network === "xrpl:0") {
    if (!asset || asset === "XRP") return { asset: "XRP", amount: /^\d+$/.test(amt) ? String(Number(amt) / 1e6) : amt };
    const code = asset.split(":")[0];
    return { asset: code === RLUSD_HEX || code === "RLUSD" ? "RLUSD" : code, amount: amt };
  }
  if (a.network === "eip155:8453") return { asset: "USDC", amount: /^\d+$/.test(amt) ? String(Number(amt) / 1e6) : amt };
  if (a.network === "stellar:pubnet") return { asset: "USDC", amount: /^\d+$/.test(amt) ? String(Number(amt) / 1e7) : amt };
  return { asset, amount: amt };
}

export async function checkQuote(url, { method = "GET", body, headers = {}, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetchImpl(url, {
      method, headers: { Accept: "application/json", ...(body != null ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body != null ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined, signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, url, error: "fetch_failed", detail: String(e?.message ?? e).slice(0, 200), quote_latency_ms: Date.now() - t0 };
  }
  const latency = Date.now() - t0;
  const text = await res.text().catch(() => "");
  let pr = decodeHeaderJson(res.headers.get("PAYMENT-REQUIRED"));
  if (!pr) { try { pr = JSON.parse(text); } catch { pr = null; } }
  const accepts = Array.isArray(pr?.accepts) ? pr.accepts : [];
  const quotes = accepts.map((a) => ({
    network: a.network, chain: NET_LABEL[a.network] ?? a.network, scheme: a.scheme, ...quoteAmount(a), pay_to: a.payTo, facilitator: a.extra?.facilitator ?? a.extra?.facilitatorUrl,
  }));
  return {
    ok: res.status === 402 && quotes.length > 0, url, http_status: res.status, quote_latency_ms: latency, x402_version: pr?.x402Version ?? null,
    resource: pr?.resource?.url ?? pr?.resource ?? url, quotes, accepts, payment_required: pr,
    ...(res.status !== 402 ? { note: res.status < 300 ? "Endpoint returned data without payment (not x402-gated)." : "No 402 quote." } : {}),
  };
}
