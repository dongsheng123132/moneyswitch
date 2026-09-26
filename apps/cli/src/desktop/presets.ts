/**
 * Model provider presets for the "brain" column. Base URLs are what each
 * agent needs *in its own protocol*: Claude Code speaks the Anthropic
 * Messages API, Codex (0.156.1) speaks only the OpenAI Responses API
 * (`wire_api = "chat"` is rejected — see docs/desktop-agents.md).
 */
export interface BrainPreset {
  id: string;
  label: string;
  baseUrl: string;
  /** Suggested model names (free text is always allowed). */
  models: string[];
  /** Claude Code only: which env var carries the key. */
  authVar?: "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN";
  /** Shown under the preset (i18n key on the UI side). */
  noteKey?: string;
  keyHint?: string;
}

export const CLAUDE_PRESETS: BrainPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
    authVar: "ANTHROPIC_API_KEY",
    keyHint: "sk-ant-…",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    models: ["anthropic/claude-sonnet-4.5"],
    authVar: "ANTHROPIC_AUTH_TOKEN",
    keyHint: "sk-or-…",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    models: ["deepseek-chat", "deepseek-reasoner"],
    authVar: "ANTHROPIC_AUTH_TOKEN",
    keyHint: "sk-…",
  },
  {
    id: "custom",
    label: "Custom",
    baseUrl: "",
    models: [],
    authVar: "ANTHROPIC_AUTH_TOKEN",
    noteKey: "presetCustomClaude",
  },
];

export const CODEX_PRESETS: BrainPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-6-sol", "gpt-5-codex"],
    keyHint: "sk-…",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-5", "anthropic/claude-sonnet-4.5"],
    keyHint: "sk-or-…",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat"],
    keyHint: "sk-…",
    noteKey: "presetDeepseekCodex",
  },
  {
    id: "custom",
    label: "Custom",
    baseUrl: "",
    models: [],
    noteKey: "presetCustomCodex",
  },
];

export function presetsFor(agent: string): BrainPreset[] {
  if (agent === "claude") return CLAUDE_PRESETS;
  if (agent === "codex") return CODEX_PRESETS;
  return [];
}

export function claudeAuthVar(presetId: string): "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN" {
  return CLAUDE_PRESETS.find((p) => p.id === presetId)?.authVar ?? "ANTHROPIC_AUTH_TOKEN";
}
