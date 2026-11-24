/**
 * elgato-shim.test.ts — Shim Elgato en-Worker (cero procesos `node`).
 *
 * - Unidad (sdk puro): keyDown/Up, willAppear, settings get/set,
 *   setTitle/setState, rechazo explícito de DialAction, rechazo de
 *   nativos y dial-only a nivel de análisis.
 * - Integración (fixtures versionadas): import → key → elgato-state,
 *   contexto único por botón, settings, setImage relativo, showAlert/Ok,
 *   system.openUrl, hold real en pulsación larga.
 * - Presupuesto de rendimiento: sin manager legacy (sin `node`), arranque
 *   de la primera pulsación <2s, un único Worker por plugin.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-shim-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService } from '../db';
import {
  createElgatoShim,
  buildSettingsSchema,
  resolveAssetPath,
  DialAction,
  SingletonAction,
  LONG_HOLD_MS_DEFAULT,
  type ShimApi,
} from '../elgato/shim/sdk';
import { DialNotSupportedError, isDialOnlyManifest } from '../elgato/shim/dial-stub';
import {
  isShimEnabled,
  isShimCapable,
  needsManualReason,
  detectElgatoCodeStyle,
  hasBareWsSpecifier,
  rewriteWsSpecifier,
  findRawSourceEntry,
  writeShimFiles,
  ensureShimBridge,
} from '../elgato/shim/loader-shim';
import {
  createRawHost,
  installRawGlobals,
  VirtualElgatoSocket,
  RAW_HOST_KEY,
} from '../elgato/shim/raw-transport';
import { analyzeElgatoManifest } from '../elgato/manifest';
import { importElgatoPlugin } from '../elgato/import';
import { PluginLoader } from '../plugin-loader';
import { fileURLToPath } from 'node:url';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'elgato');

let db: DatabaseService;
let loader: PluginLoader;
const wsEvents: any[] = [];

function fakeApi(calls: any[] = []): ShimApi {
  const store = new Map<string, string>();
  return {
    onAction: (id: string, h: any) => { calls.push(['onAction', id, h]); },
    getSetting: async (k: string) => store.get(k) ?? null,
    setSetting: async (k: string, v: string) => { store.set(k, v); },
    log: () => {},
    emitEvent: (name: string, payload: any) => { calls.push(['emit', name, payload]); },
    setButtonState: (buttonId: string, state: any) => { calls.push(['button-state', buttonId, state]); },
  };
}

beforeAll(async () => {
  await initDatabase();
  db = new DatabaseService();
  loader = new PluginLoader();
  try { await (loader as any).watcher?.close(); } catch {}
  (loader as any).watcher = undefined;
  loader.setWebSocketManager({
    broadcast: (eventType: string, payload: any, topic?: string) => {
      wsEvents.push({ eventType, payload, topic });
    },
  });
});

afterAll(async () => {
  for (const id of [...(loader as any).loadedPlugins.keys()]) {
    try { loader.unloadPlugin(id); } catch {}
  }
  try { (loader as any).dispose?.(); } catch {}
});

describe('shim: feature-flag y utilidades', () => {
  it('shim activo por defecto', () => {
    expect(isShimEnabled()).toBe(true);
  });
  it('buildSettingsSchema infiere tipos desde defaults', () => {
    const s = buildSettingsSchema({ interval: 5, label: 'reloj', enabled: true });
    expect(s.type).toBe('object');
    expect(s.properties.interval.type).toBe('number');
    expect(s.properties.label.type).toBe('string');
    expect(s.properties.enabled.type).toBe('boolean');
    expect(buildSettingsSchema(null)).toBeNull();
  });
  it('resolveAssetPath resuelve relativos contra el paquete', () => {
    expect(resolveAssetPath('imgs/icon.png', 'elgato')).toBe('elgato/imgs/icon.png');
    expect(resolveAssetPath('https://x/y.png', 'elgato')).toBe('https://x/y.png');
    expect(resolveAssetPath(null, 'elgato')).toBeNull();
  });
});

describe('shim sdk (unidad)', () => {
  it('willAppear + keyDown/Up + setTitle/setState', async () => {
    const calls: any[] = [];
    const shim = createElgatoShim(fakeApi(calls), { pluginId: 'com.t', actions: [{ shortId: 'c', uuid: 'com.t.c' }] });
    const order: string[] = [];
    shim.action('com.t.c').onWillAppear(() => { order.push('appear'); });
    shim.action('com.t.c').onKeyDown((ev: any) => {
      order.push('down');
      ev.action.setTitle('hola');
      ev.action.setState(1);
    });
    shim.action('com.t.c').onKeyUp(() => { order.push('up'); });
    const r = await shim.fireKey('com.t.c', { params: {}, context: { buttonId: 'b1' } });
    expect(order).toEqual(['appear', 'down', 'up']);
    expect(r.context).toBe('ld:com.t:c:b1');
    expect(r.visuals.title).toBe('hola');
    expect(r.visuals.state).toBe(1);
    expect(r.downCalled).toBe(true);
    expect(r.upCalled).toBe(true);
    // Segunda pulsación mismo botón: sin willAppear repetido, contexto único.
    order.length = 0;
    const r2 = await shim.fireKey('com.t.c', { params: {}, context: { buttonId: 'b1' } });
    expect(order).toEqual(['down', 'up']);
    expect(r2.context).toBe(r.context);
  });

  it('SingletonAction + registerAction y settings get/set', async () => {
    const calls: any[] = [];
    const shim = createElgatoShim(fakeApi(calls), { pluginId: 'com.s', actions: [{ shortId: 'c', uuid: 'com.s.c' }] });
    class C extends SingletonAction {
      override async onWillAppear(ev: any) {
        ev.action.setTitle(String(ev.payload.settings.count ?? 0));
      }
      override async onKeyDown(ev: any) {
        const n = Number(ev.payload.settings.count ?? 0) + 1;
        await ev.action.setSettings({ count: n });
        ev.action.setTitle(String(n));
      }
    }
    (C as any).manifestId = 'com.s.c';
    (shim.streamDeck.actions as any).registerAction(new C());
    const r0 = await shim.fireKey('com.s.c', { params: {}, context: { buttonId: 'b0' } });
    expect(r0.visuals.title).toBe('1');
    // Sin UUID declarado registerAction lanza (fidelidad con el SDK real).
    const shim2 = createElgatoShim(fakeApi(), { pluginId: 'com.s2', actions: [] });
    class D extends SingletonAction {}
    expect(() => (shim2.streamDeck.actions as any).registerAction(new D())).toThrow(/UUID/);
    // Registrar con UUID explícito vía action().register (uuid independiente).
    class E extends SingletonAction {
      override async onKeyDown(ev: any) {
        const n = Number(ev.payload.settings.count ?? 0) + 1;
        await ev.action.setSettings({ count: n });
        ev.action.setTitle(String(n));
      }
    }
    shim.action('com.s.e').register(new E());
    const r1 = await shim.fireKey('com.s.e', { params: {}, context: { buttonId: 'b1' } });
    expect(r1.visuals.title).toBe('1');
    const r2 = await shim.fireKey('com.s.e', { params: {}, context: { buttonId: 'b1' } });
    expect(r2.visuals.title).toBe('2');
    // Otro botón: contador independiente (contexto único por botón).
    const r3 = await shim.fireKey('com.s.e', { params: {}, context: { buttonId: 'b2' } });
    expect(r3.visuals.title).toBe('1');
  });

  it('params de LibreDeck se fusionan en payload.settings', async () => {
    const shim = createElgatoShim(fakeApi(), { pluginId: 'com.p', actions: [{ shortId: 'c', uuid: 'com.p.c' }] });
    let seen: any = null;
    shim.action('com.p.c').onKeyDown((ev: any) => { seen = ev.payload.settings; });
    await shim.fireKey('com.p.c', { params: { interval: 9 }, context: { buttonId: 'b' } });
    expect(seen.interval).toBe(9);
  });

  it('DialAction se rechaza de forma explícita sin tumbar el resto', async () => {
    const calls: any[] = [];
    const shim = createElgatoShim(fakeApi(calls), { pluginId: 'com.d', actions: [] });
    class K extends DialAction {}
    shim.action('com.d.knob').register(new K());
    expect(shim.wasDialRejected('com.d.knob')).toBe(true);
    expect(calls.some(([k, name]) => k === 'emit' && name === 'elgato.dial-rejected')).toBe(true);
    // Y DialNotSupportedError documenta el motivo para el registro manual.
    const err = new DialNotSupportedError('com.d.knob');
    expect(err.message).toMatch(/sin equivalente/i);
  });

  it('análisis rechaza nativos y dial-only', () => {
    const native = {
      UUID: 'com.n', Name: 'N', Author: 'A', Version: '1.0.0.0', CodePath: 'bin/app.exe',
      Actions: [{ UUID: 'com.n.a', Name: 'A', Controllers: ['Keypad'] }],
    };
    const repN = analyzeElgatoManifest(native);
    expect(repN.runtime).toBe('native');
    expect(repN.compatible).toBe(false);
    expect(isShimCapable(repN)).toBe(false);
    const dial = JSON.parse(fs.readFileSync(path.join(FIX, 'dialonly-v1', 'manifest.json'), 'utf8'));
    const repD = analyzeElgatoManifest(dial);
    expect(repD.compatible).toBe(false);
    expect(isDialOnlyManifest(dial)).toBe(true);
    expect(isShimCapable(repD)).toBe(false);
  });
});

describe('detectElgatoCodeStyle', () => {
  const SDK_SAMPLE = 'import streamDeck, { SingletonAction } from "@elgato/streamdeck";\nstreamDeck.connect();';
  const SDK_REQUIRE = 'const { streamDeck } = require("@elgato/streamdeck");';
  const RAW_SAMPLE = [
    'import WebSocket from "ws";',
    'const ws = new WebSocket(`ws://127.0.0.1:${port}`);',
    'ws.on("open", () => { send(registerEvent, { uuid: pluginUuid }); });',
    'function setTitle(context, title) { send("setTitle", { context, payload: { title, target: 0 } }); }',
    'case "keyDown": { void refresh(context); break; }',
  ].join('\n');

  it('sdk: importa @elgato/streamdeck', () => {
    expect(detectElgatoCodeStyle(SDK_SAMPLE)).toBe('sdk');
    expect(detectElgatoCodeStyle(SDK_REQUIRE)).toBe('sdk');
  });

  it('raw: WebSocket + registerEvent + setTitle/keyDown sin SDK', () => {
    expect(detectElgatoCodeStyle(RAW_SAMPLE)).toBe('raw');
  });

  it('sdk manda si hay ambos marcadores', () => {
    expect(detectElgatoCodeStyle(`${SDK_SAMPLE}\n${RAW_SAMPLE}`)).toBe('sdk');
  });

  it('unknown: sin marcadores o vacío', () => {
    expect(detectElgatoCodeStyle('console.log("hola");')).toBe('unknown');
    expect(detectElgatoCodeStyle('')).toBe('unknown');
    expect(detectElgatoCodeStyle(null as any)).toBe('unknown');
  });

  it('fixtures: sdk-v1 → sdk, raw-v1 → raw', () => {
    expect(detectElgatoCodeStyle(fs.readFileSync(path.join(FIX, 'sdk-v1', 'plugin.js'), 'utf8'))).toBe('sdk');
    expect(detectElgatoCodeStyle(fs.readFileSync(path.join(FIX, 'raw-v1', 'plugin.js'), 'utf8'))).toBe('raw');
  });

  it('isShimCapable acepta raw con CodePath; needsManualReason distingue raw sin CodePath', () => {
    const elgato = {
      UUID: 'com.x', Name: 'X', Author: 'A', Version: '1.0.0.0', CodePath: 'bin/plugin.js',
      Actions: [{ UUID: 'com.x.a', Name: 'A', Controllers: ['Keypad'] }],
    };
    const rep = analyzeElgatoManifest(elgato);
    expect(rep.compatible).toBe(true);
    expect(isShimCapable(rep, RAW_SAMPLE)).toBe(true);
    expect(isShimCapable(rep, SDK_SAMPLE)).toBe(true);
    const noCode = { ...rep, codePath: null };
    expect(isShimCapable(noCode, RAW_SAMPLE)).toBe(false);
    expect(needsManualReason(noCode, RAW_SAMPLE)).toMatch(/Raw sin adaptador/);
    expect(needsManualReason(noCode, SDK_SAMPLE)).toMatch(/Sin CodePath ejecutable/);
  });
});

describe('shim raw (unidad)', () => {
  it('socket virtual + fireKey: willAppear/keyDown/keyUp y setTitle del plugin', async () => {
    const calls: any[] = [];
    const api = fakeApi(calls);
    const prevWS = (globalThis as any).WebSocket;
    const prevArgv = [...process.argv];
    const hadHost = RAW_HOST_KEY in (globalThis as any);
    const prevHost = (globalThis as any)[RAW_HOST_KEY];
    try {
      const host = createRawHost(api, {
        pluginId: 'com.t.raw', actions: [{ shortId: 'ping', uuid: 'com.t.raw.ping' }], elgatoUuid: 'com.t.raw',
      });
      installRawGlobals(host, { elgatoUuid: 'com.t.raw' });
      expect((globalThis as any).WebSocket).toBe(VirtualElgatoSocket);
      expect(process.argv).toContain('-pluginUUID');
      expect(process.argv).toContain('com.t.raw');

      const WS: any = (globalThis as any).WebSocket;
      expect(WS.OPEN).toBe(1);
      const ws = new WS('ws://127.0.0.1:0');
      const seen: string[] = [];
      ws.on('message', (m: string) => {
        const msg = JSON.parse(String(m));
        seen.push(msg.event);
        if (msg.event === 'keyDown' && ws.readyState === WS.OPEN) {
          ws.send(JSON.stringify({ event: 'setTitle', context: msg.context, payload: { title: 'raw!', target: 0 } }));
        }
      });
      await new Promise((r) => setTimeout(r, 0)); // deja que `open` se emita
      ws.send(JSON.stringify({ event: 'registerPlugin', uuid: 'com.t.raw' }));

      const r = await host.fireKey('com.t.raw.ping', { params: {}, context: { buttonId: 'b1' } });
      expect(r.ok).toBe(true);
      expect(r.context).toBe('ld:com.t.raw:ping:b1');
      expect(seen).toContain('willAppear');
      expect(seen).toEqual(expect.arrayContaining(['keyDown', 'keyUp']));
      expect(r.downCalled).toBe(true);
      expect(r.upCalled).toBe(true);
      expect(r.visuals.title).toBe('raw!');
      // Mismo contrato que el camino SDK: elgato.state con el contexto único.
      expect(calls.some(([k, name]) => k === 'emit' && name === 'elgato.state')).toBe(true);
    } finally {
      (globalThis as any).WebSocket = prevWS;
      process.argv = prevArgv;
      if (!hadHost) delete (globalThis as any)[RAW_HOST_KEY];
      else (globalThis as any)[RAW_HOST_KEY] = prevHost;
    }
  });

  it('getSettings/setGlobalSettings/openUrl se traducen al núcleo del shim', async () => {
    const calls: any[] = [];
    const api = fakeApi(calls);
    const host = createRawHost(api, {
      pluginId: 'com.t.raw2', actions: [{ shortId: 'ping', uuid: 'com.t.raw2.ping' }], elgatoUuid: 'com.t.raw2',
    });
    const WS: any = VirtualElgatoSocket;
    (globalThis as any)[RAW_HOST_KEY] = host;
    try {
      const ws = new WS('ws://127.0.0.1:0');
      const got: any[] = [];
      ws.on('message', (m: string) => got.push(JSON.parse(String(m))));
      await new Promise((r) => setTimeout(r, 0));
      await host.fireKey('com.t.raw2.ping', { params: { interval: 5 }, context: { buttonId: 'b7' } });
      const ctx = 'ld:com.t.raw2:ping:b7';
      // setGlobalSettings → persistido con la clave global del shim.
      ws.send(JSON.stringify({ event: 'setGlobalSettings', payload: { loc: 'MAD' } }));
      await new Promise((r) => setTimeout(r, 10));
      ws.send(JSON.stringify({ event: 'getGlobalSettings' }));
      await new Promise((r) => setTimeout(r, 10));
      expect(got.some((m) => m.event === 'didReceiveGlobalSettings' && m.payload?.settings?.loc === 'MAD')).toBe(true);
      // openUrl → evento estructurado, sin abrir nada.
      ws.send(JSON.stringify({ event: 'openUrl', payload: { url: 'https://ejemplo.test' } }));
      expect(calls.some(([k, name, p]) => k === 'emit' && name === 'system.open-url' && p?.url === 'https://ejemplo.test')).toBe(true);
      // params de LibreDeck fusionados en settings del contexto.
      expect(host.getVisuals('com.t.raw2.ping', ctx)?.settings?.interval).toBe(5);
    } finally {
      delete (globalThis as any)[RAW_HOST_KEY];
    }
  });

  it('ws.Server lanza claro (cero Bun.serve por plugin)', () => {
    expect(() => new (VirtualElgatoSocket as any).Server()).toThrow(/Bun\.serve/);
  });

  it('rewriteWsSpecifier redirige ws sin tocar ws:// ni el resto', () => {
    const src = 'import WebSocket from "ws";\nimport { X } from \'ws\';\nconst u = "ws://127.0.0.1:0";\nconst m = await import("ws");\nconst r = require("ws");';
    const out = rewriteWsSpecifier(src, '../elgato-raw-transport.js');
    expect(out).toContain('from "../elgato-raw-transport.js"');
    expect(out).toContain('from \'../elgato-raw-transport.js\'');
    expect(out).toContain('import("../elgato-raw-transport.js")');
    expect(out).toContain('require("../elgato-raw-transport.js")');
    expect(out).toContain('"ws://127.0.0.1:0"');
    expect(out).not.toMatch(/from\s+["']ws["']/);
    expect(hasBareWsSpecifier(src)).toBe(true);
    expect(hasBareWsSpecifier('const u = "ws://x";')).toBe(false);
  });

  it('findRawSourceEntry prefiere la fuente raw al bundle opaco', () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-rawsrc-'));
    const elgatoDir = path.join(dest, 'elgato');
    fs.mkdirSync(path.join(elgatoDir, 'bin'), { recursive: true });
    // Bundle opaco (esbuild: ws dentro, sin especificador desnudo).
    fs.writeFileSync(path.join(elgatoDir, 'bin', 'plugin.js'), '"use strict";\n// bundle sin imports\nconst s=new (require("node:net").Socket)();');
    // Fuente raw junto al manifest (estilo AUS-UV).
    fs.writeFileSync(path.join(elgatoDir, 'plugin.js'), fs.readFileSync(path.join(FIX, 'raw-v1', 'plugin.js'), 'utf8'));
    const found = findRawSourceEntry(elgatoDir, 'bin/plugin.js', [{ shortId: 'ping', uuid: 'com.ld.raw.ping' }]);
    expect(found).toBe('plugin.js');
    // Sin fuente raw no hay adaptador posible.
    fs.rmSync(path.join(elgatoDir, 'plugin.js'));
    expect(findRawSourceEntry(elgatoDir, 'bin/plugin.js', [{ shortId: 'ping', uuid: 'com.ld.raw.ping' }])).toBeNull();
  });
});

describe('shim: import → key → state (integración)', () => {
  it('counter: importa con bridge y pulsa con hold corto y largo', async () => {
    const res = await importElgatoPlugin(db, { dir: path.join(FIX, 'counter-v1') }, {});
    expect(res.installed).toBe(true);
    expect((db.getPlugin('com.ld.counter') as any).status).toBe('active');
    const dest = (res as any).path as string;
    expect(fs.existsSync(path.join(dest, 'shim-bridge.js'))).toBe(true);

    // Registro perezoso: sin Worker hasta la primera pulsación.
    expect(await loader.loadElgatoPlugin('com.ld.counter')).toBe(true);
    expect((loader as any).externalWorkers.has('com.ld.counter')).toBe(false);
    expect((loader as any).elgatoManager).toBeFalsy();

    const h = loader.getExternalHandler('com.ld.counter.count') as Function;
    expect(typeof h).toBe('function');
    // Presupuesto: primera pulsación (spawn Worker + import) < 2s.
    const tKey = Date.now();
    const r1: any = await h({}, { buttonId: 'b1', timestamp: Date.now(), pressType: 'short' });
    expect(Date.now() - tKey).toBeLessThan(2000);
    expect(r1.ok).toBe(true);
    expect(r1.visuals.title).toBe('1');
    expect(r1.visuals.state).toBe(1);
    // Worker único creado de forma perezosa.
    expect((loader as any).externalWorkers.has('com.ld.counter')).toBe(true);

    const r2: any = await h({}, { buttonId: 'b1', timestamp: Date.now(), pressType: 'short' });
    expect(r2.visuals.title).toBe('2');

    // Hold real: long mapea a delay keyDown→keyUp.
    const tHold = Date.now();
    const r3: any = await h({}, { buttonId: 'b1', timestamp: Date.now(), pressType: 'long', holdMs: 150 });
    expect(Date.now() - tHold).toBeGreaterThanOrEqual(120);
    expect(r3.heldMs).toBeGreaterThanOrEqual(120);
    expect(r3.visuals.title).toBe('3');

    // elgato-state refleja la última pulsación por contexto.
    const st = await loader.getElgatoState('com.ld.counter');
    expect(st.running).toBe(true);
    expect(st.shim).toBe(true);
    const ctx = (st.state.contexts as any[]).find((c) => c.context === 'ld:com.ld.counter:count:b1');
    expect(ctx.state.title).toBe('3');
  }, 15000);

  it('image: setImage relativo se resuelve contra el paquete', async () => {
    await importElgatoPlugin(db, { dir: path.join(FIX, 'image-v1') }, {});
    await loader.loadElgatoPlugin('com.ld.image');
    const h = loader.getExternalHandler('com.ld.image.badge') as Function;
    const r: any = await h({}, { buttonId: 'b9', timestamp: Date.now() });
    expect(r.visuals.image).toBe('elgato/imgs/icon.png');
  }, 15000);

  it('alert: showAlert/showOk + openUrl emiten eventos estructurados', async () => {
    wsEvents.length = 0;
    await importElgatoPlugin(db, { dir: path.join(FIX, 'alert-v1') }, {});
    await loader.loadElgatoPlugin('com.ld.alert');
    const h = loader.getExternalHandler('com.ld.alert.flash') as Function;
    const r1: any = await h({}, { buttonId: 'b1', timestamp: Date.now() });
    const r2: any = await h({}, { buttonId: 'b1', timestamp: Date.now() });
    expect(r1.visuals.alerts).toBe(1);
    expect(r2.visuals.oks).toBe(1);

    await importElgatoPlugin(db, { dir: path.join(FIX, 'openurl-v1') }, {});
    await loader.loadElgatoPlugin('com.ld.openurl');
    const ho = loader.getExternalHandler('com.ld.openurl.open') as Function;
    await ho({}, { buttonId: 'b1', timestamp: Date.now() });
    expect(wsEvents.some((e) => e.eventType === 'plugin.event' && e.payload?.eventName === 'system.open-url')).toBe(true);
  }, 15000);

  it('settings: schema desde defaults y didReceiveSettings en el pulso', async () => {
    wsEvents.length = 0;
    const res = await importElgatoPlugin(db, { dir: path.join(FIX, 'clock-settings-v1') }, {});
    expect(res.installed).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join((res as any).path, 'manifest.json'), 'utf8'));
    expect(manifest.settingsSchema?.properties?.interval?.type).toBe('number');
    await loader.loadElgatoPlugin('com.ld.clocksettings');
    const h = loader.getExternalHandler('com.ld.clocksettings.tick') as Function;
    // PUT de ajustes (DatabaseService) → el pulso los entrega como settings.
    loader.savePluginSettings('com.ld.clocksettings', { interval: '7', label: 't' });
    const r: any = await h({ interval: 7 }, { buttonId: 'b1', timestamp: Date.now() });
    expect(r.visuals.title).toBe('7');
    // sendToPropertyInspector del keyUp llega como evento estructurado.
    expect(wsEvents.some((e) => e.eventType === 'plugin.event' && e.payload?.eventName === 'elgato.pi-send')).toBe(true);
  }, 15000);

  it('multi: una acción LibreDeck por acción Elgato, contextos por botón', async () => {
    await importElgatoPlugin(db, { dir: path.join(FIX, 'multi-v1') }, {});
    await loader.loadElgatoPlugin('com.ld.multi');
    const ha = loader.getExternalHandler('com.ld.multi.alpha') as Function;
    const hb = loader.getExternalHandler('com.ld.multi.beta') as Function;
    const ra: any = await ha({}, { buttonId: 'b1', timestamp: Date.now() });
    const rb: any = await hb({}, { buttonId: 'b1', timestamp: Date.now() });
    expect(ra.visuals.title).toBe('alpha!');
    expect(rb.visuals.title).toBe('beta!');
    expect(ra.context).not.toBe(rb.context);
    const st = await loader.getElgatoState('com.ld.multi');
    expect((st.state.contexts as any[]).length).toBe(2);
  }, 15000);

  it('mixed: el dial se rechaza y la tecla funciona', async () => {
    const res = await importElgatoPlugin(db, { dir: path.join(FIX, 'mixed-v1') }, {});
    expect(res.installed).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join((res as any).path, 'manifest.json'), 'utf8'));
    expect(manifest.actions.map((a: any) => a.id)).toEqual(['tap']);
    await loader.loadElgatoPlugin('com.ld.mixed');
    const h = loader.getExternalHandler('com.ld.mixed.tap') as Function;
    const r: any = await h({}, { buttonId: 'b1', timestamp: Date.now() });
    expect(r.ok).toBe(true);
    expect(r.visuals.title).toBe('tap!');
  }, 15000);

  it('sdk-v1: importa con bridge SDK y pulsa (import→key→state)', async () => {
    const res = await importElgatoPlugin(db, { dir: path.join(FIX, 'sdk-v1') }, {});
    expect(res.installed).toBe(true);
    const dest = (res as any).path as string;
    const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
    expect(manifest['x-elgato'].codeStyle).toBe('sdk');
    const bridge = fs.readFileSync(path.join(dest, 'shim-bridge.js'), 'utf8');
    expect(bridge).toContain('createElgatoShim');
    expect(bridge).not.toContain('installRawGlobals');
    expect(bridge).not.toMatch(/Bun\.serve|child_process/);

    await loader.loadElgatoPlugin('com.ld.sdk');
    const h = loader.getExternalHandler('com.ld.sdk.ping') as Function;
    expect(typeof h).toBe('function');
    const r1: any = await h({}, { buttonId: 'b1', timestamp: Date.now() });
    expect(r1.ok).toBe(true);
    expect(r1.context).toBe('ld:com.ld.sdk:ping:b1');
    expect(r1.visuals.title).toBe('pong');
    const st = await loader.getElgatoState('com.ld.sdk');
    expect(st.shim).toBe(true);
    const ctx = (st.state.contexts as any[]).find((c) => c.context === 'ld:com.ld.sdk:ping:b1');
    expect(ctx.state.title).toBe('pong');
  }, 15000);

  it('raw-v1: importa con bridge raw y pulsa vía socket virtual (import→key→state)', async () => {
    const res = await importElgatoPlugin(db, { dir: path.join(FIX, 'raw-v1') }, {});
    expect(res.installed).toBe(true);
    const dest = (res as any).path as string;
    const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
    expect(manifest['x-elgato'].codeStyle).toBe('raw');
    const bridge = fs.readFileSync(path.join(dest, 'shim-bridge.js'), 'utf8');
    expect(bridge).toContain('installRawGlobals');
    expect(bridge).toContain('await import(');
    expect(bridge).not.toMatch(/Bun\.serve|child_process|spawn\(/);
    // Bun antepone su `ws` incorporado: el bridge importa una copia generada
    // con el especificador reescrito (fuentes intactas).
    expect(bridge).toContain('shim-raw-entry');
    const entryAbs = path.join(dest, 'elgato', 'shim-raw-entry.js');
    expect(fs.existsSync(entryAbs)).toBe(true);
    const entryText = fs.readFileSync(entryAbs, 'utf8');
    expect(entryText).toContain('elgato-raw-transport.js');
    expect(entryText).not.toMatch(/from\s+["']ws["']/);
    expect(entryText).toContain('new WebSocket');
    expect(fs.existsSync(path.join(dest, 'elgato-raw-transport.js'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'elgato', 'node_modules', 'ws', 'index.js'))).toBe(true);
    const sdkJs = fs.readFileSync(path.join(dest, 'elgato-shim-sdk.js'), 'utf8');
    expect(sdkJs).not.toMatch(/child_process|Bun\.serve/);

    // Registro perezoso también en el camino raw: sin Worker hasta pulsar.
    expect(await loader.loadElgatoPlugin('com.ld.raw')).toBe(true);
    expect((loader as any).externalWorkers.has('com.ld.raw')).toBe(false);
    const h = loader.getExternalHandler('com.ld.raw.ping') as Function;
    expect(typeof h).toBe('function');
    const r1: any = await h({}, { buttonId: 'b1', timestamp: Date.now() });
    expect(r1.ok).toBe(true);
    expect(r1.context).toBe('ld:com.ld.raw:ping:b1');
    expect(r1.downCalled).toBe(true);
    expect(r1.visuals.title).toBe('raw!');
    // Eco de settings (ciclo host→plugin→host) persistido en el contexto.
    expect(r1.visuals.settings.echoed).toBe(true);
    const st = await loader.getElgatoState('com.ld.raw');
    expect(st.shim).toBe(true);
    const ctx = (st.state.contexts as any[]).find((c) => c.context === 'ld:com.ld.raw:ping:b1');
    expect(ctx.state.title).toBe('raw!');
  }, 15000);

  it('writeShimFiles es idempotente y ensureShimBridge migra instalaciones legacy', async () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-bridge-'));
    const elgatoDir = path.join(dest, 'elgato');
    fs.mkdirSync(path.join(elgatoDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(elgatoDir, 'bin', 'plugin.js'), 'export default {};');
    const a = [{ shortId: 'count', uuid: 'com.ld.counter.count' }];
    const r1 = writeShimFiles({ dest, elgatoDir, pluginId: 'com.ld.counter', codeRel: 'bin/plugin.js', actions: a });
    const r2 = writeShimFiles({ dest, elgatoDir, pluginId: 'com.ld.counter', codeRel: 'bin/plugin.js', actions: a });
    expect(r1).toEqual(r2);
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({
      id: 'com.ld.counter', name: 'C', version: '1.0.0', permissions: [],
      actions: [{ id: 'count', name: 'Count' }],
      'x-elgato': { uuid: 'com.ld.counter', originalActions: ['com.ld.counter.count'] },
    }));
    fs.writeFileSync(path.join(dest, 'elgato-manifest.json'), JSON.stringify({
      UUID: 'com.ld.counter', CodePath: 'bin/plugin.js',
    }));
    fs.rmSync(path.join(dest, 'shim-bridge.js'));
    expect(ensureShimBridge(dest)).toBe(true);
    expect(fs.existsSync(path.join(dest, 'shim-bridge.js'))).toBe(true);
  });
});

describe('shim: rendimiento', () => {
  it('sin procesos node ni Bun.serve por plugin', async () => {
    // El manager legacy nunca se instancia en modo shim.
    expect((loader as any).elgatoManager).toBeFalsy();
    // Los paquetes instalados no contienen spawns de node.
    const dir = path.join(TMP, 'plugins', 'com.ld.counter');
    const bridge = fs.readFileSync(path.join(dir, 'shim-bridge.js'), 'utf8');
    expect(bridge).not.toMatch(/child_process|Bun\.serve|spawn\(/);
    const sdk = fs.readFileSync(path.join(dir, 'elgato-shim-sdk.js'), 'utf8');
    expect(sdk).not.toMatch(/child_process|Bun\.serve/);
  });

  it('larga espera: LONG_HOLD acotado por defecto', () => {
    expect(LONG_HOLD_MS_DEFAULT).toBeLessThanOrEqual(1000);
  });
});
