import { useEffect, useState } from "react";
import { getSetupStatus } from "./api";

/**
 * Offline demo detection (`npx moneyswitch-server demo`). Read once per page
 * load from the unauthenticated GET /v1/setup/status (`demo: true`), so the
 * DEMO banner also shows on the login and setup screens. Grants nothing.
 */
let cached: boolean | null = null;
let inflight: Promise<boolean> | null = null;

export function fetchDemoMode(): Promise<boolean> {
  if (cached !== null) return Promise.resolve(cached);
  inflight =
    inflight ??
    getSetupStatus()
      .then((s) => {
        cached = Boolean(s.demo);
        return cached;
      })
      .catch(() => {
        inflight = null;
        return false;
      });
  return inflight;
}

export function useDemoMode(): boolean {
  const [demo, setDemo] = useState<boolean>(cached ?? false);
  useEffect(() => {
    let alive = true;
    fetchDemoMode().then((d) => {
      if (alive) setDemo(d);
    });
    return () => {
      alive = false;
    };
  }, []);
  return demo;
}

/** sessionStorage slot the Playground reads its MoneyKey from (PlaygroundPage). */
export const PLAYGROUND_KEY_STORAGE = "moneyswitch_playground_key";
