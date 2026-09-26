import type { FetchLike } from "moneyswitch-connect/lib/status";
import { claudeAuthVar } from "./presets.js";
import type { BrainConfig } from "./store.js";

export interface ModelTestResult {
  ok: boolean;
  httpStatus: number | null;
  /** Short, human-readable reason (provider error message, trimmed). */
  message: string;
  ms: number;
  url: string;
}

/**
 * "测试连接": one minimal request in the protocol the agent itself will use —
 * Anthropic Messages (max_tokens 1) for Claude Code, OpenAI Responses
 * (max_output_tokens 16) for Codex. Sent from this local process straight to
 * the configured provider; the key never goes to the MoneySwitch server.
 */
export async function testBrain(agent: "claude" | "codex", brain: BrainConfig, fetchImpl: FetchLike = fetch, timeoutMs = 20_000): Promise<ModelTestResult> {
  const base = brain.baseUrl.replace(/\/+$/, "");
  let url: string;
  let init: RequestInit;
  if (agent === "claude") {
    url = `${base}/v1/messages`;
    const authVar = claudeAuthVar(brain.preset);
    init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(authVar === "ANTHROPIC_API_KEY" ? { "x-api-key": brain.apiKey } : { authorization: `Bearer ${brain.apiKey}` }),
      },
      body: JSON.stringify({ model: brain.model || "claude-sonnet-4-5", max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
    };
  } else {
    url = `${base}/responses`;
    init = {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${brain.apiKey}` },
      body: JSON.stringify({ model: brain.model, input: "ping", max_output_tokens: 16 }),
    };
  }
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    const text = await res.text().catch(() => "");
    let message = res.ok ? "OK" : `HTTP ${res.status}`;
    if (!res.ok) {
      try {
        const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
        const m = typeof j.error === "string" ? j.error : j.error?.message ?? j.message;
        if (m) message = `HTTP ${res.status}: ${m}`;
      } catch {
        if (text) message = `HTTP ${res.status}: ${text.slice(0, 160)}`;
      }
    }
    return { ok: res.ok, httpStatus: res.status, message: message.slice(0, 300), ms: Date.now() - started, url };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const reason = err.name === "AbortError" ? `timed out after ${timeoutMs} ms` : err.cause?.code ?? err.cause?.message ?? err.message;
    return { ok: false, httpStatus: null, message: `network error: ${reason}`, ms: Date.now() - started, url };
  } finally {
    clearTimeout(timer);
  }
}
