/**
 * mcp-sysbackup.test.ts — MCP backups + assets + sistema (solo lectura salvo restore).
 *
 * Cubre: export/validate/restore de backups (confirm obligatorio, sin undo,
 * denegado en batch), delete_asset (confirm, sin undo, no batch),
 * list_assets, get_version, get_system_metrics (degradado honesto),
 * get_network_ips, list_jobs/cancel_job y scopes (lector .read no restaura).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-mcp-sysbackup-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;

import { initDatabase, DatabaseService } from '../db';
import { ALL_SCOPE_IDS } from '../mcp/scopes';
import { handleMcpBody } from '../mcp/server';
import { __resetHistoryForTests } from '../mcp/history';

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
    rollbackPlugin: async () => { throw new Error('sin backup en test'); },
    updatePlugin: async () => { throw new Error('no red en test'); },
    uninstallPlugin: async () => { throw new Error('protegido en test'); },
    getPluginSettingsBundle: () => ({ schema: null, values: {}, instructions: null, configured: true, missing: [], requiresConfiguration: false, oauth: null }),
    savePluginSettings: async (id: string, values: any) => values,
  },
  actionRunner: {
    executeAction: async (action: any) => ({ success: true, result: { echo: action.type }, duration: 1 }),
  },
  db: null as any,
  auth: null,
  ws: null,
  repaint: null,
};

const ADMIN = { tokenId: 't-sb-admin', tokenName: 'sb-admin', scopes: [...ALL_SCOPE_IDS] };
const READER = {
  tokenId: 't-sb-read', tokenName: 'sb-lector',
  scopes: [...ALL_SCOPE_IDS].filter((s) => s.endsWith('.read')),
};

async function call(name: string, args: any, auth: any = ADMIN, id = 1) {
  return handleMcpBody(
    { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
    { ...stubCtx, auth }
  );
}

async function listTools(auth: any = ADMIN) {
  return handleMcpBody({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }, { ...stubCtx, auth });
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
});

describe('MCP backups', () => {
  it('export_backup devuelve objeto versionado con sections', async () => {
    const r = await call('export_backup', {});
    expect(isErr(r)).toBe(false);
    const b = text(r);
    expect(b.format).toBe('libredeck-backup');
    expect(typeof b.version).toBe('number');
    expect(b.data && typeof b.data === 'object').toBe(true);
  });

  it('export_backup filtra sections e ignora desconocidas', async () => {
    const r = await call('export_backup', { sections: ['profiles', 'no-existe'] });
    expect(isErr(r)).toBe(false);
    const b = text(r);
    expect(Object.keys(b.data)).toContain('profiles');
    expect(Object.keys(b.data)).not.toContain('no-existe');
  });

  it('validate_backup: inválido → isError, exportado → valid true', async () => {
    const bad = await call('validate_backup', { backup: { formato: 'raro' } });
    expect(isErr(bad)).toBe(true);

    const exp = text(await call('export_backup', {}));
    const good = await call('validate_backup', { backup: exp });
    expect(isErr(good)).toBe(false);
    expect(text(good).valid).toBe(true);
  });

  it('export_profile_backup exige perfil existente', async () => {
    const bad = await call('export_profile_backup', { profile_id: 'sb-perfil-inexistente' });
    expect(isErr(bad)).toBe(true);

    const created = text(await call('create_profile', { name: 'SB Perfil' }));
    const pid = created.profile.id as string;
    const ok = await call('export_profile_backup', { profile_id: pid });
    expect(isErr(ok)).toBe(false);
    const b = text(ok);
    expect(b.data.profiles.some((p: any) => p.id === pid)).toBe(true);
    expect(text(await call('delete_profile', { id: pid })).success).toBe(true);
  });

  it('restore_backup sin confirm → isError; con confirm y backup válido → success', async () => {
    const created = text(await call('create_profile', { name: 'SB Restore' }));
    const pid = created.profile.id as string;
    const page = text(await call('create_page', { profile_id: pid, name: 'SB Portada' }));
    expect(page.page.id).toBeTruthy();

    const backup = text(await call('export_backup', {}));
    expect(text(await call('validate_backup', { backup })).valid).toBe(true);

    const noConfirm = await call('restore_backup', { backup });
    expect(isErr(noConfirm)).toBe(true);
    expect(errText(noConfirm)).toMatch(/confirm/i);

    __resetHistoryForTests();
    const ok = await call('restore_backup', { backup, sections: ['profiles', 'pages', 'buttons'], confirm: true });
    expect(isErr(ok)).toBe(false);
    expect(text(ok).success).toBe(true);

    // Sin undo: el restore no registra inversa en el historial propio.
    const hist = text(await call('get_history', {}));
    expect(hist.history.some((e: any) => e.tool === 'restore_backup')).toBe(false);

    expect(text(await call('delete_profile', { id: pid })).success).toBe(true);
  });

  it('batch deniega restore_backup y cancel_job pero admite export/validate', async () => {
    const backup = text(await call('export_backup', {}));
    const denied = await call('execute_batch', {
      operations: [{ tool: 'restore_backup', arguments: { backup, confirm: true } }],
    });
    expect(isErr(denied)).toBe(true);
    expect(errText(denied)).toMatch(/batch/i);

    const deniedCancel = await call('execute_batch', {
      operations: [{ tool: 'cancel_job', arguments: { job_id: 'job_x' } }],
    });
    expect(isErr(deniedCancel)).toBe(true);

    const admitted = await call('execute_batch', {
      operations: [
        { tool: 'export_backup', arguments: {} },
        { tool: 'validate_backup', arguments: { backup } },
      ],
    });
    expect(isErr(admitted)).toBe(false);
    expect(text(admitted).success).toBe(true);
  });

  it('lector .read no puede restaurar (ni ver la tool)', async () => {
    const backup = text(await call('export_backup', {}));
    const r = await call('restore_backup', { backup, confirm: true }, READER);
    expect(isErr(r)).toBe(true);
    expect(errText(r)).toMatch(/permiso denegado/i);

    const tools = await listTools(READER);
    const names = (tools.payload as any).result.tools.map((t: any) => t.name);
    expect(names).toContain('export_backup');
    expect(names).toContain('validate_backup');
    expect(names).not.toContain('restore_backup');
    expect(names).not.toContain('delete_asset');
    expect(names).not.toContain('cancel_job');
  });
});

describe('MCP assets', () => {
  it('list_assets devuelve array; delete_asset exige confirm y nombre válido', async () => {
    const listed = await call('list_assets', {});
    expect(isErr(listed)).toBe(false);
    expect(Array.isArray(text(listed).assets)).toBe(true);

    const noConfirm = await call('delete_asset', { path: 'key-x.png' });
    expect(isErr(noConfirm)).toBe(true);

    const badName = await call('delete_asset', { path: '../evil.png', confirm: true });
    expect(isErr(badName)).toBe(true);

    const empty = await call('delete_asset', { confirm: true });
    expect(isErr(empty)).toBe(true);
  });

  it('delete_asset borra fichero + metadatos con confirm:true', async () => {
    const { getAssetsDir } = await import('../paths');
    const dir = getAssetsDir();
    fs.mkdirSync(dir, { recursive: true });
    const name = `key-sb-${Date.now()}.png`;
    fs.writeFileSync(path.join(dir, name), Buffer.from([137, 80, 78, 71]));
    db.createAsset({ id: `sb-${Date.now()}`, path: name, hash: 'x', size: 4, created_at: Date.now() });

    const del = await call('delete_asset', { path: name, confirm: true });
    expect(isErr(del)).toBe(false);
    expect(text(del).ok).toBe(true);
    expect(fs.existsSync(path.join(dir, name))).toBe(false);
    expect(text(await call('list_assets', {})).assets.some((a: any) => a.path === name)).toBe(false);
  });
});

describe('MCP sistema', () => {
  it('get_version devuelve version string', async () => {
    const r = await call('get_version', {});
    expect(isErr(r)).toBe(false);
    const v = text(r);
    expect(typeof v.version).toBe('string');
    expect(v.version.length).toBeGreaterThan(0);
    expect(v.channel).toBe('stable');
  });

  it('get_system_metrics honesto (sin datos inventados) y get_network_ips array', async () => {
    const m = await call('get_system_metrics', {});
    expect(isErr(m)).toBe(false);
    const metrics = text(m);
    expect(metrics.cpu && metrics.ram).toBeTruthy();
    expect(typeof metrics.ram.total).toBe('number');

    const ips = await call('get_network_ips', {});
    expect(isErr(ips)).toBe(false);
    expect(Array.isArray(text(ips).ips)).toBe(true);
  });

  it('list_jobs devuelve array; cancel_job falla con id inexistente', async () => {
    const r = await call('list_jobs', {});
    expect(isErr(r)).toBe(false);
    expect(Array.isArray(text(r).jobs)).toBe(true);

    const bad = await call('cancel_job', { job_id: 'job-sb-inexistente' });
    expect(isErr(bad)).toBe(true);
  });

  it('cancel_job cancela un job en curso', async () => {
    const { getJobManager } = await import('../jobs/manager');
    const run = getJobManager().run('sb-test', async () => {
      await new Promise((res) => setTimeout(res, 30_000));
      return 'done';
    }, { checkMs: 20, timeoutMs: 60_000 });
    run.catch(() => {});
    const jobs = getJobManager().list().filter((j) => j.key === 'sb-test' && j.status === 'running');
    expect(jobs.length).toBeGreaterThan(0);

    const c = await call('cancel_job', { job_id: jobs[0].id });
    expect(isErr(c)).toBe(false);
    expect(text(c).success).toBe(true);
    await run.catch(() => {});
  });

  it('list_catalog offline responde con total y plugins', async () => {
    const r = await call('list_catalog', {});
    expect(isErr(r)).toBe(false);
    const c = text(r);
    expect(typeof c.total).toBe('number');
    expect(Array.isArray(c.plugins)).toBe(true);
  });

  it('scopes filtran tools/list del lector (sistema sin writes)', async () => {
    const admin = await listTools(ADMIN);
    const adminNames = (admin.payload as any).result.tools.map((t: any) => t.name);
    for (const t of ['export_backup', 'restore_backup', 'list_assets', 'delete_asset', 'get_version', 'list_jobs', 'cancel_job', 'list_catalog']) {
      expect(adminNames).toContain(t);
    }
    const reader = await listTools(READER);
    const readerNames = (reader.payload as any).result.tools.map((t: any) => t.name);
    for (const t of ['export_backup', 'list_assets', 'get_version', 'list_jobs', 'list_catalog']) {
      expect(readerNames).toContain(t);
    }
  });
});
