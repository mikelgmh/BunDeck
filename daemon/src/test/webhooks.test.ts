/**
 * webhooks.test.ts — webhooks LAN:
 * - CRUD de gestión (crear/listar/obtener/editar/regenerar/borrar)
 * - El disparo por token ejecuta las acciones vía ActionRunner
 * - Origen túnel/relay → 403 (gestión y disparo)
 * - Token inválido → 404; método distinto → 405; deshabilitado → 404
 * - Broadcasts WS `webhook.*` (topic `webhooks`)
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-webhooks-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;

import { initDatabase, DatabaseService } from '../db';
import { handleWebhooks, __resetWebhookLimiterForTests } from '../api/webhooks';
import { markLanContext } from '../http/lan-guard';
import { isAllowedTunnelPath } from '../remote/tunnel';

let db: DatabaseService;

const broadcasts: any[] = [];
const executed: any[] = [];
const services: any = {
  wsManager: {
    broadcast: (type: string, payload: any, topic?: string) => {
      broadcasts.push({ type, payload, topic });
    },
  },
  actionRunner: {
    executeAction: async (action: any, context: any) => {
      executed.push({ action, context });
      return { success: true, result: { action: action.type } };
    },
  },
};

function ctx(path: string, method: string) {
  return {
    url: new URL(`http://localhost:3001${path}`),
    method,
    path,
    db,
    services,
  };
}

function req(path: string, method: string, body?: any) {
  return new Request(`http://localhost:3001${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Marca la petición como llegada por el túnel/relay. */
function tunnelReq(path: string, method: string, body?: any) {
  const r = req(path, method, body);
  markLanContext(r, { via: 'tunnel', peerIp: null });
  return r;
}

let created: any;

beforeAll(async () => {
  process.env.LIBREDECK_DATA_DIR = TMP;
  await initDatabase();
  db = new DatabaseService();
});

describe('webhooks: CRUD de gestión', () => {
  it('POST crea con token de 256 bits y valores por defecto', async () => {
    const res = await handleWebhooks(
      req('/api/v1/webhooks', 'POST', { name: 'Casa', actions: [{ type: 'local.toast', parameters: { text: 'hola' } }] }),
      ctx('/api/v1/webhooks', 'POST'),
    );
    expect(res!.status).toBe(201);
    created = await res!.json();
    expect(created.id).toBeString();
    expect(created.name).toBe('Casa');
    expect(created.token).toMatch(/^[0-9a-f]{64}$/);
    expect(created.method).toBe('POST');
    expect(created.enabled).toBe(1);
    expect(broadcasts.some((b) => b.type === 'webhook.created' && b.topic === 'webhooks')).toBe(true);
  });

  it('GET lista los webhooks', async () => {
    const res = await handleWebhooks(req('/api/v1/webhooks', 'GET'), ctx('/api/v1/webhooks', 'GET'));
    const list = await res!.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((w: any) => w.id === created.id)).toBe(true);
  });

  it('PUT edita nombre/método/acciones y emite updated', async () => {
    broadcasts.length = 0;
    const res = await handleWebhooks(
      req(`/api/v1/webhooks/${created.id}`, 'PUT', {
        name: 'Casa 2',
        method: 'get',
        actions: [{ type: 'local.toast', parameters: { text: 'x' } }, { type: 'local.toast', parameters: { text: 'y' } }],
      }),
      ctx(`/api/v1/webhooks/${created.id}`, 'PUT'),
    );
    const body = await res!.json();
    expect(body.name).toBe('Casa 2');
    expect(body.method).toBe('GET');
    expect(body.actions.length).toBe(2);
    expect(broadcasts.some((b) => b.type === 'webhook.updated')).toBe(true);
  });

  it('POST regenerate rota el token', async () => {
    const res = await handleWebhooks(
      req(`/api/v1/webhooks/${created.id}/regenerate`, 'POST'),
      ctx(`/api/v1/webhooks/${created.id}/regenerate`, 'POST'),
    );
    const body = await res!.json();
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.token).not.toBe(created.token);
    created = body;
  });

  it('rechaza acciones inválidas y métodos inválidos', async () => {
    const bad = await handleWebhooks(
      req('/api/v1/webhooks', 'POST', { name: 'x', actions: [{ nope: 1 }] }),
      ctx('/api/v1/webhooks', 'POST'),
    );
    expect(bad!.status).toBe(400);
    const badMethod = await handleWebhooks(
      req('/api/v1/webhooks', 'POST', { name: 'x', method: 'BREW' }),
      ctx('/api/v1/webhooks', 'POST'),
    );
    expect(badMethod!.status).toBe(400);
  });
});

describe('webhooks: veto en túnel/relay (defensa en profundidad)', () => {
  it('isAllowedTunnelPath deniega gestión y disparo', () => {
    expect(isAllowedTunnelPath('/api/v1/webhooks')).toBe(false);
    expect(isAllowedTunnelPath('/api/v1/webhooks/abc123')).toBe(false);
    // El resto de la API sigue pasando por el túnel.
    expect(isAllowedTunnelPath('/api/v1/profiles')).toBe(true);
    expect(isAllowedTunnelPath('/api/v1/actions/execute')).toBe(true);
  });
});

describe('webhooks: disparo por token', () => {
  it('dispara las acciones en orden y cuenta el trigger', async () => {
    __resetWebhookLimiterForTests();
    executed.length = 0;
    broadcasts.length = 0;
    const res = await handleWebhooks(
      req(`/api/v1/webhooks/${created.token}`, 'GET'),
      ctx(`/api/v1/webhooks/${created.token}`, 'GET'),
    );
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(body.results.length).toBe(2);
    expect(executed.length).toBe(2);
    expect(executed[0].context.source).toBe('webhook');
    expect(executed[0].context.webhookId).toBe(created.id);
    const row = db.getWebhook(created.id)!;
    expect(row.trigger_count).toBe(1);
    expect(row.last_triggered_at).toBeNumber();
    expect(broadcasts.some((b) => b.type === 'webhook.triggered' && b.topic === 'webhooks')).toBe(true);
  });

  it('token inválido → 404', async () => {
    const badToken = 'b'.repeat(64);
    const badPath = `/api/v1/webhooks/${badToken}`;
    const res = await handleWebhooks(
      req(badPath, 'POST'),
      ctx(badPath, 'POST'),
    );
    expect(res!.status).toBe(404);
  });

  it('método distinto al configurado → 405', async () => {
    const res = await handleWebhooks(
      req(`/api/v1/webhooks/${created.token}`, 'POST'),
      ctx(`/api/v1/webhooks/${created.token}`, 'POST'),
    );
    expect(res!.status).toBe(405);
  });

  it('deshabilitado → 404 (no filtra existencia)', async () => {
    db.updateWebhook(created.id, { enabled: 0 });
    executed.length = 0;
    const res = await handleWebhooks(
      req(`/api/v1/webhooks/${created.token}`, 'GET'),
      ctx(`/api/v1/webhooks/${created.token}`, 'GET'),
    );
    expect(res!.status).toBe(404);
    expect(executed.length).toBe(0);
    db.updateWebhook(created.id, { enabled: 1 });
  });

  it('origen túnel/relay → 403 en disparo y en gestión', async () => {
    const trig = await handleWebhooks(
      tunnelReq(`/api/v1/webhooks/${created.token}`, 'GET'),
      ctx(`/api/v1/webhooks/${created.token}`, 'GET'),
    );
    expect(trig!.status).toBe(403);
    expect((await trig!.json()).code).toBe('WEBHOOK_RELAY_FORBIDDEN');
    const mgmt = await handleWebhooks(
      tunnelReq('/api/v1/webhooks', 'GET'),
      ctx('/api/v1/webhooks', 'GET'),
    );
    expect(mgmt!.status).toBe(403);
    const create = await handleWebhooks(
      tunnelReq('/api/v1/webhooks', 'POST', { name: 'evil' }),
      ctx('/api/v1/webhooks', 'POST'),
    );
    expect(create!.status).toBe(403);
  });

  it('DELETE borra y emite deleted', async () => {
    broadcasts.length = 0;
    const res = await handleWebhooks(
      req(`/api/v1/webhooks/${created.id}`, 'DELETE'),
      ctx(`/api/v1/webhooks/${created.id}`, 'DELETE'),
    );
    expect((await res!.json()).ok).toBe(true);
    expect(db.getWebhook(created.id)).toBeNull();
    expect(broadcasts.some((b) => b.type === 'webhook.deleted')).toBe(true);
  });
});
