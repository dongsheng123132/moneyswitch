// #3: the Windows ACL check compares SIDs read back from the system, not the aliases SDDL happens to print. SDDL writes the
// well-known accounts as two-letter aliases (SY, LS, NS, LA, BA, ...); a check that only knew "SY" reported a false
// "not protected" warning for a server running as LocalService, NetworkService or the built-in Administrator account.
// These tests are platform independent: they feed the evaluator what PowerShell prints.
import { describe, it, expect } from "vitest";
import { evaluateAcl, parseAclOutput } from "../src/protect.js";

const SYSTEM = "S-1-5-18";
const FULL = 2032127; // FileSystemRights.FullControl

/** What the PowerShell script prints for one target: the protection flag, then one line per access rule (SIDs, never names). */
function output(me: string, targets: Array<{ protected: boolean; entries: Array<{ sid: string; type?: string; inherited?: boolean }> }>): string {
  const lines = [`ME|${me}`];
  targets.forEach((t, i) => {
    lines.push(`PROT|${i}|${t.protected ? "True" : "False"}`);
    for (const e of t.entries) lines.push(`ACE|${i}|${e.type ?? "Allow"}|${e.sid}|${FULL}|${e.inherited ? "True" : "False"}`);
  });
  return lines.join("\r\n") + "\r\n";
}
const verdict = (text: string, index = 0) => {
  const parsed = parseAclOutput(text);
  return evaluateAcl(parsed.readbacks.get(index), [parsed.me!, SYSTEM]);
};

describe("#3: the owner and SYSTEM are recognised by SID, whatever alias SDDL would print for them", () => {
  it.each([
    ["an ordinary local user", "S-1-5-21-1111111111-2222222222-3333333333-1001"],
    ["the built-in Administrator account (SDDL: LA)", "S-1-5-21-1111111111-2222222222-3333333333-500"],
    ["NT AUTHORITY\\LocalService (SDDL: LS)", "S-1-5-19"],
    ["NT AUTHORITY\\NetworkService (SDDL: NS)", "S-1-5-20"],
    ["a domain account", "S-1-5-21-4444444444-5555555555-6666666666-2207"],
    ["SYSTEM itself (the server runs as SYSTEM: one trustee, not two)", SYSTEM],
  ])("%s: protected, only the owner and SYSTEM -> protected", (_label, me) => {
    const entries = me === SYSTEM ? [{ sid: SYSTEM }] : [{ sid: me }, { sid: SYSTEM }];
    expect(verdict(output(me, [{ protected: true, entries }]))).toEqual({ ok: true });
  });

  it("the order of the entries does not matter, and the data folder and the secret are judged separately", () => {
    const me = "S-1-5-19";
    const text = output(me, [
      { protected: true, entries: [{ sid: SYSTEM }, { sid: me }] },
      { protected: true, entries: [{ sid: me }, { sid: SYSTEM }] },
    ]);
    expect(verdict(text, 0).ok).toBe(true);
    expect(verdict(text, 1).ok).toBe(true);
  });

  it.each([
    ["BUILTIN\\Users (S-1-5-32-545)", "S-1-5-32-545"],
    ["BUILTIN\\Administrators (S-1-5-32-544)", "S-1-5-32-544"],
    ["Authenticated Users (S-1-5-11)", "S-1-5-11"],
    ["Everyone (S-1-1-0)", "S-1-1-0"],
    ["another local account", "S-1-5-21-1111111111-2222222222-3333333333-1002"],
  ])("an extra %s still has access -> NOT protected, and the finding names the SID", (_label, extra) => {
    const me = "S-1-5-21-1111111111-2222222222-3333333333-1001";
    const v = verdict(output(me, [{ protected: true, entries: [{ sid: me }, { sid: SYSTEM }, { sid: extra }] }]));
    expect(v.ok).toBe(false);
    expect(v.why).toContain(extra);
  });

  it("inheritance not blocked -> NOT protected", () => {
    const me = "S-1-5-19";
    expect(verdict(output(me, [{ protected: false, entries: [{ sid: me }, { sid: SYSTEM }] }]))).toEqual({ ok: false, why: "inheritance is not blocked" });
  });

  it("an inherited entry, a Deny entry or an empty ACL -> NOT protected", () => {
    const me = "S-1-5-19";
    expect(verdict(output(me, [{ protected: true, entries: [{ sid: me }, { sid: SYSTEM, inherited: true }] }])).ok).toBe(false);
    expect(verdict(output(me, [{ protected: true, entries: [{ sid: me }, { sid: SYSTEM }, { sid: "S-1-5-32-545", type: "Deny" }] }])).ok).toBe(false);
    expect(verdict(output(me, [{ protected: true, entries: [] }])).ok).toBe(false);
  });

  it("the owner or SYSTEM missing -> NOT protected (access was lost)", () => {
    const me = "S-1-5-20";
    const noMe = verdict(output(me, [{ protected: true, entries: [{ sid: SYSTEM }] }]));
    expect(noMe.ok).toBe(false);
    expect(noMe.why).toContain(me);
    const noSystem = verdict(output(me, [{ protected: true, entries: [{ sid: me }] }]));
    expect(noSystem.ok).toBe(false);
    expect(noSystem.why).toContain(SYSTEM);
  });

  it("garbage in, no verdict out: a missing target or a missing ME line is reported, never assumed fine", () => {
    expect(parseAclOutput("").me).toBeNull();
    expect(parseAclOutput("hello\nworld").readbacks.size).toBe(0);
    expect(evaluateAcl(undefined, [SYSTEM]).ok).toBe(false);
    // lines of another target never leak into this one
    const text = output("S-1-5-19", [{ protected: true, entries: [{ sid: "S-1-5-19" }, { sid: SYSTEM }] }]);
    expect(parseAclOutput(text).readbacks.get(1)).toBeUndefined();
  });

  it("the parser reads exactly what the script prints (CRLF or LF, entries in any order)", () => {
    const parsed = parseAclOutput("ME|S-1-5-19\nPROT|0|True\nACE|0|Allow|S-1-5-18|2032127|False\nACE|0|Allow|S-1-5-19|2032127|False\n");
    expect(parsed.me).toBe("S-1-5-19");
    expect(parsed.readbacks.get(0)).toEqual({
      protected: true,
      entries: [
        { type: "Allow", sid: "S-1-5-18", rights: 2032127, inherited: false },
        { type: "Allow", sid: "S-1-5-19", rights: 2032127, inherited: false },
      ],
    });
  });
});
