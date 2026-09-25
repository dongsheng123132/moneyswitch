import React from "react";

export default function RingProgress({
  ratio,
  size = 132,
  strokeWidth = 12,
  label,
  sub,
}: {
  ratio: number; // 0..1
  size?: number;
  strokeWidth?: number;
  label: React.ReactNode;
  sub?: React.ReactNode;
}) {
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(1, Math.max(0, ratio));
  const offset = c * (1 - clamped);
  const tone = clamped >= 1 ? "var(--red)" : clamped >= 0.8 ? "var(--yellow)" : "var(--accent)";

  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--panel-2)" strokeWidth={strokeWidth} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth={strokeWidth}
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.4s ease" }}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
        }}
      >
        {label}
        {sub}
      </div>
    </div>
  );
}
