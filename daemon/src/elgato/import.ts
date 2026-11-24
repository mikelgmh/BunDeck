/**
 * Importación de plugins Elgato (.sdPlugin / .streamDeckPlugin / repo git).
 *
 * Modo shim (sin emulación por proceso): la instalación deja el paquete
 * listo para ejecutar DENTRO del Worker actual — tras copiar a dest/elgato
 * + elgato-manifest.json + manifest.json se genera el bridge
 * (`shim-bridge.js` + falso `@elgato/streamdeck`, ver `shim/loader-shim.ts`)
 * y el plugin corre en el `ExternalPluginWorker` estándar. Cero procesos
 * `node`, cero `Bun.serve` por plugin.
 *
 * - JS Keypad ejecutable: enabled=1, status 'active' (arranque perezoso:
 *   el Worker se crea en la primera pulsación).
 * - Nativo / dial-only / sin CodePath: se importa para diagnóstico con
 *   enabled=0 y status 'needs-manual' + motivo en `last_error`.
 * - Las dependencias solo se instalan si hay package.json con deps JS
 *   puras; si requiere nativas se deja needs-manual con motivo (la
 *   instalación nunca tumba la importación).
 */
import path from 'path';
import fs from 'fs';
import { getPluginsDir } from '../paths';
import { DatabaseService } from '../db';
import { folderForId } from '../plugin-loader';
import { analyzeElgatoManifest, convertElgatoManifest, findManifestRecursive, type ElgatoReport } from './manifest';

export type ElgatoProgress = (stage: string, message: string) => void;

export interface ElgatoImportSource {
  url?: string; // repo git o URL .streamDeckPlugin/.zip
  zipPath?: string; // fichero local
  dir?: string; // carpeta local (p.ej. repo clonado o .sdPlugin)
}

export interface ElgatoImportResult {
  pluginId: string;
  report: ElgatoReport;
  installed: boolean;
  dryRun: boolean;
  path?: string;
}

/**
 * Gestor de paquetes para compilar/instalar dependencias de plugins Elgato.
 * El daemon ya corre sobre Bun, así que `bun install` / `bun run build` es
 * lo natural (más rápido, sin Python ni node-gyp extra en la mayoría de
 * casos). Si `bun` no está en el PATH (binario compilado sin Bun al lado),
 * se usa `npm` como fallback. Los plugins se ejecutan con `node`, pero los
 * node_modules que genera bun son compatibles con node.
 */
export type PackageManager = 'bun' | 'npm';
let cachedPM: PackageManager | null = null;
export async function pickPackageManager(): Promise<PackageManager> {
  if (cachedPM) return cachedPM;
  try {
    const { spawnJob } = await import('../jobs/manager');
    const r = await spawnJob(['bun', '--version'], { timeoutMs: 10_000 });
    if (r.exitCode === 0) { cachedPM = 'bun'; return cachedPM; }
  } catch {}
  cachedPM = 'npm';
  return cachedPM;
}
/** argv completo para instalar solo dependencias runtime (sin devDeps). */
export function installArgs(pm: PackageManager): string[] {
  return pm === 'bun' ? ['install', '--production'] : ['install', '--omit=dev', '--no-audit', '--no-fund'];
}
/** argv completo para instalar TODO (incl. devDeps, necesario para compilar). */
export function installAllArgs(pm: PackageManager): string[] {
  return pm === 'bun' ? ['install'] : ['install', '--no-audit', '--no-fund'];
}
export function pmBin(pm: PackageManager): string {
  if (pm === 'bun') return 'bun';
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function stageFromSource(src: ElgatoImportSource, pluginsDir: string, prog?: ElgatoProgress): Promise<{ stage: string; origin: string }> {
  const stage = path.join(pluginsDir, `.staging_elgato_${Date.now()}`);
  fs.mkdirSync(stage, { recursive: true });
  if (src.dir) {
    copyRecursive(src.dir, stage);
    return { stage, origin: src.dir };
  }
  if (src.zipPath) {
    prog?.('extract', 'Extrayendo paquete…');
    await extractZip(src.zipPath, stage);
    return { stage, origin: `file:${path.basename(src.zipPath)}` };
  }
  if (src.url) {
    if (/\.streamDeckPlugin(\?|#|$)/i.test(src.url) || /\.zip(\?|#|$)/i.test(src.url)) {
      prog?.('download', 'Descargando paquete…');
      const tmp = path.join(pluginsDir, `.download_${Date.now()}.streamDeckPlugin`);
      const res = await fetch(src.url);
      if (!res.ok) throw new Error(`Descarga falló: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 200 * 1024 * 1024) throw new Error('Paquete excede 200MB');
      await fs.promises.writeFile(tmp, buf);
      try {
        prog?.('extract', 'Extrayendo paquete…');
        await extractZip(tmp, stage);
      } finally {
        try { fs.rmSync(tmp, { force: true }); } catch {}
      }
      return { stage, origin: src.url };
    }
    // Repo git (con timeout anti-cuelgue: 120s)
    prog?.('clone', 'Clonando repo…');
    {
      const { spawnJob } = await import('../jobs/manager');
      const r = await spawnJob(['git', 'clone', '--depth', '1', src.url, stage], { timeoutMs: 120_000 });
      if (r.cancelled) throw new Error('git clone cancelado');
      if (r.timedOut) throw new Error('git clone excedió 120s (timeout anti-cuelgue)');
      if (r.exitCode !== 0) throw new Error(`git clone falló: ${r.stderrTail.slice(0, 400)}`);
    }
    try { fs.rmSync(path.join(stage, '.git'), { recursive: true, force: true }); } catch {}
    return { stage, origin: src.url };
  }
  throw new Error('Origen requerido: url, zipPath o dir');
}

async function extractZip(zipPath: string, dest: string): Promise<void> {
  let AdmZip: any = null;
  try { AdmZip = (await import('adm-zip')).default; } catch {}
  if (AdmZip) {
    new AdmZip(zipPath).extractAllTo(dest, true);
    return;
  }
  const { spawnJob } = await import('../jobs/manager');
  const r = await spawnJob(['tar', '-xf', zipPath, '-C', dest], { timeoutMs: 60_000 });
  if (r.timedOut) throw new Error('Extracción excedió 60s (timeout anti-cuelgue)');
  if (r.exitCode !== 0) throw new Error(`Extracción falló: ${r.stderrTail.slice(0, 300)}`);
}

/** Resuelve el CodePath real según plataforma (Win→CodePathWin, Mac→CodePathMac). */
export function resolveElgatoCodePath(elgato: any): string | null {
  if (!elgato || typeof elgato !== 'object') return null;
  const { CodePath, CodePathMac, CodePathWin } = elgato;
  let pick: unknown = null;
  if (process.platform === 'win32') pick = CodePathWin ?? CodePath ?? CodePathMac;
  else if (process.platform === 'darwin') pick = CodePathMac ?? CodePath ?? CodePathWin;
  else pick = CodePath ?? CodePathWin ?? CodePathMac;
  if (typeof pick !== 'string' || !pick.trim()) return null;
  return pick.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Instala dependencias SOLO si el paquete trae package.json con dependencias
 * JS puras. Heurística de nativas: si alguna dep es conocida por requerir
 * compilación (o hay binding.gyp / .gyp), NO se instala y se devuelve el
 * motivo (el plugin quedará needs-manual). Nunca tumba la importación.
 */

/** Heurística de dependencias nativas (requieren compilación fuera del Worker). */
function hasNativeRequirement(target: string, deps: Record<string, string>): string | null {
  const KNOWN_NATIVE = [
    'node-gyp', 'prebuild-install', 'bindings', 'node-addon-api', 'nan',
    'node-hid', 'usb', 'serialport', 'sqlite3', 'better-sqlite3', 'sharp',
    'canvas', 'robotjs', 'iohook', 'uiohook-napi', 'electron',
  ];
  const names = Object.keys(deps);
  const hit = names.find((n) => KNOWN_NATIVE.some((k) => n === k || n.startsWith(`${k}-`)));
  if (hit) return `dependencia nativa '${hit}'`;
  try {
    const files = fs.readdirSync(target);
    if (files.some((f) => f === 'binding.gyp' || f.endsWith('.gyp') || f.endsWith('.gypi'))) {
      return 'binding.gyp presente (módulo nativo)';
    }
  } catch {}
  return null;
}

async function npmInstallIfNeeded(elgatoDir: string, destRoot: string, prog?: ElgatoProgress): Promise<string | null> {
  let target: string | null = null;
  try {
    if (fs.existsSync(path.join(elgatoDir, 'package.json'))) target = elgatoDir;
    else if (fs.existsSync(path.join(destRoot, 'package.json'))) target = destRoot;
  } catch { target = null; }
  if (!target) return null;
  // Sin deps declaradas no hay nada que instalar.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.optionalDependencies ?? {}) };
    if (Object.keys(deps).length === 0) return null;
    // Nativas: no instalables por el shim → needs-manual con motivo.
    const nativeHint = hasNativeRequirement(target, deps);
    if (nativeHint) return `Sin instalar dependencias (${nativeHint}); el shim solo ejecuta JS puro.`;
  } catch { /* si no se puede leer, se intenta instalar (no bloqueante) */ }
  const cwd = target;
  const pm = await pickPackageManager();
  const bin = pmBin(pm);
  const label = pm === 'bun' ? 'bun install --production' : 'npm install --omit=dev';
  prog?.('deps', `Instalando dependencias (${label})…`);
  try {
    const { spawnJob } = await import('../jobs/manager');
    const r = await spawnJob([bin, ...installArgs(pm)], {
      cwd, timeoutMs: 5 * 60 * 1000,
      beatOnOutput: (s, m) => prog?.(s, m),
    });
    if (r.cancelled) return `${label} cancelado por el usuario (no bloqueante).`;
    if (r.timedOut) {
      const msg = `${label} excedió 5min (timeout anti-cuelgue): dependencias parciales; el shim puede fallar al arrancar.`;
      prog?.('deps', msg);
      return msg;
    }
    if (r.exitCode !== 0) {
      const msg = `${label} falló (no bloqueante, el shim puede fallar al arrancar): ${r.stderrTail.slice(0, 300)}`;
      prog?.('deps', msg);
      return msg;
    }
    prog?.('deps', 'Dependencias instaladas.');
    return null;
  } catch (e) {
    const msg = `${label} no ejecutado (no bloqueante, el shim puede fallar al arrancar): ${e instanceof Error ? e.message : String(e)}`;
    prog?.('deps', msg);
    return msg;
  }
}

export async function importElgatoPlugin(
  db: DatabaseService,
  src: ElgatoImportSource,
  opts: { dryRun?: boolean; onProgress?: ElgatoProgress; timeoutMs?: number; jobKey?: string } = {}
): Promise<ElgatoImportResult> {
  const { getJobManager } = await import('../jobs/manager');
  const key = opts.jobKey ?? `elgato-import:${src.url ?? src.zipPath ?? src.dir ?? 'local'}`;
  return getJobManager().run(key, async (ctx) => {
    const prog: ElgatoProgress = (stage, message) => {
      ctx.beat(stage, message);
      opts.onProgress?.(stage, message);
    };
    return doImportElgatoPlugin(db, src, { dryRun: opts.dryRun, onProgress: prog });
  }, {
    timeoutMs: opts.timeoutMs ?? 15 * 60 * 1000,
    onEvent: () => {},
  });
}

/**
 * Instalación de diagnóstico para paquetes Elgato NO ejecutables en el shim
 * (nativo, dial-only, manifest roto): copia el paquete + manifest mínimo con
 * `x-elgato.unsupported`, APAGADO (enabled=0) y status 'needs-manual' con el
 * motivo en `last_error`. Nunca lanza por el contenido del paquete.
 */
async function installNeedsManual(
  db: DatabaseService,
  pluginsDir: string,
  stage: string,
  origin: string,
  elgato: any,
  report: ElgatoReport,
  prog?: ElgatoProgress,
): Promise<ElgatoImportResult> {
  const { needsManualReason } = await import('./shim/loader-shim');
  const uuid = typeof report.uuid === 'string' && report.uuid ? report.uuid : 'desconocido';
  const reason = needsManualReason(report);
  const pluginId = uuid === 'desconocido' ? `elgato-desconocido-${Date.now()}` : uuid;
  const folder = folderForId(pluginId);
  const dest = path.join(pluginsDir, folder);
  if (fs.existsSync(dest)) throw new Error(`Plugin ${pluginId} ya existe`);
  prog?.('activate', 'Paquete no ejecutable en el shim: instalando para diagnóstico…');
  fs.mkdirSync(dest, { recursive: true });
  const codeRoot = path.dirname(findManifestRecursive(stage) ?? stage);
  const elgatoDir = path.join(dest, 'elgato');
  fs.mkdirSync(elgatoDir, { recursive: true });
  try { copyRecursive(codeRoot, elgatoDir); } catch {}
  try { fs.writeFileSync(path.join(dest, 'elgato-manifest.json'), JSON.stringify(elgato ?? {}, null, 2)); } catch {}
  const manifest = {
    id: pluginId,
    name: (elgato as any)?.Name ?? pluginId,
    version: report.semver ?? '0.0.0',
    description: (elgato as any)?.Description ?? 'Plugin Elgato no ejecutable en el shim (diagnóstico)',
    author: (elgato as any)?.Author ?? 'desconocido',
    engine: '>=1.5.0',
    apiVersion: '2.1',
    permissions: [],
    actions: [],
    'x-elgato': {
      uuid, elgatoVersion: report.elgatoVersion ?? null, runtime: report.runtime,
      codePath: report.codePath ?? null, controllers: report.controllers ?? [],
      originalActions: [], unsupported: report.reasons, shim: { version: 2, mode: 'needs-manual' },
    },
  };
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));
  db.upsertPluginRecord({
    id: pluginId, name: manifest.name, version: manifest.version, manifest,
    enabled: 0, source_type: 'elgato', origin, status: 'needs-manual', last_error: reason,
  } as any);
  prog?.('done', `Importado ${pluginId} para diagnóstico (needs-manual)`);
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
  return { pluginId, report, installed: true, dryRun: false, path: dest };
}

async function doImportElgatoPlugin(  db: DatabaseService,
  src: ElgatoImportSource,
  opts: { dryRun?: boolean; onProgress?: ElgatoProgress } = {}
): Promise<ElgatoImportResult> {
  const pluginsDir = getPluginsDir();
  await fs.promises.mkdir(pluginsDir, { recursive: true });
  const prog = opts.onProgress;
  const { stage, origin } = await stageFromSource(src, pluginsDir, prog);
  try {
    prog?.('detect', 'Buscando manifest Elgato…');
    const manifestPath = findManifestRecursive(stage);
    if (!manifestPath) {
      throw new Error('No se encontró manifest Elgato (*.sdPlugin/manifest.json con UUID/Actions/CodePath) en el paquete');
    }
    const elgato = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
    const report = analyzeElgatoManifest(elgato);
    if (opts.dryRun) {
      return { pluginId: report.uuid ?? 'desconocido', report, installed: false, dryRun: true };
    }
    // Incompatible (nativo / dial-only / manifest roto): se instala igual
    // para diagnóstico pero APAGADO y en needs-manual con el motivo.
    if (!report.compatible || !report.uuid) {
      return installNeedsManual(db, pluginsDir, stage, origin, elgato, report, prog);
    }
    prog?.('validate', `Manifest Elgato válido: ${report.uuid} v${report.semver}`);
    // CodePath efectivo para esta plataforma (el shim lo usará).
    const codePathRel = resolveElgatoCodePath(elgato);
    // Si el CodePath no existe en el staging (p.ej. DeckCal en git sin compilar:
    // el repo trae src/ + package.json y bin/plugin.js se genera con build),
    // intentar compilar desde fuentes antes de copiar.
    try {
      const codeRootPre = path.dirname(manifestPath);
      const preExists = codePathRel && !codePathRel.includes('..') && !path.isAbsolute(codePathRel)
        ? fs.existsSync(path.join(codeRootPre, codePathRel))
        : true;
      if (!preExists) {
        const built = await tryBuildElgatoFromSource(stage, codeRootPre, prog);
        if (built) prog?.('activate', 'Compilado desde fuentes (bin generado).');
      }
    } catch (e) {
      prog?.('activate', `Build desde fuentes no disponible: ${e instanceof Error ? e.message : String(e)}`);
    }
    const manifest = convertElgatoManifest(elgato, report);
    if (codePathRel) {
      manifest['x-elgato'] = {
        ...(manifest['x-elgato'] ?? {}),
        codePath: codePathRel,
        platform: process.platform,
      };
    }
    const folder = folderForId(report.uuid);
    const dest = path.join(pluginsDir, folder);
    // Activación simple (sin backup: es primera instalación; si existe, error)
    if (fs.existsSync(dest)) throw new Error(`Plugin ${report.uuid} ya existe`);
    prog?.('activate', 'Instalando paquete Elgato…');
    fs.mkdirSync(dest, { recursive: true });
    // Copiar el paquete original bajo elgato/ para ejecución en el Worker
    const codeRoot = path.dirname(manifestPath);
    const elgatoDir = path.join(dest, 'elgato');
    fs.mkdirSync(elgatoDir, { recursive: true });
    copyRecursive(codeRoot, elgatoDir);
    // Si el build fue desde fuentes, el package.json con las deps runtime
    // (@elgato/streamdeck, @googleapis/...) está en el build-root (raíz del
    // repo), no bajo elgato/. Copiarlo a dest/ para que `bun install` deje
    // node_modules donde el bridge lo resuelve (dest/node_modules).
    // También se copia el lockfile que exista (bun.lock o package-lock.json).
    try {
      const top = path.resolve(stage);
      let cur = path.resolve(codeRoot);
      while (true) {
        const cand = path.join(cur, 'package.json');
        if (fs.existsSync(cand) && !fs.existsSync(path.join(elgatoDir, 'package.json')) && !fs.existsSync(path.join(dest, 'package.json'))) {
          try {
            const pkg = JSON.parse(fs.readFileSync(cand, 'utf8'));
            if (pkg?.dependencies || pkg?.scripts?.build) {
              fs.copyFileSync(cand, path.join(dest, 'package.json'));
              try {
                for (const lock of ['bun.lock', 'package-lock.json']) {
                  const srcLock = path.join(cur, lock);
                  if (fs.existsSync(srcLock)) {
                    fs.copyFileSync(srcLock, path.join(dest, lock));
                    break;
                  }
                }
              } catch {}
              break;
            }
          } catch {}
        }
        if (cur === top) break;
        const parent = path.dirname(cur);
        if (parent === cur || !cur.startsWith(top)) break;
        cur = parent;
      }
    } catch {}
    fs.writeFileSync(path.join(dest, 'elgato-manifest.json'), JSON.stringify(elgato, null, 2));

    // Verificar que el CodePath existe bajo elgato/ (relativo, sin escapes).
    let codeOk = false;
    if (codePathRel && !codePathRel.includes('..') && !path.isAbsolute(codePathRel)) {
      try { codeOk = fs.statSync(path.join(elgatoDir, codePathRel)).isFile(); }
      catch { codeOk = false; }
    }
    const isNative = report.runtime === 'native';
    const runnable = !isNative && !!codePathRel && codeOk;
    let status: string;
    let lastError: string | null;
    let doneMsg: string;
    if (!runnable) {
      // Sin ejecutable JS: diagnóstico apagado en needs-manual.
      const { needsManualReason } = await import('./shim/loader-shim');
      status = 'needs-manual';
      lastError = isNative
        ? `CodePath nativo no ejecutable en el shim (${codePathRel ?? report.codePath ?? 'desconocido'}): solo JS puro corre en el Worker. ${needsManualReason(report)}`
        : `CodePath ausente bajo elgato/ (${codePathRel ?? 'sin CodePath'}): no se encontró el fichero. Revisa el paquete.`;
      manifest.main = undefined as any;
      delete (manifest as any).main;
      fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));
      doneMsg = `Importado ${report.uuid} v${report.semver} (needs-manual: ${!codeOk ? 'CodePath no encontrado' : 'runtime nativo'})`;
    } else {
      // JS válido: deps puras con bun (fallback npm, no bloqueante), bridge
      // del shim y habilitado por defecto (arranque perezoso en el Worker).
      const npmWarn = await npmInstallIfNeeded(elgatoDir, dest, prog);
      const { writeShimFiles, resolveCodePathFor, isShimCapable, detectElgatoCodeStyle, SHIM_BRIDGE_VERSION } = await import('./shim/loader-shim');
      const { buildSettingsSchema } = await import('./shim/sdk');
      // El estilo (sdk vs raw) se detecta del CodePath instalado: el raw
      // también es capaz (adaptador en-Worker) si hay CodePath tras el build.
      let codeText: string | null = null;
      try {
        const abs = codePathRel && !codePathRel.includes('..') && !path.isAbsolute(codePathRel)
          ? path.join(elgatoDir, codePathRel)
          : null;
        if (abs && fs.statSync(abs).isFile() && fs.statSync(abs).size <= 2 * 1024 * 1024) {
          codeText = fs.readFileSync(abs, 'utf8');
        }
      } catch { codeText = null; }
      if (!isShimCapable(report, codeText)) {
        throw new Error(`Plugin no ejecutable en el shim: ${report.reasons.join('; ')}`);
      }
      if (codeText) prog?.('validate', `Estilo Elgato detectado: ${detectElgatoCodeStyle(codeText)} (bridge ${codeText && detectElgatoCodeStyle(codeText) === 'raw' ? 'raw en-Worker' : 'SDK'})`);
      // 1 acción LibreDeck por acción Elgato Keypad (del informe, no por
      // índice: las omitidas —dial— romperían la alineación por posición).
      const actions = report.actions
        .filter((a) => a.status === 'ok')
        .map((a) => ({ shortId: String(a.id), uuid: String(a.uuid) }));
      const { bridgeFile, codeStyle: bridgeStyle, entryRel } = writeShimFiles({
        dest, elgatoDir, pluginId: report.uuid,
        codeRel: resolveCodePathFor(elgato) ?? codePathRel, actions,
        elgatoUuid: report.uuid,
      });
      manifest.main = bridgeFile;
      // Settings mínimos: schema generado desde defaults del paquete.
      const schema = buildSettingsSchema((elgato as any).SettingsDefaults ?? null);
      if (schema) manifest.settingsSchema = schema;
      manifest.permissions = Array.from(new Set([...(manifest.permissions ?? []), 'network', 'filesystem']));
      manifest['x-elgato'] = {
        ...(manifest['x-elgato'] ?? {}),
        codePath: codePathRel,
        platform: process.platform,
        codeStyle: bridgeStyle,
        bridgeEntry: entryRel,
        shim: { version: SHIM_BRIDGE_VERSION, mode: 'worker-lazy' },
      };
      fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));
      status = 'active';
      lastError = npmWarn;
      doneMsg = `Importado ${report.uuid} v${report.semver} (shim activo, arranque perezoso)`;
    }

    db.upsertPluginRecord({
      id: report.uuid,
      name: manifest.name,
      version: manifest.version,
      manifest,
      enabled: runnable ? 1 : 0,
      source_type: 'elgato',
      origin,
      status,
      last_error: lastError,
    } as any);

    prog?.('done', doneMsg);
    return { pluginId: report.uuid, report, installed: true, dryRun: false, path: dest };
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
  }
}

function copyRecursive(src: string, dest: string) {
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === '.git' || ent.name === 'node_modules') continue;
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyRecursive(s, d); }
    else fs.copyFileSync(s, d);
  }
}

/**
 * Fallback: compilar el plugin desde fuentes cuando el repo git no trae el
 * binario (DeckCal: `bin/plugin.js` se genera con build desde `src/` vía
 * rollup; AUS-UV: `bin/plugin.js` se genera con `npm run bundle` vía
 * esbuild; SEMS: `bin/plugin.js` vía `rollup -c`).
 * Busca el build-root (package.json con scripts.build/bundle) entre codeRoot
 * y stage, ejecuta install (con devDeps, necesarias para compilar) + el
 * script de build (`build`, con fallback a `bundle` para repos solo-esbuild
 * como AUS-UV; si el gestor principal falla se reintenta una vez con npm),
 * y devuelve true SOLO si el CodePath aparece bajo codeRoot.
 * Nunca lanza: devuelve false si no hay build-root o falla.
 */
async function tryBuildElgatoFromSource(stage: string, codeRoot: string, prog?: ElgatoProgress): Promise<boolean> {
  const norm = (p: string) => path.resolve(p);
  let buildRoot: string | null = null;
  let cur = norm(codeRoot);
  const top = norm(stage);
  while (true) {
    try {
      const pkgPath = path.join(cur, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const hasBuild = typeof pkg?.scripts?.build === 'string' || typeof pkg?.scripts?.bundle === 'string';
        const looksElgato = JSON.stringify(pkg?.dependencies ?? {}).includes('streamdeck') ||
          JSON.stringify(pkg?.devDependencies ?? {}).includes('elgato');
        if (hasBuild || looksElgato) { buildRoot = cur; break; }
      }
    } catch {}
    if (cur === top) break;
    const parent = path.dirname(cur);
    if (parent === cur || !cur.startsWith(top)) break;
    cur = parent;
  }
  if (!buildRoot) return false;
  // CodePath esperado (relativo a codeRoot): solo éxito si aparece tras compilar.
  let codeRel: string | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(codeRoot, 'manifest.json'), 'utf8'));
    codeRel = resolveElgatoCodePath(raw);
  } catch { codeRel = 'bin/plugin.js'; }
  const normRoot = norm(codeRoot);
  const codeExists = (): boolean => {
    if (!codeRel || codeRel.includes('..') || path.isAbsolute(codeRel)) return false;
    try { return fs.statSync(path.join(normRoot, codeRel)).isFile(); }
    catch { return false; }
  };
  if (codeExists()) return true;
  let pkgScripts: Record<string, string> = {};
  try {
    pkgScripts = JSON.parse(fs.readFileSync(path.join(buildRoot, 'package.json'), 'utf8'))?.scripts ?? {};
  } catch { pkgScripts = {}; }
  // `build` primero (rollup/esbuild/test+bundle), `bundle` como fallback
  // directo (repos solo-esbuild como AUS-UV cuyo `build` exige tests con red).
  const scripts = ['build', 'bundle'].filter((s) => typeof pkgScripts[s] === 'string');
  if (scripts.length === 0) return false;
  const firstPm = await pickPackageManager();
  const pms: PackageManager[] = firstPm === 'bun' ? ['bun', 'npm'] : ['npm'];
  const { spawnJob } = await import('../jobs/manager');
  for (const pm of pms) {
    const bin = pmBin(pm);
    const instLabel = pm === 'bun' ? 'bun install' : 'npm install';
    const runPm = async (args: string[], timeoutMs: number, label: string): Promise<{ ok: boolean; err: string }> => {
      const r = await spawnJob([bin, ...args], {
        cwd: buildRoot, timeoutMs,
        beatOnOutput: (s, m) => prog?.(s, `${label}: ${m.slice(-120)}`),
      });
      if (r.cancelled) return { ok: false, err: 'cancelado por el usuario' };
      if (r.timedOut) return { ok: false, err: `timeout anti-cuelgue ${Math.round(timeoutMs / 1000)}s` };
      if (r.exitCode !== 0) return { ok: false, err: r.stderrTail.slice(-500) || `exit ${r.exitCode}` };
      return { ok: true, err: '' };
    };
    prog?.('deps', `Fuentes detectadas en ${path.basename(buildRoot)}: compilando (${instLabel} + ${scripts.map((s) => `${pm === 'bun' ? 'bun' : 'npm'} run ${s}`).join(' → ')})…`);
    const inst = await runPm(installAllArgs(pm), 8 * 60 * 1000, instLabel);
    if (!inst.ok) {
      prog?.('deps', `${instLabel} (build) falló, se importa sin compilar: ${inst.err.slice(0, 200)}`);
      continue; // probar con el siguiente gestor antes de rendirse
    }
    for (const script of scripts) {
      const label = `${pm === 'bun' ? 'bun' : 'npm'} run ${script}`;
      const built = await runPm(['run', script], 5 * 60 * 1000, label);
      if (!built.ok) {
        prog?.('deps', `${label} falló, se prueba siguiente: ${built.err.slice(0, 200)}`);
        continue;
      }
      if (codeExists()) {
        prog?.('deps', `${label}: CodePath generado (${codeRel}).`);
        return true;
      }
      prog?.('deps', `${label} OK pero sin ${codeRel}: se prueba siguiente.`);
    }
    if (codeExists()) return true;
  }
  return codeExists();
}
