// toCsv: quoting, and spreadsheet formula injection. A cell that starts with = + - @ (or a tab or a carriage return) is run as a formula by
// Excel / Sheets / Calc. Some CSV values come from outside (a paid URL, a key name), so such a value is written with a single quote in front.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toCsv } from "../src/money.ts";

/** The one cell of a one-column CSV (header "h"): everything after the first line. */
const cell = (value: string | number) => toCsv(["h"], [[value]]).slice("h\n".length);

describe("toCsv: quoting", () => {
  it("plain values are written as they are, one line per row", () => {
    assert.equal(toCsv(["a", "b"], [["x", 1], ["y", 2.5]]), "a,b\nx,1\ny,2.5");
  });

  it("a comma, a quote, a line break or a carriage return inside a value wraps it in quotes (quotes doubled)", () => {
    assert.equal(cell("a,b"), '"a,b"');
    assert.equal(cell('say "hi"'), '"say ""hi"""');
    assert.equal(cell("one\ntwo"), '"one\ntwo"');
    assert.equal(cell("one\rtwo"), '"one\rtwo"', "a carriage return in the middle is quoted, and gets no apostrophe");
  });
});

describe("toCsv: formula injection", () => {
  it("a value starting with = gets a single quote in front (and is quoted as usual when it needs to be)", () => {
    assert.equal(cell('=HYPERLINK("http://evil.example/x","click")'), `"'=HYPERLINK(""http://evil.example/x"",""click"")"`);
    assert.equal(cell("=1+1"), "'=1+1");
  });

  it("+ - @ are the same", () => {
    assert.equal(cell("+1+2"), "'+1+2");
    assert.equal(cell("-1"), "'-1", "a value that only looks like a negative number is treated the same");
    assert.equal(cell("-2+3"), "'-2+3");
    assert.equal(cell("@SUM(A1:A2)"), "'@SUM(A1:A2)");
  });

  it("a leading tab or carriage return gets the quote; a carriage return also needs the value quoted", () => {
    assert.equal(cell("\t=1+1"), "'\t=1+1");
    assert.equal(cell("\r=1+1"), '"\'\r=1+1"');
    assert.equal(cell("\rplain"), '"\'\rplain"');
  });

  it("the headers go through the same rule", () => {
    assert.equal(toCsv(["=x", "ok"], []), "'=x,ok");
  });

  it("values that are not formulas are not touched: an address, a URL, a time, a number, empty, a character in the middle", () => {
    for (const same of [
      "0x000000000000000000000000000000000000dEaD",
      "https://api.example.com/paid?q=1",
      "2026-10-04T12:00:00.000Z",
      "eip155:10143",
      "a-b",
      "a=b",
      "x@y.example",
      "0.01",
      "",
    ]) {
      assert.equal(cell(same), same);
    }
    assert.equal(cell(5), "5");
  });
});
