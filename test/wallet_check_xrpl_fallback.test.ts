import { describe, it, expect } from "vitest";
import { readXrpl } from "../src/trust/wallet_check";

const A = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
const D = "rGWrZyQqhTp9Xu7G5Pkayo7bXjH4k4QYpf";
const now = Date.now();
const tx = { TransactionType: "Payment", Account: A, Destination: D, DeliverMax: "1000000", date: Math.floor(now / 1000) - 946684800 - 60 };
const ok = { result: { status: "success", transactions: [{ tx_json: tx, meta: { TransactionResult: "tesSUCCESS", delivered_amount: "1000000" }, hash: "AB" }] } };

function fakeFetch(map: Record<string, any>) {
  const calls: string[] = [];
  const f = (async (u: any) => { calls.push(String(u)); const b = map[String(u)]; if (b instanceof Error) throw b; return new Response(JSON.stringify(b), { status: 200 }); }) as typeof fetch;
  return { f, calls };
}

describe("readXrpl server fallback", () => {
  it("moves on when a server answers HTTP 200 with result.error (slowDown)", async () => {
    const { f, calls } = fakeFetch({ "https://a/": { result: { status: "error", error: "slowDown" } }, "https://b/": ok });
    const r = await readXrpl(f, ["https://a/", "https://b/"], A, now - 86_400_000);
    expect(calls).toEqual(["https://a/", "https://b/"]);
    expect(r.error).toBeUndefined();
    expect(r.payments).toHaveLength(1);
    expect(r.payments[0]).toMatchObject({ to: D, amount: "1", asset: "XRP" });
  });
  it("moves on after a network error, and reports read_failed when every server fails", async () => {
    const { f } = fakeFetch({ "https://a/": new Error("boom"), "https://b/": { result: { error: "tooBusy" } } });
    const r = await readXrpl(f, ["https://a/", "https://b/"], A, now - 86_400_000);
    expect(r).toMatchObject({ complete: false, error: "read_failed", payments: [] });
  });
  it("stops at actNotFound", async () => {
    const { f, calls } = fakeFetch({ "https://a/": { result: { status: "error", error: "actNotFound" } }, "https://b/": ok });
    const r = await readXrpl(f, ["https://a/", "https://b/"], A, now - 86_400_000);
    expect(r.error).toBe("account_not_found");
    expect(calls).toEqual(["https://a/"]);
  });
});
