import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { freshDb } from "./helpers.js";
import { createMoneyKey } from "../src/keys.js";
import { parseUsdcToMicros } from "../src/money.js";
import { encodeRequestBody, resolveRequestBody } from "../src/request-body.js";
import { createApproval, decideApproval, sha256OfBody, validateApprovalForUse } from "../src/approval.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("encodeRequestBody (CONTRACT: /v1/fetch body encoding)", () => {
  it("undefined -> no body", () => {
    expect(encodeRequestBody(undefined)).toBeUndefined();
  });

  it("string -> sent verbatim (not JSON-quoted)", () => {
    expect(encodeRequestBody("plain text")).toBe("plain text");
    expect(encodeRequestBody('{"already":"json"}')).toBe('{"already":"json"}');
    expect(encodeRequestBody("")).toBe("");
  });

  it("object / array -> JSON", () => {
    expect(encodeRequestBody({ a: 1, b: [2, 3] })).toBe('{"a":1,"b":[2,3]}');
    expect(encodeRequestBody([1, "x"])).toBe('[1,"x"]');
  });

  it("other JSON values keep the previous JSON.stringify behaviour", () => {
    expect(encodeRequestBody(42)).toBe("42");
    expect(encodeRequestBody(true)).toBe("true");
    expect(encodeRequestBody(null)).toBe("null");
  });
});

describe("resolveRequestBody headers", () => {
  it("object body adds content-type application/json when the caller set none", () => {
    const r = resolveRequestBody({ a: 1 }, undefined);
    expect(r.body).toBe('{"a":1}');
    expect(r.headers).toEqual({ "content-type": "application/json" });
    const r2 = resolveRequestBody({ a: 1 }, { "x-foo": "bar" });
    expect(r2.headers).toEqual({ "x-foo": "bar", "content-type": "application/json" });
  });

  it("keeps a caller-supplied content-type, whatever its casing", () => {
    for (const name of ["content-type", "Content-Type", "CONTENT-TYPE"]) {
      const h = { [name]: "application/vnd.api+json" };
      const r = resolveRequestBody({ a: 1 }, h);
      expect(r.headers).toEqual(h);
    }
  });

  it("string body: verbatim, headers untouched (no content-type forced)", () => {
    const h = { "x-foo": "bar" };
    const r = resolveRequestBody("a=1&b=2", h);
    expect(r.body).toBe("a=1&b=2");
    expect(r.headers).toBe(h);
    expect(resolveRequestBody("a=1", undefined).headers).toBeUndefined();
  });

  it("no body -> no headers added", () => {
    const r = resolveRequestBody(undefined, undefined);
    expect(r.body).toBeUndefined();
    expect(r.headers).toBeUndefined();
  });
});

describe("approval body binding follows the wire bytes", () => {
  it("sha256OfBody == sha256 of exactly what is sent", () => {
    expect(sha256OfBody(undefined)).toBe(sha(""));
    expect(sha256OfBody("raw string")).toBe(sha("raw string"));
    expect(sha256OfBody({ a: 1 })).toBe(sha('{"a":1}'));
    // a string body is NOT double-encoded: it must not hash like JSON.stringify("raw string")
    expect(sha256OfBody("raw string")).not.toBe(sha('"raw string"'));
  });

  function setup() {
    const { db } = freshDb();
    const key = createMoneyKey(db, {
      name: "k",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("1"),
      perRequestLimit: parseUsdcToMicros("0.5"),
      allowedHosts: ["example.com:443"],
    }).row;
    return { db, key };
  }
  const base = { url: "https://example.com/x", method: "POST", payTo: "0xabc", amount: 10_000n };

  it("an approval created for a string body validates for the same string, and not for a different one", () => {
    const { db, key } = setup();
    const a = createApproval(db, {
      keyId: key.id, url: base.url, method: base.method, body: "payload=1",
      network: "eip155:10143", asset: "0xasset", payTo: base.payTo, amount: base.amount,
    });
    decideApproval(db, a.id, "approved");
    expect(() => validateApprovalForUse(db, a.id, { keyId: key.id, ...base, body: "payload=1" })).not.toThrow();
    expect(() => validateApprovalForUse(db, a.id, { keyId: key.id, ...base, body: "payload=2" })).toThrow("APPROVAL_INVALID");
  });

  it("an approval created for an object body validates for an equal object, and not for a changed one", () => {
    const { db, key } = setup();
    const a = createApproval(db, {
      keyId: key.id, url: base.url, method: base.method, body: { q: "x", n: 1 },
      network: "eip155:10143", asset: "0xasset", payTo: base.payTo, amount: base.amount,
    });
    decideApproval(db, a.id, "approved");
    expect(() => validateApprovalForUse(db, a.id, { keyId: key.id, ...base, body: { q: "x", n: 1 } })).not.toThrow();
    expect(() => validateApprovalForUse(db, a.id, { keyId: key.id, ...base, body: { q: "x", n: 2 } })).toThrow("APPROVAL_INVALID");
  });
});
