/**
 * settings-redaction.test.ts — los secretos del relay nunca salen por
 * GET/POST /api/v1/settings (ni lectura, ni eco, ni broadcast con valor).
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-settings-redact-'));
process.env.LIBREDECK_DATA_DIR = TMP;

import { initDatabase, DatabaseService } from '../db';
import { handleSystem } from '../api/system';

let db: DatabaseService;
const services: any = { wsManager: { broadcast: (..._a: any[]) => {} } };

beforeAll(async () => {
  await initDatabase();
  db = new DatabaseService();
});

function ctx(path: string, method: string, query = '') {
  return {
    url: new URL(`http://localhost:3001${path}${query}`),
    method,
    path,
    db,
    services,
  };
}

describe('settings redaction (secretos del relay)', () => {
  it('GET con key secreta devuelve null, no el valor', async () => {
    db.setSetting('remote.relay.deviceToken', 'tok-secreto');
    db.setSetting('remote.relay.signPriv', 'priv-secreto');
    const res = await handleSystem(
      new Request('http://localhost:3001/api/v1/settings?key=remote.relay.deviceToken'),
      ctx('/api/v1/settings', 'GET', '?key=remote.relay.deviceToken'),
    );
    const body = await res!.json();
    expect(body.key).toBe('remote.relay.deviceToken');
    expect(body.value).toBeNull();
  });

  it('GET sin key sanea todos los secretos pero conserva el resto', async () => {
    db.setSetting('remote.relay.deviceToken', 'tok-secreto');
    db.setSetting('ui.appearance', 'dark');
    const res = await handleSystem(
      new Request('http://localhost:3001/api/v1/settings'),
      ctx('/api/v1/settings', 'GET'),
    );
    const body = await res!.json();
    expect(body['remote.relay.deviceToken']).toBeNull();
    expect(body['remote.relay.signPriv'] ?? null).toBeNull();
    expect(body['ui.appearance']).toBe('dark');
  });

  it('POST de secreto confirma sin eco del valor', async () => {
    const res = await handleSystem(
      new Request('http://localhost:3001/api/v1/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'remote.relay.signPriv', value: 'priv-nuevo' }),
      }),
      ctx('/api/v1/settings', 'POST'),
    );
    const body = await res!.json();
    expect(body.key).toBe('remote.relay.signPriv');
    expect(body.value).toBeNull();
    // El valor sí se guarda (solo se oculta en la respuesta).
    expect(db.getSetting('remote.relay.signPriv')).toBe('priv-nuevo');
  });
});
