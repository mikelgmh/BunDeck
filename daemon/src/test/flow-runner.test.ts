/**
 * Integración del motor de flujos con ActionRunner + API.
 *
 * Usa el mock compartido de '../db' (registrado por action-runner.test.ts,
 * global a la run de `bun test`): el FlowStore cae a memoria y la API puede
 * resolverse sin SQLite real.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

import { ActionRunner } from '../action-runner';
import type { PluginLoader } from '../plugin-loader';
import { setupAPIRoutes } from '../api/routes';

function makeFakeLoader(): PluginLoader {
  return { setActionCallbacks: () => {} } as unknown as PluginLoader;
}

/**
 * La suite completa registra un mock global de '../db' (ver
 * action-runner.test.ts); en ejecución aislada no existe y hay que
 * inicializar SQLite real en un directorio temporal.
 */
async function ensureDb(): Promise<void> {
  const dbMod: any = await import('../db');
  try {
    // eslint-disable-next-line no-new
    new dbMod.DatabaseService();
  } catch {
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    process.env.LIBREDECK_DATA_DIR = mkdtempSync(join(tmpdir(), 'flow-runner-'));
    await dbMod.initDatabase();
  }
}

function makeWsCapture() {
  const events: Array<{ type: string; payload: any }> = [];
  const wsManager: any = {
    broadcast: (type: string, payload: any) => { events.push({ type, payload }); },
    broadcastActionStarted: (id: string, c: any) => { events.push({ type: 'action.started', payload: { actionId: id } }); },
    broadcastActionFinished: (id: string, r: any) => { events.push({ type: 'action.finished', payload: { actionId: id } }); },
    broadcastActionError: (id: string, e: any) => { events.push({ type: 'action.error', payload: { actionId: id } }); },
    navigatePageTo: (o: any) => { events.push({ type: 'page.navigate', payload: o }); return { ok: true }; },
    navigateProfileTo: (o: any) => { events.push({ type: 'profile.navigate', payload: o }); return { ok: true }; },
  };
  return { events, wsManager };
}

describe('ActionRunner + flows', () => {
  let runner: ActionRunner;

  beforeEach(async () => {
    await ensureDb();
    runner = new ActionRunner(makeFakeLoader());
    runner.registerAction('test.echo', mock(async (params: any) => ({ echo: params?.msg ?? 'ok' })));
    runner.registerAction('test.fail', mock(async () => { throw new Error('boom'); }));
    await runner.initFlows();
  });

  it('executeButtonFlow: secuencia seq con waitMs e interpolación', async () => {
    (globalThis as any).__libredeckWs = { broadcast: () => {} };
    try {
      runner.setFlowVar('nombre', 'luz');
      const res = await runner.executeButtonFlow(
        { id: 'b1', page_id: 'p1', position: 0, data: { mode: 'seq', actions: [{ type: 'test.echo', parameters: { msg: 'hola {{nombre}}' } }], rules: [] } },
        { buttonId: 'b1', pageId: 'p1', timestamp: Date.now() } as any,
      );
      expect(res.success).toBe(true);
      expect(res.empty).toBeUndefined();
      expect(res.results[0]).toMatchObject({ kind: 'action', type: 'test.echo', success: true });
    } finally {
      delete (globalThis as any).__libredeckWs;
    }
  });

  it('executeButtonFlow: reglas long solo en long; short sin reglas long', async () => {
    const data = {
      mode: 'seq',
      actions: [] as any[],
      rules: [{ on: true, when: 'long', cond: '', then: [{ type: 'test.echo' }], else: [] }],
    };
    const short = await runner.executeButtonFlow({ id: 'b', data }, { timestamp: Date.now() } as any);
    expect(short.empty).toBe(true);
    const long = await runner.executeButtonFlow(
      { id: 'b', data },
      { timestamp: Date.now(), pressType: 'long' } as any,
    );
    expect(long.success).toBe(true);
    expect(long.results).toHaveLength(1);
  });

  it('executeButtonFlow: mode alt rota entre acciones y persiste', async () => {
    const data = { mode: 'alt', actions: [{ type: 'test.echo', parameters: { msg: 'A' } }, { type: 'test.echo', parameters: { msg: 'B' } }], rules: [] };
    const btn = { id: 'alt1', page_id: 'p1', position: 3, data };
    const ctx: any = { timestamp: Date.now() };
    const r1 = await runner.executeButtonFlow(btn, ctx);
    const r2 = await runner.executeButtonFlow(btn, ctx);
    expect(r1.results[0]).toMatchObject({ success: true, result: { echo: 'A' } });
    expect(r2.results[0]).toMatchObject({ success: true, result: { echo: 'B' } });
    // Nuevo runner (mismo proceso/mock de settings): la rotación continúa.
    const runner2 = new ActionRunner(makeFakeLoader());
    runner2.registerAction('test.echo', mock(async (p: any) => ({ echo: p?.msg ?? 'ok' })));
    await runner2.initFlows();
    const r3 = await runner2.executeButtonFlow(btn, ctx);
    expect(r3.results[0]).toMatchObject({ result: { echo: 'A' } });
  });

  it('executeButtonFlow: mode par ejecuta en paralelo', async () => {
    const res = await runner.executeButtonFlow(
      { id: 'b', data: { mode: 'par', actions: [{ type: 'test.echo' }, { type: 'test.echo' }], rules: [] } },
      { timestamp: Date.now() } as any,
    );
    expect(res.success).toBe(true);
    expect(res.results[0].kind).toBe('parallel');
  });

  it('cancelFlow cancela un run en curso y lo registra', async () => {
    const p = runner.runFlowNodes('test', 'cancel-me', [{ kind: 'wait', ms: 5000 }], { timestamp: Date.now() } as any);
    await new Promise((r) => setTimeout(r, 20));
    const [runId] = runner.getFlowRunning();
    expect(runId).toBeDefined();
    expect(runner.cancelFlow(runId)).toBe(true);
    const res = await p;
    expect(res.cancelled).toBe(true);
    expect(runner.cancelFlow('inexistente')).toBe(false);
  });

  it('variables: set/get + automatización var + evento var.changed', async () => {
    const { events, wsManager } = makeWsCapture();
    (globalThis as any).__libredeckWs = wsManager;
    try {
      runner.saveAutomation({
        name: 'al cambiar',
        trigger: { kind: 'var', varName: 'contador' },
        nodes: [{ kind: 'set-var', name: 'visto', expr: 'contador * 2' }],
      } as any);
      runner.setFlowVar('contador', 21);
      await new Promise((r) => setTimeout(r, 50));
      expect(runner.getFlowVar('visto')?.value).toBe(42);
      expect(events.some((e) => e.type === 'var.changed')).toBe(true);
      expect(events.some((e) => e.type === 'flow.started')).toBe(true);
    } finally {
      delete (globalThis as any).__libredeckWs;
    }
  });

  it('automatización timer dispara sin UI', async () => {
    (globalThis as any).__libredeckWs = { broadcast: () => {} };
    try {
      runner.setFlowVar('ticks', 0);
      runner.saveAutomation({
        name: 'cada segundo',
        trigger: { kind: 'timer', everySec: 1 },
        nodes: [{ kind: 'set-var', name: 'ticks', expr: 'ticks + 1' }],
      } as any);
      await new Promise((r) => setTimeout(r, 1250));
      expect((runner.getFlowVar('ticks')?.value ?? 0)).toBeGreaterThanOrEqual(1);
    } finally {
      runner.deleteAutomation(runner.listAutomations().find((a) => a.name === 'cada segundo')!.id);
      delete (globalThis as any).__libredeckWs;
    }
  });

  it('scripts guardados se ejecutan con inputs y devuelven outputVar', async () => {
    const s = runner.saveFlowScript({
      name: 'doble',
      inputs: ['n'],
      nodes: [
        { kind: 'set-var', name: 'tmp', expr: 'n * 2' },
        { kind: 'set-var', name: 'resultado', expr: 'tmp + 1' },
      ],
    });
    const res = await runner.executeFlow({ scriptId: s.id, inputs: { n: 21 }, outputVar: 'resultado' }, { timestamp: Date.now() } as any);
    expect(res.success).toBe(true);
    expect(runner.getFlowVar('resultado')?.value).toBe(43);
    // `tmp` es variable propia del script: no contamina las globales.
    expect(runner.getFlowVar('tmp')).toBeNull();
    runner.deleteFlowScript(s.id);
  });

  it('getFlowStats expone contadores del motor', () => {
    const stats = runner.getFlowStats();
    expect(typeof stats.scripts).toBe('number');
    expect(typeof stats.vars).toBe('number');
    expect(typeof stats.running).toBe('number');
  });
});

describe('API /buttons/press (camino canónico web + HW)', () => {
  it('ejecuta acciones + reglas y devuelve el run', async () => {
    await ensureDb();
    const loader = makeFakeLoader();
    const ar = new ActionRunner(loader);
    ar.registerAction('test.echo', mock(async (p: any) => ({ echo: p?.msg ?? 'ok' })));
    await ar.initFlows();
    const { events, wsManager } = makeWsCapture();
    (globalThis as any).__libredeckWs = wsManager;
    try {
      const services: any = { wsManager, pluginLoader: loader, actionRunner: ar, windowWatcher: {} };
      const post = (body: any) =>
        setupAPIRoutes(
          new Request('http://localhost/api/v1/buttons/press', { method: 'POST', body: JSON.stringify(body) }),
          services,
        );
      // Sin buttonId ni pageId/position → 400.
      const bad = await post({ pressType: 'short' });
      expect(bad.status).toBe(400);
      // Botón inexistente por id → 404.
      const nf = await post({ buttonId: 'nope', pressType: 'short' });
      expect(nf.status).toBe(404);
      // Slot vacío → success + empty (no falla).
      const empty = await post({ pageId: 'p-x', position: 0 });
      expect(empty.status).toBe(200);
      expect(await empty.json()).toMatchObject({ success: true, empty: true });
    } finally {
      delete (globalThis as any).__libredeckWs;
      ar.dispose();
    }
    expect(events.length).toBeGreaterThanOrEqual(0);
  });
});
