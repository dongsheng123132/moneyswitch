// Where the login sends the administrator afterwards (SPEC.md §3: the approval link carries no token, so a visit without a session goes
// login -> back to the approval) and how the first-start setup link is recognised.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LANDING_PATH, loginUrlFor, safeNextPath, setupTokenFromHash } from "../src/authRedirect.ts";

describe("loginUrlFor", () => {
  it("an approval link without a session goes to the login and comes back to that very approval", () => {
    const url = loginUrlFor("/approvals", "?id=7f3a2b1c-0d4e-4a55-9a1b-2c3d4e5f6a7b");
    assert.equal(url, "/login?next=" + encodeURIComponent("/approvals?id=7f3a2b1c-0d4e-4a55-9a1b-2c3d4e5f6a7b"));
    const next = new URL(url, "https://pay.example.com").searchParams.get("next");
    assert.equal(safeNextPath(next), "/approvals?id=7f3a2b1c-0d4e-4a55-9a1b-2c3d4e5f6a7b");
  });

  it("the other pages come back to themselves; the root and the login itself just go to the login", () => {
    assert.equal(loginUrlFor("/keys"), "/login?next=%2Fkeys");
    assert.equal(loginUrlFor("/wallet", ""), "/login?next=%2Fwallet");
    assert.equal(loginUrlFor("/", ""), "/login");
    assert.equal(loginUrlFor("/login", "?next=%2Fkeys"), "/login");
  });
});

describe("safeNextPath: only a path inside this app", () => {
  it("accepts the dashboard's own paths, with their query", () => {
    for (const ok of ["/wallet", "/keys", "/approvals?id=abc", "/bills?range=today&charged=maybe"]) assert.equal(safeNextPath(ok), ok);
  });

  it("refuses anything that could leave the app or loop: another host, a scheme, a backslash, a control character, the login itself, nothing, too long", () => {
    for (const bad of [
      "https://evil.example/approvals",
      "//evil.example/approvals",
      "/\\evil.example",
      "javascript:alert(1)",
      "approvals",
      "/ok\n/evil",
      "/login",
      "/login?next=/keys",
      "",
      "   ",
      null,
      undefined,
      "/" + "a".repeat(600),
    ]) {
      assert.equal(safeNextPath(bad as string | null | undefined), null, JSON.stringify(bad));
    }
  });

  it("falls back to the Wallet page when there is nothing to come back to", () => {
    assert.equal(safeNextPath(null) ?? LANDING_PATH, "/wallet");
  });
});

describe("setupTokenFromHash: the one-time link printed on the first start", () => {
  const TOKEN = "ms_setup_" + "aB3dE6hI9lMn2pQr5tUv8xYz1B4cDe7f";

  it("reads the token from the fragment (it never reaches the server's logs)", () => {
    assert.equal(setupTokenFromHash("#" + TOKEN), TOKEN);
    assert.equal(setupTokenFromHash("#" + TOKEN + "&x=1"), TOKEN);
  });

  it("ignores anything that is not a setup token", () => {
    for (const hash of ["", "#", "#ms_admin_aB3dE6hI9lMn2pQr5tUv8xYz1B4cDe7f", "#mk_live_aB3dE6hI9lMn2pQr5tUv8xYz1B4cDe7f", "#ms_setup_", "#ms_setup_short", "#x" + TOKEN, TOKEN]) {
      assert.equal(setupTokenFromHash(hash), null, hash);
    }
    assert.equal(setupTokenFromHash(null), null);
    assert.equal(setupTokenFromHash(undefined), null);
  });
});
