import { forwardRef } from 'react';
import type { ErrorContext } from '../../api/errors';
import type { BatchItem, ItemStatus } from '../../state/batch';
import { classBadge, isDenoised, itemMessage } from '../../state/batchDescribe';
import { Thumb } from '../Thumb';
import { CopyButton } from './CopyButton';
import { ItemStatusPill } from './ItemStatusPill';

interface Props {
  item: BatchItem;
  status: ItemStatus;
  ctx: ErrorContext;
  onOpen: () => void;
}

/** One image of the batch. The main area is a button that opens the details. */
export const BatchCard = forwardRef<HTMLButtonElement, Props>(function BatchCard(
  { item, status, ctx, onOpen },
  ref,
) {
  const badge = classBadge(item);
  const message = itemMessage(item, ctx);
  const caption = item.outcome === 'done' ? item.caption : undefined;
  return (
    <li className="bcard" data-status={status}>
      <button
        ref={ref}
        type="button"
        className="bcard-main"
        aria-haspopup="dialog"
        onClick={onOpen}
      >
        <span className="bcard-thumb">
          <Thumb src={item.url} />
        </span>
        <span className="bcard-body">
          <span className="bcard-name" title={item.filename}>
            <span className="sr-only">Details for </span>
            {item.filename}
          </span>
          <span className="bcard-tags">
            <ItemStatusPill status={status} />
            {badge && <span className="tag">{badge}</span>}
            {isDenoised(item) && <span className="tag tag-accent">Denoised</span>}
          </span>
          <span className="bcard-text" data-kind={caption ? 'caption' : 'message'}>
            {caption ?? message ?? ''}
          </span>
        </span>
      </button>
      <div className="bcard-foot">
        {caption && (
          <CopyButton
            text={caption}
            className="btn btn-small btn-quiet"
            context={`caption of ${item.filename}`}
          />
        )}
      </div>
    </li>
  );
});
