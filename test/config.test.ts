import { describe, it, expect } from "vitest";
import { xrpToDrops, dropsToXrp, loadConfig, MAINNET_PAY_TO } from "../src/config";

describe("config", () => {
  it("converts XRP decimal strings to drops without float error", () => {
    expect(xrpToDrops("0.02")).toBe("20000");
    expect(xrpToDrops("0.05")).toBe("50000");
    expect(xrpToDrops("1")).toBe("1000000");
    expect(xrpToDrops("0.000001")).toBe("1");
    expect(() => xrpToDrops("0.0000001")).toThrow();
    expect(() => xrpToDrops("0")).toThrow();
    expect(() => xrpToDrops("-1")).toThrow();
    expect(dropsToXrp("20000")).toBe("0.02");
    expect(dropsToXrp("1000000")).toBe("1");
  });

  it("defaults to Lumi's mainnet wallet on mainnet and requires an invoice secret there", () => {
    expect(() => loadConfig({ XRPL_NETWORK: "xrpl:0" })).toThrow(/INVOICE_SECRET/);
    const cfg = loadConfig({ XRPL_NETWORK: "xrpl:0", INVOICE_SECRET: "x".repeat(32) });
    expect(cfg.payTo).toBe(MAINNET_PAY_TO);
    expect(cfg.facilitatorUrl).toBe("https://xrpl-facilitator-mainnet.t54.ai");
    expect(cfg.pricesDrops).toEqual({
      signal: "5000", levels: "5000", slate: "10000", market: "10000",
      brief: "15000", yen: "7500", sentiment: "3800", events: "3800", institutional: "77000", vendor_report: "15000",
      scan: "15000", lite: "3000", trust_check: "3000", funding: "2300", fear_greed: "2300", events_48h: "2300",
    });
    expect(loadConfig({ XRPL_NETWORK: "xrpl:1", PAY_TO: MAINNET_PAY_TO, PRICE_YEN_XRP: "0.02" }).pricesDrops.yen).toBe("20000");
  });

  it("requires an explicit PAY_TO off mainnet and validates it", () => {
    expect(() => loadConfig({ XRPL_NETWORK: "xrpl:1" })).toThrow(/PAY_TO/);
    expect(() => loadConfig({ XRPL_NETWORK: "xrpl:1", PAY_TO: "nope" })).toThrow(/PAY_TO/);
    const cfg = loadConfig({ XRPL_NETWORK: "xrpl:1", PAY_TO: MAINNET_PAY_TO, PRICE_SLATE_XRP: "0.1" });
    expect(cfg.pricesDrops.slate).toBe("100000");
    expect(cfg.invoiceSecretIsDevDefault).toBe(true);
  });
});
