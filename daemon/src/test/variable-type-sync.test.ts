/**
 * variable-type-sync.test.ts — el tipo viaja con el valor (acción → WS → web).
 *
 * Regresión del caso real: pulsar discord mute/unmute publicaba
 * `discordMuted` sin tipo en el payload `variable.changed`; la web lo
 * guardaba como texto ('true') y la condición `discordMuted == true`
 * no matcheaba nunca ('true' == true es false). Además, con la condición
 * de nombre escueto, el 'false' textual es truthy y la apariencia nunca
 * volvía a la base.
 *
 * Cubre (lado daemon):
 * 1. applyExposedResult deja bool en el store y el broadcast WS lleva type.
 * 2. Repetir el mismo valor no reemite (sin spam).
 * 3. El toggle optimista invierte el previo manteniendo bool.
 * 4. Documenta por qué importa el tipo en `==` (daemon ev).
 *
 * Funciona con la BD real (corrida aislada: initDatabase en tmp) y con el
 * mock compartido (suite completa).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { DatabaseService, initDatabase } from '../db';
import { VariableStore, resetVariableStore } from '../variables/store';
import { applyExposedResult } from '../variables/exposed';
import { ev } from '../variables/expressions';

function makeStore(): VariableStore {
  return new VariableStore(new DatabaseService());
}

function captureBroadcast() {
  const sent: Array<[string, any, string?]> = [];
  (globalThis as any).__libredeckWs = {
    broadcast: (e: string, p: any, t?: string) => sent.push([e, p, t]),
  };
  return {
    sent,
    done() {
      delete (globalThis as any).__libredeckWs;
    },
  };
}

beforeAll(async () => {
  try {
    process.env.LIBREDECK_DATA_DIR = join(tmpdir(), `libredeck-test-vartype-${process.pid}`);
    await initDatabase();
  } catch { /* suite completa: rige el mock compartido */ }
});

beforeEach(() => {
  resetVariableStore();
});

describe('tipo acción → WS → web', () => {
  it('1. discordMuted llega al broadcast con type bool y valor bool', async () => {
    const cap = captureBroadcast();
    try {
      const store = makeStore();
      await applyExposedResult(store as any, 'discord.toggle-mute', { mute: true }, {});
      const def = store.get('discordMuted');
      expect(def?.value).toBe(true);
      expect(def?.type).toBe('bool');
      const changed = cap.sent.filter(([e]) => e === 'variable.changed');
      expect(changed.length).toBe(1);
      expect(changed[0][2]).toBe('variables');
      expect(changed[0][1]).toMatchObject({ name: 'discordMuted', value: true, type: 'bool' });
    } finally {
      cap.done();
    }
  });

  it('2. repetir el mismo valor no reemite (sin spam de WS)', async () => {
    const cap = captureBroadcast();
    try {
      const store = makeStore();
      await applyExposedResult(store as any, 'discord.toggle-mute', { mute: true }, {});
      const n = cap.sent.filter(([e]) => e === 'variable.changed').length;
      await applyExposedResult(store as any, 'discord.toggle-mute', { mute: true }, {});
      expect(cap.sent.filter(([e]) => e === 'variable.changed').length).toBe(n);
    } finally {
      cap.done();
    }
  });

  it('3. el toggle optimista (sin estado real) invierte el previo en bool', async () => {
    const cap = captureBroadcast();
    try {
      const store = makeStore();
      await store.set('discordMuted', false, { type: 'bool', source: 'test' });
      cap.sent.length = 0;
      // Resultado sin `mute`: la acción no pudo leer el estado real.
      await applyExposedResult(store as any, 'discord.toggle-mute', {}, {});
      expect(store.get('discordMuted')?.value).toBe(true);
      expect(store.get('discordMuted')?.type).toBe('bool');
      expect(cap.sent.filter(([e]) => e === 'variable.changed').length).toBe(1);
    } finally {
      cap.done();
    }
  });

  it('4. con texto, `x == true` no matchea (por eso el tipo es crítico)', () => {
    // Lo que pasaba antes: la web guardaba 'true' (string) y la condición
    // `discordMuted == true` evaluaba 'true' == true → false. Siempre.
    expect(ev('x == true', { x: 'true' } as any)).toBe(false);
    expect(ev('x == true', { x: true } as any)).toBe(true);
  });
});
