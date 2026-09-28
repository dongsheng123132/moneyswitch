import { describe, it, expect, afterEach } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { installOutboundProxy, getInstalledOutboundProxy, redactProxyUrl, hostPortOf } from "../src/install.js";

// installOutboundProxy() mutates the process-wide undici dispatcher; always
// put it back so this file doesn't leak a fake dispatcher into other tests.
const originalDispatcher = getGlobalDispatcher();
afterEach(() => setGlobalDispatcher(originalDispatcher));

describe('installOutboundProxy: MONEYSWITCH_PROXY="off"', () => {
  it("does not install a dispatcher, and resolves to source=none", () => {
    const before = getGlobalDispatcher();
    const resolution = installOutboundProxy({ env: { MONEYSWITCH_PROXY: "off" } });
    expect(resolution).toEqual({ url: null, source: "none", noProxy: [] });
    expect(getGlobalDispatcher()).toBe(before); // unchanged
    expect(getInstalledOutboundProxy()).toEqual(resolution);
  });
});

describe("installOutboundProxy: a resolved proxy", () => {
  it("installs a dispatcher (global dispatcher reference changes) and records the resolution", () => {
    const before = getGlobalDispatcher();
    const resolution = installOutboundProxy({ env: { MONEYSWITCH_PROXY: "http://127.0.0.1:7897" } });
    expect(resolution.url).toBe("http://127.0.0.1:7897");
    expect(resolution.source).toBe("MONEYSWITCH_PROXY");
    expect(getGlobalDispatcher()).not.toBe(before);
    expect(getInstalledOutboundProxy()).toEqual(resolution);
  });
});

describe("redactProxyUrl / hostPortOf", () => {
  it("redactProxyUrl strips userinfo, keeps host:port", () => {
    expect(redactProxyUrl("http://user:pass@127.0.0.1:7897")).toBe("http://127.0.0.1:7897");
    expect(redactProxyUrl("http://127.0.0.1:7897")).toBe("http://127.0.0.1:7897");
  });

  it("hostPortOf returns only host:port, never credentials", () => {
    expect(hostPortOf("http://user:pass@127.0.0.1:7897")).toBe("127.0.0.1:7897");
    expect(hostPortOf("http://127.0.0.1:7897")).toBe("127.0.0.1:7897");
  });
});
