/**
 * Minimal, comment-preserving TOML *text* edits for ~/.codex/config.toml.
 *
 * We never re-serialise the user's file: we only (a) set/remove single-line
 * root keys and (b) cut/append whole tables we own. Callers MUST re-parse the
 * result with a real TOML parser and compare everything they don't own
 * (see codex.ts `assertOnlyManagedChanged`) — that check is what makes these
 * line-based edits safe on files with exotic layouts.
 */

const HEADER_RE = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(#.*)?$/;

export function tomlString(v: string): string {
  // A JSON string literal is a valid TOML basic string for everything we write.
  return JSON.stringify(v);
}

/** Normalised dotted table name (`a . "b"` -> `a.b`) for comparison. */
function normName(raw: string): string {
  return raw
    .split(".")
    .map((p) => p.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"))
    .join(".");
}

interface Line {
  text: string;
  /** Table this line belongs to ("" = root), or null if the line is inside a multi-line string. */
  header: string | null;
  isHeader: boolean;
  inString: boolean;
}

function scan(text: string): Line[] {
  const out: Line[] = [];
  let table = "";
  let inMulti: '"""' | "'''" | null = null;
  for (const text_ of text.split(/\r?\n/)) {
    const startsInString = inMulti !== null;
    let isHeader = false;
    if (!startsInString) {
      const m = HEADER_RE.exec(text_);
      if (m) {
        table = normName(m[1]);
        isHeader = true;
      }
    }
    // Track multi-line strings so a "[x]" inside one is never taken for a header.
    let i = 0;
    while (i < text_.length) {
      if (inMulti) {
        const end = text_.indexOf(inMulti, i);
        if (end === -1) break;
        inMulti = null;
        i = end + 3;
      } else {
        const a = text_.indexOf('"""', i);
        const b = text_.indexOf("'''", i);
        const hash = text_.indexOf("#", i);
        const cands = [a, b].filter((x) => x !== -1);
        if (!cands.length) break;
        const first = Math.min(...cands);
        if (hash !== -1 && hash < first) break;
        inMulti = first === a ? '"""' : "'''";
        i = first + 3;
      }
    }
    out.push({ text: text_, header: table, isHeader, inString: startsInString });
  }
  return out;
}

function belongsTo(table: string, name: string): boolean {
  return table === name || table.startsWith(`${name}.`);
}

/** Raw text of `[name]` and all its sub-tables, or null if absent. */
export function getTable(text: string, name: string): string | null {
  const lines = scan(text).filter((l) => belongsTo(l.header ?? "", name));
  if (!lines.length) return null;
  return lines
    .map((l) => l.text)
    .join("\n")
    .replace(/\s+$/, "");
}

/** Remove `[name]` and all its sub-tables. */
export function removeTable(text: string, name: string): string {
  const kept = scan(text)
    .filter((l) => !belongsTo(l.header ?? "", name))
    .map((l) => l.text);
  return tidy(kept.join(eol(text)), eol(text));
}

/** Append a table block at the end of the document. */
export function appendTable(text: string, block: string): string {
  const nl = eol(text);
  const base = text.replace(/\s+$/, "");
  const b = block.replace(/\s+$/, "").replace(/\r?\n/g, nl);
  return base.length ? `${base}${nl}${nl}${b}${nl}` : `${b}${nl}`;
}

/** Only normalises the end of the file; the user's own blank lines are left alone. */
function tidy(s: string, nl: string): string {
  const t = s.replace(/\s+$/, "");
  return t.length ? `${t}${nl}` : "";
}

/** Keep the file's own line endings (Windows users often have CRLF). */
function eol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

const keyRe = (key: string) => new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);

/** The raw root-level line assigning `key`, or null. */
export function getRootLine(text: string, key: string): string | null {
  const re = keyRe(key);
  for (const l of scan(text)) {
    if (l.isHeader) return null;
    if (!l.inString && re.test(l.text)) return l.text;
  }
  return null;
}

/**
 * Set (or with `line === null` remove) the root-level assignment of `key`.
 * `line` is the complete line, e.g. `model = "gpt-6-sol"`. New keys go at the
 * end of the root section, before the first table header.
 */
export function setRootLine(text: string, key: string, line: string | null): string {
  const re = keyRe(key);
  const lines = scan(text);
  const firstHeader = lines.findIndex((l) => l.isHeader);
  const rootEnd = firstHeader === -1 ? lines.length : firstHeader;
  const idx = lines.slice(0, rootEnd).findIndex((l) => !l.inString && re.test(l.text));
  const texts = lines.map((l) => l.text);
  if (idx !== -1) {
    if (line === null) texts.splice(idx, 1);
    else texts[idx] = line;
  } else if (line !== null) {
    let at = rootEnd;
    while (at > 0 && texts[at - 1].trim() === "") at--;
    // No extra blank line is added, so removing the key later restores the file byte for byte.
    texts.splice(at, 0, line);
  }
  return tidy(texts.join(eol(text)), eol(text));
}
