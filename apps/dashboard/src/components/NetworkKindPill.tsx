import React from "react";
import type { NetworkMode } from "../api";
import { useT } from "../i18n";
import { common } from "../i18n/strings/common";
import Pill from "./Pill";

/** "Mainnet" (real money, yellow) / "Testnet" (test tokens, blue) next to a chain or on a key. Nothing for an unknown kind. */
export default function NetworkKindPill({ kind }: { kind: NetworkMode | null | undefined }) {
  const tc = useT(common);
  if (kind !== "mainnet" && kind !== "testnet") return null;
  return (
    <span data-network-kind={kind}>
      <Pill tone={kind === "mainnet" ? "yellow" : "blue"}>{kind === "mainnet" ? tc("kindMainnet") : tc("kindTestnet")}</Pill>
    </span>
  );
}
