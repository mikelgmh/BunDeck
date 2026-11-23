/**
 * native-plugins-load.test.ts — regresión: TODOS los plugins nativos deben
 * cargarse en el PluginLoader.
 *
 * Bug: `BUILT_IN_IDS` solo listaba 15 ids mientras `installBuiltInPlugins`
 * registra 42. Los 27 restantes (discord, timer, flow, clipboard, ...) se
 * trataban como externos, fallaban con "registrado pero sin carpeta" en
 * cada arranque y sus acciones NO aparecían en GET /plugins/actions
 * (la biblioteca de acciones de la UI salía incompleta y tardaba en
 * "cargar" lo que nunca llegaba).
 *
 * Nota de suite: `action-runner.test.ts` instala un mock.module('../db')
 * GLOBAL al proceso; este fichero siembra sus propios registros para ser
 * hermético tanto en aislado (DB real) como en suite completa (mock).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-native-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService } from '../db';
import { PluginLoader, isBuiltIn } from '../plugin-loader';
import { getNativeManifests } from '../plugins/index';

let loader: PluginLoader;

beforeAll(async () => {
  process.env.LIBREDECK_DATA_DIR = TMP;
  await initDatabase();
  // Siembra hermética: los 42 nativos habilitados, con o sin DB real.
  const db = new DatabaseService();
  const now = Date.now();
  for (const m of getNativeManifests() as any[]) {
    db.installPlugin({
      id: m.id,
      name: m.name,
      version: m.version,
      manifest: m,
      enabled: 1,
      installed_at: now,
    } as any);
  }
  loader = new PluginLoader();
  // Cerrar el watcher de chokidar: como en plugin-loader.test.ts, los tests
  // hacen load explícito y así se evita ruido del FS.
  const anyLoader = loader as any;
  try { await anyLoader.watcher?.close(); } catch {}
  anyLoader.watcher = undefined;
});

afterAll(() => {
  try { (loader as any).dispose?.(); } catch {}
});

describe('native plugins load', () => {
  it('isBuiltIn cubre todos los manifiestos nativos', () => {
    const natives = getNativeManifests();
    expect(natives.length).toBeGreaterThan(15);
    const missing = natives
      .map((m: any) => m?.id)
      .filter((id: string) => !isBuiltIn(id));
    expect(missing).toEqual([]);
  });

  it('loadAllPlugins carga todos los nativos con sus acciones', async () => {
    await loader.loadAllPlugins();
    const natives = getNativeManifests();
    expect(loader.getLoadedPlugins().size).toBe(natives.length);

    const actions = loader.getPluginActions();
    // Muestreo de los que antes fallaban con "sin carpeta":
    for (const full of [
      'discord.toggle-mute',
      'timer.start',
      'flow.wait',
      'clipboard.save-slot',
      'multiaction.run-sequence',
      'profile-auto.switch-profile',
      'audio-mixer.app-volume',
      'window-manager.window-action',
    ]) {
      expect(actions.has(full)).toBe(true);
    }
    // 42 plugins suman muy por encima de las 52 acciones de los 15 de antes.
    expect(actions.size).toBeGreaterThan(100);
  });

  it('loadPlugin directo de un nativo sin carpeta en disco', async () => {
    expect(await loader.loadPlugin('timer')).toBe(true);
    expect(loader.getLoadedPlugins().has('timer')).toBe(true);
  });
});
