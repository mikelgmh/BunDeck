/** Rutas `/api/v1/actions/*` — ejecución y estado del ActionRunner. */
import { v4 as uuidv4 } from 'uuid';
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';
import type { DatabaseService } from '../db';
import { resolveNavTargets } from '../sessions';

const EXECUTE_MANY_MAX_ITEMS = 32;

function isPlainRecord(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Núcleo compartido singular/batch. Devuelve el ActionResult de ejecutar
 * `action` con `context` (sin envolver en Response). Si la ejecución LANZA
 * (no un fallo de acción), marca `__threw` para que la ruta singular
 * conserve su 500 histórico; el batch lo deja como resultado en orden.
 */
async function execOne(
  services: Parameters<ApiHandler>[1]['services'],
  db: DatabaseService | null,
  action: any,
  context: any,
): Promise<any> {
  const quiet = (context as any)?.quiet === true;
  const actionId = uuidv4();
  if (!quiet) {
    services.wsManager.broadcastActionStarted(actionId, { action, context });
  }

  try {
    const result = await services.actionRunner.executeAction(action, {
      ...context,
      timestamp: Date.now(),
    });

    // Log por pulsación (1 fila, runId null): solo si hay buttonId en el
    // contexto y no es polling silencioso. Best-effort, sin parameters.
    if ((context as any)?.buttonId && !(context as any)?.quiet) {
      try {
        const svc: DatabaseService | null = db ?? null;
        const enabled = (() => { try { return svc?.getSetting('logs.press_enabled') !== 'false'; } catch { return true; } })();
        if (enabled && svc && typeof (svc as any).addPressLog === 'function') {
          const rawDev = (context as any)?.deviceId ?? (context as any)?.device_id ?? (context as any)?.clientId ?? null;
          const deviceId = rawDev === null || rawDev === undefined ? null : String(rawDev);
          let deviceName: string | null = null;
          if (deviceId) {
            try {
              deviceName = svc.getDevice(deviceId)?.name
                ?? svc.getDeviceSession(deviceId)?.name ?? null;
            } catch { /* mejor esfuerzo */ }
          }
          const err = typeof result.error === 'string' ? result.error.slice(0, 500) : null;
          svc.addPressLog({
            buttonId: String((context as any).buttonId),
            pageId: (context as any)?.pageId ?? null,
            profileId: (context as any)?.profileId ?? null,
            position: (context as any)?.position ?? null,
            pressType: (context as any)?.pressType ?? 'short',
            deviceId, deviceName,
            source: (context as any)?.source ?? 'api',
            actionType: String((action as any)?.type ?? 'unknown'),
            actionIndex: 0,
            actionId: (action as any)?.id ?? null,
            runId: null,
            success: result.success !== false,
            error: err,
            durationMs: typeof result.duration === 'number' ? result.duration : null,
          });
        }
      } catch { /* mejor esfuerzo: la acción ya se ejecutó */ }
    }

    if (result.success) {
      if (!quiet) {
        services.wsManager.broadcastActionFinished(actionId, result);
      }

      // Check if this is a page navigation action.
      // Dirigida por defecto: solo el dispositivo que ejecuta la acción
      // (context.target/deviceId) la aplica; con broadcast/target 'all'
      // llega a todos (compat: sin contexto de dispositivo → broadcast).
      if (result.result && result.result.action === 'navigate_to_page') {
        const origin = context?.deviceId ?? context?.device_id ?? context?.clientId ?? null;
        const targets = origin
          ? resolveNavTargets(context, String(origin))
          : { kind: 'all' as const };
        if (typeof services.wsManager.navigatePageTo === 'function') {
          services.wsManager.navigatePageTo({
            pageId: result.result.pageId,
            pageName: result.result.pageName,
            originDeviceId: origin ? String(origin) : null,
            targets,
            context,
          });
        } else {
          services.wsManager.broadcast(
            'page.navigate',
            {
              pageId: result.result.pageId,
              pageName: result.result.pageName,
              context,
            },
            'pages'
          );
        }
      }

      // Check if this is a profile navigation action (profile-auto.switch-profile/restore)
      if (result.result && result.result.action === 'navigate_to_profile') {
        const origin = context?.deviceId ?? context?.device_id ?? context?.clientId ?? null;
        const targets = origin
          ? resolveNavTargets(context, String(origin))
          : { kind: 'all' as const };
        if (typeof services.wsManager.navigateProfileTo === 'function') {
          services.wsManager.navigateProfileTo({
            profileId: result.result.profileId,
            originDeviceId: origin ? String(origin) : null,
            targets,
            context,
          });
        } else {
          services.wsManager.broadcast(
            'profile.navigate',
            {
              profileId: result.result.profileId,
              context,
            },
            'profiles'
          );
        }
      }
    } else if (!quiet) {
      services.wsManager.broadcastActionError(actionId, result.error);
    }

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (!quiet) services.wsManager.broadcastActionError(actionId, errorMessage);
    return { success: false, error: errorMessage, __threw: true };
  }
}

/**
 * Normaliza el cuerpo del batch a `[{action, context}]` en orden.
 * Formas aceptadas:
 * - `{ items: [{ action, context? }] }` (sondeo multi-botón: cada item
 *   lleva su contexto buttonId/pageId/position; `quiet` por item).
 * - `{ actions: [...] }` + `context` común opcional: cada elemento es una
 *   acción suelta o `{ action, context? }` (pulsación de tecla: 1 round-trip
 *   por botón en vez de N `POST /actions/execute` en serie).
 */
function normalizeBatch(body: any): Array<{ action: any; context: any }> | { error: string } {
  const shared = isPlainRecord(body?.context) ? body.context : {};
  const sharedQuiet = (body as any)?.quiet;
  const raw: unknown = Array.isArray(body?.items)
    ? body.items
    : Array.isArray(body?.actions)
      ? body.actions
      : null;
  if (!raw) return { error: 'actions (o items) requerido: array no vacío' };
  const list = raw as any[];
  if (list.length === 0) return { error: 'actions (o items) requerido: array no vacío' };
  if (list.length > EXECUTE_MANY_MAX_ITEMS) {
    return { error: `demasiados items (máx ${EXECUTE_MANY_MAX_ITEMS})` };
  }
  const out: Array<{ action: any; context: any }> = [];
  for (const el of list) {
    if (isPlainRecord(el) && 'action' in el) {
      const itemCtx = isPlainRecord((el as any).context) ? (el as any).context : {};
      out.push({
        action: (el as any).action,
        context: {
          ...shared,
          ...itemCtx,
          ...(sharedQuiet !== undefined && (itemCtx as any)?.quiet === undefined
            ? { quiet: sharedQuiet }
            : {}),
        },
      });
    } else {
      out.push({ action: el, context: { ...shared } });
    }
  }
  for (const { action } of out) {
    if (!isPlainRecord(action) || typeof (action as any).type !== 'string' || !(action as any).type) {
      return { error: 'cada item necesita action.type (string no vacío)' };
    }
  }
  return out;
}

export const __testOnly = { normalizeBatch, EXECUTE_MANY_MAX_ITEMS };

export const handleActions: ApiHandler = async (_req, { method, path, db, services }) => {
  if (path === '/api/v1/actions/execute') {
    if (method === 'POST') {
      const body = await _req.json();
      const { action, context } = body;
      const raw = await execOne(services, db, action, context ?? {});
      // Compat: la excepción del runner era 500 en el singular (el fallo
      // de acción —success:false— sigue siendo 200 con su cuerpo).
      if ((raw as any)?.__threw === true) {
        const { __threw, ...rest } = raw as any;
        void __threw;
        return jsonResponse(rest, 500);
      }
      return jsonResponse(raw);
    }
  }

  if (path === '/api/v1/actions/execute-many') {
    if (method === 'POST') {
      let body: any = null;
      try {
        body = await _req.json();
      } catch {
        return jsonResponse({ error: 'cuerpo JSON inválido' }, 400);
      }
      const items = normalizeBatch(body);
      if (!Array.isArray(items)) {
        return jsonResponse({ error: items.error }, 400);
      }
      // En orden, como el bucle secuencial del frontend al que sustituye.
      const results: any[] = [];
      for (const { action, context } of items) {
        const r = await execOne(services, db, action, context);
        if ((r as any)?.__threw === true) {
          const { __threw, ...rest } = r as any;
          void __threw;
          results.push(rest);
        } else {
          results.push(r);
        }
      }
      return jsonResponse({ results });
    }
  }

  if (path === '/api/v1/actions/running') {
    if (method === 'GET') {
      const runningActions = services.actionRunner.getRunningActions();
      return jsonResponse(runningActions);
    }
  }

  if (path === '/api/v1/actions/stats') {
    if (method === 'GET') {
      const stats = services.actionRunner.getActionStats();
      return jsonResponse(stats);
    }
  }

  return null;
};
