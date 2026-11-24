/**
 * Rutas `/api/v1/streamdeck/*` — detección e importación de perfiles
 * Stream Deck (Elgato) como perfiles nuevos de LibreDeck.
 *
 * - `GET /api/v1/streamdeck/detect` → perfiles instalados (solo lectura).
 * - `POST /api/v1/streamdeck/validate` { uuid } o multipart `file`
 *   (.streamDeckProfile) → plan sin tocar la BD (dry-run).
 * - `POST /api/v1/streamdeck/import` { uuid?, dryRun? } o multipart
 *   `file` → importa creando siempre un perfil nuevo
 *   («{Nombre} (importado)»). Progreso por WS (`streamdeck.progress`,
 *   topic `streamdeck`): started → progress* → done/error.
 */

import { detectStreamDeckProfiles } from '../streamdeck/detect';
import { importStreamDeckProfile } from '../streamdeck/profile-import';
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';

function emit(ws: any, event: string, payload: any): void {
  try { ws?.broadcast(event, payload, 'streamdeck'); } catch { /* noop */ }
}

const MAX_ZIP_BYTES = 100 * 1024 * 1024;

async function saveUpload(req: Request): Promise<{ tmp: string; name: string; dryRun: boolean } | { error: string }> {
  let form: any;
  try {
    form = await req.formData();
  } catch {
    return { error: 'Formulario multipart inválido (usa campo `file`)' };
  }
  const file = form.get('file') as any;
  if (!file || typeof file.arrayBuffer !== 'function') return { error: 'file requerido (.streamDeckProfile)' };
  const name = String(file.name ?? 'perfil.streamDeckProfile');
  if (!/\.(streamdeckprofile|zip)$/i.test(name)) return { error: 'Solo .streamDeckProfile / .zip' };
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length === 0) return { error: 'Fichero vacío' };
  if (buf.length > MAX_ZIP_BYTES) return { error: 'Fichero demasiado grande (máx 100 MB)' };
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ld-sdupload-')), name.replace(/[^a-zA-Z0-9._-]+/g, '_'));
  await fs.promises.writeFile(tmp, buf);
  const dryRaw = form.get('dryRun');
  const dryRun = dryRaw === '1' || dryRaw === 'true';
  return { tmp, name, dryRun };
}

export const handleStreamDeck: ApiHandler = async (req, { url, method, path, db, services }) => {
  if (path === '/api/v1/streamdeck/detect') {
    if (method === 'GET') {
      const profiles = detectStreamDeckProfiles();
      return jsonResponse({ profiles });
    }
    return null;
  }

  if (path === '/api/v1/streamdeck/validate' || path === '/api/v1/streamdeck/import') {
    if (method !== 'POST') return null;
    const isImport = path.endsWith('/import');
    const contentType = req.headers.get('content-type') ?? '';

    let zipPath: string | undefined;
    let detectedUuid: string | undefined;
    let dryRun = false;
    let cleanupUpload: string | null = null;

    if (contentType.includes('multipart/form-data')) {
      const saved = await saveUpload(req);
      if ('error' in saved) return jsonResponse({ error: saved.error }, 400);
      zipPath = saved.tmp;
      cleanupUpload = saved.tmp;
      dryRun = saved.dryRun || url.searchParams.get('dryRun') === '1' || url.searchParams.get('dryRun') === 'true';
      if (!isImport) dryRun = true; // validate nunca escribe
    } else {
      let body: any = {};
      try { body = await req.json(); } catch { body = {}; }
      detectedUuid = typeof body?.uuid === 'string' && body.uuid ? body.uuid : undefined;
      zipPath = typeof body?.zipPath === 'string' && body.zipPath ? body.zipPath : undefined;
      dryRun = body?.dryRun === true || (!isImport && true);
      if (!isImport) dryRun = true; // validate nunca escribe
    }

    if (!zipPath && !detectedUuid) {
      if (cleanupUpload) { try { (await import('node:fs')).rmSync(cleanupUpload, { force: true }); } catch {} }
      return jsonResponse({ error: 'Origen requerido: uuid (detectado) o file (.streamDeckProfile)' }, 400);
    }

    const key = detectedUuid ?? zipPath ?? '';
    const onProgress = (stage: string, done: number, total: number, message: string) => {
      emit(services.wsManager, 'streamdeck.progress', { stage, done, total, message, dryRun, ts: Date.now() });
    };
    try {
      const result = await importStreamDeckProfile(
        db,
        zipPath ? { zipPath } : { detectedUuid: detectedUuid! },
        { dryRun, onProgress },
      );
      try {
        db.addLog?.({
          level: 'info',
          message: `streamdeck:${isImport ? 'import' : 'validate'}${dryRun ? ' (dry-run)' : ''}`,
          meta: { key, counts: result.counts, profileId: result.profileId },
          ts: Date.now(),
        });
      } catch { /* noop */ }
      return jsonResponse(result, isImport && !dryRun ? 201 : 200);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit(services.wsManager, 'streamdeck.progress', { stage: 'error', done: 0, total: 1, message: msg, ts: Date.now() });
      return jsonResponse({ error: msg }, 400);
    } finally {
      if (cleanupUpload) {
        try {
          const fs = await import('node:fs');
          const path = await import('node:path');
          fs.rmSync(path.dirname(cleanupUpload), { recursive: true, force: true });
        } catch { /* noop */ }
      }
    }
  }

  return null;
};
