import React from "react";

export default function Pill({ tone, children }: { tone: "green" | "red" | "yellow" | "blue" | "gray"; children: React.ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}
