/**
 * mcp-hardening.test.ts — MCP endurecido.
 *
 * Cubre: nuevas entidades (widgets/flows/automatizaciones/variables),
 * validación batch atómica (todo o nada), undo/history propios,
 * confirmación para acciones sensibles (shell/http/power/system) y que un
 * token de solo lectura no puede ejecutar/instalar ni usar batch/undo.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-mcp-hard-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;

import { initDatabase, DatabaseService } from '../db';
import { ALL_SCOPE_IDS } from '../mcp/scopes';
import { handleMcpBody } from '../mcp/server';
import { __resetHistoryForTests } from '../mcp/history';

let db: DatabaseService;

const executed: any[] = [];
const stubCtx: any = {
  pluginLoader: {
    getPluginActions: () => new Map([
      ['shell.shell', { name: 'Shell', schema: null }],
      ['http.http', { name: 'HTTP', schema: null }],
      ['utility.delay', { name: 'Delay', schema: null }],
    ]),
    listDetailed: () => [{ id: 'shell', version: '1.0.0', enabled: 1, loaded: true, status: 'active' }],
    getStatus: (id: string) => (id === 'shell' ? { id, enabled: true, status: 'active' } : null),
    installPluginFromGit: async () => { throw new Error('no git en test'); },
    installPluginFromUrl: async () => { throw new Error('no red en test'); },
    enablePlugin: async () => true,
    disablePlugin: async () => true,
    reloadPlugin: async () => true,
    rollbackPlugin: async () => { throw new Error('sin backup en test'); },
    updatePlugin: async () => { throw new Error('no red en test'); },
    uninstallPlugin: async () => { throw new Error('protegido en test'); },
    getPluginSettingsBundle: () => ({ schema: null, values: {}, instructions: null, configured: true, missing: [], requiresConfiguration: false, oauth: null }),
    savePluginSettings: async (id: string, values: any) => values,
  },
  actionRunner: {
    executeAction: async (action: any) => {
      executed.push(action);
      return { success: true, result: { echo: action.type }, duration: 1 };
    },
  },
  db: null as any,
  auth: null,
  ws: null,
  repaint: null,
};

const ADMIN = { tokenId: 't-admin', tokenName: 'admin', scopes: [...ALL_SCOPE_IDS] };
const READER = {
  tokenId: 't-read', tokenName: 'lector',
  scopes: ['profiles.read', 'pages.read', 'buttons.read', 'actions.read', 'plugins.read', 'state.read', 'settings.read', 'logs.read', 'widgets.read', 'flows.read', 'automations.read', 'variables.read'],
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
  process.env.LIBREDECK_DATA_DIR = TMP;
  await initDatabase();
  db = new DatabaseService();
  stubCtx.db = db;
});

beforeEach(() => {
  __resetHistoryForTests();
  executed.length = 0;
});

describe('MCP: widgets, flows, automatizaciones y variables', () => {
  it('CRUD completo de las cuatro entidades', async () => {
    // widget
    const cw = await call('create_widget', { name: 'Reloj', kind: 'clock', data: { tz: 'local' } });
    expect(isErr(cw)).toBe(false);
    const wid = text(cw).widget.id;
    expect((await call('get_widget', { id: wid })).payload).toBeDefined();
    const uw = await call('update_widget', { id: wid, data: { tz: 'utc' } });
    expect(text(uw).widget.data.tz).toBe('utc');
    expect(text(uw).widget.kind).toBe('clock'); // patch conserva kind

    // flow
    const cf = await call('create_flow', { name: 'Amanecer', steps: [{ type: 'utility.delay', parameters: { ms: 5 } }] });
    expect(isErr(cf)).toBe(false);
    const fid = text(cf).flow.id;
    expect(text(await call('get_flow', { id: fid })).flow.name).toBe('Amanecer');

    // automation
    const ca = await call('create_automation', { name: 'Noche', trigger: { kind: 'manual' }, actions: [{ type: 'utility.delay' }] });
    expect(isErr(ca)).toBe(false);
    const aid = text(ca).automation.id;
    const dis = await call('set_automation_enabled', { id: aid, enabled: false });
    expect(text(dis).automation.enabled).toBe(0);

    // variable
    const sv = await call('set_variable', { name: 'brillo', value: 80, type: 'numeric' });
    expect(text(sv).variable.value).toBe(80);
    expect(text(await call('get_variable', { name: 'brillo' })).variable.value).toBe(80);

    // listados + get_state extendido
    expect(text(await call('list_widgets', {})).widgets.some((w: any) => w.id === wid)).toBe(true);
    expect(text(await call('list_flows', {})).flows.some((f: any) => f.id === fid)).toBe(true);
    expect(text(await call('list_automations', {})).automations.some((a: any) => a.id === aid)).toBe(true);
    expect(text(await call('list_variables', {})).variables.some((v: any) => v.name === 'brillo')).toBe(true);
    const st = text(await call('get_state', {}));
    expect(st.counts.widgets).toBeGreaterThanOrEqual(1);
    expect(st.counts.flows).toBeGreaterThanOrEqual(1);
    expect(st.counts.automations).toBeGreaterThanOrEqual(1);
    expect(st.counts.variables).toBeGreaterThanOrEqual(1);
    expect(st.counts.profiles).toBeGreaterThanOrEqual(0); // compat: claves viejas siguen

    // limpieza
    expect(text(await call('delete_widget', { id: wid })).success).toBe(true);
    expect(text(await call('delete_flow', { id: fid })).success).toBe(true);
    expect(text(await call('delete_automation', { id: aid })).success).toBe(true);
    expect(text(await call('delete_variable', { name: 'brillo' })).success).toBe(true);
  });

  it('valida argumentos (nombres, tipos, existentes)', async () => {
    expect(isErr(await call('create_widget', {}))).toBe(true); // name requerido
    expect(isErr(await call('get_flow', { id: 'inexistente' }))).toBe(true);
    expect(isErr(await call('get_automation', { id: 'inexistente' }))).toBe(true);
    expect(isErr(await call('get_variable', { name: 'inexistente' }))).toBe(true);
    expect(isErr(await call('create_flow', { name: 'Malo', steps: 'no-array' as any }))).toBe(true);
  });
});

describe('MCP: batch atómico', () => {
  it('aplica todo cuando todo es válido (una sola entrada de undo)', async () => {
    const r = await call('execute_batch', {
      operations: [
        { tool: 'create_widget', arguments: { id: 'bw-1', name: 'W1' } },
        { tool: 'set_variable', arguments: { name: 'batch_ok', value: 1 } },
        { tool: 'create_flow', arguments: { id: 'bf-1', name: 'F1', steps: [] } },
      ],
    });
    expect(isErr(r)).toBe(false);
    expect(text(r).applied).toBe(3);
    expect(db.getWidget('bw-1')?.name).toBe('W1');
    expect(db.getVariable('batch_ok')?.value).toBe(1);
    const h = text(await call('get_history', {}));
    expect(h.history.filter((e: any) => e.tool === 'execute_batch').length).toBe(1);
    // undo del batch revierte las 3
    const u = await call('undo_last', {});
    expect(isErr(u)).toBe(false);
    expect(db.getWidget('bw-1')).toBeNull();
    expect(db.getVariable('batch_ok')).toBeNull();
    expect(db.getFlow('bf-1')).toBeNull();
  });

  it('no aplica nada si una operación es inválida (validación previa)', async () => {
    const r = await call('execute_batch', {
      operations: [
        { tool: 'create_widget', arguments: { id: 'bw-2', name: 'W2' } },
        { tool: 'create_page', arguments: { profile_id: 'perfil-que-no-existe', name: 'X' } },
      ],
    });
    expect(isErr(r)).toBe(true);
    expect(errText(r)).toContain('operations[1]');
    expect(db.getWidget('bw-2')).toBeNull(); // ni la primera se aplicó
  });

  it('revierte lo aplicado si falla en ejecución (posición ocupada)', async () => {
    const cp = await call('create_profile', { name: 'BatchPos' });
    const pid = text(cp).profile.id;
    const pg = await call('create_page', { profile_id: pid, name: 'P' });
    const pageId = text(pg).page.id;
    await call('create_button', { page_id: pageId, position: 0, data: {} });
    const r = await call('execute_batch', {
      operations: [
        { tool: 'create_widget', arguments: { id: 'bw-3', name: 'W3' } },
        { tool: 'create_button', arguments: { page_id: pageId, position: 0, data: {} } }, // ocupada: falla al ejecutar
      ],
    });
    expect(isErr(r)).toBe(true);
    expect(errText(r)).toContain('revertidas');
    expect(db.getWidget('bw-3')).toBeNull(); // compensado
    await call('delete_profile', { id: pid });
  });

  it('rechaza tools con efectos no transaccionales dentro del batch', async () => {
    for (const tool of ['execute_action', 'press_button', 'install_plugin', 'update_plugin', 'undo_last', 'get_history']) {
      const args: any = tool === 'execute_action' ? { type: 'utility.delay' } : {};
      if (tool === 'press_button') args.button_id = 'x';
      if (tool === 'install_plugin') args.url = 'https://x/y.git';
      if (tool === 'update_plugin') args.plugin_id = 'shell';
      const r = await call('execute_batch', { operations: [{ tool, arguments: args }] });
      expect(isErr(r)).toBe(true);
      expect(errText(r)).toContain('no admitida');
    }
  });

  it('un token sin batch.write no puede usar el batch', async () => {
    const r = await call('execute_batch', { operations: [{ tool: 'list_widgets', arguments: {} }] }, READER);
    expect(isErr(r)).toBe(true);
    expect(errText(r)).toContain('permiso denegado');
  });

  it('el batch respeta los scopes de cada operación', async () => {
    const partial = { tokenId: 't-par', tokenName: 'par', scopes: ['batch.write', 'widgets.read', 'widgets.write'] };
    const r = await call('execute_batch', {
      operations: [
        { tool: 'create_widget', arguments: { name: 'Ok' } },
        { tool: 'set_variable', arguments: { name: 'x', value: 1 } }, // sin variables.write
      ],
    }, partial);
    expect(isErr(r)).toBe(true);
    expect(errText(r)).toContain('variables.write');
  });
});

describe('MCP: undo/history propios', () => {
  it('deshace crear/actualizar/borrar', async () => {
    const cw = await call('create_widget', { name: 'UndoW', data: { a: 1 } });
    const wid = text(cw).widget.id;
    let u = await call('undo_last', {});
    expect(text(u).success).toBe(true);
    expect(db.getWidget(wid)).toBeNull();

    // borrar → undo restaura
    const cw2 = await call('create_widget', { id: 'uw-2', name: 'UndoW2', data: { a: 2 } });
    expect(isErr(cw2)).toBe(false);
    await call('delete_widget', { id: 'uw-2' });
    expect(db.getWidget('uw-2')).toBeNull();
    // undo_last deshace el delete (la última entrada), no el create
    u = await call('undo_last', {});
    expect(db.getWidget('uw-2')?.data).toMatchObject({ a: 2 });

    // actualizar → undo restaura previo exacto
    await call('update_widget', { id: 'uw-2', data: { b: 3 } });
    expect(db.getWidget('uw-2')?.data).toMatchObject({ a: 2, b: 3 });
    await call('undo_last', {});
    expect(db.getWidget('uw-2')?.data).toEqual({ a: 2 });
    await call('delete_widget', { id: 'uw-2' });
  });

  it('history lista y clear vacía; undo vacío falla', async () => {
    expect(isErr(await call('undo_last', {}))).toBe(true);
    await call('set_variable', { name: 'h1', value: 1 });
    await call('set_variable', { name: 'h2', value: 2 });
    const h = text(await call('get_history', {}));
    expect(h.history.length).toBe(2);
    expect(h.history[0].tool).toBe('set_variable');
    const c = await call('clear_history', {});
    expect(text(c).cleared).toBe(2);
    expect(text(await call('get_history', {})).history).toEqual([]);
  });

  it('el undo es por token (no ve el de otros)', async () => {
    const other = { tokenId: 't-otro', tokenName: 'otro', scopes: [...ALL_SCOPE_IDS] };
    await call('set_variable', { name: 'ajena', value: 1 }, other);
    // ADMIN no puede deshacer lo de otro token
    expect(isErr(await call('undo_last', {}, ADMIN))).toBe(true);
    // el dueño sí
    expect(isErr(await call('undo_last', {}, other))).toBe(false);
    expect(db.getVariable('ajena')).toBeNull();
  });
});

describe('MCP: confirmación sensible + permisos de lectura', () => {
  it('execute_action sensible exige confirm con token', async () => {
    const noConfirm = await call('execute_action', { type: 'shell.shell', parameters: { cmd: 'x' } }, ADMIN);
    expect(isErr(noConfirm)).toBe(true);
    expect(errText(noConfirm)).toContain('confirm');
    expect(executed.length).toBe(0);

    const ok = await call('execute_action', { type: 'shell.shell', parameters: { cmd: 'x' }, confirm: true }, ADMIN);
    expect(isErr(ok)).toBe(false);
    expect(executed.length).toBe(1);
    // parameters._confirm también vale (y no llega al plugin)
    executed.length = 0;
    const ok2 = await call('execute_action', { type: 'shell.shell', parameters: { cmd: 'x', _confirm: true } }, ADMIN);
    expect(isErr(ok2)).toBe(false);
    expect(executed[0]).not.toHaveProperty('_confirm');
  });

  it('http/power/system también son sensibles; utility no', async () => {
    for (const t of ['http.http', 'power.algo', 'system.algo']) {
      const r = await call('execute_action', { type: t }, ADMIN);
      expect(isErr(r)).toBe(true);
      expect(errText(r)).toContain('confirm');
    }
    const ok = await call('execute_action', { type: 'utility.delay', parameters: { ms: 1 } }, ADMIN);
    expect(isErr(ok)).toBe(false);
  });

  it('press_button y execute_flow con pasos sensibles exigen confirm', async () => {
    const cp = await call('create_profile', { name: 'Sens' });
    const pid = text(cp).profile.id;
    const pg = await call('create_page', { profile_id: pid, name: 'P' });
    const pageId = text(pg).page.id;
    const cb = await call('create_button', { page_id: pageId, data: { actions: [{ type: 'shell.shell', parameters: {} }] } });
    const bid = text(cb).button.id;

    const denied = await call('press_button', { button_id: bid }, ADMIN);
    expect(isErr(denied)).toBe(true);
    expect(errText(denied)).toContain('confirm');
    const allowed = await call('press_button', { button_id: bid, confirm: true }, ADMIN);
    expect(isErr(allowed)).toBe(false);

    const cf = await call('create_flow', { name: 'FS', steps: [{ type: 'shell.shell' }] });
    const fid = text(cf).flow.id;
    expect(isErr(await call('execute_flow', { id: fid }, ADMIN))).toBe(true);
    const ex = await call('execute_flow', { id: fid, confirm: true }, ADMIN);
    expect(isErr(ex)).toBe(false);
    expect(text(ex).executed).toBe(1);
    await call('delete_profile', { id: pid });
  });

  it('token de lectura no ejecuta, no instala y no toca undo/batch', async () => {
    const ex = await call('execute_action', { type: 'utility.delay', confirm: true }, READER);
    expect(isErr(ex)).toBe(true);
    expect(errText(ex)).toContain('permiso denegado');

    const ins = await call('install_plugin', { url: 'https://x/y.git' }, READER);
    expect(isErr(ins)).toBe(true);

    const upd = await call('update_plugin', { plugin_id: 'shell' }, READER);
    expect(isErr(upd)).toBe(true);

    const sv = await call('set_variable', { name: 'x', value: 1 }, READER);
    expect(isErr(sv)).toBe(true);

    const un = await call('undo_last', {}, READER);
    expect(isErr(un)).toBe(true);

    // pero sí lee
    expect(isErr(await call('list_widgets', {}, READER))).toBe(false);
    expect(isErr(await call('get_state', {}, {
      tokenId: 't-s', tokenName: 's', scopes: ['state.read'],
    }))).toBe(false);
  });

  it('tools/list oculta lo no permitido al lector', async () => {
    const res = await handleMcpBody(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { ...stubCtx, auth: READER }
    );
    const names = (res.payload as any).result.tools.map((t: any) => t.name) as string[];
    expect(names).toContain('list_widgets');
    expect(names).not.toContain('create_widget');
    expect(names).not.toContain('execute_action');
    expect(names).not.toContain('install_plugin');
    expect(names).not.toContain('execute_batch');
    expect(names).not.toContain('undo_last');
  });
});
