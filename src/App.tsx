import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ApiClient, ProcessOptions } from './api/client';
import { STEP_IDS, type StepId } from './api/types';
import { BatchView } from './components/batch/BatchView';
import { ErrorAlert } from './components/ErrorAlert';
import { HowItWorks } from './components/HowItWorks';
import { ResultCard } from './components/ResultCard';
import { StatusIndicator } from './components/StatusIndicator';
import { Timeline } from './components/Timeline';
import { UploadPanel } from './components/UploadPanel';
import { useAnnouncer } from './hooks/useAnnouncer';
import { useBatchRun } from './hooks/useBatchRun';
import { usePipeline } from './hooks/usePipeline';
import { useServerStatus } from './hooks/useServerStatus';
import { useThrottledAnnounce } from './hooks/useThrottledAnnounce';
import { toSelected, type SelectedFile } from './selection';
import { isRetryable, type BatchState } from './state/batch';
import { smallerLimits, splitIntoGroups, splitLimits, type SplitLimits } from './state/batchSplit';
import { STEP_META, stepSummary } from './state/describe';
import type { ServerStatus } from './state/health';
import { denoisedImage, type RunState } from './state/pipeline';

interface Props {
  api: ApiClient;
  /** Dev-only tools (mock scenario picker), injected by main.tsx. */
  devPanel?: ReactNode;
}

const STATUS_ANNOUNCEMENT: Record<ServerStatus, string> = {
  checking: '',
  online: 'Server is online.',
  starting: 'Server is starting. Models are loading.',
  offline: 'Server is offline or asleep.',
};

function analyseBlocker(
  status: ServerStatus,
  count: number,
  batchSupported: boolean | null,
): string | null {
  if (status === 'checking') return 'Checking whether the server is available…';
  if (status === 'starting') return 'The server is starting: models are loading. Please wait.';
  if (status === 'offline') return 'The server is offline or asleep. Use “Wake up server” above.';
  if (count === 0) return 'Choose an image first.';
  if (count > 1 && batchSupported === null) return 'Reading the server limits…';
  if (count > 1 && batchSupported === false)
    return 'This server handles one image at a time. Remove the extra images.';
  return null;
}

/** The group that failed at batch level, for "Retry with smaller groups". */
function failedGroupSize(state: BatchState) {
  const g = state.groups.find((x) => x.status === 'failed');
  const items = (g?.indices ?? []).map((i) => state.items[i]!).filter(Boolean);
  return { count: items.length, bytes: items.reduce((n, i) => n + i.bytes, 0) };
}

/** Keeps object URLs alive while they are shown, and revokes them afterwards. */
function useObjectUrlJanitor(live: (string | undefined)[]) {
  const all = useRef(new Set<string>());
  const key = live.join('|');
  useEffect(() => {
    const keep = new Set(key.split('|').filter(Boolean));
    keep.forEach((u) => all.current.add(u));
    for (const u of all.current) {
      if (!keep.has(u)) {
        URL.revokeObjectURL(u);
        all.current.delete(u);
      }
    }
  }, [key]);
  useEffect(() => {
    const urls = all.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);
}

function useRunAnnouncements(run: RunState, announce: (t: string) => void) {
  const prev = useRef<RunState | null>(null);
  useEffect(() => {
    const before = prev.current;
    prev.current = run;
    if (!before || before === run) return;
    for (const id of STEP_IDS) {
      const was = before.steps[id].status;
      const now = run.steps[id].status;
      if (was === now) continue;
      const title = STEP_META[id].title;
      if (now === 'running') announce(`${title}…`);
      else if (now === 'done' || now === 'skipped')
        announce(`${title}: ${stepSummary(id, run.steps[id], run.phase)}`);
    }
    if (before.phase !== run.phase) {
      if (run.phase === 'success' && run.result) announce(`Done. Caption: ${run.result.caption}`);
      if (run.phase === 'cancelled') announce('Analysis cancelled.');
    }
  }, [run, announce]);
}

export default function App({ api, devPanel }: Props) {
  const server = useServerStatus(api);
  const { state: run, start, cancel, reset } = usePipeline(api);
  const batch = useBatchRun(api);
  const { messages, announce } = useAnnouncer();
  const announceBatch = useThrottledAnnounce(announce, 2000);
  const [files, setFiles] = useState<SelectedFile[]>([]);
  /** The image the current/last single run was made with (outlives the selection). */
  const [runImage, setRunImage] = useState<SelectedFile | null>(null);
  /** Which view the pipeline panel shows: the last run started decides. */
  const [view, setView] = useState<'single' | 'batch'>('single');
  const [options, setOptions] = useState<ProcessOptions>({ denoise: 'auto', decoding: 'beam' });
  const [autoRetry, setAutoRetry] = useState(false);
  const [batchAutoRetry, setBatchAutoRetry] = useState(false);
  /** Limits forced by "Retry with smaller groups", until the next new batch. */
  const [limitsOverride, setLimitsOverride] = useState<SplitLimits | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { status, monitor, info, infoReady } = server;
  const batchSupported = infoReady ? info.batch !== null : null;
  const limits = useMemo(
    () =>
      limitsOverride ??
      (info.batch ? splitLimits(info.batch) : { maxImages: 1, maxTotalBytes: Infinity }),
    [info.batch, limitsOverride],
  );

  useObjectUrlJanitor([
    ...files.map((f) => f.url),
    runImage?.url,
    ...batch.state.items.map((i) => i.url),
  ]);
  useRunAnnouncements(run, announce);

  // Announce server status changes (not the initial "checking").
  const lastStatus = useRef<ServerStatus>('checking');
  useEffect(() => {
    if (status === lastStatus.current) return;
    const wasOffline = lastStatus.current === 'offline' || lastStatus.current === 'starting';
    lastStatus.current = status;
    if (status === 'online' && wasOffline) announce('The server is awake and online.');
    else if (STATUS_ANNOUNCEMENT[status]) announce(STATUS_ANNOUNCEMENT[status]);
  }, [status, announce]);

  const singleRunning = run.phase === 'running';
  const batchRunning = batch.state.phase === 'running';
  const running = singleRunning || batchRunning;
  const runWith = useCallback(
    (sel: SelectedFile) => {
      setView('single');
      setRunImage(sel);
      setAutoRetry(false);
      void start(sel.file, options);
    },
    [start, options],
  );

  const startBatch = useCallback(() => {
    setView('batch');
    setLimitsOverride(null);
    setBatchAutoRetry(false);
    const base = info.batch ? splitLimits(info.batch) : limits;
    void batch.start(
      files.map((f) => ({ id: f.id, file: f.file, url: f.url })),
      options,
      base,
    );
  }, [batch, files, info.batch, limits, options]);

  const retryBatch = useCallback(
    (override?: SplitLimits) => {
      setBatchAutoRetry(false);
      void batch.retry(options, override ?? limits);
    },
    [batch, options, limits],
  );

  const retrySmaller = useCallback(async () => {
    const fresh = await server.refreshInfo();
    const base = fresh.batch ? splitLimits(fresh.batch) : limits;
    const next = smallerLimits(base, batch.state.error?.details, failedGroupSize(batch.state));
    setLimitsOverride(next);
    retryBatch(next);
  }, [server, limits, batch.state, retryBatch]);

  // React to errors that involve the server state.
  const errorCode = run.error?.code;
  useEffect(() => {
    if (errorCode === 'MODEL_NOT_READY') {
      monitor.markStarting();
      setAutoRetry(true);
    } else if (errorCode === 'SERVER_OFFLINE' || errorCode === 'CONNECTION_LOST') {
      monitor.checkNow();
    }
  }, [errorCode, run.error, monitor]);

  // MODEL_NOT_READY: send the same image again once the server is online.
  useEffect(() => {
    if (autoRetry && status === 'online' && runImage && !running) runWith(runImage);
  }, [autoRetry, status, runImage, running, runWith]);

  // The same for a batch: only the unfinished images are sent again.
  const batchErrorCode = batch.state.error?.code;
  useEffect(() => {
    if (batchErrorCode === 'MODEL_NOT_READY') {
      monitor.markStarting();
      setBatchAutoRetry(true);
    } else if (batchErrorCode === 'SERVER_OFFLINE' || batchErrorCode === 'CONNECTION_LOST') {
      monitor.checkNow();
    }
  }, [batchErrorCode, batch.state.error, monitor]);

  useEffect(() => {
    if (batchAutoRetry && status === 'online' && !running && batch.state.items.some(isRetryable))
      retryBatch();
  }, [batchAutoRetry, status, running, batch.state.items, retryBatch]);

  const blocker = running ? null : analyseBlocker(status, files.length, batchSupported);
  const canAnalyse = !running && blocker === null && files.length > 0;
  const groupCount =
    files.length > 1 && info.batch
      ? splitIntoGroups(files, (f) => f.file.size, splitLimits(info.batch)).length
      : 1;

  function chooseAnother() {
    setFiles([]);
    // Focus the file chooser so the keyboard user lands in the right place.
    requestAnimationFrame(() => fileInputRef.current?.focus());
  }

  function processAnother() {
    reset();
    setRunImage(null);
    chooseAnother();
  }

  function processOtherImages() {
    batch.reset();
    setLimitsOverride(null);
    chooseAnother();
  }

  function analyse() {
    if (files.length === 1) runWith(files[0]!);
    else if (files.length > 1) startBatch();
  }

  const shownImage = runImage ?? files[0];
  const aspect =
    shownImage?.width && shownImage?.height ? shownImage.width / shownImage.height : undefined;
  const fallbackTimings: Partial<Record<StepId, number>> = {};
  for (const id of STEP_IDS) {
    const ms = run.steps[id].elapsedMs;
    if (ms !== undefined && run.steps[id].status === 'done') fallbackTimings[id] = ms;
  }

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="brand">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
            <circle cx="16" cy="16" r="13" />
            <circle cx="16" cy="16" r="5" />
            <path d="M16 1v6M16 25v6M1 16h6M25 16h6" />
          </svg>
          <div>
            <p className="brand-name">Caption Bench</p>
            <p className="brand-sub">photo check · denoise · caption</p>
          </div>
        </div>
        <StatusIndicator health={server} onWake={() => monitor.wake()} />
      </header>

      <main id="main" className="layout">
        <div className="intro">
          <h1>What is in this photo?</h1>
          <p>
            Upload one photograph or many. Three small neural networks check that each is a photo,
            clean it if it is noisy, and describe it in one English sentence. You can watch each
            step as it runs.
          </p>
        </div>

        <UploadPanel
          info={info}
          batchSupported={batchSupported}
          files={files}
          onAdd={(added) => setFiles((current) => [...current, ...added.map(toSelected)])}
          onReplace={(file) => setFiles([toSelected(file)])}
          onRemove={(id) => setFiles((current) => current.filter((f) => f.id !== id))}
          onClearAll={() => setFiles([])}
          onDimensions={(id, width, height) =>
            setFiles((current) =>
              current.map((f) =>
                f.id === id && (f.width !== width || f.height !== height)
                  ? { ...f, width, height }
                  : f,
              ),
            )
          }
          groups={groupCount}
          options={options}
          onOptions={setOptions}
          running={running}
          canAnalyse={canAnalyse}
          reason={blocker}
          onAnalyse={analyse}
          onCancel={batchRunning ? batch.cancel : cancel}
          fileInputRef={fileInputRef}
        />

        <section className="panel pipeline" aria-labelledby="pipeline-title">
          <div className="pipeline-head">
            <h2 id="pipeline-title" className="eyebrow">
              {view === 'batch' ? `2 · Results` : '2 · Pipeline'}
            </h2>
            {view === 'single' && run.started && (
              <p className="pipeline-meta num">
                request <code>{run.started.request_id}</code>
              </p>
            )}
          </div>

          {view === 'batch' && batch.state.phase !== 'idle' && (
            <BatchView
              state={batch.state}
              info={info}
              onCancel={batch.cancel}
              onRetry={() => retryBatch()}
              onRetrySmaller={() => void retrySmaller()}
              onAnother={processOtherImages}
              announce={announceBatch}
            />
          )}

          {view === 'single' && run.phase === 'idle' && (
            <p className="pipeline-empty">
              The steps will appear here, live, once you press <strong>Analyse</strong>.
            </p>
          )}
          {view === 'batch' && batch.state.phase === 'idle' && (
            <p className="pipeline-empty">
              The results will appear here, live, once you press <strong>Analyse</strong>.
            </p>
          )}

          {view === 'single' && run.phase === 'cancelled' && (
            <p className="pipeline-note">Analysis cancelled.</p>
          )}

          {view === 'single' && run.error && (
            <ErrorAlert
              error={run.error}
              info={info}
              onChooseAnother={chooseAnother}
              onRetry={() => runImage && runWith(runImage)}
            />
          )}

          {view === 'single' && run.phase === 'success' && run.result && (
            <ResultCard
              result={run.result}
              originalUrl={runImage?.url}
              denoisedUrl={denoisedImage(run)}
              aspect={aspect}
              fallbackTimings={fallbackTimings}
              onAnother={processAnother}
            />
          )}

          {view === 'single' && run.phase !== 'idle' && (
            <Timeline run={run} info={info} originalUrl={runImage?.url} originalAspect={aspect} />
          )}
        </section>

        <HowItWorks info={info} />
      </main>

      <footer className="site-footer">
        <p>
          <strong>Privacy.</strong> Your images are held in this page&rsquo;s memory only and sent
          to the analysis server for processing, which does not keep them. This page uses no
          cookies, no analytics and stores nothing in your browser.
        </p>
        {server.version && <p className="num">backend v{server.version}</p>}
      </footer>

      <div className="sr-only" aria-live="polite" aria-atomic="false" aria-relevant="additions">
        {messages.map((m) => (
          <p key={m.id}>{m.text}</p>
        ))}
      </div>
      {devPanel}
    </>
  );
}
