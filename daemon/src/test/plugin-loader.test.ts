/**
 * plugin-loader.test.ts — FASE 2 a nivel PluginLoader/ActionRunner.
 *
 * Cubre:
 *  (d) reload limpio tras cambiar `main.js` (nuevo worker, sin fuga de
 *      módulos: el handler antiguo deja de usarse y el nuevo responde).
 *  (e) un plugin de ejemplo con el API histórico `register(api)`/`onAction`
 *      sigue funcionando end-to-end vía ActionRunner, y `emitEvent` propaga
 *      al broadcaster inyectado (antes era no-op).
 *  Extra: un plugin que crashea en register no tumba el loader.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-loader-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase } from '../db';
import { PluginLoader } from '../plugin-loader';
import { ActionRunner } from '../action-runner';

let loader: PluginLoader;
let runner: ActionRunner;

function writePlugin(id: string, manifest: any, mainJs: string): void {
  const dir = path.join(TMP, 'plugins', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'main.js'), mainJs);
}

beforeAll(async () => {
  await initDatabase();
  loader = new PluginLoader();
  // Cerrar el watcher de chokidar: los tests hacen reload explícito y así
  // se evita que el watcher dispare reloads concurrentes al escribir fixtures.
  const anyLoader = loader as any;
  try { await anyLoader.watcher?.close(); } catch {}
  anyLoader.watcher = undefined;
  runner = new ActionRunner(loader);
});

afterAll(() => {
  try { runner.dispose(); } catch {}
  try { loader.dispose(); } catch {}
});

describe('PluginLoader sobre Workers', () => {
  it('(d) reload limpio tras cambiar main.js', async () => {
    const manifest = {
      id: 'replug', name: 'Replug', version: '1.0.0', permissions: [],
      actions: [{ id: 'eco', name: 'Eco' }],
    };
    writePlugin('replug', manifest, [
      'export function register(api) {',
      "  api.onAction('eco', async (params) => 'v1:' + params.v);",
      '}',
    ].join('\n'));

    expect(await loader.loadPlugin('replug')).toBe(true);
    const h1 = loader.getExternalHandler('replug.eco');
    expect(h1).toBeDefined();
    expect(await (h1 as Function)({ v: 'a' }, {})).toBe('v1:a');

    // Cambiar el código y recargar: debe responder el nuevo worker.
    writePlugin('replug', manifest, [
      'export function register(api) {',
      "  api.onAction('eco', async (params) => 'v2:' + params.v);",
      '}',
    ].join('\n'));
    expect(await loader.reloadPlugin('replug')).toBe(true);
    expect(loader.getPluginError('replug')).toBeNull();
    const h2 = loader.getExternalHandler('replug.eco');
    expect(h2).toBeDefined();
    expect(h2).not.toBe(h1); // handler nuevo = worker nuevo, sin fuga de módulos
    expect(await (h2 as Function)({ v: 'b' }, {})).toBe('v2:b');

    loader.unloadPlugin('replug');
    expect(loader.getExternalHandler('replug.eco')).toBeUndefined();
  });

  it('(e) ejemplo register/onAction end-to-end + emitEvent propaga', async () => {
    const broadcasted: any[] = [];
    loader.setWebSocketManager({
      broadcast: (eventType: string, payload: any, topic?: string) => {
        broadcasted.push({ eventType, payload, topic });
      },
    });
    // Mismo API que el plugin de ejemplo de dev.sh (permiso legacy 'emitEvent').
    const manifest = {
      id: 'com.libredeck.ejemplo', name: 'Plugin de Ejemplo', version: '1.0.0',
      description: 'Plugin de demostración', author: 'LibreDeck Team',
      permissions: ['emitEvent'],
      actions: [{ id: 'saludo', name: 'Decir Hola', timeoutMs: 5000 }],
    };
    writePlugin('com.libredeck.ejemplo', manifest, [
      'export function register(api) {',
      "  api.onAction('saludo', async ({ args }) => {",
      '    const nombre = args.nombre || \'Mundo\';',
      '    const entusiasmo = args.entusiasmo || 5;',
      "    const mensaje = 'Hola ' + nombre + '!'.repeat(Math.min(entusiasmo, 10));",
      "    api.emitEvent('log', { message: 'Saludo: ' + mensaje });",
      "    api.log('info', 'Saludo para: ' + nombre);",
      '    return { success: true, message: mensaje };',
      '  });',
      '}',
    ].join('\n'));

    expect(await loader.loadPlugin('com.libredeck.ejemplo')).toBe(true);

    const result = await runner.executeAction(
      {
        id: 'e2e-1',
        type: 'com.libredeck.ejemplo.saludo',
        parameters: { args: { nombre: 'Ada', entusiasmo: 3 } },
      },
      { timestamp: Date.now(), buttonId: 'btn-1', pageId: 'p-1', profileId: 'prof-1' }
    );
    expect(result.success).toBe(true);
    expect((result.result as any).message).toContain('Ada');

    const pluginEvents = broadcasted.filter(b => b.eventType === 'plugin.event');
    expect(pluginEvents.length).toBeGreaterThanOrEqual(1);
    expect(pluginEvents[0].payload.pluginId).toBe('com.libredeck.ejemplo');
    expect(pluginEvents[0].payload.eventName).toBe('log');
  });

  it('crash en register no tumba el loader', async () => {
    const manifest = {
      id: 'crasher', name: 'Crasher', version: '1.0.0', permissions: [],
      actions: [{ id: 'x', name: 'X' }],
    };
    writePlugin('crasher', manifest, 'export function register(api) { throw new Error(\'pum\'); }');
    expect(await loader.loadPlugin('crasher')).toBe(false);
    expect(loader.getPluginError('crasher')).toMatch(/pum/);

    // El índice sigue completo y el resto del loader funciona.
    expect(loader.getAction('crasher.x')).toBeDefined();
    const err = await (loader.getExternalHandler('crasher.x') as Function)({}, {})
      .then(() => null, (e: Error) => e);
    expect(err!.message).toMatch(/en error/);

    // Otro plugin carga con normalidad después del crash.
    const okManifest = {
      id: 'tras-crash', name: 'Ok', version: '1.0.0', permissions: [],
      actions: [{ id: 'ping', name: 'Ping' }],
    };
    writePlugin('tras-crash', okManifest, [
      'export function register(api) {',
      "  api.onAction('ping', async () => 'pong');",
      '}',
    ].join('\n'));
    expect(await loader.loadPlugin('tras-crash')).toBe(true);
    expect(await (loader.getExternalHandler('tras-crash.ping') as Function)({}, {})).toBe('pong');
  });
});
