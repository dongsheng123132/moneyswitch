export type Command = "connect" | "status" | "remove";

export interface ParsedArgs {
  command: Command;
  server?: string;
  key?: string;
  apply: boolean;
  json: boolean;
  help: boolean;
}

export interface ArgsError {
  error: string;
}

/**
 * SPEC-v0.3-employee.md §B.1/§B.2: CLI arg parsing, zero dependencies.
 * Exit code 2 (argument error) is signalled by returning an ArgsError.
 */
export function parseArgs(argv: string[]): ParsedArgs | ArgsError {
  let command: Command = "connect";
  const rest = [...argv];
  if (rest[0] === "status" || rest[0] === "remove") {
    command = rest.shift() as Command;
  }

  let server: string | undefined;
  let key: string | undefined;
  let apply = false;
  let json = false;
  let help = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--server") {
      server = rest[++i];
      if (server === undefined) return { error: "--server requires a value" };
    } else if (arg === "--key") {
      key = rest[++i];
      if (key === undefined) return { error: "--key requires a value" };
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }

  if (!help && (command === "connect" || command === "status")) {
    if (!server) return { error: "--server is required" };
    if (!key) return { error: "--key is required" };
  }

  return { command, server, key, apply, json, help };
}
