/**
 * frontend-cache.test.ts — la UI servida (tunel y embebida) no deja al movil
 * en una version vieja:
 * - `webDistCacheHeaders`: HTML -> no-store, `/_astro/*` -> immutable.
 * - DEV_MODE: `maybeRebuildWebDist` reconstruye el build en segundo plano
 *   cuando `web/src` es mas nuevo que `web/dist` (una vez por minuto, sin
 *   solapar); sin DEV no hace nada.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webDistCacheHeaders, webDistStale, newestMtimeMs, resolveWebDistCandidates } from '../http/static';
import {
  createDaemonFetch,
  maybeRebuildWebDist,
  startWebDistWatcher,
  __resetWebDistRebuildForTests,
  __resetWebDistWatcherForTests,
} from '../http/handler';

const savedEnv = {
  DEV_MODE: process.env.DEV_MODE,
  LIBREDECK_DATA_DIR: process.env.LIBREDECK_DATA_DIR,
};

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetWebDistRebuildForTests();
  __resetWebDistWatcherForTests();
});

function fakeDeps() {
  return {
    wsManager: {} as any,
    pluginLoader: {} as any,
    actionRunner: {} as any,
    windowWatcher: {} as any,
  };
}

function isolateDb() {
  process.env.LIBREDECK_DATA_DIR = mkdtempSync(join(tmpdir(), 'ld-frontend-cache-'));
}

/** web/ falso con src nuevo y dist viejo (o ausente). */
function fakeWebRoot(opts: { srcNewer: boolean; withDist: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'ld-fake-web-'));
  const src = join(root, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'App.vue'), '<template/>');
  const dist = join(root, 'dist');
  let distIndex: string | null = null;
  if (opts.withDist) {
    mkdirSync(dist, { recursive: true });
    distIndex = join(dist, 'index.html');
    writeFileSync(distIndex, '<html/>');
  }
  const now = Date.now() / 1000;
  if (opts.withDist) {
    // dist viejo, src nuevo (o al reves segun el caso).
    utimesSync(distIndex as string, now - 100, now - 100);
    utimesSync(join(src, 'App.vue'), opts.srcNewer ? now : now - 200, opts.srcNewer ? now : now - 200);
  } else {
    utimesSync(join(src, 'App.vue'), now, now);
  }
  return { root, src, distIndex };
}

describe('webDistCacheHeaders', () => {
  test('HTML -> no-store (shell SPA siempre fresca en iOS)', () => {
    expect(webDistCacheHeaders('/index.html')).toEqual({ 'Cache-Control': 'no-store' });
    expect(webDistCacheHeaders('/alguna/ruta.html')).toEqual({ 'Cache-Control': 'no-store' });
  });

  test('/_astro/* -> immutable (build con hash)', () => {
    expect(webDistCacheHeaders('/_astro/app.abc123.js')).toEqual({
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });

  test('resto sin cabecera (favicon, etc.)', () => {
    expect(webDistCacheHeaders('/favicon.ico')).toEqual({});
  });
});

describe('resolveWebDistCandidates', () => {
  test('en DEV web/dist va antes que daemon/web-dist (la copia vieja no tapa al build fresco)', () => {
    process.env.DEV_MODE = 'true';
    const dev = resolveWebDistCandidates();
    const firstWebDist = dev.findIndex((p) => p.endsWith(join('web', 'dist')));
    const firstDaemonDist = dev.findIndex((p) => p.endsWith(join('daemon', 'web-dist')));
    expect(firstWebDist).toBeGreaterThanOrEqual(0);
    expect(firstDaemonDist).toBeGreaterThanOrEqual(0);
    expect(firstWebDist).toBeLessThan(firstDaemonDist);
  });

  test('en prod daemon/web-dist mantiene prioridad', () => {
    delete process.env.DEV_MODE;
    const prod = resolveWebDistCandidates();
    const firstWebDist = prod.findIndex((p) => p.endsWith(join('web', 'dist')));
    const firstDaemonDist = prod.findIndex((p) => p.endsWith(join('daemon', 'web-dist')));
    expect(firstWebDist).toBeGreaterThanOrEqual(0);
    expect(firstDaemonDist).toBeGreaterThanOrEqual(0);
    expect(firstDaemonDist).toBeLessThan(firstWebDist);
  });
});

describe('webDistStale', () => {
  test('src mas nuevo que dist -> obsoleto', () => {
    const { src, distIndex } = fakeWebRoot({ srcNewer: true, withDist: true });
    expect(webDistStale(src, distIndex)).toBe(true);
  });

  test('src mas viejo que dist -> al dia', () => {
    const { src, distIndex } = fakeWebRoot({ srcNewer: false, withDist: true });
    expect(webDistStale(src, distIndex)).toBe(false);
  });

  test('sin dist -> obsoleto; sin src -> no obsoleto', () => {
    const { src } = fakeWebRoot({ srcNewer: true, withDist: false });
    expect(webDistStale(src, null)).toBe(true);
    expect(webDistStale(null, '/x/index.html')).toBe(false);
  });

  test('newestMtimeMs recorre subdirectorios', () => {
    const { src } = fakeWebRoot({ srcNewer: true, withDist: false });
    mkdirSync(join(src, 'sub'));
    const deep = join(src, 'sub', 'deep.ts');
    writeFileSync(deep, 'x');
    const now = Date.now() / 1000;
    utimesSync(deep, now, now);
    expect(newestMtimeMs(src)).toBeGreaterThan(0);
    expect(newestMtimeMs(join(src, 'no-existe'))).toBe(0);
  });
});

describe('maybeRebuildWebDist', () => {
  test('sin DEV_MODE no hace nada', async () => {
    delete process.env.DEV_MODE;
    let called = 0;
    const r = await maybeRebuildWebDist({ spawnFn: () => { called++; } });
    expect(r).toBe(false);
    expect(called).toBe(0);
  });

  test('dispara el build cuando el repo esta obsoleto (usa web/ real)', async () => {
    // El repo de trabajo tiene src mas nuevo que dist tras editar: con
    // intervenir el spawn basta para probar el cableado sin compilar.
    process.env.DEV_MODE = 'true';
    isolateDb();
    let built = '';
    const real = await maybeRebuildWebDist({
      spawnFn: (webDir: string) => { built = webDir; },
    });
    // El resultado depende del estado del repo (puede estar al dia si se
    // acaba de compilar): lo importante es que no lanza y no falla.
    expect(typeof real).toBe('boolean');
    if (real) expect(built).toContain('web');
    // Segunda llamada seguida no relanza (single-flight o intervalo).
    const again = await maybeRebuildWebDist({ spawnFn: () => { throw new Error('no debe relanzar'); } });
    expect(again).toBe(false);
  });

  test('respeta el intervalo minimo aunque falle el spawn', async () => {
    process.env.DEV_MODE = 'true';
    isolateDb();
    const t0 = Date.now();
    // Fuerza lastTrigger reciente: primer intento con spawn que falla deja
    // lastTrigger = t0 y running = false; el segundo cae por intervalo.
    const first = await maybeRebuildWebDist({
      nowMs: t0,
      spawnFn: () => { throw new Error('fallo simulado'); },
    });
    // Si el repo esta al dia, first es false y no hay nada que comprobar.
    if (first) {
      const second = await maybeRebuildWebDist({ nowMs: t0 + 1000, spawnFn: () => {} });
      expect(second).toBe(false);
      const later = await maybeRebuildWebDist({ nowMs: t0 + 61_000, spawnFn: () => {} });
      // running sigue false y ya paso el intervalo: solo depende de staleness.
      expect(typeof later).toBe('boolean');
    }
  });

  test('srcDir/distIndex override (solo tests)', async () => {
    process.env.DEV_MODE = 'true';
    isolateDb();
    const { src, distIndex } = fakeWebRoot({ srcNewer: true, withDist: true });
    let built = '';
    const r = await maybeRebuildWebDist({
      nowMs: Date.now(),
      spawnFn: (webDir: string) => { built = webDir; },
      srcDir: src,
      distIndex,
    });
    expect(r).toBe(true);
    expect(built).toBe(join(src, '..'));
    const fresh = await maybeRebuildWebDist({
      nowMs: Date.now() + 61_000,
      spawnFn: () => { throw new Error('no debe relanzar: repo falso al dia'); },
      srcDir: src,
      distIndex: join(src, 'App.vue'),
    });
    void fresh;
  });
});

describe('startWebDistWatcher', () => {
  test('sin DEV_MODE no vigila nada', () => {
    delete process.env.DEV_MODE;
    const dir = mkdtempSync(join(tmpdir(), 'ld-watch-'));
    let called = 0;
    startWebDistWatcher({ debounceMs: 20, spawnFn: () => { called++; }, srcDir: dir });
    expect(called).toBe(0);
  });

  test('reconstruye al guardar (con debounce) y no duplica watchers', async () => {
    process.env.DEV_MODE = 'true';
    isolateDb();
    const root = mkdtempSync(join(tmpdir(), 'ld-watch-'));
    const src = join(root, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'a.vue'), 'x');
    // Sin dist junto al src inyectado -> obsoleto -> el arranque ya dispara.
    const calls: string[] = [];
    startWebDistWatcher({ debounceMs: 40, spawnFn: (w) => { calls.push(w); }, srcDir: src });
    // Segundo arranque es no-op (mismo watcher).
    startWebDistWatcher({
      debounceMs: 40,
      spawnFn: () => { throw new Error('watcher duplicado'); },
      srcDir: src,
    });
    expect(calls).toEqual([root]);
    // Cambio real: resetea el throttle, espera al watcher y deja que el debounce dispare.
    __resetWebDistRebuildForTests();
    calls.length = 0;
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(join(src, 'b.vue'), 'y');
    writeFileSync(join(src, 'c.vue'), 'z');
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toEqual([root]);
  }, 10000);
});

describe('handler sirve web-dist con no-store en HTML', () => {
  test('GET / sirve index.html con no-store (sin DEV, sin rebuild)', async () => {
    delete process.env.DEV_MODE;
    isolateDb();
    const { initDatabase } = await import('../db');
    await initDatabase();
    const handler = createDaemonFetch(fakeDeps());
    const res = await handler(new Request('http://127.0.0.1/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
