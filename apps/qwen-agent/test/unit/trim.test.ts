import { describe, it, expect } from "vitest";
import { trimNansenBody } from "../../src/trim.js";

describe("trimNansenBody", () => {
  it("trims a `data` array to maxRows and reports totals", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ token_symbol: `TOK${i}`, price_usd: i }));
    const body = JSON.stringify({ data: rows });

    const summary = trimNansenBody(body, 5, 100_000);

    expect(summary.rows_shown).toBe(5);
    expect(summary.rows_total).toBe(50);
    expect(summary.sample).toHaveLength(5);
    expect(summary.sample[0]).toEqual({ token_symbol: "TOK0", price_usd: 0 });
  });

  it("trims a top-level array response", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ x: i }));
    const summary = trimNansenBody(JSON.stringify(rows), 3, 100_000);
    expect(summary.rows_shown).toBe(3);
    expect(summary.rows_total).toBe(10);
  });

  it("never exceeds maxChars even for large rows", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ blob: "x".repeat(500), i }));
    const body = JSON.stringify({ data: rows });

    const summary = trimNansenBody(body, 20, 3000);

    expect(JSON.stringify(summary).length).toBeLessThanOrEqual(3000);
    expect(summary.rows_shown).toBeLessThan(20);
    expect(summary.note).toMatch(/truncated/);
  });

  it("handles empty body", () => {
    const summary = trimNansenBody(null);
    expect(summary.rows_shown).toBe(0);
    expect(summary.note).toMatch(/empty/);
  });

  it("handles non-JSON body without throwing", () => {
    const summary = trimNansenBody("not json at all");
    expect(summary.note).toMatch(/not JSON/);
  });
});
