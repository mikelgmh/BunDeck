/**
 * catalog.test.ts — catálogo local de plugins (offline).
 * Sin DB ni red: catalog.ts solo usa getNativeManifests() + validator.
 */
import { describe, it, expect } from 'bun:test';
import {
  buildCatalog,
  getCatalog,
  getCatalogEntry,
  searchCatalog,
  isCompatible,
  inferCategory,
  extractKeywords,
  manifestChecksum,
  stableStringify,
  verifyCatalogChecksum,
  invalidateCatalog,
  CATALOG_CATEGORIES,
} from '../catalog';
import { getNativeManifests } from '../plugins/index';
import { validateManifest } from '../plugin-system/validator';

describe('catalog: índice local', () => {
  it('genera una entrada por manifest nativo con todos los campos', () => {
    const manifests = getNativeManifests();
    expect(manifests.length).toBeGreaterThan(0);
    const entries = buildCatalog();
    expect(entries).toHaveLength(manifests.length);
    for (const e of entries) {
      expect(typeof e.id).toBe('string');
      expect(e.id.length).toBeGreaterThan(0);
      expect(typeof e.name).toBe('string');
      expect(typeof e.version).toBe('string');
      expect(typeof e.description).toBe('string');
      expect(typeof e.author).toBe('string');
      expect(CATALOG_CATEGORIES).toContain(e.category as never);
      expect(e.type).toBe('builtin');
      expect(Array.isArray(e.permissions)).toBe(true);
      expect(Array.isArray(e.actions)).toBe(true);
      expect(e.actions.length).toBeGreaterThan(0);
      for (const a of e.actions) {
        expect(typeof a.id).toBe('string');
        expect(typeof a.name).toBe('string');
      }
      expect(Array.isArray(e.compatibility.os)).toBe(true);
      expect(typeof e.compatibility.minVersion).toBe('string');
      expect(Array.isArray(e.keywords)).toBe(true);
      expect(e.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('cachea el índice y lo reconstruye con force / invalidate', () => {
    const first = getCatalog();
    const second = getCatalog();
    expect(second.entries).toBe(first.entries); // misma referencia: caché
    const rebuilt = getCatalog(true);
    expect(rebuilt.entries).not.toBe(first.entries);
    expect(rebuilt.entries).toHaveLength(first.entries.length);
    invalidateCatalog();
    const after = getCatalog();
    expect(after.entries).not.toBe(rebuilt.entries);
    expect(after.entries).toHaveLength(rebuilt.entries.length);
  });

  it('getCatalogEntry devuelve la entrada o null', () => {
    const obs = getCatalogEntry('obs');
    expect(obs).not.toBeNull();
    expect(obs!.name).toBe('OBS Studio');
    expect(getCatalogEntry('no-existe-xyz')).toBeNull();
  });
});

describe('catalog: búsqueda y filtros', () => {
  const entries = buildCatalog();

  it('?q= busca por id/nombre/descripción/acción (insensible a mayúsculas)', () => {
    const byId = searchCatalog(entries, { q: 'OBS' });
    expect(byId.some((e) => e.id === 'obs')).toBe(true);
    const byAction = searchCatalog(entries, { q: 'repetición' });
    expect(byAction.some((e) => e.id === 'obs')).toBe(true);
    const multi = searchCatalog(entries, { q: 'home assistant luz' });
    expect(multi.some((e) => e.id === 'homeassistant')).toBe(true);
    expect(searchCatalog(entries, { q: 'zzz-sin-resultados' })).toHaveLength(0);
  });

  it('?q= vacía devuelve todo', () => {
    expect(searchCatalog(entries, { q: '  ' })).toHaveLength(entries.length);
    expect(searchCatalog(entries, {})).toHaveLength(entries.length);
  });

  it('?category= filtra por categoría conocida', () => {
    for (const cat of CATALOG_CATEGORIES) {
      const found = searchCatalog(entries, { category: cat });
      for (const e of found) expect(e.category).toBe(cat);
    }
    expect(searchCatalog(entries, { category: 'inexistente' })).toHaveLength(0);
    // case-insensitive
    expect(searchCatalog(entries, { category: 'SYSTEM' })).toEqual(
      searchCatalog(entries, { category: 'system' })
    );
  });

  it('?compatible= filtra por compatibilidad con la versión dada', () => {
    // Entrada sintética con minVersion futura → incompatible con 1.0.0
    const future = { ...entries[0], id: 'futuro', compatibility: { os: ['win32'], minVersion: '99.0.0' } };
    const withFuture = [...entries, future];
    const onlyCompat = searchCatalog(withFuture, { compatible: true, appVersion: '1.0.0' });
    expect(onlyCompat.some((e) => e.id === 'futuro')).toBe(false);
    const onlyIncompat = searchCatalog(withFuture, { compatible: false, appVersion: '1.0.0' });
    // 'futuro' es incompatible; también lo son los nativos con engine ^1.5.0
    expect(onlyIncompat.some((e) => e.id === 'futuro')).toBe(true);
    for (const e of onlyIncompat) expect(isCompatible(e, '1.0.0')).toBe(false);
    for (const e of onlyCompat) expect(isCompatible(e, '1.0.0')).toBe(true);
  });

  it('combina q + category', () => {
    const found = searchCatalog(entries, { q: 'luz', category: 'integrations' });
    expect(found.some((e) => e.id === 'homeassistant')).toBe(true);
    for (const e of found) expect(e.category).toBe('integrations');
  });
});

describe('catalog: validación de manifiesto', () => {
  it('todos los nativos pasan validateManifest', () => {
    for (const m of getNativeManifests()) {
      const r = validateManifest(m);
      expect({ id: m.id, errors: r.errors }).toEqual({ id: m.id, errors: [] });
    }
  });

  it('detecta campos requeridos, permisos y semver', () => {
    const badId = validateManifest({ id: 'MAL ID!!', name: 'X', version: '1.0.0', permissions: [], actions: [] });
    expect(badId.valid).toBe(false);
    expect(badId.errors.join(' ')).toMatch(/id/i);

    const badName = validateManifest({ id: 'ok-id', name: '', version: '1.0.0', permissions: [], actions: [] });
    expect(badName.valid).toBe(false);

    const badSemver = validateManifest({ id: 'ok-id', name: 'Ok', version: '1.0', permissions: [], actions: [] });
    expect(badSemver.valid).toBe(false);
    expect(badSemver.errors.join(' ')).toMatch(/semver/i);

    const badPerm = validateManifest({ id: 'ok-id', name: 'Ok', version: '1.0.0', permissions: ['root-access'], actions: [] });
    expect(badPerm.valid).toBe(false);
    expect(badPerm.errors.join(' ')).toMatch(/root-access/);

    const badActions = validateManifest({ id: 'ok-id', name: 'Ok', version: '1.0.0', permissions: [] });
    expect(badActions.valid).toBe(false);
    expect(badActions.errors.join(' ')).toMatch(/actions/);
  });

  it('avisa con permisos privilegiados (shell/system)', () => {
    const r = validateManifest({ id: 'sh', name: 'Sh', version: '1.0.0', permissions: ['shell'], actions: [] });
    expect(r.valid).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('la entrada del catálogo expone el resultado de validación', () => {
    const obs = getCatalogEntry('obs')!;
    expect(obs.validation.valid).toBe(true);
    expect(obs.validation.errors).toEqual([]);
  });
});

describe('catalog: integridad sha256', () => {
  it('checksum estable e independiente del orden de claves', () => {
    const a = { id: 'x', name: 'X', version: '1.0.0' };
    const b = { version: '1.0.0', id: 'x', name: 'X' };
    expect(manifestChecksum(a)).toBe(manifestChecksum(b));
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('cambia si cambia el manifest', () => {
    const base = getCatalogEntry('obs')!;
    const live = getNativeManifests().find((m: any) => m?.id === 'obs')!;
    const altered = { ...live, version: '9.9.9' };
    expect(manifestChecksum(altered)).not.toBe(base.checksum);
  });

  it('verifyCatalogChecksum valida contra el manifest vivo', () => {
    const entry = getCatalogEntry('shell')!;
    const live = getNativeManifests().find((m: any) => m?.id === 'shell')!;
    const ok = verifyCatalogChecksum(entry, live);
    expect(ok).toMatchObject({ id: 'shell', algorithm: 'sha256', valid: true });
    expect(ok.sha256).toBe(entry.checksum);
    const tampered = verifyCatalogChecksum(entry, { ...live, description: 'manipulado' });
    expect(tampered.valid).toBe(false);
  });
});

describe('catalog: compatibilidad e inferencia', () => {
  it('isCompatible respeta minVersion/engine', () => {
    const base = getCatalogEntry('obs')!;
    // obs declara engine ^1.5.0: compatible con 1.5.x, no con 0.1.0
    expect(isCompatible(base, '1.5.0')).toBe(true);
    expect(isCompatible(base, '0.1.0')).toBe(false);
    expect(
      isCompatible({ compatibility: { os: ['win32'], minVersion: '>=2.0.0' } }, '1.0.0')
    ).toBe(false);
    expect(
      isCompatible({ compatibility: { os: ['win32'], minVersion: '>=2.0.0' } }, '2.5.1')
    ).toBe(true);
  });

  it('inferCategory cubre todos los nativos sin "utility" por defecto salvo page/utility', () => {
    const entries = buildCatalog();
    const byId = new Map(entries.map((e) => [e.id, e.category]));
    expect(byId.get('obs')).toBe('integrations');
    expect(byId.get('shell')).toBe('system');
    expect(byId.get('hotkey')).toBe('input');
    expect(byId.get('browser')).toBe('media');
    expect(byId.get('page')).toBe('utility');
  });

  it('extractKeywords incluye id, permisos y categoría', () => {
    const kws = extractKeywords({ id: 'obs', name: 'OBS Studio', description: 'Controla escenas', permissions: ['network'], actions: [] });
    expect(kws).toContain('obs');
    expect(kws).toContain('network');
    expect(inferCategory({ id: 'obs', permissions: ['network'] })).toBe('integrations');
  });
});
