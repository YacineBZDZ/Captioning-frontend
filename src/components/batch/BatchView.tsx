import { useEffect, useRef, useState } from 'react';
import type { ServerInfo } from '../../api/client';
import { STAGE_IDS } from '../../api/types';
import { formatClock, formatMs } from '../../format';
import {
  itemStatus,
  processedCount,
  stageCounts,
  summarise,
  type BatchItem,
  type BatchState,
  type StripStage,
} from '../../state/batch';
import { STAGE_FINISHED, summaryText } from '../../state/batchDescribe';
import { captionsText, downloadText, toCsv, toJson } from '../../state/batchExport';
import { BatchAlert } from './BatchAlert';
import { BatchCard } from './BatchCard';
import { BatchDialog } from './BatchDialog';
import { CopyButton } from './CopyButton';
import { StageStrip } from './StageStrip';

type Filter = 'all' | 'captioned' | 'not_photo' | 'errors';

const FILTERS: { id: Filter; label: string; test: (i: BatchItem) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'captioned', label: 'Captioned', test: (i) => i.outcome === 'done' },
  { id: 'not_photo', label: 'Not a photo', test: (i) => i.outcome === 'not_a_photo' },
  {
    id: 'errors',
    label: 'Errors',
    test: (i) => i.outcome === 'error' || i.outcome === 'interrupted' || i.outcome === 'cancelled',
  },
];

interface Props {
  state: BatchState;
  info: ServerInfo;
  onCancel: () => void;
  onRetry: () => void;
  onRetrySmaller: () => void;
  onAnother: () => void;
  /** Throttled polite announcer. */
  announce: (text: string) => void;
}

function useTick(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function useBatchAnnouncements(state: BatchState, announce: (t: string) => void) {
  const prev = useRef<BatchState | null>(null);
  useEffect(() => {
    const before = prev.current;
    prev.current = state;
    if (!before || before === state) return;
    const total = state.items.length;
    const groupNote =
      state.groups.length > 1 && state.currentGroup !== null
        ? ` (group ${state.currentGroup + 1} of ${state.groups.length})`
        : '';
    for (const stage of STAGE_IDS) {
      if (before.activeStages.includes(stage) && !state.activeStages.includes(stage))
        announce(`${STAGE_FINISHED[stage]}${groupNote}`);
    }
    const captions = (s: BatchState) => s.items.filter((i) => i.outcome === 'done').length;
    if (state.phase === 'running' && captions(state) > captions(before))
      announce(`${captions(state)} of ${total} captions ready`);
    if (before.phase === 'running' && state.phase === 'finished')
      announce(`All done: ${summaryText(summarise(state))}`);
    if (before.phase === 'running' && state.phase === 'cancelled')
      announce(`Cancelled: ${summaryText(summarise(state))}`);
  }, [state, announce]);
}

export function BatchView({
  state,
  info,
  onCancel,
  onRetry,
  onRetrySmaller,
  onAnother,
  announce,
}: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<number | null>(null);
  const running = state.phase === 'running';
  const now = useTick(running);
  useBatchAnnouncements(state, announce);

  // A new run (or retry) shows everything again.
  useEffect(() => {
    if (running) setFilter('all');
  }, [running, state.startedAt]);

  const summary = summarise(state);
  const counts = stageCounts(state);
  const done = processedCount(state);
  const total = state.items.length;
  const elapsed =
    state.elapsedBeforeMs +
    (state.startedAt === undefined ? 0 : (state.finishedAt ?? now) - state.startedAt);
  const ended = state.phase === 'finished' || state.phase === 'cancelled';
  const ctx = { maxUploadMb: info.maxUploadMb, allowedTypes: info.allowedTypes };
  const active: StripStage[] = running
    ? state.currentGroup !== null &&
      state.items.some(
        (i) =>
          i.group === state.currentGroup &&
          i.run.steps.validation.status === 'pending' &&
          !i.outcome,
      )
      ? ['upload', ...state.activeStages]
      : state.activeStages
    : [];
  const visible = ended
    ? state.items.filter(FILTERS.find((f) => f.id === filter)!.test)
    : state.items;
  const openItem = open === null ? undefined : state.items[open];

  return (
    <div className="batch">
      {state.error && ended && (
        <BatchAlert
          error={state.error}
          info={info}
          retryable={summary.retryable}
          onRetry={onRetry}
          onRetrySmaller={onRetrySmaller}
        />
      )}

      <StageStrip counts={counts} total={total} active={active} />

      {running ? (
        <div className="bprogress">
          <div className="bprogress-line">
            <label className="bprogress-label" htmlFor="batch-progress">
              {done} of {total} processed
              {state.groups.length > 1 && state.currentGroup !== null && (
                <span className="bprogress-group">
                  {' '}
                  · Group {state.currentGroup + 1} of {state.groups.length}
                </span>
              )}
            </label>
            <span className="num bprogress-time">{formatClock(elapsed / 1000)}</span>
          </div>
          <progress id="batch-progress" max={total} value={done} />
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="bsummary">
          <p className="bsummary-text">
            <strong>
              {state.phase === 'cancelled' ? 'Cancelled: ' : ''}
              {summaryText(summary)}
            </strong>
            <span className="num bsummary-time"> · {formatMs(elapsed)} total</span>
          </p>
          <div className="bactions">
            {summary.captioned > 0 && (
              <CopyButton
                text={captionsText(state.items)}
                label="Copy all captions"
                className="btn"
              />
            )}
            <button
              type="button"
              className="btn"
              onClick={() =>
                downloadText(toCsv(state.items), 'captions.csv', 'text/csv;charset=utf-8')
              }
            >
              Download CSV
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => downloadText(toJson(state.items), 'captions.json', 'application/json')}
            >
              Download JSON
            </button>
            {summary.retryable > 0 && (
              <button type="button" className="btn" onClick={onRetry}>
                Retry failed ({summary.retryable})
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={onAnother}>
              Process other images
            </button>
          </div>
          <div className="chips" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className="chip"
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
              >
                {f.label} <span className="num">{state.items.filter(f.test).length}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <ul className="bgrid" aria-label="Images">
        {visible.map((item) => (
          <BatchCard
            key={item.id}
            item={item}
            status={itemStatus(item, state)}
            ctx={ctx}
            onOpen={() => setOpen(item.index)}
          />
        ))}
      </ul>
      {ended && visible.length === 0 && <p className="pipeline-note">No image in this category.</p>}

      {openItem && (
        <BatchDialog
          item={openItem}
          status={itemStatus(openItem, state)}
          info={info}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
