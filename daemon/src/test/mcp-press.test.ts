/**
 * mcp-press.test.ts — press_button canónico con pressType (FASE 3).
 *
 * Cubre: press por defecto short, press long, pressType inválido,
 * confirm para acciones sensibles, botón inexistente y side-effects
 * de navegación (navigate_to_page → ws.navigatePageTo).
 *
 * Robusto al mock.module('../db') GLOBAL de action-runner.test.ts:
 * solo aserciones vía tools, tokenIds únicos y reset de historial.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-mcp-press-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;

import { initDatabase, DatabaseService } from '../db';
import { ALL_SCOPE_IDS } from '../mcp/scopes';
import { handleMcpBody } from '../mcp/server';
import { __resetHistoryForTests } from '../mcp/history';

let db: DatabaseService;

// Registros del runner/nav mocks (se limpian en beforeEach).
const flowCalls: Array<{ button: any; context: any }> = [];
const navCalls: Array<{ kind: string; opts: any }> = [];
let nextResult: any = null;

const stubCtx: any = {
  pluginLoader: {
    getPluginActions: () => new Map([
      ['shell.shell', { name: 'Shell', schema: null }],
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
    savePluginSettings: async (_id: string, values: any) => values,
  },
  actionRunner: {
    executeButtonFlow: async (button: any, context: any) => {
      flowCalls.push({ button, context });
      if (nextResult !== null) {
        const r = nextResult;
        nextResult = null;
        return r;
      }
      return { success: true, results: [] };
    },
    executeAction: async (action: any) => ({ success: true, result: { echo: action.type }, duration: 1 }),
  },
  db: null as any,
  auth: null,
  ws: new Proxy(
    {
      navigatePageTo: (opts: any) => { navCalls.push({ kind: 'page', opts }); return { ok: true }; },
      navigateProfileTo: (opts: any) => { navCalls.push({ kind: 'profile', opts }); return { ok: true }; },
    } as any,
    {
      get: (t: any, p: string) => {
        if (p in t) return (t as any)[p];
        // No-op para el resto de broadcasts/sesiones del WS real.
        return (..._a: any[]) => ({ ok: true });
      },
    },
  ),
  repaint: null,
};

const ADMIN = { tokenId: 't-press-admin', tokenName: 'press-admin', scopes: [...ALL_SCOPE_IDS] };

async function call(name: string, args: any, auth: any = ADMIN, id = 1) {
  return handleMcpBody(
    { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
    { ...stubCtx, auth },
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
  flowCalls.length = 0;
  navCalls.length = 0;
  nextResult = null;
});

async function makeButton(actions: any[] = []) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const cp = await call('create_profile', { name: `Press P ${suffix}` });
  expect(isErr(cp)).toBe(false);
  const profileId = text(cp).profile.id;
  const pg = await call('create_page', { profile_id: profileId, name: `Principal ${suffix}` });
  expect(isErr(pg)).toBe(false);
  const pageId = text(pg).page.id;
  const cb = await call('create_button', { page_id: pageId, data: { label: 'B', actions } });
  expect(isErr(cb)).toBe(false);
  return { profileId, pageId, buttonId: text(cb).button.id as string };
}

describe('MCP press_button canónico con pressType', () => {
  it('press por defecto usa short', async () => {
    const { buttonId } = await makeButton([]);
    const res = await call('press_button', { button_id: buttonId });
    expect(isErr(res)).toBe(false);
    const out = text(res);
    expect(out.buttonId).toBe(buttonId);
    expect(out.pressType).toBe('short');
    expect(flowCalls.length).toBe(1);
    expect(flowCalls[0].context.pressType).toBe('short');
  });

  it('press long pasa pressType:long', async () => {
    const { buttonId } = await makeButton([]);
    const res = await call('press_button', { button_id: buttonId, press_type: 'long' });
    expect(isErr(res)).toBe(false);
    expect(text(res).pressType).toBe('long');
    expect(flowCalls[0].context.pressType).toBe('long');
  });

  it('pressType inválido → isError', async () => {
    const { buttonId } = await makeButton([]);
    const res = await call('press_button', { button_id: buttonId, press_type: 'turbo' });
    expect(isErr(res)).toBe(true);
    expect(errText(res)).toContain('press_type');
    expect(flowCalls.length).toBe(0);
  });

  it('botón con acción sensible exige confirm', async () => {
    const { buttonId } = await makeButton([{ type: 'shell.shell', parameters: { cmd: 'x' } }]);
    const denied = await call('press_button', { button_id: buttonId });
    expect(isErr(denied)).toBe(true);
    expect(errText(denied)).toContain('confirm');
    expect(flowCalls.length).toBe(0);
    const okRes = await call('press_button', { button_id: buttonId, confirm: true });
    expect(isErr(okRes)).toBe(false);
    expect(flowCalls.length).toBe(1);
  });

  it('botón inexistente → isError', async () => {
    const res = await call('press_button', { button_id: 'no-existe-press' });
    expect(isErr(res)).toBe(true);
  });

  it('navegación: resultado con navigate_to_page llama a ws.navigatePageTo', async () => {
    const { buttonId, pageId } = await makeButton([]);
    nextResult = {
      success: true,
      results: [{ kind: 'action', result: { action: 'navigate_to_page', pageId, pageName: 'Principal' } }],
    };
    const res = await call('press_button', { button_id: buttonId, confirm: true });
    expect(isErr(res)).toBe(false);
    expect(navCalls.length).toBe(1);
    expect(navCalls[0].kind).toBe('page');
    expect(navCalls[0].opts.pageId).toBe(pageId);
    expect(navCalls[0].opts.targets).toEqual({ kind: 'all' });
  });
});
