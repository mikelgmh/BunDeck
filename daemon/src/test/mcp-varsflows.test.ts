/**
 * mcp-varsflows.test.ts — MCP FASE 4: variables tipadas v2 + motor de flows.
 *
 * Cubre: render/get/set/delete/toggle scoped (store real) + undo,
 * flow scripts save/get/list/delete + undo, execute_flow_nodes con confirm,
 * cancel/run/stats, emit/resync, flow-vars + undo, batch (acepta lo
 * transaccional, deniega lo no transaccional) y scopes de solo lectura.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-mcp-vf-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;

import { initDatabase, DatabaseService } from '../db';
import { ALL_SCOPE_IDS } from '../mcp/scopes';
import { handleMcpBody } from '../mcp/server';
import { __resetHistoryForTests } from '../mcp/history';
import { resetVariableStore } from '../variables/store';

let db: DatabaseService;

// Motor mock: scripts y flow-vars in-memory, runs fijos, emit no-op.
const scripts = new Map<string, any>();
const flowVars = new Map<string, any>();

const stubCtx: any = {
  pluginLoader: {
    getPluginActions: () => new Map([['shell.shell', { name: 'Shell', schema: null }]]),
    listDetailed: () => [],
    getStatus: () => null,
    installPluginFromGit: async () => { throw new Error('no git en test'); },
    installPluginFromUrl: async () => { throw new Error('no red en test'); },
    enablePlugin: async () => true,
    disablePlugin: async () => true,
    reloadPlugin: async () => true,
    rollbackPlugin: async () => { throw new Error('sin backup en test'); },
    updatePlugin: async () => { throw new Error('no red en test'); },
    uninstallPlugin: async () => { throw new Error('no en test'); },
    getPluginSettingsBundle: () => ({ schema: null, values: {}, instructions: null, configured: true, missing: [], requiresConfiguration: false, oauth: null }),
    savePluginSettings: async (_id: string, values: any) => values,
  },
  actionRunner: {
    executeAction: async (action: any) => ({ success: true, result: { echo: action.type }, duration: 1 }),
    runFlowNodes: async (_kind: string, _label: string, nodes: any[]) => ({ success: true, runId: 'run-test-1', results: [], duration: 0, nodes: nodes.length }),
    cancelFlow: (_runId: string) => true,
    getFlowRunning: () => [],
    getFlowStats: () => ({ running: 0, scripts: scripts.size, automations: 0, vars: flowVars.size, persistent: false }),
    flowStore: {
      listRuns: (_limit?: number) => [{ id: 'run-1', status: 'finished' }],
      getScript: (id: string) => scripts.get(id) ?? null,
    },
    listFlowScripts: () => [...scripts.values()],
    saveFlowScript: (s: any) => {
      if (!s || !Array.isArray(s.nodes)) throw new Error('Script sin nodos');
      const full = {
        id: typeof s.id === 'string' && s.id ? s.id : `s-${scripts.size + 1}`,
        name: String(s.name ?? 'Sin nombre'),
        inputs: Array.isArray(s.inputs) ? s.inputs : [],
        timeout: typeof s.timeout === 'number' ? s.timeout : undefined,
        nodes: s.nodes,
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      scripts.set(full.id, full);
      return full;
    },
    deleteFlowScript: (id: string) => { scripts.delete(id); },
    emitAutomationEvent: (_event: string, _payload: any = {}) => {},
    resyncButtonAutomations: () => {},
    listFlowVars: () => [...flowVars.values()],
    getFlowVar: (name: string) => flowVars.get(name) ?? null,
    setFlowVar: (name: string, value: any) => {
      const clean = String(name ?? '').trim();
      if (!clean) throw new Error('Nombre de variable vacío');
      const existing = flowVars.get(clean);
      const type = existing?.type ?? (typeof value === 'number' ? 'num' : typeof value === 'boolean' ? 'bool' : 'txt');
      flowVars.set(clean, { name: clean, type, value });
      return true;
    },
    deleteFlowVar: (name: string) => { flowVars.delete(name); },
  },
  db: null as any,
  auth: null,
  ws: null,
  repaint: null,
};

const ADMIN = { tokenId: 't-vf-admin', tokenName: 'vf-admin', scopes: [...ALL_SCOPE_IDS] };
const READER = {
  tokenId: 't-vf-reader', tokenName: 'vf-lector',
  scopes: ['variables.read', 'flows.read', 'automations.read', 'actions.read', 'state.read'],
};

async function call(name: string, args: any, auth: any = ADMIN, id = 1) {
  return handleMcpBody(
    { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
    { ...stubCtx, auth }
  );
}

function text(res: any): any {
  return JSON.parse((res.payload as any).result.content[0].text);
}

function isErr(res: any): boolean {
  return (res.payload as any).result.isError === true;
}

function errText(res: any): string {
  return (res.payload as any).result.content[0].text as string;
}

beforeAll(async () => {
  await initDatabase();
  db = new DatabaseService();
  stubCtx.db = db;
  resetVariableStore();
});

beforeEach(() => {
  __resetHistoryForTests();
});

describe('MCP variables tipadas (store nuevo)', () => {
  it('set/get/render scoped + update con undo', async () => {
    const s = await call('set_scoped_variable', { name: 'vf_text', value: 'hola' });
    expect(isErr(s)).toBe(false);
    expect(text(s).variable.value).toBe('hola');

    const g = await call('get_scoped_variable', { name: 'vf_text' });
    expect(text(g).variable.value).toBe('hola');

    const r = await call('render_variable', { template: 'dice {{vf_text}}!' });
    expect(isErr(r)).toBe(false);
    expect(text(r).result).toContain('hola');

    // update + undo restaura el valor previo
    const u = await call('set_scoped_variable', { name: 'vf_text', value: 'adios' });
    expect(text(u).variable.value).toBe('adios');
    const undo = await call('undo_last', {});
    expect(isErr(undo)).toBe(false);
    expect(text(await call('get_scoped_variable', { name: 'vf_text' })).variable.value).toBe('hola');
  });

  it('get de inexistente es error; delete con undo restaura', async () => {
    const g = await call('get_scoped_variable', { name: 'vf_noexiste' });
    expect(isErr(g)).toBe(true);

    await call('set_scoped_variable', { name: 'vf_borrar', value: 42 });
    const d = await call('delete_scoped_variable', { name: 'vf_borrar' });
    expect(isErr(d)).toBe(false);
    expect(isErr(await call('get_scoped_variable', { name: 'vf_borrar' }))).toBe(true);
    const undo = await call('undo_last', {});
    expect(isErr(undo)).toBe(false);
    expect(text(await call('get_scoped_variable', { name: 'vf_borrar' })).variable.value).toBe(42);
  });

  it('toggle bool con undo (doble toggle idempotente)', async () => {
    await call('set_scoped_variable', { name: 'vf_flag', value: true });
    const t = await call('toggle_variable', { name: 'vf_flag' });
    expect(isErr(t)).toBe(false);
    expect(text(t).variable.value).toBe(false);
    const undo = await call('undo_last', {});
    expect(isErr(undo)).toBe(false);
    expect(text(await call('get_scoped_variable', { name: 'vf_flag' })).variable.value).toBe(true);
  });

  it('undo de creación elimina la variable', async () => {
    await call('set_scoped_variable', { name: 'vf_tmp', value: 'x' });
    const undo = await call('undo_last', {});
    expect(isErr(undo)).toBe(false);
    expect(isErr(await call('get_scoped_variable', { name: 'vf_tmp' }))).toBe(true);
  });
});

describe('MCP flow scripts (motor)', () => {
  it('save/get/list/delete con undo', async () => {
    const s = await call('save_flow_script', { name: 'VF script', nodes: [{ kind: 'action', type: 'utility.noop' }] });
    expect(isErr(s)).toBe(false);
    const id = text(s).script.id;
    expect(typeof id).toBe('string');

    expect(text(await call('get_flow_script', { id })).script.name).toBe('VF script');
    expect(text(await call('list_flow_scripts', {})).scripts.some((x: any) => x.id === id)).toBe(true);

    // update + undo restaura el snapshot previo
    await call('save_flow_script', { id, name: 'VF script 2', nodes: [{ kind: 'action', type: 'utility.noop' }] });
    expect(text(await call('get_flow_script', { id })).script.name).toBe('VF script 2');
    expect(isErr(await call('undo_last', {}))).toBe(false);
    expect(text(await call('get_flow_script', { id })).script.name).toBe('VF script');

    // delete + undo restaura
    expect(isErr(await call('delete_flow_script', { id }))).toBe(false);
    expect(isErr(await call('get_flow_script', { id }))).toBe(true);
    expect(isErr(await call('undo_last', {}))).toBe(false);
    expect(text(await call('get_flow_script', { id })).script.name).toBe('VF script');

    // limpieza
    await call('delete_flow_script', { id });
    __resetHistoryForTests();
  });

  it('get/delete de inexistente es error', async () => {
    expect(isErr(await call('get_flow_script', { id: 'vf-inexistente' }))).toBe(true);
    expect(isErr(await call('delete_flow_script', { id: 'vf-inexistente' }))).toBe(true);
  });
});

describe('MCP motor: ejecución y observabilidad', () => {
  it('execute_flow_nodes exige confirm para nodos sensibles', async () => {
    const nodes = [{ kind: 'action', type: 'shell.shell', parameters: { cmd: 'echo hi' } }];
    const denied = await call('execute_flow_nodes', { nodes });
    expect(isErr(denied)).toBe(true);
    expect(errText(denied)).toContain('confirm');

    const okRes = await call('execute_flow_nodes', { nodes, confirm: true });
    expect(isErr(okRes)).toBe(false);
    expect(text(okRes).success).toBe(true);
  });

  it('cancel_flow, get_flow_runs, get_flow_stats', async () => {
    const c = await call('cancel_flow', { run_id: 'run-1' });
    expect(isErr(c)).toBe(false);
    expect(text(c).cancelled).toBe(true);

    const runs = await call('get_flow_runs', { limit: 10 });
    expect(isErr(runs)).toBe(false);
    expect(Array.isArray(text(runs).runs)).toBe(true);

    const stats = await call('get_flow_stats', {});
    expect(isErr(stats)).toBe(false);
    expect(typeof text(stats).running).toBe('number');
  });

  it('emit_automation_event y resync_automations', async () => {
    expect(isErr(await call('emit_automation_event', { event: 'vf.test', payload: { n: 1 } }))).toBe(false);
    expect(isErr(await call('emit_automation_event', {}))).toBe(true);
    expect(isErr(await call('resync_automations', {}))).toBe(false);
  });
});

describe('MCP flow-vars (motor)', () => {
  it('set/get/list/delete con undo', async () => {
    expect(isErr(await call('set_flow_var', { name: 'vf_motor', value: 'luz' }))).toBe(false);
    expect(text(await call('get_flow_var', { name: 'vf_motor' })).variable.value).toBe('luz');
    expect(text(await call('list_flow_vars', {})).variables.some((v: any) => v.name === 'vf_motor')).toBe(true);

    expect(isErr(await call('delete_flow_var', { name: 'vf_motor' }))).toBe(false);
    expect(isErr(await call('get_flow_var', { name: 'vf_motor' }))).toBe(true);
    expect(isErr(await call('undo_last', {}))).toBe(false);
    expect(text(await call('get_flow_var', { name: 'vf_motor' })).variable.value).toBe('luz');

    // limpieza
    await call('delete_flow_var', { name: 'vf_motor' });
    __resetHistoryForTests();
  });
});

describe('MCP batch + scopes (fase 4)', () => {
  it('batch acepta scripts y scoped vars transaccionales', async () => {
    const res = await call('execute_batch', {
      operations: [
        { tool: 'save_flow_script', arguments: { name: 'VF batch', nodes: [{ kind: 'wait', ms: 10 }] } },
        { tool: 'set_scoped_variable', arguments: { name: 'vf_batch', value: 1 } },
        { tool: 'set_flow_var', arguments: { name: 'vf_batch_var', value: 'b' } },
      ],
    });
    expect(isErr(res)).toBe(false);
    expect(text(res).applied).toBe(3);
    // undo único del batch revierte las 3
    expect(isErr(await call('undo_last', {}))).toBe(false);
    expect(isErr(await call('get_scoped_variable', { name: 'vf_batch' }))).toBe(true);
    expect(isErr(await call('get_flow_var', { name: 'vf_batch_var' }))).toBe(true);
  });

  it('batch deniega execute_flow_nodes, cancel_flow y emit', async () => {
    for (const op of [
      { tool: 'execute_flow_nodes', arguments: { nodes: [{ kind: 'wait', ms: 1 }], confirm: true } },
      { tool: 'cancel_flow', arguments: { run_id: 'run-1' } },
      { tool: 'emit_automation_event', arguments: { event: 'x' } },
      { tool: 'resync_automations', arguments: {} },
    ]) {
      const res = await call('execute_batch', { operations: [op] });
      expect(isErr(res)).toBe(true);
      expect(errText(res)).toContain('no admitida en batch');
    }
  });

  it('lector (solo .read) no escribe', async () => {
    await call('set_scoped_variable', { name: 'vf_lectura', value: 'si' });
    const g = await call('get_scoped_variable', { name: 'vf_lectura' }, READER);
    expect(isErr(g)).toBe(false);

    for (const [tool, args] of [
      ['set_scoped_variable', { name: 'vf_lectura', value: 'no' }],
      ['delete_scoped_variable', { name: 'vf_lectura' }],
      ['toggle_variable', { name: 'vf_lectura' }],
      ['save_flow_script', { name: 'VF no', nodes: [] }],
      ['delete_flow_script', { id: 'x' }],
      ['cancel_flow', { run_id: 'run-1' }],
      ['emit_automation_event', { event: 'x' }],
      ['resync_automations', {}],
      ['set_flow_var', { name: 'vf_lectura', value: 1 }],
      ['delete_flow_var', { name: 'vf_lectura' }],
      ['execute_flow_nodes', { nodes: [{ kind: 'wait', ms: 1 }] }],
    ] as Array<[string, any]>) {
      const res = await call(tool, args, READER);
      expect(isErr(res)).toBe(true);
      expect(errText(res)).toContain('permiso denegado');
    }
    // limpieza
    await call('delete_scoped_variable', { name: 'vf_lectura' });
    __resetHistoryForTests();
  });
});
