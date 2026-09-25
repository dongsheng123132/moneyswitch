import React, { useState } from "react";
import { Plus, KeyRound } from "lucide-react";
import { usePolling } from "../usePolling";
import { listKeys, createKey, revokeKey, listChannels, ApiError, ChannelRow, CreateMoneyKeyResponse, MoneyKeyRow } from "../api";
import { toMicros, fromMicros, ratioMicros, formatUsdc } from "../money";
import CopyButton from "../components/CopyButton";
import Avatar from "../components/Avatar";
import Pill from "../components/Pill";
import ProgressBar from "../components/ProgressBar";
import Drawer from "../components/Drawer";
import { SkeletonTable } from "../components/Skeleton";

interface FormState {
  name: string;
  total_budget: string;
  daily_budget: string;
  per_request_limit: string;
  approval_threshold: string;
  allowed_hosts: string;
  max_payments_per_minute: string;
  expires_at: string;
  allowed_models: string[]; // empty = all models allowed (SPEC-v0.2 §1: null = all)
}

const EMPTY_FORM: FormState = {
  name: "",
  total_budget: "5.00",
  daily_budget: "1.00",
  per_request_limit: "0.10",
  approval_threshold: "",
  allowed_hosts: "127.0.0.1:4021",
  max_payments_per_minute: "10",
  expires_at: "",
  allowed_models: [],
};

const PRESETS: Array<{ label: string; patch: Partial<FormState>; dynamicHosts?: boolean }> = [
  {
    label: "Hackathon demo: $0.50/day, $0.20/req, approval ≥ $0.10",
    patch: { daily_budget: "0.50", per_request_limit: "0.20", approval_threshold: "0.10", total_budget: "5.00" },
    // allowed_hosts is filled in from enabled channels at click time — see
    // deriveAllowedHostsFromChannels() below — instead of a hardcoded
    // 127.0.0.1:4021 that silently stops matching once a real channel exists.
    dynamicHosts: true,
  },
  {
    label: "Tight: $0.10/day, $0.02/req",
    patch: { daily_budget: "0.10", per_request_limit: "0.02", approval_threshold: "0.05", total_budget: "1.00" },
  },
  {
    label: "Generous: $5.00/day, $1.00/req",
    patch: { daily_budget: "5.00", per_request_limit: "1.00", approval_threshold: "", total_budget: "50.00" },
  },
];

function deriveAllowedHostsFromChannels(channels: ChannelRow[] | undefined | null): string {
  const hosts = new Set<string>();
  for (const c of channels ?? []) {
    if (!c.enabled) continue;
    try {
      const u = new URL(c.base_url);
      hosts.add(u.port ? `${u.hostname}:${u.port}` : u.hostname);
    } catch {
      // Malformed base_url — skip rather than poison the host allow-list.
    }
  }
  if (hosts.size === 0) return "127.0.0.1:4021";
  return Array.from(hosts).join(", ");
}

function claudeCommand(base: string, key: string): string {
  return `claude mcp add moneyswitch -e MONEY_API_BASE=${base} -e MONEY_API_KEY=${key} -- node C:/1mineyswitch/apps/mcp/dist/index.js`;
}

function codexConfigSnippet(base: string, key: string): string {
  return `[mcp_servers.moneyswitch]
command = "node"
args = ["C:/1mineyswitch/apps/mcp/dist/index.js"]

[mcp_servers.moneyswitch.env]
MONEY_API_BASE = "${base}"
MONEY_API_KEY = "${key}"`;
}

function envSnippet(base: string, key: string): string {
  return `MONEY_API_BASE=${base}\nMONEY_API_KEY=${key}`;
}

function openaiBase(origin: string): string {
  return `${origin}/v1`;
}

function openaiPythonSnippet(origin: string, key: string): string {
  return `from openai import OpenAI

client = OpenAI(base_url="${openaiBase(origin)}", api_key="${key}")

resp = client.chat.completions.create(
    model="moneyswitch-demo-chat",
    messages=[{"role": "user", "content": "hello"}],
)
print(resp.choices[0].message.content)`;
}

function openaiNodeSnippet(origin: string, key: string): string {
  return `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${openaiBase(origin)}", apiKey: "${key}" });

const resp = await client.chat.completions.create({
  model: "moneyswitch-demo-chat",
  messages: [{ role: "user", content: "hello" }],
});
console.log(resp.choices[0].message.content);`;
}

function openaiCurlSnippet(origin: string, key: string): string {
  return `curl ${openaiBase(origin)}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"moneyswitch-demo-chat","messages":[{"role":"user","content":"hello"}]}'`;
}

// SPEC-v0.3-employee.md §A.7: a copy-paste-ready Chinese message for handing
// a freshly created key to an employee over 企业微信/飞书.
function employeeMessageSnippet(origin: string, keyName: string, key: string): string {
  return `【MoneySwitch】${keyName} 的 API Key 已开通

服务器地址：${origin}
Key：${key}

登录方式：打开 ${origin}/login，把上面的 Key 粘贴进去登录即可看到你的额度、流水，还能直接对话。

一键接入本机 Agent（Claude Code / Codex 等）：
npx moneyswitch-connect --server ${origin} --key ${key}

Key 只发给你本人，不要转发给别人。`;
}

function newApiSnippet(origin: string, key: string): string {
  return `NewAPI → Channels → Add channel:
  Type:     OpenAI
  Base URL: ${openaiBase(origin)}
  API Key:  ${key}
  Models:   pull from /v1/models (only models this key is allowed to use)`;
}

export default function MoneyKeysPage() {
  const { data: keys, error, loading, refresh } = usePolling(listKeys);
  const { data: channels } = usePolling(listChannels);
  const allModelOptions = Array.from(new Set((channels ?? []).flatMap((c) => c.models))).sort();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateMoneyKeyResponse | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [tab, setTab] = useState<"claude" | "codex" | "env" | "openai" | "newapi" | "employee">("claude");

  function openCreate() {
    setForm(EMPTY_FORM);
    setCreateError(null);
    setCreated(null);
    setTab("claude");
    setShowCreate(true);
  }

  function closeDrawer() {
    setShowCreate(false);
    setCreated(null);
  }

  function applyPreset(preset: (typeof PRESETS)[number]) {
    setForm((f) => ({
      ...f,
      ...preset.patch,
      ...(preset.dynamicHosts ? { allowed_hosts: deriveAllowedHostsFromChannels(channels) } : {}),
    }));
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const res = await createKey({
        name: form.name,
        total_budget: form.total_budget,
        daily_budget: form.daily_budget,
        per_request_limit: form.per_request_limit,
        approval_threshold: form.approval_threshold.trim() ? form.approval_threshold.trim() : null,
        allowed_hosts: form.allowed_hosts
          .split(",")
          .map((h) => h.trim())
          .filter(Boolean),
        max_payments_per_minute: form.max_payments_per_minute ? Number(form.max_payments_per_minute) : undefined,
        expires_at: form.expires_at.trim() ? form.expires_at.trim() : null,
        allowed_models: form.allowed_models.length > 0 ? form.allowed_models : null,
      });
      setCreated(res);
      refresh();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "create_failed");
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(id: string) {
    if (!confirm("Revoke this MoneyKey? This cannot be undone.")) return;
    setRevokingId(id);
    setRevokeError(null);
    try {
      await revokeKey(id);
      refresh();
    } catch (e) {
      setRevokeError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "revoke_failed");
    } finally {
      setRevokingId(null);
    }
  }

  const apiBase = window.location.origin;

  return (
    <div>
      <div className="toolbar">
        <div />
        <button className="btn" onClick={openCreate}>
          <Plus size={15} />
          Create key
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {revokeError && <div className="error-banner">{revokeError}</div>}

      <div className="card">
        {loading && !keys ? (
          <SkeletonTable rows={4} cols={8} />
        ) : !keys || keys.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <KeyRound size={28} />
            </div>
            <div className="empty-title">No Money Keys yet</div>
            Create one to let an agent spend USDC on your behalf.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Daily</th>
                <th className="num">Per-request</th>
                <th className="num">Total used / budget</th>
                <th>Allowed hosts</th>
                <th>Status</th>
                <th>Expires</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k: MoneyKeyRow) => {
                const usedMicros = toMicros(k.used_today);
                const dailyMicros = toMicros(k.daily_budget);
                const r = ratioMicros(usedMicros, dailyMicros);
                const hostsText = k.allowed_hosts.join(", ");
                const hostsTrunc = hostsText.length > 28 ? hostsText.slice(0, 26) + "…" : hostsText;
                return (
                  <tr key={k.id}>
                    <td>
                      <div className="agent-row">
                        <Avatar name={k.name} size={24} />
                        <span className="agent-name">{k.name}</span>
                      </div>
                    </td>
                    <td className="mono">{k.key_prefix}••••</td>
                    <td style={{ minWidth: 130 }}>
                      <div className="num" style={{ fontSize: 12 }}>
                        {formatUsdc(k.used_today, { maxDecimals: 4 })} / {formatUsdc(k.daily_budget, { maxDecimals: 4 })}
                      </div>
                      <ProgressBar ratio={r} />
                    </td>
                    <td className="num">{formatUsdc(k.per_request_limit, { maxDecimals: 4 })}</td>
                    <td className="num">
                      {formatUsdc(k.used_total, { maxDecimals: 4 })} / {formatUsdc(k.total_budget, { maxDecimals: 4 })}
                    </td>
                    <td className="mono" title={hostsText}>
                      {hostsTrunc || "-"}
                    </td>
                    <td>
                      <Pill tone={k.enabled ? "green" : "red"}>{k.enabled ? "enabled" : "revoked"}</Pill>
                    </td>
                    <td>{k.expires_at ? new Date(k.expires_at).toLocaleDateString() : "never"}</td>
                    <td>
                      {k.enabled && (
                        <button className="btn small danger" onClick={() => onRevoke(k.id)} disabled={revokingId === k.id}>
                          {revokingId === k.id ? "..." : "Revoke"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <Drawer open={showCreate} onClose={closeDrawer} title={created ? "Key created" : "Create Money Key"} width={480}>
        {!created ? (
          <form onSubmit={submitCreate}>
            <div className="preset-row">
              {PRESETS.map((p) => (
                <button type="button" key={p.label} className="preset-btn" onClick={() => applyPreset(p)}>
                  {p.label}
                </button>
              ))}
            </div>

            <div className="field">
              <label>Name</label>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Claude Code" />
            </div>

            <div className="form-section">
              <div className="form-section-title">Budget</div>
              <div className="field-row">
                <div className="field">
                  <label>Daily budget (USDC)</label>
                  <input required value={form.daily_budget} onChange={(e) => setForm({ ...form, daily_budget: e.target.value })} />
                </div>
                <div className="field">
                  <label>Total budget (USDC)</label>
                  <input required value={form.total_budget} onChange={(e) => setForm({ ...form, total_budget: e.target.value })} />
                </div>
              </div>
            </div>

            <div className="form-section">
              <div className="form-section-title">Guardrails</div>
              <div className="field-row">
                <div className="field">
                  <label>Per-request limit (USDC)</label>
                  <input
                    required
                    value={form.per_request_limit}
                    onChange={(e) => setForm({ ...form, per_request_limit: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>Approval threshold (optional)</label>
                  <input
                    value={form.approval_threshold}
                    onChange={(e) => setForm({ ...form, approval_threshold: e.target.value })}
                    placeholder="empty = never require"
                  />
                </div>
              </div>
              <div className="field">
                <label>Max payments / minute</label>
                <input
                  value={form.max_payments_per_minute}
                  onChange={(e) => setForm({ ...form, max_payments_per_minute: e.target.value })}
                />
              </div>
            </div>

            <div className="form-section">
              <div className="form-section-title">Access</div>
              <div className="field">
                <label>Allowed hosts (comma-separated, host:port)</label>
                <input required value={form.allowed_hosts} onChange={(e) => setForm({ ...form, allowed_hosts: e.target.value })} />
              </div>
              <div className="field">
                <label>Expires at (ISO, optional)</label>
                <input value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} placeholder="never" />
              </div>
              <div className="field">
                <label>Allowed models (empty = all channel models)</label>
                {allModelOptions.length === 0 ? (
                  <div className="field-hint">No channels with models yet — this key will be allowed all models.</div>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {allModelOptions.map((m) => {
                      const active = form.allowed_models.includes(m);
                      return (
                        <button
                          type="button"
                          key={m}
                          className={`pill ${active ? "pill-blue" : "pill-gray"}`}
                          style={{ border: "none", cursor: "pointer" }}
                          onClick={() =>
                            setForm((f) => ({
                              ...f,
                              allowed_models: active ? f.allowed_models.filter((x) => x !== m) : [...f.allowed_models, m],
                            }))
                          }
                        >
                          {m}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {createError && <div className="error-banner">{createError}</div>}
            <div className="modal-actions">
              <button type="button" className="btn secondary" onClick={closeDrawer}>
                Cancel
              </button>
              <button type="submit" className="btn" disabled={creating}>
                {creating ? "Creating..." : "Create key"}
              </button>
            </div>
          </form>
        ) : (
          <div>
            <div className="key-once-banner">This is the only time the full key is shown. Copy it now — MoneySwitch stores only a hash.</div>
            <div className="field">
              <label>Your Money Key</label>
              <div className="key-big">{created.key}</div>
              <CopyButton text={created.key} />
            </div>

            <div className="tabs" style={{ marginTop: 20 }}>
              <button type="button" className={`tab-btn ${tab === "claude" ? "active" : ""}`} onClick={() => setTab("claude")}>
                Claude Code
              </button>
              <button type="button" className={`tab-btn ${tab === "codex" ? "active" : ""}`} onClick={() => setTab("codex")}>
                Codex
              </button>
              <button type="button" className={`tab-btn ${tab === "env" ? "active" : ""}`} onClick={() => setTab("env")}>
                Env vars
              </button>
              <button type="button" className={`tab-btn ${tab === "openai" ? "active" : ""}`} onClick={() => setTab("openai")}>
                OpenAI / NewAPI
              </button>
              <button type="button" className={`tab-btn ${tab === "employee" ? "active" : ""}`} onClick={() => setTab("employee")}>
                Send to employee
              </button>
            </div>

            {tab === "claude" && (
              <div className="code-block">
                {claudeCommand(apiBase, created.key)}
                <CopyButton text={claudeCommand(apiBase, created.key)} />
              </div>
            )}
            {tab === "codex" && (
              <div className="code-block">
                {codexConfigSnippet(apiBase, created.key)}
                <CopyButton text={codexConfigSnippet(apiBase, created.key)} />
              </div>
            )}
            {tab === "env" && (
              <div className="code-block">
                {envSnippet(apiBase, created.key)}
                <CopyButton text={envSnippet(apiBase, created.key)} />
              </div>
            )}
            {tab === "openai" && (
              <div>
                <div className="field">
                  <label>Base URL</label>
                  <div className="code-block">
                    {openaiBase(apiBase)}
                    <CopyButton text={openaiBase(apiBase)} />
                  </div>
                </div>
                <div className="field">
                  <label>API Key</label>
                  <div className="code-block">
                    {created.key}
                    <CopyButton text={created.key} />
                  </div>
                </div>
                <div className="field">
                  <label>Python (openai SDK)</label>
                  <div className="code-block">
                    {openaiPythonSnippet(apiBase, created.key)}
                    <CopyButton text={openaiPythonSnippet(apiBase, created.key)} />
                  </div>
                </div>
                <div className="field">
                  <label>Node (openai SDK)</label>
                  <div className="code-block">
                    {openaiNodeSnippet(apiBase, created.key)}
                    <CopyButton text={openaiNodeSnippet(apiBase, created.key)} />
                  </div>
                </div>
                <div className="field">
                  <label>curl</label>
                  <div className="code-block">
                    {openaiCurlSnippet(apiBase, created.key)}
                    <CopyButton text={openaiCurlSnippet(apiBase, created.key)} />
                  </div>
                </div>
                <div className="field">
                  <label>Add as an OpenAI-type channel in NewAPI</label>
                  <div className="code-block">
                    {newApiSnippet(apiBase, created.key)}
                    <CopyButton text={newApiSnippet(apiBase, created.key)} />
                  </div>
                </div>
              </div>
            )}
            {tab === "employee" && (
              <div>
                <div className="field-hint" style={{ marginBottom: 10 }}>
                  可以直接复制下面这段发给企业微信/飞书里的员工。
                </div>
                <div className="code-block">
                  {employeeMessageSnippet(apiBase, created.name || "该 Agent", created.key)}
                  <CopyButton text={employeeMessageSnippet(apiBase, created.name || "该 Agent", created.key)} />
                </div>
              </div>
            )}

            <div className="modal-actions">
              <button className="btn" onClick={closeDrawer}>
                Done
              </button>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
