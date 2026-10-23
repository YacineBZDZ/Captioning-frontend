import { useState } from 'react';
import type { ResultEvent, StepId } from '../api/types';
import { STEP_IDS } from '../api/types';
import { formatMs } from '../format';
import { STEP_META } from '../state/describe';

interface Props {
  result: ResultEvent;
  originalUrl?: string;
  denoisedUrl?: string;
  aspect?: number;
  fallbackTimings: Partial<Record<StepId, number>>;
  onAnother: () => void;
}

export function ResultCard({
  result,
  originalUrl,
  denoisedUrl,
  aspect,
  fallbackTimings,
  onAnother,
}: Props) {
  const [view, setView] = useState<'original' | 'denoised'>('original');
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const timings = { ...fallbackTimings, ...(result.timings_ms ?? {}) };
  const rows = STEP_IDS.filter((id) => timings[id] !== undefined);
  const total = result.total_ms ?? rows.reduce((sum, id) => sum + (timings[id] ?? 0), 0);
  const shown = view === 'denoised' && denoisedUrl ? denoisedUrl : originalUrl;

  async function copy() {
    try {
      await navigator.clipboard.writeText(result.caption);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
    setTimeout(() => setCopied('idle'), 2000);
  }

  return (
    <section className="result" aria-labelledby="result-title">
      <h2 id="result-title" className="eyebrow">
        Caption
      </h2>
      <p className="result-caption">{result.caption}</p>
      <div className="result-actions">
        <button type="button" className="btn" onClick={copy}>
          {copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Copy failed' : 'Copy'}
        </button>
        <button type="button" className="btn btn-primary" onClick={onAnother}>
          Process another image
        </button>
        <span className="sr-only" aria-live="polite">
          {copied === 'ok' ? 'Caption copied to clipboard' : ''}
        </span>
      </div>

      <div className="result-grid">
        {shown && (
          <figure className="result-figure">
            {denoisedUrl && (
              <div className="segmented" role="radiogroup" aria-label="Image shown">
                {(['original', 'denoised'] as const).map((v) => (
                  <label key={v} className="segmented-item">
                    <input
                      type="radio"
                      name="result-view"
                      value={v}
                      checked={view === v}
                      onChange={() => setView(v)}
                    />
                    <span>{v === 'original' ? 'Original' : 'Denoised'}</span>
                  </label>
                ))}
              </div>
            )}
            <div className="result-img-frame" style={{ aspectRatio: String(aspect ?? 4 / 3) }}>
              <img
                src={shown}
                alt={view === 'denoised' ? 'Denoised preview, 192×192' : 'Your image'}
              />
            </div>
          </figure>
        )}
        <div>
          <h3 className="eyebrow">Timings</h3>
          <dl className="timings">
            {rows.map((id) => (
              <div key={id}>
                <dt>{STEP_META[id].title}</dt>
                <dd className="num">{formatMs(timings[id])}</dd>
              </div>
            ))}
            <div className="timings-total">
              <dt>Total</dt>
              <dd className="num">{formatMs(total)}</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
