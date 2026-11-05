import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  checkHealth,
  DEFAULT_INFO,
  fetchInfo,
  type ApiClient,
  type ServerInfo,
} from '../api/client';
import { HealthMonitor } from '../state/health';

/** Server status (polled /health) plus /v1/info, fetched once on first "online". */
export function useServerStatus(api: ApiClient) {
  const monitor = useMemo(() => new HealthMonitor(() => checkHealth(api)), [api]);
  const snapshot = useSyncExternalStore(monitor.subscribe, monitor.getSnapshot);
  const [info, setInfo] = useState<ServerInfo>(DEFAULT_INFO);
  const [infoLoaded, setInfoLoaded] = useState(false);
  /** True once /v1/info has answered (or failed and fallen back to defaults). */
  const [infoReady, setInfoReady] = useState(false);

  useEffect(() => {
    monitor.start(document.visibilityState === 'hidden');
    const onVisibility = () => monitor.setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      monitor.stop();
    };
  }, [monitor]);

  useEffect(() => {
    if (snapshot.status !== 'online' || infoLoaded) return;
    setInfoLoaded(true);
    const controller = new AbortController();
    void fetchInfo(api, controller.signal).then((i) => {
      if (controller.signal.aborted) return;
      setInfo(i);
      setInfoReady(true);
    });
    // Not aborted on cleanup on purpose: it is fetched once and must land.
  }, [api, snapshot.status, infoLoaded]);

  /** Re-reads /v1/info (e.g. after the server refused a batch as too large). */
  const refreshInfo = useCallback(async () => {
    const i = await fetchInfo(api);
    setInfo(i);
    setInfoReady(true);
    return i;
  }, [api]);

  return { ...snapshot, info, infoReady, refreshInfo, monitor };
}
