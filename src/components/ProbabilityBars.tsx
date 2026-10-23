import { pct } from '../format';

interface Props {
  probabilities: Record<string, number>;
  predicted: string;
  classes: string[];
  /** Colour the predicted bar as a warning (non-photo). */
  tone?: 'accent' | 'warn' | 'error';
  label?: string;
}

export function ProbabilityBars({
  probabilities,
  predicted,
  classes,
  tone = 'accent',
  label,
}: Props) {
  const names = [...classes, ...Object.keys(probabilities).filter((k) => !classes.includes(k))];
  return (
    <ul className="bars" data-tone={tone} aria-label={label ?? 'Class probabilities'}>
      {names.map((name) => {
        const p = probabilities[name] ?? 0;
        const isPredicted = name === predicted;
        return (
          <li key={name} className="bar-row" data-predicted={isPredicted || undefined}>
            <span className="bar-label">
              {name}
              {isPredicted && <span className="sr-only"> (predicted)</span>}
            </span>
            <span className="bar-track" aria-hidden="true">
              <span
                className="bar-fill"
                style={{ width: `${Math.max(0, Math.min(1, p)) * 100}%` }}
              />
            </span>
            <span className="bar-value">{pct(p)}</span>
          </li>
        );
      })}
    </ul>
  );
}
