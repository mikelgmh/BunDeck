/** Rutas `/api/v1/sessions*` y `/api/v1/navigate` — sesiones por dispositivo. */
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';
import { resolveNavTargets } from '../sessions';
import { isHardwareDeviceId } from '../devices';
import { unbindDevice } from '../remote/device-bindings';

function matchId(path: string): string | null {
  const m = path.match(/^\/api\/v1\/sessions\/([^/]+)(\/navigate)?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

function findDeviceId(services: any, db: any, id: string): string | null {
  // Acepta deviceId o clientId (efímero del WS).
  if (db.getDeviceSession(id)) return id;
  const views = services.wsManager?.getSessions?.() ?? [];
  const byClient = views.find((v: any) => v.clientId === id);
  if (byClient) return byClient.deviceId;
  const byDevice = views.find((v: any) => v.deviceId === id);
  if (byDevice) return byDevice.deviceId;
  return null;
}

export const handleSessions: ApiHandler = async (_req, { url, method, path, db, services }) => {
  const ws = services.wsManager;

  // Lista de clientes conectados + su vista actual (más sesiones
  // persistidas sin conexión, p. ej. HW apagado).
  if (path === '/api/v1/sessions') {
    if (method === 'GET') {
      return jsonResponse(ws?.getSessions?.() ?? []);
    }
  }

  // Navegación dirigida puntual (alternativa al WS page.select/profile.select).
  if (path === '/api/v1/navigate') {
    if (method === 'POST') {
      const body = (await _req.json()) as any ?? {};
      const targets = resolveNavTargets(body, body.originDeviceId ?? '');
      if (body.pageId) {
        const res = ws.navigatePageTo({
          pageId: body.pageId,
          originDeviceId: body.originDeviceId ?? null,
          targets,
          context: body.context,
        });
        if (!res.ok) return jsonResponse({ error: res.error }, 404);
        return jsonResponse(res);
      }
      if (body.profileId) {
        const res = ws.navigateProfileTo({
          profileId: body.profileId,
          originDeviceId: body.originDeviceId ?? null,
          targets,
          context: body.context,
        });
        if (!res.ok) return jsonResponse({ error: res.error }, 404);
        return jsonResponse(res);
      }
      return jsonResponse({ error: 'pageId or profileId required' }, 400);
    }
  }

  const id = matchId(path);
  if (id !== null) {
    const isNavigate = path.endsWith('/navigate');
    const deviceId = findDeviceId(services, db, id);

    if (method === 'GET' && !isNavigate) {
      const views = ws?.getSessions?.() ?? [];
      const view = views.find((v: any) => v.deviceId === id || v.clientId === id);
      if (!view && deviceId) {
        const s = db.getDeviceSession(deviceId);
        if (s) return jsonResponse({ ...s, connected: false });
      }
      if (!view) return jsonResponse({ error: 'Session not found' }, 404);
      return jsonResponse(view);
    }

    if ((method === 'PUT' && !isNavigate) || (method === 'POST' && isNavigate)) {
      if (!deviceId) return jsonResponse({ error: 'Session not found' }, 404);
      const body = (await _req.json()) as any ?? {};

      // Startup profile asignable sin navegar todavía
      if (body.startupProfileId !== undefined && body.profileId === undefined && body.pageId === undefined) {
        if (body.startupProfileId !== null) {
          const p = db.getProfile(body.startupProfileId);
          if (!p) return jsonResponse({ error: `Profile not found: ${body.startupProfileId}` }, 404);
        }
        const s = db.setDeviceStartupProfile(deviceId, body.startupProfileId);
        return jsonResponse({ ok: true, session: s });
      }

      const res = ws.setSessionView(deviceId, {
        profileId: body.profileId,
        pageId: body.pageId,
        startupProfileId: body.startupProfileId,
        name: body.name,
        kind: body.kind,
      });
      if (!res.ok) return jsonResponse({ error: res.error }, 404);
      const views = ws?.getSessions?.() ?? [];
      const view = views.find((v: any) => v.deviceId === deviceId) ?? db.getDeviceSession(deviceId);
      return jsonResponse({ ok: true, session: view });
    }

    if (method === 'DELETE' && !isNavigate) {
      if (!deviceId) return jsonResponse({ error: 'Session not found' }, 404);
      db.deleteDeviceSession(deviceId);
      // La sesión está asignada a un navegador: sin sesión no hay fila.
      // (El hardware nunca se borra: su fila la repone el listado.)
      try {
        if (db.getDevice(deviceId) && !isHardwareDeviceId(deviceId)) db.deleteDevice(deviceId);
      } catch { /* noop */ }
      try {
        unbindDevice(db, deviceId);
      } catch { /* noop */ }
      return jsonResponse({ ok: true });
    }
  }

  return null;
};
