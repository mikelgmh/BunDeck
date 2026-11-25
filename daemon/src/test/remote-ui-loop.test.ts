/**
 * remote-ui-loop.test.ts — Bucle completo REAL de UI remota, de punta a punta:
 *
 * daemon (TunnelClient de verdad) ↔ relay (RelayServer de verdad)
 *        + endpoints HTTP de navegador (/ui/<code> y /ui/<code>/status).
 *
 * Flujo: publishUiCode → visita /ui/<code> (dispara ui-request al daemon)
 * → el daemon lo encola → decideUiRequest(allow) → ui-bind → el poll del
 * navegador devuelve approved + sessionToken. Es el test que habría cazado
 * el "enlace caducado o inválido" persistente (p. ej. publish que nunca
 * llega al relay o decisiones que no se propagan).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import { RelayServer } from '../../../relay/src/relay';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { DeviceStore } from '../../../relay/src/store';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { PairingStore } from '../../../relay/src/pairing';
import { TunnelClient } from '../remote/tunnel';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-remote-ui-loop-test-'));

let servers: RelayServer[] = [];
let stores: DeviceStore[] = [];
let tunnels: TunnelClient[] = [];
let savedRelayUrl: string | undefined;

function fakeDb(uiEnabled = true) {
  return {
    getSetting: (k: string) => {
      if (k === 'remote.ui.enabled') return uiEnabled ? '1' : '0';
      return null;
    },
  } as any;
}

function startRelay(): RelayServer {
  const dir = fs.mkdtempSync(path.join(ROOT, 'r-'));
  const store = new DeviceStore(dir);
  stores.push(store);
  const relay = new RelayServer({ token: '', store, pairing: new PairingStore() });
  relay.listen(0, '127.0.0.1');
  servers.push(relay);
  return relay;
}

function startTunnel(port: number, deviceId: string, uiEnabled = true): TunnelClient {
  const t = new TunnelClient(fakeDb(uiEnabled), null, {
    deviceId,
    relayUrl: `ws://127.0.0.1:${port}`,
  });
  tunnels.push(t);
  t.start();
  return t;
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timeout esperando condición del túnel');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeEach(() => {
  savedRelayUrl = process.env.RELAY_URL;
  delete process.env.RELAY_URL;
});

afterEach(async () => {
  for (const t of tunnels.splice(0)) {
    try { t.stop(); } catch { /* noop */ }
  }
  for (const r of servers.splice(0)) {
    try { r.stop(); } catch { /* noop */ }
  }
  for (const s of stores.splice(0)) {
    try { s.close(); } catch { /* noop */ }
  }
  if (savedRelayUrl === undefined) delete process.env.RELAY_URL;
  else process.env.RELAY_URL = savedRelayUrl;
  await new Promise((r) => setTimeout(r, 100));
});

async function statusOf(base: string, code: string): Promise<any> {
  const res = await fetch(`${base}/ui/${code}/status`);
  return res.json();
}

describe('remote-ui-loop: bucle completo navegador↔daemon↔relay', () => {
  test('publish → visita → pending en daemon → allow → approved + token', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const tunnel = startTunnel(relay.port, 'loop-dev-1');
    await waitFor(() => tunnel.getState() === 'connected');

    const code = 'loopcode-abc123';
    tunnel.publishUiCode(code, Date.now() + 600_000);
    // La publicación es async por WS: espera a que el relay la tenga.
    await waitFor(async () => (await statusOf(base, code)).status === 'pending');

    // Primera visita del navegador: página (o 404 si no hay handler, no importa)
    // y sobre todo dispara ui-request al daemon.
    await fetch(`${base}/ui/${code}`, { headers: { 'user-agent': 'LoopTest/1.0' } });
    await waitFor(() => tunnel.getPending().length > 0);
    const [req] = tunnel.getPending();
    expect(req.urlCode).toBe(code);

    // El dueño aprueba en el daemon.
    const decision = tunnel.decideUiRequest(req.reqId, true);
    expect(decision.ok).toBe(true);
    expect(decision.allowed).toBe(true);
    expect(typeof decision.sessionToken).toBe('string');
    // REGRESIÓN BUG3: el pendiente decidido ya no se lista.
    expect(tunnel.getPending()).toEqual([]);

    // El poll del navegador recibe approved + token UNA vez.
    const first = await statusOf(base, code);
    expect(first.status).toBe('approved');
    expect(typeof first.sessionToken).toBe('string');
    expect(first.sessionToken!.length).toBeGreaterThan(31);
    const second = await statusOf(base, code);
    expect(second.status).toBe('approved');
    expect(second.sessionToken).toBeUndefined();
  });

  test('deny → el poll dice denied', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const tunnel = startTunnel(relay.port, 'loop-dev-2');
    await waitFor(() => tunnel.getState() === 'connected');

    const code = 'loopcode-deny456';
    tunnel.publishUiCode(code, Date.now() + 600_000);
    await waitFor(async () => (await statusOf(base, code)).status === 'pending');
    await fetch(`${base}/ui/${code}`);
    await waitFor(() => tunnel.getPending().length > 0);

    const [req] = tunnel.getPending();
    const decision = tunnel.decideUiRequest(req.reqId, false);
    expect(decision.ok).toBe(true);
    expect(decision.allowed).toBe(false);
    // REGRESIÓN BUG3 (deny): el pendiente decidido ya no se lista.
    expect(tunnel.getPending()).toEqual([]);
    expect(await statusOf(base, code)).toEqual({ status: 'denied' });
  });

  test('código nunca publicado → expired (el caso del bug reportado)', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const tunnel = startTunnel(relay.port, 'loop-dev-3');
    await waitFor(() => tunnel.getState() === 'connected');

    // Sin publishUiCode: el relay no conoce el código.
    expect(await statusOf(base, 'loopcode-jamas-publicado')).toEqual({ status: 'expired' });
  });

  test('túnel caído: publish no llega y el status sigue expired', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const tunnel = startTunnel(relay.port, 'loop-dev-4');
    await waitFor(() => tunnel.getState() === 'connected');
    tunnel.stop();

    // Publicar sin conexión no sirve (se reintentará al reconectar, pero
    // ahora mismo el relay no sabe nada del código).
    tunnel.publishUiCode('loopcode-offline789', Date.now() + 600_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(await statusOf(base, 'loopcode-offline789')).toEqual({ status: 'expired' });
  });
});
