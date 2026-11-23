/**
 * mcp-devices.test.ts — Fase 2 del MCP: dispositivos, asignaciones y sesiones.
 *
 * Cubre: CRUD de devices (con validación kind/model/cols/rows), get_state
 * extendido, get/set_assignments con compatibilidad (deck rechaza modo
 * libre), undo de update_device y de set_assignments, batch (devices sí,
 * navigate/set_session_view no), permisos por scope y degradado sin WS.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-mcp-dev-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;

import { initDatabase, DatabaseService } from '../db';
import { ALL_SCOPE_IDS } from '../mcp/scopes';
import { handleMcpBody } from '../mcp/server';
import { __resetHistoryForTests } from '../mcp/history';

let db: DatabaseService;

const sessions = new Map<string, any>();
const wsStub: any = {
  broadcast: () => {},
  broadcastProfileUpdate: () => {},
  broadcastPageCreated: () => {},
  broadcastPageDeleted: () => {},
  broadcastButtonUpdate: () => {},
  broadcastButtonDeleted: () => {},
  broadcastButtonsReordered: () => {},
  broadcastActionStarted: () => {},
  broadcastActionFinished: () => {},
  broadcastActionError: () => {},
  broadcastPluginInstalled: () => {},
  broadcastPluginEnabled: () => {},
  broadcastPluginUninstalled: () => {},
  getSessions: () => [...sessions.values()].map((s: any) => ({ deviceId: s.deviceId, profileId: s.profileId ?? null, pageId: s.pageId ?? null })),
  getSessionView: (id: string) => {
    const s = sessions.get(id);
    const p = db.getDeviceSession(id) as any;
    if (!s && !p) return null;
    return { profileId: s?.profileId ?? p?.profile_id ?? null, pageId: s?.pageId ?? p?.page_id ?? null };
  },
  setSessionView: (id: string, v: any) => {
    if (v.profileId !== undefined && v.profileId !== null && !db.getProfile(v.profileId)) return { ok: false, error: 'Profile not found' };
    if (v.pageId !== undefined && v.pageId !== null && !db.getPage(v.pageId)) return { ok: false, error: 'Page not found' };
    db.upsertDeviceSession({ device_id: id, profile_id: v.profileId, page_id: v.pageId, startup_profile_id: v.startupProfileId });
    sessions.set(id, { deviceId: id, profileId: v.profileId ?? null, pageId: v.pageId ?? null });
    return { ok: true };
  },
  navigatePageTo: (o: any) => {
    const pg = db.getPage(o.pageId) as any;
    if (!pg) return { ok: false, error: 'Page not found' };
    const ids = o.targets?.kind === 'all' ? [...sessions.keys()] : (o.targets?.ids ?? []);
    for (const id of ids) sessions.set(id, { deviceId: id, profileId: pg.profile_id, pageId: pg.id });
    return { ok: true, deliveredTo: ids, profileId: pg.profile_id };
  },
  navigateProfileTo: (o: any) => {
    const p = db.getProfile(o.profileId);
    if (!p) return { ok: false, error: 'Profile not found' };
    const ids = o.targets?.kind === 'all' ? [...sessions.keys()] : (o.targets?.ids ?? []);
    for (const id of ids) sessions.set(id, { deviceId: id, profileId: p.id, pageId: null });
    return { ok: true, deliveredTo: ids };
  },
};

const stubCtx: any = {
  pluginLoader: {
    getPluginActions: () => new Map(),
    listDetailed: () => [],
  },
  actionRunner: { executeAction: async () => ({ success: true }) },
  db: null as any,
  auth: null,
  ws: wsStub,
  repaint: null,
};

const ADMIN = { tokenId: 't-dev-admin', tokenName: 'dev-admin', scopes: [...ALL_SCOPE_IDS] };
const READER = { tokenId: 't-dev-read', tokenName: 'dev-read', scopes: ['devices.read', 'sessions.read', 'state.read'] };

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
});

beforeEach(() => {
  __resetHistoryForTests();
});

describe('MCP: dispositivos y asignaciones', () => {
  it('CRUD de devices con validación', async () => {
    const bad = await call('create_device', { name: 'X', kind: 'reloj' });
    expect(isErr(bad)).toBe(true);

    const deck = await call('create_device', { name: 'Deck', kind: 'deck', model: 'mk2' });
    expect(isErr(deck)).toBe(false);
    expect(text(deck).device.effectiveSize).toEqual({ cols: 5, rows: 3 });
    const deckId = text(deck).device.id;

    const phone = await call('create_device', { name: 'Phone', kind: 'phone' });
    const phoneId = text(phone).device.id;

    expect(text(await call('get_device', { id: deckId })).device.id).toBe(deckId);
    expect(isErr(await call('get_device', { id: 'nope' }))).toBe(true);

    const up = await call('update_device', { id: phoneId, name: 'Phone 2' });
    expect(text(up).device.name).toBe('Phone 2');

    // undo de update_device
    await call('undo_last', {});
    // Nota: se lee vía get_device (mismo ctx.db que usa el undo).
    expect(text(await call('get_device', { id: phoneId })).device.name).toBe('Phone');

    const del = await call('delete_device', { id: phoneId });
    expect(text(del).success).toBe(true);
    expect(isErr(await call('get_device', { id: phoneId }))).toBe(true);
    // undo de delete restaura
    await call('undo_last', {});
    expect(text(await call('get_device', { id: phoneId })).device?.name).toBe('Phone');

    await call('delete_device', { id: deckId });
    await call('delete_device', { id: phoneId });
  });

  it('asignaciones: deck rechaza modo libre, phone acepta', async () => {
    const cp = text(await call('create_profile', { name: 'Dg' })).profile;
    const main = text(await call('create_page', { profile_id: cp.id, name: 'Main' })).page;
    const free = text(await call('create_page', { profile_id: cp.id, name: 'Free', layout_mode: 'gridstack', grid_cols: 8, grid_rows: 4 })).page;
    const deckId = text(await call('create_device', { name: 'D', kind: 'deck', model: 'mk2' })).device.id;
    const phoneId = text(await call('create_device', { name: 'P', kind: 'phone' })).device.id;

    const bad = await call('set_assignments', { profile_id: cp.id, assignments: { [deckId]: free.id } });
    expect(isErr(bad)).toBe(true);
    expect(errText(bad)).toContain('incompatible');

    const ok = await call('set_assignments', { profile_id: cp.id, assignments: { [deckId]: main.id, [phoneId]: free.id } });
    expect(isErr(ok)).toBe(false);
    expect(text(ok).assignments[deckId]).toBe(main.id);

    const ga = text(await call('get_assignments', { profile_id: cp.id }));
    expect(ga.compat.find((c: any) => c.deviceId === deckId).ok).toBe(true);

    // undo restaura el mapa previo
    await call('set_assignments', { profile_id: cp.id, assignments: { [deckId]: main.id, [phoneId]: main.id } });
    await call('undo_last', {});
    expect(db.getAssignments(cp.id)[phoneId]).toBe(free.id);

    await call('delete_profile', { id: cp.id });
    await call('delete_device', { id: deckId });
    await call('delete_device', { id: phoneId });
  });

  it('scopes: lector no escribe devices', async () => {
    expect(isErr(await call('create_device', { name: 'X' }, READER))).toBe(true);
    expect(isErr(await call('list_devices', {}, READER))).toBe(false);
    expect(isErr(await call('set_assignments', { profile_id: 'x', assignments: {} }, READER))).toBe(true);
  });

  it('batch: devices sí, navigate/set_session_view no', async () => {
    const d = text(await call('create_device', { name: 'B' })).device;
    const r = await call('execute_batch', { operations: [{ tool: 'update_device', arguments: { id: d.id, name: 'B2' } }] });
    expect(isErr(r)).toBe(false);
    expect((db.getDevice(d.id) as any).name).toBe('B2');

    const n = await call('execute_batch', { operations: [{ tool: 'navigate', arguments: { profile_id: 'x', broadcast: true } }] });
    expect(isErr(n)).toBe(true);
    expect(errText(n)).toContain('no admitida');
    await call('delete_device', { id: d.id });
  });
});

describe('MCP: sesiones y navegación', () => {
  it('list/get/set_session_view + navigate dirigido', async () => {
    const cp = text(await call('create_profile', { name: 'S' })).profile;
    const main = text(await call('create_page', { profile_id: cp.id, name: 'SMain' })).page;
    sessions.set('tab-1', { deviceId: 'tab-1', profileId: null, pageId: null });

    expect(text(await call('list_sessions', {})).sessions.some((s: any) => s.deviceId === 'tab-1')).toBe(true);

    const sv = await call('set_session_view', { device_id: 'tab-1', page_id: main.id });
    expect(isErr(sv)).toBe(false);
    expect(text(await call('get_session', { device_id: 'tab-1' })).view.pageId).toBe(main.id);

    const nv = await call('navigate', { page_id: main.id, device_id: 'tab-1' });
    expect(isErr(nv)).toBe(false);
    expect(text(nv).deliveredTo).toContain('tab-1');

    // sin destino → error (no broadcast accidental)
    expect(isErr(await call('navigate', { page_id: main.id }))).toBe(true);
    // page y profile a la vez → error
    expect(isErr(await call('navigate', { page_id: main.id, profile_id: cp.id, broadcast: true }))).toBe(true);
    // inexistente → error
    expect(isErr(await call('get_session', { device_id: 'nadie' }))).toBe(true);

    await call('delete_profile', { id: cp.id });
  });

  it('sin WS degradan con error claro; get_streamdeck_status no rompe', async () => {
    const noWs = { ...stubCtx, auth: ADMIN, ws: null };
    const nav: any = await handleMcpBody(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'navigate', arguments: { page_id: 'x', broadcast: true } } },
      noWs
    );
    expect(nav.payload.result.isError).toBe(true);
    const hw = await call('get_streamdeck_status', {});
    expect(isErr(hw)).toBe(false);
    expect(typeof text(hw).isConnected).toBe('boolean');
  });

  it('get_state incluye devices, assignments y counts', async () => {
    const cp = text(await call('create_profile', { name: 'St' })).profile;
    await call('set_current_profile', { profile_id: cp.id });
    const st = text(await call('get_state', {}));
    expect(Array.isArray(st.devices)).toBe(true);
    expect(st.assignments).toBeDefined();
    expect(st.counts.devices).toBeGreaterThanOrEqual(0);
    await call('delete_profile', { id: cp.id });
  });
});
