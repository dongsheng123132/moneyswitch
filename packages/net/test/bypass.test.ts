import { describe, it, expect } from "vitest";
import { isAlwaysDirectHost, matchesNoProxyEntry, shouldBypassProxy } from "../src/bypass.js";

describe("isAlwaysDirectHost", () => {
  it("localhost and loopback forms", () => {
    expect(isAlwaysDirectHost("localhost")).toBe(true);
    expect(isAlwaysDirectHost("LOCALHOST")).toBe(true);
    expect(isAlwaysDirectHost("127.0.0.1")).toBe(true);
    expect(isAlwaysDirectHost("127.255.255.255")).toBe(true);
    expect(isAlwaysDirectHost("::1")).toBe(true);
    expect(isAlwaysDirectHost("[::1]")).toBe(true);
  });

  it("private RFC1918 + CGNAT ranges", () => {
    expect(isAlwaysDirectHost("10.0.0.1")).toBe(true);
    expect(isAlwaysDirectHost("10.255.255.255")).toBe(true);
    expect(isAlwaysDirectHost("172.16.0.1")).toBe(true);
    expect(isAlwaysDirectHost("172.31.255.255")).toBe(true);
    expect(isAlwaysDirectHost("192.168.1.1")).toBe(true);
    expect(isAlwaysDirectHost("100.64.0.1")).toBe(true);
    expect(isAlwaysDirectHost("100.127.255.255")).toBe(true);
  });

  it("public / adjacent-but-not-private ranges are not always-direct", () => {
    expect(isAlwaysDirectHost("monad-lingqian.vercel.app")).toBe(false);
    expect(isAlwaysDirectHost("8.8.8.8")).toBe(false);
    expect(isAlwaysDirectHost("172.32.0.1")).toBe(false); // just outside 172.16/12
    expect(isAlwaysDirectHost("172.15.255.255")).toBe(false);
    expect(isAlwaysDirectHost("100.63.255.255")).toBe(false); // just outside 100.64/10
    expect(isAlwaysDirectHost("100.128.0.1")).toBe(false);
    expect(isAlwaysDirectHost("11.0.0.1")).toBe(false);
  });
});

describe("matchesNoProxyEntry", () => {
  it("exact and dot-suffix matches (NO_PROXY convention)", () => {
    expect(matchesNoProxyEntry("api.example.com", "example.com")).toBe(true);
    expect(matchesNoProxyEntry("api.example.com", ".example.com")).toBe(true);
    expect(matchesNoProxyEntry("example.com", "example.com")).toBe(true);
    expect(matchesNoProxyEntry("evilexample.com", "example.com")).toBe(false);
  });

  it("* glob matches (Windows ProxyOverride convention)", () => {
    expect(matchesNoProxyEntry("192.168.1.5", "192.168.*")).toBe(true);
    expect(matchesNoProxyEntry("foo.contoso.com", "*.contoso.com")).toBe(true);
    expect(matchesNoProxyEntry("anything", "*")).toBe(true);
  });
});

describe("shouldBypassProxy", () => {
  it("always-direct wins even with an empty noProxy list", () => {
    expect(shouldBypassProxy("127.0.0.1", [])).toBe(true);
  });

  it("noProxy entries bypass otherwise-public hosts", () => {
    expect(shouldBypassProxy("internal.corp.example", ["*.corp.example"])).toBe(true);
    expect(shouldBypassProxy("monad-lingqian.vercel.app", ["*.corp.example"])).toBe(false);
  });
});
