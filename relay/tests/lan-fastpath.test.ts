import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../src/store';
import { PairingStore } from '../src/pairing';
import { RelayServer } from '../src/relay';
import { TunnelState, sanitizeLanHints } from '../src/tunnel';
import { renderWaitingPage } from '../src/waiting';

const TOKEN = 'test-relay-token';
const CODE = 'testcode-abc123'; // 15 chars (>= 12)
// Publish: SIN code (nuevo diseño post-aprobación).
const LAN_PUBLISH = {
  ips: ['192.168.1.10'],
  port: 3002,
  apiPort: 3001,
  fp: 'fp-test-123',
  dev: 'PC-Test',
};
// Bind: CON code (invite fresco, solo post-aprobación).
const LAN_BIND = {
  code: 'ABCDEFGHIJKLMNOPQRSTUV', // 22 chars base64url
  ips: ['192.168.1.10'],
  port: 3002,
  apiPort: 3001,
  fp: 'fp-test-123',
  dev: 'PC-Test',
};
const TOK = 'ab'.repeat(32); // 64 hex

function memState(now = Date.now()): { state: TunnelState; socket: { send: () => boolean; close: () => void } } {
  const state = new TunnelState({ now: () => now });
  const socket = { send: () => true, close: () => {} };
  state.registerDevice(socket, 'daemon-lan');
  return { state, socket };
}

describe('sanitizeLanHints con/sin code según flag', () => {
  test('requireCode:false acepta sin code (publish)', () => {
    const r = sanitizeLanHints(LAN_PUBLISH, false);
    expect(r).not.toBeNull();
    expect(r!.ips).toEqual(['192.168.1.10']);
    expect(r!.port).toBe(3002);
    expect(r!.code).toBeUndefined();
  });

  test('requireCode:false conserva code válido (compat daemon viejo), ignora inválido', () => {
    const withValid = sanitizeLanHints(LAN_BIND, false);
    expect(withValid).not.toBeNull();
    expect(withValid!.code).toBe(LAN_BIND.code);
    const withBad = sanitizeLanHints({ ...LAN_PUBLISH, code: 'corto' }, false);
    expect(withBad).not.toBeNull();
    expect(withBad!.code).toBeUndefined();
  });

  test('requireCode:true exige code 16-80 base64url (bind)', () => {
    expect(sanitizeLanHints(LAN_BIND, true)).not.toBeNull();
    expect(sanitizeLanHints(LAN_PUBLISH, true)).toBeNull();
    expect(sanitizeLanHints({ ...LAN_BIND, code: 'corto' }, true)).toBeNull();
    expect(sanitizeLanHints({ ...LAN_BIND, code: 'con espacios no!!!!' }, true)).toBeNull();
    expect(sanitizeLanHints({ ...LAN_BIND, code: '<script>alert(1)</script>0123' }, true)).toBeNull();
  });

  test('ambos modos exigen ips+puertos válidos', () => {
    for (const flag of [false, true] as const) {
      const base = flag ? LAN_BIND : LAN_PUBLISH;
      expect(sanitizeLanHints({ ...base, ips: [] }, flag)).toBeNull();
      expect(sanitizeLanHints({ ...base, ips: ['8.8.8.8'] }, flag)).toBeNull();
      expect(sanitizeLanHints({ ...base, port: 0 }, flag)).toBeNull();
      expect(sanitizeLanHints({ ...base, apiPort: 70000 }, flag)).toBeNull();
    }
  });

  test('ips no-RFC1918 se descartan y se recorta a 4', () => {
    const r = sanitizeLanHints(
      {
        ...LAN_PUBLISH,
        ips: ['8.8.8.8', '10.0.0.1', '172.16.5.4', '192.168.0.2', '172.32.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'],
      },
      false,
    );
    expect(r!.ips).toEqual(['10.0.0.1', '172.16.5.4', '192.168.0.2', '10.0.0.2']);
  });
});

describe('publish sin code + limpieza', () => {
  test('publish sin lan publica igual (hints null)', () => {
    const { state, socket } = memState();
    expect(state.publish(socket, CODE, Date.now() + 600_000)).toEqual({ deviceId: 'daemon-lan' });
    expect(state.getLanHints(CODE)).toBeNull();
  });

  test('publish con hints sin code guarda alcanzabilidad', () => {
    const { state, socket } = memState();
    state.publish(socket, CODE, Date.now() + 600_000, LAN_PUBLISH);
    const h = state.getLanHints(CODE);
    expect(h).not.toBeNull();
    expect(h!.ips).toEqual(['192.168.1.10']);
    expect(h!.code).toBeUndefined();
  });

  test('publish con lan inválida publica sin lan (no falla)', () => {
    const { state, socket } = memState();
    state.publish(socket, CODE, Date.now() + 600_000, { code: 'x' });
    expect(state.getLanHints(CODE)).toBeNull();
  });

  test('republicar/unpublish/prune limpian hints (mueren con el binding)', () => {
    const { state, socket } = memState();
    state.publish(socket, CODE, Date.now() + 600_000, LAN_PUBLISH);
    expect(state.getLanHints(CODE)).not.toBeNull();
    state.publish(socket, CODE, Date.now() + 600_000);
    expect(state.getLanHints(CODE)).toBeNull();
    state.publish(socket, CODE, Date.now() + 600_000, LAN_PUBLISH);
    expect(state.unpublish(CODE)).toBe(true);
    expect(state.getLanHints(CODE)).toBeNull();
    let now = 1_000;
    const st2 = new TunnelState({ now: () => now });
    const sock2 = { send: () => true, close: () => {} };
    st2.registerDevice(sock2, 'd');
    st2.publish(sock2, CODE, 10_000, LAN_PUBLISH);
    now = 11_000;
    st2.prune();
    expect(st2.getLanHints(CODE)).toBeNull();
  });
});

describe('bind guarda lan y status la devuelve UNA vez', () => {
  test('bind con lan válida guarda; status la devuelve una vez (poll2 ya no)', () => {
    const { state, socket } = memState();
    state.publish(socket, CODE, Date.now() + 600_000, LAN_PUBLISH);
    expect(state.bind(CODE, TOK, Date.now() + 600_000, null, LAN_BIND)).toBe('ok');
    const s1 = state.status(CODE) as { status: string; sessionToken?: string; lan?: Record<string, unknown> };
    expect(s1.status).toBe('approved');
    expect(s1.sessionToken).toBe(TOK);
    expect(s1.lan).toEqual({
      code: LAN_BIND.code,
      ips: ['192.168.1.10'],
      port: 3002,
      apiPort: 3001,
      fp: 'fp-test-123',
    });
    // Sin dev en status (contrato fijo).
    expect('dev' in (s1.lan ?? {})).toBe(false);
    const s2 = state.status(CODE) as { status: string; lan?: unknown; sessionToken?: unknown };
    expect(s2.status).toBe('approved');
    expect(s2.lan).toBeUndefined();
    expect(s2.sessionToken).toBeUndefined();
  });

  test('bind con lan inválida responde bad-lan', () => {
    const { state, socket } = memState();
    state.publish(socket, CODE, Date.now() + 600_000, LAN_PUBLISH);
    expect(state.bind(CODE, TOK, Date.now() + 600_000, null, { code: 'x' })).toBe('bad-lan');
    expect(state.bind(CODE, TOK, Date.now() + 600_000, null, LAN_PUBLISH)).toBe('bad-lan'); // sin code
    // Sin lan: ok (compat).
    expect(state.bind(CODE, TOK, Date.now() + 600_000)).toBe('ok');
    const s = state.status(CODE) as { lan?: unknown };
    expect(s.lan).toBeUndefined();
  });

  test('status legacy-sin-sid intacto (sin lan: sin campo lan)', () => {
    const { state, socket } = memState();
    state.publish(socket, CODE, Date.now() + 600_000);
    expect(state.bind(CODE, TOK, Date.now() + 600_000)).toBe('ok');
    const s1 = state.status(CODE) as { status: string; sessionToken?: string; lan?: unknown };
    expect(s1).toEqual({ status: 'approved', sessionToken: TOK });
    const s2 = state.status(CODE) as { status: string };
    expect(s2).toEqual({ status: 'approved' });
  });

  test('dual sid+legacy: primer poll trae sid+ticket+legacy+lan; segundo sin legacy ni lan', () => {
    const now = Date.now();
    const { state, socket } = memState(now);
    state.publish(socket, CODE, now + 600_000, LAN_PUBLISH);
    const SID = 'ab'.repeat(16);
    const SECRET = 'cd'.repeat(32);
    expect(state.bindSid(CODE, SID, SECRET, now + 600_000)).toBe('ok');
    expect(state.bind(CODE, TOK, now + 600_000, null, LAN_BIND)).toBe('ok');
    const s1 = state.status(CODE) as { status: string; sid?: string; ticket?: string; sessionToken?: string; lan?: { code: string } };
    expect(s1.status).toBe('approved');
    expect(typeof s1.sid).toBe('string');
    expect(typeof s1.ticket).toBe('string');
    expect(s1.sessionToken).toBe(TOK);
    expect(s1.lan?.code).toBe(LAN_BIND.code);
    const s2 = state.status(CODE) as { status: string; sessionToken?: unknown; lan?: unknown; sid?: string; ticket?: string };
    expect(s2.status).toBe('approved');
    expect(s2.sessionToken).toBeUndefined();
    expect(s2.lan).toBeUndefined();
    expect(typeof s2.sid).toBe('string');
    expect(typeof s2.ticket).toBe('string');
  });
});

describe('waiting post-aprobación: sin code pre-aprobación', () => {
  // Extrae el JSON de hints y el script de probe (el que menciona lan-hints).
  function extractProbe(html: string): { lanJson: string; probe: string; main: string } {
    const jsonM = html.match(/<script id="lan-hints" type="application\/json">([\s\S]*?)<\/script>/);
    expect(jsonM).not.toBeNull();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
    const probe = scripts.find((s) => s.includes('lan-hints') || s.includes('libredeck:lanProbe') === false ? s.includes('lan-hints') : false);
    // El probe es el bloque que menciona lan-hints; el principal es el del poll (STATUS_URL).
    const probeScript = scripts.find((s) => s.includes('lan-hints')) ?? '';
    const mainScript = scripts.find((s) => s.includes('STATUS_URL')) ?? '';
    expect(probeScript).not.toBe('');
    expect(mainScript).not.toBe('');
    return { lanJson: jsonM![1] ?? '', probe: probeScript, main: mainScript };
  }

  test('HTML inicial con hints NO incluye code (ni invite utilizable)', () => {
    const secret = 'ZZZSECRETCODE12345678';
    const html = renderWaitingPage('abc123', 'es', { ...LAN_PUBLISH, code: secret } as never);
    expect(html).not.toContain(secret);
    // El JSON inyectado es solo alcanzabilidad.
    const m = html.match(/<script id="lan-hints" type="application\/json">([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    const parsed = JSON.parse(m![1] ?? '{}');
    expect('code' in parsed).toBe(false);
    expect(parsed.ips).toEqual(['192.168.1.10']);
    // Sin bloque manual pre-aprobación con invite.
    expect(html).not.toContain('wait-lan-local');
    expect(html).not.toContain('lanRedirect:');
    // Sin eval/handlers inline; escapa </.
    expect(html).not.toContain('eval(');
  });

  test('sin redirect pre-aprobación: el probe NO contiene location.replace; el go() al túnel SÍ sigue', () => {
    const html = renderWaitingPage('abc123', 'es', LAN_PUBLISH);
    const { probe, main } = extractProbe(html);
    expect(probe).not.toContain('location.replace');
    expect(probe).not.toContain('lanRedirect:');
    expect(probe).not.toContain('goLan');
    expect(probe).not.toContain('invite=');
    expect(probe).toContain('libredeck:lanProbe');
    expect(probe).toContain('wait-lan-check');
    // El flujo actual al túnel sigue intacto.
    expect(main).toContain('location.replace');
    expect(main).toContain('/t/');
    expect(main).toContain('/s/');
  });

  test('bloque manual post-approval con href correcto + auto-redirect solo con probe-ok', () => {
    const html = renderWaitingPage('abc123', 'es', LAN_PUBLISH);
    // Bloque oculto post-aprobación (se muestra vía JS cuando data.lan existe).
    expect(html).toContain('id="wait-lan-direct"');
    expect(html).toContain('id="wait-lan-direct-link"');
    const { main } = extractProbe(html);
    // Construye la URL directa post-aprobación con invite+kiosk+fallback.
    expect(main).toContain('invite=');
    expect(main).toContain('kiosk=1');
    expect(main).toContain('relayFallback=');
    expect(main).toContain('wait-lan-direct-link');
    expect(main).toContain('libredeck:lanProbe');
    // Frescura <10min y auto-redirect vía goUrl (mismo go() del túnel).
    expect(main).toContain('10*60*1000');
    expect(main).toContain('goUrl=lanUrl');
  });

  test('textos ES/EN nuevos', () => {
    const es = renderWaitingPage('abc123', 'es', LAN_PUBLISH);
    expect(es).toContain('Estás en la misma red: abre la versión directa');
    expect(es).toContain('Abrir versión directa');
    const en = renderWaitingPage('abc123', 'en', LAN_PUBLISH);
    expect(en).toContain('On the same network: open the direct version');
    expect(en).toContain('Open direct version');
    // Ya no existen las claves viejas pre-aprobación.
    expect(es).not.toContain('Abrir versión local');
    expect(en).not.toContain('Open local version');
  });

  test('el JSON inyectado no permite breakout de </script>', () => {
    const evil = { ...LAN_PUBLISH, fp: '</script>' };
    const html = renderWaitingPage(CODE, 'es', evil);
    expect(html).not.toContain('</script><script>');
    expect(html).toContain('<\\/script>');
  });

  test('probe guarda contrato libredeck:lanProbe y oculta el aviso (ok y ko)', async () => {
    const html = renderWaitingPage('abc123', 'es', LAN_PUBLISH);
    const { lanJson, probe } = extractProbe(html);
    function sandbox(fetchMock: (url: string) => Promise<unknown>) {
      const store = new Map<string, string>();
      return {
        store,
        sessionStorage: {
          getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
          setItem: (k: string, v: string) => { store.set(String(k), String(v)); },
        },
        document: {
          getElementById: (id: string) => {
            if (id === 'lan-hints') return { textContent: lanJson, hidden: false };
            if (id === 'wait-lan-check') return { textContent: '', hidden: false as boolean, _h: false };
            return null;
          },
        },
        location: { pathname: '/ui/abc123', replaced: null as string | null },
        fetchMock,
      };
    }
    // ok:true con fp coincidente
    const sbOk = sandbox(async () => ({ ok: true, json: async () => ({ fp: 'fp-test-123' }) }));
    let hiddenFlag = false;
    const docOk = {
      getElementById: (id: string) => {
        if (id === 'lan-hints') return { textContent: lanJson };
        if (id === 'wait-lan-check') return { set hidden(v: boolean) { hiddenFlag = v; }, get hidden() { return hiddenFlag; } };
        return null;
      },
    };
    const fnOk = new Function('document', 'location', 'sessionStorage', 'fetch', probe);
    (fnOk as (...a: unknown[]) => void)(docOk, sbOk.location, sbOk.sessionStorage, sbOk.fetchMock);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    const rawOk = sbOk.store.get('libredeck:lanProbe');
    expect(rawOk).toBeDefined();
    const pOk = JSON.parse(rawOk as string);
    expect(pOk).toMatchObject({ urlCode: 'abc123', tried: true, ok: true, ip: '192.168.1.10' });
    // ko: todo falla → ok:false, sin ip
    const sbKo = sandbox(async () => ({ ok: false }));
    const fnKo = new Function('document', 'location', 'sessionStorage', 'fetch', probe);
    (fnKo as (...a: unknown[]) => void)(docOk, sbKo.location, sbKo.sessionStorage, sbKo.fetchMock);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    const rawKo = sbKo.store.get('libredeck:lanProbe');
    expect(rawKo).toBeDefined();
    const pKo = JSON.parse(rawKo as string);
    expect(pKo).toMatchObject({ urlCode: 'abc123', tried: true, ok: false });
    expect('ip' in pKo).toBe(false);
  });
});

describe('relay ui-publish/ui-bind con lan (WS)', () => {
  const servers: RelayServer[] = [];
  const stores: DeviceStore[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const s of sockets.splice(0)) {
      try { s.close(); } catch { /* noop */ }
    }
    for (const r of servers.splice(0)) r.stop();
    for (const s of stores.splice(0)) s.close();
    await new Promise((r) => setTimeout(r, 25));
  });

  test('publish sin code + bind con lan: status devuelve lan una vez', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-lan-test-'));
    const store = new DeviceStore(dir);
    stores.push(store);
    const relay = startRelay(store, servers, sockets);
    const { ws, next } = await connectDaemon(relay, sockets);
    ws.send(JSON.stringify({ v: 1, kind: 'tunnel-register', deviceId: 'daemon-lan' }));
    await next((m) => m.kind === 'tunnel-registered');
    ws.send(JSON.stringify({ v: 1, kind: 'ui-publish', urlCode: CODE, exp: Date.now() + 600_000, lan: LAN_PUBLISH }));
    const ack = await next((m) => m.kind === 'ui-published');
    expect(ack.urlCode).toBe(CODE);
    const hints = relay.tunnel.getLanHints(CODE);
    expect(hints?.code).toBeUndefined();
    expect(hints?.ips).toEqual(['192.168.1.10']);
    // Bind legacy con invite.
    ws.send(JSON.stringify({ v: 1, kind: 'ui-bind', urlCode: CODE, sessionToken: TOK, exp: Date.now() + 600_000, lan: LAN_BIND }));
    await next((m) => m.kind === 'ui-bound');
    const base = `http://127.0.0.1:${relay.port}`;
    const s1 = await (await fetch(`${base}/ui/${CODE}/status`)).json();
    expect(s1.status).toBe('approved');
    expect(s1.lan.code).toBe(LAN_BIND.code);
    const s2 = await (await fetch(`${base}/ui/${CODE}/status`)).json();
    expect(s2.lan).toBeUndefined();
  });

  test('bind con lan inválida responde bad-lan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-lan-test-'));
    const store = new DeviceStore(dir);
    stores.push(store);
    const relay = startRelay(store, servers, sockets);
    const { ws, next } = await connectDaemon(relay, sockets);
    ws.send(JSON.stringify({ v: 1, kind: 'tunnel-register', deviceId: 'daemon-lan' }));
    await next((m) => m.kind === 'tunnel-registered');
    ws.send(JSON.stringify({ v: 1, kind: 'ui-publish', urlCode: CODE, exp: Date.now() + 600_000, lan: LAN_PUBLISH }));
    await next((m) => m.kind === 'ui-published');
    ws.send(JSON.stringify({ v: 1, kind: 'ui-bind', urlCode: CODE, sessionToken: TOK, exp: Date.now() + 600_000, lan: { code: 'x' } }));
    const err = await next((m) => m.kind === 'error');
    expect(err.error).toBe('bad-lan');
  });
});

function startRelay(store: DeviceStore, servers: RelayServer[], sockets: WebSocket[]): RelayServer {
  const relay = new RelayServer({ token: TOKEN, store, pairing: new PairingStore() });
  relay.listen(0, '127.0.0.1');
  servers.push(relay);
  return relay;
}

async function connectDaemon(relay: RelayServer, sockets: WebSocket[]): Promise<{ ws: WebSocket; next: (pred: (m: { kind?: unknown }) => boolean) => Promise<{ kind?: unknown } & Record<string, unknown>> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/?token=${TOKEN}`);
  sockets.push(ws);
  const buf: unknown[] = [];
  ws.addEventListener('message', (e) => {
    try { buf.push(JSON.parse(String((e as MessageEvent).data))); } catch { /* noop */ }
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('connect failed')), { once: true });
  });
  const next = (pred: (m: { kind?: unknown }) => boolean): Promise<{ kind?: unknown } & Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => { clearInterval(poll); reject(new Error('timeout')); }, 3000);
      const poll = setInterval(() => {
        const i = buf.findIndex((m) => pred(m as { kind?: unknown }));
        if (i >= 0) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve(buf.splice(i, 1)[0] as { kind?: unknown } & Record<string, unknown>);
        }
      }, 5);
    });
  return { ws, next };
}
