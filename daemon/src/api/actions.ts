/** Rutas `/api/v1/actions/*` — ejecución y estado del ActionRunner. */
import { v4 as uuidv4 } from 'uuid';
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';
import { resolveNavTargets } from '../sessions';

export const handleActions: ApiHandler = async (_req, { method, path, services }) => {
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
