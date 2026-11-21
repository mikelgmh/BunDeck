/**
 * elgato-host.test.ts — Runtime de compatibilidad Elgato (fase 2).
 * Protocolo (parse args, build info) + host con un plugin Node falso que
 * hace registerEvent + setTitle/setState/setSettings, sin red externa.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-elgato-host-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService } from '../db';
import {
  parseRegisterArgs,
  buildInfoJson,
  buildInfoObject,
  buildHostMessage,
  isRegisterMessage,
} from '../elgato/protocol';
import { ElgatoHost, elgatoGlobalKey, elgatoSettingsKey, type ElgatoActionState } from '../elgato/host';
import { ElgatoRuntimeManager, resolveCodePath } from '../elgato/runtime';

const PLUGIN_ID = 'com.fake.elgato';
const ACTION_UUID = `${PLUGIN_ID}.countdown`;

let db: DatabaseService;

function fakePluginCode(): string {
  return `
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const port = flag('-port');
const uuid = flag('-pluginUUID');
const reg = flag('-registerEvent') || 'registerEvent';
async function main() {
  let ws = null;
  for (let i = 0; i < 50; i++) {
    try {
      ws = new WebSocket('ws://127.0.0.1:' + port);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      break;
    } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!ws) { console.error('no connect'); process.exit(2); }
  const action = uuid + '.countdown';
  ws.send(JSON.stringify({ event: reg, uuid }));
  await new Promise((r) => setTimeout(r, 400));
  ws.send(JSON.stringify({ event: 'setTitle', action, context: 'ctx-1', payload: { title: 'Hola DeckCal', target: 0 } }));
  ws.send(JSON.stringify({ event: 'setImage', action, context: 'ctx-1', payload: { image: 'data:image/png;base64,iVBOR', target: 0 } }));
  ws.send(JSON.stringify({ event: 'setState', action, context: 'ctx-1', payload: { state: 1 } }));
  ws.send(JSON.stringify({ event: 'setSettings', action, context: 'ctx-1', payload: { meeting: 'standup' } }));
  ws.send(JSON.stringify({ event: 'setGlobalSettings', payload: { settings: { token: 'abc' } } }));
  ws.send(JSON.stringify({ event: 'getSettings', action, context: 'ctx-1' }));
  ws.send(JSON.stringify({ event: 'getGlobalSettings' }));
  ws.send(JSON.stringify({ event: 'logMessage', payload: { message: 'fake alive' } }));
  ws.send(JSON.stringify({ event: 'openUrl', payload: { url: 'https://example.com/x' } }));
  await new Promise(() => {});
}
main().catch((e) => { console.error(String(e)); process.exit(1); });
`;
}

function installFakePlugin(id: string): any {
  const dir = path.join(TMP, 'plugins', id, 'elgato', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.js'), fakePluginCode());
  return {
    UUID: id,
    Name: 'Fake',
    Version: '1.0.0.0',
    Author: 'Test',
    CodePath: 'bin/plugin.js',
    Actions: [{ UUID: `${id}.countdown`, Name: 'Countdown', Controllers: ['Keypad'] }],
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 12000, stepMs = 100): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('Timeout esperando condición del test');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

beforeAll(async () => {
  await initDatabase();
  db = new DatabaseService();
});

describe('protocolo Elgato', () => {
  it('parseRegisterArgs lee -port/-pluginUUID/-registerEvent/-info', () => {
    const info = buildInfoJson({ pluginUUID: PLUGIN_ID });
    const args = parseRegisterArgs(['-port', '28900', '-pluginUUID', PLUGIN_ID, '-registerEvent', 'registerEvent', '-info', info]);
    expect(args.port).toBe(28900);
    expect(args.pluginUUID).toBe(PLUGIN_ID);
    expect(args.registerEvent).toBe('registerEvent');
    expect(args.info.plugin.uuid).toBe(PLUGIN_ID);
  });

  it('parseRegisterArgs falla sin -port o con puerto inválido', () => {
    expect(() => parseRegisterArgs(['-pluginUUID', 'x'])).toThrow();
    expect(() => parseRegisterArgs(['-port', 'abc', '-pluginUUID', 'x'])).toThrow();
  });

  it('buildInfoJson incluye application/plugin/devices', () => {
    const obj = buildInfoObject({ pluginUUID: PLUGIN_ID });
    expect(obj.application).toBeDefined();
    expect(obj.plugin.uuid).toBe(PLUGIN_ID);
    expect(obj.devices.length).toBeGreaterThan(0);
    expect(obj.devicesInfo[0].size.columns).toBeGreaterThan(0);
    expect(JSON.parse(buildInfoJson({ pluginUUID: PLUGIN_ID })).plugin.uuid).toBe(PLUGIN_ID);
  });

  it('buildHostMessage e isRegisterMessage', () => {
    const m = buildHostMessage('keyDown', { action: ACTION_UUID, context: 'c1' });
    expect(m.event).toBe('keyDown');
    expect(m.device).toBeDefined();
    expect(isRegisterMessage({ event: 'registerEvent', uuid: 'x' })).toBe(true);
    expect(isRegisterMessage({ event: 'registerPlugin', uuid: 'x' })).toBe(true);
    expect(isRegisterMessage({ event: 'keyDown' })).toBe(false);
  });
});

describe('ElgatoHost con plugin falso', () => {
  let host: ElgatoHost;
  const seen: Array<{ context: string; state: ElgatoActionState }> = [];
  const manifest = installFakePlugin(PLUGIN_ID);

  afterAll(async () => {
    try { await host?.stopAll(); } catch {}
  });

  it('registra el plugin y recibe setTitle/setState', async () => {
    host = new ElgatoHost({
      pluginsDir: path.join(TMP, 'plugins'),
      db,
      onStateChange: (_pid, context, state) => seen.push({ context, state }),
      registerTimeoutMs: 10000,
      maxRestarts: 1,
      noOpen: true,
    });
    await host.startPlugin(PLUGIN_ID, manifest);
    expect(host.isRunning(PLUGIN_ID)).toBe(true);
    await waitFor(() => seen.some((s) => s.context === 'ctx-1' && s.state.title === 'Hola DeckCal'));
    const st = host.getActionState(PLUGIN_ID, 'ctx-1');
    expect(st?.title).toBe('Hola DeckCal');
    expect(st?.state).toBe(1);
    expect(st?.image).toMatch(/^data:image\/png/);
  });

  it('persiste setSettings y setGlobalSettings en DB', async () => {
    await waitFor(() => {
      const raw = db.getSetting(elgatoSettingsKey(PLUGIN_ID, 'ctx-1'));
      return !!raw && JSON.parse(raw).meeting === 'standup';
    });
    const global = JSON.parse(db.getSetting(elgatoGlobalKey(PLUGIN_ID))!);
    expect(global.token).toBe('abc');
  });

  it('sendKey llega al plugin y getContexts lista contextos', async () => {
    expect(host.getContexts(PLUGIN_ID)).toContain('ctx-1');
    expect(host.sendKey(PLUGIN_ID, ACTION_UUID, 'ctx-1', 'keyDown')).toBe(true);
    expect(host.sendKey(PLUGIN_ID, ACTION_UUID, 'ctx-1', 'keyUp')).toBe(true);
    // Contexto nuevo → willAppear implícito.
    expect(host.sendKey(PLUGIN_ID, ACTION_UUID, 'ctx-2', 'keyDown')).toBe(true);
    expect(host.getContexts(PLUGIN_ID)).toContain('ctx-2');
  });

  it('stopPlugin termina el proceso', async () => {
    await host.stopPlugin(PLUGIN_ID);
    expect(host.isRunning(PLUGIN_ID)).toBe(false);
  });
});

describe('ElgatoRuntimeManager', () => {
  const ID2 = 'com.fake.elgato2';
  const manifest2 = installFakePlugin(ID2);
  let mgr: ElgatoRuntimeManager;

  afterAll(async () => {
    try { await mgr?.stopAll(); } catch {}
  });

  it('resolveCodePath según plataforma', () => {
    const m = { CodePath: 'a.js', CodePathWin: 'w.js', CodePathMac: 'm.js' };
    expect(resolveCodePath(m, 'win32')).toBe('w.js');
    expect(resolveCodePath(m, 'darwin')).toBe('m.js');
    expect(resolveCodePath(m, 'linux')).toBe('a.js');
    expect(resolveCodePath({ CodePath: 'a.js' }, 'win32')).toBe('a.js');
    expect(resolveCodePath(null)).toBeNull();
  });

  it('start/stop/isRunning/getStateForAction', async () => {
    mgr = new ElgatoRuntimeManager({
      pluginsDir: path.join(TMP, 'plugins'),
      db,
      registerTimeoutMs: 10000,
      maxRestarts: 1,
      noOpen: true,
    });
    await mgr.start(ID2, manifest2);
    expect(mgr.isRunning(ID2)).toBe(true);
    await waitFor(() => mgr.getStateForAction(ID2, 'ctx-1')?.title === 'Hola DeckCal');
    expect(mgr.getContexts(ID2)).toContain('ctx-1');
    await mgr.stop(ID2);
    expect(mgr.isRunning(ID2)).toBe(false);
  });
});
