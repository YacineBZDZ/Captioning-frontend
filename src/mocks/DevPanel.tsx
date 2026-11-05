import { useId, useState, useSyncExternalStore } from 'react';
import { mockKindOf, SCENARIOS, type MockBackend, type ScenarioId } from './mockBackend';

const TINT: Record<string, [string, string]> = {
  clean: ['#2f6f9f', '#9fd3c7'],
  noisy: ['#6b4f2f', '#d9b26f'],
  rescue: ['#3d6b3d', '#c7e0a1'],
  painting: ['#7a2e4f', '#f0b6c8'],
  degraded: ['#4f3d7a', '#c5b6f0'],
};

/** A small labelled test image, drawn on a canvas (dev panel only). */
async function sampleFile(name: string): Promise<File> {
  const kind = mockKindOf(name);
  if (name.endsWith('.txt')) return new File(['not an image'], name, { type: 'text/plain' });
  const type = name.endsWith('.png') ? 'image/png' : 'image/jpeg';
  if (kind === 'invalid')
    return new File([crypto.getRandomValues(new Uint8Array(2048))], name, { type });
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 360;
  const ctx = canvas.getContext('2d')!;
  const [a, b] = TINT[kind] ?? TINT.clean!;
  const g = ctx.createLinearGradient(0, 0, 480, 360);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 480, 360);
  if (kind === 'noisy' || kind === 'degraded' || kind === 'rescue') {
    for (let i = 0; i < 9000; i++) {
      ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.5})`;
      ctx.fillRect(Math.random() * 480, Math.random() * 360, 2, 2);
    }
  }
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 290, 480, 70);
  ctx.fillStyle = '#fff';
  ctx.font = '600 28px system-ui, sans-serif';
  ctx.fillText(name, 20, 335);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), type, 0.85));
  return new File([blob], name, { type });
}

/** Puts files into the app's real file input, as if the user had chosen them. */
function inject(files: File[]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) return;
  const dt = new DataTransfer();
  files.forEach((f) => dt.items.add(f));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Scenario picker for the mock backend. Only loaded when VITE_MOCK=true. */
export function DevPanel({ backend }: { backend: MockBackend }) {
  const scenario = useSyncExternalStore(backend.subscribe, backend.getScenario);
  const [loading, setLoading] = useState(false);
  const id = useId();
  const current = SCENARIOS.find((s) => s.id === scenario);
  const files = current && 'files' in current ? (current.files as readonly string[]) : null;

  async function load() {
    if (!files) return;
    setLoading(true);
    try {
      inject(await Promise.all(files.map(sampleFile)));
    } finally {
      setLoading(false);
    }
  }

  return (
    <aside className="devpanel" aria-label="Mock backend controls">
      <details
        open={
          typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 700px)').matches
        }
      >
        <summary>Mock backend</summary>
        <label htmlFor={id}>Scenario</label>
        <select
          id={id}
          value={scenario}
          onChange={(e) => backend.setScenario(e.target.value as ScenarioId)}
        >
          {(['single', 'batch'] as const).map((kind) => (
            <optgroup key={kind} label={kind === 'single' ? 'Single image' : 'Batch'}>
              {SCENARIOS.filter((s) => s.kind === kind).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {files ? (
          <>
            <button type="button" className="btn btn-small" onClick={load} disabled={loading}>
              {loading ? 'Generating…' : `Load ${files.length} sample files`}
            </button>
            <p>
              Names decide the outcome: “paint”, “degraded”, “noisy”, “rescue”, “bad”, else a clean
              photo. You can also drop your own files with such names.
            </p>
          </>
        ) : (
          <p>Applies to the next request. Health follows the scenario too.</p>
        )}
      </details>
    </aside>
  );
}
