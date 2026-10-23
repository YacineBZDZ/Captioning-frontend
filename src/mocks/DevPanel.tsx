import { useId, useSyncExternalStore } from 'react';
import { SCENARIOS, type MockBackend, type ScenarioId } from './mockBackend';

/** Scenario picker for the mock backend. Only loaded when VITE_MOCK=true. */
export function DevPanel({ backend }: { backend: MockBackend }) {
  const scenario = useSyncExternalStore(backend.subscribe, backend.getScenario);
  const id = useId();
  return (
    <aside className="devpanel" aria-label="Mock backend controls">
      <details open>
        <summary>Mock backend</summary>
        <label htmlFor={id}>Scenario</label>
        <select
          id={id}
          value={scenario}
          onChange={(e) => backend.setScenario(e.target.value as ScenarioId)}
        >
          {SCENARIOS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <p>Applies to the next request. Health follows the scenario too.</p>
      </details>
    </aside>
  );
}
