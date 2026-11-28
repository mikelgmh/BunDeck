/**
 * mcp-gaps.test.ts — tools MCP nuevas: aspecto/badges, controles, webhooks,
 * press-logs paginados, display, preferencias, catálogo/Elgato, atajos,
 * sesiones, contexto de página y variables extra.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-mcp-gaps-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;

import { initDatabase, DatabaseService } from '../db';
import { handleMcpBody } from '../mcp/server';
import { MCP_SCOPES } from '../mcp/scopes';
import { __resetHistoryForTests } from '../mcp/history';

let db: DatabaseService;

const CONTROL_ACTION = {
  name: 'Control de volumen',
  description: 'Muestra un control de volumen',
  schema: { type: 'object', properties: {} },
  surface: 'control',
  component: 'volume-range',
  dynamic: true,
  freeModeOnly: false,
  pollMs: 2000,
  states: [{ value: 'muted', label: 'Silenciado', icon: 'VolumeX' }],
  variables: [{ name: 'audioMicMuted', type: 'bool', label: 'Micro' }],
  i18n: {
    es: { name: 'Control de volumen', description: 'Muestra un control de volumen' },
    en: { name: 'Volume control', description: 'Shows a volume control' },
  },
};

const stubCtx: any = {
  pluginLoader: {
    getPluginActions: () =>
      new Map<string, any>([
        ['shell.shell', { name: 'Shell', description: 'Run', schema: null }],
        ['audio-mixer.volume-control', CONTROL_ACTION],
      ]),
    getAction: (type: string) =>
      type === 'audio-mixer.volume-control'
        ? CONTROL_ACTION
        : type === 'shell.shell'
          ? { name: 'Shell', description: 'Run', schema: null }
          : undefined,
    getPlugin: (id: string) =>
      id === 'audio-mixer'
        ? {
            enabled: true,
            manifest: {
              id: 'audio-mixer',
              actions: [
                { id: 'volume-control' },
                { id: 'scene', optionsFrom: { sourceAction: 'scene-list', field: 'scene' } },
              ],
              widgets: [{ id: 'w1', kind: 'text', title: 'Nivel' }],
            },
          }
        : undefined,
    listDetailed: () => [
      {
        id: 'audio-mixer',
        enabled: true,
        manifest: { id: 'audio-mixer', widgets: [{ id: 'w1', kind: 'text', title: 'Nivel' }] },
      },
    ],
    getElgatoState: async () => ({ contexts: 1 }),
    getStatus: () => null,
    getPluginSettingsBundle: () => ({ schema: null, values: {}, instructions: null, configured: true, missing: [], requiresConfiguration: false, oauth: null }),
    savePluginSettings: (id: string, values: any) => values,
  },
  actionRunner: {
    executeAction: async (action: any) => ({
      success: true,
      result: action?.type === 'audio-mixer.scene-list' ? { options: [{ value: 'a', label: 'A' }] } : { echo: action.type },
    }),
  },
  db: null as any,
  auth: { tokenId: 'mcp-gaps', tokenName: 'gaps', scopes: null },
  ws: new Proxy(
    { getSessions: () => [] },
    {
      get: (t: any, k: string) => {
        if (k in t) return (t as any)[k];
        if (k === 'then') return undefined;
        return () => {};
      },
    }
  ),
  repaint: null,
};

async function call(name: string, args: any, id = 1) {
  return handleMcpBody(
    { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
    stubCtx
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
  __resetHistoryForTests();
});

describe('MCP gaps: catálogo de tools y scopes', () => {
  it('tools/list expone las tools nuevas y scopes incluye los grupos nuevos', async () => {
    const tools = await handleMcpBody({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, stubCtx);
    const names = (tools.payload as any).result.tools.map((t: any) => t.name);
    for (const n of [
      'get_button_appearance', 'set_button_appearance',
      'list_controls', 'get_plugin_action', 'get_action_options', 'list_plugin_widgets',
      'list_webhooks', 'get_webhook', 'create_webhook', 'update_webhook',
      'delete_webhook', 'regenerate_webhook_token', 'test_webhook',
      'list_press_logs', 'clear_press_logs',
      'get_device_display', 'set_device_display',
      'get_app_preferences', 'set_app_preferences',
      'get_catalog_plugin', 'get_elgato_state',
      'list_shortcuts', 'trigger_shortcut', 'close_session', 'get_page_context',
      'list_scoped_variables', 'update_scoped_variable', 'list_exposed_variables',
    ]) {
      expect(names).toContain(n);
    }
    const ids = MCP_SCOPES.map((s) => s.id);
    for (const s of ['webhooks.read', 'webhooks.write', 'presslogs.read', 'presslogs.write', 'shortcuts.read', 'shortcuts.write']) {
      expect(ids).toContain(s);
    }
  });
});

describe('MCP gaps: aspecto de botones', () => {
  it('set/get appearance con badge + looks + resolve, y undo', async () => {
    const p = text(await call('create_profile', { name: 'gaps-ap' }));
    const pg = text(await call('create_page', { profile_id: p.profile.id, name: 'P1' }));
    const b = text(await call('create_button', { page_id: pg.page.id, data: { label: 'Base' } }));
    const id = b.button.id;

    const set = await call('set_button_appearance', {
      id,
      appearance: { badge: '3', dynamicValue: '{{mcpGapsX}}', backgroundColor: '#112233' },
      looks: [{ cond: 'mcpGapsX > 1', t: 'Alto', c: 2 }],
    });
    expect(isErr(set)).toBe(false);

    const got = text(await call('get_button_appearance', { id }));
    expect(got.appearance.badge).toBe('3');
    expect(got.looks).toHaveLength(1);

    const resolved = text(await call('get_button_appearance', { id, resolve: true }));
    expect(typeof resolved.resolved).toBe('object');
    expect(resolved.resolved.badge).toBe('3');

    // looks sin cond → error
    const bad = await call('set_button_appearance', { id, looks: [{ t: 'x' }] });
    expect(isErr(bad)).toBe(true);

    // undo restaura data previa
    const undo = text(await call('undo_last', {}));
    expect(undo.success).toBe(true);
    const after = text(await call('get_button_appearance', { id }));
    expect(after.appearance.badge).toBeUndefined();
    expect(after.looks).toEqual([]);
  });

  it('update_button patch admite badge/dynamicValue/imágenes', async () => {
    const p = text(await call('create_profile', { name: 'gaps-ap2' }));
    const pg = text(await call('create_page', { profile_id: p.profile.id, name: 'P1' }));
    const b = text(await call('create_button', { page_id: pg.page.id, data: {} }));
    const upd = await call('update_button', { id: b.button.id, patch: { badge: '9', iconImage: 'x.png', showTitle: false } });
    expect(isErr(upd)).toBe(false);
    expect(text(upd).button.data.badge).toBe('9');
  });
});

describe('MCP gaps: controles y superficies', () => {
  it('list_controls solo controles por defecto; get_plugin_action localizado', async () => {
    const only = text(await call('list_controls', {}));
    expect(only.controls.map((c: any) => c.type)).toEqual(['audio-mixer.volume-control']);
    expect(only.controls[0].component).toBe('volume-range');

    const all = text(await call('list_controls', { only_controls: false }));
    expect(all.controls.length).toBe(2);

    const es = text(await call('get_plugin_action', { type: 'audio-mixer.volume-control', locale: 'es' }));
    expect(es.name).toBe('Control de volumen');
    expect(es.surface).toBe('control');
    expect(es.states).toHaveLength(1);
    const en = text(await call('get_plugin_action', { type: 'audio-mixer.volume-control', locale: 'en' }));
    expect(en.name).toBe('Volume control');

    const missing = await call('get_plugin_action', { type: 'nope.nope' });
    expect(isErr(missing)).toBe(true);
  });

  it('get_action_options ejecuta la sourceAction y list_plugin_widgets lista widgets', async () => {
    const opts = text(await call('get_action_options', { plugin_id: 'audio-mixer', action_id: 'scene' }));
    expect(opts.success).toBe(true);
    expect(opts.options).toEqual([{ value: 'a', label: 'A' }]);

    const bad = await call('get_action_options', { plugin_id: 'audio-mixer', action_id: 'volume-control' });
    expect(isErr(bad)).toBe(true);

    const w = text(await call('list_plugin_widgets', { plugin_id: 'audio-mixer' }));
    expect(w.widgets).toHaveLength(1);
    expect(w.widgets[0].kind).toBe('text');
  });
});

describe('MCP gaps: webhooks LAN', () => {
  it('CRUD + token oculto en lista + test + regenerate + delete con confirm y undo', async () => {
    const created = text(await call('create_webhook', { name: 'gaps-hook', actions: [{ type: 'shell.shell', parameters: {} }] }));
    const id = created.webhook.id;
    expect(created.webhook.token.length).toBeGreaterThanOrEqual(48);

    const listed = text(await call('list_webhooks', {}));
    const row = listed.webhooks.find((w: any) => w.id === id);
    expect(row.token).toBeNull();

    const withTok = text(await call('list_webhooks', { includeTokens: true }));
    expect(withTok.webhooks.find((w: any) => w.id === id).token).toBe(created.webhook.token);

    const got = text(await call('get_webhook', { id }));
    expect(got.webhook.urlPath).toBe(`/api/v1/webhooks/${created.webhook.token}`);

    const badMethod = await call('create_webhook', { name: 'x', method: 'PURGE' });
    expect(isErr(badMethod)).toBe(true);

    const noConfirmTest = await call('test_webhook', { id });
    expect(isErr(noConfirmTest)).toBe(true);
    const test = text(await call('test_webhook', { id, confirm: true }));
    expect(test.ok).toBe(true);
    expect(test.executed).toBe(1);

    const regen = text(await call('regenerate_webhook_token', { id }));
    expect(regen.webhook.token).not.toBe(created.webhook.token);

    // delete exige confirm
    const noConfirm = await call('delete_webhook', { id });
    expect(isErr(noConfirm)).toBe(true);
    expect(errText(noConfirm)).toMatch(/confirm/);

    const del = text(await call('delete_webhook', { id, confirm: true }));
    expect(del.success).toBe(true);
    expect(isErr(await call('get_webhook', { id }))).toBe(true);

    // undo restaura el webhook
    const undo = text(await call('undo_last', {}));
    expect(undo.success).toBe(true);
    expect(isErr(await call('get_webhook', { id }))).toBe(false);
  });
});

describe('MCP gaps: press-logs paginados', () => {
  it('lista con filtros y paginación; clear exige confirm', async () => {
    db.addPressLog({ buttonId: 'gaps-btn', pageId: null, profileId: null, position: null, pressType: 'short', deviceId: 'd1', deviceName: null, source: 'test', actionType: 'shell.shell', actionIndex: 0, actionId: null, runId: null, success: true, error: null, durationMs: 5 } as any);
    db.addPressLog({ buttonId: 'gaps-btn', pageId: null, profileId: null, position: null, pressType: 'short', deviceId: 'd1', deviceName: null, source: 'test', actionType: 'shell.shell', actionIndex: 0, actionId: null, runId: null, success: false, error: 'boom', durationMs: 5 } as any);

    const all = text(await call('list_press_logs', { buttonId: 'gaps-btn' }));
    expect(all.total).toBe(2);
    expect(all.items).toHaveLength(2);

    const page = text(await call('list_press_logs', { buttonId: 'gaps-btn', limit: 1, offset: 1 }));
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);

    const fails = text(await call('list_press_logs', { buttonId: 'gaps-btn', success: false }));
    expect(fails.total).toBe(1);

    expect(isErr(await call('list_press_logs', { limit: 999 }))).toBe(true);
    expect(isErr(await call('clear_press_logs', { buttonId: 'gaps-btn' }))).toBe(true);

    const cleared = text(await call('clear_press_logs', { buttonId: 'gaps-btn', confirm: true }));
    expect(cleared.deleted).toBe(2);
  });
});

describe('MCP gaps: display, preferencias, catálogo, atajos, sesiones, contexto', () => {
  it('display por dispositivo con undo', async () => {
    const before = text(await call('get_device_display', { device: 'gaps-deck' }));
    expect(before.brightness).toBe(100);
    const set = text(await call('set_device_display', { device: 'gaps-deck', brightness: 60, idleAction: 'dim' }));
    expect(set.brightness).toBe(60);
    expect(set.idleAction).toBe('dim');
    expect(isErr(await call('set_device_display', { device: 'gaps-deck', idleAction: 'apagar' }))).toBe(true);
    const undo = text(await call('undo_last', {}));
    expect(undo.success).toBe(true);
    const after = text(await call('get_device_display', { device: 'gaps-deck' }));
    expect(after.brightness).toBe(before.brightness);
  });

  it('preferencias: idioma/autostart con validación y undo', async () => {
    const set = text(await call('set_app_preferences', { language: 'es', autostart: true, start_minimized: false }));
    expect(set).toMatchObject({ language: 'es', autostart: true, start_minimized: false });
    const got = text(await call('get_app_preferences', {}));
    expect(got.language).toBe('es');
    expect(got.autostart).toBe(true);
    expect(isErr(await call('set_app_preferences', { language: 'fr' }))).toBe(true);
    expect(isErr(await call('set_app_preferences', {}))).toBe(true);
    expect(text(await call('undo_last', {})).success).toBe(true);
  });

  it('catálogo detalle, elgato state, atajos y cierre de sesión', async () => {
    const cat = text(await call('list_catalog', {}));
    expect(cat.total).toBeGreaterThan(0);
    const entry = text(await call('get_catalog_plugin', { id: cat.plugins[0].id }));
    expect(entry.id).toBe(cat.plugins[0].id);
    expect(typeof entry.compatible).toBe('boolean');
    expect(isErr(await call('get_catalog_plugin', { id: 'no-existe-xyz' }))).toBe(true);

    const elg = text(await call('get_elgato_state', { plugin_id: 'audio-mixer' }));
    expect(elg.contexts).toBe(1);

    const sc = text(await call('list_shortcuts', {}));
    expect(sc.ids).toContain('next-profile');

    const trg = text(await call('trigger_shortcut', { id: 'toggle-panels', source: 'test', notifyOnly: true }));
    expect(trg.ok).toBe(true);
    expect(isErr(await call('trigger_shortcut', { id: 'nope' }))).toBe(true);

    expect(isErr(await call('close_session', { device_id: 'gaps-dev-x' }))).toBe(true);
    db.setDeviceStartupProfile('gaps-dev-x', null);
    expect(text(await call('close_session', { device_id: 'gaps-dev-x' })).success).toBe(true);
    expect(db.getDeviceSession('gaps-dev-x')).toBeNull();
  });

  it('get_page_context devuelve page + buttons + assignments', async () => {
    const p = text(await call('create_profile', { name: 'gaps-ctx' }));
    const pg = text(await call('create_page', { profile_id: p.profile.id, name: 'Ctx' }));
    await call('create_button', { page_id: pg.page.id, data: { label: 'B' } });
    const ctx = text(await call('get_page_context', { id: pg.page.id }));
    expect(ctx.page.id).toBe(pg.page.id);
    expect(ctx.buttons).toHaveLength(1);
    expect(typeof ctx.assignments).toBe('object');
    expect(typeof ctx.pageVersion).toBe('number');
  });
});

describe('MCP gaps: variables extra y batch', () => {
  it('list/update scoped + expuestas + toggle', async () => {
    const created = text(await call('set_scoped_variable', { name: 'mcpGapsFlag', value: false, type: 'bool' }));
    expect(created.variable.value).toBe(false);

    const listed = text(await call('list_scoped_variables', { scope: 'global' }));
    expect(listed.variables.some((v: any) => v.name === 'mcpGapsFlag')).toBe(true);

    const upd = text(await call('update_scoped_variable', { name: 'mcpGapsFlag', unavailable: true }));
    expect(upd.variable.unavailable).toBe(true);

    const exposed = text(await call('list_exposed_variables', {}));
    expect(exposed.variables.some((v: any) => v.name === 'discordMuted')).toBe(true);

    const toggled = text(await call('toggle_variable', { name: 'mcpGapsFlag' }));
    expect(toggled.variable.value).toBe(true);
  });

  it('batch rechaza tools no transaccionales y acepta CRUD de webhooks', async () => {
    const denied = await call('execute_batch', { operations: [{ tool: 'test_webhook', arguments: { id: 'x' } }] });
    expect(isErr(denied)).toBe(true);

    const denied2 = await call('execute_batch', { operations: [{ tool: 'clear_press_logs', arguments: {} }] });
    expect(isErr(denied2)).toBe(true);

    const ok = text(await call('execute_batch', {
      operations: [
        { tool: 'create_webhook', arguments: { name: 'gaps-batch-hook' } },
        { tool: 'set_app_preferences', arguments: { language: 'en' } },
      ],
    }));
    expect(ok.success).toBe(true);
    expect(ok.applied).toBe(2);
  });
});
