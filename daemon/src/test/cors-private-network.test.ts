/**
 * cors-private-network.test.ts — Private Network Access (Chrome).
 *
 * La página de callback del relay (`https://relay.bundeck.app`, red pública)
 * hace fetch a `http://127.0.0.1:<apiPort>` (red privada). Chrome exige
 * `Access-Control-Allow-Private-Network: true` en el preflight y en la
 * respuesta; sin él bloquea la petición antes de llegar a la API y la
 * auto-entrega del code de Discord falla con "Failed to fetch".
 */
import { describe, expect, test } from 'bun:test';
import { buildCorsHeaders, isLocalOrigin, preflightResponse, withCors } from '../http/cors';

describe('CORS: Access-Control-Allow-Private-Network', () => {
  test('origen público (relay https): abierto + PNA', () => {
    const h = buildCorsHeaders('https://relay.bundeck.app');
    expect(h['Access-Control-Allow-Origin']).toBe('*');
    expect(h['Access-Control-Allow-Private-Network']).toBe('true');
    expect(h['Access-Control-Allow-Credentials']).toBeUndefined();
  });

  test('origen local: eco + credentials + PNA', () => {
    const h = buildCorsHeaders('http://127.0.0.1:4321');
    expect(h['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:4321');
    expect(h['Access-Control-Allow-Credentials']).toBe('true');
    expect(h['Access-Control-Allow-Private-Network']).toBe('true');
  });

  test('sin origin: abierto + PNA', () => {
    const h = buildCorsHeaders(null);
    expect(h['Access-Control-Allow-Origin']).toBe('*');
    expect(h['Access-Control-Allow-Private-Network']).toBe('true');
  });

  test('preflight OPTIONS: 204 con PNA', async () => {
    const req = new Request('http://127.0.0.1:3001/api/v1/plugins/discord/token-capture', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://relay.bundeck.app',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    const res = preflightResponse(req);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-private-network')).toBe('true');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('withCors añade PNA a una respuesta API sin quitar el resto', async () => {
    const res = withCors(
      new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }),
      'https://relay.bundeck.app'
    );
    expect(res.headers.get('access-control-allow-private-network')).toBe('true');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('isLocalOrigin no cambia: relay es remoto, loopback es local', () => {
    expect(isLocalOrigin('https://relay.bundeck.app')).toBe(false);
    expect(isLocalOrigin('http://127.0.0.1:3001')).toBe(true);
  });
});
