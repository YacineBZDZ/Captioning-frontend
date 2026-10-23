import type { ServerInfo } from '../api/client';
import {
  STEP_IDS,
  type CaptioningData,
  type ClassificationData,
  type DenoisingData,
  type QualityData,
  type StepId,
} from '../api/types';
import { formatMs } from '../format';
import { isProvisionalNonPhoto, STATUS_LABEL, STEP_META, stepSummary } from '../state/describe';
import type { RunState, StepState } from '../state/pipeline';
import { BeforeAfter } from './BeforeAfter';
import { ProbabilityBars } from './ProbabilityBars';

interface Props {
  run: RunState;
  info: ServerInfo;
  originalUrl?: string;
  originalAspect?: number;
}

function StatusIcon({ status }: { status: StepState['status'] }) {
  switch (status) {
    case 'done':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 8.5l2.5 2.5L12 5.5" />
        </svg>
      );
    case 'error':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5 5l6 6M11 5l-6 6" />
        </svg>
      );
    case 'skipped':
    case 'not_needed':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.5 8h7" />
        </svg>
      );
    default:
      return null;
  }
}

function QualityDetails({ data, info }: { data: QualityData; info: ServerInfo }) {
  const badges: { key: string; label: string; on: boolean }[] = [
    { key: 'clean', label: 'Clean', on: !data.is_noisy && !data.is_blurry },
    { key: 'noisy', label: 'Noisy', on: data.is_noisy },
    { key: 'blurry', label: 'Blurry', on: data.is_blurry },
  ];
  const calibrated = data.calibrated ?? info.calibrated;
  return (
    <div className="quality">
      <ul className="badges" aria-label="Quality">
        {badges.map((b) => (
          <li key={b.key} className="badge" data-on={b.on || undefined} data-kind={b.key}>
            {b.on ? '● ' : '○ '}
            {b.label}
            <span className="sr-only">{b.on ? ': yes' : ': no'}</span>
          </li>
        ))}
      </ul>
      <dl className="measures">
        <div>
          <dt>Noise level σ</dt>
          <dd>
            <span className="num">{data.noise_sigma.toFixed(3)}</span>
            <span className="threshold">
              {data.is_noisy ? '>' : '≤'} {data.thresholds.noise_sigma}
            </span>
          </dd>
        </div>
        <div>
          <dt>Sharpness</dt>
          <dd>
            <span className="num">{data.sharpness.toFixed(1)}</span>
            <span className="threshold">
              {data.is_blurry ? '<' : '≥'} {data.thresholds.sharpness}
            </span>
          </dd>
        </div>
      </dl>
      {calibrated === false && <p className="note">Thresholds not calibrated yet.</p>}
    </div>
  );
}

function StepDetails(props: { id: StepId; step: StepState } & Omit<Props, 'run'>) {
  const { id, step, info, originalUrl, originalAspect } = props;
  if (
    !step.data ||
    (step.status !== 'done' && step.status !== 'skipped' && step.status !== 'error')
  )
    return null;
  switch (id) {
    case 'classification':
    case 'reclassification': {
      const d = step.data as ClassificationData;
      const tone = step.status === 'error' ? 'error' : d.is_photo ? 'accent' : 'warn';
      return (
        <ProbabilityBars
          probabilities={d.probabilities}
          predicted={d.predicted_class}
          classes={info.classes}
          tone={tone}
          label={`Class probabilities${d.input === 'denoised' ? ' (denoised image)' : ''}`}
        />
      );
    }
    case 'quality':
      return <QualityDetails data={step.data as QualityData} info={info} />;
    case 'denoising': {
      const d = step.data as DenoisingData;
      if (!d.applied) return null;
      return (
        <BeforeAfter
          original={originalUrl}
          denoised={d.image}
          width={d.width}
          height={d.height}
          aspect={originalAspect}
        />
      );
    }
    case 'captioning': {
      const d = step.data as CaptioningData;
      return (
        <p className="step-caption-meta">
          {d.decoding === 'beam'
            ? `Beam search${d.beam_width ? ` (width ${d.beam_width})` : ''}`
            : 'Greedy decoding'}
          {' · '}
          on the {d.input === 'denoised' ? 'denoised' : 'original'} image
        </p>
      );
    }
    default:
      return null;
  }
}

export function Timeline({ run, info, originalUrl, originalAspect }: Props) {
  const visible = STEP_IDS.filter(
    (id) =>
      id !== 'reclassification' ||
      !['pending', 'not_needed'].includes(run.steps.reclassification.status),
  );
  return (
    <ol className="timeline" aria-label="Analysis steps">
      {visible.map((id) => {
        const step = run.steps[id];
        const meta = STEP_META[id];
        const provisional =
          (id === 'classification' || id === 'reclassification') &&
          isProvisionalNonPhoto(step, run.phase);
        const failed = step.status === 'error';
        return (
          <li
            key={id}
            className="step"
            data-status={step.status}
            data-warn={provisional || undefined}
            aria-current={step.status === 'running' ? 'step' : undefined}
          >
            <span className="step-marker" aria-hidden="true">
              <StatusIcon status={step.status} />
            </span>
            <div className="step-body">
              <div className="step-head">
                <h3 className="step-title">{meta.title}</h3>
                {meta.model && <span className="tag">{meta.model(info)}</span>}
                <span className="step-state">
                  {failed ? 'Failed here' : provisional ? 'Checking' : STATUS_LABEL[step.status]}
                </span>
                <span className="step-time">{formatMs(step.elapsedMs)}</span>
              </div>
              <p className="step-summary">{stepSummary(id, step, run.phase)}</p>
              <StepDetails
                id={id}
                step={step}
                info={info}
                originalUrl={originalUrl}
                originalAspect={originalAspect}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
