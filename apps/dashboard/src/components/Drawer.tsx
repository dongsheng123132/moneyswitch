import React from "react";

export default function Drawer({
  open,
  onClose,
  title,
  children,
  width = 460,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  width?: number;
}) {
  if (!open) return null;
  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" style={{ width }} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h2>{title}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}
