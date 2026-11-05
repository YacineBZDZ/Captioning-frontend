import { formatBytes } from '../format';
import type { SelectedFile } from '../selection';
import { Thumb } from './Thumb';

interface Props {
  files: SelectedFile[];
  groups: number;
  maxImagesPerGroup: number | null;
  disabled: boolean;
  onRemove: (id: string) => void;
  onClearAll: () => void;
}

/** Thumbnails of a multi-image selection, before the run. */
export function SelectionGrid({
  files,
  groups,
  maxImagesPerGroup,
  disabled,
  onRemove,
  onClearAll,
}: Props) {
  const total = files.reduce((n, f) => n + f.file.size, 0);
  return (
    <div className="selection">
      <div className="selection-head">
        <p className="selection-counts num" aria-live="polite">
          <span>{files.length} images</span>
          <span>{formatBytes(total)}</span>
          <span>
            {groups} {groups === 1 ? 'group' : 'groups'}
          </span>
        </p>
        <button
          type="button"
          className="btn btn-quiet btn-small"
          onClick={onClearAll}
          disabled={disabled}
        >
          Clear all
        </button>
      </div>
      {groups > 1 && maxImagesPerGroup !== null && (
        <p className="hint">
          Sent in {groups} groups, one after another (the server takes up to {maxImagesPerGroup}{' '}
          images at a time).
        </p>
      )}
      <ul className="thumbs" aria-label="Selected images">
        {files.map((f) => (
          <li key={f.id} className="thumb">
            <span className="thumb-img">
              <Thumb src={f.url} />
            </span>
            <span className="thumb-name" title={f.file.name}>
              {f.file.name}
            </span>
            <button
              type="button"
              className="thumb-remove"
              onClick={() => onRemove(f.id)}
              disabled={disabled}
              aria-label={`Remove ${f.file.name}`}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
              </svg>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
