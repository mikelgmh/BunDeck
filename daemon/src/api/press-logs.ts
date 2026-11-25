/**
 * Rutas de logs por pulsación × acción (`button_press_logs`).
 *
 * - GET /api/v1/buttons/:id/logs?limit=&offset=&success=&pressType=&deviceId=&since=&until=
 * - GET /api/v1/actions/logs?actionType=REQ&... (mismos filtros; actionType obligatorio)
 * - GET /api/v1/press-logs?buttonId=&actionType=&deviceId=&... (genérico combinable)
 * - DELETE /api/v1/buttons/:id/logs
 * - DELETE /api/v1/actions/logs?actionType=
 * - DELETE /api/v1/press-logs?buttonId=&actionType=&before=
 *
 * Botón borrado → GET devuelve `{items: [], total: 0}` (no 404): el
 * historial sobrevive al botón. Todas las respuestas usan `jsonResponse`
 * (el CORS lo añade la capa HTTP del server). Nunca exponen `parameters`.
 */
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';
import type { PressLogFilters } from '../db';

const BUTTON_LOGS_RE = /^\/api\/v1\/buttons\/([^/]+)\/logs$/;

function badRequest(message: string): Response {
  return jsonResponse({ error: message }, 400);
}

/** Entero de query: null si ausente/vacío; NaN si no numérico. */
function queryNumber(raw: string | null): number | null | undefined {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Valida limit/offset/since/until comunes. Devuelve los filtros o un
 * literal `{ error }` con el mensaje 400.
 */
function parseListQuery(url: URL): { filters: PressLogFilters } | { error: string } {
  const limitRaw = queryNumber(url.searchParams.get('limit'));
  if (limitRaw === null) return { error: 'limit debe ser numérico (máx. 500)' };
  const limit = limitRaw === undefined ? 50 : Math.floor(limitRaw);
  if (limit < 0 || limit > 500) return { error: 'limit debe estar entre 0 y 500' };

  const offsetRaw = queryNumber(url.searchParams.get('offset'));
  if (offsetRaw === null) return { error: 'offset debe ser numérico (>= 0)' };
  const offset = offsetRaw === undefined ? 0 : Math.floor(offsetRaw);
  if (offset < 0) return { error: 'offset debe ser numérico (>= 0)' };

  const since = queryNumber(url.searchParams.get('since'));
  if (since === null) return { error: 'since debe ser numérico (ms epoch)' };
  const until = queryNumber(url.searchParams.get('until'));
  if (until === null) return { error: 'until debe ser numérico (ms epoch)' };

  const filters: PressLogFilters = { limit, offset };
  const buttonId = url.searchParams.get('buttonId');
  if (buttonId !== null && buttonId !== '') filters.buttonId = buttonId;
  const actionType = url.searchParams.get('actionType');
  if (actionType !== null && actionType !== '') filters.actionType = actionType;
  const deviceId = url.searchParams.get('deviceId');
  if (deviceId !== null && deviceId !== '') filters.deviceId = deviceId;
  const pressType = url.searchParams.get('pressType');
  if (pressType !== null && pressType !== '') filters.pressType = pressType;
  const successRaw = url.searchParams.get('success');
  if (successRaw === 'true' || successRaw === '1') filters.success = true;
  else if (successRaw === 'false' || successRaw === '0') filters.success = false;
  if (since !== undefined) filters.since = since;
  if (until !== undefined) filters.until = until;
  return { filters };
}

function toListResponse(result: { items: unknown[]; total: number }, filters: PressLogFilters): Response {
  return jsonResponse({
    items: result.items,
    total: result.total,
    limit: filters.limit ?? 50,
    offset: filters.offset ?? 0,
  });
}

export const handlePressLogs: ApiHandler = async (_req, { url, method, path, db }) => {
  // ---- /api/v1/buttons/:id/logs ----
  const buttonMatch = path.match(BUTTON_LOGS_RE);
  if (buttonMatch) {
    const buttonId = decodeURIComponent(buttonMatch[1]);
    if (method === 'GET') {
      const parsed = parseListQuery(url);
      if ('error' in parsed) return badRequest(parsed.error);
      // Sin 404 aunque el botón ya no exista: el historial sobrevive.
      return toListResponse(db.listPressLogs({ ...parsed.filters, buttonId }), parsed.filters);
    }
    if (method === 'DELETE') {
      return jsonResponse({ deleted: db.clearPressLogs({ buttonId }) });
    }
    return null;
  }

  // ---- /api/v1/actions/logs ----
  if (path === '/api/v1/actions/logs') {
    const actionType = url.searchParams.get('actionType');
    if (!actionType) return badRequest('actionType requerido');
    if (method === 'GET') {
      const parsed = parseListQuery(url);
      if ('error' in parsed) return badRequest(parsed.error);
      return toListResponse(db.listPressLogs({ ...parsed.filters, actionType }), parsed.filters);
    }
    if (method === 'DELETE') {
      return jsonResponse({ deleted: db.clearPressLogs({ actionType }) });
    }
    return null;
  }

  // ---- /api/v1/press-logs (genérico) ----
  if (path === '/api/v1/press-logs') {
    if (method === 'GET') {
      const parsed = parseListQuery(url);
      if ('error' in parsed) return badRequest(parsed.error);
      return toListResponse(db.listPressLogs(parsed.filters), parsed.filters);
    }
    if (method === 'DELETE') {
      const before = queryNumber(url.searchParams.get('before'));
      if (before === null) return badRequest('before debe ser numérico (ms epoch)');
      const buttonId = url.searchParams.get('buttonId');
      const actionType = url.searchParams.get('actionType');
      return jsonResponse({
        deleted: db.clearPressLogs({
          ...(buttonId ? { buttonId } : {}),
          ...(actionType ? { actionType } : {}),
          ...(before !== undefined ? { before } : {}),
        }),
      });
    }
    return null;
  }

  return null;
};
