/**
 * Importación de plugins Elgato (.sdPlugin / .streamDeckPlugin / repo git).
 *
 * Fase 2: la instalación deja el paquete listo para ejecutar, no un stub:
 * tras copiar a dest/elgato + elgato-manifest.json + manifest.json se
 * resuelve el CodePath real (CodePathWin en win32, CodePathMac en darwin,
 * CodePath genérico), se verifica el fichero bajo elgato/ y, si hay
 * package.json, se instalan dependencias con `bun install` (fallback a
 * `npm install --omit=dev`, no bloqueante).
 * El manifest convertido se guarda habilitado por defecto cuando es
 * ejecutable: enabled=1 y status 'elgato-stopped' (el runtime fase 2 lo
 * arranca al importar); 'needs-runtime' + enabled=0 solo si el runtime es
 * nativo o falta el CodePath.
 * El runtime de compatibilidad (host Elgato, fase 2) lo activa.
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
 * Instala dependencias con bun (`bun install --production`, fallback a
 * `npm install --omit=dev`) si el paquete trae package.json
 * (en elgato/ o en la raíz del destino). Nunca tumba la importación:
 * devuelve un aviso para `last_error` o null si no hizo falta / fue bien.
 */
async function npmInstallIfNeeded(elgatoDir: string, destRoot: string, prog?: ElgatoProgress): Promise<string | null> {
  let target: string | null = null;
  try {
    if (fs.existsSync(path.join(elgatoDir, 'package.json'))) target = elgatoDir;
    else if (fs.existsSync(path.join(destRoot, 'package.json'))) target = destRoot;
  } catch { target = null; }
  if (!target) return null;
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
      const msg = `${label} excedió 5min (timeout anti-cuelgue): dependencias parciales; listo para activar con runtime Elgato pero puede fallar al arrancar.`;
      prog?.('deps', msg);
      return msg;
    }
    if (r.exitCode !== 0) {
      const msg = `${label} falló (no bloqueante, listo para activar con runtime Elgato): ${r.stderrTail.slice(0, 300)}`;
      prog?.('deps', msg);
      return msg;
    }
    prog?.('deps', 'Dependencias instaladas.');
    return null;
  } catch (e) {
    const msg = `${label} no ejecutado (no bloqueante, listo para activar con runtime Elgato): ${e instanceof Error ? e.message : String(e)}`;
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

async function doImportElgatoPlugin(
  db: DatabaseService,
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
    if (!report.compatible || !report.uuid) {
      return { pluginId: report.uuid ?? 'desconocido', report, installed: false, dryRun: !!opts.dryRun };
    }
    if (opts.dryRun) {
      return { pluginId: report.uuid, report, installed: false, dryRun: true };
    }
    prog?.('validate', `Manifest Elgato válido: ${report.uuid} v${report.semver}`);
    // CodePath efectivo para esta plataforma (el runtime fase 2 lo usará).
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
    // Copiar el paquete original bajo elgato/ para ejecución en fase 2
    const codeRoot = path.dirname(manifestPath);
    const elgatoDir = path.join(dest, 'elgato');
    fs.mkdirSync(elgatoDir, { recursive: true });
    copyRecursive(codeRoot, elgatoDir);
    // Si el build fue desde fuentes, el package.json con las deps runtime
    // (@elgato/streamdeck, @googleapis/...) está en el build-root (raíz del
    // repo), no bajo elgato/. Copiarlo a dest/ para que `bun install` deje
    // node_modules donde Node lo resuelve (dest/node_modules ← elgato/bin/).
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
    // NOTA: ya no se escribe ningún stub main.js. La ejecución la hace el
    // runtime Elgato (host fase 2) sobre elgato/<CodePath>; el loader delega
    // ahí cuando el manifest trae x-elgato (bridge en plugin-loader).
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));

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
      status = 'needs-runtime';
      lastError = isNative
        ? `CodePath nativo no ejecutable en LibreDeck (${codePathRel ?? report.codePath ?? 'desconocido'}): solo los plugins JS/Node se activan con runtime Elgato. Importado para diagnóstico.`
        : `CodePath ausente bajo elgato/ (${codePathRel ?? 'sin CodePath'}): no se encontró el fichero. Revisa el paquete.`;
      doneMsg = `Importado ${report.uuid} v${report.semver} (needs-runtime: ${!codeOk ? 'CodePath no encontrado' : 'runtime nativo'})`;
    } else {
      // JS válido: dependencias con bun (fallback npm, no bloqueante),
      // habilitado por defecto; el runtime fase 2 lo arranca al importar.
      const npmWarn = await npmInstallIfNeeded(elgatoDir, dest, prog);
      status = 'elgato-stopped';
      lastError = npmWarn;
      doneMsg = `Importado ${report.uuid} v${report.semver} (habilitado, arrancando runtime Elgato…)`;
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
 * Fallback fase 2: compilar el plugin desde fuentes cuando el repo git no
 * trae el binario (DeckCal: `bin/plugin.js` se genera con `bun run build`
 * desde `src/` vía rollup; el manifest vive en `<root>/com.x.sdPlugin/`).
 * Busca el build-root (package.json con scripts.build) entre codeRoot y
 * stage, ejecuta `bun install` (con devDeps, necesarias para compilar) +
 * `bun run build` (fallback a npm si bun no está disponible), y devuelve
 * true si el CodePath aparece bajo codeRoot.
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
        const hasBuild = typeof pkg?.scripts?.build === 'string';
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
  // Sin gestor de paquetes no hay build.
  const pm = await pickPackageManager();
  const bin = pmBin(pm);
  const instLabel = pm === 'bun' ? 'bun install' : 'npm install';
  const buildLabel = pm === 'bun' ? 'bun run build' : 'npm run build';
  prog?.('deps', `Fuentes detectadas en ${path.basename(buildRoot)}: compilando (${instLabel} + ${buildLabel})…`);
  const { spawnJob } = await import('../jobs/manager');
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
  const inst = await runPm(installAllArgs(pm), 8 * 60 * 1000, instLabel);
  if (!inst.ok) {
    prog?.('deps', `${instLabel} (build) falló, se importa sin compilar: ${inst.err.slice(0, 200)}`);
    return false;
  }
  const build = await runPm(['run', 'build'], 5 * 60 * 1000, buildLabel);
  if (!build.ok) {
    prog?.('deps', `${buildLabel} falló, se importa sin compilar: ${build.err.slice(0, 200)}`);
    return false;
  }
  return true;
}
