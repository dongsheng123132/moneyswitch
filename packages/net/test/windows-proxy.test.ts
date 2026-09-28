import { describe, it, expect } from "vitest";
import { parseProxyServerValue, parseProxyOverride, readWindowsSystemProxy, type RegQueryFn } from "../src/windows-proxy.js";

// Fixtures captured from a real `reg query` run on a live Windows machine
// (Clash Verge's system-proxy toggle on, mixed port 7897) — see the module
// doc comments. Kept verbatim (including the CRLFs) so the parser is tested
// against actual reg.exe output shape, not an idealized one.
const REAL_PROXY_ENABLE =
  "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ProxyEnable    REG_DWORD    0x1\r\n\r\n";
const REAL_PROXY_DISABLED =
  "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ProxyEnable    REG_DWORD    0x0\r\n\r\n";
const REAL_PROXY_SERVER_SIMPLE =
  "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ProxyServer    REG_SZ    127.0.0.1:7897\r\n\r\n";
const REAL_PROXY_OVERRIDE =
  "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ProxyOverride    REG_SZ    ;localhost.*;;localhost;127.*;192.168.*;10.*;172.16.*;172.17.*;<local>\r\n\r\n";

describe("parseProxyServerValue", () => {
  it("simple 'host:port' form applies to all protocols", () => {
    expect(parseProxyServerValue("127.0.0.1:7897")).toBe("http://127.0.0.1:7897");
  });

  it("'proto=host:port;...' form prefers https, falls back to http", () => {
    expect(parseProxyServerValue("http=127.0.0.1:7897;https=127.0.0.1:7898;ftp=127.0.0.1:7899")).toBe(
      "http://127.0.0.1:7898"
    );
    expect(parseProxyServerValue("http=127.0.0.1:7897;ftp=127.0.0.1:7899")).toBe("http://127.0.0.1:7897");
  });

  it("empty/whitespace-only value is null", () => {
    expect(parseProxyServerValue("   ")).toBeNull();
  });
});

describe("parseProxyOverride", () => {
  it("splits on ';', drops empty segments and the '<local>' token", () => {
    expect(parseProxyOverride(";localhost.*;;localhost;127.*;<local>")).toEqual([
      "localhost.*",
      "localhost",
      "127.*",
    ]);
  });
});

describe("readWindowsSystemProxy (regQuery injected — never touches the real registry)", () => {
  it("ProxyEnable=0x1 + simple ProxyServer + ProxyOverride, all real-shaped output", () => {
    const regQuery: RegQueryFn = (name) => {
      if (name === "ProxyEnable") return REAL_PROXY_ENABLE;
      if (name === "ProxyServer") return REAL_PROXY_SERVER_SIMPLE;
      if (name === "ProxyOverride") return REAL_PROXY_OVERRIDE;
      return null;
    };
    expect(readWindowsSystemProxy(regQuery)).toEqual({
      url: "http://127.0.0.1:7897",
      noProxy: ["localhost.*", "localhost", "127.*", "192.168.*", "10.*", "172.16.*", "172.17.*"],
    });
  });

  it("ProxyEnable=0x0 (system proxy off) -> null, regardless of ProxyServer", () => {
    const regQuery: RegQueryFn = (name) => (name === "ProxyEnable" ? REAL_PROXY_DISABLED : REAL_PROXY_SERVER_SIMPLE);
    expect(readWindowsSystemProxy(regQuery)).toBeNull();
  });

  it("ProxyEnable value missing entirely (key never set) -> null", () => {
    const regQuery: RegQueryFn = () => null;
    expect(readWindowsSystemProxy(regQuery)).toBeNull();
  });

  it("enabled but ProxyServer missing -> url null, noProxy still parsed", () => {
    const regQuery: RegQueryFn = (name) => {
      if (name === "ProxyEnable") return REAL_PROXY_ENABLE;
      if (name === "ProxyOverride") return REAL_PROXY_OVERRIDE;
      return null;
    };
    const result = readWindowsSystemProxy(regQuery);
    expect(result?.url).toBeNull();
    expect(result?.noProxy).toContain("127.*");
  });
});
