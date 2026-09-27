import type OpenAI from "openai";
import { AGENT_TOOLS, runMoneyStatus, runNansenQuery } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";
import type { MoneySwitchClient } from "./moneyswitch.js";
import type { Trace } from "./trace.js";

/** Best-effort short message for the ❌ step-trace line on an upstream (non-
 * MoneySwitch) error: `t.data.sample[0]` is the trimmed response body (see
 * trim.ts), which for a JSON error envelope is usually `{ error, message,
 * or detail }`. Falls back to the MoneySwitch-level `reason` if the body
 * isn't shaped that way. Never throws on unexpected shapes. */
function trimUpstreamMessageForTrace(t: Record<string, unknown>): string | null {
  const data = t.data as { sample?: unknown[] } | undefined;
  const first = data?.sample?.[0];
  if (first && typeof first === "object") {
    const obj = first as Record<string, unknown>;
    const candidate = obj.error ?? obj.message ?? obj.detail;
    if (typeof candidate === "string") return candidate;
  } else if (typeof first === "string") {
    return first;
  }
  return typeof t.reason === "string" ? t.reason : null;
}

export interface RunAgentOptions {
  openai: OpenAI;
  model: string;
  moneySwitch: MoneySwitchClient;
  question: string;
  trace: Trace;
  maxSteps: number;
}

export interface RunAgentResult {
  finalAnswer: string | null;
  hitStepLimit: boolean;
}

/**
 * Chat-completions tool-calling loop (OpenAI-compatible; works against
 * DashScope's compatible-mode endpoint for Qwen). Bounded by `maxSteps`
 * model turns; each turn may include zero or more tool calls, which are
 * executed against the real MoneySwitch client passed in (tests pass a
 * client pointed at a fake local server).
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const { openai, model, moneySwitch, question, trace, maxSteps } = opts;

  // Using `any` for the message array: the openai SDK's ChatCompletionMessageParam
  // union is intentionally permissive here, and we round-trip assistant tool_calls
  // verbatim, which is easiest to express untyped.
  const messages: any[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: question },
  ];

  let hitStepLimit = false;

  for (let step = 1; step <= maxSteps; step++) {
    const completion = await openai.chat.completions.create({
      model,
      messages,
      tools: AGENT_TOOLS,
    });

    const message = completion.choices[0]?.message;
    if (!message) {
      trace.emit("error", "model returned no message");
      return { finalAnswer: null, hitStepLimit: false };
    }

    const toolCalls = message.tool_calls ?? [];

    if (message.content && message.content.trim().length > 0) {
      if (toolCalls.length > 0) {
        trace.emit("plan", message.content.trim());
      } else {
        // No tool calls left: this is the final answer.
        trace.emit("final", message.content.trim());
        messages.push(message);
        return { finalAnswer: message.content.trim(), hitStepLimit: false };
      }
    }

    if (toolCalls.length === 0) {
      // Model produced neither content nor tool calls; nothing more to do.
      return { finalAnswer: message.content ?? null, hitStepLimit: false };
    }

    messages.push(message);

    for (const rawCall of toolCalls) {
      // The SDK's tool_calls type is a union of function-tool and custom-tool
      // shapes; we only ever request function tools (AGENT_TOOLS), so this is
      // always the function-call shape at runtime.
      const call = rawCall as { id: string; function: { name: string; arguments: string } };
      const name = call.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        trace.emit("error", `could not parse arguments for tool call ${name}`, { raw: call.function.arguments });
      }

      trace.emit("tool_call", `${name}(${JSON.stringify(args)})`, { name, args });

      let outcome;
      if (name === "money_status") {
        outcome = await runMoneyStatus(moneySwitch);
      } else if (name === "nansen_query") {
        outcome = await runNansenQuery(moneySwitch, args as { endpoint?: unknown; params?: unknown });
      } else {
        outcome = {
          content: JSON.stringify({ error: `unknown tool ${name}` }),
          trace: { tool: name, error: "unknown tool" },
        };
      }

      if (name === "nansen_query") {
        const t = outcome.trace as Record<string, unknown>;
        if (t.paid) {
          const paid = t.paid as { amount: string; tx_hash: string | null; explorer_url: string | null };
          trace.emit(
            "payment",
            `paid ${paid.amount} USDC${paid.tx_hash ? ` — tx ${paid.tx_hash}` : ""}`,
            { endpoint: t.endpoint, ...paid }
          );
        }
        const httpStatus = t.http_status as number | null | undefined;
        const isUpstreamError = t.status === "ok" && httpStatus != null && httpStatus >= 400;
        if (t.status === "ok" && t.data && !isUpstreamError) {
          const data = t.data as { rows_shown: number; rows_total: number | null };
          trace.emit("data", `${data.rows_shown}/${data.rows_total ?? "?"} rows from ${t.endpoint}`, {
            endpoint: t.endpoint,
            data: t.data,
          });
        } else if (isUpstreamError) {
          const upstream = trimUpstreamMessageForTrace(t);
          trace.emit("error", `${t.endpoint}: upstream HTTP ${httpStatus}${upstream ? ` — ${upstream}` : ""}`, t);
        } else if (t.status && t.status !== "ok") {
          trace.emit("error", `${t.endpoint}: ${t.status}${t.code ? ` (${t.code})` : ""}${t.reason ? ` — ${t.reason}` : ""}`, t);
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: outcome.content,
      });
    }
  }

  hitStepLimit = true;
  trace.emit("error", `AGENT_MAX_STEPS (${maxSteps}) reached without a final answer`);
  return { finalAnswer: null, hitStepLimit };
}
