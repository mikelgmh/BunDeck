import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../src/store';
import { PairingStore } from '../src/pairing';
import { RelayServer } from '../src/relay';
import { setUiPageHandler } from '../src/tunnel';
import { renderWaitingPage, waitingLang, wantsJson } from '../src/waiting';

/**
 * Enlazar dispositivo con el relay (modo internet del QR):
 * publish → escanear /ui/<code>?kiosk=1 → aprobar → sesión /t/<token>/.
 * Fija el contrato que rompió el cambio de dominio a relay.bundeck.app:
 * el QR lleva `https://<relay>/ui/<urlCode>?kiosk=1` y el relay debe
 * conocer el código (publicado por el daemon) y servir sala de espera.
 */

const TOKEN = 'test-device-link-token';
const servers: RelayServer[] = [];
const stores: DeviceStore[] = [];
const sockets: WebSocket[] = [];

function startRelay(): RelayServer {
  const dir = mkdtempSync(join(tmpdir(), 'relay-device-link-'));
  const store = new DeviceStore(dir);
  stores.push(store);
  const relay = new RelayServer({ token: TOKEN, store, pairing: new PairingStore() });
  relay.listen(0, '127.0.0.1');
  servers.push(relay);
  // Igual que relay/src/index.ts en prod: la sala de espera real.
  setUiPageHandler((urlCode: string, req: Request) => {
    if (wantsJson(req)) return Response.json({ page: 'ui-waiting', urlCode });
    return new Response(renderWaitingPage(urlCode, waitingLang(req)), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  });
  return relay;
}

afterEach(async () => {
  setUiPageHandler(null);
  for (const s of sockets.splice(0)) {
    try {
      s.close();
    } catch {
      /* noop */
    }
  }
  for (const r of servers.splice(0)) r.stop();
  for (const s of stores.splice(0)) s.close();
  await new Promise((r) => setTimeout(r, 25));
});

class FakeDaemon {
  ws!: WebSocket;
  buf: any[] = [];

  async connect(port: number): Promise<this> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`);
    sockets.push(this.ws);
    this.ws.addEventListener('message', (e) => {
      try {
        this.buf.push(JSON.parse(String((e as MessageEvent).data)));
      } catch {
        /* ignora no-JSON */
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('daemon connect failed')), { once: true });
    });
    return this;
  }

  send(o: unknown): void {
    this.ws.send(JSON.stringify(o));
  }

  next(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    const take = (): any | undefined => {
      const i = this.buf.findIndex(pred);
      return i >= 0 ? this.buf.splice(i, 1)[0] : undefined;
    };
    const hit = take();
    if (hit !== undefined) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error('timeout waiting for daemon message'));
      }, timeoutMs);
      const poll = setInterval(() => {
        const m = take();
        if (m !== undefined) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve(m);
        }
      }, 5);
    });
  }
}

// Código como los que genera el daemon: 12 chars base64url (puede llevar - y _).
const CODE = 'PD_KzxK2_igD';
const TOK = 'cd'.repeat(32); // 64 hex

async function registeredDaemon(port: number): Promise<FakeDaemon> {
  const d = await new FakeDaemon().connect(port);
  d.send({ v: 1, kind: 'tunnel-register', deviceId: 'daemon-1' });
  await d.next((m) => m.kind === 'tunnel-registered');
  return d;
}

describe('enlazar dispositivo con el relay (QR modo internet)', () => {
  test('flujo completo: publish → escanear (?kiosk=1) → aprobar → sesión', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);

    // El daemon publica el código del QR.
    d.send({ v: 1, kind: 'ui-publish', urlCode: CODE, exp: Date.now() + 600_000 });
    await d.next((m) => m.kind === 'ui-published');

    // El móvil escanea y abre https://<relay>/ui/<code>?kiosk=1 (navegador real).
    const page = await fetch(`${base}/ui/${CODE}?kiosk=1`, {
      headers: { accept: 'text/html', 'user-agent': 'Mobile/1.0' },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain(CODE);
    expect(html).toContain('status');

    // La primera visita dispara UNA solicitud al daemon.
    const req = await d.next((m) => m.kind === 'ui-request');
    expect(req.urlCode).toBe(CODE);
    // Segunda visita (reintento del móvil): no duplica la solicitud.
    const nBefore = d.buf.length;
    await fetch(`${base}/ui/${CODE}?kiosk=1`, { headers: { accept: 'text/html' } });
    await new Promise((r) => setTimeout(r, 200));
    expect(d.buf.filter((m) => m.kind === 'ui-request')).toHaveLength(0);
    expect(d.buf.length).toBe(nBefore);

    // Estado: pendiente hasta aprobar.
    expect(await (await fetch(`${base}/ui/${CODE}/status`)).json()).toEqual({ status: 'pending' });

    // El dueño aprueba en el panel: decision + bind con token de sesión.
    d.send({ v: 1, kind: 'ui-decision', reqId: req.reqId, allow: true });
    await d.next((m) => m.kind === 'ui-decision-ack');
    d.send({ v: 1, kind: 'ui-bind', urlCode: CODE, sessionToken: TOK, exp: Date.now() + 600_000 });
    await d.next((m) => m.kind === 'ui-bound');

    // El primer poll tras aprobar entrega el token UNA vez…
    expect(await (await fetch(`${base}/ui/${CODE}/status`)).json()).toEqual({
      status: 'approved',
      sessionToken: TOK,
    });
    // …el segundo ya no (el token no queda expuesto).
    expect(await (await fetch(`${base}/ui/${CODE}/status`)).json()).toEqual({ status: 'approved' });

    // …y un segundo móvil con el mismo QR ya no entra (un solo uso).
    expect(await (await fetch(`${base}/ui/${CODE}/status`)).json()).toEqual({ status: 'approved' });
  });

  test('código desconocido: JSON para API, página amable para navegadores', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const missing = 'ZZZnoexiste12';

    // Llamante API (fetch/JSON): 404 con el motivo.
    const api = await fetch(`${base}/ui/${missing}`, { headers: { accept: 'application/json' } });
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: 'unknown-code' });

    // Navegador real (el móvil escaneando un QR viejo/revocado): 404 HTML
    // explicando "enlace caducado o inválido", NUNCA JSON crudo.
    const nav = await fetch(`${base}/ui/${missing}?kiosk=1`, {
      headers: { accept: 'text/html', 'user-agent': 'Mobile/1.0' },
    });
    expect(nav.status).toBe(404);
    expect(nav.headers.get('content-type')).toContain('text/html');
    const html = await nav.text();
    expect(html).not.toContain('unknown-code');
    expect(html).toContain('aducad');

    // El poll de la sala de espera lo lee como expired.
    expect(await (await fetch(`${base}/ui/${missing}/status`)).json()).toEqual({ status: 'expired' });
  });

  test('código revocado antes de escanear → el móvil ve página de caducado', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    d.send({ v: 1, kind: 'ui-publish', urlCode: CODE, exp: Date.now() + 600_000 });
    await d.next((m) => m.kind === 'ui-published');
    // El dueño regenera el QR (o revoca): el anterior muere.
    d.send({ v: 1, kind: 'ui-unpublish', urlCode: CODE });
    await d.next((m) => m.kind === 'ui-unpublished');

    const nav = await fetch(`${base}/ui/${CODE}?kiosk=1`, {
      headers: { accept: 'text/html', 'user-agent': 'Mobile/1.0' },
    });
    expect(nav.status).toBe(404);
    expect(nav.headers.get('content-type')).toContain('text/html');
  });
});
