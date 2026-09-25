import React from "react";

export default function ProgressBar({ ratio }: { ratio: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  const tone = pct >= 100 ? "danger" : pct >= 80 ? "warn" : "ok";
  return (
    <div className="progress-track" title={`${pct}%`}>
      <div className={`progress-fill ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
