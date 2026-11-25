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
  isHardwareDeviceId,
  DECK_MODELS,
  DEFAULT_DECK_MODEL,
  type DeviceKind,
} from '../devices';
import { unbindDevice, boundPrefixForDevice } from '../remote/device-bindings';
import { revokeUiSessionByPrefix, notifyTunnelUiUnbind, queueUiUnbind } from '../remote/ui-policy';
import { revokeLanSessionByPrefix } from '../remote/lan-invites';
import { streamDeckDriver } from '../hw-driver/streamdeck-driver';

const KINDS: DeviceKind[] = ['deck', 'phone', 'tablet', 'browser'];

/** Igualdad superficial de mapas deviceId → pageId (para no re-emitir). */
function assignmentsChanged(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return true;
  return ka.some((k) => b[k] !== a[k]);
}

/**
 * Fila del HW físico: siempre existe (el hardware no se crea ni se borra).
 * Crea la fila si falta (sin tocar el nombre si el usuario lo renombró).
 */
function ensureHardwareRow(db: any): void {
  try {
    const id = 'streamdeck-local';
    if (db.getDevice(id)) return;
    db.createDevice({
      id, name: 'Stream Deck', kind: 'deck',
      model: null, cols: null, rows: null, hw_path: null,
    });
  } catch { /* carrera: otro hilo la creó */ }
}

/**
 * Lista unificada de dispositivos (la única que ve la UI):
 * - Hardware detectado (`streamdeck-local` o filas con `hw_path`).
 * - Navegadores aceptados (auto-aprovisionados al identificarse por WS).
 * - Filas heredadas sin sesión (semilla/legado): fuente `manual`, offline.
 *
 * Añade `online` (WS en vivo), `source` y `lastSeen`. Se auto-repara:
 * crea la fila que falte para cada sesión conocida (el HW y los
 * navegadores aparecen solos, sin alta manual).
 */
export function buildUnifiedDevices(db: any, services: any): any[] {
  // El HW físico siempre existe como fila (aunque nunca se haya conectado).
  ensureHardwareRow(db);
  // Higiene oportunista: las sesiones de contextos que no vuelven en semanas
  // (incógnitos, orígenes de prueba, invitados antiguos) se purgan para que
  // la auto-reparación de abajo no las resucite como dispositivos.
  // El HW offline conserva su fila (ensureHardwareRow) y sus asignaciones;
  // al reconectar recupera la vista global.
  try {
    db.purgeStaleDeviceSessions?.(Date.now() - 30 * 24 * 3600 * 1000);
  } catch { /* mejor esfuerzo */ }
  // Auto-reparación: cada sesión persistida tiene su fila.
  try {
    const sessions = db.listDeviceSessions();
    for (const s of sessions) {
      const id = String(s?.device_id ?? '');
      if (!id || id.startsWith('tunnel:')) continue;
      const sk = String(s?.kind ?? '').toLowerCase();
      if (sk === 'cli' || sk === 'api') continue;
      if (!db.getDevice(id)) {
        const hw = isHardwareDeviceId(id) || sk === 'hardware' || sk === 'streamdeck' || sk === 'elgato';
        const label = (typeof s?.name === 'string' && s.name.trim())
          ? s.name.trim().slice(0, 80)
          : hw ? 'Stream Deck' : `Navegador ${id.slice(0, 4)}`;
        try {
          db.createDevice({
            id, name: label, kind: hw ? 'deck' : 'browser',
            model: null, cols: null, rows: null, hw_path: null,
          });
        } catch { /* carrera: otro hilo la creó */ }
      }
    }
  } catch { /* mejor esfuerzo */ }

  const online = new Set<string>();
  try {
    const views = services?.wsManager?.getSessions?.() ?? [];
    for (const v of views) {
      if (v?.connected && v?.deviceId) online.add(String(v.deviceId));
    }
  } catch { /* sin ws: todos offline */ }
  let hwConnected = false;
  try {
    hwConnected = streamDeckDriver.isConnected();
  } catch { hwConnected = false; }

  let rows: any[] = [];
  try {
    rows = db.listDevices();
  } catch {
    return [];
  }
  const withMeta = rows.map((d: any) => {
    const id = String(d.id);
    const hw = isHardwareDeviceId(id) || !!d.hw_path;
    let session: any = null;
    try {
      session = db.getDeviceSession(id) ?? null;
    } catch { session = null; }
    const isOnline = hw ? (hwConnected || online.has(id)) : online.has(id);
    const source: 'hardware' | 'browser' | 'manual' =
      hw ? 'hardware' : (session || d.kind === 'browser') ? 'browser' : 'manual';
    return {
      ...d,
      online: isOnline,
      source,
      lastSeen: session?.updated_at ?? d.updated_at ?? null,
    };
  });
  // Orden estable para la UI: hardware, online, resto (por actividad).
  const rank = (d: any) => (d.source === 'hardware' ? 0 : d.online ? 1 : d.source === 'browser' ? 2 : 3);
  withMeta.sort((a: any, b: any) => rank(a) - rank(b) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  return withMeta;
}

/**
 * Olvidar un dispositivo = prohibirle la entrada:
 * - Revoca sus sesiones de acceso vinculadas (UI remota / LAN).
 * - Borra fila `devices`, sesión persistida, enlaces y asignaciones.
 * - Cierra sus WS vivos y avisa por WS (`device.deleted` + presencia).
 * Las llamadas desde el revocador de sesiones usan `revokeTokens: false`
 * (el token ya se revocó ahí; evita auditorías duplicadas).
 */
export function forgetDeviceEverywhere(
  db: any,
  services: any,
  deviceId: string,
  opts?: { revokeTokens?: boolean },
): { forgotten: boolean } {
  const id = String(deviceId ?? '');
  if (!id) return { forgotten: false };
  // El hardware físico no se puede olvidar ni prohibir: siempre existe.
  if (isHardwareDeviceId(id)) return { forgotten: false };
  try {
    if (!db.getDevice(id)) return { forgotten: false };
  } catch {
    return { forgotten: false };
  }
  if (opts?.revokeTokens !== false) {
    for (const kind of ['ui', 'lan'] as const) {
      let prefix: string | null = null;
      try {
        prefix = boundPrefixForDevice(db, kind, id);
      } catch { prefix = null; }
      if (!prefix) continue;
      try {
        if (kind === 'ui') {
          const found = revokeUiSessionByPrefix(db, prefix);
          if (found) {
            try { queueUiUnbind(db, found.token, found.session.exp); } catch { /* noop */ }
            notifyTunnelUiUnbind(found.token);
            try { (globalThis as any).__libredeckRemote?.tunnel?.closeRtcForToken?.(found.token); } catch { /* noop */ }
          }
        } else {
          revokeLanSessionByPrefix(db, prefix);
        }
      } catch { /* noop */ }
    }
  }
  try {
    db.deleteDevice(id);
  } catch { /* noop */ }
  try {
    db.deleteDeviceSession(id);
  } catch { /* sin sesión: noop */ }
  try {
    unbindDevice(db, id);
  } catch { /* noop */ }
  try {
    services?.wsManager?.disconnectDevice?.(id);
  } catch { /* noop */ }
  try {
    for (const p of db.getProfiles()) db.repairAssignments(p.id);
  } catch { /* noop */ }
  try {
    services?.wsManager?.broadcast?.('device.deleted', { deviceId: id }, 'pages');
    services?.wsManager?.broadcast?.('device.offline', { deviceId: id, online: false }, 'devices');
    services?.wsManager?.broadcast?.('assignment.updated', { deviceDeleted: id }, 'pages');
  } catch { /* noop */ }
  return { forgotten: true };
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
      }      const devices = db.listDevices();
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
      // La asignación manda: los navegadores/móviles cuya vista actual no
      // coincide con la asignada abren su pantalla al momento (navegación
      // dirigida sin tocar el current global del anfitrión). Se compara con
      // la vista real (no con el cambio del mapa) para rescatar también
      // estados desincronizados. Al HW lo mueve el bloque de abajo.
      try {
        const nav = services?.wsManager;
        if (nav && typeof nav.navigatePageTo === 'function') {
          for (const deviceId of Object.keys(wanted)) {
            if (!byId.has(deviceId)) continue;
            if (byId.get(deviceId)?.kind === 'deck') continue;
            const finalPage = assignments[deviceId];
            if (!finalPage) continue;
            let current: string | null = null;
            try {
              current = nav.getSessionView(deviceId)?.pageId ?? null;
            } catch { /* sin vista: se navega igual (persiste para reconectar) */ }
            if (current === finalPage) continue;
            nav.navigatePageTo({
              pageId: finalPage,
              originDeviceId: null,
              targets: { kind: 'devices', ids: [deviceId] },
              context: { via: 'device-assignment' },
              updateGlobal: false,
            });
          }
        }
      } catch { /* noop */ }
      // El HW físico sigue la asignación EXPLÍCITA (nunca al revés): si
      // cambió un deck, fijar su sesión y repintar a su página final
      // (post-repair). Sin esto el botón "dispositivos" no movía nada
      // físico. Best-effort: nunca tumba el guardado.
      // OJO: sin guarda de perfil. La asignación es intención explícita del
      // usuario: si le pone al deck una página de otro perfil, el deck la
      // muestra (y su sesión pasa a ese perfil). La guarda anterior
      // (`sameProfile`) dejaba al HW clavado en la primera página que vio
      // al arrancar porque navigatePageTo nunca actualizaba su sesión.
      try {
        const changedDecks = Object.entries(wanted)
          .filter(([id, p]) => p !== null && byId.get(id)?.kind === 'deck')
          .map(([id]) => id);
        if (changedDecks.length > 0) {
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
            try {
              // Fija sesión (memoria + tabla) y repinta si hay HW; sin HW
              // conectado igual queda guardado para la reconexión.
              await streamDeckDriver.setSessionView({ profileId, pageId: finalPage });
              // Compat con el camino anterior: la asignación al HW también
              // movía el current global (integraciones/driver lo leen).
              db.setCurrentPage(finalPage);
            } catch (e) {
              // Incompatible con el HW real (p. ej. modelo mal configurado
              // frente a la geometría viva): avisar sin tumbar el guardado.
              try {
                services.wsManager?.broadcast?.('page.blocked', {
                  pageId: finalPage,
                  reason: e instanceof Error ? e.message : String(e),
                  pageName: db.getPage(finalPage)?.name ?? null,
                }, 'pages');
              } catch { /* noop */ }
            }
          }
        }
      } catch { /* noop */ }
      return jsonResponse({ assignments, repaired: fixed });
    }

    return null;
  }

  // ---- CRUD de dispositivos ----
  // GET devuelve la lista UNIFICADA (hardware + navegadores aceptados +
  // legado) con `online`/`source`/`lastSeen`. Es la única que consume la UI:
  // ya no hay altas manuales (el POST queda para restaurar/deshacer y MCP).
  if (path === '/api/v1/devices') {
    if (method === 'GET') {
      return jsonResponse(buildUnifiedDevices(db, services));
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
      // El hardware solo admite renombrar: su clase/geometría la manda el
      // driver detectado, no la edición manual.
      if (isHardwareDeviceId(id)) {
        const forbidden = ['kind', 'model', 'cols', 'rows', 'hw_path'].filter((k) => body?.[k] !== undefined);
        if (forbidden.length > 0) {
          return jsonResponse({ error: `El hardware solo admite renombrar (campos bloqueados: ${forbidden.join(', ')})` }, 400);
        }
      }
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
      // El hardware físico no se puede eliminar ni revocar: siempre existe.
      if (isHardwareDeviceId(id)) {
        return jsonResponse({ error: 'El hardware no se puede eliminar' }, 403);
      }
      const existing = db.getDevice(id);
      if (!existing) return jsonResponse({ error: 'Device not found' }, 404);
      const snapshot = {
        device: existing,
        assignments: db.getProfiles().map((p) => ({ profileId: p.id, pageId: db.getAssignments(p.id)[id] ?? null })),
      };
      // Olvidar = prohibir: revoca sesiones vinculadas, borra filas y
      // cierra sus WS (ver forgetDeviceEverywhere).
      forgetDeviceEverywhere(db, services, id);
      // Snapshot para deshacer en el frontend (re-crea dispositivo + asignaciones).
      return jsonResponse({ success: true, snapshot });
    }
    return null;
  }

  void url;
  return null;
};
