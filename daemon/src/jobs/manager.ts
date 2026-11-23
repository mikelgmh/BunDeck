/**
 * jobs/manager.ts — Sistema anti-cuelgue para operaciones largas.
 *
 * Problema que resuelve: `git clone`, `bun/npm install`, `bun run build` y el
 * arranque del runtime Elgato pueden tardar minutos o colgarse (red lenta,
 * prompt interactivo, proceso hijo zombi). Antes cada punto usaba su propio
 * `Promise.race` con timeout, sin latido ni cancelación global: un cuelgue
 * dejaba staging colgando y a la UI sin saber si seguía vivo.
 *
 * Diseño:
 * - `JobManager.run(key, fn, opts)`: registra el job, ejecuta `fn(ctx)` con
 *   `ctx.beat(msg)` para latir, y un watchdog que cada `checkMs` comprueba
 *   `Date.now() - lastBeat > timeoutMs` → marca timeout, llama a
 *   `opts.onTimeout?.()` (p.ej. `proc.kill()`), y rechaza. `ctx.cancelled`
 *   + `ctx.throwIfCancelled()` permiten cancelación cooperativa.
 * - `spawnJob argv`: helper para `Bun.spawn` con timeout real (SIGTERM +
 *   SIGKILL de gracia), captura acotada de stderr y latido opcional.
 * - API: `list()` para `GET /api/v1/jobs`, `cancel(id)` para
 *   `POST /api/v1/jobs/:id/cancel`. WS: el importador ya emite
 *   `plugin.install-progress`; el manager expone `onEvent` para puentearlo a
 *   `job.progress` si se quiere.
 */

export interface JobInfo {
  id: string;
  key: string;
  stage: string;
  message: string;
  startedAt: number;
  lastBeatAt: number;
  timeoutMs: number;
  status: 'running' | 'done' | 'error' | 'timeout' | 'cancelled';
  error?: string | null;
}

export interface JobContext {
  /** Actualiza latido + stage/message visible en GET /api/v1/jobs. */
  beat: (stage?: string, message?: string) => void;
  /** True si alguien llamó a cancel(id). */
  readonly cancelled: boolean;
  /** Lanza si se canceló (para abortar bucles largos). */
  throwIfCancelled: () => void;
  /** Id del job (para logs). */
  readonly jobId: string;
}

export interface RunOpts {
  timeoutMs?: number;
  /** Cada cuánto el watchdog comprueba el latido (ms). */
  checkMs?: number;
  /** Llamado al expirar: matar proceso hijo, cerrar servidor, etc. */
  onTimeout?: () => void;
  /** Puente de progreso (p.ej. broadcast WS). */
  onEvent?: (info: JobInfo) => void;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 min por defecto (build DeckCal incluido)
const DEFAULT_CHECK_MS = 5_000;

let seq = 0;

export class JobManager {
  private jobs = new Map<string, JobInfo & { cancelRequested: boolean; timer: ReturnType<typeof setInterval> | null }>();

  public list(): JobInfo[] {
    return [...this.jobs.values()].map(({ cancelRequested: _c, timer: _t, ...info }) => ({ ...info }));
  }

  public get(id: string): JobInfo | null {
    const j = this.jobs.get(id);
    if (!j) return null;
    const { cancelRequested: _c, timer: _t, ...info } = j;
    return { ...info };
  }

  public cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.status !== 'running') return false;
    j.cancelRequested = true;
    j.stage = 'cancel';
    j.message = 'Cancelación solicitada…';
    j.lastBeatAt = Date.now();
    this.emit({ ...j });
    return true;
  }

  private emit(info: JobInfo): void {
    try { this.onEvent?.(info); } catch {}
  }

  public onEvent: ((info: JobInfo) => void) | null = null;

  /** Ejecuta fn con watchdog. Rechaza con Error('timeout' | 'cancelado'). */
  public async run<T>(key: string, fn: (ctx: JobContext) => Promise<T>, opts: RunOpts = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const checkMs = opts.checkMs ?? DEFAULT_CHECK_MS;
    const id = `job_${Date.now()}_${(seq += 1)}`;
    const rec = {
      id, key, stage: 'start', message: 'Iniciando…',
      startedAt: Date.now(), lastBeatAt: Date.now(), timeoutMs,
      status: 'running' as const, error: null as string | null,
      cancelRequested: false, timer: null as ReturnType<typeof setInterval> | null,
    };
    this.jobs.set(id, rec);
    const snapshot = (): JobInfo => {
      const { cancelRequested: _c, timer: _t, ...info } = rec;
      return { ...info };
    };
    if (opts.onEvent) {
      try { opts.onEvent(snapshot()); } catch {}
    }
    this.emit(snapshot());

    const ctx: JobContext = {
      jobId: id,
      get cancelled() { return rec.cancelRequested; },
      throwIfCancelled: () => {
        if (rec.cancelRequested) throw new Error(`Job ${id} (${key}) cancelado`);
      },
      beat: (stage?: string, message?: string) => {
        rec.lastBeatAt = Date.now();
        if (stage) rec.stage = stage;
        if (message !== undefined) rec.message = message;
        if (opts.onEvent) {
          try { opts.onEvent(snapshot()); } catch {}
        }
        this.emit(snapshot());
      },
    };

    let settled = false;
    const finish = (status: JobInfo['status'], error?: string | null): void => {
      if (settled) return;
      settled = true;
      rec.status = status;
      rec.error = error ?? null;
      if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
      if (opts.onEvent) {
        try { opts.onEvent(snapshot()); } catch {}
      }
      this.emit(snapshot());
      // Conservar el registro 5 min para diagnóstico, luego purgar.
      setTimeout(() => { this.jobs.delete(id); }, 5 * 60 * 1000).unref?.();
    };

    return new Promise<T>((resolve, reject) => {
      rec.timer = setInterval(() => {
        if (settled) return;
        if (rec.cancelRequested) {
          finish('cancelled', 'Cancelado por el usuario');
          try { opts.onTimeout?.(); } catch {}
          reject(new Error(`Job ${id} (${key}) cancelado`));
          return;
        }
        if (Date.now() - rec.lastBeatAt > timeoutMs) {
          finish('timeout', `Timeout ${Math.round(timeoutMs / 1000)}s sin progreso en ${key} (stage: ${rec.stage})`);
          try { opts.onTimeout?.(); } catch {}
          reject(new Error(`Timeout ${Math.round(timeoutMs / 1000)}s sin progreso en ${key} (stage: ${rec.stage})`));
        }
      }, checkMs);
      // Unref para no mantener vivo el daemon en tests.
      (rec.timer as any)?.unref?.();

      fn(ctx).then(
        (v) => { finish('done'); resolve(v); },
        (e) => {
          if (rec.cancelRequested) finish('cancelled', e instanceof Error ? e.message : String(e));
          else finish('error', e instanceof Error ? e.message : String(e));
          reject(e);
        }
      );
    });
  }
}

/** Singleton del daemon (el loader/importador lo comparten). */
let singleton: JobManager | null = null;
export function getJobManager(): JobManager {
  if (!singleton) singleton = new JobManager();
  return singleton;
}

export interface SpawnResult {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  stderrTail: string;
}

/**
 * `Bun.spawn` con timeout REAL + cancelación cooperativa + latido.
 * Mata con SIGTERM y, tras 2s de gracia, SIGKILL. Nunca deja zombis.
 */
export async function spawnJob(
  argv: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs: number;
    ctx?: JobContext;
    /** Latido cada N bytes en stderr/stdout (para builds largos). */
    beatOnOutput?: (stage: string, message: string) => void;
  }
): Promise<SpawnResult> {
  let proc: any;
  try {
    proc = Bun.spawn(argv, { windowsHide: true, 
      cwd: opts.cwd,
      env: opts.env as any,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (e) {
    throw new Error(`No se pudo lanzar ${argv[0]}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const deadline = Date.now() + opts.timeoutMs;
  let stderrTail = '';
  const pump = (async () => {
    try {
      const reader = (proc.stderr as any)?.getReader?.();
      if (!reader) {
        try { stderrTail = (await new Response(proc.stderr).text()).slice(-800); } catch {}
        return;
      }
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrTail = (stderrTail + dec.decode(value)).slice(-800);
        opts.beatOnOutput?.('deps', `…${stderrTail.slice(-120)}`);
        if (Date.now() > deadline) break;
      }
    } catch {}
  })();

  const exited: Promise<number> = proc.exited;
  let timedOut = false;
  const winner = await Promise.race([
    exited.then(() => 'done' as const),
    (async () => {
      for (;;) {
        await new Promise((r) => setTimeout(r, 500));
        if (opts.ctx?.cancelled) return 'cancel' as const;
        if (Date.now() > deadline) return 'timeout' as const;
        try {
          const code = proc.exitCode;
          if (code !== null && code !== undefined) return 'done' as const;
        } catch {}
      }
    })(),
  ]);
  if (winner !== 'done') {
    timedOut = winner === 'timeout';
    try { proc.kill('SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, 2000));
    try {
      if (proc.exitCode === null || proc.exitCode === undefined) proc.kill('SIGKILL');
    } catch {}
    try { await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]); } catch {}
  } else {
    try { await exited; } catch {}
  }
  try { await Promise.race([pump, new Promise((r) => setTimeout(r, 1000))]); } catch {}
  return {
    exitCode: (proc.exitCode ?? null) as number | null,
    timedOut,
    cancelled: winner === 'cancel' || !!opts.ctx?.cancelled,
    stderrTail,
  };
}
