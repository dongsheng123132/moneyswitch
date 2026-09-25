import React, { useState } from "react";

export interface BarDatum {
  label: string;
  value: number; // display value (float ok, this is chart-only)
  displayValue: string; // pre-formatted string for tooltip
}

export default function BarChart({ data, height = 160 }: { data: BarDatum[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1e-9, ...data.map((d) => d.value));
  const width = 640;
  const padding = 24;
  const barGap = 10;
  const chartWidth = width - padding * 2;
  const barWidth = data.length > 0 ? (chartWidth - barGap * (data.length - 1)) / data.length : 0;
  const chartHeight = height - padding * 1.5;

  return (
    <div className="barchart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} className="barchart-svg" preserveAspectRatio="none">
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} className="barchart-axis" />
        {data.map((d, i) => {
          const h = max > 0 ? (d.value / max) * chartHeight : 0;
          const x = padding + i * (barWidth + barGap);
          const y = height - padding - h;
          const isHover = hover === i;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect
                x={x}
                y={y}
                width={Math.max(2, barWidth)}
                height={Math.max(1, h)}
                rx={4}
                className={`barchart-bar${isHover ? " hover" : ""}`}
              />
              <rect x={x} y={padding / 2} width={Math.max(2, barWidth)} height={chartHeight + padding} fill="transparent" />
              <text x={x + barWidth / 2} y={height - padding + 16} textAnchor="middle" className="barchart-label">
                {d.label}
              </text>
              {isHover && (
                <g>
                  <rect
                    x={Math.min(width - padding - 90, Math.max(padding, x + barWidth / 2 - 45))}
                    y={Math.max(2, y - 26)}
                    width={90}
                    height={20}
                    rx={4}
                    className="barchart-tooltip-bg"
                  />
                  <text
                    x={Math.min(width - padding - 45, Math.max(padding + 45, x + barWidth / 2))}
                    y={Math.max(16, y - 12)}
                    textAnchor="middle"
                    className="barchart-tooltip-text"
                  >
                    {d.displayValue}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
