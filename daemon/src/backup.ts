/**
 * Backups completos de LibreDeck: perfiles + carpetas (pages con
 * is_folder) + widgets + flows + automatizaciones + variables + assets
 * (metadatos + contenido) + plugins (registros) + settings.
 *
 * Formato versionado:
 *   { format: 'libredeck-backup', version: 1, appVersion, createdAt, data: {...} }
 *
 * - buildBackup(db, { sections? }): construye el objeto backup.
 * - validateBackup(obj): validación pre-restore (tipos, refs, duplicados).
 * - restoreBackup(db, backup, { sections?, mode, onProgress }): restore
 *   selectivo ('merge' = upsert) o a instalación limpia ('clean' = vacía
 *   las secciones pedidas antes de importar). Progreso vía onProgress.
 */
import { DatabaseService } from './db';
import { checkPageCompatibility } from './devices';
import { getAssetsDir } from './paths';
import { getVersion } from './version';
// Solo para invalidar la caché del store tras un restore (escribe a BD
// directamente y el store memoiza por versión; sin esto, resolved() seguiría
// devolviendo valores pre-restore hasta la próxima escritura).
import { getVariableStore } from './variables/store';

export const BACKUP_FORMAT = 'libredeck-backup';
export const BACKUP_VERSION = 1;

export const BACKUP_SECTIONS = [
  'profiles',
  'pages',
  'buttons',
  'widgets',
  'flows',
  'automations',
  'variables',
  'assets',
  'plugins',
  'settings',
  'devices',
  'assignments',
] as const;

export type BackupSection = (typeof BACKUP_SECTIONS)[number];
export type RestoreMode = 'merge' | 'clean';

export interface BackupObject {
  format: string;
  version: number;
  appVersion: string;
  createdAt: number;
  data: Record<string, any>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  info: {
    format: string;
    version: number;
    appVersion?: string;
    createdAt?: number;
    sections: string[];
    counts: Record<string, number>;
  };
}

export interface RestoreOptions {
  sections?: string[];
  mode?: RestoreMode;
  onProgress?: (stage: string, done: number, total: number, message: string) => void;
}

export interface RestoreResult {
  success: boolean;
  mode: RestoreMode;
  sections: string[];
  restored: Record<string, number>;
  warnings: string[];
}

const MAX_ASSET_BYTES = 5 * 1024 * 1024;

function isObj(v: any): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parseMaybeJson(v: any): any {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

function assetEntries(db: DatabaseService, referencedPaths?: Set<string>): any[] {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  return db.listAssets()
    .filter((asset) => {
      if (!referencedPaths) return true;
      const filename = path.basename(asset.path.replace(/\\/g, '/'));
      return referencedPaths.has(filename);
    })
    .map((a) => {
      const entry: any = { ...a, contentBase64: null as string | null };
      try {
        const full = path.isAbsolute(a.path) ? a.path : path.join(getAssetsDir(), a.path);
        if (fs.existsSync(full)) {
          const st = fs.statSync(full);
          if (st.size <= MAX_ASSET_BYTES) {
            entry.contentBase64 = fs.readFileSync(full).toString('base64');
          } else {
            entry._skipped = `asset demasiado grande (${st.size} bytes, límite ${MAX_ASSET_BYTES})`;
          }
        } else {
          entry._skipped = 'fichero ausente en disco';
        }
      } catch (e) {
        entry._skipped = e instanceof Error ? e.message : String(e);
      }
      return entry;
    });
}

function collectAssetPaths(value: any, paths: Set<string>, seen = new Set<object>()): void {
  if (typeof value === 'string') {
    const match = value.match(/^\/assets\/([^/?#]+)(?:[?#].*)?$/);
    if (match) paths.add(match[1]);
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectAssetPaths(item, paths, seen);
    return;
  }
  for (const item of Object.values(value)) collectAssetPaths(item, paths, seen);
}

/** Construye el backup completo (o solo `sections`). */
export function buildBackup(db: DatabaseService, opts?: { sections?: string[] }): BackupObject {
  const want = new Set(opts?.sections ?? [...BACKUP_SECTIONS]);
  const data: Record<string, any> = {};

  if (want.has('profiles')) {
    data.profiles = db.getProfiles().map((p) => ({ ...p, data: parseMaybeJson((p as any).data) }));
  }
  if (want.has('pages')) {
    const profiles = db.getProfiles();
    const pages: any[] = [];
    for (const p of profiles) {
      for (const pg of db.getPagesByProfile(p.id)) {
        pages.push({ ...(pg as any), data: parseMaybeJson((pg as any).data) });
      }
    }
    data.pages = pages;
  }
  if (want.has('buttons')) {
    const profiles = db.getProfiles();
    const buttons: any[] = [];
    for (const p of profiles) {
      for (const pg of db.getPagesByProfile(p.id)) {
        for (const b of db.getButtonsByPage(pg.id)) buttons.push(b);
      }
    }
    // Botones huérfanos (página borrada sin cascada): también se exportan.
    data.buttons = buttons;
  }
  if (want.has('widgets')) data.widgets = db.listWidgets();
  if (want.has('flows')) data.flows = db.listFlows();
  if (want.has('automations')) data.automations = db.listAutomations();
  if (want.has('variables')) data.variables = db.listVariables();
  // Filas completas (todos los scopes: global/widget/script/automation)
  // para que el backup sea total. Las globales simples van en `data.variables`
  // (formato MCP); las scoped, en `data.variable_rows` (formato crudo).
  if (want.has('variables')) {
    try {
      const all = db.listVariableRows();
      const scoped = all.filter((r: any) => r.scope !== 'global' || r.scope_id !== '');
      if (scoped.length) data.variable_rows = scoped;
    } catch { /* tabla ausente en DBs muy antiguas: noop */ }
  }

  if (want.has('assets')) {
    data.assets = assetEntries(db);
  }
  if (want.has('plugins')) {
    data.plugins = db.getPlugins().map((p: any) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      manifest: p.manifest,
      enabled: p.enabled,
      installed_at: p.installed_at,
      updated_at: p.updated_at ?? null,
      source_type: p.source_type ?? null,
      origin: p.origin ?? null,
      ref: p.ref ?? null,
      commit: p.commit ?? (p as any).commit_sha ?? null,
      checksum: p.checksum ?? null,
      status: p.status ?? null,
      last_error: p.last_error ?? null,
      previous_version: p.previous_version ?? null,
      previous_manifest: p.previous_manifest ?? null,
    }));
  }
  if (want.has('settings')) {
    data.settings = db.getAllSettings();
  }
  if (want.has('devices')) {
    data.devices = db.listDevices();
  }
  if (want.has('assignments')) {
    data.assignments = db.listAllAssignments();
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion: safeVersion(),
    createdAt: Date.now(),
    data,
  };
}

/** Exportación portable de un perfil con sus pantallas, botones y assets usados. */
export function buildProfileBackup(db: DatabaseService, profileId: string): BackupObject | null {
  const profile = db.getProfile(profileId);
  if (!profile) return null;

  const pages = db.getPagesByProfile(profileId).map((page) => ({
    ...page,
    data: parseMaybeJson((page as any).data),
  }));
  const pageIds = new Set(pages.map((page) => page.id));
  const buttons = pages.flatMap((page) => db.getButtonsByPage(page.id));
  const normalizedProfile = { ...profile, data: parseMaybeJson((profile as any).data) };

  const referencedPaths = new Set<string>();
  collectAssetPaths(normalizedProfile, referencedPaths);
  collectAssetPaths(pages, referencedPaths);
  collectAssetPaths(buttons, referencedPaths);

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion: safeVersion(),
    createdAt: Date.now(),
    data: {
      profiles: [normalizedProfile],
      pages,
      buttons: buttons.filter((button) => pageIds.has(button.page_id)),
      assets: assetEntries(db, referencedPaths),
    },
  };
}

function safeVersion(): string {
  try { return getVersion(); } catch { return '0.0.0'; }
}

/** Validación pre-restore: no toca la BD. */
export function validateBackup(obj: any): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const counts: Record<string, number> = {};

  if (!isObj(obj)) {
    return { valid: false, errors: ['Backup vacío o no es un objeto JSON'], warnings, info: { format: '', version: 0, sections: [], counts } };
  }
  if (obj.format !== BACKUP_FORMAT) errors.push(`format inválido: ${JSON.stringify(obj.format)} (esperado ${JSON.stringify(BACKUP_FORMAT)})`);
  if (typeof obj.version !== 'number') {
    errors.push('version ausente o no numérica');
  } else if (obj.version !== BACKUP_VERSION) {
    if (obj.version > BACKUP_VERSION) errors.push(`Backup versión ${obj.version} no soportado (máx ${BACKUP_VERSION})`);
    else warnings.push(`Backup versión ${obj.version} < actual ${BACKUP_VERSION}: se migrará lo posible`);
  }
  if (!isObj(obj.data)) errors.push('data ausente o no es un objeto');

  const data = isObj(obj.data) ? obj.data : {};
  const sections = Object.keys(data);
  for (const s of sections) {
    if (!(BACKUP_SECTIONS as readonly string[]).includes(s)) warnings.push(`Sección desconocida ignorada: ${s}`);
  }

  const profileIds = new Set<string>();
  if (data.profiles !== undefined) {
    if (!Array.isArray(data.profiles)) errors.push('profiles debe ser un array');
    else {
      counts.profiles = data.profiles.length;
      data.profiles.forEach((p: any, i: number) => {
        if (!isObj(p) || !p.id || !p.name) { errors.push(`profiles[${i}]: id y name requeridos`); return; }
        if (profileIds.has(p.id)) errors.push(`profiles[${i}]: id duplicado ${JSON.stringify(p.id)}`);
        profileIds.add(p.id);
      });
    }
  }
  const pageIds = new Set<string>();
  if (data.pages !== undefined) {
    if (!Array.isArray(data.pages)) errors.push('pages debe ser un array');
    else {
      counts.pages = data.pages.length;
      data.pages.forEach((pg: any, i: number) => {
        if (!isObj(pg) || !pg.id || !pg.profile_id || !pg.name) { errors.push(`pages[${i}]: id, profile_id y name requeridos`); return; }
        if (pageIds.has(pg.id)) errors.push(`pages[${i}]: id duplicado ${JSON.stringify(pg.id)}`);
        pageIds.add(pg.id);
        if (profileIds.size > 0 && !profileIds.has(pg.profile_id)) {
          warnings.push(`pages[${i}]: profile_id ${JSON.stringify(pg.profile_id)} no está en profiles (merge lo creará si la BD lo tiene)`);
        }
      });
    }
  }
  if (data.buttons !== undefined) {
    if (!Array.isArray(data.buttons)) errors.push('buttons debe ser un array');
    else {
      counts.buttons = data.buttons.length;
      const seen = new Set<string>();
      data.buttons.forEach((b: any, i: number) => {
        if (!isObj(b) || !b.id || !b.page_id || typeof b.position !== 'number') {
          errors.push(`buttons[${i}]: id, page_id y position (number) requeridos`); return;
        }
        if (seen.has(`${b.page_id}:${b.position}`)) errors.push(`buttons[${i}]: posición duplicada ${b.page_id}:${b.position}`);
        seen.add(`${b.page_id}:${b.position}`);
        if (b.position < 0 || !Number.isInteger(b.position)) errors.push(`buttons[${i}]: position inválida`);
      });
    }
  }
  for (const sec of ['widgets', 'flows', 'automations'] as const) {
    if (data[sec] !== undefined) {
      if (!Array.isArray(data[sec])) errors.push(`${sec} debe ser un array`);
      else {
        counts[sec] = data[sec].length;
        const ids = new Set<string>();
        data[sec].forEach((e: any, i: number) => {
          if (!isObj(e) || !e.id || !e.name) { errors.push(`${sec}[${i}]: id y name requeridos`); return; }
          if (ids.has(e.id)) errors.push(`${sec}[${i}]: id duplicado ${JSON.stringify(e.id)}`);
          ids.add(e.id);
          if (sec === 'flows' && e.data !== undefined && isObj(e.data) && e.data.steps !== undefined && !Array.isArray(e.data.steps)) {
            errors.push(`flows[${i}]: data.steps debe ser un array`);
          }
        });
      }
    }
  }
  if (data.variables !== undefined) {
    if (!Array.isArray(data.variables)) errors.push('variables debe ser un array');
    else {
      counts.variables = data.variables.length;
      const names = new Set<string>();
      data.variables.forEach((v: any, i: number) => {
        if (!isObj(v) || !v.name) { errors.push(`variables[${i}]: name requerido`); return; }
        if (names.has(v.name)) errors.push(`variables[${i}]: name duplicado ${JSON.stringify(v.name)}`);
        names.add(v.name);
      });
    }
  }
  if (data.variable_rows !== undefined) {
    if (!Array.isArray(data.variable_rows)) errors.push('variable_rows debe ser un array');
    else {
      counts.variable_rows = data.variable_rows.length;
      data.variable_rows.forEach((v: any, i: number) => {
        if (!isObj(v) || !v.name || v.scope === undefined || v.scope_id === undefined || v.type === undefined || v.value === undefined) {
          errors.push(`variable_rows[${i}]: name, scope, scope_id, type y value requeridos`);
        }
      });
    }
  }
  if (data.assets !== undefined) {
    if (!Array.isArray(data.assets)) errors.push('assets debe ser un array');
    else {
      counts.assets = data.assets.length;
      data.assets.forEach((a: any, i: number) => {
        if (!isObj(a) || !a.id || !a.path) errors.push(`assets[${i}]: id y path requeridos`);
        else if (a.contentBase64 !== null && a.contentBase64 !== undefined && typeof a.contentBase64 !== 'string') {
          errors.push(`assets[${i}]: contentBase64 debe ser string base64 o null`);
        }
      });
    }
  }
  if (data.plugins !== undefined) {
    if (!Array.isArray(data.plugins)) errors.push('plugins debe ser un array');
    else {
      counts.plugins = data.plugins.length;
      data.plugins.forEach((p: any, i: number) => {
        if (!isObj(p) || !p.id || !p.name || !p.version) errors.push(`plugins[${i}]: id, name y version requeridos`);
      });
    }
  }
  if (data.settings !== undefined) {
    if (!isObj(data.settings)) errors.push('settings debe ser un objeto clave → valor');
    else counts.settings = Object.keys(data.settings).length;
  }
  if (data.devices !== undefined) {
    if (!Array.isArray(data.devices)) errors.push('devices debe ser un array');
    else {
      counts.devices = data.devices.length;
      const seen = new Set<string>();
      data.devices.forEach((d: any, i: number) => {
        if (!isObj(d) || !d.id || !d.name) { errors.push(`devices[${i}]: id y name requeridos`); return; }
        if (seen.has(d.id)) errors.push(`devices[${i}]: id duplicado ${JSON.stringify(d.id)}`);
        seen.add(d.id);
        if (!['deck', 'phone', 'tablet', 'browser'].includes(d.kind)) errors.push(`devices[${i}]: kind debe ser deck|phone|tablet|browser`);
        for (const k of ['cols', 'rows'] as const) {
          if (d[k] !== undefined && d[k] !== null && (!Number.isInteger(d[k]) || d[k] < 1 || d[k] > 12)) {
            errors.push(`devices[${i}]: ${k} debe estar entre 1 y 12`);
          }
        }
      });
    }
  }
  if (data.assignments !== undefined) {
    if (!Array.isArray(data.assignments)) errors.push('assignments debe ser un array');
    else {
      counts.assignments = data.assignments.length;
      const seen = new Set<string>();
      data.assignments.forEach((a: any, i: number) => {
        if (!isObj(a) || !a.profile_id || !a.device_id || !a.page_id) {
          errors.push(`assignments[${i}]: profile_id, device_id y page_id requeridos`); return;
        }
        const key = `${a.profile_id}:${a.device_id}`;
        if (seen.has(key)) errors.push(`assignments[${i}]: duplicado ${key}`);
        seen.add(key);
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    info: {
      format: obj.format,
      version: obj.version,
      appVersion: obj.appVersion,
      createdAt: obj.createdAt,
      sections,
      counts,
    },
  };
}

/**
 * Restore con validación previa obligatoria. `sections` filtra qué se
 * importa; `mode: 'clean'` vacía esas secciones antes (instalación
 * limpia). Todo lo to-DO va en una transacción (rollback si algo falla).
 */
export function restoreBackup(
  db: DatabaseService,
  obj: any,
  opts?: RestoreOptions
): RestoreResult {
  const mode: RestoreMode = opts?.mode === 'clean' ? 'clean' : 'merge';
  const v = validateBackup(obj);
  if (!v.valid) {
    throw new Error(`Backup inválido: ${v.errors.join('; ')}`);
  }
  const requested = opts?.sections?.length
    ? opts.sections.filter((s) => (BACKUP_SECTIONS as readonly string[]).includes(s))
    : [...BACKUP_SECTIONS];
  // Orden de importación (respeta FKs): profiles → pages → buttons → resto.
  const order: string[] = [...BACKUP_SECTIONS].filter((s) => requested.includes(s));
  const total = order.length || 1;
  const prog = (stage: string, done: number, message: string) => {
    try { opts?.onProgress?.(stage, done, total, message); } catch { /* noop */ }
  };
  const data = obj.data ?? {};
  const restored: Record<string, number> = {};
  const warnings: string[] = [...v.warnings];

  prog('started', 0, `Restore ${mode} (${order.join(', ') || 'vacío'})`);

  db.transaction(() => {
    if (mode === 'clean') {
      for (const s of order) {
        if (s === 'settings') continue; // settings se pisan por clave abajo
        if (s === 'assets') continue; // ficheros + tabla se tratan fuera/fuera-tx
        db.clearSection(s);
      }
      if (order.includes('settings')) {
        // Limpieza de settings: borra todo y restaura (conserva mcp.tokens si el backup no lo trae).
        const keepTokens = !isObj(data.settings) || (data.settings as any)['mcp.tokens'] === undefined
          ? db.getSetting('mcp.tokens')
          : undefined;
        try {
          (db as any)['db'].prepare('DELETE FROM settings').run();
        } catch { /* noop */ }
        if (keepTokens !== undefined && keepTokens !== null) db.setSetting('mcp.tokens', keepTokens);
      }
    }

    if (data.profiles && order.includes('profiles')) {
      let n = 0;
      for (const p of data.profiles) {
        const existing = db.getProfile(p.id);
        if (existing) db.updateProfile(p.id, { name: p.name, data: p.data ?? {} });
        else db.createProfile({ id: p.id, name: p.name, data: p.data ?? {} });
        n++;
      }
      restored.profiles = n;
      prog('progress', doneCount(order, 'profiles'), `${n} perfiles`);
    }
    if (data.pages && order.includes('pages')) {
      let n = 0;
      for (const pg of data.pages) {
        const existing = db.getPage(pg.id);
        const payload = {
          name: pg.name,
          order_idx: Number(pg.order_idx ?? 0),
          is_folder: Number(pg.is_folder ?? 0),
          data: pg.data ?? {},
        };
        if (existing) {
          try { db.updatePage(pg.id, payload); }
          catch { warnings.push(`Página ${pg.id} no actualizada (nombre duplicado?)`); }
        } else {
          try { db.createPage({ id: pg.id, profile_id: pg.profile_id, ...payload } as any); }
          catch {
            // Perfil destino ausente en merge: se omite con aviso en vez de abortar todo.
            warnings.push(`Página ${pg.id} omitida (perfil ${pg.profile_id} ausente o nombre duplicado)`);
          }
        }
        n++;
      }
      restored.pages = n;
      prog('progress', doneCount(order, 'pages'), `${n} páginas/carpetas`);
    }
    if (data.buttons && order.includes('buttons')) {
      let n = 0;
      for (const b of data.buttons) {
        if (!db.getPage(b.page_id)) { warnings.push(`Botón ${b.id} omitido (página ${b.page_id} ausente)`); continue; }
        const existing = db.getButton(b.id);
        if (existing) {
          try { db.updateButtonComplete(b.id, { data: b.data ?? {}, position: b.position }); }
          catch { warnings.push(`Botón ${b.id} no actualizado (posición ${b.position} ocupada?)`); }
        } else {
          try { db.createButton({ id: b.id, page_id: b.page_id, position: b.position, data: b.data ?? {} } as any); }
          catch { warnings.push(`Botón ${b.id} omitido (posición ${b.position} ocupada?)`); }
        }
        n++;
      }
      restored.buttons = n;
      prog('progress', doneCount(order, 'buttons'), `${n} botones`);
    }
    if (data.widgets && order.includes('widgets')) {
      let n = 0;
      for (const w of data.widgets) {
        if (db.getWidget(w.id)) db.updateWidget(w.id, { name: w.name, kind: w.kind ?? null, data: w.data ?? {} });
        else db.createWidget({ id: w.id, name: w.name, kind: w.kind ?? null, data: w.data ?? {} });
        n++;
      }
      restored.widgets = n;
      prog('progress', doneCount(order, 'widgets'), `${n} widgets`);
    }
    if (data.flows && order.includes('flows')) {
      let n = 0;
      for (const f of data.flows) {
        if (db.getFlow(f.id)) db.updateFlow(f.id, { name: f.name, data: f.data ?? { steps: [] } });
        else db.createFlow({ id: f.id, name: f.name, data: f.data ?? { steps: [] } });
        n++;
      }
      restored.flows = n;
      prog('progress', doneCount(order, 'flows'), `${n} flows`);
    }
    if (data.automations && order.includes('automations')) {
      let n = 0;
      for (const a of data.automations) {
        if (db.getAutomation(a.id)) {
          db.updateAutomation(a.id, { name: a.name, enabled: a.enabled ?? 1, trigger: a.trigger ?? {}, data: a.data ?? { actions: [] } });
        } else {
          db.createAutomation({ id: a.id, name: a.name, enabled: a.enabled ?? 1, trigger: a.trigger ?? {}, data: a.data ?? { actions: [] } });
        }
        n++;
      }
      restored.automations = n;
      prog('progress', doneCount(order, 'automations'), `${n} automatizaciones`);
    }
    if (data.variables && order.includes('variables')) {
      let n = 0;
      for (const vv of data.variables) {
        db.setVariable(vv.name, vv.value ?? null, vv.type ?? null);
        n++;
      }
      // Filas scoped (widget/script/automation) en crudo.
      if (Array.isArray(data.variable_rows)) {
        for (const r of data.variable_rows) {
          try {
            db.setVariableRow({
              name: r.name, scope: r.scope, scope_id: r.scope_id, type: r.type,
              value: typeof r.value === 'string' ? r.value : JSON.stringify(r.value ?? ''),
              unavailable: Number(r.unavailable ?? 0),
              bindings: typeof r.bindings === 'string' || r.bindings === null || r.bindings === undefined
                ? (r.bindings ?? null)
                : JSON.stringify(r.bindings),
            });
            n++;
          } catch (e) {
            warnings.push(`variable_rows ${r.scope}/${r.scope_id}/${r.name} omitida (${e instanceof Error ? e.message : String(e)})`);
          }
        }
      }
      restored.variables = n;
      try { getVariableStore().clearCache(); } catch { /* mejor esfuerzo */ }
      prog('progress', doneCount(order, 'variables'), `${n} variables`);
    }
    if (data.plugins && order.includes('plugins')) {
      let n = 0;
      for (const p of data.plugins) {
        db.upsertPluginRecord({
          id: p.id, name: p.name, version: p.version, manifest: p.manifest,
          enabled: p.enabled ?? 1, source_type: p.source_type, origin: p.origin,
          ref: p.ref, commit: p.commit, checksum: p.checksum, status: p.status,
          last_error: p.last_error, previous_version: p.previous_version,
          previous_manifest: p.previous_manifest,
        } as any);
        n++;
      }
      restored.plugins = n;
      prog('progress', doneCount(order, 'plugins'), `${n} plugins`);
    }
    if (data.settings && order.includes('settings') && isObj(data.settings)) {
      let n = 0;
      for (const [k, val] of Object.entries(data.settings)) {
        if (typeof k !== 'string' || !k) continue;
        db.setSetting(k, typeof val === 'string' ? val : JSON.stringify(val));
        n++;
      }
      restored.settings = n;
      prog('progress', doneCount(order, 'settings'), `${n} ajustes`);
    }
    if (data.devices && order.includes('devices')) {
      let n = 0;
      for (const d of data.devices) {
        const payload = {
          name: String(d.name).slice(0, 80),
          kind: d.kind,
          model: d.model ?? null,
          cols: d.cols ?? null,
          rows: d.rows ?? null,
          hw_path: d.hw_path ?? null,
        };
        if (db.getDevice(d.id)) db.updateDevice(d.id, payload);
        else {
          try { db.createDevice({ id: d.id, ...payload }); }
          catch { warnings.push(`Dispositivo ${d.id} omitido (id duplicado?)`); continue; }
        }
        n++;
      }
      restored.devices = n;
      prog('progress', doneCount(order, 'devices'), `${n} dispositivos`);
    }
    if (data.assignments && order.includes('assignments')) {
      let n = 0;
      const touchedProfiles = new Set<string>();
      for (const a of data.assignments) {
        const device = db.getDevice(a.device_id);
        const page = db.getPage(a.page_id);
        if (!device) { warnings.push(`Asignación omitida (dispositivo ${a.device_id} ausente)`); continue; }
        if (!page || page.profile_id !== a.profile_id) {
          warnings.push(`Asignación omitida (página ${a.page_id} ausente en el perfil)`);
          continue;
        }
        const profile = db.getProfile(a.profile_id);
        const compat = checkPageCompatibility(
          {
            id: page.id, profile_id: page.profile_id, name: page.name, is_folder: page.is_folder,
            parent_id: page.parent_id ?? null, grid_cols: page.grid_cols ?? null, grid_rows: page.grid_rows ?? null,
            data: page.data,
          },
          {
            id: device.id, name: device.name, kind: device.kind as 'deck' | 'phone' | 'tablet' | 'browser',
            model: device.model, cols: device.cols, rows: device.rows,
          },
          profile?.data,
        );
        if (!compat.ok) {
          warnings.push(`Asignación omitida («${page.name}» ${compat.why ?? 'incompatible'} en ${device.name})`);
          continue;
        }
        db.setAssignment(a.profile_id, a.device_id, a.page_id);
        touchedProfiles.add(a.profile_id);
        n++;
      }
      // Normaliza lo restaurado (auto-asigna raíces donde falte pantalla).
      for (const pid of touchedProfiles) {
        try { db.repairAssignments(pid); } catch { /* mejor esfuerzo */ }
      }
      restored.assignments = n;
      prog('progress', doneCount(order, 'assignments'), `${n} asignaciones`);
    }
    if (data.assets && order.includes('assets')) {
      let n = 0;
      for (const a of data.assets) {
        db.upsertAsset({ id: a.id, path: a.path, hash: a.hash ?? '', size: Number(a.size ?? 0), created_at: Number(a.created_at ?? Date.now()) });
        n++;
      }
      restored.assets = n;
      prog('progress', doneCount(order, 'assets'), `${n} assets (metadatos)`);
    }
  });

  // Ficheros de assets (fuera de la tx): best-effort, no aborta el restore.
  if (data.assets && order.includes('assets')) {
    try {
      const fs = require('fs') as typeof import('fs');
      const path = require('path') as typeof import('path');
      if (mode === 'clean') {
        try {
          const dir = getAssetsDir();
          if (fs.existsSync(dir)) {
            for (const f of fs.readdirSync(dir)) {
              try { fs.rmSync(path.join(dir, f), { recursive: true, force: true }); } catch { /* noop */ }
            }
          }
        } catch { /* noop */ }
      }
      for (const a of data.assets) {
        if (typeof a.contentBase64 !== 'string' || !a.contentBase64) continue;
        try {
          const dir = getAssetsDir();
          const full = path.isAbsolute(a.path) ? a.path : path.join(dir, a.path);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, Buffer.from(a.contentBase64, 'base64'));
        } catch (e) {
          warnings.push(`Asset ${a.id}: no se pudo escribir el fichero (${e instanceof Error ? e.message : String(e)})`);
        }
      }
    } catch (e) {
      warnings.push(`Assets en disco omitidos: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  prog('done', total, 'Restore completado');
  return { success: true, mode, sections: order, restored, warnings };
}

function doneCount(order: string[], section: string): number {
  const i = order.indexOf(section);
  return i < 0 ? order.length : i + 1;
}
