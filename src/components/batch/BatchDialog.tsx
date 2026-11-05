import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import type { ServerInfo } from '../../api/client';
import type { BatchItem, ItemStatus } from '../../state/batch';
import { itemMessage } from '../../state/batchDescribe';
import { Timeline } from '../Timeline';
import { CopyButton } from './CopyButton';
import { ItemStatusPill } from './ItemStatusPill';

interface Props {
  item: BatchItem;
  status: ItemStatus;
  info: ServerInfo;
  onClose: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal details of one image: the same timeline as the single-image view.
 * Focus is trapped inside, Esc closes, and focus returns where it was.
 */
export function BatchDialog({ item, status, info, onClose }: Props) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const nodes = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (nodes.length === 0) return;
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const v = item.run.steps.validation.data;
  const aspect = v && v.width && v.height ? v.width / v.height : undefined;
  const caption = item.outcome === 'done' ? item.caption : undefined;
  const message = itemMessage(item, {
    maxUploadMb: info.maxUploadMb,
    allowedTypes: info.allowedTypes,
  });

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <div className="dialog-head">
          <h2 id={titleId} className="dialog-title" title={item.filename}>
            {item.filename}
          </h2>
          <ItemStatusPill status={status} />
          <button
            ref={closeRef}
            type="button"
            className="btn btn-quiet btn-small dialog-close"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="dialog-body">
          {caption && (
            <div className="dialog-caption">
              <p className="eyebrow">Caption</p>
              <p className="dialog-caption-text">{caption}</p>
              <CopyButton text={caption} />
            </div>
          )}
          {!caption && message && (
            <p className="dialog-message" data-status={status}>
              {message}
            </p>
          )}
          <Timeline run={item.run} info={info} originalUrl={item.url} originalAspect={aspect} />
        </div>
      </div>
    </div>
  );
}
