import { STRIP_STAGES, type StripStage } from '../../state/batch';
import { STRIP_LABEL } from '../../state/batchDescribe';

interface Props {
  counts: Record<StripStage, number>;
  total: number;
  active: StripStage[];
}

/** Upload > Classification > … > Captioning, with how many images passed each stage. */
export function StageStrip({ counts, total, active }: Props) {
  return (
    <ol className="strip" aria-label="Stages">
      {STRIP_STAGES.map((stage) => {
        const running = active.includes(stage);
        return (
          <li key={stage} className="strip-stage" data-running={running || undefined}>
            <span className="strip-label">{STRIP_LABEL[stage]}</span>
            <span className="strip-count num">
              {counts[stage]} / {total}
            </span>
            {running && <span className="sr-only"> (running)</span>}
          </li>
        );
      })}
    </ol>
  );
}
