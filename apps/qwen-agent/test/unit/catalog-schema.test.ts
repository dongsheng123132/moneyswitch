import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { NANSEN_CATALOG, type NansenCatalogEntry } from "../../src/catalog.js";

/**
 * Guards against a repeat of the 2026-09-27 mainnet incident where
 * catalog.ts's params_schema for 2 of the 5 endpoints didn't match Nansen's
 * real request body shape (smart-money/netflow doesn't take `timeframe`;
 * tgm/flow-intelligence takes a single `chain`, not `chains`), which only
 * surfaced as live 422s. Checks every catalog entry's params_schema against
 * a vendored, trimmed, $ref-resolved subset of the real OpenAPI spec
 * (regenerate via scripts/vendor-nansen-spec.mjs).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "..", "fixtures", "nansen-openapi.subset.json");

interface SpecSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

interface SpecFixture {
  paths: Record<string, { post: { requestBody: { content: { "application/json": { schema: SpecSchema } } } } }>;
}

const fixture: SpecFixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));

/** Endpoint `path` in catalog.ts is a full URL; the spec keys paths as
 * `/api/v1/...`. Strip the scheme+host to map one to the other. */
function specPathFor(entry: NansenCatalogEntry): string {
  const url = new URL(entry.path);
  return url.pathname;
}

function specSchemaFor(entry: NansenCatalogEntry): SpecSchema {
  const specPath = specPathFor(entry);
  const item = fixture.paths[specPath];
  if (!item) {
    throw new Error(`Fixture has no entry for ${specPath} (catalog entry "${entry.name}")`);
  }
  return item.post.requestBody.content["application/json"].schema;
}

/** Best-effort search for the first `enum` reachable from a spec property
 * schema, unwrapping the `anyOf`/`items` wrappers the real spec uses (e.g.
 * `{ anyOf: [{ type: "string", enum: [...] }] }` for `timeframe`, or
 * `{ type: "array", items: { enum: [...] } }` for `chains`). Returns null if
 * no enum is found anywhere in the subtree (searched breadth-first, capped,
 * so it terminates even on the large numeric-range-filter subtrees). */
function findEnum(schema: unknown, depth = 0): string[] | null {
  if (schema === null || typeof schema !== "object" || depth > 6) return null;
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.enum)) return s.enum as string[];
  const candidates = [s.items, ...(Array.isArray(s.anyOf) ? s.anyOf : []), ...(Array.isArray(s.oneOf) ? s.oneOf : [])];
  for (const c of candidates) {
    const found = findEnum(c, depth + 1);
    if (found) return found;
  }
  return null;
}

describe("NANSEN_CATALOG matches the real Nansen OpenAPI spec", () => {
  for (const entry of NANSEN_CATALOG) {
    describe(entry.name, () => {
      it("has a corresponding path in the spec", () => {
        expect(() => specSchemaFor(entry)).not.toThrow();
      });

      it("declares (and marks required) every field the spec requires", () => {
        const spec = specSchemaFor(entry);
        const specRequired = spec.required ?? [];
        for (const field of specRequired) {
          expect(entry.params_schema.properties).toHaveProperty(field);
          expect(entry.params_schema.required).toContain(field);
        }
      });

      it("only declares properties that exist at the top level of the spec's schema", () => {
        const spec = specSchemaFor(entry);
        const specProps = Object.keys(spec.properties ?? {});
        for (const declared of Object.keys(entry.params_schema.properties)) {
          expect(specProps).toContain(declared);
        }
      });

      it("declares chain/timeframe enums that are subsets of the spec's enums, and allows monad", () => {
        const spec = specSchemaFor(entry);
        for (const field of ["chain", "chains", "timeframe"]) {
          const declaredProp = (entry.params_schema.properties as Record<string, unknown>)[field];
          if (!declaredProp) continue;
          const specProp = (spec.properties ?? {})[field];
          expect(specProp, `spec has no property "${field}" for ${entry.name}`).toBeDefined();

          const declaredEnum =
            field === "chains"
              ? findEnum((declaredProp as { items?: unknown }).items)
              : findEnum(declaredProp);
          const specEnum = field === "chains" ? findEnum((specProp as { items?: unknown }).items) : findEnum(specProp);

          expect(specEnum, `spec property "${field}" for ${entry.name} has no enum`).not.toBeNull();
          if (declaredEnum) {
            for (const value of declaredEnum) {
              expect(specEnum).toContain(value);
            }
          }

          if (field === "chain" || field === "chains") {
            expect(specEnum).toContain("monad");
          }
        }
      });
    });
  }
});
