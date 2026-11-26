/**
 * Servido de ficheros estáticos compartido por el servidor API
 * (`/assets/*`, desde el data-dir) y el frontend embebido (web-dist).
 *
 * Centraliza:
 * - `resolveWebDistCandidates()`: ubicaciones documentadas dev/prod donde
 *   puede estar la UI compilada (antes: listas de 5 paths duplicadas en
 *   server.ts). Orden: prod (CWD del ejecutable) → dev (web/dist).
 * - `serveDataAsset()`: ficheros subidos por el usuario bajo `<data>/assets`.
 * - `getContentType()`: mapa de extensiones (antes: método privado en server.ts).
 */

import path from 'path';
import fs from 'node:fs';
import { getDataDir } from '../paths';

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  mjs: 'application/javascript',
  json: 'application/json',
  map: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};

export function getContentType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'text/plain';
}

/**
 * Candidatos donde puede estar la UI compilada, en orden de prioridad.
 * - Prod (`bun run start`, binario compilado): `web-dist` junto al CWD o al
 *   ejecutable, y `daemon/web-dist` (build.sh copia web/dist → daemon/web-dist).
 * - Dev (`npm run dev` en web/): `web/dist` (build en vivo).
 * - En DEV_MODE `web/dist` va primero: `daemon/web-dist` suele ser una copia
 *   vieja que si no taparía al build fresco y el móvil vería una UI antigua.
 */
export function resolveWebDistCandidates(): string[] {
  const fromCwd = path.join(process.cwd(), 'web-dist');
  const nearExec = path.join(path.dirname(process.execPath), 'web-dist');
  // OJO: este fichero vive en daemon/src/http/, no en daemon/src.
  const inDaemon = path.join(import.meta.dir, '..', '..', 'web-dist'); // daemon/web-dist (build.sh)
  const cwdWeb = path.join(process.cwd(), 'web', 'dist');
  const repoWeb = path.join(import.meta.dir, '..', '..', '..', 'web', 'dist'); // repo web/dist
  if (process.env.DEV_MODE === 'true') {
    return [cwdWeb, repoWeb, fromCwd, nearExec, inDaemon];
  }
  return [fromCwd, nearExec, inDaemon, cwdWeb, repoWeb];
}

/** Candidatos para el `index.html` de fallback SPA (mismo orden). */
export function resolveWebDistIndexCandidates(): string[] {
  return resolveWebDistCandidates().map((base) => path.join(base, 'index.html'));
}

/**
 * Cache para la UI embebida:
 * - HTML (shell SPA): `no-store` — iOS/Safari cachea agresivo y sin esto el
 *   móvil se queda en una versión vieja aunque haya un build nuevo.
 * - `/_astro/*` (build con hash en el nombre): immutable 1 año.
 * - Resto: sin cabecera (heurística del navegador).
 */
export function webDistCacheHeaders(filePath: string): Record<string, string> {
  const p = filePath.toLowerCase();
  if (p.endsWith('.html')) return { 'Cache-Control': 'no-store' };
  if (p.includes('/_astro/')) return { 'Cache-Control': 'public, max-age=31536000, immutable' };
  return {};
}

/** Candidatos para `web/src` (misma lógica que web-dist, para detectar obsolescencia en DEV).
 * OJO: este fichero vive en daemon/src/http/ (un nivel más hondo que
 * daemon/src), así que el relativo necesita TRES `..` para llegar a la raíz. */
export function resolveWebSrcCandidates(): string[] {
  return [
    path.join(process.cwd(), 'web', 'src'),
    path.join(import.meta.dir, '..', '..', '..', 'web', 'src'),
  ];
}

/** mtime más reciente bajo un directorio (recursivo, best-effort). */
export function newestMtimeMs(dir: string): number {
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        try {
          const m = fs.statSync(full).mtimeMs;
          if (m > newest) newest = m;
        } catch { /* noop */ }
      }
    }
  }
  return newest;
}

/**
 * ¿El build está obsoleto? `web/src` más nuevo que `web/dist/index.html`
 * (o dist ausente). Solo se usa en DEV para reconstruir solo.
 */
export function webDistStale(webSrcDir: string | null, distIndex: string | null): boolean {
  if (!distIndex) return true;
  if (!webSrcDir) return false;
  try {
    const distStat = fs.statSync(distIndex);
    return newestMtimeMs(webSrcDir) > distStat.mtimeMs;
  } catch {
    return false;
  }
}

/** Busca `requestPath` (p. ej. `/js/app.js`) en los candidatos web-dist. */
export async function findWebDistFile(requestPath: string): Promise<string | null> {
  const relative = requestPath.replace(/^\/+/, '');
  for (const base of resolveWebDistCandidates()) {
    const fullPath = path.join(base, relative);
    try {
      if (await Bun.file(fullPath).exists()) return fullPath;
    } catch {
      // Continuar con la siguiente ubicación
    }
  }
  return null;
}

/** Busca el `index.html` de fallback SPA. */
export async function findWebDistIndex(): Promise<string | null> {
  for (const indexPath of resolveWebDistIndexCandidates()) {
    try {
      if (await Bun.file(indexPath).exists()) return indexPath;
    } catch {
      // Continuar buscando
    }
  }
  return null;
}

/**
 * Sirve un asset de usuario (`/assets/<rel>`) desde `<data>/assets`.
 * Devuelve `null` si no existe (el llamador responde 404).
 */
export async function serveDataAsset(
  relativePath: string,
  corsHeaders: Record<string, string>
): Promise<Response | null> {
  // Evitar path traversal: normalizar y rechazar `..`.
  const normalized = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '');
  if (normalized.startsWith('..')) return null;
  try {
    const fullPath = path.join(getDataDir(), 'assets', normalized);
    const file = Bun.file(fullPath);
    if (await file.exists()) {
      return new Response(file, {
        headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=3600' },
      });
    }
  } catch (error) {
    console.error('Error serving asset:', error);
  }
  return null;
}
