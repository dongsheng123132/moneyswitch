import { describe, it, expect } from "vitest";
import { COOKIE_NAME, guardRequest, readCookie, SessionManager } from "../../src/desktop/session.js";

const PORT = 4318;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;

function req(method: string, url: string, headers: Record<string, string> = {}) {
  return { method, url, headers: { host: HOST, ...headers } };
}

describe("local UI session (one-time token -> httpOnly cookie)", () => {
  it("exchanges the one-time token exactly once", () => {
    const sm = new SessionManager(PORT, "tok_abc");
    expect(sm.exchange("wrong")).toBeNull();
    const sid = sm.exchange("tok_abc");
    expect(sid).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(sm.isValid(sid)).toBe(true);
    expect(sm.exchange("tok_abc")).toBeNull(); // burned
    expect(sm.pendingToken).toBeNull();
  });

  it("issues an HttpOnly, SameSite=Strict cookie", () => {
    const sm = new SessionManager(PORT, "t");
    const sid = sm.exchange("t")!;
    const c = sm.cookieHeader(sid);
    expect(c).toContain(`${COOKIE_NAME}=${sid}`);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(readCookie(`a=1; ${COOKIE_NAME}=${sid}; b=2`, COOKIE_NAME)).toBe(sid);
  });

  it("rejects /api/* without a session", () => {
    const sm = new SessionManager(PORT, "t");
    expect(guardRequest(sm, req("GET", "/api/state"))).toMatchObject({ status: 401, code: "NO_SESSION" });
    expect(guardRequest(sm, req("GET", "/api/state", { cookie: `${COOKIE_NAME}=forged` }))).toMatchObject({ status: 401 });
  });

  it("allows static assets and a valid session", () => {
    const sm = new SessionManager(PORT, "t");
    const sid = sm.exchange("t")!;
    expect(guardRequest(sm, req("GET", "/"))).toBeNull();
    expect(guardRequest(sm, req("GET", "/app.js"))).toBeNull();
    expect(guardRequest(sm, req("GET", "/api/state", { cookie: `${COOKIE_NAME}=${sid}` }))).toBeNull();
  });

  it("requires same Origin + JSON for every state-changing call, even with a valid cookie (CSRF)", () => {
    const sm = new SessionManager(PORT, "t");
    const sid = sm.exchange("t")!;
    const cookie = `${COOKIE_NAME}=${sid}`;
    const json = { "content-type": "application/json" };
    expect(guardRequest(sm, req("POST", "/api/agents/claude/apply", { cookie, ...json }))).toMatchObject({ status: 403, code: "BAD_ORIGIN" });
    expect(guardRequest(sm, req("POST", "/api/agents/claude/apply", { cookie, ...json, origin: "http://evil.example" }))).toMatchObject({ status: 403 });
    expect(guardRequest(sm, req("POST", "/api/agents/claude/apply", { cookie, ...json, origin: "http://127.0.0.1:9999" }))).toMatchObject({ status: 403 });
    expect(guardRequest(sm, req("POST", "/api/agents/claude/apply", { cookie, ...json, origin: "null" }))).toMatchObject({ status: 403 });
    // text/plain is what a cross-site <form> or no-preflight fetch can send
    expect(guardRequest(sm, req("POST", "/api/agents/claude/apply", { cookie, origin: ORIGIN, "content-type": "text/plain" }))).toMatchObject({ status: 415 });
    expect(guardRequest(sm, req("PUT", "/api/account", { cookie, ...json, origin: ORIGIN }))).toBeNull();
    expect(guardRequest(sm, req("DELETE", "/api/agents/codex/wallet", { cookie, ...json, origin: `http://localhost:${PORT}`, host: `localhost:${PORT}` }))).toBeNull();
  });

  it("POST /api/session itself also needs the right Origin", () => {
    const sm = new SessionManager(PORT, "t");
    expect(guardRequest(sm, req("POST", "/api/session", { "content-type": "application/json" }))).toMatchObject({ status: 403 });
    expect(guardRequest(sm, req("POST", "/api/session", { "content-type": "application/json", origin: ORIGIN }))).toBeNull();
  });

  it("rejects unexpected Host headers (DNS rebinding)", () => {
    const sm = new SessionManager(PORT, "t");
    expect(guardRequest(sm, { method: "GET", url: "/", headers: { host: "attacker.example:4318" } })).toMatchObject({ status: 421 });
    expect(guardRequest(sm, { method: "GET", url: "/api/state", headers: {} })).toMatchObject({ status: 421 });
  });
});

import { parseUiArgs } from "../../src/desktop/ui.js";

describe("moneyswitch ui args", () => {
  it("defaults to 127.0.0.1:4318 and opening the browser", () => {
    expect(parseUiArgs([], {})).toEqual({ port: 4318, open: true, help: false });
  });
  it("accepts --port / --no-open / env overrides and rejects junk", () => {
    expect(parseUiArgs(["--port", "5000", "--no-open"], {})).toEqual({ port: 5000, open: false, help: false });
    expect(parseUiArgs(["--port=5001"], { MONEYSWITCH_UI_NO_OPEN: "1" })).toEqual({ port: 5001, open: false, help: false });
    expect(parseUiArgs(["--port", "99999"], {})).toHaveProperty("error");
    expect(parseUiArgs(["--host", "0.0.0.0"], {})).toHaveProperty("error");
  });
});
