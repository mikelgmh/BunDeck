/**
 * Detección solo-lectura de perfiles Stream Deck (Elgato) instalados.
 *
 * - win32: `%APPDATA%/Elgato/StreamDeck/ProfilesV2`
 * - macOS: `~/Library/Application Support/com.elgato.StreamDeck`
 *   (dentro puede haber `ProfilesV2/` o los perfiles directamente)
 * - linux: `[]` (la app oficial no existe ahí)
 *
 * Solo lectura: jamás escribe en las carpetas de Elgato. Si un fichero
 * está bloqueado (la app oficial lo tiene abierto en Windows), se copia
 * a temp y se lee la copia.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DetectedStreamDeckProfile {
  /** UUID de la carpeta del perfil en ProfilesV2. */
  uuid: string;
  /** Nombre visible del perfil (o de la carpeta si no hay manifest). */
  name: string;
  /** DeviceType tal cual viene en el Manifest (número o texto). */
  deviceType: string | number | null;
  /** Dónde se encontró. */
  source: 'profilesv2';
  /** Carpeta del perfil (informativo, para importar). */
  path: string;
  updatedAt: number | null;
}

function appDataDir(env: NodeJS.ProcessEnv): string | null {
  if (env.APPDATA) return env.APPDATA;
  if (env.USERPROFILE) return path.join(env.USERPROFILE, 'AppData', 'Roaming');
  return null;
}

function homeDir(env: NodeJS.ProcessEnv): string | null {
  if (env.HOME) return env.HOME;
  try {
    const h = os.homedir();
    return h || null;
  } catch {
    return null;
  }
}

/**
 * Carpeta base donde buscar perfiles según plataforma.
 * `null` = plataforma sin soporte (linux) → no hay nada que escanear.
 */
export function streamDeckBaseDir(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (platform === 'win32') {
    const appData = appDataDir(env);
    if (!appData) return null;
    return path.join(appData, 'Elgato', 'StreamDeck', 'ProfilesV2');
  }
  if (platform === 'darwin') {
    const home = homeDir(env);
    if (!home) return null;
    return path.join(home, 'Library', 'Application Support', 'com.elgato.StreamDeck');
  }
  return null;
}

/** Lee un JSON sin bloquear al dueño: ante EPERM/EBUSY/EACCES lo copia a temp. */
export function readJsonTolerant(filePath: string): any | null {
  const parse = (buf: Buffer): any | null => {
    try {
      return JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
      return null;
    }
  };
  try {
    return parse(fs.readFileSync(filePath));
  } catch (err: any) {
    const code = err?.code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'EAGAIN') return null;
    try {
      const tmp = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'ld-sdscan-')),
        path.basename(filePath),
      );
      fs.copyFileSync(filePath, tmp);
      const out = parse(fs.readFileSync(tmp));
      try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch { /* noop */ }
      return out;
    } catch {
      return null;
    }
  }
}

function profileNameOf(manifest: any, fallback: string): string {
  const name = manifest?.Name ?? manifest?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : fallback;
}

function mtimeOf(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Escanea la carpeta base (solo lectura) y devuelve los perfiles
 * encontrados. Nunca lanza: sin carpeta o sin permiso → `[]`.
 */
export function detectStreamDeckProfiles(opts?: {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  baseDir?: string;
}): DetectedStreamDeckProfile[] {
  const platform = opts?.platform ?? process.platform;
  const env = opts?.env ?? process.env;
  const base = opts?.baseDir ?? streamDeckBaseDir(platform, env);
  if (!base) return [];
  // macOS: la base puede contener `ProfilesV2/` o los perfiles sueltos.
  const candidates = [path.join(base, 'ProfilesV2'), base];
  for (const dir of candidates) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const out: DetectedStreamDeckProfile[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const profileDir = path.join(dir, e.name);
      const manifestPath = path.join(profileDir, 'manifest.json');
      let manifest: any = null;
      try {
        if (fs.statSync(manifestPath).isFile()) manifest = readJsonTolerant(manifestPath);
      } catch {
        manifest = null;
      }
      // Sin manifest.json no es un perfil válido: se omite en silencio.
      if (!manifest) continue;
      out.push({
        uuid: e.name,
        name: profileNameOf(manifest, e.name),
        deviceType: manifest?.DeviceType ?? manifest?.deviceType ?? null,
        source: 'profilesv2',
        path: profileDir,
        updatedAt: mtimeOf(manifestPath),
      });
    }
    if (out.length > 0 || dir === base) return out;
  }
  return [];
}
