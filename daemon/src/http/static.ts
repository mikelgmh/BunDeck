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
 * - `daemon/web-dist` y `web-dist` junto al ejecutable/CWD: prod (build.sh
 *   copia web/dist → daemon/web-dist; el binario compilado usa CWD/execDir).
 * - `web/dist` (CWD o relativo a daemon/src): dev (`npm run build` en web/).
 */
export function resolveWebDistCandidates(): string[] {
  return [
    path.join(process.cwd(), 'web-dist'), // Desde CWD (prod)
    path.join(path.dirname(process.execPath), 'web-dist'), // Junto al ejecutable
    path.join(import.meta.dir, '..', 'web-dist'), // daemon/web-dist (build.sh)
    path.join(process.cwd(), 'web', 'dist'), // Astro dev/prod (web/dist)
    path.join(import.meta.dir, '..', '..', 'web', 'dist'), // Relativo a daemon/src
  ];
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
