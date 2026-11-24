/**
 * Importación de perfiles Stream Deck (Elgato) a LibreDeck.
 *
 * Entradas:
 * - `.streamDeckProfile` (zip): se descomprime a temp con adm-zip
 *   (igual que `elgato/import.ts`) y se parsea el `manifest.json` raíz
 *   más cada `Profiles/.../Manifest.json`.
 * - Carpeta de perfil detectada (`ProfilesV2/<uuid>`): se lee tal cual,
 *   sin escribir nunca en las carpetas de Elgato.
 *
 * Mapper en 3 cubos (nunca bloquea):
 * - nativo 1:1 (hotkey, abrir app/web, texto, multimedia, navegación a
 *   carpeta, MultiAction) → acciones de plugins integrados.
 * - bridge `x-elgato`: la acción SD pertenece a un plugin Elgato ya
 *   instalado (su UUID coincide con una acción convertida) → se guarda
 *   la referencia con sus settings opacos.
 * - placeholder: resto → botón con título/imagen y una acción `flow.log`
 *   con nota (no hace nada, no rompe nada).
 *
 * Los settings originales viajan opacos (`x-streamdeck.settings` por
 * botón, `x-streamdeck` en el perfil) tal cual —pueden traer tokens— y
 * nunca se vuelcan en warnings ni logs.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseService } from '../db';
import { getAssetsDir } from '../paths';

export interface SDGrid {
  cols: number;
  rows: number;
  /** Etiqueta del modelo para la trazabilidad. */
  model: string;
  /** false si el DeviceType era desconocido (se usó 5×3 por defecto). */
  known: boolean;
}

export interface NormalizedSDAction {
  /** Clave original ("col,row" o índice). */
  key: string;
  col: number;
  row: number;
  /** UUID de la acción Elgato (p.ej. com.elgato.…). */
  uuid: string | null;
  /** Settings opacos de la acción SD. */
  settings: Record<string, any>;
  title: string | null;
  /** Imagen SD: data URI o ruta relativa dentro del bundle. */
  image: string | null;
  isFolder: boolean;
  /** UUID del sub-perfil SD al que apunta (si se detectó). */
  folderTarget: string | null;
  /** Sub-acciones (MultiAction), ya normalizadas. */
  children: NormalizedSDAction[];
}

export interface NormalizedSDProfile {
  /** Nombre de la carpeta del perfil (identidad para enlaces de carpeta). */
  uuid: string;
  /** DeviceUUID declarado en el Manifest (puede repetirse; solo informativo). */
  deviceUuid: string | null;
  name: string;
  deviceType: string | number | null;
  grid: SDGrid;
  actions: NormalizedSDAction[];
  warnings: string[];
}

export type MapBucket = 'native' | 'bridge' | 'placeholder';

export interface MappedAction {
  bucket: MapBucket;
  action: { type: string; parameters: Record<string, any> };
  /** Nota legible para el placeholder (sin settings opacos). */
  note: string | null;
}

export interface ImportPlanProfile {
  uuid: string;
  name: string;
  grid: SDGrid;
  /** Posición LibreDeck → mapeo (ya resuelto con cols del grid). */
  buttons: Array<{ position: number; title: string | null; bucket: MapBucket; note: string | null }>;
  counts: { native: number; bridge: number; placeholder: number };
  warnings: string[];
}

export interface ImportPlan {
  name: string;
  profiles: ImportPlanProfile[];
  counts: { native: number; bridge: number; placeholder: number; buttons: number };
  warnings: string[];
}

export interface ImportResult extends ImportPlan {
  dryRun: boolean;
  profileId: string | null;
  profileName: string | null;
}

export type ImportProgress = (stage: string, done: number, total: number, message: string) => void;

// ---------------------------------------------------------------------------
// Grid por DeviceType
// ---------------------------------------------------------------------------

/** DeviceType numérico del SDK (0=clásico …) + nombres de modelo. */
export function deviceGridFor(deviceType: string | number | null | undefined): SDGrid {
  const raw = typeof deviceType === 'string' ? deviceType.trim() : deviceType;
  const lower = typeof raw === 'string' ? raw.toLowerCase() : null;
  if (lower) {
    if (lower.includes('mini')) return { cols: 3, rows: 2, model: String(raw), known: true };
    if (lower.includes('xl')) return { cols: 8, rows: 4, model: String(raw), known: true };
    if (lower.includes('plus')) return { cols: 8, rows: 4, model: String(raw), known: true };
    if (lower.includes('pedal')) return { cols: 3, rows: 1, model: String(raw), known: true };
    if (lower.includes('neo')) return { cols: 3, rows: 2, model: String(raw), known: true };
    if (lower.includes('stream deck mk') || lower === 'stream deck' || lower.includes('classic') || lower.includes('mk.2') || lower.includes('mk2')) {
      return { cols: 5, rows: 3, model: String(raw), known: true };
    }
  }
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    // Orden del SDK: 0 clásica, 1 Mini, 2 XL, 5 Plus (teclas), 6 Pedal.
    switch (raw) {
      case 0: return { cols: 5, rows: 3, model: `DeviceType ${raw}`, known: true };
      case 1: return { cols: 3, rows: 2, model: `DeviceType ${raw}`, known: true };
      case 2: return { cols: 8, rows: 4, model: `DeviceType ${raw}`, known: true };
      case 5: return { cols: 8, rows: 4, model: `DeviceType ${raw}`, known: true };
      case 6: return { cols: 3, rows: 1, model: `DeviceType ${raw}`, known: true };
    }
  }
  return { cols: 5, rows: 3, model: String(raw ?? 'desconocido'), known: false };
}

// ---------------------------------------------------------------------------
// Normalización tolerante del Manifest SD
// ---------------------------------------------------------------------------

const FOLDER_UUID_HINTS = ['openchild', 'open-child', 'gotofolder', 'go-to-folder', 'folder', 'childprofile'];

function isFolderAction(uuid: string | null, settings: Record<string, any>): boolean {
  const u = (uuid ?? '').toLowerCase();
  if (u && FOLDER_UUID_HINTS.some((h) => u.includes(h))) return true;
  // La navegación a carpeta de SD v6 guarda el destino en settings.
  for (const [k, v] of Object.entries(settings)) {
    if (typeof v === 'string' && /profileuuid|childuuid|folder|childprofile/i.test(k) && v.trim()) return true;
  }
  return false;
}

function folderTargetOf(settings: Record<string, any>): string | null {
  for (const [k, v] of Object.entries(settings)) {
    if (typeof v === 'string' && /profileuuid|childuuid|folder|childprofile/i.test(k) && v.trim()) return v.trim();
  }
  return null;
}

function titleOf(entry: any, settings: Record<string, any>): string | null {
  const states = Array.isArray(entry?.States) ? entry.States : [];
  const idx = Number.isInteger(entry?.State) ? entry.State : 0;
  const st = states[idx] ?? states[0] ?? {};
  const candidates = [st.Title, st?.TitleParameters?.Title, settings?.Title, settings?.title, entry?.Title];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

function imageOf(entry: any): string | null {
  const states = Array.isArray(entry?.States) ? entry.States : [];
  const idx = Number.isInteger(entry?.State) ? entry.State : 0;
  const st = states[idx] ?? states[0] ?? {};
  for (const c of [st.Image, entry?.Image]) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

function normalizeChildren(raw: any): NormalizedSDAction[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c, i) => normalizeEntry(c, `sub:${i}`))
    .filter((c): c is NormalizedSDAction => c !== null);
}

function normalizeEntry(entry: any, fallbackKey: string): NormalizedSDAction | null {
  if (!entry || typeof entry !== 'object') return null;
  const uuid = typeof entry.UUID === 'string' && entry.UUID ? entry.UUID
    : typeof entry.uuid === 'string' && entry.uuid ? entry.uuid
    : typeof entry.Name === 'string' && entry.Name ? entry.Name
    : null;
  const settings = entry.Settings && typeof entry.Settings === 'object' ? entry.Settings
    : entry.settings && typeof entry.settings === 'object' ? entry.settings
    : {};
  // Coordenadas: clave "col,row", Coordinates {Column,Row}/{column,row} o Controller Keypad.
  let col = -1;
  let row = -1;
  const coords = entry.Coordinates ?? entry.coordinates;
  if (coords && typeof coords === 'object') {
    const c = coords.Column ?? coords.column ?? coords.x;
    const r = coords.Row ?? coords.row ?? coords.y;
    if (Number.isInteger(c) && Number.isInteger(r)) { col = c; row = r; }
  }
  if ((col < 0 || row < 0) && typeof entry.Position === 'number') {
    col = entry.Position; row = 0;
  }
  const childrenRaw = entry.Actions ?? entry.actions ?? entry.ActionList ?? entry.Macro ?? [];
  return {
    key: typeof entry.Key === 'string' ? entry.Key : fallbackKey,
    col,
    row,
    uuid,
    settings: settings as Record<string, any>,
    title: titleOf(entry, settings as Record<string, any>),
    image: imageOf(entry),
    isFolder: isFolderAction(uuid, settings as Record<string, any>),
    folderTarget: folderTargetOf(settings as Record<string, any>),
    children: normalizeChildren(childrenRaw),
  };
}

/** Acepta Actions como objeto {"col,row": entry} o array con Coordinates. */
function normalizeActions(raw: any): NormalizedSDAction[] {
  if (!raw || typeof raw !== 'object') return [];
  const list: NormalizedSDAction[] = [];
  if (Array.isArray(raw)) {
    raw.forEach((e, i) => {
      const n = normalizeEntry(e, `idx:${i}`);
      if (n) list.push(n);
    });
    return list;
  }
  for (const [key, entry] of Object.entries(raw)) {
    const n = normalizeEntry(entry, key);
    if (!n) continue;
    n.key = key;
    const m = /^(\d+)\s*,\s*(\d+)$/.exec(key);
    if (m && (n.col < 0 || n.row < 0)) {
      n.col = Number(m[1]);
      n.row = Number(m[2]);
    }
    list.push(n);
  }
  return list;
}

/** Normaliza un Manifest.json SD (perfil) ya parseado. */
export function parseProfileManifest(obj: any, fallbackName: string, folderName: string): NormalizedSDProfile {
  const m = obj && typeof obj === 'object' ? obj : {};
  const name = typeof m.Name === 'string' && m.Name.trim() ? m.Name.trim()
    : typeof m.name === 'string' && m.name.trim() ? m.name.trim()
    : fallbackName;
  const deviceUuid = typeof m.DeviceUUID === 'string' && m.DeviceUUID ? m.DeviceUUID
    : typeof m.UUID === 'string' && m.UUID ? m.UUID
    : null;
  const deviceType = m.DeviceType ?? m.deviceType ?? m.DeviceModel ?? null;
  const grid = deviceGridFor(typeof deviceType === 'string' || typeof deviceType === 'number' ? deviceType : null);
  const warnings: string[] = [];
  if (!grid.known) warnings.push(`DeviceType «${String(deviceType ?? 'ausente')}» desconocido: se usa rejilla 5×3`);
  const actions = normalizeActions(m.Actions ?? m.actions);
  if (actions.length === 0) warnings.push('El perfil no trae acciones (Actions vacío o con formato no reconocido)');
  // La identidad es la carpeta (Profiles/<uuid>/ o ProfilesV2/<uuid>/):
  // el DeviceUUID declarado puede repetirse entre sub-perfiles.
  return { uuid: folderName, deviceUuid, name, deviceType, grid, actions, warnings };
}

/** Recolecta los Manifest.json de perfiles dentro de una carpeta extraída o instalada. */
export function collectProfileManifests(rootDir: string): {
  manifests: Array<{ manifestPath: string; folder: string; obj: any }>;
  /** Nombre del bundle (manifest.json raíz), si lo trae. */
  rootName: string | null;
} {
  const found: Array<{ manifestPath: string; folder: string; obj: any }> = [];
  const read = (p: string): any | null => {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      return null;
    }
  };
  let rootName: string | null = null;
  for (const cand of ['manifest.json', 'Manifest.json']) {
    try {
      const p = path.join(rootDir, cand);
      if (fs.statSync(p).isFile()) {
        const obj = read(p);
        if (obj && typeof obj?.Name === 'string' && obj.Name.trim()) rootName = obj.Name.trim();
        break;
      }
    } catch { /* noop */ }
  }
  // Forma bundle: Profiles/<uuid>/Manifest.json (+ manifest.json raíz informativo).
  const profilesDir = path.join(rootDir, 'Profiles');
  try {
    if (fs.statSync(profilesDir).isDirectory()) {
      for (const e of fs.readdirSync(profilesDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        for (const cand of ['Manifest.json', 'manifest.json']) {
          const p = path.join(profilesDir, e.name, cand);
          try {
            if (fs.statSync(p).isFile()) {
              const obj = read(p);
              if (obj) found.push({ manifestPath: p, folder: e.name, obj });
              break;
            }
          } catch { /* noop */ }
        }
      }
    }
  } catch { /* sin Profiles/: sigue abajo */ }
  // Forma instalada (ProfilesV2/<uuid>/manifest.json): la propia raíz es el perfil.
  if (found.length === 0) {
    for (const cand of ['Manifest.json', 'manifest.json']) {
      const p = path.join(rootDir, cand);
      try {
        if (fs.statSync(p).isFile()) {
          const obj = read(p);
          if (obj && (obj.Actions || obj.actions)) {
            found.push({ manifestPath: p, folder: path.basename(rootDir), obj });
            if (typeof obj?.Name === 'string' && obj.Name.trim()) rootName = obj.Name.trim();
          }
          break;
        }
      } catch { /* noop */ }
    }
  }
  // Determinista: orden alfabético por carpeta (el readdir no lo garantiza).
  found.sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
  return { manifests: found, rootName };
}

// ---------------------------------------------------------------------------
// Mapper (3 cubos)
// ---------------------------------------------------------------------------

function strSetting(s: Record<string, any>, ...keys: string[]): string {
  for (const k of keys) {
    const v = s[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function mediaActionFor(uuid: string): string | null {
  const u = uuid.toLowerCase();
  if (u.includes('mute')) return 'mute';
  if (u.includes('volume') && (u.includes('up') || u.includes('increment') || u.includes('+'))) return 'volumeup';
  if (u.includes('volume') && (u.includes('down') || u.includes('decrement') || u.includes('-'))) return 'volumedown';
  if (u.includes('volume')) return 'mute';
  if (u.includes('next') || u.includes('siguiente')) return 'next';
  if (u.includes('prev')) return 'previous';
  if (u.includes('stop')) return 'stop';
  if (u.includes('play') || u.includes('pause') || u.includes('media')) return 'playpause';
  return null;
}

/**
 * Mapea una acción SD a una acción LibreDeck.
 * `installedElgato`: UUIDs de acciones de plugins Elgato ya convertidos
 * (manifest `x-elgato.originalActions`), para el cubo bridge.
 */
export function mapSDAction(
  action: NormalizedSDAction,
  installedElgato: Set<string> = new Set(),
): MappedAction {
  const uuid = (action.uuid ?? '').trim();
  const lower = uuid.toLowerCase();
  const s = action.settings;

  // MultiAction → multiaction.run-sequence (recursión limitada a 1 nivel).
  if (lower.includes('multiaction')) {
    const steps: Array<{ type: string; parameters: Record<string, any> }> = [];
    let notes = 0;
    for (const child of action.children.slice(0, 50)) {
      const m = mapSDAction(child, installedElgato);
      if (m.bucket === 'placeholder') {
        notes++;
        steps.push({ type: 'flow.log', parameters: { message: m.note ?? 'Paso no importable de MultiAction' } });
      } else {
        steps.push(m.action);
      }
    }
    if (steps.length === 0) {
      return {
        bucket: 'placeholder',
        action: { type: 'flow.log', parameters: { message: `MultiAction «${action.title ?? uuid}» vacía (Stream Deck)` } },
        note: `MultiAction «${action.title ?? uuid}» sin pasos reconocibles`,
      };
    }
    return {
      bucket: 'native',
      action: { type: 'multiaction.run-sequence', parameters: { actions: steps.map((st) => ({ type: st.type, params: st.parameters })) } },
      note: notes > 0 ? `${notes} paso(s) como nota (sin equivalente)` : null,
    };
  }

  // Carpetas: se resuelven al importar (page.page con pageId destino).
  // Aquí se marca como nativa pendiente; el importador rellena pageId.
  if (action.isFolder) {
    return {
      bucket: 'native',
      action: { type: 'page.page', parameters: {} },
      note: null,
    };
  }

  // Nativas 1:1 por UUID conocido o por heurística de nombre.
  if (lower.includes('hotkey')) {
    return { bucket: 'native', action: { type: 'hotkey.hotkey', parameters: { keys: strSetting(s, 'hotkey', 'Hotkey', 'keys', 'Keys') } }, note: null };
  }
  if (lower.includes('website') || lower.includes('openurl') || lower.includes('open-url') || lower.includes('url')) {
    const url = strSetting(s, 'url', 'URL', 'website', 'Website', 'address');
    if (url) return { bucket: 'native', action: { type: 'browser.open-url', parameters: { url } }, note: null };
  }
  if ((lower.includes('open') && !lower.includes('openchild')) || lower.includes('launch') || lower.includes('application')) {
    const p = strSetting(s, 'path', 'Path', 'file', 'File', 'application', 'Application');
    if (p) return { bucket: 'native', action: { type: 'open-app.open-app', parameters: { path: p } }, note: null };
  }
  if (lower.includes('text') || lower.includes('type') || lower.includes('writetext')) {
    const text = strSetting(s, 'text', 'Text', 'texto', 'Texto', 'string', 'String');
    if (text) return { bucket: 'native', action: { type: 'type-text.type', parameters: { text } }, note: null };
  }
  const media = mediaActionFor(uuid);
  if (media || lower.includes('multimedia') || lower.includes('volume')) {
    return { bucket: 'native', action: { type: 'multimedia.multimedia', parameters: { action: media ?? 'playpause' } }, note: null };
  }
  if (lower.includes('timer') || lower.includes('clock') || lower.includes('countdown')) {
    return { bucket: 'placeholder', action: { type: 'flow.log', parameters: { message: `Temporizador/reloj «${action.title ?? uuid}» (Stream Deck): sin equivalente directo` } }, note: `Temporizador «${action.title ?? uuid}» sin equivalente directo` };
  }
  if (lower.includes('switchprofile') || lower.includes('switch-profile')) {
    return { bucket: 'placeholder', action: { type: 'flow.log', parameters: { message: `Cambio de perfil SD «${action.title ?? uuid}»: revísalo a mano` } }, note: `Cambio de perfil SD «${action.title ?? uuid}» (revisar a mano)` };
  }

  // Bridge x-elgato: UUID de acción de un plugin Elgato ya instalado.
  if (uuid && installedElgato.has(uuid)) {
    const dot = uuid.lastIndexOf('.');
    const pluginId = dot > 0 ? uuid.slice(0, dot) : uuid;
    const actionId = dot > 0 ? uuid.slice(dot + 1) : uuid;
    return {
      bucket: 'bridge',
      action: { type: `${pluginId}.${actionId}`, parameters: { settings: s } },
      note: null,
    };
  }

  // Resto: placeholder con nota (nunca bloquea).
  const label = action.title ?? uuid ?? 'acción desconocida';
  return {
    bucket: 'placeholder',
    action: { type: 'flow.log', parameters: { message: `Sin equivalente en LibreDeck: ${label} (${uuid || 'sin UUID'})` } },
    note: `«${label}» sin equivalente directo (${uuid || 'sin UUID'})`,
  };
}

// ---------------------------------------------------------------------------
// Plan (dry-run / validate sin tocar la BD)
// ---------------------------------------------------------------------------

function positionOf(a: NormalizedSDAction, cols: number, index: number): number {
  if (a.col >= 0 && a.row >= 0) return a.row * cols + a.col;
  return index;
}

/** Construye el plan de importación desde perfiles ya normalizados. */
export function buildImportPlan(
  profiles: NormalizedSDProfile[],
  installedElgato: Set<string> = new Set(),
  opts?: { name?: string | null },
): ImportPlan {
  const ordered = [...profiles];
  // La raíz (nombre del bundle) abre el perfil; el resto cuelga como carpetas.
  if (opts?.name) {
    ordered.sort((a, b) => {
      const am = a.name === opts.name ? 0 : 1;
      const bm = b.name === opts.name ? 0 : 1;
      return am - bm || (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0);
    });
  }
  const planProfiles: ImportPlanProfile[] = [];
  const counts = { native: 0, bridge: 0, placeholder: 0, buttons: 0 };
  const warnings: string[] = [];
  const fallbackName = opts?.name ?? ordered[0]?.name ?? 'Stream Deck';
  for (const p of ordered) {
    warnings.push(...p.warnings.map((w) => `${p.name}: ${w}`));
    const buttons: ImportPlanProfile['buttons'] = [];
    const pc = { native: 0, bridge: 0, placeholder: 0 };
    const seen = new Set<number>();
    p.actions.forEach((a, i) => {
      const position = positionOf(a, p.grid.cols, i);
      if (seen.has(position)) {
        warnings.push(`${p.name}: posición duplicada ${position} («${a.title ?? a.uuid ?? a.key}»), se reubica`);
      }
      seen.add(position);
      // Los encoders/diales (Plus) no tienen equivalente en rejilla.
      const m = mapSDAction(a, installedElgato);
      pc[m.bucket]++;
      counts[m.bucket]++;
      counts.buttons++;
      buttons.push({ position, title: a.title, bucket: m.bucket, note: m.note });
    });
    planProfiles.push({ uuid: p.uuid, name: p.name, grid: p.grid, buttons, counts: pc, warnings: [] });
  }
  return { name: fallbackName, profiles: planProfiles, counts, warnings };
}

// ---------------------------------------------------------------------------
// Importación real (siempre perfil nuevo, IDs nuevos, transacción)
// ---------------------------------------------------------------------------

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `sd-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

/** «{Nombre} (importado)» (+2, +3… si colisiona con perfiles existentes). */
export function uniqueImportedName(db: DatabaseService, base: string): string {
  const clean = base.trim() || 'Stream Deck';
  const existing = new Set(db.getProfiles().map((p) => p.name));
  const first = `${clean} (importado)`;
  if (!existing.has(first)) return first;
  let n = 2;
  while (existing.has(`${clean} (importado ${n})`)) n++;
  return `${clean} (importado ${n})`;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function storeImageAsset(
  db: DatabaseService,
  profileId: string,
  image: string | null,
  bundleDir: string | null,
  warnings: string[],
): string | null {
  if (!image) return null;
  try {
    let buf: Buffer | null = null;
    let ext = 'png';
    const dataUri = /^data:image\/([a-z0-9+]+);base64,(.*)$/is.exec(image);
    if (dataUri) {
      ext = dataUri[1].split('+')[0] || 'png';
      buf = Buffer.from(dataUri[2], 'base64');
    } else if (bundleDir && !/^(https?:)?\/\//i.test(image) && !path.isAbsolute(image)) {
      const abs = path.normalize(path.join(bundleDir, image));
      if (!abs.startsWith(path.normalize(bundleDir))) return null; // escape: se ignora
      try {
        if (fs.statSync(abs).isFile() && fs.statSync(abs).size <= MAX_IMAGE_BYTES) {
          buf = fs.readFileSync(abs);
          const e = path.extname(abs).replace('.', '').toLowerCase();
          if (e) ext = e;
        }
      } catch {
        return null;
      }
    } else {
      return null;
    }
    if (!buf || buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
    const rel = `sd-import/${profileId}/${newId()}.${ext.replace(/[^a-z0-9]/gi, '') || 'png'}`;
    const full = path.join(getAssetsDir(), rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    db.upsertAsset({ id: newId(), path: rel, hash, size: buf.length, created_at: Date.now() });
    return `/assets/${rel}`;
  } catch (e) {
    warnings.push(`Imagen no importada (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

async function extractZip(zipPath: string, dest: string): Promise<void> {
  let AdmZip: any = null;
  try {
    AdmZip = (await import('adm-zip')).default;
  } catch { /* fallback abajo */ }
  if (AdmZip) {
    new AdmZip(zipPath).extractAllTo(dest, true);
    return;
  }
  const { spawnJob } = await import('../jobs/manager');
  const r = await spawnJob(['tar', '-xf', zipPath, '-C', dest], { timeoutMs: 60_000 });
  if (r.timedOut) throw new Error('Extracción excedió 60s');
  if (r.exitCode !== 0) throw new Error(`Extracción falló: ${r.stderrTail.slice(0, 300)}`);
}

export interface StreamDeckImportInput {
  /** Fichero .streamDeckProfile (zip). */
  zipPath?: string;
  /** Carpeta de perfil ya instalada (ProfilesV2/<uuid> o bundle extraído). */
  profileDir?: string;
  /** UUID (carpeta) dentro de ProfilesV2 para importar. */
  detectedUuid?: string;
  /** Base ProfilesV2 (tests). */
  baseDir?: string;
}

/**
 * Importa un perfil Stream Deck creando SIEMPRE un perfil nuevo
 * («{Nombre} (importado)») con IDs nuevos. Con `dryRun` solo devuelve
 * el plan sin tocar la BD.
 */
export async function importStreamDeckProfile(
  db: DatabaseService,
  input: StreamDeckImportInput,
  opts?: { dryRun?: boolean; onProgress?: ImportProgress },
): Promise<ImportResult> {
  const prog = opts?.onProgress;
  const total = 5;
  prog?.('started', 0, total, 'Importación Stream Deck iniciada');
  let stageDir: string | null = null;
  let cleanup = false;
  let bundleDir: string | null = null;
  try {
    if (input.zipPath) {
      if (!fs.existsSync(input.zipPath)) throw new Error(`Fichero no encontrado: ${input.zipPath}`);
      stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-sdimport-'));
      cleanup = true;
      bundleDir = stageDir;
      prog?.('progress', 1, total, 'Extrayendo .streamDeckProfile…');
      await extractZip(input.zipPath, stageDir);
    } else if (input.profileDir) {
      bundleDir = input.profileDir;
      prog?.('progress', 1, total, 'Leyendo perfil instalado…');
    } else if (input.detectedUuid) {
      const { detectStreamDeckProfiles, streamDeckBaseDir } = await import('./detect');
      const base = input.baseDir ?? streamDeckBaseDir();
      if (!base) throw new Error('Plataforma sin carpetas Stream Deck (linux)');
      const found = detectStreamDeckProfiles({ baseDir: base }).find((p) => p.uuid === input.detectedUuid);
      if (!found) throw new Error(`Perfil Stream Deck no encontrado: ${input.detectedUuid}`);
      bundleDir = found.path;
      prog?.('progress', 1, total, 'Leyendo perfil instalado…');
    } else {
      throw new Error('Origen requerido: zipPath, profileDir o detectedUuid');
    }

    const { manifests, rootName } = collectProfileManifests(bundleDir!);
    if (manifests.length === 0) throw new Error('No se encontró ningún Manifest.json de perfil válido en el origen');
    prog?.('progress', 2, total, `${manifests.length} perfil(es) detectado(s)`);

    const normalized = manifests.map((m) =>
      parseProfileManifest(m.obj, m.folder, m.folder),
    );
    // Settings de plugins Elgato instalados → cubo bridge.
    const installedElgato = new Set<string>();
    try {
      for (const p of db.getPlugins()) {
        const orig = (p.manifest as any)?.['x-elgato']?.originalActions;
        if (Array.isArray(orig)) for (const a of orig) if (typeof a === 'string') installedElgato.add(a);
      }
    } catch { /* sin plugins: todo a native/placeholder */ }

    const plan = buildImportPlan(normalized, installedElgato, { name: rootName });
    // Las páginas siguen el orden del plan (raíz primero).
    const order = new Map(plan.profiles.map((p, i) => [p.uuid, i]));
    normalized.sort((a, b) => (order.get(a.uuid) ?? 0) - (order.get(b.uuid) ?? 0));
    prog?.('progress', 3, total, `${plan.counts.buttons} botones (${plan.counts.native} nativos, ${plan.counts.bridge} bridge, ${plan.counts.placeholder} pendientes)`);

    if (opts?.dryRun) {
      prog?.('done', total, total, 'Plan calculado (dry-run, sin cambios)');
      return { ...plan, dryRun: true, profileId: null, profileName: null };
    }

    const profileName = uniqueImportedName(db, plan.name);
    const profileId = newId();
    const warnings = [...plan.warnings];
    const pageIdByFolder = new Map<string, string>();
    const pageIdByDeviceUuid = new Map<string, string>();
    const resolveFolderPage = (target: string): string | null =>
      pageIdByFolder.get(target) ?? pageIdByDeviceUuid.get(target) ?? null;

    db.transaction(() => {
      db.createProfile({
        id: profileId,
        name: profileName,
        data: {
          'x-streamdeck': {
            sourceName: plan.name,
            importedAt: Date.now(),
            warnings,
            counts: plan.counts,
          },
        },
      });
      prog?.('progress', 4, total, `Perfil «${profileName}» creado`);

      normalized.forEach((sdProfile, pi) => {
        const pageId = newId();
        pageIdByFolder.set(sdProfile.uuid, pageId);
        if (sdProfile.deviceUuid) pageIdByDeviceUuid.set(sdProfile.deviceUuid, pageId);
        db.createPage({
          id: pageId,
          profile_id: profileId,
          name: pi === 0 ? sdProfile.name : `${sdProfile.name}`,
          order_idx: pi,
          is_folder: pi === 0 ? 0 : 1,
          data: {
            'x-streamdeck': { sdUuid: sdProfile.uuid, grid: sdProfile.grid },
            layoutMode: 'classic',
          },
        } as any);
      });

      // Segunda pasada: botones (las carpetas enlazan por pageId ya creado).
      normalized.forEach((sdProfile) => {
        const pageId = pageIdByFolder.get(sdProfile.uuid)!;
        const usedPositions = new Set<number>();
        sdProfile.actions.forEach((a, i) => {
          let position = a.col >= 0 && a.row >= 0 ? a.row * sdProfile.grid.cols + a.col : i;
          while (usedPositions.has(position)) position++;
          usedPositions.add(position);
          const m = mapSDAction(a, installedElgato);
          const buttonId = newId();
          const linkedPage = a.isFolder && a.folderTarget ? resolveFolderPage(a.folderTarget) : null;
          if (a.isFolder && linkedPage) {
            m.action = { type: 'page.page', parameters: { pageId: linkedPage } };
            m.bucket = 'native';
          } else if (a.isFolder) {
            // Carpeta sin destino conocido: sub-página propia.
            const folderPageId = newId();
            db.createPage({
              id: folderPageId,
              profile_id: profileId,
              name: a.title ?? `Carpeta ${i + 1}`,
              order_idx: 1000 + i,
              is_folder: 1,
              parent_id: pageId,
              data: { 'x-streamdeck': { sdKey: a.key, from: sdProfile.uuid } },
            } as any);
            m.action = { type: 'page.page', parameters: { pageId: folderPageId } };
            m.bucket = 'native';
          }
          const iconImage = storeImageAsset(db, profileId, a.image, bundleDir, warnings);
          db.createButtonWidget({
            id: buttonId,
            page_id: pageId,
            position,
            kind: a.isFolder ? 'folder' : 'action_button',
            data: {
              label: a.title ?? '',
              iconImage: iconImage ?? undefined,
              actions: [m.action],
              'x-streamdeck': {
                sdKey: a.key,
                sdUuid: a.uuid,
                bucket: m.bucket,
                note: m.note,
                settings: a.settings,
              },
            },
          });
        });
      });
    });

    prog?.('done', total, total, `Perfil «${profileName}» importado`);
    return { ...plan, warnings, dryRun: false, profileId, profileName };
  } finally {
    if (cleanup && stageDir) {
      try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }
}
