/**
 * Tests del motor de flujos persistente (daemon/src/flow/* + ActionRunner).
 *
 * Cubre: expresiones, migración de reglas KeyInspector/useKeyEngine, bloques
 * (secuencia/wait/If/Switch/Repeat/paralelo), timeout, cancelación, scripts
 * con inputs y variables propias, automatizaciones (timer/var/evento/load),
 * triggers short/long/double/touch, errores, persistencia tras reinicio y
 * eventos WS action.started/finished/error + flow.*.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ev, evb, intp, baseEnv, resolveNum } from '../flow/expressions';
import { buttonDataToNodes, buttonDataToAutomations, buttonHasTrigger, legacyActionToNode } from '../flow/migrate';
import { FlowEngine, type EngineDeps } from '../flow/engine';
import { FlowStore } from '../flow/store';
import { AutomationManager } from '../flow/automations';
import type { FlowNode, FlowScript, FlowVar } from '../flow/types';

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------

function makeVars(initial: Record<string, any> = {}): { vars: Map<string, FlowVar>; deps: EngineDeps; calls: any[]; emitted: Array<{ event: string; payload: any }> } {
  const vars = new Map<string, FlowVar>();
  for (const [name, value] of Object.entries(initial)) {
    vars.set(name, { name, type: typeof value === 'number' ? 'num' : typeof value === 'boolean' ? 'bool' : 'txt', value });
  }
  const calls: any[] = [];
  const emitted: Array<{ event: string; payload: any }> = [];
  const deps: EngineDeps = {
    executeAction: async (a: any, _c: any) => {
      calls.push(a);
      if (a.type === 'test.fail') return { success: false, error: 'boom' };
      if (a.type === 'test.hang') return new Promise(() => {});
      return { success: true, result: { echo: a.type, params: a.parameters } };
    },
    getVar: (name: string) => vars.get(name),
    setVar: (name: string, value: any) => {
      const prev = vars.get(name);
      const type = prev?.type ?? (typeof value === 'number' ? 'num' : typeof value === 'boolean' ? 'bool' : 'txt');
      const changed = !prev || prev.value !== value;
      vars.set(name, { name, type, value });
      return changed;
    },
    listVars: () => [...vars.values()],
    getScript: (_id: string) => null,
    log: () => {},
    emit: (event: string, payload: any) => { emitted.push({ event, payload }); },
  };
  return { vars, deps, calls, emitted };
}

const ctx = (extra: any = {}) => ({ timestamp: Date.now(), ...extra });

// ---------------------------------------------------------------------------
// Expresiones (paridad con el cliente)
// ---------------------------------------------------------------------------

describe('flow expressions', () => {
  it('evalúa operadores y funciones como el cliente', () => {
    const E = baseEnv([{ n: 'contador', v: 4 }], 'P', 'Q');
    expect(ev('contador + 1', E)).toBe(5);
    expect(ev('contador > 3 y no falso', E)).toBe(true);
    expect(ev('mayus("hola")', E)).toBe('HOLA');
    expect(ev('longitud("hola")', E)).toBe(4);
    expect(ev('contador > 3 ? "sí" : "no"', E)).toBe('sí');
    expect(evb('contador == 4', E)).toBe(true);
  });

  it('interpola {{vars}} en textos', () => {
    const E = baseEnv([{ n: 'x', v: 2 }], '', '');
    expect(intp('n={{x}}', E)).toBe('n=2');
    expect(intp('{{x + 1}}', E)).toBe('3');
  });

  it('resolveNum acepta literales y expresiones', () => {
    const E = baseEnv([{ n: 'x', v: 3 }], '', '');
    expect(resolveNum(10, E, 0)).toBe(10);
    expect(resolveNum('7', E, 0)).toBe(7);
    expect(resolveNum('{{x * 2}}', E, 0)).toBe(6);
    expect(resolveNum('basura', E, 42)).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Migración de reglas heredadas
// ---------------------------------------------------------------------------

describe('migrate legacy key config', () => {
  it('acciones base solo van en short; reglas press/long mapean', () => {
    const data = {
      mode: 'seq',
      actions: [{ type: 'utility.delay', parameters: { duration: 5 } }],
      rules: [{ on: true, when: 'long', cond: '', then: [{ type: 'test.echo' }], else: [] }],
    };
    const short = buttonDataToNodes(data, 'short');
    expect(short.hasContent).toBe(true);
    expect(short.nodes).toHaveLength(1);
    expect(short.nodes[0]).toMatchObject({ kind: 'action', type: 'utility.delay' });
    const long = buttonDataToNodes(data, 'long');
    expect(long.hasContent).toBe(true);
    expect(long.nodes[0]).toMatchObject({ kind: 'sequence' });
    const dbl = buttonDataToNodes(data, 'double');
    expect(dbl.hasContent).toBe(false);
  });

  it('mode par genera un nodo parallel', () => {
    const data = { mode: 'par', actions: [{ type: 'a' }, { type: 'b' }], rules: [] };
    const { nodes } = buttonDataToNodes(data, 'short');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: 'parallel' });
    expect((nodes[0] as any).branches).toHaveLength(2);
  });

  it('mode alt marca contenido para rotación del runner', () => {
    const data = { mode: 'alt', actions: [{ type: 'a' }, { type: 'b' }], rules: [] };
    const { nodes, hasContent, mode } = buttonDataToNodes(data, 'short');
    expect(mode).toBe('alt');
    expect(hasContent).toBe(true);
    expect(nodes).toHaveLength(0);
  });

  it('local.* se convierten a nodos de flujo', () => {
    expect(legacyActionToNode({ type: 'local.set-var', parameters: { name: 'c', expr: '1+1' } }))
      .toMatchObject({ kind: 'set-var', name: 'c' });
    expect(legacyActionToNode({ type: 'local.toggle-var', parameters: { name: 'm' } }))
      .toMatchObject({ kind: 'toggle-var', name: 'm' });
    expect(legacyActionToNode({ type: 'local.toast', parameters: { text: 'hola' } }))
      .toMatchObject({ kind: 'log' });
  });

  it('reglas con cond generan if; load/timer/var van a automatizaciones', () => {
    const data = {
      actions: [],
      rules: [
        { on: true, when: 'press', cond: 'contador > 3', then: [{ type: 'a' }], else: [{ type: 'b' }] },
        { on: true, when: 'timer', every: 5, cond: '', then: [{ type: 't' }], else: [] },
        { on: true, when: 'var', vn: 'contador', cond: '', then: [{ type: 'v' }], else: [] },
        { on: true, when: 'load', cond: '', then: [{ type: 'l' }], else: [] },
        { on: false, when: 'press', cond: '', then: [{ type: 'off' }], else: [] },
      ],
    };
    const { nodes } = buttonDataToNodes(data, 'short');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: 'if', cond: 'contador > 3' });
    const autos = buttonDataToAutomations(data, { buttonId: 'b1', pageId: 'p1', position: 0 });
    expect(autos.map((a) => a.when).sort()).toEqual(['load', 'timer', 'var']);
    expect(autos.find((a) => a.when === 'timer')?.everySec).toBe(5);
    expect(autos.find((a) => a.when === 'var')?.varName).toBe('contador');
  });

  it('buttonHasTrigger refleja reglas double/touch', () => {
    const data = { actions: [], rules: [{ on: true, when: 'double', cond: '', then: [{ type: 'a' }], else: [] }] };
    expect(buttonHasTrigger(data, 'double')).toBe(true);
    expect(buttonHasTrigger(data, 'short')).toBe(false);
    expect(buttonHasTrigger(data, 'touch-start')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Motor: bloques
// ---------------------------------------------------------------------------

describe('FlowEngine blocks', () => {
  it('secuencia + wait + interpolación de {{vars}} en parámetros', async () => {
    const { deps, calls } = makeVars({ nombre: 'luz' });
    const engine = new FlowEngine(deps);
    const res = await engine.execute([
      { kind: 'action', type: 'test.echo', parameters: { msg: 'hola {{nombre}}' } },
      { kind: 'wait', ms: 5 },
      { kind: 'action', type: 'test.echo', parameters: {} },
    ], ctx());
    expect(res.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].parameters.msg).toBe('hola luz');
    expect(res.results).toHaveLength(3);
  });

  it('if/else por cond', async () => {
    const { deps, calls } = makeVars({ contador: 10 });
    const engine = new FlowEngine(deps);
    const node: FlowNode = { kind: 'if', cond: 'contador > 3', then: [{ kind: 'action', type: 'a-yes' }], else: [{ kind: 'action', type: 'a-no' }] };
    const r1 = await engine.execute([node], ctx());
    expect(r1.success).toBe(true);
    expect(calls.map((c) => c.type)).toEqual(['a-yes']);
    calls.length = 0;
    const r2 = await engine.execute([{ ...node, cond: 'contador < 3' }], ctx());
    expect(r2.success).toBe(true);
    expect(calls.map((c) => c.type)).toEqual(['a-no']);
  });

  it('cond inválida falla con error', async () => {
    const { deps } = makeVars();
    const engine = new FlowEngine(deps);
    const res = await engine.execute([{ kind: 'if', cond: '((((', then: [] }], ctx());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Condición inválida/);
  });

  it('switch por valor, por cond y default', async () => {
    const { deps, calls } = makeVars({ modo: 'noche' });
    const engine = new FlowEngine(deps);
    const node: FlowNode = {
      kind: 'switch', expr: 'modo',
      cases: [
        { value: 'dia', nodes: [{ kind: 'action', type: 'a-dia' }] },
        { cond: 'modo == "noche"', nodes: [{ kind: 'action', type: 'a-noche' }] },
      ],
      default: [{ kind: 'action', type: 'a-otro' }],
    };
    await engine.execute([node], ctx());
    expect(calls.map((c) => c.type)).toEqual(['a-noche']);
    calls.length = 0;
    // Con otro valor que no casa con ningún case ni cond → default.
    await engine.execute([{ kind: 'set-var', name: 'modo', expr: '"tarde"' }], ctx());
    await engine.execute([node], ctx());
    expect(calls.map((c) => c.type)).toEqual(['a-otro']);
  });

  it('repeat por count y por while', async () => {
    const { deps, calls } = makeVars({ n: 0 });
    const engine = new FlowEngine(deps);
    await engine.execute([{ kind: 'repeat', count: 3, nodes: [{ kind: 'action', type: 'tick' }] }], ctx());
    expect(calls).toHaveLength(3);
    calls.length = 0;
    await engine.execute([
      { kind: 'repeat', while: 'n < 2', nodes: [{ kind: 'set-var', name: 'n', expr: 'n + 1' }] },
    ], ctx());
    expect(deps.getVar('n')?.value).toBe(2);
  });

  it('parallel ejecuta todas las ramas', async () => {
    const { deps, calls } = makeVars();
    const engine = new FlowEngine(deps);
    const res = await engine.execute([
      { kind: 'parallel', branches: [[{ kind: 'action', type: 'p1' }], [{ kind: 'action', type: 'p2' }]] },
    ], ctx());
    expect(res.success).toBe(true);
    expect(calls.map((c) => c.type).sort()).toEqual(['p1', 'p2']);
  });

  it('set-var/toggle-var escriben globales existentes', async () => {
    const { deps } = makeVars({ mic: false });
    const engine = new FlowEngine(deps);
    await engine.execute([{ kind: 'toggle-var', name: 'mic' }], ctx());
    expect(deps.getVar('mic')?.value).toBe(true);
    await engine.execute([{ kind: 'set-var', name: 'mic', expr: 'falso' }], ctx());
    expect(deps.getVar('mic')?.value).toBe(false);
  });

  it('error en leaf detiene la secuencia salvo continueOnError', async () => {
    const { deps, calls } = makeVars();
    const engine = new FlowEngine(deps);
    const res = await engine.execute([
      { kind: 'action', type: 'test.fail' },
      { kind: 'action', type: 'test.echo' },
    ], ctx());
    expect(res.success).toBe(false);
    expect(calls).toHaveLength(1);
    calls.length = 0;
    const res2 = await engine.execute([
      { kind: 'action', type: 'test.fail', continueOnError: true },
      { kind: 'action', type: 'test.echo' },
    ], ctx());
    expect(res2.success).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('timeout global aborta hojas colgadas', async () => {
    const { deps } = makeVars();
    const engine = new FlowEngine(deps);
    const res = await engine.execute([{ kind: 'action', type: 'test.hang' }], ctx(), { timeout: 50 });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/timeout/i);
  });

  it('cancelación a mitad de un wait', async () => {
    const { deps } = makeVars();
    const engine = new FlowEngine(deps);
    const p = engine.execute([{ kind: 'wait', ms: 5000 }, { kind: 'action', type: 'late' }], ctx());
    await new Promise((r) => setTimeout(r, 20));
    const running = engine.getRunning();
    expect(running).toHaveLength(1);
    expect(engine.cancel(running[0])).toBe(true);
    const res = await p;
    expect(res.cancelled).toBe(true);
    expect(res.success).toBe(false);
  });

  it('scripts con inputs y variables propias (ámbito local)', async () => {
    const scripts = new Map<string, FlowScript>();
    scripts.set('saludar', {
      id: 'saludar', name: 'Saludar', inputs: ['quien'], nodes: [
        { kind: 'set-var', name: 'tmp', expr: 'quien' },
        { kind: 'action', type: 'test.echo', parameters: { msg: '{{tmp}}' } },
      ], created_at: 0, updated_at: 0,
    });
    const { deps, calls, vars } = makeVars({ quien: 'GLOBAL' });
    (deps as any).getScript = (id: string) => scripts.get(id) ?? null;
    const engine = new FlowEngine(deps);
    const res = await engine.execute(
      [{ kind: 'script', scriptId: 'saludar', inputs: { quien: 'mundo' }, outputVar: 'saludo' }],
      ctx(),
    );
    expect(res.success).toBe(true);
    // `tmp` no existe en globales: queda en ámbito local, no contamina.
    expect(vars.has('tmp')).toBe(false);
    // outputVar copia el resultado al global.
    expect(deps.getVar('saludo')).toBeDefined();
    // La interpolación usó el input local, no el global.
    expect(calls[0].parameters.msg).toBe('mundo');
    expect(deps.getVar('quien')?.value).toBe('GLOBAL');
  });

  it('script inexistente falla', async () => {
    const { deps } = makeVars();
    const engine = new FlowEngine(deps);
    const res = await engine.execute([{ kind: 'script', scriptId: 'nope' }], ctx());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no encontrado/);
  });

  it('canExecute deniega hojas (allowlist remoto)', async () => {
    const { deps } = makeVars();
    const engine = new FlowEngine(deps);
    const res = await engine.execute([{ kind: 'action', type: 'shell.exec' }], ctx(), { canExecute: (t) => t === 'test.echo' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no permitida/);
  });

  it('emite flow.started/finished y action.started/finished', async () => {
    const { deps, emitted } = makeVars();
    const engine = new FlowEngine(deps);
    await engine.execute([{ kind: 'action', type: 'test.echo' }], ctx());
    const types = emitted.map((e) => e.event);
    expect(types).toContain('flow.started');
    expect(types).toContain('flow.finished');
    expect(types).toContain('action.started');
    expect(types).toContain('action.finished');
  });

  it('emite action.error cuando falla una hoja', async () => {
    const { deps, emitted } = makeVars();
    const engine = new FlowEngine(deps);
    await engine.execute([{ kind: 'action', type: 'test.fail' }], ctx());
    expect(emitted.map((e) => e.event)).toContain('action.error');
    expect(emitted.map((e) => e.event)).toContain('flow.error');
  });
});

// ---------------------------------------------------------------------------
// Persistencia: store + reinicio
// ---------------------------------------------------------------------------

/** Adaptador de fichero JSON: simula la persistencia en disco entre reinicios. */
function fileAdapter(path: string) {
  const load = () => {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch { return { scripts: {}, automations: {}, vars: {}, runs: [] }; }
  };
  const save = (d: any) => writeFileSync(path, JSON.stringify(d));
  return {
    listFlowScripts: () => Object.values(load().scripts),
    getFlowScript: (id: string) => load().scripts[id] ?? null,
    saveFlowScript: (s: any) => { const d = load(); d.scripts[s.id] = s; save(d); },
    deleteFlowScript: (id: string) => { const d = load(); delete d.scripts[id]; save(d); },
    listFlowAutomations: () => Object.values(load().automations),
    getFlowAutomation: (id: string) => load().automations[id] ?? null,
    saveFlowAutomation: (a: any) => { const d = load(); d.automations[a.id] = a; save(d); },
    deleteFlowAutomation: (id: string) => { const d = load(); delete d.automations[id]; save(d); },
    listFlowVars: () => Object.values(load().vars),
    getFlowVar: (name: string) => load().vars[name] ?? null,
    setFlowVar: (v: any) => { const d = load(); d.vars[v.name] = v; save(d); },
    deleteFlowVar: (name: string) => { const d = load(); delete d.vars[name]; save(d); },
    createFlowRun: (r: any) => { const d = load(); d.runs.unshift(r); save(d); },
    updateFlowRun: (id: string, patch: any) => { const d = load(); const r = d.runs.find((x: any) => x.id === id); if (r) Object.assign(r, patch); save(d); },
    listFlowRuns: (limit = 100) => load().runs.slice(0, limit),
  };
}

describe('FlowStore persistence', () => {
  it('sobrevive a un reinicio (nueva instancia, mismo adaptador)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-store-'));
    const path = join(dir, 'store.json');
    const a = new FlowStore(fileAdapter(path));
    a.saveScript({ id: 's1', name: 'S', nodes: [{ kind: 'wait', ms: 1 }], created_at: 1, updated_at: 1 });
    a.saveAutomation({ id: 'a1', name: 'A', enabled: true, trigger: { kind: 'timer', everySec: 5 }, nodes: [], created_at: 1, updated_at: 1 });
    a.setVar({ name: 'contador', type: 'num', value: 7 });
    a.createRun({ id: 'r1', kind: 'button', label: 'b', status: 'running', started_at: 1 });

    // "Reinicio": nueva instancia sobre el mismo fichero.
    const b = new FlowStore(fileAdapter(path));
    expect(b.getScript('s1')?.name).toBe('S');
    expect(b.getAutomation('a1')?.trigger).toMatchObject({ kind: 'timer' });
    expect(b.getVar('contador')?.value).toBe(7);
    const interrupted = b.markInterruptedRuns();
    expect(interrupted).toBe(1);
    expect(b.listRuns()[0].status).toBe('interrupted');
  });

  it('usa memoria cuando el servicio no expone métodos de flujos', () => {
    const store = new FlowStore({});
    expect(store.persistent).toBe(false);
    store.saveScript({ id: 'x', name: 'X', nodes: [], created_at: 0, updated_at: 0 });
    expect(store.getScript('x')?.name).toBe('X');
  });
});

// ---------------------------------------------------------------------------
// Automatizaciones
// ---------------------------------------------------------------------------

describe('AutomationManager', () => {
  it('dispara por evento y por cambio de variable', async () => {
    const fired: any[] = [];
    const mgr = new AutomationManager({
      execute: async (nodes: any, c: any) => { fired.push({ nodes, ctx: c }); return { success: true }; },
      log: () => {},
      emit: () => {},
    });
    const autos = [
      { id: 'e1', name: 'E', enabled: true, trigger: { kind: 'event', event: 'media.play' }, nodes: [{ kind: 'log', message: 'x' }], created_at: 0, updated_at: 0 },
      { id: 'v1', name: 'V', enabled: true, trigger: { kind: 'var', varName: 'contador' }, nodes: [], created_at: 0, updated_at: 0 },
      { id: 'off', name: 'Off', enabled: false, trigger: { kind: 'event', event: 'media.play' }, nodes: [], created_at: 0, updated_at: 0 },
    ];
    mgr.handleEvent('media.play', { player: 'spotify' }, autos as any);
    mgr.handleVariableChange('contador', autos as any);
    mgr.handleVariableChange('otra', autos as any);
    await new Promise((r) => setTimeout(r, 20));
    expect(fired.map((f) => f.ctx.trigger)).toEqual(['event:media.play', 'var']);
  });

  it('timers globales y reglas de botón se sincronizan', async () => {
    const fired: any[] = [];
    const mgr = new AutomationManager({
      execute: async (nodes: any, c: any) => { fired.push(c); return { success: true }; },
      log: () => {},
      emit: () => {},
    });
    mgr.startGlobal([{ id: 'g', name: 'G', enabled: true, trigger: { kind: 'timer', everySec: 1 }, nodes: [], created_at: 0, updated_at: 0 }] as any);
    mgr.syncButtons([
      { id: 'b1', page_id: 'p1', position: 0, data: { actions: [], rules: [{ on: true, when: 'timer', every: 1, cond: '', then: [], else: [] }] } },
    ]);
    // load de la página no debe fallar aunque no haya reglas load.
    mgr.handlePageLoad('p1');
    await new Promise((r) => setTimeout(r, 1200));
    mgr.stopAll();
    const triggers = fired.map((c) => c.trigger);
    expect(triggers).toContain('timer');
  });
});
