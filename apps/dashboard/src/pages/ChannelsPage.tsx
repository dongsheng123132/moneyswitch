import React, { useState } from "react";
import { Plus, RefreshCw, Radio, Trash2 } from "lucide-react";
import { usePolling } from "../usePolling";
import { listChannels, createChannel, updateChannel, deleteChannel, probeChannelModels, ApiError, ChannelRow } from "../api";
import Drawer from "../components/Drawer";
import Callout from "../components/Callout";
import EmptyState from "../components/EmptyState";
import Term from "../components/Term";
import { SkeletonTable } from "../components/Skeleton";
import { useT } from "../i18n";
import { channelsStrings } from "../i18n/strings/channels";
import { common } from "../i18n/strings/common";
import { useAdminMeta } from "../useAdminMeta";
import "../styles/channels.css";

const DEMO_SELLER_FALLBACK = "http://127.0.0.1:4021";
const DEMO_MODEL_FALLBACK = "moneyswitch-demo-chat";

interface FormState {
  name: string;
  base_url: string;
  models: string; // comma-separated in the form, split on submit
}

const EMPTY_FORM: FormState = { name: "", base_url: "", models: "" };

function demoBaseUrl(demoSellerUrl: string | null): string {
  const trimmed = demoSellerUrl ? demoSellerUrl.replace(/\/+$/, "") : null;
  return `${trimmed ?? DEMO_SELLER_FALLBACK}/v1`;
}

/**
 * One-click demo channel (docs/ux-audit.md A-6/A-7). Exported so the setup
 * wizard (written concurrently) can reuse it verbatim.
 */
export async function addDemoChannel(demoSellerUrl: string | null): Promise<ChannelRow> {
  const base = demoBaseUrl(demoSellerUrl);
  let models: string[];
  try {
    models = await probeChannelModels(base);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : `Could not reach ${base}.`);
  }
  if (models.length === 0) {
    throw new Error(`${base} did not return any models.`);
  }
  return createChannel({ name: "Demo LLM (x402)", base_url: base, models });
}

export default function ChannelsPage() {
  const { data: channels, error, loading, refresh } = usePolling(listChannels);
  const meta = useAdminMeta();
  const t = useT(channelsStrings);
  const tc = useT(common);

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchModelsMsg, setFetchModelsMsg] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const [demoBusy, setDemoBusy] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [demoSuccess, setDemoSuccess] = useState(false);

  function openCreate(prefillDemo = false) {
    setForm(prefillDemo ? { name: "Demo LLM (x402)", base_url: demoBaseUrl(meta?.demo_seller_url ?? null), models: DEMO_MODEL_FALLBACK } : EMPTY_FORM);
    setCreateError(null);
    setFetchModelsMsg(null);
    setShowCreate(true);
  }

  function closeDrawer() {
    setShowCreate(false);
  }

  async function onAddDemo() {
    setDemoBusy(true);
    setDemoError(null);
    setDemoSuccess(false);
    try {
      await addDemoChannel(meta?.demo_seller_url ?? null);
      setDemoSuccess(true);
      refresh();
    } catch (e) {
      setDemoError(e instanceof Error ? e.message : "demo_add_failed");
      openCreate(true);
    } finally {
      setDemoBusy(false);
    }
  }

  async function pullModels() {
    if (!form.base_url.trim()) {
      setCreateError(t("fieldRequired"));
      return;
    }
    setFetchingModels(true);
    setCreateError(null);
    setFetchModelsMsg(null);
    try {
      const models = await probeChannelModels(form.base_url.trim());
      if (models.length === 0) {
        setCreateError(t("fetchModelsEmpty"));
      } else {
        setForm((f) => ({ ...f, models: models.join(", ") }));
        setFetchModelsMsg(t("fetchModelsFound", { n: models.length }));
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
    if (deleteConfirmId !== ch.id) {
      setDeleteConfirmId(ch.id);
      return;
    }
    setBusyId(ch.id);
    setActionError(null);
    try {
      await deleteChannel(ch.id);
      refresh();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "delete_failed");
    } finally {
      setBusyId(null);
      setDeleteConfirmId(null);
    }
  }

  const showDemoWarn = showCreate && meta && meta.demo_seller_url == null;

  return (
    <div>
      <p className="channels-intro">
        {t("intro")} (<Term k="channel">channel</Term> · <Term k="x402">x402</Term>)
      </p>

      <div className="toolbar">
        <div />
        <button className="btn" onClick={() => openCreate(false)}>
          <Plus size={15} />
          {t("addChannel")}
        </button>
      </div>
      {error && <Callout tone="error">{tc("requestFailed", { message: error })}</Callout>}
      {actionError && <Callout tone="error">{actionError}</Callout>}
      {demoSuccess && <Callout tone="success">{t("demoAddSuccess")}</Callout>}
      {demoError && <Callout tone="error" title={t("demoAddFailedTitle")}>{demoError}</Callout>}

      <div className="card">
        {loading && !channels ? (
          <SkeletonTable rows={3} cols={5} />
        ) : !channels || channels.length === 0 ? (
          <EmptyState
            icon={<Radio size={28} />}
            title={t("emptyTitle")}
            action={
              <div className="btn-group">
                <button type="button" className="btn" onClick={onAddDemo} disabled={demoBusy}>
                  {demoBusy ? t("addingDemo") : t("addDemoChannel")}
                </button>
                <button type="button" className="btn secondary" onClick={() => openCreate(false)}>
                  {t("addManually")}
                </button>
              </div>
            }
          >
            {t("emptyBody")}
          </EmptyState>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("colName")}</th>
                <th>{t("colBaseUrl")}</th>
                <th>{t("colModels")}</th>
                <th>{t("colStatus")}</th>
                <th>{t("colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((ch) => (
                <tr key={ch.id}>
                  <td>{ch.name}</td>
                  <td className="mono">{ch.base_url}</td>
                  <td>
                    <div className="channels-models-cell">
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
                      aria-pressed={ch.enabled}
                      disabled={busyId === ch.id}
                      onClick={() => toggleEnabled(ch)}
                    >
                      {ch.enabled ? t("statusEnabled") : t("statusDisabled")}
                    </button>
                  </td>
                  <td>
                    {deleteConfirmId === ch.id ? (
                      <span className="channels-delete-confirm">
                        <span className="stat-sub">{t("deleteConfirm")}</span>
                        <button type="button" className="btn small danger" disabled={busyId === ch.id} onClick={() => onDelete(ch)}>
                          {t("deleteConfirmYes")}
                        </button>
                        <button type="button" className="btn small secondary" disabled={busyId === ch.id} onClick={() => setDeleteConfirmId(null)}>
                          {tc("cancel")}
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="btn small danger" disabled={busyId === ch.id} onClick={() => onDelete(ch)} aria-label={t("deleteAction")}>
                        <Trash2 size={13} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Drawer open={showCreate} onClose={closeDrawer} title={t("drawerTitle")} width={460}>
        <form onSubmit={submitCreate}>
          <div className="preset-row">
            <button type="button" className="preset-btn" onClick={() => openCreate(true)}>
              {t("prefillDemo")}
            </button>
          </div>

          {showDemoWarn && (
            <Callout tone="warn" title={t("demoSellerUnknownTitle")}>
              {t("demoSellerUnknownBody")}
            </Callout>
          )}

          <div className="field">
            <label>{t("fieldName")}</label>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Demo LLM (x402)" />
          </div>
          <div className="field">
            <label>{t("fieldBaseUrl")}</label>
            <input
              required
              value={form.base_url}
              onChange={(e) => setForm({ ...form, base_url: e.target.value })}
              placeholder={demoBaseUrl(null)}
            />
            <div className="field-hint">{t("baseUrlHint")}</div>
          </div>
          <div className="field">
            <label>{t("fieldModels")}</label>
            <input
              required
              value={form.models}
              onChange={(e) => setForm({ ...form, models: e.target.value })}
              placeholder={DEMO_MODEL_FALLBACK}
            />
            <div className="field-hint">
              <button type="button" className="btn small secondary" onClick={pullModels} disabled={fetchingModels} style={{ marginTop: 6 }}>
                <RefreshCw size={12} className={fetchingModels ? "spin" : ""} />
                {fetchingModels ? t("fetchingModels") : t("fetchModels")}
              </button>
              {fetchModelsMsg && <span style={{ marginLeft: 8 }}>{fetchModelsMsg}</span>}
            </div>
          </div>

          {createError && <Callout tone="error">{createError}</Callout>}
          <div className="modal-actions">
            <button type="button" className="btn secondary" onClick={closeDrawer}>
              {tc("cancel")}
            </button>
            <button type="submit" className="btn" disabled={creating}>
              {creating ? tc("loading") : t("addChannel")}
            </button>
          </div>
        </form>
      </Drawer>
    </div>
  );
}
