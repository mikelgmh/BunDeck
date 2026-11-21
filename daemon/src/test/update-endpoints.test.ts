/**
 * update-endpoints.test.ts — endpoints del update gestionado:
 *  - GET /api/v1/version incluye { version, channel: 'stable', buildDate }
 *  - POST /api/v1/admin/prepare-update responde { ok: true } (best-effort)
 *  - Rutas legacy de update siguen en 501 Gone.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-update-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;

import { initDatabase, DatabaseService } from '../db';
import { handleSystem } from '../api/system';
import { handleAdmin } from '../api/admin';

let db: DatabaseService;
const services: any = {};

beforeAll(async () => {
  await initDatabase();
  db = new DatabaseService();
});

function ctx(path: string, method: string) {
  return {
    url: new URL(`http://localhost:3001${path}`),
    method,
    path,
    db,
    services,
  };
}

describe('update gestionado (daemon)', () => {
  it('GET /api/v1/version expone version + channel stable', async () => {
    const res = await handleSystem(
      new Request('http://localhost:3001/api/v1/version'),
      ctx('/api/v1/version', 'GET'),
    );
    expect(res).not.toBeNull();
    const body = await res!.json();
    expect(typeof body.version).toBe('string');
    expect(body.channel).toBe('stable');
    expect(typeof body.buildDate).toBe('string');
  });

  it('POST /api/v1/admin/prepare-update responde ok (checkpoint best-effort)', async () => {
    const res = await handleSystem(
      new Request('http://localhost:3001/api/v1/admin/prepare-update', { method: 'POST' }),
      ctx('/api/v1/admin/prepare-update', 'POST'),
    );
    expect(res).not.toBeNull();
    const body = await res!.json();
    expect(body.ok).toBe(true);
  });

  it('rutas legacy de update siguen en 501', async () => {
    const v = await handleSystem(
      new Request('http://localhost:3001/api/v1/version/check'),
      ctx('/api/v1/version/check', 'GET'),
    );
    expect(v!.status).toBe(501);
    const u = await handleAdmin(
      new Request('http://localhost:3001/api/v1/update', { method: 'POST' }),
      ctx('/api/v1/update', 'POST'),
    );
    expect(u!.status).toBe(501);
  });
});
