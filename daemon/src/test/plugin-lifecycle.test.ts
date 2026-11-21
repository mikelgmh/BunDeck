/**
 * plugin-lifecycle.test.ts — ciclo de vida marketplace:
 * install (staging/atómico) → enable/disable → update → rollback,
 * y disabled-no-ejecuta.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-lifecycle-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase } from '../db';
import { PluginLoader } from '../plugin-loader';

let loader: PluginLoader;

function writeSrcPlugin(dir: string, manifest: any, mainJs: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'main.js'), mainJs);
}

function manifest(id: string, version: string, extra: any = {}) {
  return {
    id, name: `P ${id}`, version, permissions: [],
    actions: [{ id: 'ping', name: 'Ping' }],
    ...extra,
  };
}

beforeAll(async () => {
  await initDatabase();
  loader = new PluginLoader();
  const anyLoader = loader as any;
  try { await anyLoader.watcher?.close(); } catch {}
  anyLoader.watcher = undefined;
});

afterAll(() => {
  try { loader.dispose(); } catch {}
});

describe('Plugin lifecycle (marketplace)', () => {
  it('install desde directorio + enable/disable gobierna la carga', async () => {
    const src = path.join(TMP, 'src-lc1');
    writeSrcPlugin(src, manifest('lc1', '1.0.0'), [
      'export function register(api) {',
      "  api.onAction('ping', async () => 'pong-1');",
      '}',
    ].join('\n'));

    const id = await loader.installPluginFromDirectory(src, { enabled: true });
    expect(id).toBe('lc1');
    expect(loader.getPlugin('lc1')).toBeDefined();
    const h1 = loader.getExternalHandler('lc1.ping') as Function;
    expect(await h1({}, {})).toBe('pong-1');

    // Disable: se descarga y loadPlugin sin force no lo carga
    await loader.disablePlugin('lc1');
    expect(loader.getPlugin('lc1')).toBeUndefined();
    expect(await loader.loadPlugin('lc1')).toBe(false);

    // Enable: vuelve a cargar
    expect(await loader.enablePlugin('lc1')).toBe(true);
    const h2 = loader.getExternalHandler('lc1.ping') as Function;
    expect(await h2({}, {})).toBe('pong-1');

    await loader.uninstallPlugin('lc1');
    expect(loader.getPlugin('lc1')).toBeUndefined();
  });

  it('descubrimiento FS registra deshabilitado y no ejecuta', async () => {
    const dir = path.join(TMP, 'plugins', 'lc-fs');
    writeSrcPlugin(dir, manifest('lc-fs', '1.0.0'), [
      'export function register(api) {',
      "  api.onAction('ping', async () => 'hola');",
      '}',
    ].join('\n'));
    // Simula arranque: loadAllPlugins no debe cargar el FS no registrado
    await loader.loadAllPlugins();
    expect(loader.getPlugin('lc-fs')).toBeUndefined();
    // Pero queda registrado deshabilitado
    const st = loader.getStatus('lc-fs');
    expect(st).not.toBeNull();
    expect(st.enabled).toBe(false);
    await loader.uninstallPlugin('lc-fs');
  });

  it('update atómico + rollback', async () => {
    const srcV1 = path.join(TMP, 'src-lc2-v1');
    writeSrcPlugin(srcV1, manifest('lc2', '1.0.0'), [
      'export function register(api) {',
      "  api.onAction('ping', async () => 'v1');",
      '}',
    ].join('\n'));
    await loader.installPluginFromDirectory(srcV1, { enabled: true });
    expect(await (loader.getExternalHandler('lc2.ping') as Function)({}, {})).toBe('v1');

    const srcV2 = path.join(TMP, 'src-lc2-v2');
    writeSrcPlugin(srcV2, manifest('lc2', '1.1.0'), [
      'export function register(api) {',
      "  api.onAction('ping', async () => 'v2');",
      '}',
    ].join('\n'));
    await loader.updatePlugin('lc2', { dir: srcV2 });
    expect(loader.getStatus('lc2').version).toBe('1.1.0');
    expect(await (loader.getExternalHandler('lc2.ping') as Function)({}, {})).toBe('v2');

    // Rollback a v1
    expect(await loader.rollbackPlugin('lc2')).toBe(true);
    expect(loader.getStatus('lc2').version).toBe('1.0.0');
    expect(await (loader.getExternalHandler('lc2.ping') as Function)({}, {})).toBe('v1');

    await loader.uninstallPlugin('lc2');
  });

  it('downgrade bloqueado sin force + update roto revierte', async () => {
    const srcV2 = path.join(TMP, 'src-lc3-v2');
    writeSrcPlugin(srcV2, manifest('lc3', '2.0.0'), [
      'export function register(api) {',
      "  api.onAction('ping', async () => 'v2');",
      '}',
    ].join('\n'));
    await loader.installPluginFromDirectory(srcV2, { enabled: true });

    const srcV1 = path.join(TMP, 'src-lc3-v1');
    writeSrcPlugin(srcV1, manifest('lc3', '1.0.0'), [
      'export function register(api) {',
      "  api.onAction('ping', async () => 'v1');",
      '}',
    ].join('\n'));
    let err: Error | null = null;
    try { await loader.updatePlugin('lc3', { dir: srcV1 }); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(loader.getStatus('lc3').version).toBe('2.0.0');

    // Update con manifest inválido no toca la versión activa
    const srcBad = path.join(TMP, 'src-lc3-bad');
    fs.mkdirSync(srcBad, { recursive: true });
    fs.writeFileSync(path.join(srcBad, 'manifest.json'), JSON.stringify({ id: 'lc3', name: 'x' }));
    fs.writeFileSync(path.join(srcBad, 'main.js'), 'export function register(){}');
    err = null;
    try { await loader.updatePlugin('lc3', { dir: srcBad }); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(loader.getStatus('lc3').version).toBe('2.0.0');
    expect(await (loader.getExternalHandler('lc3.ping') as Function)({}, {})).toBe('v2');

    await loader.uninstallPlugin('lc3');
  });
});
