/**
 * streamdeck-import.test.ts — importación de perfiles Stream Deck (Elgato).
 *
 * Cubre: detect solo-lectura (win/mac/linux + carpeta ausente),
 * DeviceType → grid (Mini/MK2…), parser tolerante (objeto "col,row" y
 * array con Coordinates), mapper en 3 cubos (nativo/bridge/placeholder),
 * import con dryRun (no toca la BD) e import real (perfil nuevo con
 * sufijo «(importado)», IDs nuevos, placeholders, sin bloquear).
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-sdimport-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;

import { initDatabase, DatabaseService } from '../db';
import {
  detectStreamDeckProfiles,
  streamDeckBaseDir,
} from '../streamdeck/detect';
import {
  buildImportPlan,
  deviceGridFor,
  importStreamDeckProfile,
  mapSDAction,
  parseProfileManifest,
  uniqueImportedName,
} from '../streamdeck/profile-import';

let db: DatabaseService;

beforeAll(async () => {
  process.env.LIBREDECK_DATA_DIR = TMP;
  await initDatabase();
  db = new DatabaseService();
});

// --- Fixtures ---------------------------------------------------------------

function hotkeyEntry(title: string) {
  return {
    Name: 'Hotkey',
    UUID: 'com.elgato.streamdeck.system.hotkey',
    Settings: { hotkey: 'ctrl+c', Title: title },
    State: 0,
    States: [{ Title: title, Image: null }],
  };
}

function sdManifest(deviceType: number | string, actions: Record<string, any>, name = 'Demo SD', uuid = 'uuid-demo') {
  return { DeviceUUID: uuid, Name: name, DeviceType: deviceType, Actions: actions };
}

/** Crea un .streamDeckProfile de ejemplo (Mini o clásico) en temp. */
async function makeProfileZip(tag: string, deviceType: number | string): Promise<string> {
  const { default: AdmZip } = await import('adm-zip');
  const zip = new AdmZip();
  const childUuid = `child-${tag}`;
  zip.addFile(
    'Profiles/demo-uuid/Manifest.json',
    Buffer.from(JSON.stringify(sdManifest(deviceType, {
      '0,0': hotkeyEntry('Copiar'),
      '1,0': {
        Name: 'Website', UUID: 'com.elgato.streamdeck.system.website',
        Settings: { url: 'https://example.com', Title: 'Web' },
        State: 0, States: [{ Title: 'Web' }],
      },
      '2,0': {
        Name: 'Cosa rara', UUID: 'com.f lansis.unknown.do',
        Settings: { Title: 'Rara' }, State: 0, States: [{ Title: 'Rara' }],
      },
      '0,1': {
        Name: 'Carpeta', UUID: 'com.elgato.streamdeck.profile.openchild',
        Settings: { ProfileUUID: childUuid, Title: 'Juegos' },
        State: 0, States: [{ Title: 'Juegos' }],
      },
      '1,1': {
        Name: 'Multi', UUID: 'com.elgato.streamdeck.profile.multiaction',
        Settings: {
          Actions: [
            { UUID: 'com.elgato.streamdeck.system.hotkey', Settings: { hotkey: 'ctrl+v' } },
            { UUID: 'com.desconocido.otro', Settings: {} },
          ],
        },
        State: 0, States: [{ Title: 'Multi' }],
      },
    })), 'utf8'),
  );
  zip.addFile(
    `Profiles/${childUuid}/Manifest.json`,
    Buffer.from(JSON.stringify(sdManifest(deviceType, { '0,0': hotkeyEntry('Pegar') }, 'Juegos', childUuid))),
    'utf8',
  );
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ Name: 'Demo SD' })), 'utf8');
  const out = path.join(TMP, `demo-${tag}.streamDeckProfile`);
  zip.writeZip(out);
  return out;
}

// --- detect -----------------------------------------------------------------

describe('streamdeck: detect solo-lectura', () => {
  it('win32 usa %APPDATA%/Elgato/StreamDeck/ProfilesV2', () => {
    expect(streamDeckBaseDir('win32', { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' } as any))
      .toBe(path.join('C:\\Users\\x\\AppData\\Roaming', 'Elgato', 'StreamDeck', 'ProfilesV2'));
  });

  it('macOS usa ~/Library/…/com.elgato.StreamDeck', () => {
    expect(streamDeckBaseDir('darwin', { HOME: '/Users/x' } as any))
      .toBe(path.join('/Users/x', 'Library', 'Application Support', 'com.elgato.StreamDeck'));
  });

  it('linux no tiene carpetas Elgato → null y []', () => {
    expect(streamDeckBaseDir('linux', {} as any)).toBeNull();
    expect(detectStreamDeckProfiles({ platform: 'linux', env: {} as any })).toEqual([]);
  });

  it('carpeta ausente → [] sin lanzar', () => {
    expect(detectStreamDeckProfiles({ baseDir: path.join(TMP, 'no-existe') })).toEqual([]);
  });

  it('escanea perfiles sin escribir en la carpeta Elgato', () => {
    const base = path.join(TMP, 'fake-ProfilesV2');
    for (const [uuid, name] of [['uuid-1', 'Principal'], ['uuid-2', 'Juegos']]) {
      const dir = path.join(base, uuid);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ Name: name, DeviceType: 0 }));
    }
    const before = fs.readdirSync(base).sort();
    const found = detectStreamDeckProfiles({ baseDir: base });
    expect(found.map((p) => p.name).sort()).toEqual(['Juegos', 'Principal']);
    expect(found[0].source).toBe('profilesv2');
    // Solo lectura: ni un fichero más, ni un fichero menos.
    expect(fs.readdirSync(base).sort()).toEqual(before);
    for (const p of found) {
      expect(fs.readdirSync(p.path)).toEqual(['manifest.json']);
    }
  });
});

// --- grid + parser ----------------------------------------------------------

describe('streamdeck: grid y parser', () => {
  it('DeviceType numérico y por nombre', () => {
    expect(deviceGridFor(0)).toMatchObject({ cols: 5, rows: 3, known: true });
    expect(deviceGridFor(1)).toMatchObject({ cols: 3, rows: 2, known: true });
    expect(deviceGridFor(2)).toMatchObject({ cols: 8, rows: 4, known: true });
    expect(deviceGridFor('Stream Deck Mini')).toMatchObject({ cols: 3, rows: 2, known: true });
    expect(deviceGridFor('Stream Deck XL')).toMatchObject({ cols: 8, rows: 4, known: true });
    expect(deviceGridFor(999)).toMatchObject({ cols: 5, rows: 3, known: false });
    expect(deviceGridFor(null)).toMatchObject({ cols: 5, rows: 3, known: false });
  });

  it('parsea Actions como objeto "col,row" y como array con Coordinates', () => {
    const objForm = parseProfileManifest(
      sdManifest(0, { '2,1': hotkeyEntry('A') }), 'X', 'u1',
    );
    expect(objForm.grid).toMatchObject({ cols: 5, rows: 3 });
    expect(objForm.actions).toHaveLength(1);
    expect(objForm.actions[0]).toMatchObject({ col: 2, row: 1, title: 'A' });

    const arrForm = parseProfileManifest(
      { Name: 'Y', DeviceType: 1, Actions: [{ Coordinates: { Column: 1, Row: 0 }, ...hotkeyEntry('B') }] },
      'Y', 'u2',
    );
    expect(arrForm.grid).toMatchObject({ cols: 3, rows: 2 });
    expect(arrForm.actions[0]).toMatchObject({ col: 1, row: 0, title: 'B' });
  });

  it('detecta carpetas por UUID y por ProfileUUID en settings', () => {
    const p = parseProfileManifest(
      sdManifest(0, {
        '0,0': { UUID: 'com.elgato.streamdeck.profile.openchild', Settings: { ProfileUUID: 'hijo-1' }, States: [{ Title: 'F' }] },
      }), 'Z', 'u3',
    );
    expect(p.actions[0].isFolder).toBe(true);
    expect(p.actions[0].folderTarget).toBe('hijo-1');
  });
});

// --- mapper -----------------------------------------------------------------

describe('streamdeck: mapper en 3 cubos', () => {
  it('nativo 1:1 (hotkey, web, multimedia)', () => {
    const m = mapSDAction(
      { key: '0,0', col: 0, row: 0, uuid: 'com.elgato.streamdeck.system.hotkey', settings: { hotkey: 'ctrl+c' }, title: 'C', image: null, isFolder: false, folderTarget: null, children: [] },
    );
    expect(m.bucket).toBe('native');
    expect(m.action).toEqual({ type: 'hotkey.hotkey', parameters: { keys: 'ctrl+c' } });
  });

  it('bridge x-elgato cuando el plugin ya está instalado', () => {
    const installed = new Set(['com.ejemplo.plug.accion']);
    const m = mapSDAction(
      { key: '0,0', col: 0, row: 0, uuid: 'com.ejemplo.plug.accion', settings: { k: 1 }, title: 'P', image: null, isFolder: false, folderTarget: null, children: [] },
      installed,
    );
    expect(m.bucket).toBe('bridge');
    expect(m.action.type).toBe('com.ejemplo.plug.accion');
    expect(m.action.parameters).toEqual({ settings: { k: 1 } });
  });

  it('resto → placeholder con nota (nunca bloquea)', () => {
    const m = mapSDAction(
      { key: '0,0', col: 0, row: 0, uuid: 'com.raro.sin.equivalente', settings: {}, title: 'Rara', image: null, isFolder: false, folderTarget: null, children: [] },
    );
    expect(m.bucket).toBe('placeholder');
    expect(m.action.type).toBe('flow.log');
    expect(m.note).toContain('Rara');
  });

  it('MultiAction → multiaction.run-sequence con pasos no importables como log', () => {
    const m = mapSDAction({
      key: '0,0', col: 0, row: 0, uuid: 'com.elgato.streamdeck.profile.multiaction',
      settings: {}, title: 'Multi', image: null, isFolder: false, folderTarget: null,
      children: [
        { key: 's0', col: -1, row: -1, uuid: 'com.elgato.streamdeck.system.hotkey', settings: { hotkey: 'a' }, title: null, image: null, isFolder: false, folderTarget: null, children: [] },
        { key: 's1', col: -1, row: -1, uuid: 'com.raro.x', settings: {}, title: null, image: null, isFolder: false, folderTarget: null, children: [] },
      ],
    });
    expect(m.bucket).toBe('native');
    expect(m.action.type).toBe('multiaction.run-sequence');
    expect(m.action.parameters.actions).toHaveLength(2);
    expect(m.action.parameters.actions[1].type).toBe('flow.log');
  });
});

// --- import -----------------------------------------------------------------

describe('streamdeck: import', () => {
  it('dryRun calcula el plan sin tocar la BD', async () => {
    const zip = await makeProfileZip('dry', 0);
    const before = db.getProfiles().length;
    const stages: string[] = [];
    const plan = await importStreamDeckProfile(db, { zipPath: zip }, {
      dryRun: true,
      onProgress: (stage) => { stages.push(stage); },
    });
    expect(plan.dryRun).toBe(true);
    expect(plan.profileId).toBeNull();
    expect(plan.counts.buttons).toBe(6); // 5 + 1 del sub-perfil
    expect(plan.counts.native).toBeGreaterThanOrEqual(3);
    expect(plan.counts.placeholder).toBeGreaterThanOrEqual(1);
    expect(db.getProfiles().length).toBe(before);
    expect(stages[0]).toBe('started');
    expect(stages[stages.length - 1]).toBe('done');
  });

  it('import crea perfil nuevo «(importado)» con páginas, botones y placeholders', async () => {
    const zip = await makeProfileZip('full', 0);
    const res = await importStreamDeckProfile(db, { zipPath: zip }, { dryRun: false });
    expect(res.dryRun).toBe(false);
    expect(res.profileName).toBe('Demo SD (importado)');
    const profile = db.getProfile(res.profileId!);
    expect(profile).not.toBeNull();
    // Trazabilidad sin settings opacos a la vista.
    const pdata = typeof profile!.data === 'string' ? JSON.parse(profile!.data) : profile!.data;
    expect(pdata['x-streamdeck'].sourceName).toBe('Demo SD');

    const pages = db.getPagesByProfile(res.profileId!);
    expect(pages.length).toBe(2);
    const root = pages.find((p) => p.is_folder === 0)!;
    const buttons = db.getButtonsByPage(root.id);
    expect(buttons.length).toBe(5);
    // Nativo con parámetros reales.
    const hotkey = buttons.find((b) => (b.data as any).label === 'Copiar');
    expect((hotkey!.data as any).actions[0]).toEqual({ type: 'hotkey.hotkey', parameters: { keys: 'ctrl+c' } });
    // Placeholder con nota y settings opacos conservados.
    const rare = buttons.find((b) => (b.data as any).label === 'Rara');
    expect((rare!.data as any).actions[0].type).toBe('flow.log');
    expect((rare!.data as any)['x-streamdeck'].bucket).toBe('placeholder');
    expect((rare!.data as any)['x-streamdeck'].note).toContain('Rara');
    // Carpeta → page.page al sub-perfil.
    const folder = buttons.find((b) => (b.data as any).label === 'Juegos');
    expect((folder!.data as any).actions[0].type).toBe('page.page');
  });

  it('segunda importación no colisiona: «(importado 2)» con IDs nuevos', async () => {
    const firstId = db.getProfiles().find((p) => p.name === 'Demo SD (importado)')!.id;
    const before = db.getButtonsByPage(db.getPagesByProfile(firstId)[0].id).length;
    expect(before).toBeGreaterThan(0);
    const zip = await makeProfileZip('full', 0);
    const res = await importStreamDeckProfile(db, { zipPath: zip }, { dryRun: false });
    expect(res.profileName).toBe('Demo SD (importado 2)');
    expect(res.profileId).not.toBeNull();
    expect(uniqueImportedName(db, 'Demo SD')).toBe('Demo SD (importado 3)');
  });

  it('Mini (DeviceType 1) usa rejilla 3×2', async () => {
    const zip = await makeProfileZip('mini', 1);
    const res = await importStreamDeckProfile(db, { zipPath: zip }, { dryRun: true });
    expect(res.profiles[0].grid).toMatchObject({ cols: 3, rows: 2 });
  });

  it('zip sin Manifest válido → error sin tocar la BD', async () => {
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip();
    zip.addFile('nada.txt', Buffer.from('hola', 'utf8'));
    const out = path.join(TMP, 'vacio.streamDeckProfile');
    zip.writeZip(out);
    const before = db.getProfiles().length;
    await expect(importStreamDeckProfile(db, { zipPath: out }, { dryRun: true })).rejects.toThrow(/Manifest/i);
    expect(db.getProfiles().length).toBe(before);
  });
});
