import React, { useEffect } from "react";
import { NEW_CHILD_MARK, type AgentPlan, type FieldChange } from "./api";
import { hasKey, useT } from "./i18n";
import { Callout, Spinner } from "./ui";

function Value({ v, secret }: { v: string | null; secret?: boolean }) {
  const t = useT();
  if (v === null) return <span className="diff-absent">{t("diffAbsent")}</span>;
  if (v === NEW_CHILD_MARK) return <span className="diff-new-child">{t("diffNewChild")}</span>;
  return <code className={secret ? "diff-secret" : undefined}>{v}</code>;
}

function Row({ c }: { c: FieldChange }) {
  return (
    <tr className={`diff-row op-${c.op}`}>
      <td className="diff-field">
        <span className={`diff-op op-${c.op}`}>{c.op === "add" ? "+" : c.op === "remove" ? "−" : "~"}</span>
        <code>{c.field}</code>
      </td>
      <td className="diff-before">
        <Value v={c.before} secret={c.secret} />
      </td>
      <td className="diff-after">
        <Value v={c.after} secret={c.secret} />
      </td>
    </tr>
  );
}

export function PlanView({ plan, heading }: { plan: AgentPlan; heading?: React.ReactNode }) {
  const t = useT();
  return (
    <div className="plan" data-testid={`plan-${plan.agent}`}>
      {heading}
      {plan.warnings.map((w) => (
        <Callout key={w} tone="warn">
          {hasKey(`warn_${w}`) ? t(`warn_${w}` as never) : w}
        </Callout>
      ))}
      {plan.noop && <p className="muted">{t("diffNoChanges")}</p>}
      {plan.files.map((f) => (
        <div key={f.display} className="diff-file">
          <div className="diff-file-head">
            <code className="diff-path">{f.display}</code>
            {!f.exists && <span className="tag">{t("diffNewFile")}</span>}
            {f.writer === "agent-cli" && <span className="tag">{t("diffAgentCli")}</span>}
          </div>
          <table className="diff-table">
            <thead>
              <tr>
                <th>{t("diffField")}</th>
                <th>{t("diffBefore")}</th>
                <th>{t("diffAfter")}</th>
              </tr>
            </thead>
            <tbody>
              {f.changes
                .filter((c) => c.op !== "same")
                .map((c) => (
                  <Row key={c.field} c={c} />
                ))}
            </tbody>
          </table>
        </div>
      ))}
      {plan.commands.length > 0 && (
        <div className="diff-commands">
          <div className="diff-sub">{t("diffCommands")}</div>
          {plan.commands.map((c, i) => (
            <pre key={i} className="cmd">
              {c.display.replace(NEW_CHILD_MARK, t("diffNewChild"))}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
}

export function Modal({ title, children, footer, onClose }: { title: string; children: React.ReactNode; footer: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-foot">{footer}</div>
      </div>
    </div>
  );
}

export function DiffModal({
  title,
  intro,
  plans,
  busy,
  error,
  confirmLabel,
  onConfirm,
  onClose,
  extra,
}: {
  title: string;
  intro: string;
  plans: { plan: AgentPlan; heading?: React.ReactNode }[];
  busy: boolean;
  error: string | null;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  extra?: React.ReactNode;
}) {
  const t = useT();
  const allNoop = plans.every((p) => p.plan.noop);
  return (
    <Modal
      title={title}
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </button>
          <button className="btn btn-primary" data-testid="diff-confirm" onClick={onConfirm} disabled={busy || allNoop}>
            {busy ? (
              <>
                <Spinner /> {t("writing")}
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </>
      }
    >
      <p className="modal-intro">{intro}</p>
      {extra}
      {plans.map((p) => (
        <PlanView key={p.plan.agent} plan={p.plan} heading={p.heading} />
      ))}
      {error && <Callout tone="error">{error}</Callout>}
    </Modal>
  );
}
