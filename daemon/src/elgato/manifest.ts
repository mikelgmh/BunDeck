/**
 * Soporte Elgato StreamDeck (.sdPlugin) — Fase 0/1: detección, validación,
 * conversión de manifest y diagnóstico de compatibilidad.
 *
 * Un plugin Elgato es una carpeta `<uuid>.sdPlugin` (distribuida como ZIP
 * renombrado `.streamDeckPlugin`) con `manifest.json` PROPIO de Elgato
 * (campos UUID/Name/Version/CodePath/Actions...), NO nuestro manifest.
 * Ver informe de investigación (subagente) para el diseño completo.
 */

import path from 'node:path';
import fs from 'node:fs';

export interface ElgatoAction {
  UUID: string;
  Name: string;
  Tooltip?: string;
  Icon?: string;
  PropertyInspectorPath?: string;
  Controllers?: string[];
  States?: any[];
  OS?: any[];
  [k: string]: any;
}

export interface ElgatoManifest {
  UUID: string;
  Name: string;
  Version: string; // X.Y.Z.0 (cuatripartito)
  Author: string;
  Description?: string;
  Tooltip?: string;
  CodePath?: string;
  CodePathMac?: string;
  CodePathWin?: string;
  Nodejs?: { Version?: string };
  SDKVersion?: number;
  Icon?: string;
  Category?: string;
  URL?: string;
  Actions: ElgatoAction[];
  OS?: any[];
  [k: string]: any;
}

export type ElgatoRuntime = 'node' | 'native' | 'unknown';

export type StagedKind = 'elgato' | 'libredeck' | 'none';

/** ¿Tiene forma de manifest Elgato (UUID + Actions[] + algún CodePath)? */
export function isElgatoManifest(m: any): boolean {
  if (!m || typeof m !== 'object') return false;
  if (typeof m.UUID !== 'string' || !Array.isArray(m.Actions)) return false;
  // Acepta CodePath genérico O específicos por plataforma (algunos paquetes
  // solo traen CodePathMac/CodePathWin). Sin ninguno no es ejecutable.
  const code = m.CodePath ?? m.CodePathMac ?? m.CodePathWin;
  return typeof code === 'string' && code.length > 0;
}

function readJsonSafe(p: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** Busca manifest.json recursivo (profundidad ≤4), sin entrar en node_modules/.git. */
export function findManifestRecursive(root: string, maxDepth = 4): string | null {
  const walk = (dir: string, depth: number): string | null => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (e.isFile() && e.name === 'manifest.json') return path.join(dir, e.name);
    }
    if (depth >= maxDepth) return null;
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git') continue;
      const found = walk(path.join(dir, e.name), depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(root, 0);
}

/** Detecta qué tipo de paquete hay en un directorio de staging. */
export function detectStagedType(stageDir: string): { kind: StagedKind; manifestPath: string | null } {
  const found = findManifestRecursive(stageDir);
  if (!found) return { kind: 'none', manifestPath: null };
  const m = readJsonSafe(found);
  if (!m) return { kind: 'none', manifestPath: found };
  if (isElgatoManifest(m) && typeof m.id !== 'string') return { kind: 'elgato', manifestPath: found };
  return { kind: 'libredeck', manifestPath: found };
}

export interface ElgatoActionReport {
  uuid: string;
  id: string; // sufijo convertible a nuestro action id
  name: string;
  keypad: boolean;
  status: 'ok' | 'skip';
  reason?: string;
}

export interface ElgatoReport {
  detected: boolean;
  uuid: string | null;
  name: string | null;
  elgatoVersion: string | null;
  semver: string | null;
  runtime: ElgatoRuntime;
  codePath: string | null;
  controllers: string[];
  compatible: boolean;
  reasons: string[]; // bloqueantes
  warnings: string[]; // no bloqueantes
  actions: ElgatoActionReport[];
}

const ACTION_ID = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i;

function toSemver(v: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/.exec((v ?? '').trim());
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}`;
}

function actionIdFor(pluginUuid: string, actionUuid: string): string {
  let id = actionUuid.startsWith(pluginUuid + '.')
    ? actionUuid.slice(pluginUuid.length + 1)
    : actionUuid;
  id = id.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '');
  if (!id) id = 'action';
  if (!ACTION_ID.test(id)) id = 'action-' + id.replace(/[^a-z0-9]+/gi, '-');
  return id.slice(0, 64);
}

export function analyzeElgatoManifest(manifest: any): ElgatoReport {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!manifest || typeof manifest !== 'object') {
    return {
      detected: false, uuid: null, name: null, elgatoVersion: null, semver: null,
      runtime: 'unknown', codePath: null, controllers: [], compatible: false,
      reasons: ['No es un manifest Elgato (objeto inválido)'], warnings, actions: [],
    };
  }
  const { UUID, Name, Version, Author, CodePath, CodePathMac, CodePathWin, Nodejs, Actions } = manifest as ElgatoManifest;
  if (!UUID || typeof UUID !== 'string') reasons.push('Falta UUID del plugin');
  if (!Name) reasons.push('Falta Name');
  if (!Author) reasons.push('Falta Author');
  const semver = typeof Version === 'string' ? toSemver(Version) : null;
  if (!semver) reasons.push(`Version Elgato inválida (esperado X.Y.Z.0, recibido '${Version}')`);
  if (!Array.isArray(Actions) || Actions.length === 0) reasons.push('Actions vacío o ausente');

  // Runtime: JS+Nodejs → node; ejecutable/binario → native (no importable)
  const code = CodePathWin ?? CodePathMac ?? CodePath ?? null;
  const codeStr = [CodePath, CodePathMac, CodePathWin].filter(Boolean).join(' ');
  const looksJs = /\.(m?js|cjs)$/i.test(codeStr);
  const looksNative = /\.(exe|dll|so|dylib|bin)$/i.test(codeStr) || (/^(bin\/|[A-Za-z]:\\|\/)/.test(codeStr) && !looksJs);
  const runtime: ElgatoRuntime = looksNative ? 'native' : (looksJs || Nodejs ? 'node' : 'unknown');
  if (runtime === 'native') reasons.push(`CodePath nativo no importable (${codeStr || 'desconocido'}): solo plugins JS/Node`);
  if (runtime === 'unknown') warnings.push('No se pudo determinar el runtime (sin bloque Nodejs ni CodePath .js): se asume Node');

  const actions: ElgatoActionReport[] = [];
  const controllers = new Set<string>();
  if (Array.isArray(Actions)) {
    for (const a of Actions) {
      const ctrls = Array.isArray(a.Controllers) ? a.Controllers : [];
      ctrls.forEach((c) => controllers.add(c));
      const keypad = ctrls.length === 0 || ctrls.includes('Keypad');
      const id = UUID ? actionIdFor(UUID, a.UUID ?? '') : 'action';
      if (!a.UUID || !a.Name) {
        actions.push({ uuid: a.UUID ?? '?', id, name: a.Name ?? '?', keypad, status: 'skip', reason: 'UUID/Name ausente' });
        continue;
      }
      if (!keypad) {
        actions.push({ uuid: a.UUID, id, name: a.Name, keypad, status: 'skip', reason: `Controllers [${ctrls.join(',')}] sin Keypad: sin equivalente hardware` });
        continue;
      }
      actions.push({ uuid: a.UUID, id, name: a.Name, keypad, status: 'ok' });
    }
    if (actions.length > 0 && !actions.some((a) => a.status === 'ok')) {
      reasons.push('Ninguna acción es Keypad (diales/encoders sin equivalente en LibreDeck)');
    }
  }
  if (manifest.SDKVersion === 1) warnings.push('SDKVersion 1: protocolo clásico, el shim lo soporta pero sin probar');

  return {
    detected: true,
    uuid: UUID ?? null,
    name: Name ?? null,
    elgatoVersion: Version ?? null,
    semver,
    runtime,
    codePath: code ?? null,
    controllers: [...controllers],
    compatible: reasons.length === 0,
    reasons,
    warnings,
    actions,
  };
}

/** Convierte un manifest Elgato ya analizado a nuestro manifest (solo si compatible). */
export function convertElgatoManifest(elgato: ElgatoManifest, report: ElgatoReport): any {
  if (!report.compatible || !report.uuid || !report.semver) {
    throw new Error(`No convertible: ${report.reasons.join('; ')}`);
  }
  return {
    id: report.uuid,
    name: elgato.Name,
    version: report.semver,
    description: elgato.Description ?? (elgato as any).Tooltip ?? `Importado de StreamDeck (${report.elgatoVersion})`,
    author: elgato.Author,
    homepage: elgato.URL,
    engine: '>=1.5.0',
    apiVersion: '2.1',
    permissions: ['network', 'filesystem'],
    actions: report.actions
      .filter((a) => a.status === 'ok')
      .map((a) => ({
        id: a.id,
        name: a.name,
        description: (elgato.Actions.find((x) => x.UUID === a.uuid)?.Tooltip) ?? '',
      })),
    'x-elgato': {
      uuid: report.uuid,
      elgatoVersion: report.elgatoVersion,
      runtime: report.runtime,
      codePath: report.codePath,
      controllers: report.controllers,
      originalActions: elgato.Actions.map((a) => a.UUID),
      sdkVersion: (elgato as any).SDKVersion ?? null,
    },
  };
}
