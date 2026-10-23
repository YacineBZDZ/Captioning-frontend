import { useEffect, useId, useState, type DragEvent, type RefObject } from 'react';
import type { ProcessOptions, ServerInfo } from '../api/client';
import { validateFile } from '../validateFile';
import { formatTypes } from '../api/errors';
import { formatBytes, formatDims } from '../format';

export interface Selection {
  file: File;
  url: string;
  width?: number;
  height?: number;
}

interface Props {
  info: ServerInfo;
  selection: Selection | null;
  onSelect: (file: File) => void;
  onClear: () => void;
  onDimensions: (width: number, height: number) => void;
  options: ProcessOptions;
  onOptions: (o: ProcessOptions) => void;
  running: boolean;
  canAnalyse: boolean;
  reason: string | null;
  onAnalyse: () => void;
  onCancel: () => void;
  fileInputRef: RefObject<HTMLInputElement>;
}

export function UploadPanel(props: Props) {
  const { info, selection, onSelect, onClear, options, onOptions, running } = props;
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputId = useId();
  const reasonId = useId();
  const errorId = useId();

  function take(file: File | undefined | null) {
    if (!file) return;
    const problem = validateFile(file, info);
    setError(problem);
    if (!problem) onSelect(file);
  }

  // Paste an image from the clipboard anywhere on the page.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (running) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input[type="text"], textarea, [contenteditable="true"]')) return;
      const item = Array.from(e.clipboardData?.items ?? []).find(
        (i) => i.kind === 'file' && i.type.startsWith('image/'),
      );
      const blob = item?.getAsFile();
      if (!blob) return;
      e.preventDefault();
      const ext = blob.type.split('/')[1] ?? 'png';
      take(blob.name ? blob : new File([blob], `pasted-image.${ext}`, { type: blob.type }));
    }
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (running) return;
    take(e.dataTransfer.files[0]);
  }

  return (
    <section className="panel upload" aria-labelledby="upload-title">
      <h2 id="upload-title" className="eyebrow">
        1 · Image
      </h2>

      <div
        className="dropzone"
        data-dragging={dragging || undefined}
        data-has-file={selection ? true : undefined}
        onDragOver={(e) => {
          e.preventDefault();
          if (!running) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {selection ? (
          <figure className="preview">
            <div className="preview-frame">
              <img
                src={selection.url}
                alt={`Preview of ${selection.file.name}`}
                onLoad={(e) =>
                  props.onDimensions(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)
                }
              />
            </div>
            <figcaption className="preview-meta">
              <span className="preview-name" title={selection.file.name}>
                {selection.file.name}
              </span>
              <span className="num">
                {selection.width && selection.height
                  ? `${formatDims(selection.width, selection.height)} · `
                  : ''}
                {formatBytes(selection.file.size)}
              </span>
            </figcaption>
          </figure>
        ) : (
          <div className="dropzone-empty">
            <svg className="dropzone-icon" viewBox="0 0 48 48" aria-hidden="true">
              <rect x="6" y="10" width="36" height="28" rx="3" />
              <circle cx="17" cy="20" r="3.5" />
              <path d="M6 33l11-10 9 8 6-5 10 9" />
            </svg>
            <p>Drop a photo here, paste it, or choose a file.</p>
            <p className="hint">
              {formatTypes(info.allowedTypes)} · up to {info.maxUploadMb} MB
            </p>
          </div>
        )}

        <div className="dropzone-actions">
          <input
            ref={props.fileInputRef}
            id={inputId}
            className="file-input sr-only"
            type="file"
            accept={info.allowedTypes.join(',')}
            disabled={running}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => {
              take(e.target.files?.[0]);
              e.target.value = ''; // allow choosing the same file again
            }}
          />
          <label htmlFor={inputId} className="btn" data-disabled={running || undefined}>
            {selection ? 'Choose another file' : 'Choose a file'}
          </label>
          {selection && !running && (
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                setError(null);
                onClear();
              }}
            >
              Remove
            </button>
          )}
        </div>
      </div>

      <p id={errorId} className="field-error" role="alert">
        {error}
      </p>

      <details className="options">
        <summary>Options</summary>
        <fieldset disabled={running}>
          <legend>Denoising</legend>
          {(
            [
              ['auto', 'Auto', 'only if the image looks noisy or blurry'],
              ['always', 'Always', ''],
              ['never', 'Never', ''],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="radio">
              <input
                type="radio"
                name="denoise"
                value={value}
                checked={options.denoise === value}
                onChange={() => onOptions({ ...options, denoise: value })}
              />
              <span>
                {label}
                {hint && <span className="hint"> – {hint}</span>}
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset disabled={running}>
          <legend>Decoding</legend>
          {(
            [
              ['beam', 'Beam search', 'better'],
              ['greedy', 'Greedy', 'faster'],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="radio">
              <input
                type="radio"
                name="decoding"
                value={value}
                checked={options.decoding === value}
                onChange={() => onOptions({ ...options, decoding: value })}
              />
              <span>
                {label} <span className="hint">– {hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </details>

      <div className="run-actions">
        {running ? (
          <button type="button" className="btn btn-wide" onClick={props.onCancel}>
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-wide"
            disabled={!props.canAnalyse}
            aria-describedby={props.reason ? reasonId : undefined}
            onClick={props.onAnalyse}
          >
            Analyse
          </button>
        )}
        <p id={reasonId} className="run-reason">
          {props.reason ?? ''}
        </p>
      </div>
    </section>
  );
}
