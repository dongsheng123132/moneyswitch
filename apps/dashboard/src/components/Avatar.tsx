import React from "react";
import { agentIdentity } from "../money";

export default function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const { initial, color } = agentIdentity(name);
  return (
    <div
      className="avatar"
      style={{
        width: size,
        height: size,
        borderRadius: size / 3,
        background: color,
        fontSize: size * 0.42,
      }}
      title={name}
    >
      {initial}
    </div>
  );
}
