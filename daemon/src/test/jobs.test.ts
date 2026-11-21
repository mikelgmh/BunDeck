/**
 * jobs.test.ts — sistema anti-cuelgue: timeout, latido y cancelación.
 */
import { describe, it, expect } from 'bun:test';
import { JobManager, spawnJob } from '../jobs/manager';

describe('JobManager anti-cuelgue', () => {
  it('resuelve rápido sin timeout', async () => {
    const jm = new JobManager();
    const v = await jm.run('rapido', async () => 42, { timeoutMs: 2000, checkMs: 50 });
    expect(v).toBe(42);
    expect(jm.list()[0]?.status).toBe('done');
  });

  it('timeout cuando no hay latido', async () => {
    const jm = new JobManager();
    let err: Error | null = null;
    try {
      await jm.run('lento', async () => {
        await new Promise((r) => setTimeout(r, 500));
        return 1;
      }, { timeoutMs: 100, checkMs: 20 });
    } catch (e) { err = e as Error; }
    expect(err?.message).toMatch(/Timeout/);
    expect(jm.list()[0]?.status).toBe('timeout');
  });

  it('el latido evita el timeout', async () => {
    const jm = new JobManager();
    const v = await jm.run('latido', async (ctx) => {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 40));
        ctx.beat('work', `paso ${i}`);
      }
      return 'ok';
    }, { timeoutMs: 120, checkMs: 20 });
    expect(v).toBe('ok');
  });

  it('cancelación cooperativa', async () => {
    const jm = new JobManager();
    const p = jm.run('cancel', async (ctx) => {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 30));
        ctx.throwIfCancelled();
      }
      return 'nunca';
    }, { timeoutMs: 5000, checkMs: 10 });
    const id = jm.list()[0]?.id as string;
    expect(id).toBeTruthy();
    setTimeout(() => jm.cancel(id), 60);
    let err: Error | null = null;
    try { await p; } catch (e) { err = e as Error; }
    expect(String(err?.message)).toMatch(/cancelado/i);
  });

  it('spawnJob mata un proceso colgado', async () => {
    const r = await spawnJob([process.execPath, '-e', 'setInterval(()=>{}, 1000)'], { timeoutMs: 800 });
    expect(r.timedOut).toBe(true);
  }, 10000);
});
