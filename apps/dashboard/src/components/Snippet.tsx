import React from "react";
import CopyButton from "./CopyButton";

/**
 * Titled, copyable code block. `display` lets callers mask secrets on screen
 * while `code` (the copied value) stays complete.
 */
export default function Snippet({ title, code, display, note }: { title?: React.ReactNode; code: string; display?: string; note?: React.ReactNode }) {
  return (
    <div className="snippet">
      {title && (
        <div className="snippet-head">
          <span className="snippet-title">{title}</span>
          <CopyButton text={code} />
        </div>
      )}
      <div className={`code-block ${title ? "" : "has-inline-copy"}`}>
        {display ?? code}
        {!title && <CopyButton text={code} />}
      </div>
      {note && <div className="snippet-note">{note}</div>}
    </div>
  );
}
