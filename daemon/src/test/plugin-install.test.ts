/**
 * plugin-install.test.ts — instalación de plugins (ZIP, directorio, git,
 * autodetección Elgato) con progreso y broadcast WS.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-install-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase } from '../db';
import { PluginLoader } from '../plugin-loader';

let loader: PluginLoader;
const wsEvents: any[] = [];

function writeSrcPlugin(dir: string, manifest: any, mainJs: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'main.js'), mainJs);
}

function manifest(id: string, version = '1.0.0') {
  return {
    id, name: `P ${id}`, version, permissions: [],
    actions: [{ id: 'ping', name: 'Ping' }],
  };
}

function zipOf(srcDir: string, zipPath: string): void {
  const zip = new AdmZip();
  zip.addLocalFolder(srcDir);
  zip.writeZip(zipPath);
}

async function gitAvailable(): Promise<boolean> {
  try {
    const p = Bun.spawn(['git', '--version'], { stdout: 'pipe', stderr: 'pipe' });
    await p.exited;
    return p.exitCode === 0;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  await initDatabase();
  loader = new PluginLoader();
  const anyLoader = loader as any;
  try { await anyLoader.watcher?.close(); } catch {}
  anyLoader.watcher = undefined;
  loader.setWebSocketManager({
    broadcast: (eventType: string, payload: any, topic?: string) => {
      wsEvents.push({ eventType, payload, topic });
    },
  });
});

afterAll(() => {
  try { loader.dispose(); } catch {}
});

describe('Instalación de plugins', () => {
  it('instala desde ZIP con progreso y broadcast', async () => {
    wsEvents.length = 0;
    const src = path.join(TMP, 'src-zip-ok');
    writeSrcPlugin(src, manifest('zipok', '1.2.0'), [
      'export function register(api) {',
      "  api.onAction('ping', async () => 'pong-zip');",
      '}',
    ].join('\n'));
    const zipPath = path.join(TMP, 'zipok.zip');
    zipOf(src, zipPath);

    const stages: string[] = [];
    const id = await loader.installPluginFromZip(zipPath, {
      onProgress: (s) => stages.push(s),
    });
    expect(id).toBe('zipok');
    expect(loader.getPlugin('zipok')).toBeDefined();
    expect(await (loader.getExternalHandler('zipok.ping') as Function)({}, {})).toBe('pong-zip');
    // Progreso por callback y por WS
    for (const want of ['extract', 'validate', 'activate', 'load', 'done']) {
      expect(stages).toContain(want);
    }
    const wsStages = wsEvents.filter((e) => e.eventType === 'plugin.install-progress').map((e) => e.payload.stage);
    for (const want of ['validate', 'activate', 'load', 'done']) {
      expect(wsStages).toContain(want);
    }
    expect(wsEvents.some((e) => e.eventType === 'plugin.installed' && e.payload.pluginId === 'zipok')).toBe(true);

    await loader.uninstallPlugin('zipok');
    expect(loader.getPlugin('zipok')).toBeUndefined();
    expect(fs.existsSync(path.join(TMP, 'plugins', 'zipok'))).toBe(false);
  });

  it('ZIP sin manifest falla con error visible (callback + WS)', async () => {
    const src = path.join(TMP, 'src-zip-bad');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'readme.txt'), 'nada');
    const zipPath = path.join(TMP, 'bad.zip');
    zipOf(src, zipPath);

    wsEvents.length = 0;
    const stages: string[] = [];
    let err: Error | null = null;
    try {
      await loader.installPluginFromZip(zipPath, { onProgress: (s) => stages.push(s) });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/manifest/i);
    expect(stages).toContain('error');
    expect(wsEvents.some((e) => e.eventType === 'plugin.install-progress' && e.payload.stage === 'error')).toBe(true);
  });

  it('checksum incorrecto se rechaza', async () => {
    const src = path.join(TMP, 'src-zip-sum');
    writeSrcPlugin(src, manifest('zipsum'), 'export function register(api) {}');
    const zipPath = path.join(TMP, 'sum.zip');
    zipOf(src, zipPath);
    await expect(loader.installPluginFromZip(zipPath, { checksum: 'deadbeef' })).rejects.toThrow(/Checksum/i);
  });

  it('detecta y deriva paquetes Elgato (.sdPlugin) al importador', async () => {
    const src = path.join(TMP, 'src-elgato-auto', 'com.auto.demo.sdPlugin');
    writeSrcPlugin(src, {
      UUID: 'com.auto.demo', Name: 'Auto Demo', Version: '2.0.0.0', Author: 'T',
      CodePath: 'bin/plugin.js', Nodejs: { Version: '20' },
      Actions: [{ Name: 'Hola', UUID: 'com.auto.demo.hola', Controllers: ['Keypad'] }],
    }, '// elgato fake\n');
    const id = await loader.installPluginFromDirectory(path.join(TMP, 'src-elgato-auto'));
    expect(id).toBe('com.auto.demo');
    const st = loader.getStatus('com.auto.demo');
    expect(st.status).toBe('needs-runtime');
    expect(st.enabled).toBe(false);
    // Deshabilitado: no carga handlers reales
    expect(loader.getPlugin('com.auto.demo')).toBeUndefined();
    await loader.uninstallPlugin('com.auto.demo');
  });

  it('instala desde repo git local y registra el commit', async () => {
    if (!(await gitAvailable())) {
      console.warn('git no disponible: se omite test de instalación git');
      return;
    }
    const repo = path.join(TMP, 'fixture-repo');
    writeSrcPlugin(repo, manifest('gitplug', '0.1.0'), [
      'export function register(api) {',
      "  api.onAction('ping', async () => 'pong-git');",
      '}',
    ].join('\n'));
    const git = (args: string[]) => {
      const p = Bun.spawn(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        cwd: repo, stdout: 'pipe', stderr: 'pipe',
      });
      return p.exited;
    };
    await git(['init']);
    await git(['add', '.']);
    await git(['commit', '-m', 'init']);

    const stages: string[] = [];
    const id = await loader.installPluginFromGit(repo, { onProgress: (s) => stages.push(s) });
    expect(id).toBe('gitplug');
    expect(stages).toContain('clone');
    expect(stages).toContain('done');
    expect(await (loader.getExternalHandler('gitplug.ping') as Function)({}, {})).toBe('pong-git');
    const st = loader.getStatus('gitplug');
    expect(st.commit).toBeTruthy();
    expect(st.sourceType).toBe('git');
    await loader.uninstallPlugin('gitplug');
  });
});
