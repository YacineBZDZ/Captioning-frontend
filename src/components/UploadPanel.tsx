import { useEffect, useId, useState, type DragEvent, type RefObject } from 'react';
import type { ProcessOptions, ServerInfo } from '../api/client';
import { formatTypes } from '../api/errors';
import { formatBytes, formatDims } from '../format';
import type { SelectedFile } from '../selection';
import { capSelection, HARD_CAP } from '../state/batchSplit';
import { validateFile } from '../validateFile';
import { SelectionGrid } from './SelectionGrid';

interface Props {
  info: ServerInfo;
  /** null while /v1/info has not answered yet. */
  batchSupported: boolean | null;
  files: SelectedFile[];
  /** Adds already validated files to the selection. */
  onAdd: (files: File[]) => void;
  /** Single-image servers: the new file replaces the selection. */
  onReplace: (file: File) => void;
  onRemove: (id: string) => void;
  onClearAll: () => void;
  onDimensions: (id: string, width: number, height: number) => void;
  groups: number;
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
  const { info, files, batchSupported, options, onOptions, running } = props;
  const [refused, setRefused] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputId = useId();
  const reasonId = useId();
  const errorId = useId();
  const multiple = batchSupported !== false;
  const single = files.length === 1 ? files[0]! : null;

  /** Validates each file on its own: refused ones are listed, the others kept. */
  function take(incoming: File[]) {
    if (incoming.length === 0) return;
    const problems: string[] = [];
    const valid: File[] = [];
    for (const file of incoming) {
      const problem = validateFile(file, info);
      if (problem) problems.push(problem);
      else valid.push(file);
    }
    if (!multiple) {
      const [first, ...rest] = valid;
      if (first) props.onReplace(first);
      if (first && rest.length)
        problems.push(`Only “${first.name}” was kept: this server handles one image at a time.`);
    } else {
      const { accepted, dropped } = capSelection(files.length, valid);
      if (dropped)
        problems.push(
          `${dropped} ${dropped === 1 ? 'image was' : 'images were'} not added: at most ${HARD_CAP} images can be analysed at once.`,
        );
      if (accepted.length) props.onAdd(accepted);
    }
    setRefused(problems);
  }

  // Paste an image from the clipboard anywhere on the page.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (running) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input[type="text"], textarea, [contenteditable="true"]')) return;
      const blobs = Array.from(e.clipboardData?.items ?? [])
        .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
        .map((i) => i.getAsFile())
        .filter((b): b is File => b !== null);
      if (blobs.length === 0) return;
      e.preventDefault();
      take(
        blobs.map((blob, i) => {
          const ext = blob.type.split('/')[1] ?? 'png';
          const name = blobs.length > 1 ? `pasted-image-${i + 1}.${ext}` : `pasted-image.${ext}`;
          return blob.name ? blob : new File([blob], name, { type: blob.type });
        }),
      );
    }
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (running) return;
    take(Array.from(e.dataTransfer.files));
  }

  return (
    <section
      className="panel upload"
      aria-labelledby="upload-title"
      data-multi={files.length > 1 || undefined}
    >
      <h2 id="upload-title" className="eyebrow">
        1 · {multiple ? 'Images' : 'Image'}
      </h2>

      <div
        className="dropzone"
        data-dragging={dragging || undefined}
        data-has-file={files.length ? true : undefined}
        onDragOver={(e) => {
          e.preventDefault();
          if (!running) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {single ? (
          <figure className="preview">
            <div className="preview-frame">
              <img
                src={single.url}
                alt={`Preview of ${single.file.name}`}
                onLoad={(e) =>
                  props.onDimensions(
                    single.id,
                    e.currentTarget.naturalWidth,
                    e.currentTarget.naturalHeight,
                  )
                }
              />
            </div>
            <figcaption className="preview-meta">
              <span className="preview-name" title={single.file.name}>
                {single.file.name}
              </span>
              <span className="num">
                {single.width && single.height
                  ? `${formatDims(single.width, single.height)} · `
                  : ''}
                {formatBytes(single.file.size)}
              </span>
            </figcaption>
          </figure>
        ) : files.length > 1 ? (
          <SelectionGrid
            files={files}
            groups={props.groups}
            maxImagesPerGroup={info.batch?.maxImages ?? null}
            disabled={running}
            onRemove={props.onRemove}
            onClearAll={() => {
              setRefused([]);
              props.onClearAll();
            }}
          />
        ) : (
          <div className="dropzone-empty">
            <svg className="dropzone-icon" viewBox="0 0 48 48" aria-hidden="true">
              <rect x="6" y="10" width="36" height="28" rx="3" />
              <circle cx="17" cy="20" r="3.5" />
              <path d="M6 33l11-10 9 8 6-5 10 9" />
            </svg>
            <p>
              {multiple
                ? 'Drop photos here, paste them, or choose files.'
                : 'Drop a photo here, paste it, or choose a file.'}
            </p>
            <p className="hint">
              {formatTypes(info.allowedTypes)} · up to {info.maxUploadMb} MB each
              {info.batch ? ` · up to ${HARD_CAP} images` : ''}
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
            multiple={multiple}
            disabled={running}
            aria-describedby={refused.length ? errorId : undefined}
            onChange={(e) => {
              take(Array.from(e.target.files ?? []));
              e.target.value = ''; // allow choosing the same file again
            }}
          />
          <label htmlFor={inputId} className="btn" data-disabled={running || undefined}>
            {files.length === 0
              ? multiple
                ? 'Choose files'
                : 'Choose a file'
              : multiple
                ? 'Add images'
                : 'Choose another file'}
          </label>
          {single && !running && (
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                setRefused([]);
                props.onClearAll();
              }}
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {batchSupported === false && (
        <p className="note-inline">This server handles one image at a time.</p>
      )}

      <div id={errorId} className="field-error" role="alert">
        {refused.length > 0 && (
          <ul className="refused" aria-label="Files not added">
            {refused.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}
      </div>

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
            {files.length > 1 ? `Analyse ${files.length} images` : 'Analyse'}
          </button>
        )}
        <p id={reasonId} className="run-reason">
          {props.reason ?? ''}
        </p>
      </div>
    </section>
  );
}
