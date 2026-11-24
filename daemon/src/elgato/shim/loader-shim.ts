/**
 * loader-shim.ts — Integración del shim Elgato en el Worker actual.
 *
 * Genera, en la carpeta instalada del plugin (`<data>/plugins/<id>/`):
 *  1. `elgato-shim-sdk.js` — copia transpilada de `shim/sdk.ts` (el falso
 *     `@elgato/streamdeck`). Sin dependencias, sin procesos extra.
 *  2. `elgato/node_modules/@elgato/streamdeck/` (+ `node_modules/...`) —
 *     stub que re-exporta el SDK, para que el CodePath ORIGINAL resuelva
 *     `@elgato/streamdeck` sin tocar sus fuentes ni depender de npm.
 *  3. `shim-bridge.js` — entry LibreDeck (`register(api)`) que importa el
 *     CodePath (side-effect: se auto-registra en el shim) y publica UNA
 *     acción LibreDeck por cada acción Elgato Keypad.
 *
 * El manifest convertido apunta `main: 'shim-bridge.js'`, así el plugin
 * corre en el `ExternalPluginWorker` estándar: timeout real con
 * `Worker.terminate()`, permisos mediados en el padre, sin `node -port`
 * ni `Bun.serve` por plugin.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ElgatoReport } from '../manifest';
import { detectElgatoCodeStyle, type ElgatoCodeStyle } from './detect';

/** Re-exportado por comodidad (implementación en sdk.ts). */
export { buildSettingsSchema } from './sdk';
/** Re-exportado por comodidad (implementación en detect.ts). */
export { detectElgatoCodeStyle, importsElgatoSdk, looksLikeRawProtocol } from './detect';
export type { ElgatoCodeStyle } from './detect';

/** Inactividad tras la cual se libera el Worker (ms). */
export const SHIM_IDLE_MS = 60_000;
/** Versión del formato bridge generado. */
export const SHIM_BRIDGE_VERSION = 2;

/**
 * Feature-flag: `LIBREDECK_ELGATO_SHIM=0|false` vuelve al runtime legacy
 * por proceso (`elgato/host.ts`, deprecated). Por defecto el shim está
 * activo: cero procesos `node` y cero `Bun.serve` por plugin.
 */
export function isShimEnabled(): boolean {
  const v = (process.env.LIBREDECK_ELGATO_SHIM ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

/** ¿El informe de análisis es ejecutable en el shim? (JS + Keypad + CodePath). */
export function isShimCapable(report: ElgatoReport, codeText?: string | null): boolean {
  if (!report || !report.compatible) return false;
  if (report.runtime === 'native') return false;
  if (!report.codePath) return false;
  // Camino raw (protocolo WebSocket en crudo, sin SDK): también es capaz —
  // el bridge genera el adaptador raw en-Worker (sin procesos extra).
  if (typeof codeText === 'string' && codeText.trim()) {
    const style = detectElgatoCodeStyle(codeText);
    if (style === 'raw') return report.actions.some((a) => a.status === 'ok');
  }
  return report.actions.some((a) => a.status === 'ok');
}

/** Motivo `needs-manual` para el registro de diagnóstico. */
export function needsManualReason(report: ElgatoReport, codeText?: string | null): string {
  const reasons = [...(report.reasons ?? [])];
  if (report.runtime === 'native') {
    reasons.unshift('CodePath nativo (exe/dll/so): el shim solo ejecuta JS dentro del Worker');
  }
  if (!report.actions.some((a) => a.status === 'ok')) {
    reasons.unshift('Sin acciones Keypad (dial-only): sin equivalente hardware en LibreDeck');
  }
  if (!report.codePath) {
    // Sin CodePath el estilo raw no tiene adaptador posible: el binario
    // (esbuild/rollup) hay que generarlo primero (`npm run bundle/build`).
    const style = typeof codeText === 'string' && codeText.trim() ? detectElgatoCodeStyle(codeText) : 'unknown';
    if (style === 'raw') {
      reasons.unshift('Raw sin adaptador: el plugin habla WebSocket en crudo pero no hay CodePath ejecutable (genera bin/plugin.js con esbuild/rollup y reimporta)');
    } else {
      reasons.unshift('Sin CodePath ejecutable en el paquete');
    }
  }
  return `needs-manual (shim v1): ${reasons.join('; ') || 'no analizable'}`;
}

/** Elige el CodePath según plataforma (Win→CodePathWin, Mac→CodePathMac). */
export function resolveCodePathFor(elgato: any, platform: NodeJS.Platform = process.platform): string | null {
  if (!elgato || typeof elgato !== 'object') return null;
  const { CodePath, CodePathMac, CodePathWin } = elgato;
  let pick: unknown = null;
  if (platform === 'win32') pick = CodePathWin ?? CodePath ?? CodePathMac;
  else if (platform === 'darwin') pick = CodePathMac ?? CodePath ?? CodePathWin;
  else pick = CodePath ?? CodePathWin ?? CodePathMac;
  if (typeof pick !== 'string' || !pick.trim()) return null;
  return pick.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

export interface ShimActionMap {
  shortId: string;
  uuid: string;
}

export interface WriteShimOpts {
  /** Raíz instalada del plugin (`<data>/plugins/<id>/`). */
  dest: string;
  /** Copia del paquete original (`<dest>/elgato`). */
  elgatoDir: string;
  pluginId: string;
  /** CodePath relativo dentro de elgatoDir (p.ej. `bin/plugin.js`). */
  codeRel: string;
  actions: ShimActionMap[];
  /** UUID Elgato del plugin (camino raw: `-pluginUUID` y registro). */
  elgatoUuid?: string;
  /** Forzar estilo (`sdk` por defecto); si se omite se detecta del CodePath. */
  codeStyle?: ElgatoCodeStyle;
}

export interface WriteShimResult {
  sdkFile: string; // nombre base dentro de dest
  bridgeFile: string; // nombre base dentro de dest (manifest.main)
  codeStyle: ElgatoCodeStyle;
  /** Entry que importa el bridge, relativo a dest (raw: copia generada). */
  entryRel: string;
}

function shimSourcePath(file: string): string {
  try {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), file);
  } catch {
    return path.join(path.dirname(new URL(import.meta.url).pathname), file);
  }
}

function relPosix(fromDir: string, toFile: string): string {
  return path.relative(fromDir, toFile).split(path.sep).join('/');
}

/**
 * Transpila un fuente del shim (`sdk.ts`, `raw-transport.ts`) → JS (Bun.Transpiler)
 * o lo copia como .ts (fallback). Reescribe los imports relativos al nombre
 * materializado del SDK (el transpilador no los toca).
 */
function materialize(dest: string, srcName: string, outBase: string, sdkFile?: string): string {
  const src = fs.readFileSync(shimSourcePath(srcName), 'utf8');
  const js = `${outBase}.js`;
  const rewrite = (text: string): string => {
    if (!sdkFile) return text;
    return text.replace(/from\s+['"]\.\/sdk['"]/g, `from "./${sdkFile}"`);
  };
  try {
    const T = (globalThis as any).Bun?.Transpiler;
    if (typeof T === 'function') {
      const out = new T({ loader: 'ts' }).transformSync(src, 'ts');
      fs.writeFileSync(path.join(dest, js), rewrite(out));
      return js;
    }
  } catch { /* fallback abajo */ }
  fs.writeFileSync(path.join(dest, `${outBase}.ts`), rewrite(src));
  return `${outBase}.ts`;
}

/** Transpila sdk.ts → JS (Bun.Transpiler) o lo copia como .ts (fallback). */
function materializeSdk(dest: string): string {
  return materialize(dest, 'sdk.ts', 'elgato-shim-sdk');
}

function writeSdkStub(packageRoot: string, sdkAbs: string): void {
  const stubDir = path.join(packageRoot, 'node_modules', '@elgato', 'streamdeck');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(
    path.join(stubDir, 'package.json'),
    JSON.stringify({ name: '@elgato/streamdeck', version: '0.0.0-shim-libredeck', type: 'module', main: './index.js' })
  );
  const rel = relPosix(stubDir, sdkAbs);
  const prefix = rel.startsWith('.') ? rel : `./${rel}`;
  fs.writeFileSync(
    path.join(stubDir, 'index.js'),
    `// Stub LibreDeck: redirige '@elgato/streamdeck' al shim en-Worker.\n` +
    `export * from "${prefix}";\n` +
    `import __shimDefault from "${prefix}";\n` +
    `export default __shimDefault;\n`
  );
}

/** Stub `ws` → socket virtual del transporte raw (solo camino raw). */
function writeWsStub(packageRoot: string, rawAbs: string): void {
  const stubDir = path.join(packageRoot, 'node_modules', 'ws');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(
    path.join(stubDir, 'package.json'),
    JSON.stringify({ name: 'ws', version: '0.0.0-shim-libredeck', type: 'module', main: './index.js' })
  );
  const rel = relPosix(stubDir, rawAbs);
  const prefix = rel.startsWith('.') ? rel : `./${rel}`;
  fs.writeFileSync(
    path.join(stubDir, 'index.js'),
    `// Stub LibreDeck: redirige 'ws' al socket virtual en-Worker (sin red).\n` +
    `export { VirtualElgatoSocket as default, VirtualElgatoSocket as WebSocket, VirtualElgatoSocket, getRawHost, createRawHost, installRawGlobals, RAW_TRANSPORT_VERSION } from "${prefix}";\n`
  );
}

const BRIDGE_TEMPLATE = `// AUTO-GENERADO por LibreDeck (elgato shim, bridge v__BRIDGE_VERSION__). No editar.
// Una acción LibreDeck por acción Elgato Keypad; el CodePath original se
// importa tal cual y se auto-registra en el falso @elgato/streamdeck.
import { createElgatoShim } from "__SDK_REL__";
import "__CODE_REL__";

const PLUGIN_ID = "__PLUGIN_ID__";
const ACTIONS = __ACTIONS_JSON__;

let shim = null;

export function register(api) {
  shim = createElgatoShim(api, { pluginId: PLUGIN_ID, elgatoDir: "elgato", actions: ACTIONS });
  for (const a of ACTIONS) {
    api.onAction(a.shortId, async (params, context) => shim.fireKey(a.uuid, { params, context }));
  }
}
`;

const RAW_BRIDGE_TEMPLATE = `// AUTO-GENERADO por LibreDeck (elgato shim raw, bridge v__BRIDGE_VERSION__). No editar.
// El CodePath habla el protocolo WebSocket en crudo (sin SDK): ANTES de
// importarlo se instala el transporte virtual (socket + argv). El import es
// DINÁMICO a propósito: un static import se izaría y llegaría antes que los
// globales. Todo ocurre en el Worker actual, sin procesos ni servidores extra.
import { createRawHost, installRawGlobals } from "__RAW_REL__";

const PLUGIN_ID = "__PLUGIN_ID__";
const ELGATO_UUID = "__ELGATO_UUID__";
const REGISTER_EVENT = "__REGISTER_EVENT__";
const ACTIONS = __ACTIONS_JSON__;
const CODE_REL = "__CODE_REL__";

export async function register(api) {
  const host = createRawHost(api, { pluginId: PLUGIN_ID, elgatoDir: "elgato", actions: ACTIONS, elgatoUuid: ELGATO_UUID, registerEvent: REGISTER_EVENT });
  installRawGlobals(host, { elgatoUuid: ELGATO_UUID, registerEvent: REGISTER_EVENT });
  await import(CODE_REL);
  for (const a of ACTIONS) {
    api.onAction(a.shortId, async (params, context) => host.fireKey(a.uuid, { params, context }));
  }
}
`;

/** Lee el CodePath instalado (si existe) para detectar el estilo. */
function readCodeText(elgatoDir: string, codeRel: string): string | null {
  try {
    if (!codeRel || codeRel.includes('..') || path.isAbsolute(codeRel)) return null;
    const abs = path.join(elgatoDir, codeRel);
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/**
 * ¿El fuente importa el `ws` instalable (`from "ws"`, `import("ws")`,
 * `require("ws")`)? Los `ws://` de las URLs no cuentan.
 */
export function hasBareWsSpecifier(code: string): boolean {
  if (typeof code !== 'string') return false;
  return /from\s+['"]ws['"]/.test(code)
    || /import\s*\(\s*['"]ws['"]\s*\)/.test(code)
    || /require\s*\(\s*['"]ws['"]\s*\)/.test(code);
}

/**
 * Reescribe los especificadores `ws` del entry hacia el transporte virtual.
 *
 * Por qué: Bun trae un módulo `ws` incorporado con prioridad sobre
 * `node_modules` (ni `paths` de tsconfig ni `Bun.plugin(onResolve)` lo
 * ven), así que el stub `node_modules/ws` NO basta. La copia generada
 * (`shim-raw-entry.js`, junto al original para no romper sus imports
 * relativos) redirige `from "ws"` / `import("ws")` / `require("ws")` al
 * transporte en-Worker. Las fuentes originales no se tocan.
 */
export function rewriteWsSpecifier(code: string, rel: string): string {
  return code
    .replace(/from\s+(['"])ws\1/g, `from $1${rel}$1`)
    .replace(/import\s*\(\s*(['"])ws\1\s*\)/g, `import($1${rel}$1)`)
    .replace(/require\s*\(\s*(['"])ws\1\s*\)/g, `require($1${rel}$1)`);
}

/**
 * Preferencia de fuente raw: si el CodePath NO es estilo raw (p.ej. un
 * `bin/plugin.js` empaquetado con esbuild/rollup que lleva `ws` dentro y ya
 * no importa el SDK), busca un fuente raw entre los .js del paquete (misma
 * acción UUID) para usarlo como entry del bridge. Sin fuentes no hay
 * adaptador posible: devuelve null.
 */
export function findRawSourceEntry(
  elgatoDir: string, skipRel: string, actions: ShimActionMap[],
): string | null {
  const normSkip = skipRel.replace(/\\/g, '/');
  const uuids = new Set(actions.map((a) => a.uuid));
  // Agujas: UUIDs de acción + prefijos de plugin (`com.x.a` → `com.x`).
  for (const u of [...uuids]) {
    const dot = u.lastIndexOf('.');
    if (dot > 0) uuids.add(u.slice(0, dot));
  }
  const cands: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('shim-raw-entry')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), r, depth + 1); continue; }
      if (!/\.(m|c)?js$/.test(e.name)) continue;
      if (r === normSkip) continue;
      cands.push(r);
    }
  };
  walk(elgatoDir, '', 0);
  // Primero nivel superior (fuentes junto al manifest), luego el resto.
  cands.sort((a, b) => a.split('/').length - b.split('/').length);
  for (const r of cands) {
    const text = readCodeText(elgatoDir, r);
    if (!text || detectElgatoCodeStyle(text) !== 'raw') continue;
    if (uuids.size === 0 || [...uuids].some((u) => text.includes(u))) return r;
  }
  return null;
}

/** UUID Elgato para el bridge raw (explícito o prefijo común de las acciones). */
function elgatoUuidFor(opts: WriteShimOpts): string {
  if (opts.elgatoUuid && opts.elgatoUuid.trim()) return opts.elgatoUuid.trim();
  const uuids = opts.actions.map((a) => a.uuid).filter(Boolean);
  if (uuids.length > 0) {
    // Prefijo común hasta el último punto (`<plugin>.<short>` → `<plugin>`).
    const first = uuids[0].split('.');
    let len = first.length;
    for (const u of uuids.slice(1)) {
      const parts = u.split('.');
      let i = 0;
      while (i < len && i < parts.length && parts[i] === first[i]) i++;
      len = i;
    }
    if (len > 1) return first.slice(0, len).join('.');
    if (uuids.length === 1 && uuids[0].includes('.')) {
      return uuids[0].slice(0, uuids[0].lastIndexOf('.'));
    }
  }
  return opts.pluginId;
}

/** Escribe SDK + stubs + bridge. Idempotente (sobrescribe). */
export function writeShimFiles(opts: WriteShimOpts): WriteShimResult {
  const { dest, elgatoDir, pluginId, codeRel, actions } = opts;
  if (!codeRel || codeRel.includes('..') || path.isAbsolute(codeRel)) {
    throw new Error(`CodePath inválido para el shim: '${codeRel}'`);
  }
  const codeAbs = path.join(elgatoDir, codeRel);
  if (!fs.existsSync(codeAbs) || !fs.statSync(codeAbs).isFile()) {
    throw new Error(`CodePath no encontrado bajo elgato/: '${codeRel}'`);
  }
  const codeStyle: ElgatoCodeStyle = opts.codeStyle ?? detectElgatoCodeStyle(readCodeText(elgatoDir, codeRel));
  const sdkFile = materializeSdk(dest);
  const sdkAbs = path.join(dest, sdkFile);
  // El stub debe cubrir la resolución desde CUALQUIER profundidad bajo
  // elgato/ (bin/, src/, ...): se instala en elgato/ y en dest/.
  writeSdkStub(elgatoDir, sdkAbs);
  writeSdkStub(dest, sdkAbs);

  const bridgeFile = 'shim-bridge.js';
  let entryRelFromDest: string;
  {
    const codeRelFromDest = relPosix(dest, codeAbs);
    entryRelFromDest = codeRelFromDest.startsWith('.') ? codeRelFromDest : `./${codeRelFromDest}`;
  }
  let style = codeStyle;
  let bridge: string;
  let rawAbs: string | null = null;
  if (codeStyle === 'raw') {
    const rawFile = materialize(dest, 'raw-transport.ts', 'elgato-raw-transport', sdkFile);
    rawAbs = path.join(dest, rawFile);
    // El stub `ws` es solo fallback (otros runtimes): bajo Bun el `ws`
    // incorporado tiene prioridad, así que el entry se importa desde una
    // copia generada con `ws` reescrito al transporte virtual.
    writeWsStub(elgatoDir, rawAbs);
    writeWsStub(dest, rawAbs);

    // Entry efectivo: el CodePath si es raw con `ws` reescribible; si es un
    // bundle sin especificador `ws` (esbuild/rollup lo llevan dentro), se
    // prefiere la fuente raw del paquete (p.ej. AUS-UV: `plugin.js`).
    let entryRel = codeRel;
    let entryText = readCodeText(elgatoDir, entryRel);
    if (detectElgatoCodeStyle(entryText ?? '') !== 'raw' || !hasBareWsSpecifier(entryText ?? '')) {
      const srcEntry = findRawSourceEntry(elgatoDir, codeRel, actions);
      if (srcEntry) {
        entryRel = srcEntry;
        entryText = readCodeText(elgatoDir, entryRel);
      }
    }
    if (detectElgatoCodeStyle(entryText ?? '') === 'raw') {
      style = 'raw';
      const entryAbs = path.join(elgatoDir, entryRel);
      const entryDir = path.dirname(entryAbs);
      const ext = path.extname(entryAbs) || '.js';
      const genName = `shim-raw-entry${ext}`;
      const relToRaw = relPosix(entryDir, rawAbs);
      const rewritten = `// AUTO-GENERADO por LibreDeck (elgato shim raw). No editar: copia del entry\n` +
        `// original \`${entryRel}\` con el especificador "ws" redirigido al socket virtual\n` +
        `// en-Worker (Bun antepone su ws incorporado a node_modules; ver raw-transport.ts).\n` +
        rewriteWsSpecifier(entryText as string, relToRaw.startsWith('.') ? relToRaw : `./${relToRaw}`);
      fs.writeFileSync(path.join(entryDir, genName), rewritten);
      const genRel = relPosix(dest, path.join(entryDir, genName));
      entryRelFromDest = genRel.startsWith('.') ? genRel : `./${genRel}`;
    } else {
      // Sin fuente raw (solo bundle opaco): el bridge SDK lo intentará como
      // unknown; el estilo reportado sigue siendo el detectado del CodePath.
      style = detectElgatoCodeStyle(entryText ?? '');
    }
  }
  if (style === 'raw' && rawAbs) {
    const rawFile = path.basename(rawAbs);
    bridge = RAW_BRIDGE_TEMPLATE
      .split('__BRIDGE_VERSION__').join(String(SHIM_BRIDGE_VERSION))
      .split('__RAW_REL__').join(`./${rawFile}`)
      .split('__PLUGIN_ID__').join(pluginId.replace(/"/g, ''))
      .split('__ELGATO_UUID__').join(elgatoUuidFor(opts).replace(/"/g, ''))
      .split('__REGISTER_EVENT__').join('registerPlugin')
      .split('__ACTIONS_JSON__').join(JSON.stringify(actions))
      .split('"__CODE_REL__"').join(JSON.stringify(entryRelFromDest));
  } else {
    const sdkRelFromDest = `./${sdkFile}`;
    bridge = BRIDGE_TEMPLATE
      .split('__BRIDGE_VERSION__').join(String(SHIM_BRIDGE_VERSION))
      .split('__SDK_REL__').join(sdkRelFromDest)
      .split('__CODE_REL__').join(entryRelFromDest.startsWith('.') ? entryRelFromDest : `./${entryRelFromDest}`)
      .split('__PLUGIN_ID__').join(pluginId.replace(/"/g, ''))
      .split('__ACTIONS_JSON__').join(JSON.stringify(actions));
  }
  fs.writeFileSync(path.join(dest, bridgeFile), bridge);
  return { sdkFile, bridgeFile, codeStyle: style, entryRel: entryRelFromDest };
}

/**
 * Migración perezosa: si un plugin Elgato instalado (era host) no tiene
 * bridge, lo regenera desde `elgato-manifest.json` + `manifest.json`.
 * Devuelve `false` si no hay con qué regenerar (→ needs-manual).
 */
export function ensureShimBridge(dest: string): boolean {
  try {
    const manifestPath = path.join(dest, 'manifest.json');
    const rawPath = path.join(dest, 'elgato-manifest.json');
    if (!fs.existsSync(manifestPath) || !fs.existsSync(rawPath)) return false;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const elgatoRaw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
    const elgatoDir = path.join(dest, 'elgato');
    const bridgeAbs = path.join(dest, 'shim-bridge.js');
    if (manifest?.main === 'shim-bridge.js' && fs.existsSync(bridgeAbs)) return true;
    const codeRel = resolveCodePathFor(elgatoRaw);
    if (!codeRel) return false;
    const actions: ShimActionMap[] = Array.isArray(manifest?.actions)
      ? manifest.actions.map((a: any) => ({ shortId: String(a.id), uuid: resolveUuid(elgatoRaw, manifest, String(a.id)) }))
      : [];
    if (actions.some((a) => !a.uuid)) return false;
    writeShimFiles({ dest, elgatoDir, pluginId: String(manifest.id), codeRel, actions, elgatoUuid: String(elgatoRaw?.UUID ?? '') });
    manifest.main = 'shim-bridge.js';
    manifest['x-elgato'] = { ...(manifest['x-elgato'] ?? {}), shim: { version: SHIM_BRIDGE_VERSION, mode: 'worker-lazy' } };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return true;
  } catch {
    return false;
  }
}

function resolveUuid(elgatoRaw: any, manifest: any, shortId: string): string | null {
  const origs: string[] = Array.isArray(manifest?.['x-elgato']?.originalActions)
    ? manifest['x-elgato'].originalActions
    : [];
  // Primero por sufijo (<pluginUuid>.<shortId> es la convención Elgato)...
  const bySuffix = origs.find((o) => o === shortId || o.endsWith(`.${shortId}`));
  if (bySuffix) return bySuffix;
  // ...fallback por posición entre las acciones convertidas (ok-only).
  // OJO: solo vale si ninguna acción previa fue omitida (dial).
  const idx = Array.isArray(manifest?.actions) ? manifest.actions.findIndex((a: any) => a?.id === shortId) : -1;
  if (idx >= 0 && origs[idx]) return String(origs[idx]);
  // Último recurso: <pluginUuid>.<shortId> si existe en el original.
  const cand = `${elgatoRaw?.UUID ?? ''}.${shortId}`;
  const found = (elgatoRaw?.Actions ?? []).some((a: any) => a?.UUID === cand);
  return found ? cand : null;
}
