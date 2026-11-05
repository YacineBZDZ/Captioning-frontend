import type { ItemStatus } from '../../state/batch';
import { ITEM_STATUS_LABEL } from '../../state/batchDescribe';

const BUSY: ItemStatus[] = ['classifying', 'checking', 'cleaning', 'rechecking', 'captioning'];

export function ItemStatusPill({ status }: { status: ItemStatus }) {
  return (
    <span className="ipill" data-status={status} data-busy={BUSY.includes(status) || undefined}>
      <span className="ipill-dot" aria-hidden="true" />
      {ITEM_STATUS_LABEL[status]}
    </span>
  );
}
