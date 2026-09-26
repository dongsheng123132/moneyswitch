import { describe, it, expect } from "vitest";
import { quoteWinArg } from "../../src/lib/runner.js";

describe("quoteWinArg (cmd.exe argv for .cmd shims)", () => {
  it("leaves plain tokens alone", () => {
    expect(quoteWinArg("mcp")).toBe("mcp");
    expect(quoteWinArg("-s")).toBe("-s");
    expect(quoteWinArg("C:/1mineyswitch/apps/mcp/dist/index.js")).toBe("C:/1mineyswitch/apps/mcp/dist/index.js");
  });
  it("quotes spaces, metacharacters and empty strings", () => {
    expect(quoteWinArg("C:\\Program Files\\x.js")).toBe('"C:\\Program Files\\x.js"');
    expect(quoteWinArg("MONEY_API_BASE=http://h")).toBe('"MONEY_API_BASE=http://h"');
    expect(quoteWinArg("a&b")).toBe('"a&b"');
    expect(quoteWinArg("")).toBe('""');
  });
  it("escapes embedded quotes and doubles trailing backslashes", () => {
    expect(quoteWinArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWinArg("dir x\\")).toBe('"dir x\\\\"');
  });
});
