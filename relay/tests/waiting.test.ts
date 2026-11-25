import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../src/store';
import { PairingStore } from '../src/pairing';
import { RelayServer } from '../src/relay';
import { renderLanding } from '../src/landing';
import {
  UI_POLL_MS,
  UI_STATUS_SUFFIX,
  UI_TIMEOUT_MS,
  __resetTunnelGetterCache,
  handleUiFetch,
  isValidUrlCode,
  registerUiRoutes,
  renderTunnelGonePage,
  renderWaitingPage,
  waitingTimedOut,
  type GetUiStatus,
} from '../src/waiting';

const servers: RelayServer[] = [];
const stores: DeviceStore[] = [];

function startRelayWithUi(getUiStatus?: GetUiStatus): RelayServer {
  const dir = mkdtempSync(join(tmpdir(), 'relay-waiting-test-'));
  const store = new DeviceStore(dir);
  stores.push(store);
  const relay = new RelayServer({ store, pairing: new PairingStore(), version: '0.1.0' });
  registerUiRoutes(relay, getUiStatus ? { getUiStatus } : {});
  relay.listen(0, '127.0.0.1');
  servers.push(relay);
  return relay;
}

afterEach(() => {
  for (const r of servers.splice(0)) r.stop();
  for (const s of stores.splice(0)) s.close();
  __resetTunnelGetterCache();
});

function uiReq(path: string, init?: RequestInit): Request {
  return new Request(`http://x.test${path}`, init);
}

describe('waiting: validación y helpers puros', () => {
  test('isValidUrlCode acepta cortos alfanuméricos y rechaza raros', () => {
    expect(isValidUrlCode('abc123')).toBe(true);
    expect(isValidUrlCode('AB-cd_12')).toBe(true);
    expect(isValidUrlCode('')).toBe(false);
    expect(isValidUrlCode('a/b')).toBe(false);
    expect(isValidUrlCode('ab<script>')).toBe(false);
    expect(isValidUrlCode('a b')).toBe(false);
    expect(isValidUrlCode('x'.repeat(65))).toBe(false);
    expect(isValidUrlCode('x'.repeat(64))).toBe(true);
  });

  test('waitingTimedOut respeta el timeout (130s por defecto)', () => {
    expect(waitingTimedOut(0, 129_999)).toBe(false);
    expect(waitingTimedOut(0, 130_000)).toBe(true);
    expect(waitingTimedOut(1000, 2000, 5000)).toBe(false);
    expect(waitingTimedOut(1000, 6000, 5000)).toBe(true);
  });

  test('constantes de poll/timeout según contrato', () => {
    expect(UI_POLL_MS).toBe(3000);
    expect(UI_TIMEOUT_MS).toBe(130_000);
    expect(UI_STATUS_SUFFIX).toBe('/status');
  });
});

describe('waiting: renderWaitingPage', () => {
  test('ES por defecto con spinner, poll y código visible', () => {
    const html = renderWaitingPage('abc123', 'es');
    expect(html).toContain('Esperando aprobación en el equipo anfitrión');
    expect(html).toContain('abc123');
    expect(html).toContain('Cancelar');
    expect(html).toContain('spinner');
    expect(html).toContain('setInterval');
    expect(html).toContain(String(UI_POLL_MS));
    expect(html).toContain(String(UI_TIMEOUT_MS));
    expect(html).toContain('location.replace');
    expect(html).toContain('/t/');
  });

  test('EN cuando se pide inglés', () => {
    const html = renderWaitingPage('abc123', 'en');
    expect(html).toContain('Waiting for approval on the host machine');
    expect(html).toContain('Cancel');
  });

  test('escapa el urlCode (sin inyección HTML)', () => {
    const html = renderWaitingPage('a<b>&"c', 'es');
    expect(html).not.toContain('a<b>');
    expect(html).toContain('a&lt;b&gt;&amp;&quot;c');
  });

  test('cubre los 4 estados + cancelación, privacidad y sin credenciales', () => {
    const html = renderWaitingPage('abc123', 'es');
    for (const id of ['st-pending', 'st-approved', 'st-denied', 'st-expired', 'st-cancelled']) {
      expect(html).toContain(id);
    }
    expect(html).toContain('Enlace caducado o inválido');
    expect(html.toLowerCase()).toContain('pide un código nuevo');
    expect(html).toContain('denegado');
    expect(html).toContain('operador del relay puede ver el tráfico');
    expect(html).toContain('nunca te pedirá usuario ni contraseña');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<form');
  });

  test('sin analytics ni fetch externos', () => {
    const html = renderWaitingPage('abc123', 'es');
    expect(html).not.toMatch(/src="https?:/);
    expect(html.toLowerCase()).not.toContain('google-analytics');
    expect(html.toLowerCase()).not.toContain('googletagmanager');
  });

  test('muestra el transporte: intento P2P en espera y conexion en aprobado', () => {
    const es = renderWaitingPage('abc123', 'es');
    // En espera: politica de transporte visible antes de aprobar.
    expect(es).toContain('se intentará primero una conexión directa P2P');
    // Aprobado: latido de conexion + boton para entrar sin esperar.
    expect(es).toContain('wait-connecting');
    expect(es).toContain('Estableciendo conexión segura');
    expect(es).toContain('id="wait-go"');
    expect(es).toContain('Entrar ahora');
    expect(es).toContain('setTimeout(go,2000)');
    const en = renderWaitingPage('abc123', 'en');
    expect(en).toContain('first try an encrypted direct P2P');
    expect(en).toContain('Enter now');
  });
});

describe('waiting: handleUiFetch (sin servidor)', () => {
  test('GET /ui/abc123 → 200 HTML público', async () => {
    const res = await handleUiFetch(uiReq('/ui/abc123'));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get('content-type')).toContain('text/html');
    const html = await res!.text();
    expect(html).toContain('Esperando aprobación');
    expect(html).toContain('wait-cancel');
  });

  test('Accept: application/json → {page, urlCode}', async () => {
    const res = await handleUiFetch(uiReq('/ui/abc123', { headers: { Accept: 'application/json' } }));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ page: 'ui-waiting', urlCode: 'abc123' });
  });

  test('idioma ES por defecto, EN según Accept-Language', async () => {
    const esRes = await handleUiFetch(uiReq('/ui/abc123'));
    const es = await esRes!.text();
    expect(es).toContain('Esperando aprobación');
    const enRes = await handleUiFetch(
      uiReq('/ui/abc123', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } }),
    );
    const en = await enRes!.text();
    expect(en).toContain('Waiting for approval');
  });

  test('urlCode con caracteres raros → 400/404 sin eco inyectable', async () => {
    const evil = 'ab<script>alert("XSS-Z9Q")</script>cd';
    const res = await handleUiFetch(uiReq(`/ui/${evil}`));
    expect([400, 404]).toContain(res!.status);
    const html = await res!.text();
    expect(html).not.toContain('XSS-Z9Q');
    expect(html).not.toContain('<script>alert');
    const resJson = await handleUiFetch(
      uiReq(`/ui/${evil}`, { headers: { Accept: 'application/json' } }),
    );
    expect([400, 404]).toContain(resJson!.status);
    expect(await resJson!.text()).not.toContain('XSS-Z9Q');
  });

  test('ruta /ui con dos segmentos → 404 (no delega)', async () => {
    const res = await handleUiFetch(uiReq('/ui/a/b'));
    expect(res!.status).toBe(404);
  });

  test('no gestiona otras rutas (devuelve null)', async () => {
    expect(await handleUiFetch(uiReq('/health'))).toBeNull();
    expect(await handleUiFetch(uiReq('/'))).toBeNull();
  });

  test('status delega al getter inyectado: pending/approved/denied/expired', async () => {
    const states: Record<string, { status: 'pending' | 'approved' | 'denied' | 'expired'; sessionToken?: string }> = {
      p: { status: 'pending' },
      a: { status: 'approved', sessionToken: 'tok-1' },
      d: { status: 'denied' },
      e: { status: 'expired' },
    };
    const get: GetUiStatus = (code) => states[code] ?? null;
    for (const [code, want] of Object.entries(states)) {
      const res = await handleUiFetch(uiReq(`/ui/${code}/status`), { getUiStatus: get });
      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual(want);
    }
    const unknown = await handleUiFetch(uiReq('/ui/zzz/status'), { getUiStatus: get });
    expect(unknown!.status).toBe(404);
    const bad = await handleUiFetch(uiReq('/ui/<mal>/status'), { getUiStatus: get });
    expect(bad!.status).toBe(400);
  });

  test('status tolera getter async y rechazos', async () => {
    const ok = await handleUiFetch(uiReq('/ui/k/status'), {
      getUiStatus: async () => ({ status: 'pending' }),
    });
    expect(await ok!.json()).toEqual({ status: 'pending' });
    const boom = await handleUiFetch(uiReq('/ui/k/status'), {
      getUiStatus: () => {
        throw new Error('down');
      },
    });
    expect(boom!.status).toBe(502);
  });

  test('status sin túnel (import dinámico ausente) → 404 expired, sin romper la página', async () => {
    const st = await handleUiFetch(uiReq('/ui/abc123/status'));
    expect(st!.status).toBe(404);
    expect(await st!.json()).toEqual({ error: 'unknown-code', status: 'expired' });
    const page = await handleUiFetch(uiReq('/ui/abc123'));
    expect(page!.status).toBe(200);
  });

  test('pageOnly: true cede el status (devuelve null)', async () => {
    const res = await handleUiFetch(uiReq('/ui/abc123/status'), { pageOnly: true });
    expect(res).toBeNull();
    const page = await handleUiFetch(uiReq('/ui/abc123'), { pageOnly: true });
    expect(page!.status).toBe(200);
  });
});

describe('waiting: renderTunnelGonePage', () => {
  test('ES: titulos/cuerpos localizados y enlace al escaner, sin reload', () => {
    for (const reason of ['invalid-token', 'expired', 'daemon-offline'] as const) {
      const html = renderTunnelGonePage(reason, 'es');
      expect(html).toContain(`data-tunnel-gone="${reason}"`);
      expect(html).toContain('href="/#escanear-qr"');
      expect(html).toContain('Escanear un QR nuevo');
      expect(html).not.toContain('location.reload()');
      expect(html).not.toContain('Recargar');
    }
    expect(renderTunnelGonePage('invalid-token', 'es')).toContain('Sesión no válida');
    expect(renderTunnelGonePage('expired', 'es')).toContain('Sesión caducada');
    expect(renderTunnelGonePage('daemon-offline', 'es')).toContain('Equipo sin conexión');
  });

  test('EN: enlace al escaner, sin reload', () => {
    for (const reason of ['invalid-token', 'expired', 'daemon-offline'] as const) {
      const html = renderTunnelGonePage(reason, 'en');
      expect(html).toContain(`data-tunnel-gone="${reason}"`);
      expect(html).toContain('href="/#escanear-qr"');
      expect(html).toContain('Scan a new QR');
      expect(html).not.toContain('location.reload()');
    }
    expect(renderTunnelGonePage('invalid-token', 'en')).toContain('Invalid session');
    expect(renderTunnelGonePage('expired', 'en')).toContain('Session expired');
    expect(renderTunnelGonePage('daemon-offline', 'en')).toContain('Host offline');
  });

  test('la landing expone el anchor estable del escaner', () => {
    for (const lang of ['es', 'en'] as const) {
      const html = renderLanding({ version: '0.1.0', online: 0, devices: 0, wsUrl: 'wss://x.test', lang });
      expect(html).toContain('id="escanear-qr"');
      expect(html).toContain('id="qrscan-open"');
    }
  });
});

describe('waiting: integración HTTP con RelayServer', () => {
  test('/ui/abc123 → 200 HTML con spinner+poll; JSON con Accept', async () => {
    const relay = startRelayWithUi((code) =>
      code === 'abc123' ? { status: 'pending' } : null,
    );
    const base = `http://127.0.0.1:${relay.port}`;
    const res = await fetch(`${base}/ui/abc123`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('spinner');
    expect(html).toContain('setInterval');
    expect(html).toContain('wait-cancel');
    const js = await fetch(`${base}/ui/abc123`, { headers: { Accept: 'application/json' } });
    expect(await js.json()).toEqual({ page: 'ui-waiting', urlCode: 'abc123' });
    const st = await fetch(`${base}/ui/abc123/status`);
    expect(await st.json()).toEqual({ status: 'pending' });
  });

  test('la página inicial no contiene el sessionToken aunque esté aprobada', async () => {
    const relay = startRelayWithUi(() => ({ status: 'approved', sessionToken: 'SECRET-ABC-123' }));
    const html = await (await fetch(`http://127.0.0.1:${relay.port}/ui/abc123`)).text();
    expect(html).not.toContain('SECRET-ABC-123');
    const st = await (await fetch(`http://127.0.0.1:${relay.port}/ui/abc123/status`)).json();
    expect(st).toEqual({ status: 'approved', sessionToken: 'SECRET-ABC-123' });
  });

  test('rutas existentes intactas (/health, /) tras registrar', async () => {
    const relay = startRelayWithUi();
    const base = `http://127.0.0.1:${relay.port}`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/ui/no-existe-xyz/status`)).status).toBe(404);
  });

  test('registerUiRoutes es idempotente (doble registro no rompe)', async () => {
    const relay = startRelayWithUi();
    const second = registerUiRoutes(relay, {});
    expect(second.mode).toBe('wrapped');
    const res = await fetch(`http://127.0.0.1:${relay.port}/ui/abc123`);
    expect(res.status).toBe(200);
  });
});
