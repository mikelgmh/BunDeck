/**
 * action-exposed-vars.test.ts — variables expuestas por las acciones.
 *
 * Cubre:
 * 1. Contrato: cada acción mapeada declara sus `variables` en el manifiesto
 *    y en `EXPOSED_ACTION_VARS` (mismo nombre/tipo).
 * 2. Runtime: cada ejecución exitosa actualiza la variable (estado real del
 *    resultado; toggle optimista cuando el resultado no trae estado).
 * 3. Una ejecución fallida NO publica nada.
 *
 * Corre aislada (BD real en tmp) y en suite completa (mock compartido).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { DatabaseService, initDatabase } from '../db';
import { resetVariableStore } from '../variables/store';
import {
  EXPOSED_ACTION_VARS,
  applyExposedResult,
  exposedDeclsFor,
  extractExposedValues,
} from '../variables/exposed';
import { ActionRunner } from '../action-runner';
import { DiscordPlugin } from '../plugins/discord.plugin';
import { ObsPlugin } from '../plugins/obs.plugin';
import { AudioMixerPlugin } from '../plugins/audio-mixer.plugin';
import { MultimediaPlugin } from '../plugins/multimedia.plugin';

function stubCtx() {
  const settings = new Map<string, string>();
  return {
    log: () => {},
    getSetting: (k: string) => settings.get(k) ?? null,
    setSetting: (k: string, v: string) => { settings.set(k, v); },
    deleteSetting: (k: string) => { settings.delete(k); },
  };
}

function manifestVars(plugin: { getManifest: () => any }): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const m = plugin.getManifest();
  for (const a of m.actions ?? []) {
    out[`${m.id}.${a.id}`] = (a.variables ?? []).map((v: any) => `${v.name}:${v.type}`);
  }
  return out;
}

beforeAll(async () => {
  try {
    process.env.LIBREDECK_DATA_DIR = join(tmpdir(), `libredeck-test-exposed-${process.pid}`);
    await initDatabase();
  } catch { /* suite completa: rige el mock compartido */ }
});

beforeEach(() => {
  resetVariableStore();
});

describe('contrato: manifiesto ↔ EXPOSED_ACTION_VARS', () => {
  it('1. toda acción mapeada declara la misma variable en su manifiesto', () => {
    const vars = {
      ...manifestVars(new DiscordPlugin(stubCtx() as any)),
      ...manifestVars(new ObsPlugin(stubCtx() as any)),
      ...manifestVars(new AudioMixerPlugin(stubCtx() as any)),
      ...manifestVars(new MultimediaPlugin(stubCtx() as any)),
    };
    for (const [action, decls] of Object.entries(EXPOSED_ACTION_VARS)) {
      expect(decls.length).toBeGreaterThan(0);
      for (const d of decls) {
        expect(vars[action] ?? []).toContain(`${d.name}:${d.type}`);
      }
    }
  });

  it('2. exposedDeclsFor devuelve vacío para acciones sin estado', () => {
    expect(exposedDeclsFor('shell.exec')).toEqual([]);
    expect(exposedDeclsFor('discord.toggle-mute').map((d) => d.name)).toEqual(['discordMuted']);
  });
});

describe('extractExposedValues: estado real vs toggle optimista', () => {
  const prev = (v: unknown) => (_name: string) => v;
  it('3. discord RPC usa mute/deaf reales', () => {
    expect(extractExposedValues('discord.toggle-mute', { mute: true }, {}, prev(false))).toEqual({ discordMuted: true });
    expect(extractExposedValues('discord.toggle-deafen', { deaf: false }, {}, prev(true))).toEqual({ discordDeafened: false });
  });
  it('4. discord hotkey (sin estado) invierte el almacenado', () => {
    expect(extractExposedValues('discord.toggle-mute', { transport: 'hotkey' }, {}, prev(false))).toEqual({ discordMuted: true });
    expect(extractExposedValues('discord.toggle-deafen', { transport: 'hotkey' }, {}, prev(true))).toEqual({ discordDeafened: false });
  });
  it('5. obs usa outputActive/muted reales y deduce start/stop', () => {
    expect(extractExposedValues('obs.stream', { outputActive: true }, {}, prev(false))).toEqual({ obsStreaming: true });
    expect(extractExposedValues('obs.record', { outputActive: false }, {}, prev(true))).toEqual({ obsRecording: false });
    expect(extractExposedValues('obs.stream', { requested: 'start' }, {}, prev(false))).toEqual({ obsStreaming: true });
    expect(extractExposedValues('obs.stream', { requested: 'toggle' }, {}, prev(true))).toEqual({ obsStreaming: false });
    expect(extractExposedValues('obs.mute', { muted: true }, {}, prev(false))).toEqual({ obsMuted: true });
  });
  it('6. audio-mixer usa muted real; win "toggle" invierte', () => {
    expect(extractExposedValues('audio-mixer.mic-mute', { muted: true }, {}, prev(false))).toEqual({ audioMicMuted: true });
    expect(extractExposedValues('audio-mixer.mic-mute', { muted: 'toggle' }, {}, prev(true))).toEqual({ audioMicMuted: false });
  });
  it('7. multimedia: play/pause fijan, mute/playpause invierten', () => {
    expect(extractExposedValues('multimedia.multimedia', { action: 'play' }, {}, prev(false))).toEqual({ multimediaPlaying: true });
    expect(extractExposedValues('multimedia.multimedia', { action: 'pause' }, {}, prev(true))).toEqual({ multimediaPlaying: false });
    expect(extractExposedValues('multimedia.multimedia', { action: 'mute' }, {}, prev(false))).toEqual({ multimediaMuted: true });
    expect(extractExposedValues('multimedia.multimedia', { action: 'playpause' }, {}, prev(true))).toEqual({ multimediaPlaying: false });
    expect(extractExposedValues('multimedia.multimedia', { action: 'volumeup' }, {}, prev(false))).toBeNull();
  });
});

describe('runtime: ActionRunner publica tras ejecutar', () => {
  function makeRunner(): ActionRunner {
    return new ActionRunner({ setActionCallbacks: () => {} } as any);
  }

  /** La BD se comparte entre tests del fichero: parte de variable limpia. */
  async function freshBool(store: any, name: string, value: boolean): Promise<void> {
    try { await store.delete(name); } catch { /* no existía */ }
    store.define({ name, type: 'bool', value });
  }

  it('8. discord.toggle-mute con mute real actualiza discordMuted', async () => {
    const runner = makeRunner();
    runner.registerAction('discord.toggle-mute', async () => ({ action: 'toggle-mute', transport: 'rpc', mute: true }));
    const r = await runner.executeAction({ type: 'discord.toggle-mute', parameters: {} }, { timestamp: Date.now() } as any);
    expect(r.success).toBe(true);
    expect(runner.getVariableStore().get('discordMuted')?.value).toBe(true);
    runner.dispose();
  });

  it('9. discord hotkey alterna el valor previo (ejemplo: tecla mute cambia icono)', async () => {
    const runner = makeRunner();
    const store = runner.getVariableStore();
    await freshBool(store, 'discordMuted', false);
    runner.registerAction('discord.toggle-mute', async () => ({ action: 'toggle-mute', transport: 'hotkey' }));
    await runner.executeAction({ type: 'discord.toggle-mute', parameters: {} }, { timestamp: Date.now() } as any);
    expect(store.get('discordMuted')?.value).toBe(true);
    await runner.executeAction({ type: 'discord.toggle-mute', parameters: {} }, { timestamp: Date.now() } as any);
    expect(store.get('discordMuted')?.value).toBe(false);
    runner.dispose();
  });

  it('10. obs.stream / obs.record / audio-mixer publican su estado', async () => {
    const runner = makeRunner();
    const store = runner.getVariableStore();
    runner.registerAction('obs.stream', async () => ({ action: 'stream', requested: 'toggle', outputActive: true }));
    runner.registerAction('obs.record', async () => ({ action: 'record', requested: 'toggle', outputActive: false }));
    runner.registerAction('audio-mixer.mic-mute', async () => ({ muted: true }));
    await runner.executeAction({ type: 'obs.stream', parameters: {} }, { timestamp: Date.now() } as any);
    await runner.executeAction({ type: 'obs.record', parameters: {} }, { timestamp: Date.now() } as any);
    await runner.executeAction({ type: 'audio-mixer.mic-mute', parameters: {} }, { timestamp: Date.now() } as any);
    expect(store.get('obsStreaming')?.value).toBe(true);
    expect(store.get('obsRecording')?.value).toBe(false);
    expect(store.get('audioMicMuted')?.value).toBe(true);
    runner.dispose();
  });

  it('11. un fallo NO publica nada', async () => {
    const runner = makeRunner();
    const store = runner.getVariableStore();
    await freshBool(store, 'discordMuted', false);
    runner.registerAction('discord.toggle-mute', async () => { throw new Error('RPC caído'); });
    const r = await runner.executeAction({ type: 'discord.toggle-mute', parameters: {} }, { timestamp: Date.now() } as any);
    expect(r.success).toBe(false);
    expect(store.get('discordMuted')?.value).toBe(false);
    runner.dispose();
  });

  it('12. applyExposedResult ignora acciones sin mapeo', async () => {
    const runner = makeRunner();
    const store = runner.getVariableStore();
    try { await (store as any).delete('shellSentinel'); } catch { /* noop */ }
    await applyExposedResult(store as any, 'shell.exec', { ok: true }, {});
    expect(store.get('shellSentinel')).toBeNull();
    // …y no toca variables ajenas
    expect(store.get('discordMuted')?.value).toBe(false);
    runner.dispose();
  });
});
