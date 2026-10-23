import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiClient, ProcessOptions } from './api/client';
import { STEP_IDS, type StepId } from './api/types';
import { ErrorAlert } from './components/ErrorAlert';
import { HowItWorks } from './components/HowItWorks';
import { ResultCard } from './components/ResultCard';
import { StatusIndicator } from './components/StatusIndicator';
import { Timeline } from './components/Timeline';
import { UploadPanel, type Selection } from './components/UploadPanel';
import { useAnnouncer } from './hooks/useAnnouncer';
import { usePipeline } from './hooks/usePipeline';
import { useServerStatus } from './hooks/useServerStatus';
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

function analyseBlocker(status: ServerStatus, hasFile: boolean): string | null {
  if (status === 'checking') return 'Checking whether the server is available…';
  if (status === 'starting') return 'The server is starting: models are loading. Please wait.';
  if (status === 'offline') return 'The server is offline or asleep. Use “Wake up server” above.';
  if (!hasFile) return 'Choose an image first.';
  return null;
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
  const { messages, announce } = useAnnouncer();
  const [selection, setSelection] = useState<Selection | null>(null);
  /** The image the current/last run was made with (outlives the selection). */
  const [runImage, setRunImage] = useState<Selection | null>(null);
  const [options, setOptions] = useState<ProcessOptions>({ denoise: 'auto', decoding: 'beam' });
  const [autoRetry, setAutoRetry] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { status, monitor } = server;

  useObjectUrlJanitor([selection?.url, runImage?.url]);
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

  const running = run.phase === 'running';
  const runWith = useCallback(
    (sel: Selection) => {
      setRunImage(sel);
      setAutoRetry(false);
      void start(sel.file, options);
    },
    [start, options],
  );

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

  const blocker = running ? null : analyseBlocker(status, selection !== null);
  const canAnalyse = !running && blocker === null && selection !== null;

  function chooseAnother() {
    setSelection(null);
    // Focus the file chooser so the keyboard user lands in the right place.
    requestAnimationFrame(() => fileInputRef.current?.focus());
  }

  function processAnother() {
    reset();
    setRunImage(null);
    chooseAnother();
  }

  const shownImage = runImage ?? selection;
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
            Upload a photograph. Three small neural networks check that it is a photo, clean it if
            it is noisy, and describe it in one English sentence. You can watch each step as it
            runs.
          </p>
        </div>

        <UploadPanel
          info={server.info}
          selection={selection}
          onSelect={(file) => setSelection({ file, url: URL.createObjectURL(file) })}
          onClear={() => setSelection(null)}
          onDimensions={(width, height) =>
            setSelection((s) =>
              s && (s.width !== width || s.height !== height) ? { ...s, width, height } : s,
            )
          }
          options={options}
          onOptions={setOptions}
          running={running}
          canAnalyse={canAnalyse}
          reason={blocker}
          onAnalyse={() => selection && runWith(selection)}
          onCancel={cancel}
          fileInputRef={fileInputRef}
        />

        <section className="panel pipeline" aria-labelledby="pipeline-title">
          <div className="pipeline-head">
            <h2 id="pipeline-title" className="eyebrow">
              2 · Pipeline
            </h2>
            {run.started && (
              <p className="pipeline-meta num">
                request <code>{run.started.request_id}</code>
              </p>
            )}
          </div>

          {run.phase === 'idle' && (
            <p className="pipeline-empty">
              The steps will appear here, live, once you press <strong>Analyse</strong>.
            </p>
          )}
          {run.phase === 'cancelled' && <p className="pipeline-note">Analysis cancelled.</p>}

          {run.error && (
            <ErrorAlert
              error={run.error}
              info={server.info}
              onChooseAnother={chooseAnother}
              onRetry={() => runImage && runWith(runImage)}
            />
          )}

          {run.phase === 'success' && run.result && (
            <ResultCard
              result={run.result}
              originalUrl={runImage?.url}
              denoisedUrl={denoisedImage(run)}
              aspect={aspect}
              fallbackTimings={fallbackTimings}
              onAnother={processAnother}
            />
          )}

          {run.phase !== 'idle' && (
            <Timeline
              run={run}
              info={server.info}
              originalUrl={runImage?.url}
              originalAspect={aspect}
            />
          )}
        </section>

        <HowItWorks info={server.info} />
      </main>

      <footer className="site-footer">
        <p>
          <strong>Privacy.</strong> Your image is sent only to the analysis server, processed in
          memory and not kept. This page uses no cookies, no analytics and stores nothing in your
          browser.
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
