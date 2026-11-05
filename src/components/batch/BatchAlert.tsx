import { useEffect, useRef } from 'react';
import type { ServerInfo } from '../../api/client';
import { describeError, type AppError } from '../../api/errors';
import { useCountdown } from '../../hooks/useCountdown';

interface Props {
  error: AppError;
  info: ServerInfo;
  /** How many images can be sent again. */
  retryable: number;
  onRetry: () => void;
  onRetrySmaller: () => void;
}

/** A batch-level failure. Finished images are always kept. */
export function BatchAlert({ error, info, retryable, onRetry, onRetrySmaller }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const d = describeError(error, {
    maxUploadMb: info.maxUploadMb,
    allowedTypes: info.allowedTypes,
  });
  const wait = useCountdown(error.code === 'SERVER_BUSY' ? error.retryAfterS : undefined, error);

  useEffect(() => {
    ref.current?.focus();
  }, [error]);

  const what = `${retryable} unfinished ${retryable === 1 ? 'image' : 'images'}`;
  return (
    <div ref={ref} className="alert" role="alert" tabIndex={-1} aria-labelledby="batch-alert-title">
      <h2 id="batch-alert-title" className="alert-title">
        {d.title}
      </h2>
      <p className="alert-message">{d.message}</p>
      <p className="alert-detail">Images that were already finished are kept below.</p>
      {error.requestId && (
        <p className="alert-detail">
          Request ID: <code>{error.requestId}</code>
        </p>
      )}
      {retryable > 0 && (
        <div className="alert-actions">
          {d.action === 'retry_smaller' && (
            <button type="button" className="btn btn-primary" onClick={onRetrySmaller}>
              Retry with smaller groups
            </button>
          )}
          {d.action === 'retry_after' && (
            <button type="button" className="btn btn-primary" onClick={onRetry} disabled={wait > 0}>
              {wait > 0 ? `Retry in ${wait} s` : 'Retry'}
            </button>
          )}
          {d.action === 'wait_for_server' && (
            <p className="alert-detail">
              <span className="spinner" aria-hidden="true" /> Waiting for the server; the {what}{' '}
              will be sent again automatically.
            </p>
          )}
          {(d.action === 'retry' || d.action === 'choose_another' || d.action === 'none') && (
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              Retry {what}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
