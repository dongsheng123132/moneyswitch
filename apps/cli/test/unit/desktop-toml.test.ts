import { describe, it, expect } from "vitest";
import { parse } from "smol-toml";
import { appendTable, getRootLine, getTable, removeTable, setRootLine } from "../../src/desktop/toml-edit.js";

const SAMPLE = `# my codex config
model = "gpt-6-sol"
model_reasoning_effort = "xhigh"

[projects.'C:\\Users\\me']
trust_level = "trusted"

[mcp_servers.other]
command = "node"
args = ["x.js"]

[mcp_servers.moneyswitch]
command = "node"
args = ["old.js"]

[mcp_servers.moneyswitch.env]
MONEY_API_KEY = "mk_live_old"

[notice]
hide = true
`;

describe("toml-edit (comment-preserving line edits)", () => {
  it("getRootLine finds root keys only, not keys inside tables", () => {
    expect(getRootLine(SAMPLE, "model")).toBe('model = "gpt-6-sol"');
    expect(getRootLine(SAMPLE, "command")).toBeNull();
    expect(getRootLine(SAMPLE, "model_provider")).toBeNull();
  });

  it("setRootLine replaces in place and inserts new keys before the first table", () => {
    let t = setRootLine(SAMPLE, "model", 'model = "m2"');
    t = setRootLine(t, "model_provider", 'model_provider = "moneyswitch_brain"');
    const doc = parse(t) as Record<string, unknown>;
    expect(doc.model).toBe("m2");
    expect(doc.model_provider).toBe("moneyswitch_brain");
    expect(t.startsWith("# my codex config\n")).toBe(true);
    expect(t.indexOf("model_provider")).toBeLessThan(t.indexOf("[projects"));
  });

  it("insert then remove of a new root key is byte-for-byte reversible", () => {
    const added = setRootLine(SAMPLE, "model_provider", 'model_provider = "x"');
    expect(setRootLine(added, "model_provider", null)).toBe(SAMPLE);
  });

  it("removeTable drops the table and its sub-tables, nothing else", () => {
    const t = removeTable(SAMPLE, "mcp_servers.moneyswitch");
    const doc = parse(t) as { mcp_servers: Record<string, unknown>; notice: unknown; projects: unknown };
    expect(Object.keys(doc.mcp_servers)).toEqual(["other"]);
    expect(doc.notice).toEqual({ hide: true });
    expect(t).toContain("# my codex config");
    expect(getTable(SAMPLE, "mcp_servers.moneyswitch")).toContain('MONEY_API_KEY = "mk_live_old"');
  });

  it("does not treat [brackets] inside a multi-line string as a table header", () => {
    const text = `note = """\n[mcp_servers.moneyswitch]\nnot a table\n"""\n\n[a]\nb = 1\n`;
    expect(removeTable(text, "mcp_servers.moneyswitch")).toBe(text);
  });

  it("keeps CRLF line endings", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n");
    const t = appendTable(setRootLine(crlf, "model_provider", 'model_provider = "x"'), "[x]\na = 1");
    expect(t.includes("\r\n")).toBe(true);
    expect(/[^\r]\n/.test(t)).toBe(false);
  });
});
