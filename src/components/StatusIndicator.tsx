import { useEffect, useState } from 'react';
import { formatClock, formatTime } from '../format';
import type { HealthSnapshot, ServerStatus } from '../state/health';

const STATUS_TEXT: Record<ServerStatus, string> = {
  checking: 'Checking…',
  online: 'Online',
  starting: 'Starting',
  offline: 'Offline',
};

function useNow(active: boolean, intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

interface Props {
  health: HealthSnapshot;
  onWake: () => void;
}

export function StatusIndicator({ health, onWake }: Props) {
  const { status, lastChecked, waking, wakeFailed } = health;
  const now = useNow(waking !== null);
  const elapsed = waking ? (now - waking.startedAt) / 1000 : 0;

  return (
    <div className="status" data-status={status}>
      <div className="status-line">
        <span className="pill" data-status={status}>
          <span className="pill-dot" aria-hidden="true" />
          <span>
            <span className="sr-only">Server status: </span>
            {STATUS_TEXT[status]}
          </span>
        </span>
        {lastChecked !== null && (
          <span className="status-checked">
            checked{' '}
            <time dateTime={new Date(lastChecked).toISOString()}>{formatTime(lastChecked)}</time>
          </span>
        )}
      </div>

      {status === 'starting' && <p className="status-note">Models are loading.</p>}

      {status === 'offline' && (
        <div className="status-note">
          <p>Offline or asleep. Free servers sleep after a period of inactivity.</p>
          {waking ? (
            <p className="status-waking" role="timer" aria-live="off">
              <span className="spinner" aria-hidden="true" /> Waking up… {formatClock(elapsed)}
            </p>
          ) : (
            <>
              <button type="button" className="btn btn-small" onClick={onWake}>
                Wake up server
              </button>
              {wakeFailed && (
                <p className="status-fail">It did not wake up within 3 minutes. Try again later.</p>
              )}
            </>
          )}
        </div>
      )}
      {status === 'starting' && waking && (
        <p className="status-waking">
          <span className="spinner" aria-hidden="true" /> Waking up… {formatClock(elapsed)}
        </p>
      )}
    </div>
  );
}
