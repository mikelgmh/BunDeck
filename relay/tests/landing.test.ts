import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../src/store';
import { PairingStore } from '../src/pairing';
import { RelayServer } from '../src/relay';

const TOKEN = 'landing-test-token';
const servers: RelayServer[] = [];
const stores: DeviceStore[] = [];

function startRelay(opts: { token?: string; publicHost?: string } = {}): RelayServer {
  const dir = mkdtempSync(join(tmpdir(), 'relay-landing-test-'));
  const store = new DeviceStore(dir);
  stores.push(store);
  const relay = new RelayServer({
    token: opts.token ?? TOKEN,
    store,
    pairing: new PairingStore(),
    version: '0.1.0',
    publicHost: opts.publicHost,
  });
  relay.listen(0, '127.0.0.1');
  servers.push(relay);
  return relay;
}

afterEach(() => {
  for (const r of servers.splice(0)) r.stop();
  for (const s of stores.splice(0)) s.close();
});

describe('relay landing (GET /)', () => {
  test('/ devuelve 200 HTML público con BunDeck y la URL wss', async () => {
    const relay = startRelay();
    const res = await fetch(`http://127.0.0.1:${relay.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('BunDeck');
    expect(html).toContain('wss://');
    expect(html).toContain('RELAY_URL');
  });

  test('/ es pública: no pide token aunque haya RELAY_TOKEN', async () => {
    const relay = startRelay();
    const res = await fetch(`http://127.0.0.1:${relay.port}/`);
    expect(res.status).toBe(200);
  });

  test('/ en JSON si Accept: application/json', async () => {
    const relay = startRelay();
    const res = await fetch(`http://127.0.0.1:${relay.port}/`, {
      headers: { Accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.service).toBe('libredeck-relay');
    expect(typeof body.version).toBe('string');
    expect(typeof body.online).toBe('number');
  });

  test('idioma: default ES, EN según Accept-Language', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}/`;
    const es = await (await fetch(base)).text();
    expect(es).toContain('Cómo conectar');
    const en = await (await fetch(base, { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })).text();
    expect(en).toContain('How to connect');
  });

  test('RELAY_DOMAIN personaliza la URL mostrada', async () => {
    const relay = startRelay({ publicHost: 'bundeck.mikelgranero.com' });
    const html = await (await fetch(`http://127.0.0.1:${relay.port}/`)).text();
    expect(html).toContain('wss://bundeck.mikelgranero.com');
  });

  test('/health sigue JSON (contrato intacto)', async () => {
    const relay = startRelay();
    const res = await fetch(`http://127.0.0.1:${relay.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe('libredeck-relay');
  });

  test('WS sin token sigue rechazado (el upgrade de / exige auth)', async () => {
    const relay = startRelay();
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/`);
    const outcome = await new Promise<string>((resolve) => {
      ws.addEventListener('close', (e) => resolve(`close:${(e as CloseEvent).code}`));
      ws.addEventListener('open', () => resolve('open'));
      setTimeout(() => resolve('timeout'), 3000);
    });
    expect(outcome).not.toBe('open');
    try {
      ws.close();
    } catch {
      /* noop */
    }
  });

  test('POST /pair sin token sigue 401', async () => {
    const relay = startRelay();
    const res = await fetch(`http://127.0.0.1:${relay.port}/pair`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
