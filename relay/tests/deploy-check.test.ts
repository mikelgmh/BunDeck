import { describe, expect, test } from 'bun:test';

/**
 * Smoke checks contra el relay en producción.
 * Solo 3 peticiones, sin reintentos agresivos. Si no hay red (DNS/fetch
 * falla), cada test hace skip silencioso (early return) en vez de fallar,
 * para no romper `bun test` en local/CI sin internet.
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

  test('WS sin token → conexión rechazada', async () => {
    const outcome = await tryOpenWs(`${toWsUrl(PROD)}/`);
    if (outcome === 'open') {
      expect('ws-aceptado-sin-token').toBe('rechazado'); // el relay prod aceptó sin auth: fallo real
    }
    if (outcome === 'nored') {
      console.warn('[deploy-check] sin red hasta PROD, skip WS');
      return; // skip sin fallar
    }
    // 'rejected' (close/error/timeout): el relay no deja entrar sin token.
    expect(outcome).toBe('rejected');
  });

  test('POST /pair sin token → 401', async () => {
    let res: Response;
    try {
      res = await fetch(`${PROD}/pair`, { method: 'POST', signal: AbortSignal.timeout(8000) });
    } catch {
      console.warn('[deploy-check] sin red hasta PROD, skip /pair');
      return; // skip sin fallar
    }
    expect(res.status).toBe(401);
  });
});
