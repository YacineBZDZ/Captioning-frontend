// Server status state machine. Framework-free so it can be tested with fake
// timers; React subscribes to it through useSyncExternalStore.

import type { HealthResult } from '../api/client';

export type ServerStatus = 'checking' | 'online' | 'starting' | 'offline';

export interface HealthSnapshot {
  status: ServerStatus;
  /** Epoch ms of the last completed probe. */
  lastChecked: number | null;
  /** Set while the user-triggered wake-up loop is running. */
  waking: { startedAt: number } | null;
  /** The last wake-up attempt gave up after WAKE_MAX_MS. */
  wakeFailed: boolean;
  version: string | null;
}

export const POLL = {
  online: 20_000,
  /** Re-check quickly after a single failure while online. */
  onlineRetry: 5_000,
  starting: 3_000,
  offlineMin: 10_000,
  offlineMax: 60_000,
  wake: 5_000,
  wakeMax: 3 * 60_000,
} as const;

/** Consecutive failures needed to go from online to offline. */
export const FAILURES_TO_OFFLINE = 2;

export class HealthMonitor {
  private snapshot: HealthSnapshot = {
    status: 'checking',
    lastChecked: null,
    waking: null,
    wakeFailed: false,
    version: null,
  };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private hidden = false;
  private inFlight = false;
  private recheckAfterFlight = false;
  private failures = 0;
  private offlineDelay: number = POLL.offlineMin;
  private generation = 0;

  constructor(
    private readonly probe: () => Promise<HealthResult>,
    private readonly now: () => number = Date.now,
  ) {}

  // ---- external store ------------------------------------------------------

  getSnapshot = (): HealthSnapshot => this.snapshot;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<HealthSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  // ---- controls ------------------------------------------------------------

  start(hidden = false) {
    if (this.running) return;
    this.running = true;
    this.hidden = hidden;
    if (!hidden) void this.check();
  }

  stop() {
    this.running = false;
    this.generation++;
    this.inFlight = false;
    clearTimeout(this.timer);
  }

  /** Pause while the tab is hidden; re-check immediately when visible again. */
  setHidden(hidden: boolean) {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (hidden) clearTimeout(this.timer);
    else if (this.running) void this.check();
  }

  /** User asked to wake a sleeping server: ping every 5 s for up to 3 minutes. */
  wake() {
    if (this.snapshot.status === 'online' || this.snapshot.waking) return;
    this.set({ waking: { startedAt: this.now() }, wakeFailed: false });
    void this.check();
  }

  /** A request answered MODEL_NOT_READY: the server is up but still loading. */
  markStarting() {
    this.failures = 0;
    this.set({ status: 'starting' });
    this.schedule(POLL.starting);
  }

  /** Re-check now (e.g. after a failed request suggests the server is gone). */
  checkNow() {
    void this.check();
  }

  // ---- internals -----------------------------------------------------------

  private schedule(ms: number) {
    clearTimeout(this.timer);
    if (!this.running || this.hidden) return;
    this.timer = setTimeout(() => void this.check(), ms);
  }

  private async check() {
    if (!this.running) return;
    if (this.inFlight) {
      this.recheckAfterFlight = true;
      return;
    }
    clearTimeout(this.timer);
    this.inFlight = true;
    const gen = this.generation;
    let result: HealthResult;
    try {
      result = await this.probe();
    } catch (err) {
      result = { kind: 'fail', reason: String(err) };
    }
    if (gen !== this.generation) return; // stopped meanwhile
    this.inFlight = false;
    this.handle(result);
    if (this.recheckAfterFlight) {
      this.recheckAfterFlight = false;
      void this.check();
    }
  }

  private handle(result: HealthResult) {
    const now = this.now();
    const { status, waking } = this.snapshot;

    if (result.kind === 'ok') {
      this.failures = 0;
      this.offlineDelay = POLL.offlineMin;
      this.set({
        status: 'online',
        lastChecked: now,
        waking: null,
        wakeFailed: false,
        version: result.body.version ?? null,
      });
      this.schedule(POLL.online);
      return;
    }

    if (result.kind === 'loading') {
      this.failures = 0;
      this.set({ status: 'starting', lastChecked: now, version: result.body.version ?? null });
      this.schedule(POLL.starting);
      return;
    }

    // Failure.
    this.failures++;
    if (status === 'online' && this.failures < FAILURES_TO_OFFLINE) {
      this.set({ lastChecked: now });
      this.schedule(POLL.onlineRetry);
      return;
    }

    if (waking) {
      if (now - waking.startedAt >= POLL.wakeMax) {
        this.set({ status: 'offline', lastChecked: now, waking: null, wakeFailed: true });
        this.schedule(this.offlineDelay);
      } else {
        this.set({ status: 'offline', lastChecked: now });
        this.schedule(POLL.wake);
      }
      return;
    }

    if (status !== 'offline') this.offlineDelay = POLL.offlineMin;
    this.set({ status: 'offline', lastChecked: now });
    this.schedule(this.offlineDelay);
    this.offlineDelay = Math.min(this.offlineDelay * 2, POLL.offlineMax);
  }
}
