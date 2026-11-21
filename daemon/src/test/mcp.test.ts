/**
 * mcp.test.ts — servidor MCP: tokens con scopes + JSON-RPC (initialize, tools/list, tools/call)
 * + CRUD de perfiles/páginas/botones y permisos.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-mcp-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;

import { initDatabase, DatabaseService } from '../db';
import { createMcpToken, listMcpTokens, updateMcpToken, revokeMcpToken, verifyMcpToken } from '../mcp/tokens';
import { ALL_SCOPE_IDS, normalizeScopes } from '../mcp/scopes';
import { handleMcpBody } from '../mcp/server';

let db: DatabaseService;
const stubCtx: any = {
  pluginLoader: {
    getPluginActions: () => new Map([['shell.shell', { name: 'Shell', schema: null }]]),
    listDetailed: () => [{ id: 'shell', version: '1.0.0', enabled: 1, loaded: true, status: 'active' }],
    getStatus: (id: string) => (id === 'shell' ? { id, enabled: true, status: 'active' } : null),
    installPluginFromGit: async () => { throw new Error('no git en test'); },
    installPluginFromUrl: async () => { throw new Error('no red en test'); },
    enablePlugin: async () => true,
    disablePlugin: async () => true,
    reloadPlugin: async () => true,
    rollbackPlugin: async () => true,
    updatePlugin: async () => { throw new Error('no red en test'); },
    uninstallPlugin: async () => { throw new Error('no en test'); },
    getPluginSettingsBundle: () => ({ schema: null, values: {}, instructions: null, configured: true, missing: [], requiresConfiguration: false, oauth: null }),
    savePluginSettings: (id: string, values: any) => values,
  },
  actionRunner: {
    executeAction: async (action: any) => ({ success: true, result: { echo: action.type }, duration: 1 }),
  },
  db: null as any,
  auth: null,
  ws: null,
  repaint: null,
};

async function call(name: string, args: any, auth: any = null, id = 1) {
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

beforeAll(async () => {
  await initDatabase();
  db = new DatabaseService();
  stubCtx.db = db;
});

describe('MCP tokens con scopes', () => {
  it('crear → verificar → editar → revocar', () => {
    const { record, secret } = createMcpToken(db, 'claude');
    expect(secret.startsWith('ldmcp_')).toBe(true);
    // sin scopes = admin (todos)
    expect(record.scopes.sort()).toEqual([...ALL_SCOPE_IDS].sort());
    expect(listMcpTokens(db).some((t) => t.id === record.id)).toBe(true);
    // El listado no expone el hash
    expect((listMcpTokens(db)[0] as any).hash).toBeUndefined();
    expect(verifyMcpToken(db, secret)?.id).toBe(record.id);
    expect(verifyMcpToken(db, 'ldmcp_invalido')).toBeNull();

    // subconjunto de permisos
    const sub = createMcpToken(db, 'lector', ['buttons.read', 'profiles.read']);
    expect(sub.record.scopes).toEqual(['buttons.read', 'profiles.read']);
    expect(verifyMcpToken(db, sub.secret)?.scopes).toEqual(['buttons.read', 'profiles.read']);

    // scope desconocido → 400 (lanza)
    expect(() => createMcpToken(db, 'mal', ['nope'])).toThrow();

    // editar scopes
    const updated = updateMcpToken(db, sub.record.id, { scopes: ['buttons.read', 'buttons.write'] });
    expect(updated?.scopes).toEqual(['buttons.read', 'buttons.write']);
    expect(updateMcpToken(db, 'inexistente', { scopes: [] })).toBeNull();

    expect(revokeMcpToken(db, record.id)).toBe(true);
    expect(verifyMcpToken(db, secret)).toBeNull();
    expect(revokeMcpToken(db, record.id)).toBe(false);
    revokeMcpToken(db, sub.record.id);
  });

  it('normalizeScopes: vacío/omitido = todos', () => {
    expect(normalizeScopes(undefined).length).toBe(ALL_SCOPE_IDS.length);
    expect(normalizeScopes([]).length).toBe(ALL_SCOPE_IDS.length);
  });
});

describe('MCP JSON-RPC', () => {
  it('initialize + tools/list', async () => {
    const init = await handleMcpBody({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, stubCtx);
    expect(init.status).toBe(200);
    expect((init.payload as any).result.serverInfo.name).toBe('libredeck');

    const tools = await handleMcpBody({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, stubCtx);
    const names = (tools.payload as any).result.tools.map((t: any) => t.name);
    expect(names).toContain('list_actions');
    expect(names).toContain('execute_action');
    expect(names).toContain('validate_manifest');
    expect(names).toContain('get_plugin_template');
    expect(names).toContain('create_profile');
    expect(names).toContain('update_button');
    expect(names).toContain('reorder_button_actions');
    expect(names).toContain('enable_plugin');
    expect(names).toContain('set_setting');
  });

  it('tools/list filtra por scopes del token', async () => {
    const auth = { tokenId: 't1', tokenName: 'lector', scopes: ['buttons.read'] };
    const tools = await handleMcpBody({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { ...stubCtx, auth });
    const names = (tools.payload as any).result.tools.map((t: any) => t.name);
    expect(names).toContain('list_buttons');
    expect(names).toContain('get_button');
    expect(names).not.toContain('update_button');
    expect(names).not.toContain('create_profile');
    expect(names).not.toContain('execute_action');
  });

  it('tools/call: list_actions, execute_action, validate_manifest', async () => {
    const la = await handleMcpBody(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_actions', arguments: {} } }, stubCtx);
    const actions = JSON.parse((la.payload as any).result.content[0].text);
    expect(actions.actions[0].type).toBe('shell.shell');

    const ex = await handleMcpBody(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'execute_action', arguments: { type: 'shell.shell' } } }, stubCtx);
    expect((ex.payload as any).result.content[0].text).toContain('shell.shell');

    const bad = await handleMcpBody(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'no-existe', arguments: {} } }, stubCtx);
    expect((bad.payload as any).result.isError).toBe(true);

    const vm = await handleMcpBody(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'validate_manifest', arguments: { manifest: { id: 'x' } } } }, stubCtx);
    expect((vm.payload as any).result.content[0].text).toContain('"valid": false');
  });

  it('permiso denegado sin el scope', async () => {
    const auth = { tokenId: 't1', tokenName: 'lector', scopes: ['buttons.read'] };
    const res = await call('update_button', { id: 'x', patch: {} }, auth);
    expect(isErr(res)).toBe(true);
    expect((res.payload as any).result.content[0].text).toContain('permiso denegado');
  });

  it('método desconocido y request inválido', async () => {
    const u = await handleMcpBody({ jsonrpc: '2.0', id: 7, method: 'foo/bar' }, stubCtx);
    expect((u.payload as any).error.code).toBe(-32601);
    const p = await handleMcpBody('no-json', stubCtx);
    expect(p.status).toBe(400);
  });
});

describe('MCP control total: perfiles → páginas → botones', () => {
  it('CRUD completo + acciones + press', async () => {
    // perfil
    const cp = await call('create_profile', { name: 'MCP Test' });
    expect(isErr(cp)).toBe(false);
    const profileId = text(cp).profile.id;
    expect(profileId).toBeString();

    const lp = await call('list_profiles', {});
    expect(text(lp).profiles.some((p: any) => p.id === profileId)).toBe(true);

    const up = await call('update_profile', { id: profileId, name: 'MCP Test 2' });
    expect(text(up).profile.name).toBe('MCP Test 2');

    const cur = await call('set_current_profile', { profile_id: profileId });
    expect(text(cur).success).toBe(true);

    // página
    const pg = await call('create_page', { profile_id: profileId, name: 'Principal' });
    expect(isErr(pg)).toBe(false);
    const pageId = text(pg).page.id;

    const scp = await call('set_current_page', { page_id: pageId });
    expect(text(scp).success).toBe(true);

    // botón con icono y textos
    const cb = await call('create_button', {
      page_id: pageId,
      data: { label: 'Hola', icon: 'Play', backgroundColor: '#ff0000', actions: [] },
    });
    expect(isErr(cb)).toBe(false);
    const button = text(cb).button;
    expect(button.data.label).toBe('Hola');

    // update visual
    const ub = await call('update_button', { id: button.id, patch: { label: 'Adiós', textTop: 'top' } });
    const updated = text(ub).button;
    expect(updated.data.label).toBe('Adiós');
    expect(updated.data.textTop).toBe('top');
    expect(updated.data.icon).toBe('Play'); // el patch fusiona, no borra

    // añadir / reordenar acciones
    const a1 = await call('add_button_action', { button_id: button.id, type: 'shell.shell', parameters: { cmd: 'a' } });
    expect(text(a1).button.data.actions.length).toBe(1);
    await call('add_button_action', { button_id: button.id, type: 'shell.shell', parameters: { cmd: 'b' } });
    const ro = await call('reorder_button_actions', { button_id: button.id, order: [1, 0] });
    const reordered = text(ro).button.data.actions;
    expect(reordered[0].parameters.cmd).toBe('b');

    const ua = await call('update_button_action', { button_id: button.id, index: 0, parameters: { cmd: 'c' } });
    expect(text(ua).button.data.actions[0].parameters.cmd).toBe('c');

    // pulsar ejecuta las acciones
    const press = await call('press_button', { button_id: button.id });
    expect(text(press).executed).toBe(2);

    const rm = await call('remove_button_action', { button_id: button.id, index: 0 });
    expect(text(rm).button.data.actions.length).toBe(1);

    // duplicar + mover + reorder de página
    const dup = await call('duplicate_button', { id: button.id });
    const dupBtn = text(dup).button;
    expect(dupBtn.id).not.toBe(button.id);
    expect(dupBtn.data.label).toBe('Adiós');

    const lb = await call('list_buttons', { page_id: pageId });
    const ids = text(lb).buttons.map((b: any) => b.id);
    const re = await call('reorder_buttons', {
      page_id: pageId,
      order: ids.map((id: string, i: number) => ({ id, position: ids.length - 1 - i })),
    });
    expect(isErr(re)).toBe(false);

    // mover a otra página
    const pg2 = await call('create_page', { profile_id: profileId, name: 'Secundaria' });
    const page2 = text(pg2).page.id;
    const mv = await call('move_button', { id: button.id, page_id: page2 });
    expect(text(mv).button.page_id).toBe(page2);

    // get_state lo refleja todo
    const st = await call('get_state', {});
    const state = text(st);
    expect(state.counts.profiles).toBeGreaterThanOrEqual(1);
    expect(state.current.profileId).toBe(profileId);

    // settings + logs
    const gs = await call('set_setting', { key: 'mcp.test', value: '1' });
    expect(text(gs).value).toBe('1');
    const gl = await call('get_setting', { key: 'mcp.test' });
    expect(text(gl).value).toBe('1');
    const logs = await call('get_logs', { limit: 5 });
    expect(Array.isArray(text(logs).logs)).toBe(true);

    // limpieza
    await call('delete_button', { id: button.id });
    await call('delete_button', { id: dupBtn.id });
    await call('delete_page', { id: pageId });
    await call('delete_page', { id: page2 });
    const dp = await call('delete_profile', { id: profileId });
    expect(text(dp).success).toBe(true);
  });

  it('plugins: get/enable/disable/settings', async () => {
    const g = await call('get_plugin', { plugin_id: 'shell' });
    expect(text(g).plugin.id).toBe('shell');

    const d = await call('disable_plugin', { plugin_id: 'shell' });
    expect(text(d).success).toBe(true);

    const e = await call('enable_plugin', { plugin_id: 'shell' });
    expect(text(e).success).toBe(true);

    const s = await call('save_plugin_settings', { plugin_id: 'shell', values: { foo: 'bar' } });
    expect(text(s).success).toBe(true);

    const missing = await call('get_plugin', { plugin_id: 'no-existe' });
    expect(isErr(missing)).toBe(true);

    const prot = await call('uninstall_plugin', { plugin_id: 'shell' });
    expect(isErr(prot)).toBe(true); // stub lanza en test
  });
});
