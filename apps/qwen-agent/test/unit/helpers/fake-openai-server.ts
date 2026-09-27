import http from "node:http";
import type { AddressInfo } from "node:net";

export interface ScriptedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ScriptedTurn {
  content?: string;
  toolCalls?: ScriptedToolCall[];
}

/**
 * Minimal OpenAI-compatible chat-completions server. Returns one scripted
 * turn per POST /chat/completions call, in order. Records every request body
 * it receives (for asserting the tool-result loop shape in tests).
 */
export function startFakeOpenAiServer(turns: ScriptedTurn[]) {
  const requests: unknown[] = [];
  let callIndex = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // ignore
      }
      requests.push(parsed);

      const turn = turns[callIndex] ?? turns[turns.length - 1];
      callIndex++;

      const message: Record<string, unknown> = { role: "assistant", content: turn.content ?? null };
      if (turn.toolCalls && turn.toolCalls.length > 0) {
        message.tool_calls = turn.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }

      const body = {
        id: `fake-${callIndex}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "qwen3.8-max",
        choices: [
          {
            index: 0,
            message,
            finish_reason: turn.toolCalls && turn.toolCalls.length > 0 ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });

  return new Promise<{ url: string; close: () => Promise<void>; requests: unknown[]; callCount: () => number }>(
    (resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${port}/v1`,
          close: () => new Promise((r) => server.close(() => r())),
          requests,
          callCount: () => callIndex,
        });
      });
    }
  );
}
