/** Rutas `/api/v1/actions/*` — ejecución y estado del ActionRunner. */
import { v4 as uuidv4 } from 'uuid';
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';
import type { DatabaseService } from '../db';
import { resolveNavTargets } from '../sessions';

export const handleActions: ApiHandler = async (_req, { method, path, db, services }) => {
  if (path === '/api/v1/actions/execute') {
    if (method === 'POST') {
      const body = await _req.json();
      const { action, context } = body;
      // Polling silencioso (botones dinámicos, cada 500 ms): sin logs en BD
      // ni broadcasts WS por ejecución; solo errores.
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
        } else {
          services.wsManager.broadcastActionError(actionId, result.error);
        }

        return jsonResponse(result);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        services.wsManager.broadcastActionError(actionId, errorMessage);

        return jsonResponse(
          {
            success: false,
            error: errorMessage,
          },
          500
        );
      }
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
