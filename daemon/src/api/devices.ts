/**
 * Rutas de dispositivos lógicos y asignaciones por perfil.
 *
 * - `GET/POST /api/v1/devices`, `GET/PUT/DELETE /api/v1/devices/:id`
 * - `GET /api/v1/profiles/:profileId/assignments` → { assignments, repaired }
 * - `PUT /api/v1/profiles/:profileId/assignments` { assignments: {deviceId: pageId|null} }
 *   Valida compatibilidad (deck = cuadrícula + tamaño exacto) y responde
 *   422 con los motivos si alguna asignación es inválida.
 *
 * IMPORTANTE: este handler debe ir ANTES que handleProfiles en el dispatcher,
 * porque `/api/v1/profiles/:id/assignments` también matchea el prefijo de perfiles.
 */
import { v4 as uuidv4 } from 'uuid';
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';
import {
  checkPageCompatibility,
  resolveDeckSize,
  pickHwDeckForRepaint,
  DECK_MODELS,
  DEFAULT_DECK_MODEL,
  type DeviceKind,
} from '../devices';
import { streamDeckDriver } from '../hw-driver/streamdeck-driver';

const KINDS: DeviceKind[] = ['deck', 'phone', 'tablet'];

/** Igualdad superficial de mapas deviceId → pageId (para no re-emitir). */
function assignmentsChanged(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return true;
  return ka.some((k) => b[k] !== a[k]);
}

function cleanDeviceInput(body: any, isCreate: boolean): { ok: boolean; error?: string; value?: any } {
  const kind = body?.kind ?? (isCreate ? 'phone' : undefined);
  if (kind !== undefined && !KINDS.includes(kind)) {
    return { ok: false, error: `kind debe ser uno de: ${KINDS.join(', ')}` };
  }
  if (isCreate && (typeof body?.name !== 'string' || !body.name.trim())) {
    return { ok: false, error: 'name es obligatorio' };
  }
  const out: any = {};
  if (body?.name !== undefined) out.name = String(body.name).slice(0, 80);
  if (kind !== undefined) out.kind = kind;
  if (body?.model !== undefined) out.model = body.model === null ? null : String(body.model).slice(0, 24);
  for (const k of ['cols', 'rows'] as const) {
    if (body?.[k] !== undefined) {
      if (body[k] === null) {
        out[k] = null;
      } else {
        const n = Math.floor(Number(body[k]));
        if (!Number.isFinite(n) || n < 1 || n > 12) {
          return { ok: false, error: `${k} debe estar entre 1 y 12` };
        }
        out[k] = n;
      }
    }
  }
  if (body?.hw_path !== undefined) out.hw_path = body.hw_path === null ? null : String(body.hw_path).slice(0, 300);
  // Normalizar deck: modelo válido + tamaño efectivo resuelto del modelo
  // salvo override explícito de cols/rows.
  const targetKind = (body?.kind ?? (isCreate ? 'phone' : undefined)) as DeviceKind | undefined;
  if (targetKind === 'deck' && (isCreate || body?.kind === 'deck' || body?.model !== undefined)) {
    const model = (body?.model ?? out.model ?? DEFAULT_DECK_MODEL) as string;
    const preset = DECK_MODELS.find((m) => m.id === model);
    if (body?.model !== undefined && body.model !== null && !preset) {
      return { ok: false, error: `model debe ser uno de: ${DECK_MODELS.map((m) => m.id).join(', ')}` };
    }
    if (preset) {
      if (out.model === undefined && body?.model === undefined) out.model = preset.id;
      if (body?.cols === undefined && body?.rows === undefined && out.cols === undefined && out.rows === undefined) {
        out.cols = preset.cols;
        out.rows = preset.rows;
      }
    }
  }
  return { ok: true, value: out };
}

export const handleDevices: ApiHandler = async (_req, { url, method, path, db, services }) => {
  // ---- Asignaciones por perfil ----
  const assignMatch = path.match(/^\/api\/v1\/profiles\/([^/]+)\/assignments$/);
  if (assignMatch) {
    const profileId = assignMatch[1];
    const profile = db.getProfile(profileId);
    if (!profile) return jsonResponse({ error: 'Profile not found' }, 404);

    if (method === 'GET') {
      // OJO: antes se emitía `assignment.updated` en CADA GET, aunque no
      // hubiera cambiado nada. Como el propio frontend se suscribe y al
      // recibirlo refetchea (devices-changed → loadAssignments), se formaba
      // una tormenta auto-sostenida (GET → broadcast → GET → …) que agotaba
      // los sockets del navegador. Solo se avisa si algo cambió de verdad.
      const before = db.getAssignments(profileId);
      const fixed = db.repairAssignments(profileId);
      const assignments = db.getAssignments(profileId);
      if (assignmentsChanged(before, assignments) || fixed.dropped.length > 0) {
        services.wsManager.broadcast('assignment.updated', { profileId, assignments }, 'pages');
      }
      return jsonResponse({ assignments, repaired: fixed });
    }

    if (method === 'PUT') {
      const body = (await _req.json()) as any ?? {};
      const wanted = body?.assignments;
      if (!wanted || typeof wanted !== 'object' || Array.isArray(wanted)) {
        return jsonResponse({ error: 'assignments (objeto deviceId → pageId|null) requerido' }, 400);
      }
      const devices = db.listDevices();
      const byId = new Map(devices.map((d) => [d.id, d]));
      const pages = db.getPagesByProfile(profileId);
      const pageById = new Map(pages.map((p) => [p.id, p]));
      const errors: Array<{ deviceId: string; pageId: string; reason: string }> = [];

      for (const [deviceId, pageId] of Object.entries(wanted)) {
        if (pageId === null) continue;
        const device = byId.get(deviceId);
        if (!device) {
          errors.push({ deviceId, pageId: String(pageId), reason: 'dispositivo no existe' });
          continue;
        }
        const page = pageById.get(String(pageId));
        if (!page) {
          errors.push({ deviceId, pageId: String(pageId), reason: 'página no existe en este perfil' });
          continue;
        }
        const compat = checkPageCompatibility(
          {
            id: page.id,
            profile_id: page.profile_id,
            name: page.name,
            is_folder: page.is_folder,
            parent_id: page.parent_id ?? null,
            grid_cols: page.grid_cols ?? null,
            grid_rows: page.grid_rows ?? null,
            data: page.data,
          },
          {
            id: device.id,
            name: device.name,
            kind: device.kind as DeviceKind,
            model: device.model,
            cols: device.cols,
            rows: device.rows,
          },
          profile.data,
        );
        if (!compat.ok) {
          errors.push({ deviceId, pageId: page.id, reason: compat.why ?? 'incompatible' });
        }
      }

      if (errors.length > 0) {
        return jsonResponse({ error: 'Asignaciones incompatibles', details: errors }, 422);
      }

      for (const [deviceId, pageId] of Object.entries(wanted)) {
        if (!byId.has(deviceId)) continue;
        if (pageId === null) db.clearAssignment(profileId, deviceId);
        else db.setAssignment(profileId, deviceId, String(pageId));
      }
      const fixed = db.repairAssignments(profileId);
      const assignments = db.getAssignments(profileId);
      services.wsManager.broadcast('assignment.updated', { profileId, assignments }, 'pages');
      // El HW físico sigue la asignación (nunca al revés): si cambió un deck,
      // fijar la vista del HW a su página final (post-repair). Sin esto el
      // botón "dispositivos" no movía nada físico. Best-effort: nunca tumba
      // el guardado.
      try {
        const changedDecks = Object.entries(wanted)
          .filter(([id, p]) => p !== null && byId.get(id)?.kind === 'deck')
          .map(([id]) => id);
        if (changedDecks.length > 0
          && streamDeckDriver.isConnected()
          && typeof services.wsManager.navigatePageTo === 'function') {
          const allDevices = db.listDevices().map((d) => ({
            id: d.id,
            name: d.name,
            kind: d.kind as DeviceKind,
            model: (d as any).model ?? null,
            cols: (d as any).cols ?? null,
            rows: (d as any).rows ?? null,
            hw_path: (d as any).hw_path ?? null,
          }));
          let hwGrid: { cols: number; rows: number } | null = null;
          try {
            hwGrid = streamDeckDriver.getGridGeometry();
          } catch { hwGrid = null; }
          let connectedPath: string | null = null;
          try {
            connectedPath = streamDeckDriver.getConnectedDevice() ?? null;
          } catch { connectedPath = null; }
          const picked = pickHwDeckForRepaint({
            devices: allDevices,
            changedDeckIds: changedDecks,
            connectedPath,
            hwGrid,
          });
          const finalPage = picked ? assignments[picked] : null;
          if (picked && finalPage) {
            let sameProfile = true;
            try {
              const view = streamDeckDriver.getSessionView();
              sameProfile = !view.profileId || view.profileId === profileId;
            } catch { sameProfile = true; }
            // No arrancar al HW de otro perfil: solo sigue asignaciones de
            // su perfil actual (o sin sesión todavía).
            if (sameProfile) {
              services.wsManager.navigatePageTo({
                pageId: finalPage,
                originDeviceId: null,
                targets: { kind: 'devices', ids: [streamDeckDriver.getDeviceId()] },
                context: { via: 'device-assignment' },
              });
            }
          }
        }
      } catch { /* noop */ }
      return jsonResponse({ assignments, repaired: fixed });
    }

    return null;
  }

  // ---- CRUD de dispositivos ----
  if (path === '/api/v1/devices') {
    if (method === 'GET') {
      return jsonResponse(db.listDevices());
    }
    if (method === 'POST') {
      const body = (await _req.json()) as any ?? {};
      const cleaned = cleanDeviceInput(body, true);
      if (!cleaned.ok) return jsonResponse({ error: cleaned.error }, 400);
      // Se acepta id explícito (deshacer borrado); si está en uso se ignora.
      let id = uuidv4();
      if (typeof body?.id === 'string' && body.id.length >= 1 && body.id.length <= 64 && !db.getDevice(body.id)) {
        id = body.id;
      }
      const created = db.createDevice({ id, ...cleaned.value });
      services.wsManager.broadcast('device.created', { device: created }, 'pages');
      return jsonResponse(created, 201);
    }
    return null;
  }

  const devMatch = path.match(/^\/api\/v1\/devices\/([^/]+)$/);
  if (devMatch) {
    const id = devMatch[1];
    if (method === 'GET') {
      const device = db.getDevice(id);
      if (!device) return jsonResponse({ error: 'Device not found' }, 404);
      return jsonResponse({ ...device, effectiveSize: device.kind === 'deck' ? resolveDeckSize(device as any) : null });
    }
    if (method === 'PUT') {
      const existing = db.getDevice(id);
      if (!existing) return jsonResponse({ error: 'Device not found' }, 404);
      const body = (await _req.json()) as any ?? {};
      const cleaned = cleanDeviceInput(body, false);
      if (!cleaned.ok) return jsonResponse({ error: cleaned.error }, 400);
      const updated = db.updateDevice(id, cleaned.value);
      // El cambio de kind/tamaño puede invalidar asignaciones en todos los perfiles.
      const profiles = db.getProfiles();
      const repaired: Record<string, unknown> = {};
      for (const p of profiles) {
        repaired[p.id] = db.repairAssignments(p.id);
      }
      services.wsManager.broadcast('device.updated', { device: updated }, 'pages');
      services.wsManager.broadcast('assignment.updated', { repaired }, 'pages');
      return jsonResponse({ device: updated, repaired });
    }
    if (method === 'DELETE') {
      const existing = db.getDevice(id);
      if (!existing) return jsonResponse({ error: 'Device not found' }, 404);
      const snapshot = {
        device: existing,
        assignments: db.getProfiles().map((p) => ({ profileId: p.id, pageId: db.getAssignments(p.id)[id] ?? null })),
      };
      db.deleteDevice(id);
      for (const p of db.getProfiles()) db.repairAssignments(p.id);
      services.wsManager.broadcast('device.deleted', { deviceId: id }, 'pages');
      services.wsManager.broadcast('assignment.updated', { deviceDeleted: id }, 'pages');
      // Snapshot para deshacer en el frontend (re-crea dispositivo + asignaciones).
      return jsonResponse({ success: true, snapshot });
    }
    return null;
  }

  void url;
  return null;
};
