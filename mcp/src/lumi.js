/**
 * Lumi API client used by the MCP server: free calls, quotes (402 terms) and paid calls with spend caps, through
 * x402-xrpl (XRP / RLUSD / USDC on the XRP Ledger) or @x402/fetch + @x402/evm (USDC on Base, EIP-3009, gasless).
 * No MCP code here, so it can be tested on its own.
 */
import { Wallet } from "xrpl";
import { x402Fetch, decodePaymentResponseHeader, XRPLPresignedPaymentPayer } from "x402-xrpl";

export const MAINNET_API = "https://api.lumitrades.io";
export const MAINNET_PAY_TO = "rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM";
export const MAINNET_EVM_PAY_TO = "0x5E617bac19912e6d212CB303ae84655E9E203532";
export const BASE_NETWORK = "eip155:8453";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ASSETS = ["XRP", "RLUSD", "USDC", "BASE_USDC"];
const STABLES = {
  RLUSD: { currency: "524C555344000000000000000000000000000000" },
  USDC: { currency: "5553444300000000000000000000000000000000" },
};

/** Read and validate configuration from the environment. The seed is only held in memory, never logged or returned. */
export function loadSettings(env = process.env) {
  const network = env.XRPL_NETWORK || "xrpl:0";
  if (!["xrpl:0", "xrpl:1", "xrpl:2"].includes(network)) throw new Error(`XRPL_NETWORK must be xrpl:0, xrpl:1 or xrpl:2 (got ${network})`);
  const apiUrl = (env.LUMI_API_URL || MAINNET_API).replace(/\/+$/, "");
  const evmKey = (env.EVM_PRIVATE_KEY || "").trim();
  if (evmKey && !/^0x[0-9a-fA-F]{64}$/.test(evmKey)) throw new Error("EVM_PRIVATE_KEY must be a 0x-prefixed 32-byte hex private key");
  // Default rail: XRPL when a seed is set (home network), else Base USDC when an EVM key is set, else XRP (quotes only).
  let asset = (env.LUMI_PAY_ASSET || (!env.XRPL_SEED && evmKey ? "BASE_USDC" : "XRP")).toUpperCase().replace(/[- ]/g, "_");
  if (asset === "BASE" || asset === "USDC_BASE") asset = "BASE_USDC";
  if (!ASSETS.includes(asset)) throw new Error("LUMI_PAY_ASSET must be XRP, RLUSD, USDC (XRPL) or BASE_USDC (USDC on Base)");
  const num = (v, d, name) => {
    const n = v === undefined || v === "" ? d : Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
    return n;
  };
  return {
    network,
    apiUrl,
    asset,
    rail: asset === "BASE_USDC" ? "base" : "xrpl",
    seed: env.XRPL_SEED || "",
    evmKey,
    wsUrl: env.XRPL_WS_URL || (network === "xrpl:0" ? "wss://xrplcluster.com" : "wss://testnet.xrpl-labs.com"),
    // Defaults cover every Lumi paid tool (the most expensive is $0.02).
    maxXrpPerCall: num(env.LUMI_MAX_XRP_PER_CALL, 0.25, "LUMI_MAX_XRP_PER_CALL"),
    maxUsdPerCall: num(env.LUMI_MAX_USD_PER_CALL, 0.3, "LUMI_MAX_USD_PER_CALL"),
    // Session budget across all paid calls in this server process, in the chosen asset (XRP or USD). 0 = no paid calls.
    budget: num(env.LUMI_SESSION_BUDGET, 1, "LUMI_SESSION_BUDGET"),
    // Only pay this address. Defaults to Lumi's mainnet wallet when talking to the official API on mainnet.
    expectedPayTo:
      env.LUMI_EXPECTED_PAY_TO ||
      (apiUrl === MAINNET_API && (asset === "BASE_USDC" ? MAINNET_EVM_PAY_TO : network === "xrpl:0" ? MAINNET_PAY_TO : "")),
  };
}

const isBase = (a) => a.network === BASE_NETWORK && String(a.asset).toLowerCase() === BASE_USDC.toLowerCase();
/** Quote amount in whole units: XRP drops -> XRP, Base USDC atomic (6 decimals) -> USDC, XRPL IOUs are already decimal. */
export const toNumber = (req) => (req.asset === "XRP" ? Number(req.amount) / 1e6 : isBase(req) ? Number(req.amount) / 1e6 : Number(req.amount));
export const capVar = (asset) => (asset === "XRP" ? "LUMI_MAX_XRP_PER_CALL" : "LUMI_MAX_USD_PER_CALL");
export const assetLabel = (asset) => (asset === "BASE_USDC" ? "USDC on Base" : asset);

/**
 * Pick the accepts[] option for the configured asset and enforce: network, payTo, per-call cap, session budget.
 * Throws (so nothing is signed) when no option qualifies.
 */
export function makeSelector(settings, ledger) {
  return (accepts) => {
    ledger.lastError = null;
    const want =
      settings.asset === "BASE_USDC"
        ? isBase
        : settings.asset === "XRP"
          ? (a) => a.network === settings.network && a.asset === "XRP"
          : (a) => a.network === settings.network && (a.asset === STABLES[settings.asset].currency || a.extra?.symbol === settings.asset);
    const opt = accepts.find((a) => a.scheme === "exact" && want(a));
    const fail = (msg) => {
      ledger.lastError = msg;
      return new SpendError(msg);
    };
    if (!opt) throw fail(`no ${assetLabel(settings.asset)} option${settings.asset === "BASE_USDC" ? "" : ` on ${settings.network}`} in the 402 quote`);
    if (settings.expectedPayTo && opt.payTo.toLowerCase() !== settings.expectedPayTo.toLowerCase()) {
      throw fail(`refusing to pay ${opt.payTo}: expected ${settings.expectedPayTo}`);
    }
    const amt = toNumber(opt);
    const cap = settings.asset === "XRP" ? settings.maxXrpPerCall : settings.maxUsdPerCall;
    if (!(amt > 0)) throw fail(`invalid quoted amount ${opt.amount}`);
    if (amt > cap) {
      throw fail(`price ${amt} ${assetLabel(settings.asset)} is above the per-call cap ${cap}. To allow it, set ${capVar(settings.asset)}=${amt} (or higher) in this MCP server's env and restart it`);
    }
    if (ledger.spent + amt > settings.budget + 1e-12) {
      throw fail(`session budget ${settings.budget} ${assetLabel(settings.asset)} would be exceeded (spent ${round(ledger.spent)}). Raise LUMI_SESSION_BUDGET or restart the server`);
    }
    ledger.pending = amt;
    return opt;
  };
}

export class SpendError extends Error {}
const round = (n) => Math.round(n * 1e6) / 1e6;

export function createClient(settings, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const ledger = { spent: 0, pending: 0, calls: [], lastError: null };
  let paidFetch = null;

  async function evmPayer() {
    if (!settings.evmKey) return null;
    if (!paidFetch) {
      const [{ wrapFetchWithPayment, x402Client }, { registerExactEvmScheme }, { privateKeyToAccount }] = await Promise.all([
        import("@x402/fetch"),
        import("@x402/evm/exact/client"),
        import("viem/accounts"),
      ]);
      const select = makeSelector(settings, ledger);
      const client = deps.x402Client ?? new x402Client((_v, reqs) => select(reqs));
      registerExactEvmScheme(client, { signer: privateKeyToAccount(settings.evmKey) });
      paidFetch = (deps.wrapFetchWithPayment ?? wrapFetchWithPayment)(fetchImpl, client);
    }
    return paidFetch;
  }

  async function payer() {
    if (settings.rail === "base") return evmPayer();
    if (!settings.seed) return null;
    if (!paidFetch) {
      paidFetch = (deps.x402Fetch ?? x402Fetch)({
        wallet: Wallet.fromSeed(settings.seed),
        network: settings.network,
        wsUrl: settings.wsUrl,
        paymentRequirementsSelector: makeSelector(settings, ledger),
        // Sign locally (the seed never leaves this process); record signing errors, which the SDK would otherwise swallow.
        paymentHeaderFactory: async (reqs, ctx) => {
          try {
            const p = new XRPLPresignedPaymentPayer({ wallet: Wallet.fromSeed(settings.seed), network: reqs.network, wsUrl: settings.wsUrl, invoiceBinding: "both" });
            return await p.createPaymentHeader(reqs, ctx);
          } catch (e) {
            ledger.lastError = `could not sign the payment: ${e?.message ?? e}`;
            throw e;
          }
        },
        fetchImpl,
      });
    }
    return paidFetch;
  }

  async function readBody(res) {
    const type = res.headers.get("content-type") || "";
    const text = await res.text();
    if (type.includes("json")) {
      try {
        return JSON.parse(text);
      } catch {
        /* fall through */
      }
    }
    return text;
  }

  return {
    settings,
    ledger,
    walletAddress: async () => {
      if (settings.rail === "base") {
        if (!settings.evmKey) return null;
        const { privateKeyToAccount } = await import("viem/accounts");
        return privateKeyToAccount(settings.evmKey).address;
      }
      return settings.seed ? Wallet.fromSeed(settings.seed).classicAddress : null;
    },

    /** Free GET (index, coins, health, discovery). */
    async free(path) {
      const res = await fetchImpl(settings.apiUrl + path, { headers: { Accept: "application/json" } });
      return { status: res.status, body: await readBody(res) };
    },

    /** Unpaid GET of a paid path: returns the 402 terms (prices per asset) without paying. */
    async quote(path) {
      const res = await fetchImpl(settings.apiUrl + path, { headers: { Accept: "application/json" } });
      const body = await readBody(res);
      if (res.status !== 402) return { status: res.status, body };
      return {
        status: 402,
        resource: body.resource?.url,
        description: body.resource?.description,
        options: (body.accepts || []).map((a) => ({
          asset: a.asset === "XRP" ? "XRP" : a.extra?.symbol ?? a.asset,
          amount: a.asset === "XRP" || isBase(a) ? String(toNumber(a)) : a.amount,
          network: a.network,
          payTo: a.payTo,
        })),
      };
    },

    /** Paid GET: pays per the 402 quote with the user's wallet, within caps. */
    async paid(path, accept = "application/json") {
      const pf = await payer();
      if (!pf) {
        const q = await this.quote(path);
        const need = settings.rail === "base" ? "EVM_PRIVATE_KEY" : "XRPL_SEED (or EVM_PRIVATE_KEY for USDC on Base)";
        return { paid: false, status: q.status, error: `${need} is not set, so no payment was made. Terms:`, quote: q };
      }
      ledger.pending = 0;
      ledger.lastError = null;
      let res;
      try {
        res = await pf(settings.apiUrl + path, { headers: { Accept: accept } });
      } catch (e) {
        if (ledger.lastError) return { paid: false, error: `not paid: ${ledger.lastError}` };
        if (e instanceof SpendError || e?.cause instanceof SpendError) return { paid: false, error: `not paid: ${e.message}` };
        return { paid: false, error: `request failed before any confirmed payment: ${e?.message ?? e}` };
      }
      const body = await readBody(res);
      if (res.status === 402 && ledger.lastError) {
        return { paid: false, status: 402, error: `not paid: ${ledger.lastError}`, quote: body?.accepts ?? body };
      }
      const rh = res.headers.get("PAYMENT-RESPONSE");
      let receipt = null;
      if (rh) {
        try {
          receipt = decodePaymentResponseHeader(rh);
        } catch {
          try {
            receipt = JSON.parse(Buffer.from(rh, "base64").toString("utf8"));
          } catch {
            receipt = null;
          }
        }
      }
      if (res.status === 200 && receipt?.success) {
        ledger.spent = round(ledger.spent + ledger.pending);
        ledger.calls.push({ path, amount: ledger.pending, asset: settings.asset, tx: receipt.transaction });
      }
      return {
        paid: res.status === 200 && !!receipt?.success,
        status: res.status,
        body,
        receipt,
        spent_this_session: `${ledger.spent} ${assetLabel(settings.asset)}`,
      };
    },
  };
}
