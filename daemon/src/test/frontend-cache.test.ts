/**
 * frontend-cache.test.ts — la UI servida (túnel y embebida) no deja al móvil
 * en una versión vieja:
 * - `webDistCacheHeaders`: HTML → no-store, `/_astro/*` → immutable.
 * - DEV_MODE: el handler proxya a Astro vivo (`tryProxyAstroDev`) y cae a
 *   web-dist si Astro no responde; sin DEV_MODE no proxya.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webDistCacheHeaders } from '../http/static';
import { createDaemonFetch, shouldProxyToAstro } from '../http/handler';

const savedEnv = {
  DEV_MODE: process.env.DEV_MODE,
  ASTRO_PORT: process.env.ASTRO_PORT,
  LIBREDECK_DATA_DIR: process.env.LIBREDECK_DATA_DIR,
};

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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

describe('webDistCacheHeaders', () => {
  test('HTML → no-store (shell SPA siempre fresca en iOS)', () => {
    expect(webDistCacheHeaders('/index.html')).toEqual({ 'Cache-Control': 'no-store' });
    expect(webDistCacheHeaders('/alguna/ruta.html')).toEqual({ 'Cache-Control': 'no-store' });
  });

  test('/_astro/* → immutable (build con hash)', () => {
    expect(webDistCacheHeaders('/_astro/app.abc123.js')).toEqual({
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });

  test('resto sin cabecera (favicon, etc.)', () => {
    expect(webDistCacheHeaders('/favicon.ico')).toEqual({});
  });
});

describe('shouldProxyToAstro', () => {
  test('solo en DEV_MODE y fuera de api/assets/config/health', () => {
    delete process.env.DEV_MODE;
    expect(shouldProxyToAstro('/')).toBe(false);
    process.env.DEV_MODE = 'true';
    expect(shouldProxyToAstro('/')).toBe(true);
    expect(shouldProxyToAstro('/alguna/ruta')).toBe(true);
    expect(shouldProxyToAstro('/api/v1/version')).toBe(false);
    expect(shouldProxyToAstro('/assets/x.png')).toBe(false);
    expect(shouldProxyToAstro('/config')).toBe(false);
    expect(shouldProxyToAstro('/health')).toBe(false);
    process.env.DEV_MODE = '1';
    expect(shouldProxyToAstro('/')).toBe(false);
  });
});

describe('DEV_MODE proxy a Astro (UI viva por el túnel)', () => {
  test('sirve Astro con no-store en HTML y pasa assets tal cual', async () => {
    const astro = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const u = new URL(req.url);
        if (u.pathname.endsWith('.js')) {
          return new Response('console.log("astro-vivo")', {
            headers: { 'content-type': 'text/javascript' },
          });
        }
        return new Response('<html>ASTRO-VIVO</html>', {
          headers: { 'content-type': 'text/html' },
        });
      },
    });
    try {
      process.env.DEV_MODE = 'true';
      process.env.ASTRO_PORT = String(astro.port);
      isolateDb();
      const handler = createDaemonFetch(fakeDeps());
      const res = await handler(new Request('http://127.0.0.1/'));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('ASTRO-VIVO');
      expect(res.headers.get('cache-control')).toBe('no-store');
      const js = await handler(new Request('http://127.0.0.1/_astro/app.hash.js'));
      expect(js.status).toBe(200);
      expect(await js.text()).toContain('astro-vivo');
    } finally {
      astro.stop(true);
    }
  });

  test('Astro caído → cae a web-dist/API sin colgar', async () => {
    process.env.DEV_MODE = 'true';
    process.env.ASTRO_PORT = '1'; // puerto cerrado
    isolateDb();
    const handler = createDaemonFetch(fakeDeps());
    const res = await handler(new Request('http://127.0.0.1/'));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('ASTRO-VIVO');
  });

  test('sin DEV_MODE no proxya aunque Astro viva', async () => {
    const astro = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('<html>ASTRO-VIVO</html>', { headers: { 'content-type': 'text/html' } }),
    });
    try {
      delete process.env.DEV_MODE;
      process.env.ASTRO_PORT = String(astro.port);
      isolateDb();
      const handler = createDaemonFetch(fakeDeps());
      const res = await handler(new Request('http://127.0.0.1/'));
      expect(await res.text()).not.toContain('ASTRO-VIVO');
    } finally {
      astro.stop(true);
    }
  });
});
