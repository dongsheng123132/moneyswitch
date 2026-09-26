import { describe, it, expect } from "vitest";
import {
  matchRoute,
  normalizeRequestPath,
  normalizePathPattern,
  parseRouteSpec,
  splitTollboothUrl,
  slugify,
  TollPathError,
  type TollRoute,
} from "../src/routes.js";

const r = (method: TollRoute["method"], pathPattern: string, price: bigint): TollRoute => ({ method, pathPattern, price });
const m = (routes: TollRoute[], method: string, rawPath: string, def: bigint | null = null) =>
  matchRoute(routes, method, normalizeRequestPath(rawPath).matchPath, def);

describe("route matching: longest prefix, method, wildcard, default", () => {
  const routes = [
    r("ANY", "/*", 1000n),
    r("ANY", "/v1/*", 5000n),
    r("POST", "/v1/chat/completions", 10_000n),
    r("GET", "/v1/models", 0n),
    r("ANY", "/files/*.pdf", 20_000n),
  ];

  it("exact rule beats wildcard prefixes", () => {
    expect(m(routes, "POST", "/v1/chat/completions")).toMatchObject({ kind: "paid", price: 10_000n });
  });
  it("method-specific exact rule does not match another method → falls to the longest wildcard", () => {
    expect(m(routes, "GET", "/v1/chat/completions")).toMatchObject({ kind: "paid", price: 5000n });
  });
  it("price 0 → free pass-through", () => {
    expect(m(routes, "GET", "/v1/models")).toMatchObject({ kind: "free" });
  });
  it("HEAD matches GET rules (Express runs the GET handler for HEAD)", () => {
    expect(m(routes, "HEAD", "/v1/models")).toMatchObject({ kind: "free" });
    expect(m([r("GET", "/paid", 7n)], "HEAD", "/paid", 0n)).toMatchObject({ kind: "paid", price: 7n });
  });
  it("'/v1/*' also matches the bare prefix '/v1'", () => {
    expect(m(routes, "GET", "/v1")).toMatchObject({ kind: "paid", price: 5000n });
  });
  it("wildcard in the middle", () => {
    expect(m(routes, "GET", "/files/a/b/report.pdf")).toMatchObject({ kind: "paid", price: 20_000n });
    expect(m(routes, "GET", "/files/a.txt")).toMatchObject({ kind: "paid", price: 1000n });
  });
  it("catch-all '/*' matches root", () => {
    expect(m(routes, "GET", "/")).toMatchObject({ kind: "paid", price: 1000n });
  });
  it("no rule: default price, free default, or deny", () => {
    const only = [r("POST", "/v1/chat/completions", 10_000n)];
    expect(m(only, "GET", "/other", 3000n)).toMatchObject({ kind: "paid", price: 3000n, route: null });
    expect(m(only, "GET", "/other", 0n)).toMatchObject({ kind: "free", route: null });
    expect(m(only, "GET", "/other", null)).toEqual({ kind: "deny" });
  });
  it("ANY vs specific method on the same pattern: specific wins", () => {
    const rs = [r("ANY", "/x", 1n), r("POST", "/x", 2n)];
    expect(m(rs, "POST", "/x")).toMatchObject({ price: 2n });
    expect(m(rs, "GET", "/x")).toMatchObject({ price: 1n });
  });
});

describe("path normalization closes pricing bypasses", () => {
  const paidChatFreeRest = [r("POST", "/v1/chat/completions", 10_000n)];
  const free = 0n;
  it.each([
    "/v1/chat/completions/",
    "/V1/Chat/Completions",
    "//v1//chat///completions",
    "/v1/chat/complet%69ons",
    "/free/../v1/chat/completions",
    "/v1/x/%2e%2e/chat/completions",
    "/v1/./chat/completions",
  ])("%s is priced like /v1/chat/completions", (p) => {
    expect(m(paidChatFreeRest, "POST", p, free)).toMatchObject({ kind: "paid", price: 10_000n });
  });
  it("forward path is the normalized one (what was priced is what is served)", () => {
    expect(normalizeRequestPath("/free/../v1//chat/completions").forwardPath).toBe("/v1/chat/completions");
  });
  it.each(["/v1%2Fchat/completions", "/v1%5cchat", "/a\\b", "/a%00b", "/bad%zz"])("%s is rejected", (p) => {
    expect(() => normalizeRequestPath(p)).toThrow(TollPathError);
  });
});

describe("patterns and CLI rule specs", () => {
  it("normalizes patterns", () => {
    expect(normalizePathPattern("*")).toBe("/*");
    expect(normalizePathPattern("v1//chat")).toBe("/v1/chat");
    expect(() => normalizePathPattern("/a/../b")).toThrow();
    expect(() => normalizePathPattern("/a?b")).toThrow();
  });
  it("parses rule specs", () => {
    expect(parseRouteSpec("POST /v1/chat/completions=0.01")).toEqual({ method: "POST", pathPattern: "/v1/chat/completions", price: 10_000n });
    expect(parseRouteSpec("/health=0")).toEqual({ method: "ANY", pathPattern: "/health", price: 0n });
    expect(parseRouteSpec("get /files/*=free")).toEqual({ method: "GET", pathPattern: "/files/*", price: 0n });
    expect(() => parseRouteSpec("POST /x")).toThrow();
    expect(() => parseRouteSpec("POST /x=abc")).toThrow();
    expect(() => parseRouteSpec("FETCH /x=1")).toThrow();
  });
  it("splits /t/{slug}/… urls", () => {
    expect(splitTollboothUrl("/t/weather/v1/today?city=x")).toEqual({ slug: "weather", rest: "/v1/today", search: "?city=x" });
    expect(splitTollboothUrl("/t/Weather")).toEqual({ slug: "weather", rest: "/", search: "" });
    expect(splitTollboothUrl("/v1/keys")).toBeNull();
  });
  it("slugify", () => {
    expect(slugify("My Weather API!")).toBe("my-weather-api");
    expect(slugify("天气")).toBe("");
  });
});
