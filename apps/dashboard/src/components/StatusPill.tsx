import React from "react";
import Pill from "./Pill";
import Term from "./Term";
import { useT } from "../i18n";
import { common } from "../i18n/strings/common";

export type PaymentStatus = "reserved" | "settled" | "failed" | "unknown";

const TONE: Record<PaymentStatus, "green" | "red" | "blue" | "yellow"> = {
  settled: "green",
  failed: "red",
  reserved: "blue",
  unknown: "yellow",
};

/** Localized payment status + hover explanation + MOCK marker (docs/ux-audit.md B-4). */
export default function StatusPill({ status, mock }: { status: PaymentStatus; mock?: boolean }) {
  const t = useT(common);
  return (
    <span className="status-cell">
      <Term k={`status_${status}` as const}>
        <Pill tone={TONE[status] ?? "gray"}>{t(`status_${status}` as const)}</Pill>
      </Term>
      {mock && (
        <Term k="mock">
          <span className="badge mock">{t("mock")}</span>
        </Term>
      )}
    </span>
  );
}
