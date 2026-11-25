/**
 * discord-token-capture-rpc.test.ts — `token-capture` devuelve `rpc` y
 * `GET .../rpc-probe` re-sonda sin code (sin red: captura directa de token
 * + actionRunner stub).
 */
import { describe, it, expect } from 'bun:test';
import { handlePlugins } from '../api/plugins';

const TOKEN = {
  access_token: 'tok-directo-abcdefghij1234',
  refresh_token: 'ref-1',
  expires_in: 3600,
  token_type: 'Bearer',
};

function stubServices(status: 'connected' | 'discord-closed' | 'throw') {
  const broadcasts: any[] = [];
  return {
    broadcasts,
    services: {
      pluginLoader: {
        savePluginSettings: (_id: string, values: any) => values,
      },
      wsManager: {
        broadcastPluginSettings: () => {},
        broadcast: () => {},
      },
      actionRunner: {
        executeAction: async () => {
          if (status === 'throw') throw new Error('sin RPC');
          return { success: true, result: { status } };
        },
      },
    },
  };
}

async function call(path: string, method: string, services: any, body?: any) {
  const req = new Request(`http://localhost:3001${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const db = { deleteSetting: () => {} } as any;
  const res = await handlePlugins(req, {
    url: new URL(`http://localhost:3001${path}`),
    method,
    path,
    db,
    services,
  } as any);
  if (!res) throw new Error(`sin handler para ${method} ${path}`);
  return { status: res.status, body: await res.json() };
}

describe('token-capture devuelve rpc (best-effort, sin red)', () => {
  it('RPC ok → rpc: connected (token guardado igual)', async () => {
    const { services } = stubServices('connected');
    const r = await call('/api/v1/plugins/discord/token-capture', 'POST', services, TOKEN);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.rpc).toBe('connected');
    expect(r.body.values.accessToken).toBe(TOKEN.access_token);
  });

  it('Discord cerrado → rpc: closed (token guardado igual)', async () => {
    const { services } = stubServices('discord-closed');
    const r = await call('/api/v1/plugins/discord/token-capture', 'POST', services, TOKEN);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.rpc).toBe('closed');
  });

  it('sonda rota → rpc: unknown (la captura no falla)', async () => {
    const { services } = stubServices('throw');
    const r = await call('/api/v1/plugins/discord/token-capture', 'POST', services, TOKEN);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.rpc).toBe('unknown');
  });
});

describe('GET rpc-probe (reintento sin code)', () => {
  it('connected', async () => {
    const { services } = stubServices('connected');
    const r = await call('/api/v1/plugins/discord/rpc-probe', 'GET', services);
    expect(r.status).toBe(200);
    expect(r.body.rpc).toBe('connected');
  });

  it('closed', async () => {
    const { services } = stubServices('discord-closed');
    const r = await call('/api/v1/plugins/discord/rpc-probe', 'GET', services);
    expect(r.status).toBe(200);
    expect(r.body.rpc).toBe('closed');
  });

  it('sonda rota → unknown, sin 500', async () => {
    const { services } = stubServices('throw');
    const r = await call('/api/v1/plugins/discord/rpc-probe', 'GET', services);
    expect(r.status).toBe(200);
    expect(r.body.rpc).toBe('unknown');
  });
});
