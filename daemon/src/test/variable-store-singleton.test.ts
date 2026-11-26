/**
 * variable-store-singleton.test.ts — runner, API y WS comparten UN SOLO
 * VariableStore (misma caché en memoria).
 *
 * Regresión real: ActionRunner construía su propio `new VariableStore(db)`
 * con caché independiente del singleton (`setVariableStore` del server).
 * Tras una escritura del runner, `GET /variables/:name` (singleton) servía
 * el valor rancio de SU caché indefinidamente; y si el valor coincidía con
 * la caché rancia, el `set` posterior calculaba changed=false y se perdía
 * hasta el broadcast `variable.changed` por WS (el icono remoto no cambiaba).
 *
 * Corre aislada (BD real en tmp) y en suite completa (mock compartido).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDatabase } from '../db';
import {
  getVariableStore,
  resetVariableStore,
  setVariableStore,
  VariableStore,
} from '../variables/store';
import { ActionRunner } from '../action-runner';
import type { PluginLoader } from '../plugin-loader';

function makeFakeLoader(): PluginLoader {
  return { setActionCallbacks: () => {} } as unknown as PluginLoader;
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

const ctx: any = { buttonId: 'b1', profileId: 'p1', pageId: 'pg1', position: 0, timestamp: Date.now() };

beforeAll(async () => {
  try {
    process.env.LIBREDECK_DATA_DIR = join(tmpdir(), `libredeck-test-varsingleton-${process.pid}`);
    await initDatabase();
  } catch { /* suite completa: rige el mock compartido */ }
});

beforeEach(() => {
  resetVariableStore();
});

describe('store único compartido', () => {
  it('1. el runner usa el mismo store que la API/WS (misma instancia)', () => {
    const runner = new ActionRunner(makeFakeLoader());
    expect(runner.getVariableStore()).toBe(getVariableStore());
  });

  it('2. toggle vía runner se lee igual vía singleton y emite broadcast con tipo', async () => {
    const cap = captureBroadcast();
    try {
      const runner = new ActionRunner(makeFakeLoader());
      getVariableStore().define({ name: 'vsShared', type: 'bool', value: false });
      const r = await runner.executeAction(
        { id: 'x1', type: 'local.toggle-var', parameters: { name: 'vsShared' } } as any,
        ctx,
      );
      expect(r.success).toBe(true);
      // Lectura "de API" (singleton): debe ver el true del runner.
      expect(getVariableStore().get('vsShared')?.value).toBe(true);
      const changed = cap.sent.filter(([e]) => e === 'variable.changed');
      expect(changed.length).toBe(1);
      expect(changed[0][2]).toBe('variables');
      expect(changed[0][1]).toMatchObject({ name: 'vsShared', value: true, type: 'bool' });
    } finally {
      cap.done();
    }
  });

  it('3. ida y vuelta cruzada sin valores rancios', async () => {
    const runner = new ActionRunner(makeFakeLoader());
    const api = getVariableStore();
    api.define({ name: 'vsPing', type: 'bool', value: false });
    // La API lee primero (rellena SU caché con false).
    expect(api.get('vsPing')?.value).toBe(false);
    // El runner cambia a true...
    await runner.executeAction(
      { id: 'x2', type: 'local.toggle-var', parameters: { name: 'vsPing' } } as any,
      ctx,
    );
    // ...y la API debe ver true, no el false rancio de antes.
    expect(getVariableStore().get('vsPing')?.value).toBe(true);
    // Y al revés: la API escribe y el runner lee lo nuevo.
    api.set('vsPing', false, { source: 'test' });
    await runner.executeAction(
      { id: 'x3', type: 'local.toggle-var', parameters: { name: 'vsPing' } } as any,
      ctx,
    );
    expect(getVariableStore().get('vsPing')?.value).toBe(true);
  });

  it('4. setVariableStore reemplaza la instancia que ve el runner', () => {
    const runner = new ActionRunner(makeFakeLoader());
    const fresh = new VariableStore(undefined as any);
    setVariableStore(fresh);
    try {
      expect(runner.getVariableStore()).toBe(fresh);
    } finally {
      resetVariableStore();
    }
  });
});
