import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkHealth, createApiClient, type HealthResult } from '../api/client';
import { HealthMonitor, POLL } from './health';

const OK: HealthResult = { kind: 'ok', body: { status: 'ok', version: '1.0.0' } };
const LOADING: HealthResult = { kind: 'loading', body: { status: 'loading' } };
const FAIL: HealthResult = { kind: 'fail', reason: 'network' };

/** A probe whose answer the test controls; counts calls. */
function controlledProbe(initial: HealthResult) {
  let next = initial;
  const probe = vi.fn(async () => next);
  return { probe, set: (r: HealthResult) => (next = r) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function boot(initial: HealthResult) {
  const p = controlledProbe(initial);
  const m = new HealthMonitor(p.probe, () => Date.now());
  m.start();
  await vi.advanceTimersByTimeAsync(0);
  return { m, ...p };
}

describe('HealthMonitor', () => {
  it('goes online on 200 ok and polls every 20 s', async () => {
    const { m, probe } = await boot(OK);
    expect(m.getSnapshot().status).toBe('online');
    expect(m.getSnapshot().lastChecked).not.toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL.online - 1);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(2);
    m.stop();
  });

  it('needs two consecutive failures to go from online to offline', async () => {
    const { m, set } = await boot(OK);
    set(FAIL);
    await vi.advanceTimersByTimeAsync(POLL.online);
    expect(m.getSnapshot().status).toBe('online'); // one failure is tolerated
    await vi.advanceTimersByTimeAsync(POLL.onlineRetry);
    expect(m.getSnapshot().status).toBe('offline');
    m.stop();
  });

  it('a success between failures resets the count', async () => {
    const { m, set } = await boot(OK);
    set(FAIL);
    await vi.advanceTimersByTimeAsync(POLL.online);
    set(OK);
    await vi.advanceTimersByTimeAsync(POLL.onlineRetry);
    set(FAIL);
    await vi.advanceTimersByTimeAsync(POLL.online);
    expect(m.getSnapshot().status).toBe('online');
    m.stop();
  });

  it('503 loading means starting, polled every 3 s, then online', async () => {
    const { m, probe, set } = await boot(LOADING);
    expect(m.getSnapshot().status).toBe('starting');
    await vi.advanceTimersByTimeAsync(POLL.starting);
    expect(probe).toHaveBeenCalledTimes(2);
    set(OK);
    await vi.advanceTimersByTimeAsync(POLL.starting);
    expect(m.getSnapshot().status).toBe('online');
    m.stop();
  });

  it('a failure on first check is offline immediately, with backoff from 10 s to 60 s', async () => {
    const { m, probe } = await boot(FAIL);
    expect(m.getSnapshot().status).toBe('offline');
    const expected = [10_000, 20_000, 40_000, 60_000, 60_000];
    for (const [i, delay] of expected.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(probe).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(probe).toHaveBeenCalledTimes(i + 2);
    }
    m.stop();
  });

  it('wake-up pings every 5 s and stops waking once online', async () => {
    const { m, probe, set } = await boot(FAIL);
    m.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.getSnapshot().waking).not.toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL.wake);
    expect(probe).toHaveBeenCalledTimes(3);
    set(LOADING);
    await vi.advanceTimersByTimeAsync(POLL.wake);
    expect(m.getSnapshot().status).toBe('starting');
    set(OK);
    await vi.advanceTimersByTimeAsync(POLL.starting);
    expect(m.getSnapshot()).toMatchObject({ status: 'online', waking: null, wakeFailed: false });
    m.stop();
  });

  it('wake-up gives up after 3 minutes', async () => {
    const { m } = await boot(FAIL);
    m.wake();
    await vi.advanceTimersByTimeAsync(POLL.wakeMax + POLL.wake);
    expect(m.getSnapshot()).toMatchObject({ status: 'offline', waking: null, wakeFailed: true });
    m.stop();
  });

  it('pauses polling while hidden and re-checks immediately when visible', async () => {
    const { m, probe } = await boot(OK);
    m.setHidden(true);
    await vi.advanceTimersByTimeAsync(POLL.online * 5);
    expect(probe).toHaveBeenCalledTimes(1);
    m.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(2);
    m.stop();
  });

  it('does not probe at start when the tab is hidden', async () => {
    const p = controlledProbe(OK);
    const m = new HealthMonitor(p.probe);
    m.start(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p.probe).not.toHaveBeenCalled();
    expect(m.getSnapshot().status).toBe('checking');
    m.stop();
  });

  it('markStarting switches to starting and polls at 3 s', async () => {
    const { m, probe } = await boot(OK);
    m.markStarting();
    expect(m.getSnapshot().status).toBe('starting');
    await vi.advanceTimersByTimeAsync(POLL.starting);
    expect(probe).toHaveBeenCalledTimes(2);
    m.stop();
  });
});

describe('checkHealth', () => {
  const respond = (body: string, status: number) =>
    createApiClient('http://x', async () => new Response(body, { status }));

  it('maps contract answers', async () => {
    expect((await checkHealth(respond('{"status":"ok"}', 200))).kind).toBe('ok');
    expect((await checkHealth(respond('{"status":"loading"}', 503))).kind).toBe('loading');
  });

  it('treats HTML pages, odd bodies and network errors as failures', async () => {
    expect((await checkHealth(respond('<html>sleeping</html>', 200))).kind).toBe('fail');
    expect((await checkHealth(respond('<html>building</html>', 503))).kind).toBe('fail');
    expect((await checkHealth(respond('{"status":"ok"}', 500))).kind).toBe('fail');
    const broken = createApiClient('http://x', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect((await checkHealth(broken)).kind).toBe('fail');
  });

  it('times out after 5 s', async () => {
    const hanging = createApiClient(
      'http://x',
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError'))),
        ),
    );
    const pending = checkHealth(hanging);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ kind: 'fail', reason: 'timeout' });
  });
});
