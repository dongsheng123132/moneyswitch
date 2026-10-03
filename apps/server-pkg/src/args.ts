/** Pure argv parsing for `moneyswitch-server` (unit-tested, no side effects). */

export const DEFAULT_PORT = 4020;
export const DEFAULT_HOST = "127.0.0.1";

export interface ServeArgs {
  kind: "serve";
  dataDir: string | null;
  port: number | null;
  host: string | null;
}

export type ParsedArgs = ServeArgs | { kind: "help" } | { kind: "version" } | { kind: "error"; message: string };

function parsePort(v: string | undefined): number | null {
  if (v == null || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= 65535 ? n : null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let rest = argv;
  if (rest[0] === "start" || rest[0] === "serve") rest = rest.slice(1);

  let dataDir: string | null = null;
  let port: number | null = null;
  let host: string | null = null;

  for (let i = 0; i < rest.length; i++) {
    const raw = rest[i]!;
    const eq = raw.indexOf("=");
    const flag = raw.startsWith("--") && eq > 0 ? raw.slice(0, eq) : raw;
    const inline = raw.startsWith("--") && eq > 0 ? raw.slice(eq + 1) : undefined;
    const value = (): string | undefined => (inline !== undefined ? inline : rest[++i]);
    switch (flag) {
      case "-h":
      case "--help":
        return { kind: "help" };
      case "-v":
      case "--version":
        return { kind: "version" };
      case "--port":
      case "-p": {
        const v = value();
        const p = parsePort(v);
        if (p == null) return { kind: "error", message: `--port needs a number between 1 and 65535 (got ${v ?? "nothing"})` };
        port = p;
        break;
      }
      case "--host": {
        const v = value();
        if (!v) return { kind: "error", message: "--host needs a value, e.g. 127.0.0.1 or 0.0.0.0" };
        host = v;
        break;
      }
      case "--data-dir": {
        const v = value();
        if (!v) return { kind: "error", message: "--data-dir needs a path" };
        dataDir = v;
        break;
      }
      default:
        return { kind: "error", message: `unknown argument "${raw}"` };
    }
  }

  return { kind: "serve", dataDir, port, host };
}
