import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Polls the given async fetcher every `intervalMs` (default 3000ms per
 * SPEC §10: "轮询 3s 刷新即可，不上 WebSocket"). Also exposes a manual
 * refresh() for after mutations (create key, approve, etc).
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs = 3000
): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "request_failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    run();
    const id = setInterval(run, intervalMs);
    return () => clearInterval(id);
  }, [run, intervalMs]);

  return { data, error, loading, refresh: run };
}
