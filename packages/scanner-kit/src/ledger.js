/** Read-only ledger lookups so a passive receipt can be filled from a tx hash. Public RPCs only, no keys. */
const RLUSD_HEX = "524C555344000000000000000000000000000000";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const XRPL_RPC = ["https://xrplcluster.com/", "https://s1.ripple.com:51234/"];
export const BASE_RPC = "https://mainnet.base.org";
export const HORIZON = "https://horizon.stellar.org";

async function post(f, url, body) {
  const r = await f(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error("rpc " + r.status);
  return r.json();
}

/** { payer, pay_to, amount, asset, issuer?, ts, ledger_result } for a payment tx, or throws. */
export async function paymentFromLedger(network, tx, { fetchImpl = fetch, xrplRpc = XRPL_RPC, baseRpc = BASE_RPC, horizon = HORIZON, payTo } = {}) {
  if (network === "xrpl:0") {
    let last;
    for (const u of xrplRpc) {
      try {
        const j = await post(fetchImpl, u, { method: "tx", params: [{ transaction: tx, api_version: 2 }] });
        const r = j.result; if (!r || r.error) { last = r?.error; continue; }
        const t = r.tx_json ?? r, meta = r.meta;
        if (!r.validated) throw new Error("tx not validated");
        if (t.TransactionType !== "Payment") throw new Error("not a payment");
        const d = meta?.delivered_amount ?? t.DeliverMax ?? t.Amount;
        const xrp = typeof d === "string";
        return {
          payer: t.Account, pay_to: t.Destination, amount: xrp ? String(Number(d) / 1e6) : String(d.value),
          asset: xrp ? "XRP" : d.currency === RLUSD_HEX ? "RLUSD" : d.currency, ...(xrp ? {} : { issuer: d.issuer }),
          ts: r.close_time_iso ? Date.parse(r.close_time_iso) : (t.date + 946_684_800) * 1000, ledger_result: meta?.TransactionResult ?? "unknown", ledger_index: r.ledger_index,
        };
      } catch (e) { last = e; }
    }
    throw new Error("xrpl lookup failed: " + String(last?.message ?? last));
  }
  if (network === "eip155:8453") {
    const rc = (await post(fetchImpl, baseRpc, { jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [tx] })).result;
    if (!rc) throw new Error("tx not found");
    const logs = (rc.logs ?? []).filter((l) => l.address?.toLowerCase() === BASE_USDC && l.topics?.[0] === TRANSFER_TOPIC);
    const pick = logs.find((l) => !payTo || ("0x" + l.topics[2].slice(26)).toLowerCase() === payTo.toLowerCase()) ?? logs[0];
    if (!pick) throw new Error("no USDC transfer in tx");
    const blk = (await post(fetchImpl, baseRpc, { jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: [rc.blockNumber, false] })).result;
    return {
      payer: "0x" + pick.topics[1].slice(26), pay_to: "0x" + pick.topics[2].slice(26), amount: String(Number(BigInt(pick.data)) / 1e6), asset: "USDC",
      ts: Number(BigInt(blk?.timestamp ?? "0x0")) * 1000, ledger_result: rc.status === "0x1" ? "success" : "reverted", block_number: Number(BigInt(rc.blockNumber)),
    };
  }
  if (network === "stellar:pubnet") {
    const base = horizon.replace(/\/+$/, "");
    const t = await (await fetchImpl(`${base}/transactions/${tx}`, { signal: AbortSignal.timeout(15_000) })).json();
    if (!t?.successful) throw new Error("tx not found or failed");
    const ops = await (await fetchImpl(`${base}/transactions/${tx}/operations?limit=20`, { signal: AbortSignal.timeout(15_000) })).json();
    for (const op of ops?._embedded?.records ?? []) {
      if (op.type === "payment" && op.asset_code === "USDC") return { payer: op.from, pay_to: op.to, amount: String(Number(op.amount)), asset: "USDC", ts: Date.parse(t.created_at), ledger_result: "success" };
      for (const c of op.asset_balance_changes ?? []) if (c.type === "transfer" && c.asset_code === "USDC") return { payer: c.from, pay_to: c.to, amount: String(Number(c.amount)), asset: "USDC", ts: Date.parse(t.created_at), ledger_result: "success" };
    }
    throw new Error("no USDC transfer in tx");
  }
  throw new Error("unsupported network " + network);
}
