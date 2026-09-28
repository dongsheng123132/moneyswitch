import { describe, it, expect } from "vitest";
import { resolveOutboundProxy } from "../src/resolve.js";
import type { RegQueryFn } from "../src/windows-proxy.js";

const winProxyOn: RegQueryFn = (name) => {
  if (name === "ProxyEnable") return "    ProxyEnable    REG_DWORD    0x1\r\n";
  if (name === "ProxyServer") return "    ProxyServer    REG_SZ    127.0.0.1:7897\r\n";
  if (name === "ProxyOverride") return "    ProxyOverride    REG_SZ    localhost;<local>\r\n";
  return null;
};
const winProxyOff: RegQueryFn = (name) => (name === "ProxyEnable" ? "    ProxyEnable    REG_DWORD    0x0\r\n" : null);

describe("resolveOutboundProxy: priority order", () => {
  it("1. MONEYSWITCH_PROXY (explicit URL) wins over everything else", () => {
    const r = resolveOutboundProxy({
      env: { MONEYSWITCH_PROXY: "http://10.0.0.9:8080", HTTPS_PROXY: "http://ignored:1" },
      platform: "win32",
      regQuery: winProxyOn,
    });
    expect(r).toEqual({ url: "http://10.0.0.9:8080", source: "MONEYSWITCH_PROXY", noProxy: [] });
  });

  it("MONEYSWITCH_PROXY without a scheme is normalized to http://", () => {
    const r = resolveOutboundProxy({ env: { MONEYSWITCH_PROXY: "127.0.0.1:7897" } });
    expect(r.url).toBe("http://127.0.0.1:7897");
    expect(r.source).toBe("MONEYSWITCH_PROXY");
  });

  it('MONEYSWITCH_PROXY="off" disables everything, even if env/system proxies exist', () => {
    const r = resolveOutboundProxy({
      env: { MONEYSWITCH_PROXY: "off", HTTPS_PROXY: "http://ignored:1" },
      platform: "win32",
      regQuery: winProxyOn,
    });
    expect(r).toEqual({ url: null, source: "none", noProxy: [] });
  });

  it('MONEYSWITCH_PROXY="auto" (and unset) fall through to the next priority', () => {
    for (const env of [{ MONEYSWITCH_PROXY: "auto", HTTPS_PROXY: "http://1.2.3.4:9" }, { HTTPS_PROXY: "http://1.2.3.4:9" }]) {
      const r = resolveOutboundProxy({ env });
      expect(r.source).toBe("env");
      expect(r.url).toBe("http://1.2.3.4:9");
    }
  });

  it("2. standard env vars (case-insensitive) beat the Windows system proxy", () => {
    const r = resolveOutboundProxy({ env: { https_proxy: "http://1.1.1.1:1" }, platform: "win32", regQuery: winProxyOn });
    expect(r).toEqual({ url: "http://1.1.1.1:1", source: "env", noProxy: [] });
  });

  it("env precedence: HTTPS_PROXY > HTTP_PROXY > ALL_PROXY", () => {
    expect(
      resolveOutboundProxy({ env: { HTTPS_PROXY: "http://a:1", HTTP_PROXY: "http://b:2", ALL_PROXY: "http://c:3" } }).url
    ).toBe("http://a:1");
    expect(resolveOutboundProxy({ env: { HTTP_PROXY: "http://b:2", ALL_PROXY: "http://c:3" } }).url).toBe("http://b:2");
    expect(resolveOutboundProxy({ env: { ALL_PROXY: "http://c:3" } }).url).toBe("http://c:3");
  });

  it("3. Windows system proxy is used only when nothing else matched, and only on win32", () => {
    const r = resolveOutboundProxy({ env: {}, platform: "win32", regQuery: winProxyOn });
    expect(r).toEqual({ url: "http://127.0.0.1:7897", source: "windows-system", noProxy: ["localhost"] });
  });

  it("non-win32 platforms never consult the Windows registry", () => {
    const r = resolveOutboundProxy({ env: {}, platform: "linux", regQuery: winProxyOn });
    expect(r).toEqual({ url: null, source: "none", noProxy: [] });
  });

  it("win32 with the system proxy toggled off falls through to none", () => {
    const r = resolveOutboundProxy({ env: {}, platform: "win32", regQuery: winProxyOff });
    expect(r).toEqual({ url: null, source: "none", noProxy: [] });
  });

  it("4. nothing configured anywhere -> none", () => {
    expect(resolveOutboundProxy({ env: {}, platform: "linux" })).toEqual({ url: null, source: "none", noProxy: [] });
  });
});

describe("resolveOutboundProxy: NO_PROXY", () => {
  it("NO_PROXY/no_proxy (either case) is parsed on comma or semicolon, and merged with Windows ProxyOverride", () => {
    const r1 = resolveOutboundProxy({ env: { HTTPS_PROXY: "http://p:1", NO_PROXY: "a.com, b.com;c.com" } });
    expect(r1.noProxy).toEqual(["a.com", "b.com", "c.com"]);

    const r2 = resolveOutboundProxy({ env: { no_proxy: "x.com" }, platform: "win32", regQuery: winProxyOn });
    expect(r2.noProxy).toEqual(["x.com", "localhost"]);
  });
});
