/**
 * Rutas `/api/v1/backups/*` — backups completos y restore selectivo.
 *
 * - `GET /api/v1/backups/export[?sections=a,b]` → backup JSON versionado.
 * - `POST /api/v1/backups/validate` { backup } → { valid, errors, warnings, info }.
 * - `POST /api/v1/backups/restore` { backup, sections?, mode? } → valida
 *   (400 si inválido) e importa; progreso por WS (`backup.progress`, topic
 *   `backups`): started → progress* → done/error.
 */
import { buildBackup, buildProfileBackup, validateBackup, restoreBackup, BACKUP_SECTIONS } from '../backup';
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';

function emit(ws: any, event: string, payload: any): void {
  try { ws?.broadcast(event, payload, 'backups'); } catch { /* noop */ }
}

function parseSections(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
    .filter((s) => (BACKUP_SECTIONS as readonly string[]).includes(s));
  return list.length ? [...new Set(list)] : [];
}

export const handleBackups: ApiHandler = async (_req, { url, method, path, db, services }) => {
  const profileExportMatch = path.match(/^\/api\/v1\/backups\/profiles\/([^/]+)\/export$/);
  if (profileExportMatch && method === 'GET') {
    const profileId = decodeURIComponent(profileExportMatch[1]);
    const backup = buildProfileBackup(db, profileId);
    return backup
      ? jsonResponse(backup)
      : jsonResponse({ error: 'Profile not found' }, 404);
  }

  if (path === '/api/v1/backups/export') {
    if (method === 'GET') {
      const sections = parseSections(url.searchParams.get('sections'));
      const backup = buildBackup(db, sections ? { sections } : undefined);
      return jsonResponse(backup);
    }
    if (method === 'POST') {
      let body: any = {};
      try { body = await _req.json(); } catch { body = {}; }
      const sections = Array.isArray(body?.sections)
        ? body.sections.filter((s: unknown) => typeof s === 'string' && (BACKUP_SECTIONS as readonly string[]).includes(s))
        : undefined;
      const backup = buildBackup(db, sections ? { sections } : undefined);
      return jsonResponse(backup);
    }
  }

  if (path === '/api/v1/backups/validate') {
    if (method === 'POST') {
      let body: any = {};
      try { body = await _req.json(); } catch { body = {}; }
      const v = validateBackup(body?.backup ?? body);
      return jsonResponse(v, v.valid ? 200 : 400);
    }
  }

  if (path === '/api/v1/backups/restore') {
    if (method === 'POST') {
      let body: any = {};
      try { body = await _req.json(); } catch { body = {}; }
      const backup = body?.backup ?? body;
      const sections = Array.isArray(body?.sections)
        ? body.sections.filter((s: unknown) => typeof s === 'string')
        : undefined;
      const mode = body?.mode === 'clean' ? 'clean' : 'merge';

      // Validación pre-restore (sin tocar la BD).
      const pre = validateBackup(backup);
      if (!pre.valid) {
        emit(services.wsManager, 'backup.progress', { stage: 'error', done: 0, total: 1, message: pre.errors.join('; '), ts: Date.now() });
        return jsonResponse(pre, 400);
      }

      try {
        const result = restoreBackup(db, backup, {
          sections,
          mode,
          onProgress: (stage, done, total, message) => {
            emit(services.wsManager, 'backup.progress', { stage, done, total, message, mode, ts: Date.now() });
            // Espejo en 'system' para clientes suscritos solo a logs/sistema.
            try { services.wsManager?.broadcast('backup.progress', { stage, done, total, message, mode, ts: Date.now() }, 'system'); } catch { /* noop */ }
          },
        });
        try {
          db.addLog({ level: 'info', message: `backup:restore ${mode}`, meta: { sections: result.sections, restored: result.restored }, ts: Date.now() });
        } catch { /* noop */ }
        return jsonResponse(result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit(services.wsManager, 'backup.progress', { stage: 'error', done: 0, total: 1, message: msg, ts: Date.now() });
        return jsonResponse({ error: msg }, 400);
      }
    }
  }

  return null;
};
