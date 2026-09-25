import React, { useState } from "react";
import { Plus, Trash2, RefreshCw, Radio } from "lucide-react";
import { usePolling } from "../usePolling";
import { listChannels, createChannel, updateChannel, deleteChannel, probeChannelModels, ApiError, ChannelRow } from "../api";
import Pill from "../components/Pill";
import Drawer from "../components/Drawer";
import { SkeletonTable } from "../components/Skeleton";

interface FormState {
  name: string;
  base_url: string;
  models: string; // comma-separated in the form, split on submit
}

const DEMO_PRESET: FormState = {
  name: "Demo LLM (x402)",
  base_url: "http://127.0.0.1:4021/v1",
  models: "moneyswitch-demo-chat",
};

const EMPTY_FORM: FormState = { name: "", base_url: "", models: "" };

export default function ChannelsPage() {
  const { data: channels, error, loading, refresh } = usePolling(listChannels);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function openCreate() {
    setForm(EMPTY_FORM);
    setCreateError(null);
    setShowCreate(true);
  }

  function closeDrawer() {
    setShowCreate(false);
  }

  async function pullModels() {
    if (!form.base_url.trim()) {
      setCreateError("Enter a base URL first.");
      return;
    }
    setFetchingModels(true);
    setCreateError(null);
    try {
      const models = await probeChannelModels(form.base_url.trim());
      if (models.length === 0) {
        setCreateError("Upstream returned no models.");
      } else {
        setForm((f) => ({ ...f, models: models.join(", ") }));
      }
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "fetch_models_failed");
    } finally {
      setFetchingModels(false);
    }
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      await createChannel({
        name: form.name,
        base_url: form.base_url,
        models: form.models
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean),
      });
      setShowCreate(false);
      refresh();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "create_failed");
    } finally {
      setCreating(false);
    }
  }

  async function toggleEnabled(ch: ChannelRow) {
    setBusyId(ch.id);
    setActionError(null);
    try {
      await updateChannel(ch.id, { enabled: !ch.enabled });
      refresh();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "update_failed");
    } finally {
      setBusyId(null);
    }
  }

  async function onDelete(ch: ChannelRow) {
    if (!confirm(`Delete channel "${ch.name}"? This cannot be undone.`)) return;
    setBusyId(ch.id);
    setActionError(null);
    try {
      await deleteChannel(ch.id);
      refresh();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "delete_failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="toolbar">
        <div />
        <button className="btn" onClick={openCreate}>
          <Plus size={15} />
          Add channel
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {actionError && <div className="error-banner">{actionError}</div>}

      <div className="card">
        {loading && !channels ? (
          <SkeletonTable rows={3} cols={5} />
        ) : !channels || channels.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <Radio size={28} />
            </div>
            <div className="empty-title">No channels yet</div>
            Add an OpenAI-compatible, x402-priced upstream to route chat completions through.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Base URL</th>
                <th>Models</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {channels.map((ch) => (
                <tr key={ch.id}>
                  <td>{ch.name}</td>
                  <td className="mono">{ch.base_url}</td>
                  <td style={{ whiteSpace: "normal", maxWidth: 320 }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {ch.models.slice(0, 3).map((m) => (
                        <span className="pill pill-gray" key={m}>
                          {m}
                        </span>
                      ))}
                      {ch.models.length > 3 && <span className="pill pill-gray">+{ch.models.length - 3}</span>}
                      {ch.models.length === 0 && <span className="stat-sub">-</span>}
                    </div>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`btn small ${ch.enabled ? "success" : "secondary"}`}
                      disabled={busyId === ch.id}
                      onClick={() => toggleEnabled(ch)}
                    >
                      {ch.enabled ? "Enabled" : "Disabled"}
                    </button>
                  </td>
                  <td>
                    <button type="button" className="btn small danger" disabled={busyId === ch.id} onClick={() => onDelete(ch)}>
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Drawer open={showCreate} onClose={closeDrawer} title="Add channel" width={460}>
        <form onSubmit={submitCreate}>
          <div className="preset-row">
            <button type="button" className="preset-btn" onClick={() => setForm(DEMO_PRESET)}>
              Prefill: Demo LLM (x402)
            </button>
          </div>

          <div className="field">
            <label>Name</label>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Demo LLM (x402)" />
          </div>
          <div className="field">
            <label>Base URL</label>
            <input
              required
              value={form.base_url}
              onChange={(e) => setForm({ ...form, base_url: e.target.value })}
              placeholder="http://127.0.0.1:4021/v1"
            />
          </div>
          <div className="field">
            <label>Models (comma-separated)</label>
            <input
              required
              value={form.models}
              onChange={(e) => setForm({ ...form, models: e.target.value })}
              placeholder="moneyswitch-demo-chat"
            />
            <div className="field-hint">
              <button type="button" className="btn small secondary" onClick={pullModels} disabled={fetchingModels} style={{ marginTop: 6 }}>
                <RefreshCw size={12} className={fetchingModels ? "spin" : ""} />
                {fetchingModels ? "Fetching..." : "Fetch models from upstream"}
              </button>
            </div>
          </div>

          {createError && <div className="error-banner">{createError}</div>}
          <div className="modal-actions">
            <button type="button" className="btn secondary" onClick={closeDrawer}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={creating}>
              {creating ? "Adding..." : "Add channel"}
            </button>
          </div>
        </form>
      </Drawer>
    </div>
  );
}
