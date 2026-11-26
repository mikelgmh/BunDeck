import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../src/store';
import { PairingStore } from '../src/pairing';
import { RelayServer } from '../src/relay';
import { TunnelState } from '../src/tunnel';
import { renderWaitingPage } from '../src/waiting';

const TOKEN = 'test-relay-token';
const CODE = 'testcode-abc123'; // 15 chars (>= 12)
const LAN = {
  code: 'ABCDEFGHIJKLMNOPQRSTUV', // 22 chars base64url
  ips: ['192.168.1.10'],
  port: 3002,
  apiPort: 3001,
  fp: 'fp-test-123',
  dev: 'PC-Test',
};

function memState(now = Date.now()): { state: TunnelState; socket: { send: () => boolean; close: () => void } } {
  const state = new TunnelState({ now: () => now });
  const socket = { send: () => true, close: () => {} };
  state.registerDevice(socket, 'daemon-lan');
  return { state, socket };
}

describe('fast-path LAN: TunnelState.publish con lan', () => {
  test('lan válida se guarda y getLanHints la devuelve', () => {
    const { state, socket } = memState();
    expect(state.publish(socket, CODE, Date.now() + 600_000, LAN)).toEqual({ deviceId: 'daemon-lan' });
    expect(state.getLanHints(CODE)).toEqual(LAN);
  });

  test('sin lan (relay/daemon viejo) publica igual y hints es null', () => {
    const { state, socket } = memState();
    expect(state.publish(socket, CODE, Date.now() + 600_000)).toEqual({ deviceId: 'daemon-lan' });
    expect(state.getLanHints(CODE)).toBeNull();
    expect(state.getLanHints('no-existe')).toBeNull();
  });

  test('lan inválida publica sin lan (no falla el publish)', () => {
    const badLans: unknown[] = [
      null,
      'str',
      42,
      {},
      { ...LAN, code: 'corto' },
      { ...LAN, code: 'con espacios no' },
      { ...LAN, code: '<script>alert(1)</script>0123' },
      { ...LAN, ips: [] },
      { ...LAN, ips: 'no-array' },
      { ...LAN, ips: ['8.8.8.8'] }, // pública
      { ...LAN, ips: ['10.0.0.1', '999.1.1.1', 'fe80::1'] }, // mixta con 1 válida → filtrada
      { ...LAN, port: 0 },
      { ...LAN, port: 70000 },
      { ...LAN, port: 3002.5 },
      { ...LAN, apiPort: -1 },
      { ...LAN, fp: 'x'.repeat(129) },
      { ...LAN, dev: 'y'.repeat(129) },
      { ...LAN, fp: 123 },
    ];
    for (const lan of badLans) {
      const { state, socket } = memState();
      const r = state.publish(socket, CODE, Date.now() + 600_000, lan);
      expect(r).toEqual({ deviceId: 'daemon-lan' });
      // La mixta conserva la válida; el resto publica sin lan.
      if (lan && typeof lan === 'object' && (lan as { fp?: unknown }).fp === 123) {
        expect(state.getLanHints(CODE)).toBeNull();
      } else if (Array.isArray((lan as { ips?: unknown })?.ips) && (lan as { ips: unknown[] }).ips.includes('10.0.0.1')) {
        expect(state.getLanHints(CODE)).toEqual({ ...LAN, ips: ['10.0.0.1'] });
      } else {
        expect(state.getLanHints(CODE)).toBeNull();
      }
    }
  });

  test('ips no-RFC1918 se descartan y se recorta a 4', () => {
    const { state, socket } = memState();
    state.publish(socket, CODE, Date.now() + 600_000, {
      ...LAN,
      ips: ['8.8.8.8', '10.0.0.1', '172.16.5.4', '192.168.0.2', '172.32.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'],
    });
    expect(state.getLanHints(CODE)).toEqual({
      ...LAN,
      ips: ['10.0.0.1', '172.16.5.4', '192.168.0.2', '10.0.0.2'],
    });
  });
});

describe('fast-path LAN: limpieza de hints', () => {
  test('republicar sin lan limpia los hints anteriores', () => {
    const { state, socket } = memState();
    state.publish(socket, CODE, Date.now() + 600_000, LAN);
    expect(state.getLanHints(CODE)).toEqual(LAN);
    state.publish(socket, CODE, Date.now() + 600_000);
    expect(state.getLanHints(CODE)).toBeNull();
  });

  test('unpublish (dropCode) limpia los hints', () => {
    const { state, socket } = memState();
    state.publish(socket, CODE, Date.now() + 600_000, LAN);
    expect(state.getLanHints(CODE)).toEqual(LAN);
    expect(state.unpublish(CODE)).toBe(true);
    expect(state.getLanHints(CODE)).toBeNull();
  });

  test('prune expira el código y sus hints', () => {
    let now = 1_000;
    const state = new TunnelState({ now: () => now });
    const socket = { send: () => true, close: () => {} };
    state.registerDevice(socket, 'daemon-lan');
    state.publish(socket, CODE, 10_000, LAN);
    expect(state.getLanHints(CODE)).toEqual(LAN);
    now = 11_000;
    state.prune();
    expect(state.getLanHints(CODE)).toBeNull();
  });
});

describe('fast-path LAN: renderWaitingPage', () => {
  test('sin lan = HTML actual (sin lanHints)', () => {
    for (const lang of ['es', 'en'] as const) {
      const html = renderWaitingPage('abc123', lang);
      expect(html).not.toContain('lan-hints');
      expect(html).not.toContain('lanRedirect');
      expect(html).not.toContain('wait-lan');
      expect(html).toContain('setInterval');
    }
    // Explícito null/undefined tampoco inyecta.
    expect(renderWaitingPage('abc123', 'es', null)).not.toContain('lan-hints');
    expect(renderWaitingPage('abc123', 'es', undefined)).not.toContain('lan-hints');
  });

  test('con lan inyecta JSON escapado + JS con guard de single-redirect', () => {
    const html = renderWaitingPage('abc123', 'es', LAN);
    // JSON de hints escapado (</ → <\/), sin dependencias.
    expect(html).toContain('id="lan-hints"');
    expect(html).toContain('192.168.1.10');
    expect(html).toContain('"port":3002');
    // Guard de single-redirect: flag + sessionStorage.
    expect(html).toContain('lanRedirect:');
    expect(html).toContain('sessionStorage');
    // Race contra /config público con timeout + redirect con invite.
    expect(html).toContain('/config');
    expect(html).toContain('invite=');
    expect(html).toContain('relayFallback=');
    expect(html).toContain('1500');
    expect(html).toContain('no-store');
    // Texto ES nuevo visible.
    expect(html).toContain('Red local detectada, abriendo versión rápida…');
    const en = renderWaitingPage('abc123', 'en', LAN);
    expect(en).toContain('Local network detected, opening fast version…');
  });

  test('el JSON inyectado no permite breakout de </script>', () => {
    const evil = { ...LAN, dev: '</script><script>alert(1)</script>', fp: '</script>' };
    const { state, socket } = memState();
    // fp '</script>' es string ≤128: sanitiza ok (el escape lo hace el render).
    state.publish(socket, CODE, Date.now() + 600_000, evil);
    const html = renderWaitingPage(CODE, 'es', state.getLanHints(CODE));
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('<\\/script>');
  });

  test('lan incompleta no inyecta (tolerante)', () => {
    const html = renderWaitingPage('abc123', 'es', { code: '', ips: [], port: 0 } as never);
    expect(html).not.toContain('lan-hints');
  });
});

describe('fast-path LAN: relay ui-publish con lan (WS)', () => {
  const servers: RelayServer[] = [];
  const stores: DeviceStore[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
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

  test('pasa msg.lan a publish y mantiene el ack ui-published', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-lan-test-'));
    const store = new DeviceStore(dir);
    stores.push(store);
    const relay = new RelayServer({ token: TOKEN, store, pairing: new PairingStore() });
    relay.listen(0, '127.0.0.1');
    servers.push(relay);

    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/?token=${TOKEN}`);
    sockets.push(ws);
    const buf: unknown[] = [];
    ws.addEventListener('message', (e) => {
      try {
        buf.push(JSON.parse(String((e as MessageEvent).data)));
      } catch {
        /* noop */
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('connect failed')), { once: true });
    });
    const next = (pred: (m: { kind?: unknown }) => boolean): Promise<{ kind?: unknown } & Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          clearInterval(poll);
          reject(new Error('timeout'));
        }, 3000);
        const poll = setInterval(() => {
          const i = buf.findIndex((m) => pred(m as { kind?: unknown }));
          if (i >= 0) {
            clearTimeout(timer);
            clearInterval(poll);
            resolve(buf.splice(i, 1)[0] as { kind?: unknown } & Record<string, unknown>);
          }
        }, 5);
      });

    ws.send(JSON.stringify({ v: 1, kind: 'tunnel-register', deviceId: 'daemon-lan' }));
    await next((m) => m.kind === 'tunnel-registered');
    ws.send(JSON.stringify({ v: 1, kind: 'ui-publish', urlCode: CODE, exp: Date.now() + 600_000, lan: LAN }));
    const ack = await next((m) => m.kind === 'ui-published');
    expect(ack.urlCode).toBe(CODE);
    expect(relay.tunnel.getLanHints(CODE)).toEqual(LAN);

    // lan inválida: mismo ack, sin hints.
    ws.send(JSON.stringify({ v: 1, kind: 'ui-publish', urlCode: CODE, exp: Date.now() + 600_000, lan: { code: 'x' } }));
    const ack2 = await next((m) => m.kind === 'ui-published');
    expect(ack2.urlCode).toBe(CODE);
    expect(relay.tunnel.getLanHints(CODE)).toBeNull();
  });
});

describe('fast-path LAN: aviso visible wait-lan-check + contrato libredeck:lanProbe', () => {
  // Extrae el JSON de hints y el JS del probe del HTML renderizado.
  function extractProbe(html: string): { lanJson: string; script: string } {
    const jsonM = html.match(/<script id="lan-hints" type="application\/json">([\s\S]*?)<\/script>/);
    expect(jsonM).not.toBeNull();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
    // El probe es el bloque que menciona lan-hints (el poll no lo hace).
    const probe = scripts.find((s) => s.includes('lan-hints'));
    expect(probe).toBeDefined();
    return { lanJson: jsonM![1] ?? '', script: probe ?? '' };
  }

  function makeSandbox(lanJson: string, fetchMock: (url: string, opt?: unknown) => Promise<unknown>) {
    const store = new Map<string, string>();
    const sessionStorage = {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
    };
    const els: Record<string, { textContent: string; hidden: boolean }> = {
      'lan-hints': { textContent: lanJson, hidden: false },
      'wait-lan': { textContent: '', hidden: true },
      'wait-lan-check': { textContent: '', hidden: false },
    };
    const document = {
      getElementById: (id: string) => els[id] ?? null,
    };
    const location = {
      pathname: '/ui/abc123',
      replaced: null as string | null,
      replace(url: string) {
        this.replaced = url;
      },
    };
    return { store, sessionStorage, els, document, location, fetchMock };
  }

  async function runProbe(
    sb: ReturnType<typeof makeSandbox>,
    script: string,
  ): Promise<void> {
    // Ejecuta el IIFE del probe con los globales simulados (el producto no
    // usa eval ni handlers inline; aquí solo el test interpreta el string).
    const fn = new Function('document', 'location', 'sessionStorage', 'fetch', script);
    // `fetch` del sandbox devuelve la promesa simulada; AbortController y
    // temporizadores son los reales de bun (el probe los limpia al resolver).
    (fn as (...args: unknown[]) => void)(sb.document, sb.location, sb.sessionStorage, sb.fetchMock);
    // Deja asentar las promesas del fetch simulado + json().
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
  }

  test('con lan: pinta wait-lan-check visible con el texto ES/EN', () => {
    const es = renderWaitingPage('abc123', 'es', LAN);
    expect(es).toContain('id="wait-lan-check"');
    expect(es).toContain('Comprobando si estás en la misma red local…');
    // Visible mientras el probe corre: sin hidden en ese <p>.
    expect(es).not.toContain('id="wait-lan-check" hidden');
    // El wait-lan de éxito sigue oculto hasta el redirect.
    expect(es).toContain('id="wait-lan" hidden');
    const en = renderWaitingPage('abc123', 'en', LAN);
    expect(en).toContain('id="wait-lan-check"');
    expect(en).toContain('Checking whether you are on the same local network…');
  });

  test('con lan: el script declara el contrato libredeck:lanProbe en ambos caminos', () => {
    const html = renderWaitingPage('abc123', 'es', LAN);
    const { script } = extractProbe(html);
    expect(script).toContain('libredeck:lanProbe');
    expect(script).toContain('wait-lan-check');
    // Éxito: guarda ok:true + ip antes de redirigir.
    expect(script).toContain('lanRedirect:');
    expect(script).toContain('location.replace');
    // Fracaso total: oculta el aviso sin tocar nada más.
    expect(script).toContain('hidden=true');
    // Sin eval ni handlers inline (CSP del resto del fichero).
    expect(script).not.toContain('eval(');
    expect(script).not.toContain('onload=');
    expect(script).not.toContain('onclick=');
  });

  test('con lan + fetch ok (fp coincide): redirige y guarda probe ok:true', async () => {
    const html = renderWaitingPage('abc123', 'es', LAN);
    const { lanJson, script } = extractProbe(html);
    const sb = makeSandbox(lanJson, async () => ({
      ok: true,
      json: async () => ({ fp: 'fp-test-123', frontendPort: 3002 }),
    }));
    await runProbe(sb, script);
    // Redirección única a la LAN con invite + fallback al relay.
    expect(sb.location.replaced).toContain('http://192.168.1.10:3002/?invite=');
    expect(sb.location.replaced).toContain('relayFallback=abc123');
    // Aviso de éxito visible (comportamiento actual intacto).
    expect(sb.els['wait-lan']!.hidden).toBe(false);
    // Contrato con el frontend: probe ok:true con ip y tiempos.
    const raw = sb.store.get('libredeck:lanProbe');
    expect(raw).toBeDefined();
    const probe = JSON.parse(raw as string);
    expect(probe).toMatchObject({ urlCode: 'abc123', tried: true, ok: true, ip: '192.168.1.10' });
    expect(Array.isArray(probe.ips)).toBe(true);
    expect(typeof probe.ms).toBe('number');
    expect(typeof probe.ts).toBe('number');
  });

  test('con lan + fetch ko (todo falla): oculta wait-lan-check y guarda probe ok:false', async () => {
    const html = renderWaitingPage('abc123', 'es', LAN);
    const { lanJson, script } = extractProbe(html);
    const sb = makeSandbox(lanJson, async () => ({ ok: false }));
    await runProbe(sb, script);
    // Sin redirect: la tarjeta pending sigue igual…
    expect(sb.location.replaced).toBeNull();
    expect(sb.els['wait-lan']!.hidden).toBe(true);
    // …pero el aviso de comprobación desaparece.
    expect(sb.els['wait-lan-check']!.hidden).toBe(true);
    // Contrato con el frontend: probe ok:false con tiempos.
    const raw = sb.store.get('libredeck:lanProbe');
    expect(raw).toBeDefined();
    const probe = JSON.parse(raw as string);
    expect(probe).toMatchObject({ urlCode: 'abc123', tried: true, ok: false });
    expect(Array.isArray(probe.ips)).toBe(true);
    expect(typeof probe.ms).toBe('number');
    expect(typeof probe.ts).toBe('number');
    expect('ip' in probe).toBe(false);
  });

  test('sin lan: ni wait-lan-check ni lan-hints ni script de probe', () => {
    for (const lang of ['es', 'en'] as const) {
      const html = renderWaitingPage('abc123', lang);
      expect(html).not.toContain('wait-lan-check');
      expect(html).not.toContain('lan-hints');
      expect(html).not.toContain('libredeck:lanProbe');
      expect(html).not.toContain('wait-lan');
      expect(html).toContain('setInterval');
    }
    expect(renderWaitingPage('abc123', 'es', null)).not.toContain('wait-lan-check');
    expect(renderWaitingPage('abc123', 'es', undefined)).not.toContain('wait-lan-check');
  });
});
