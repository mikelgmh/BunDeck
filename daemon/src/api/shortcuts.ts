/**
 * Rutas `/api/v1/shortcuts/*` — atajos globales de teclado.
 *
 * - La web registra sus atajos en `settings` (`shortcuts.config`); el
 *   launcher Rust los sondea y los registra con RegisterHotKey (Win32).
 * - POST /api/v1/shortcuts/trigger { id, source?, executionId? } ejecuta
 *   las acciones de servidor (perfil siguiente/anterior, silenciar todo)
 *   y difunde `shortcut.triggered` (topic `shortcuts`) para que los
 *   clientes web apliquen las acciones solo-UI (paneles, kiosco).
 *
 * Regla anti-doble-ejecución ("el primero que captura gana"): ventana de
 * 800 ms por id; un segundo trigger con otro `executionId` dentro de la
 * ventana se rechaza con { deduped: true }. El mismo `executionId`
 * repetido (reintento/eco) también se rechaza. Los clientes web ignoran
 * además los broadcasts cuyo `executionId` ya ejecutaron en local.
 */
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';

export const SHORTCUT_IDS = [
  'toggle-panels',
  'next-profile',
  'prev-profile',
  'mute-all',
  'toggle-kiosk',
] as const;

export type ShortcutId = (typeof SHORTCUT_IDS)[number];

/** Solo-UI: el daemon no las ejecuta, solo las difunde a los clientes. */
const UI_ONLY: ReadonlySet<string> = new Set(['toggle-panels', 'toggle-kiosk']);

/** Ventana "el primero gana" por id (ms) + memoria de ecos (ms). */
export const FIRST_WINS_MS = 800;
const ECHO_MEMORY_MS = 30_000;

interface TriggerRecord {
  executionId: string | null;
  at: number;
}

const lastById = new Map<string, TriggerRecord>();

function now(): number {
  return Date.now();
}

export function stepProfileIds(ids: string[], activeId: string | null, dir: 1 | -1): string | null {
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0];
  const i = activeId ? ids.indexOf(activeId) : -1;
  if (i === -1) return dir === 1 ? ids[0] : ids[ids.length - 1];
  return ids[(i + dir + ids.length) % ids.length];
}

export const handleShortcuts: ApiHandler = async (_req, { url, method, path, db, services }) => {
  if (path === '/api/v1/shortcuts/trigger' && method === 'POST') {
    const body: any = await _req.json().catch(() => ({}));
    const id = String(body?.id ?? '');
    const source = String(body?.source ?? 'unknown');
    const executionId = typeof body?.executionId === 'string' && body.executionId ? body.executionId : null;

    if (!id || !(SHORTCUT_IDS as readonly string[]).includes(id)) {
      return jsonResponse({ error: `id de atajo desconocido: ${id || '(vacío)'}`, known: [...SHORTCUT_IDS] }, 400);
    }

    // `notifyOnly` (la web ya lo ejecutó en local): es un aviso, no una
    // captura — no compite en la ventana first-wins ni la envenena: solo
    // difunde a otros clientes sin re-ejecutar acciones de servidor.
    if (body?.notifyOnly === true) {
      try {
        services.wsManager?.broadcast?.(
          'shortcut.triggered',
          { id, source, executionId, server: { handled: false, notified: true }, timestamp: Date.now() },
          'shortcuts',
        );
      } catch {
        /* mejor esfuerzo */
      }
      return jsonResponse({ ok: true, id, deduped: false, notified: true });
    }

    // Anti-doble-ejecución: el primero que captura gana.
    const prev = lastById.get(id);
    const t = now();
    if (prev) {
      if (executionId && prev.executionId === executionId && t - prev.at < ECHO_MEMORY_MS) {
        return jsonResponse({ ok: true, id, deduped: true, reason: 'echo' });
      }
      if (t - prev.at < FIRST_WINS_MS && prev.executionId !== executionId) {
        return jsonResponse({ ok: true, id, deduped: true, reason: 'first-wins' });
      }
    }
    lastById.set(id, { executionId, at: t });

    let serverResult: any = { handled: false };

    if (id === 'next-profile' || id === 'prev-profile') {
      const profiles = db.getProfiles();
      if (profiles.length === 0) {
        return jsonResponse({ error: 'Sin perfiles' }, 404);
      }
      const current = db.getSetting('current.profile_id');
      const target = stepProfileIds(
        profiles.map((p: any) => p.id),
        current,
        id === 'next-profile' ? 1 : -1,
      );
      if (!target) return jsonResponse({ error: 'Sin perfiles' }, 404);
      if (typeof services.wsManager?.navigateProfileTo === 'function') {
        services.wsManager.navigateProfileTo({
          profileId: target,
          originDeviceId: null,
          targets: { kind: 'all' as const },
          context: { source: 'shortcut', shortcutId: id, executionId },
        });
      } else {
        db.setCurrentProfile(target);
        services.wsManager?.broadcast?.('profile.navigate', { profileId: target }, 'profiles');
      }
      serverResult = { handled: true, profileId: target };
    } else if (id === 'mute-all') {
      try {
        const result = await services.actionRunner?.executeAction?.(
          { type: 'app-volume', pluginId: 'audio-mixer', parameters: { mute: 'true' } },
          { source: 'shortcut', shortcutId: id, executionId, timestamp: Date.now() },
        );
        serverResult = { handled: true, result: result?.result ?? result ?? null };
      } catch (error) {
        serverResult = { handled: false, error: error instanceof Error ? error.message : String(error) };
      }
    } else {
      // toggle-panels / toggle-kiosk: solo-UI, el daemon solo difunde.
      serverResult = { handled: false, uiOnly: true };
    }

    try {
      services.wsManager?.broadcast?.(
        'shortcut.triggered',
        { id, source, executionId, server: serverResult, timestamp: Date.now() },
        'shortcuts',
      );
    } catch {
      /* mejor esfuerzo */
    }

    return jsonResponse({ ok: true, id, deduped: false, ...serverResult });
  }

  // Lista de ids conocidos (el launcher valida antes de registrar).
  if (path === '/api/v1/shortcuts' && method === 'GET') {
    void url;
    return jsonResponse({ ids: [...SHORTCUT_IDS], uiOnly: [...UI_ONLY], firstWinsMs: FIRST_WINS_MS });
  }

  return null;
};
