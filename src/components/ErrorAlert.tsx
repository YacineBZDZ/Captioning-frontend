import { useEffect, useRef } from 'react';
import type { ServerInfo } from '../api/client';
import { describeError, type AppError } from '../api/errors';
import { useCountdown } from '../hooks/useCountdown';
import { ProbabilityBars } from './ProbabilityBars';

interface Props {
  error: AppError;
  info: ServerInfo;
  onChooseAnother: () => void;
  onRetry: () => void;
}

export function ErrorAlert({ error, info, onChooseAnother, onRetry }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const d = describeError(error, {
    maxUploadMb: info.maxUploadMb,
    allowedTypes: info.allowedTypes,
  });
  const wait = useCountdown(error.code === 'SERVER_BUSY' ? error.retryAfterS : undefined, error);
  const isNotAPhoto = error.code === 'NOT_A_PHOTO';
  const probabilities = error.details?.probabilities;
  const predicted = error.details?.predicted_class;
  const showServerMessage =
    !!error.serverMessage &&
    !isNotAPhoto &&
    error.code !== 'INTERNAL_ERROR' &&
    error.serverMessage !== d.message;

  useEffect(() => {
    ref.current?.focus();
  }, [error]);

  return (
    <div
      ref={ref}
      className="alert"
      data-kind={isNotAPhoto ? 'not-a-photo' : 'error'}
      role="alert"
      tabIndex={-1}
      aria-labelledby="alert-title"
    >
      <h2 id="alert-title" className="alert-title">
        {d.title}
      </h2>
      <p className="alert-message">{d.message}</p>
      {showServerMessage && <p className="alert-detail">Server said: {error.serverMessage}</p>}

      {isNotAPhoto && typeof probabilities === 'object' && probabilities !== null && (
        <ProbabilityBars
          probabilities={probabilities as Record<string, number>}
          predicted={typeof predicted === 'string' ? predicted : ''}
          classes={info.classes}
          tone="error"
        />
      )}

      {error.requestId && (
        <p className="alert-detail">
          Request ID: <code>{error.requestId}</code>
        </p>
      )}

      <div className="alert-actions">
        {d.action === 'choose_another' && (
          <button type="button" className="btn btn-primary" onClick={onChooseAnother}>
            {d.actionLabel}
          </button>
        )}
        {d.action === 'retry' && (
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            {d.actionLabel}
          </button>
        )}
        {d.action === 'retry_after' && (
          <button type="button" className="btn btn-primary" onClick={onRetry} disabled={wait > 0}>
            {wait > 0 ? `Retry in ${wait} s` : 'Retry'}
          </button>
        )}
        {d.action === 'wait_for_server' && (
          <p className="alert-detail">
            <span className="spinner" aria-hidden="true" /> Waiting for the server…
          </p>
        )}
        {d.action !== 'choose_another' && (
          <button type="button" className="btn" onClick={onChooseAnother}>
            Choose another image
          </button>
        )}
      </div>
    </div>
  );
}
