/**
 * plugin-settings.test.ts — ajustes generales por plugin (menú ⋯):
 * get/save con validación contra settingsSchema + fallback en handlers.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-settings-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService } from '../db';
import { PluginLoader } from '../plugin-loader';
import { ActionRunner } from '../action-runner';

let db: DatabaseService;
let loader: PluginLoader;
let runner: ActionRunner;

beforeAll(async () => {
  await initDatabase();
  db = new DatabaseService();
  loader = new PluginLoader();
  const anyLoader = loader as any;
  try { await anyLoader.watcher?.close(); } catch {}
  anyLoader.watcher = undefined;
  runner = new ActionRunner(loader);
});

describe('Ajustes por plugin', () => {
  it('bundle expone schema + instrucciones + valores (obs)', () => {
    const b = loader.getPluginSettingsBundle('obs');
    expect(b.schema).not.toBeNull();
    expect(b.schema.properties.host).toBeDefined();
    expect(b.schema.properties.password).toBeDefined();
    expect(typeof b.instructions).toBe('string');
    expect(b.instructions).toMatch(/OBS/);
    expect(b.values).toEqual({});
  });

  it('valida required y guarda (homeassistant)', () => {
    expect(() => loader.savePluginSettings('homeassistant', { baseUrl: 'http://x:8123' }))
      .toThrow(/token/);
    const values = loader.savePluginSettings('homeassistant', {
      baseUrl: 'http://homeassistant.local:8123',
      token: 'secreto',
    });
    expect(values.baseUrl).toBe('http://homeassistant.local:8123');
    expect(db.getSetting('plugin.homeassistant.token')).toBe('secreto');
    // Vacío elimina la clave
    loader.savePluginSettings('homeassistant', { token: '' });
    expect(db.getSetting('plugin.homeassistant.token')).toBeNull();
  });

  it('valida tipos (números/booleanos/enums)', () => {
    expect(() => loader.savePluginSettings('obs', { port: 'no-numero' })).toThrow(/número/);
    expect(() => loader.savePluginSettings('obs', { port: 99999 })).toThrow(/máximo/);
    loader.savePluginSettings('obs', { host: 'mi-obs', port: 4456 });
    expect(db.getSetting('plugin.obs.host')).toBe('mi-obs');
  });

  it('los handlers usan los ajustes como fallback (spotify sin token en params)', async () => {
    loader.savePluginSettings('spotify', { token: 'tok-ajustes' });
    // Sin red real: el handler debe intentar con el token de ajustes y fallar
    // por conexión, NO por "falta token".
    const res = await runner.executeAction(
      { type: 'spotify.like', parameters: {} },
      { timestamp: Date.now() }
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').not.toMatch(/Falta el token/);
  });

  it('clave inválida se rechaza', () => {
    expect(() => loader.savePluginSettings('obs', { 'a.b': 'x' })).toThrow(/inválida/);
  });

  it('plugin desconocido lanza', () => {
    expect(() => loader.getPluginSettingsBundle('no-existe')).toThrow();
  });
});
