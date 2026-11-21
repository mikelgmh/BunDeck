/**
 * plugin-worker.test.ts — FASE 2: aislamiento real de plugins externos.
 *
 * Cubre:
 *  (a) timeout REAL: el worker colgado se termina (prueba: deja de escribir
 *      en disco) y la acción falla con error de timeout; el worker
 *      re-spawneado sigue sirviendo acciones.
 *  (b) permiso no declarado => denegado (http/fs); localhost exige `system`.
 *  (c) crash del plugin (throw en handler y en register) no tumba el loader:
 *      el worker queda en error/log y otros plugins siguen funcionando.
 *  Extra: settings/log/emit-event/fs mediados por el padre.
 */
import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-worker-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;

import { initDatabase, DatabaseService } from '../db';
import { ExternalPluginWorker } from '../plugin-system/plugin-worker';

const workers: ExternalPluginWorker[] = [];
afterEach(() => {
  for (const w of workers.splice(0)) {
    try { w.terminate(); } catch {}
  }
});

function manifestFor(id: string, actions: any[], permissions: string[] = []) {
  return { id, name: `Plugin ${id}`, version: '1.0.0', permissions, actions };
}

function makePluginDir(id: string, manifest: any, mainJs: string): string {
  const dir = path.join(TMP, 'plugins', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'main.js'), mainJs);
  return path.join(dir, 'main.js');
}

function track(w: ExternalPluginWorker): ExternalPluginWorker {
  workers.push(w);
  return w;
}

beforeAll(async () => {
  await initDatabase();
});

describe('ExternalPluginWorker — timeout real', () => {
  it('(a) mata el worker colgado, falla con timeout y re-spawnea', async () => {
    const marker = path.join(TMP, 'hang-marker.txt');
    try { fs.unlinkSync(marker); } catch {}
    const mainJs = [
      "import fs from 'node:fs';",
      'export function register(api) {',
      "  api.onAction('hang', async (params) => {",
      '    const m = params.marker;',
      "    setInterval(() => { try { fs.appendFileSync(m, 'x'); } catch {} }, 25);",
      '    await new Promise(() => {});',
      '  });',
      "  api.onAction('quick', async () => 'ok');",
      '}',
    ].join('\n');
    const mainPath = makePluginDir(
      't-hang',
      manifestFor('t-hang', [
        { id: 'hang', name: 'Hang', timeoutMs: 300 },
        { id: 'quick', name: 'Quick' },
      ]),
      mainJs
    );
    const w = track(new ExternalPluginWorker(
      manifestFor('t-hang', [
        { id: 'hang', name: 'Hang', timeoutMs: 300 },
        { id: 'quick', name: 'Quick' },
      ]), mainPath, { handshakeTimeoutMs: 4000 }
    ));
    const actions = await w.start();
    expect(actions.sort()).toEqual(['hang', 'quick']);

    const t0 = Date.now();
    const err = await w.invoke('hang', { marker }, {}).then(
      () => null,
      (e: Error) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/Timeout 300ms/);
    expect(Date.now() - t0).toBeLessThan(2000);

    // Prueba de kill REAL (no Promise.race): el bucle del worker deja de escribir.
    await new Promise(r => setTimeout(r, 150));
    const size1 = fs.existsSync(marker) ? fs.statSync(marker).size : 0;
    expect(size1).toBeGreaterThan(0); // el loop escribió antes del timeout
    await new Promise(r => setTimeout(r, 400));
    const size2 = fs.statSync(marker).size;
    expect(size2).toBe(size1); // tras terminate, nada más escribe

    // El worker re-spawneado sirve nuevas invocaciones.
    expect(await w.invoke('quick', {}, {})).toBe('ok');
    expect(w.getStatus()).toBe('ok');
    expect(w.getRespawnCount()).toBeGreaterThanOrEqual(1);
  }, 15000);
});

describe('ExternalPluginWorker — permisos enforced en el padre', () => {
  it('(b) http sin permiso => denegado', async () => {
    const mainJs = [
      'export function register(api) {',
      "  api.onAction('go', async () => {",
      "    const r = await api.http.fetch('https://example.com/');",
      '    return r.status;',
      '  });',
      '}',
    ].join('\n');
    const m = manifestFor('t-nohttp', [{ id: 'go', name: 'Go' }], []);
    const w = track(new ExternalPluginWorker(m, makePluginDir('t-nohttp', m, mainJs), { handshakeTimeoutMs: 4000 }));
    await w.start();
    const err = await w.invoke('go', {}, {}).then(() => null, (e: Error) => e);
    expect(err!.message).toMatch(/permiso/i);
  });

  it('(b) localhost exige permiso system; con system se permite (falla por conexión, no por permiso)', async () => {
    const mainJs = [
      'export function register(api) {',
      "  api.onAction('go', async () => {",
      "    const r = await api.http.fetch('http://127.0.0.1:9/none');",
      '    return r.status;',
      '  });',
      '}',
    ].join('\n');
    const mNoSys = manifestFor('t-nolocal', [{ id: 'go', name: 'Go' }], ['http']);
    const w1 = track(new ExternalPluginWorker(mNoSys, makePluginDir('t-nolocal', mNoSys, mainJs), { handshakeTimeoutMs: 4000 }));
    await w1.start();
    const err1 = await w1.invoke('go', {}, {}).then(() => null, (e: Error) => e);
    expect(err1!.message).toMatch(/localhost/i);

    const mSys = manifestFor('t-local', [{ id: 'go', name: 'Go' }], ['http', 'system']);
    const w2 = track(new ExternalPluginWorker(mSys, makePluginDir('t-local', mSys, mainJs), { handshakeTimeoutMs: 4000 }));
    await w2.start();
    const err2 = await w2.invoke('go', {}, {}).then(() => null, (e: Error) => e);
    // Puerto 9 cerrado: debe fallar por conexión, NO por permiso.
    expect(err2).toBeInstanceOf(Error);
    expect(err2!.message).not.toMatch(/permiso|localhost/i);
  });

  it('(b) fs sin permiso => denegado; con permiso hay roundtrip', async () => {
    const mainJsDenied = [
      'export function register(api) {',
      "  api.onAction('go', async () => {",
      "    return await api.fs.readFile('a.txt');",
      '  });',
      '}',
    ].join('\n');
    const mDenied = manifestFor('t-nofs', [{ id: 'go', name: 'Go' }], []);
    const w1 = track(new ExternalPluginWorker(mDenied, makePluginDir('t-nofs', mDenied, mainJsDenied), { handshakeTimeoutMs: 4000 }));
    await w1.start();
    const err = await w1.invoke('go', {}, {}).then(() => null, (e: Error) => e);
    expect(err!.message).toMatch(/filesystem/i);

    const mainJsOk = [
      'export function register(api) {',
      "  api.onAction('go', async () => {",
      "    await api.fs.writeFile('notas/hola.txt', 'hola worker');",
      "    const back = await api.fs.readFile('notas/hola.txt');",
      "    const ex = await api.fs.exists('notas/hola.txt');",
      "    return back + ':' + ex;",
      '  });',
      '}',
    ].join('\n');
    const mOk = manifestFor('t-fs', [{ id: 'go', name: 'Go' }], ['filesystem']);
    const w2 = track(new ExternalPluginWorker(mOk, makePluginDir('t-fs', mOk, mainJsOk), { handshakeTimeoutMs: 4000 }));
    await w2.start();
    expect(await w2.invoke('go', {}, {})).toBe('hola worker:true');
    // Traversal bloqueado aunque haya permiso.
    const mainJsTrav = [
      'export function register(api) {',
      "  api.onAction('go', async () => {",
      "    return await api.fs.readFile('../../db.sqlite');",
      '  });',
      '}',
    ].join('\n');
    const mTrav = manifestFor('t-fstrav', [{ id: 'go', name: 'Go' }], ['filesystem']);
    const w3 = track(new ExternalPluginWorker(mTrav, makePluginDir('t-fstrav', mTrav, mainJsTrav), { handshakeTimeoutMs: 4000 }));
    await w3.start();
    const errTrav = await w3.invoke('go', {}, {}).then(() => null, (e: Error) => e);
    expect(errTrav!.message).toMatch(/traversal/i);
  });

  it('(b) shell sin permiso y comandos bloqueados => denegado', async () => {
    const mainJs = [
      'export function register(api) {',
      "  api.onAction('go', async () => 'nunca');",
      '}',
    ].join('\n');
    const m = manifestFor('t-shell', [{ id: 'go', name: 'Go' }], []);
    const w = track(new ExternalPluginWorker(m, makePluginDir('t-shell', m, mainJs), { handshakeTimeoutMs: 4000 }));
    await w.start();
    const err = await w.invoke('go', { command: 'echo hi' }, {}).then(() => null, (e: Error) => e);
    expect(err!.message).toMatch(/shell/i);

    const m2 = manifestFor('t-shell2', [{ id: 'go', name: 'Go' }], ['shell']);
    const w2 = track(new ExternalPluginWorker(m2, makePluginDir('t-shell2', m2, mainJs), { handshakeTimeoutMs: 4000 }));
    await w2.start();
    const err2 = await w2.invoke('go', { command: 'rm -rf / tmp' }, {}).then(() => null, (e: Error) => e);
    expect(err2!.message).toMatch(/bloqueado/i);
  });
});

describe('ExternalPluginWorker — crash no tumba al padre', () => {
  it('(c) throw en handler => invoke falla pero el worker sigue vivo', async () => {
    const mainJs = [
      'export function register(api) {',
      "  api.onAction('boom', async () => { throw new Error('kaboom'); });",
      "  api.onAction('quick', async () => 'vivo');",
      '}',
    ].join('\n');
    const m = manifestFor('t-boom', [{ id: 'boom', name: 'B' }, { id: 'quick', name: 'Q' }], []);
    const w = track(new ExternalPluginWorker(m, makePluginDir('t-boom', m, mainJs), { handshakeTimeoutMs: 4000 }));
    await w.start();
    const err = await w.invoke('boom', {}, {}).then(() => null, (e: Error) => e);
    expect(err!.message).toMatch(/kaboom/);
    expect(await w.invoke('quick', {}, {})).toBe('vivo');
    expect(w.getStatus()).toBe('ok');
  });

  it('(c) throw en register => start falla, plugin en error, otros siguen OK', async () => {
    const bad = manifestFor('t-badreg', [{ id: 'x', name: 'X' }], []);
    const wBad = track(new ExternalPluginWorker(
      bad, makePluginDir('t-badreg', bad, 'export function register(api) { throw new Error(\'boom-register\'); }'),
      { handshakeTimeoutMs: 4000 }
    ));
    const err = await wBad.start().then(() => null, (e: Error) => e);
    expect(err!.message).toMatch(/boom-register/);
    expect(wBad.getStatus()).toBe('error');
    expect(wBad.getLastError()).toMatch(/boom-register/);

    // El "loader" (proceso padre) sigue vivo: otro plugin arranca sin problema.
    const good = manifestFor('t-good', [{ id: 'ok', name: 'Ok' }], []);
    const wGood = track(new ExternalPluginWorker(
      good, makePluginDir('t-good', good, "export function register(api) { api.onAction('ok', async () => 42); }"),
      { handshakeTimeoutMs: 4000 }
    ));
    await wGood.start();
    expect(await wGood.invoke('ok', {}, {})).toBe(42);
  });
});

describe('ExternalPluginWorker — ops mediadas (settings/log/eventos)', () => {
  it('settings roundtrip + emit-event/log llegan al padre', async () => {
    const emitted: any[] = [];
    const mainJs = [
      'export function register(api) {',
      "  api.onAction('go', async () => {",
      "    await api.setSetting('color', 'rojo');",
      "    const v = await api.getSetting('color');",
      "    api.log('info', 'hola desde worker');",
      "    api.emitEvent('mi-evento', { n: 1 });",
      '    return v;',
      '  });',
      '}',
    ].join('\n');
    const m = manifestFor('t-ops', [{ id: 'go', name: 'Go' }], []);
    const w = track(new ExternalPluginWorker(m, makePluginDir('t-ops', m, mainJs), {
      handshakeTimeoutMs: 4000,
      emitEvent: (eventName, payload, pluginId) => { emitted.push({ eventName, payload, pluginId }); },
    }));
    await w.start();
    expect(await w.invoke('go', {}, {})).toBe('rojo');
    expect(emitted).toEqual([{ eventName: 'mi-evento', payload: { n: 1 }, pluginId: 't-ops' }]);
    const db = new DatabaseService();
    expect(db.getSetting('plugin.t-ops.color')).toBe('rojo');
    const logs = db.getLogs(5);
    expect(logs.some(l => l.message.includes('hola desde worker'))).toBe(true);
  });
});
