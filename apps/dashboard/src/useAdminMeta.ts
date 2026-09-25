import { useEffect, useState } from "react";
import { getAdminMeta, type AdminMeta } from "./api";

let cached: AdminMeta | null = null;
let inflight: Promise<AdminMeta> | null = null;

/** GET /v1/admin/meta once per page load (admin views only). */
export function useAdminMeta(): AdminMeta | null {
  const [meta, setMeta] = useState<AdminMeta | null>(cached);
  useEffect(() => {
    if (cached) return;
    let alive = true;
    inflight = inflight ?? getAdminMeta();
    inflight
      .then((m) => {
        cached = m;
        if (alive) setMeta(m);
      })
      .catch(() => {
        inflight = null;
      });
    return () => {
      alive = false;
    };
  }, []);
  return meta;
}
