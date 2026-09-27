/**
 * Defensive, best-effort trimming of a Nansen JSON response body so we never
 * dump a large payload into the model's context. Keeps at most `maxRows` rows
 * from whatever array we can find (top-level array, or a `.data` array), and
 * hard-caps the final JSON string at `maxChars` bytes with a truncation note.
 */
export interface TrimmedSummary {
  rows_shown: number;
  rows_total: number | null;
  sample: unknown[];
  note?: string;
}

export function trimNansenBody(body: string | null, maxRows = 5, maxChars = 3000): TrimmedSummary {
  if (!body) {
    return { rows_shown: 0, rows_total: null, sample: [], note: "empty response body" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const truncated = body.length > maxChars ? body.slice(0, maxChars) + "…(truncated)" : body;
    return { rows_shown: 0, rows_total: null, sample: [truncated], note: "response body is not JSON" };
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { data?: unknown[] })?.data)
      ? (parsed as { data: unknown[] }).data
      : null;

  if (!rows) {
    // Not a row-shaped response (e.g. a single object) — include it verbatim
    // but still size-capped.
    const asString = JSON.stringify(parsed);
    if (asString.length <= maxChars) {
      return { rows_shown: 0, rows_total: null, sample: [parsed] };
    }
    return {
      rows_shown: 0,
      rows_total: null,
      sample: [asString.slice(0, maxChars) + "…(truncated)"],
      note: "response was not a rows array; truncated raw object",
    };
  }

  const sample = rows.slice(0, maxRows);
  const result: TrimmedSummary = { rows_shown: sample.length, rows_total: rows.length, sample };

  let asString = JSON.stringify(result);
  while (asString.length > maxChars && result.sample.length > 0) {
    result.sample.pop();
    result.rows_shown = result.sample.length;
    result.note = `truncated to fit ${maxChars} chars (had ${rows.length} rows total)`;
    asString = JSON.stringify(result);
  }
  return result;
}
