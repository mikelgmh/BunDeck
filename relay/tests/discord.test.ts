import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../src/store';
import { PairingStore } from '../src/pairing';
import { RelayServer } from '../src/relay';
import { relayCallbackUrl, renderDiscordCallbackPage } from '../src/discord';

const servers: RelayServer[] = [];
const stores: DeviceStore[] = [];

function startRelay(opts: {
  token?: string;
  discordClientId?: string;
  discordClientSecret?: string;
  discordFetchFn?: typeof fetch;
} = {}): RelayServer {
  const dir = mkdtempSync(join(tmpdir(), 'relay-discord-test-'));
  const store = new DeviceStore(dir);
  stores.push(store);
  const relay = new RelayServer({
    token: opts.token ?? 'discord-test-token',
    store,
    pairing: new PairingStore(),
    version: '0.1.0',
    discordClientId: opts.discordClientId,
    discordClientSecret: opts.discordClientSecret,
    discordFetchFn: opts.discordFetchFn,
  });
  relay.listen(0, '127.0.0.1');
  servers.push(relay);
  return relay;
}

afterEach(() => {
  for (const r of servers.splice(0)) r.stop();
  for (const s of stores.splice(0)) s.close();
});

describe('relay discord callback (GET /api/discord/callback)', () => {
  test('público sin token: 200 HTML con auto-captura al daemon local', async () => {
    const relay = startRelay();
    const res = await fetch(`http://127.0.0.1:${relay.port}/api/discord/callback?code=abc123`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('/api/v1/plugins/discord/token-capture');
    expect(html).toContain('127.0.0.1');
    expect(html).toContain('api_port');
  });

  test('sin code explica el flujo en vez de romper', async () => {
    const relay = startRelay();
    const html = await (await fetch(`http://127.0.0.1:${relay.port}/api/discord/callback`)).text();
    expect(html).toContain('code');
  });

  test('relayCallbackUrl construye la https a registrar en Discord', () => {
    const req = new Request('http://localhost:8787/api/discord/callback?code=x');
    expect(relayCallbackUrl(req, 'relay.bundeck.app')).toBe('https://relay.bundeck.app/api/discord/callback');
    expect(relayCallbackUrl(req)).toBe('https://localhost:8787/api/discord/callback');
  });
});

describe('relay discord callback: diagnóstico de auto-entrega', () => {
  test('intenta v1 y fallback legacy, sin sobrescribir errores', () => {
    const html = renderDiscordCallbackPage({ lang: 'es' });
    expect(html).toContain('/api/v1/plugins/discord/token-capture');
    expect(html).toContain('/api/plugins/discord/token-capture');
    // Cadena completa de intentos (ya no `lastErr` con solo el último).
    expect(html).toContain('attempts');
    expect(html).toContain("attempts.join(' | ')");
    expect(html).not.toContain('lastErr');
  });

  test('muestra status + extracto del body de error (primeros 200 chars)', () => {
    const html = renderDiscordCallbackPage({ lang: 'es' });
    expect(html).toContain('HTTP ');
    expect(html).toContain('slice(0,200)');
  });

  test('pista de red local en es y en', () => {
    const es = renderDiscordCallbackPage({ lang: 'es' });
    const en = renderDiscordCallbackPage({ lang: 'en', defaultApiPort: 3001 });
    expect(es).toContain('red local');
    expect(en).toContain('local-network access');
  });
});

describe('relay discord proxy (POST /api/discord/rpc-token)', () => {
  const discordOk = (seen: Array<{ url: string; body: string }>) =>
    (async (url: any, init: any) => {
      seen.push({ url: String(url), body: String(init?.body ?? '') });
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok-relay-abcdef', refresh_token: 'r-relay', expires_in: 3600, token_type: 'Bearer' }) };
    }) as any;

  test('público sin RELAY_TOKEN: code→token contra discord.com con el secret del env', async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const relay = startRelay({ discordClientId: 'cid-1', discordClientSecret: 'sec-1', discordFetchFn: discordOk(seen) });
    const res = await fetch(`http://127.0.0.1:${relay.port}/api/discord/rpc-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'authcode-1', redirect_uri: 'http://127.0.0.1:6463' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.access_token).toBe('tok-relay-abcdef');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://discord.com/api/oauth2/token');
    expect(seen[0].body).toContain('client_secret=sec-1');
    // El secret sale HACIA discord.com, pero NUNCA vuelve al cliente.
    expect(JSON.stringify(data)).not.toContain('sec-1');
  });

  test('refresh_token renueva sin code', async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const relay = startRelay({ discordClientId: 'cid-1', discordClientSecret: 'sec-1', discordFetchFn: discordOk(seen) });
    const res = await fetch(`http://127.0.0.1:${relay.port}/api/discord/rpc-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'old-refresh' }),
    });
    expect(res.status).toBe(200);
    expect(seen[0].body).toContain('grant_type=refresh_token');
    expect(seen[0].body).toContain('refresh_token=old-refresh');
  });

  test('sin secret en env → discord-not-configured (500), sin llamar a discord.com', async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const relay = startRelay({ discordFetchFn: discordOk(seen) });
    const res = await fetch(`http://127.0.0.1:${relay.port}/api/discord/rpc-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'c', redirect_uri: 'http://127.0.0.1:6463' }),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error).toBe('discord-not-configured');
    expect(seen).toHaveLength(0);
  });

  test('propaga el error de Discord tal cual (mismo status)', async () => {
    const relay = startRelay({
      discordClientId: 'cid-1',
      discordClientSecret: 'sec-1',
      discordFetchFn: (async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant', error_description: 'Invalid "code".' }),
      })) as any,
    });
    const res = await fetch(`http://127.0.0.1:${relay.port}/api/discord/rpc-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'bad', redirect_uri: 'http://127.0.0.1:6463' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe('invalid_grant');
  });

  test('CORS abierto + preflight OPTIONS', async () => {
    const relay = startRelay({ discordClientId: 'c', discordClientSecret: 's' });
    const res = await fetch(`http://127.0.0.1:${relay.port}/api/discord/rpc-token`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('rate-limit por IP (31ª → 429)', async () => {
    const relay = startRelay({ discordClientId: 'c', discordClientSecret: 's', discordFetchFn: discordOk([]) });
    const base = `http://127.0.0.1:${relay.port}/api/discord/rpc-token`;
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'c', redirect_uri: 'http://127.0.0.1:6463' }) };
    for (let i = 0; i < 30; i++) {
      const r = await fetch(base, init);
      expect(r.status).toBe(200);
      await r.arrayBuffer();
    }
    const limited = await fetch(base, init);
    expect(limited.status).toBe(429);
  });
});
