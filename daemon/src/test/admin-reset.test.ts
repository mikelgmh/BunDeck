/**
 * admin-reset.test.ts — POST /api/v1/admin/reset (restablecimiento total).
 *
 * Cubre:
 *  - Sin { confirm: true } → 400 y la BD intacta.
 *  - Con confirmación → borra perfiles/páginas/botones/variables/ajustes/
 *    plugins externos y restaura la instalación fresca (perfil `default`
 *    con sus 5 páginas + plugins built-in).
 *  - Idempotente: dos resets seguidos nunca dejan la BD vacía.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-admin-reset-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;

import { initDatabase, DatabaseService } from '../db';
import { ensureDefaultProfile, DEFAULT_PROFILE_ID } from '../default-profile';
import { handleAdmin } from '../api/admin';

/**
 * La suite completa (`bun test`) corre con el mock in-memory global de
 * `action-runner.test.ts` (`mock.module('../db')` es global al proceso y las
 * exportaciones no mockeadas caen al módulo real): ahí `initDatabase` es
 * noop y `DatabaseService` se construye sin inicializar. Con sqlite real,
 * construir sin `initDatabase()` previo lanza 'Database not initialized'.
 * Los tests de reseteo real (wipe+reseed sobre sqlite) solo corren con DB
 * de verdad (fichero aislado); en suite se saltan sin ensuciar el mock
 * compartido (un `default.dismissed` residual rompería a page-grid).
 */
let hasRealDb = false;
try {
  // Sonda mock-vs-real (ver comentario arriba). A nivel superior: se evalúa
  // al cargar el fichero, antes de que `skipIf` la necesite. Con el mock
  // construye sin inicializar; con sqlite real lanza ('Database not
  // initialized'). Si un fichero anterior ya inicializó de verdad, la sonda
  // da mock (se salta: dirección segura, sigue en verde).
  new DatabaseService();
  hasRealDb = false;
} catch {
  hasRealDb = true;
}

let db: DatabaseService;
const services: any = {};

beforeAll(async () => {
  // bun importa TODOS los ficheros antes de ejecutar: re-fijar el data dir
  // aquí (patrón del resto de la suite) para no heredar el de otro fichero.
  process.env.LIBREDECK_DATA_DIR = TMP;
  await initDatabase();
  db = new DatabaseService();
  // Simula el arranque del daemon (initDatabase no crea el perfil).
  // Solo con DB real: en suite el mock es compartido y no se ensucia.
  if (hasRealDb) ensureDefaultProfile(db);
});

function ctx(path: string, method: string) {
  return {
    url: new URL(`http://localhost:3001${path}`),
    method,
    path,
    db,
    services,
  };
}

function postReset(body: unknown) {
  return handleAdmin(
    new Request('http://localhost:3001/api/v1/admin/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    ctx('/api/v1/admin/reset', 'POST'),
  );
}

function seedCustom(tag: string) {
  const p = db.createProfile({ id: `custom-${tag}`, name: `Custom ${tag}`, data: {} });
  db.createPage({ id: `custom-page-${tag}`, profile_id: p.id, name: 'Pantalla custom', order_idx: 0, is_folder: 0, data: {} } as any);
  db.createButton({ id: `custom-btn-${tag}`, page_id: `custom-page-${tag}`, position: 0, data: { label: 'X', actions: [] } } as any);
  db.setVariable(`custom_var_${tag}`, 'secreto', 'text');
  db.setSetting(`custom.key.${tag}`, '1');
  db.upsertPluginRecord({ id: `custom-plugin-${tag}`, name: 'Externo', version: '9.9.9', manifest: { id: `custom-plugin-${tag}` }, enabled: 1, source_type: 'zip' } as any);
}

describe('POST /api/v1/admin/reset', () => {
  it('sin confirm:true responde 400 sin tocar nada', async () => {
    seedCustom('noconfirm');
    const before = db.getProfiles().map((p) => p.id).sort();
    for (const bad of [{}, { confirm: false }, { confirm: 'true' }, null]) {
      const res = await postReset(bad);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);
      const body = await res!.json();
      expect(body.error).toBeDefined();
    }
    expect(db.getProfiles().map((p) => p.id).sort()).toEqual(before);
    expect(db.getProfile('custom-noconfirm')).not.toBeNull();
    expect(db.getVariable('custom_var_noconfirm')?.value).toBe('secreto');
  });

  it.skipIf(!hasRealDb)('con confirm:true borra todo y restaura la instalación fresca', async () => {
    seedCustom('doomed');
    // El usuario había borrado el default antes: el reset lo recrea igual.
    db.deleteProfile(DEFAULT_PROFILE_ID);
    db.setSetting('default.dismissed', '1');

    const res = await postReset({ confirm: true });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.success).toBe(true);
    expect(body.reset).toBe(true);
    expect(body.profileId).toBe(DEFAULT_PROFILE_ID);

    // Solo queda el perfil por defecto con sus 5 páginas semilla.
    const profiles = db.getProfiles();
    expect(profiles.map((p) => p.id)).toEqual([DEFAULT_PROFILE_ID]);
    const pageIds = db.getPagesByProfile(DEFAULT_PROFILE_ID).map((p) => p.id).sort();
    expect(pageIds).toEqual(
      ['default-page-deck', 'default-page-libre', 'default-page-mini', 'default-page-neo', 'default-page-xl'].sort()
    );
    // Las páginas semilla traen botones (nunca BD vacía).
    let buttons = 0;
    for (const pg of db.getPagesByProfile(DEFAULT_PROFILE_ID)) {
      buttons += db.getButtonsByPage(pg.id).length;
    }
    expect(buttons).toBeGreaterThan(0);
    expect(body.buttons).toBe(buttons);

    // Rastros custom eliminados.
    expect(db.getProfile('custom-doomed')).toBeNull();
    expect(db.getProfile('custom-noconfirm')).toBeNull();
    expect(db.getVariable('custom_var_doomed')).toBeNull();
    expect(db.getSetting('custom.key.doomed')).toBeNull();
    expect(db.getSetting('default.dismissed')).toBeNull();
    expect(db.getPlugin('custom-plugin-doomed' as string)).toBeNull();
    expect(db.getSetting('current.profile_id')).toBe(DEFAULT_PROFILE_ID);

    // Plugins built-in presentes y activados; externos fuera.
    const plugins = db.getPlugins();
    expect(plugins.length).toBeGreaterThan(10);
    expect(plugins.some((p) => p.id === 'shell')).toBe(true);
    expect(plugins.every((p) => (p as any).source_type === 'builtin')).toBe(true);
    expect(body.plugins).toBe(plugins.length);
  });

  it.skipIf(!hasRealDb)('es idempotente: dos resets seguidos dejan instalación fresca', async () => {
    const first = await (await postReset({ confirm: true }))!.json();
    const second = await (await postReset({ confirm: true }))!.json();
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(db.getProfiles().map((p) => p.id)).toEqual([DEFAULT_PROFILE_ID]);
    expect(db.getPagesByProfile(DEFAULT_PROFILE_ID)).toHaveLength(5);
    expect(db.getPlugins().length).toBeGreaterThan(10);
  });
});
