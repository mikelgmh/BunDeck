/** Rutas `/api/v1/actions/*` — ejecución y estado del ActionRunner. */
import { v4 as uuidv4 } from 'uuid';
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';

export const handleActions: ApiHandler = async (_req, { method, path, services }) => {
  if (path === '/api/v1/actions/execute') {
    if (method === 'POST') {
      const body = await _req.json();
      const { action, context } = body;

      const actionId = uuidv4();
      services.wsManager.broadcastActionStarted(actionId, { action, context });

      try {
        const result = await services.actionRunner.executeAction(action, {
          ...context,
          timestamp: Date.now(),
        });

        if (result.success) {
          services.wsManager.broadcastActionFinished(actionId, result);

          // Check if this is a page navigation action
          if (result.result && result.result.action === 'navigate_to_page') {
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
