/**
 * discord-bundle-status.test.ts — el bundle de ajustes de Discord reporta
 * estado REAL (Bug 2): sin token → needs-auth; token vigente → authorized;
 * caducado → token-expired; sin Client ID resoluble → not-configured.
 * El contrato genérico para otros plugins (Spotify) queda intacto.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-discord-bundle-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService } from '../db';
import { PluginLoader, getDiscordBundleStatus } from '../plugin-loader';

let db: DatabaseService;
let loader: PluginLoader;

beforeAll(async () => {
  await initDatabase();
  db = new DatabaseService();
  loader = new PluginLoader();
  const anyLoader = loader as any;
  try { await anyLoader.watcher?.close(); } catch {}
  anyLoader.watcher = undefined;
});

function saveDiscord(values: Record<string, any>) {
  // Limpia claves discord previas para aislar cada caso.
  for (const k of ['clientId', 'clientSecret', 'redirectUri', 'proxyUrl', 'accessToken', 'refreshToken', 'tokenExpiresAt', 'mode']) {
    if (!(k in values)) loader.savePluginSettings('discord', { [k]: '' });
  }
  if (Object.keys(values).length > 0) loader.savePluginSettings('discord', values);
}

describe('bundle Discord: estado real (sin token / válido / caducado)', () => {
  it('sin token → needs-auth, configured:false', () => {
    saveDiscord({});
    const b = loader.getPluginSettingsBundle('discord');
    expect(b.configured).toBe(false);
    expect(b.missing).toContain('accessToken');
    expect((b as any).discordStatus).toBe('needs-auth');
  });

  it('con token vigente → authorized, configured:true', () => {
    saveDiscord({
      accessToken: 'tok-valido-abcdefghij',
      refreshToken: 'ref-1',
      tokenExpiresAt: String(Date.now() + 3600_000),
    });
    const b = loader.getPluginSettingsBundle('discord');
    expect(b.configured).toBe(true);
    expect(b.missing).toEqual([]);
    expect((b as any).discordStatus).toBe('authorized');
  });

  it('con token caducado → token-expired, configured:false', () => {
    saveDiscord({
      accessToken: 'tok-viejo-abcdefghij',
      refreshToken: 'ref-1',
      tokenExpiresAt: String(Date.now() - 5000),
    });
    const b = loader.getPluginSettingsBundle('discord');
    expect(b.configured).toBe(false);
    expect(b.missing).toContain('accessToken');
    expect((b as any).discordStatus).toBe('token-expired');
  });

  it('con zero-config baked-in, vacío → needs-auth (not-configured solo si el baked-in/env son placeholders)', () => {
    const st = getDiscordBundleStatus({});
    expect(st.status).toBe('needs-auth');
    expect(st.configured).toBe(false);
  });
});

describe('bundle genérico intacto (Spotify)', () => {
  it('spotify no trae discordStatus y sigue el contrato genérico', () => {
    const b = loader.getPluginSettingsBundle('spotify') as any;
    expect('discordStatus' in b).toBe(false);
    expect(typeof b.configured).toBe('boolean');
    expect(Array.isArray(b.missing)).toBe(true);
  });
});
