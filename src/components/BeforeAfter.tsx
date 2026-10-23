import { useId, useState } from 'react';

interface Props {
  original: string | undefined;
  denoised: string;
  width?: number;
  height?: number;
  aspect?: number;
}

/** Drag (or use arrow keys on) the slider to compare the original and the denoised preview. */
export function BeforeAfter({
  original,
  denoised,
  width = 192,
  height = 192,
  aspect = 4 / 3,
}: Props) {
  const [pos, setPos] = useState(50);
  const id = useId();
  return (
    <figure className="compare">
      <div className="compare-frame" style={{ aspectRatio: String(aspect) }}>
        {original ? (
          <img className="compare-img" src={original} alt="Original image" />
        ) : (
          <div className="compare-img compare-missing">Original not available</div>
        )}
        <img
          className="compare-img compare-top"
          src={denoised}
          alt={`Denoised preview, ${width}×${height}`}
          style={{ clipPath: `inset(0 0 0 ${pos}%)` }}
        />
        <span className="compare-divider" style={{ left: `${pos}%` }} aria-hidden="true" />
        <span className="compare-tag compare-tag-left" aria-hidden="true">
          Original
        </span>
        <span className="compare-tag compare-tag-right" aria-hidden="true">
          Denoised
        </span>
        <input
          id={id}
          className="compare-range"
          type="range"
          min={0}
          max={100}
          value={pos}
          onChange={(e) => setPos(Number(e.target.value))}
          aria-label="Comparison: left shows the original, right the denoised preview"
          aria-valuetext={`${100 - pos} % denoised visible`}
        />
      </div>
      <figcaption className="compare-caption">
        Left: original. Right: denoised preview, {width}×{height} (the U-Net works at this size).
      </figcaption>
    </figure>
  );
}
