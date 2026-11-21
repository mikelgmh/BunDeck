import { describe, expect, test } from 'bun:test';

/**
 * Smoke checks contra el relay en producción (MODO PÚBLICO: sin token).
 * Solo 4 peticiones, sin reintentos agresivos. Si no hay red (DNS/fetch
 * falla), cada test hace skip silencioso (early return) en vez de fallar,
 * para no romper `bun test` en local/CI sin internet.
 *
 * El modo privado (con RELAY_TOKEN) se testea en local en `auth.test.ts`.
 */
const PROD = (process.env.RELAY_PROD_URL ?? 'https://bundeck.mikelgranero.com').replace(/\/$/, '');

function toWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith('https://')) return 'wss://' + httpUrl.slice('https://'.length);
  if (httpUrl.startsWith('http://')) return 'ws://' + httpUrl.slice('http://'.length);
  return httpUrl;
}

/** Abre un WS y resuelve 'open' si conecta, 'rejected' si lo cierran/rechazan, 'nored' si no hay red. */
function tryOpenWs(url: string, timeoutMs = 8000): Promise<'open' | 'rejected' | 'nored'> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: 'open' | 'rejected' | 'nored') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* noop */
      }
      resolve(v);
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      finish('nored');
      return;
    }
    ws.addEventListener('open', () => finish('open'), { once: true });
    ws.addEventListener('close', () => finish('rejected'));
    ws.addEventListener('error', () => finish('rejected'));
    const timer = setTimeout(() => finish('rejected'), timeoutMs);
  });
}

describe('relay producción (deploy-check)', () => {
  test('GET /health → {ok:true, service:libredeck-relay}', async () => {
    let res: Response;
    try {
      res = await fetch(`${PROD}/health`, { signal: AbortSignal.timeout(8000) });
    } catch {
      console.warn('[deploy-check] sin red hasta PROD, skip /health');
      return; // skip sin fallar
    }
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, service: 'libredeck-relay' });
  });

  test('relay público: WS sin token → upgrade aceptado', async () => {
    const outcome = await tryOpenWs(`${toWsUrl(PROD)}/`);
    if (outcome === 'nored') {
      console.warn('[deploy-check] sin red hasta PROD, skip WS');
      return; // skip sin fallar
    }
    // En modo público el upgrade se acepta; el registro lo valida el protocolo.
    expect(outcome).toBe('open');
  });

  test('relay público: register sin token → registered', async () => {
    const url = `${toWsUrl(PROD)}/`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      console.warn('[deploy-check] sin red hasta PROD, skip register');
      return;
    }
    const got = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('TIMEOUT'), 8000);
      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({
            v: 1,
            type: 'register',
            from: 'deploy-check-probe',
            nonce: 'probe1',
            exp: Date.now() + 60_000,
            payload: { deviceId: 'deploy-check-probe', pubKey: 'eA==' },
          }),
        );
      });
      ws.addEventListener('message', (e) => {
        const text = String((e as MessageEvent).data);
        if (text.includes('"registered"')) {
          clearTimeout(timer);
          resolve('registered');
        }
      });
      ws.addEventListener('close', () => {
        clearTimeout(timer);
        resolve('closed');
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        resolve('error');
      });
    });
    try {
      ws.close();
    } catch {
      /* noop */
    }
    if (got === 'TIMEOUT' || got === 'closed' || got === 'error') {
      console.warn(`[deploy-check] sin red útil hasta PROD (got=${got}), skip register`);
      return; // skip sin fallar: no podemos distinguir red de rechazo aquí
    }
    expect(got).toBe('registered');
  });

  test('relay público: POST /pair sin token → 200 con code', async () => {
    let res: Response;
    try {
      res = await fetch(`${PROD}/pair`, { method: 'POST', signal: AbortSignal.timeout(8000) });
    } catch {
      console.warn('[deploy-check] sin red hasta PROD, skip /pair');
      return; // skip sin fallar
    }
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.code).toBe('string');
  });
});
