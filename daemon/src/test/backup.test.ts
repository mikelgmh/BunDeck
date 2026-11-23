/**
 * backup.test.ts — backups completos y restore (selectivo / limpio).
 *
 * Cubre: buildBackup (formato versionado + secciones), validateBackup
 * (válido e inválidos), restore merge, restore selectivo por secciones,
 * restore a instalación limpia (mode 'clean'), rechazo pre-restore y
 * progreso (started → progress* → done).
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-backup-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;

import { initDatabase, DatabaseService } from '../db';
import { getAssetsDir } from '../paths';
import { buildBackup, buildProfileBackup, validateBackup, restoreBackup, BACKUP_FORMAT, BACKUP_VERSION } from '../backup';

let db: DatabaseService;

beforeAll(async () => {
  process.env.LIBREDECK_DATA_DIR = TMP;
  await initDatabase();
  db = new DatabaseService();
});

function seedAll(tag: string) {
  const p = db.createProfile({ id: `prof-${tag}`, name: `P ${tag}`, data: {} });
  db.createPage({ id: `page-${tag}`, profile_id: p.id, name: 'Raíz', order_idx: 0, is_folder: 0, data: {} } as any);
  db.createPage({ id: `fold-${tag}`, profile_id: p.id, name: 'Carpeta', order_idx: 1, is_folder: 1, data: {} } as any);
  db.createButton({ id: `btn-${tag}`, page_id: `page-${tag}`, position: 0, data: { label: 'Hola', actions: [] } } as any);
  db.createWidget({ id: `wid-${tag}`, name: `W ${tag}`, kind: 'clock', data: { tz: 'local' } });
  db.createFlow({ id: `flow-${tag}`, name: `F ${tag}`, data: { steps: [{ type: 'utility.delay', parameters: { ms: 1 } }] } });
  db.createAutomation({ id: `auto-${tag}`, name: `A ${tag}`, enabled: 1, trigger: { kind: 'manual' }, data: { actions: [] } });
  db.setVariable(`var_${tag}`, 42, 'numeric');
  db.setSetting(`seed.${tag}`, '1');
  return p;
}

describe('backups: formato y validación', () => {
  it('buildBackup genera formato versionado con todas las secciones', () => {
    seedAll('base');
    const b = buildBackup(db);
    expect(b.format).toBe(BACKUP_FORMAT);
    expect(b.version).toBe(BACKUP_VERSION);
    expect(typeof b.appVersion).toBe('string');
    expect(typeof b.createdAt).toBe('number');
    const keys = Object.keys(b.data);
    for (const s of ['profiles', 'pages', 'buttons', 'widgets', 'flows', 'automations', 'variables', 'plugins', 'settings']) {
      expect(keys).toContain(s);
    }
    expect(b.data.profiles.length).toBeGreaterThanOrEqual(1);
    expect(b.data.widgets.some((w: any) => w.id === 'wid-base')).toBe(true);
    expect(b.data.flows.some((f: any) => f.id === 'flow-base')).toBe(true);
    expect(b.data.automations.some((a: any) => a.id === 'auto-base')).toBe(true);
    expect(b.data.variables.some((v: any) => v.name === 'var_base')).toBe(true);
    // Carpetas viajan dentro de pages (is_folder=1).
    expect(b.data.pages.some((p: any) => p.id === 'fold-base' && p.is_folder === 1)).toBe(true);
  });

  it('validateBackup acepta un backup bueno y rechaza basura', () => {
    const good = buildBackup(db);
    const v = validateBackup(good);
    expect(v.valid).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.info.counts.profiles).toBeGreaterThanOrEqual(1);

    expect(validateBackup(null).valid).toBe(false);
    expect(validateBackup({}).valid).toBe(false);
    expect(validateBackup({ ...good, format: 'otro' }).valid).toBe(false);
    expect(validateBackup({ ...good, version: 999 }).valid).toBe(false);
    // Versión vieja: válida con aviso.
    const oldV = validateBackup({ ...good, version: 0 });
    expect(oldV.valid).toBe(true);
    expect(oldV.warnings.length).toBeGreaterThan(0);
  });

  it('validateBackup detecta duplicados y campos ausentes', () => {
    const good = buildBackup(db);
    const dup: any = JSON.parse(JSON.stringify(good));
    dup.data.buttons = [...dup.data.buttons, { ...dup.data.buttons[0] }];
    const v = validateBackup(dup);
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.includes('duplicada'))).toBe(true);

    const missing: any = JSON.parse(JSON.stringify(good));
    missing.data.variables = [{ value: 1 }];
    expect(validateBackup(missing).valid).toBe(false);
  });

  it('buildBackup respeta sections y assets embeben contenido', () => {
    // Asset con fichero real.
    const dir = getAssetsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'logo.txt'), 'hola-assets');
    db.upsertAsset({ id: 'asset-1', path: 'logo.txt', hash: 'x', size: 11, created_at: Date.now() });

    const only = buildBackup(db, { sections: ['variables', 'assets'] });
    expect(Object.keys(only.data).sort()).toEqual(['assets', 'variables']);
    const a = only.data.assets.find((x: any) => x.id === 'asset-1');
    expect(a).toBeDefined();
    expect(typeof a.contentBase64).toBe('string');
    expect(Buffer.from(a.contentBase64, 'base64').toString()).toBe('hola-assets');
    expect(validateBackup(only).valid).toBe(true);
  });

  it('buildProfileBackup exporta solo el perfil, sus páginas, botones y assets referenciados', () => {
    const profile = db.createProfile({ id: 'prof-export-only', name: 'Perfil exportable', data: { theme: 'dark' } });
    db.createPage({
      id: 'page-export-only',
      profile_id: profile.id,
      name: 'Pantalla',
      order_idx: 0,
      is_folder: 0,
      data: {},
    } as any);
    db.createPage({
      id: 'folder-export-only',
      profile_id: profile.id,
      name: 'Carpeta',
      order_idx: 1,
      is_folder: 1,
      data: {},
    } as any);
    db.createButton({
      id: 'button-export-only',
      page_id: 'page-export-only',
      position: 0,
      data: { iconImage: '/assets/profile-export.png', label: 'Imagen' },
    } as any);
    const other = db.createProfile({ id: 'prof-not-exported', name: 'Otro perfil', data: {} });
    db.createPage({
      id: 'page-not-exported',
      profile_id: other.id,
      name: 'Otra pantalla',
      order_idx: 0,
      is_folder: 0,
      data: {},
    } as any);
    db.createButton({ id: 'button-not-exported', page_id: 'page-not-exported', position: 0, data: {} } as any);

    const assetsDir = getAssetsDir();
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'profile-export.png'), 'profile asset');
    fs.writeFileSync(path.join(assetsDir, 'unrelated-export.png'), 'unrelated asset');
    db.upsertAsset({ id: 'profile-asset', path: 'profile-export.png', hash: 'p', size: 13, created_at: Date.now() });
    db.upsertAsset({ id: 'unrelated-asset', path: 'unrelated-export.png', hash: 'u', size: 15, created_at: Date.now() });

    const backup = buildProfileBackup(db, profile.id)!;
    expect(validateBackup(backup).valid).toBe(true);
    expect(backup.data.profiles.map((p: any) => p.id)).toEqual([profile.id]);
    expect(backup.data.pages.map((p: any) => p.id).sort()).toEqual(['folder-export-only', 'page-export-only']);
    expect(backup.data.buttons.map((b: any) => b.id)).toEqual(['button-export-only']);
    expect(backup.data.assets.map((a: any) => a.id)).toEqual(['profile-asset']);
    expect(Buffer.from(backup.data.assets[0].contentBase64, 'base64').toString()).toBe('profile asset');
    expect(buildProfileBackup(db, 'missing-profile')).toBeNull();
  });
});

describe('backups: restore', () => {
  it('restore merge aplica cambios sin borrar lo existente', () => {
    seedAll('merge');
    const b: any = JSON.parse(JSON.stringify(buildBackup(db)));
    const prof = b.data.profiles.find((p: any) => p.id === 'prof-merge');
    prof.name = 'P merge RENOMBRADO';
    b.data.variables.push({ name: 'var_nueva', type: 'text', value: 'nueva', updated_at: Date.now() });
    const stages: string[] = [];
    const r = restoreBackup(db, b, {
      mode: 'merge',
      onProgress: (stage) => { stages.push(stage); },
    });
    expect(r.success).toBe(true);
    expect(r.mode).toBe('merge');
    expect(db.getProfile('prof-merge')?.name).toBe('P merge RENOMBRADO');
    expect(db.getVariable('var_nueva')?.value).toBe('nueva');
    // Lo previo sigue ahí.
    expect(db.getProfile('prof-base')).not.toBeNull();
    expect(stages[0]).toBe('started');
    expect(stages[stages.length - 1]).toBe('done');
  });

  it('restore selectivo solo toca las secciones pedidas', () => {
    const b: any = JSON.parse(JSON.stringify(buildBackup(db)));
    const w = b.data.widgets.find((x: any) => x.id === 'wid-base');
    w.name = 'W base TOCADO';
    const prof = b.data.profiles.find((p: any) => p.id === 'prof-base');
    prof.name = 'NO DEBERÍA APLICARSE';
    const r = restoreBackup(db, b, { sections: ['widgets'], mode: 'merge' });
    expect(r.sections).toEqual(['widgets']);
    expect(db.getWidget('wid-base')?.name).toBe('W base TOCADO');
    expect(db.getProfile('prof-base')?.name).not.toBe('NO DEBERÍA APLICARSE');
  });

  it('restore rechaza backups inválidos sin tocar la BD', () => {
    const before = db.getProfiles().length;
    expect(() => restoreBackup(db, { format: BACKUP_FORMAT, version: 999, data: {} })).toThrow(/no soportado/i);
    expect(() => restoreBackup(db, { format: 'x', version: 1, data: {} })).toThrow(/inválido/i);
    expect(db.getProfiles().length).toBe(before);
  });

  it('restore clean a instalación limpia deja solo lo del backup', () => {
    seedAll('clean');
    const partial: any = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      appVersion: 'test',
      createdAt: Date.now(),
      data: {
        profiles: [{ id: 'solo-1', name: 'Solo', created_at: 1, updated_at: 1, data: {} }],
        pages: [{ id: 'solo-p1', profile_id: 'solo-1', name: 'Única', order_idx: 0, is_folder: 0, data: {} }],
        buttons: [{ id: 'solo-b1', page_id: 'solo-p1', position: 3, data: { label: 'X' } }],
        widgets: [],
        flows: [],
        automations: [],
        variables: [],
        assets: [],
        plugins: [],
        settings: {},
      },
    };
    expect(validateBackup(partial).valid).toBe(true);
    const r = restoreBackup(db, partial, { mode: 'clean' });
    expect(r.success).toBe(true);
    expect(r.mode).toBe('clean');
    expect(db.getProfiles().map((p) => p.id)).toEqual(['solo-1']);
    expect(db.getPagesByProfile('solo-1').map((p) => p.id)).toEqual(['solo-p1']);
    expect(db.getButtonsByPage('solo-p1').map((b) => b.id)).toEqual(['solo-b1']);
    expect(db.getWidget('wid-clean')).toBeNull();
    expect(db.getFlow('flow-clean')).toBeNull();
  });
});
