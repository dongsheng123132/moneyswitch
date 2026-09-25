import React from "react";

export function SkeletonBlock({ height = 16, width = "100%" }: { height?: number; width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} />;
}

export function SkeletonCard() {
  return (
    <div className="card">
      <SkeletonBlock height={12} width={80} />
      <div style={{ height: 10 }} />
      <SkeletonBlock height={26} width={120} />
    </div>
  );
}

export function SkeletonTable({ rows = 5, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <table>
      <tbody>
        {Array.from({ length: rows }).map((_, r) => (
          <tr key={r}>
            {Array.from({ length: cols }).map((__, c) => (
              <td key={c}>
                <SkeletonBlock height={12} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
