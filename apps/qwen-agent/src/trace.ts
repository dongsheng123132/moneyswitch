import fs from "node:fs";
import path from "node:path";

export type TraceEventKind = "plan" | "tool_call" | "payment" | "data" | "error" | "final";

export interface TraceEvent {
  kind: TraceEventKind;
  at: string;
  [key: string]: unknown;
}

const ICONS: Record<TraceEventKind, string> = {
  plan: "\u{1F9E0}", // brain
  tool_call: "\u{1F527}", // wrench
  payment: "\u{1F4B8}", // money with wings
  data: "\u{1F4CA}", // bar chart
  error: "❌", // cross mark
  final: "✅", // check mark
};

const COLORS: Record<TraceEventKind, string> = {
  plan: "\x1b[36m", // cyan
  tool_call: "\x1b[33m", // yellow
  payment: "\x1b[32m", // green
  data: "\x1b[34m", // blue
  error: "\x1b[31m", // red
  final: "\x1b[32m", // green
};
const RESET = "\x1b[0m";

export class Trace {
  private readonly events: TraceEvent[] = [];
  private readonly useColor: boolean;

  constructor(
    private readonly out: (line: string) => void = (l) => console.log(l),
    isTty = process.stdout.isTTY ?? false,
    private readonly redact: (s: string) => string = (s) => s
  ) {
    this.useColor = isTty;
  }

  emit(kind: TraceEventKind, message: string, extra: Record<string, unknown> = {}) {
    // Redact before storing, not just before printing: the JSON transcript
    // (written from `events`) must never contain secrets either.
    const safeMessage = this.redact(message);
    const event: TraceEvent = { kind, at: new Date().toISOString(), message: safeMessage, ...extra };
    this.events.push(event);
    const icon = ICONS[kind];
    const line = `${icon} ${safeMessage}`;
    this.out(this.useColor ? `${COLORS[kind]}${line}${RESET}` : line);
  }

  toJSON(): TraceEvent[] {
    return this.events;
  }
}

/** Write a JSON transcript to .data/agent-runs/<timestamp>.json (gitignored). */
export function writeTranscript(
  repoDataDir: string,
  question: string,
  trace: Trace,
  finalAnswer: string | null,
  redact: (s: string) => string = (s) => s
) {
  const dir = path.join(repoDataDir, "agent-runs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        question: redact(question),
        events: trace.toJSON(),
        final_answer: finalAnswer !== null ? redact(finalAnswer) : null,
      },
      null,
      2
    ),
    "utf-8"
  );
  return file;
}
