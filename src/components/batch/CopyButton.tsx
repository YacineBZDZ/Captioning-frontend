import { useEffect, useRef, useState } from 'react';

/** Copies `text`; says "Copied" for two seconds. */
export function CopyButton({
  text,
  label = 'Copy',
  className = 'btn btn-small',
  context,
}: {
  text: string;
  label?: string;
  className?: string;
  /** Read by screen readers after the label, e.g. "caption of photo.jpg". */
  context?: string;
}) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('ok');
    } catch {
      setState('fail');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  }

  return (
    <button type="button" className={className} onClick={copy}>
      {state === 'ok' ? 'Copied' : state === 'fail' ? 'Copy failed' : label}
      {context && <span className="sr-only"> {context}</span>}
    </button>
  );
}
