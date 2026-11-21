import { WebSocketManager } from '../ws';
import { PluginLoader } from '../plugin-loader';
import { ActionRunner } from '../action-runner';
import { windowWatcher } from '../window-watcher';
import { DatabaseService } from '../db';
import { v4 as uuidv4 } from 'uuid';
import { handleMcpBody } from '../mcp/server';
import { listMcpTokens, createMcpToken, updateMcpToken, revokeMcpToken, verifyMcpToken, bearerFromHeaders } from '../mcp/tokens';
import { MCP_SCOPES } from '../mcp/scopes';
import { importElgatoPlugin } from '../elgato/import';
import { getSystemMetricsScript } from '../scripts/system-metrics.ps1';
import { join, dirname } from 'path';
import { readdir } from 'fs/promises';
import { createWriteStream, createReadStream } from 'fs';
import { mkdir, rm, rename } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';
import { streamDeckDriver } from '../hw-driver/streamdeck-driver';

interface APIServices {
  wsManager: WebSocketManager;
  pluginLoader: PluginLoader;
  actionRunner: ActionRunner;
  windowWatcher: typeof windowWatcher;
}

export async function setupAPIRoutes(
  req: Request,
  services: APIServices
): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;
  const path = url.pathname;

  const db = new DatabaseService();

  try {
    // Test endpoint for connectivity
    if (path === '/api/v1/test') {
      if (method === 'GET') {
        return jsonResponse({
          status: 'ok',
          message: 'Daemon is running',
          timestamp: Date.now()
        })
      }
    }

    // Config endpoint for frontend — usa puertos centralizados (config.ts)
    if (path === '/config') {
      if (method === 'GET') {
        const { WS_PORT, API_PORT, FRONTEND_PORT } = await import('../config');
        const config: any = {
          wsPort: WS_PORT,
          apiPort: API_PORT,
          frontendPort: FRONTEND_PORT
        };
        return jsonResponse(config);
      }
    }

    // Profiles endpoints
    if (path === '/api/v1/profiles') {
      if (method === 'GET') {
        const profiles = db.getProfiles();
        return jsonResponse(profiles);
      }

      if (method === 'POST') {
        const body = await req.json();
        const profile = {
          id: uuidv4(),
          name: body.name,
          data: body.data || {}
        };

        const createdProfile = db.createProfile(profile);
        services.wsManager.broadcastProfileUpdate(profile.id, createdProfile);

        return jsonResponse(createdProfile, 201);
      }
    }

    if (path.startsWith('/api/v1/profiles/')) {
      const profileId = path.split('/')[4];

      if (method === 'GET') {
        const profile = db.getProfile(profileId);
        if (!profile) {
          return jsonResponse({ error: 'Profile not found' }, 404);
        }
        return jsonResponse(profile);
      }

      if (method === 'PUT') {
        const body = await req.json();
        db.updateProfile(profileId, body);

        const updatedProfile = db.getProfile(profileId);
        services.wsManager.broadcastProfileUpdate(profileId, updatedProfile);

        return jsonResponse(updatedProfile);
      }

      if (method === 'DELETE') {
        db.deleteProfile(profileId);
        services.wsManager.broadcast('profile.deleted', { profileId });
        return jsonResponse({ success: true });
      }
    }

    // Pages endpoints
    if (path === '/api/v1/pages') {
      if (method === 'GET') {
        const profileId = url.searchParams.get('profileId');
        if (!profileId) {
          return jsonResponse({ error: 'profileId parameter required' }, 400);
        }

        const pages = db.getPagesByProfile(profileId);
        return jsonResponse(pages);
      }

      if (method === 'POST') {
        const body = await req.json();
        const page = {
          id: uuidv4(),
          profile_id: body.profile_id,
          name: body.name,
          order_idx: body.order_idx || 0,
          is_folder: body.is_folder || 0,
          data: body.data || {}
        };

        try {
          db.createPage(page);
          services.wsManager.broadcastPageCreated(page.id, page);

          return jsonResponse(page, 201);
        } catch (error) {
          if (error instanceof Error && error.message.includes('already exists')) {
            return jsonResponse({ error: error.message }, 409);
          }
          throw error;
        }
      }
    }

    if (path.startsWith('/api/v1/pages/')) {
      const pageId = path.split('/')[4];

      if (method === 'GET') {
        const page = db.getPage(pageId);
        if (!page) {
          return jsonResponse({ error: 'Page not found' }, 404);
        }
        return jsonResponse(page);
      }

      if (method === 'PUT') {
        const body = await req.json();
        const page = db.getPage(pageId);
        if (!page) {
          return jsonResponse({ error: 'Page not found' }, 404);
        }

        try {
          db.updatePage(pageId, body);
          const updatedPage = db.getPage(pageId);
          services.wsManager.broadcast('page.updated', { pageId, page: updatedPage }, 'pages');
          return jsonResponse(updatedPage);
        } catch (error) {
          if (error instanceof Error && error.message.includes('already exists')) {
            return jsonResponse({ error: error.message }, 409);
          }
          throw error;
        }
      }

      if (method === 'DELETE') {
        const page = db.getPage(pageId);
        if (!page) {
          return jsonResponse({ error: 'Page not found' }, 404);
        }

        db.deletePage(pageId);
        services.wsManager.broadcastPageDeleted(pageId);
        return jsonResponse({ success: true });
      }
    }

    // Buttons endpoints
    if (path === '/api/v1/buttons') {
      if (method === 'GET') {
        const pageId = url.searchParams.get('pageId');
        if (!pageId) {
          return jsonResponse({ error: 'pageId parameter required' }, 400);
        }

        const buttons = db.getButtonsByPage(pageId);
        return jsonResponse(buttons);
      }

      if (method === 'POST') {
        const body = await req.json();
        const button = {
          id: uuidv4(),
          page_id: body.page_id,
          position: body.position,
          data: body.data || {}
        };

        try {
          db.createButton(button);
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            return jsonResponse({ error: `La posición ${body.position} ya está ocupada en esta página` }, 409);
          }
          throw error;
        }
        services.wsManager.broadcast('button.created', { buttonId: button.id, button, mutationId: (body as any)?.mutationId }, 'buttons');

        // Repintado diferido (no bloquea la respuesta): el vaciado/creación
        // respondía tras un repintado completo y parecía "pillado".
        if (streamDeckDriver.isConnected()) {
          streamDeckDriver.scheduleUpdateFromPage(button.page_id);
        }

        return jsonResponse(button, 201);
      }
    }

    // Reordenado atómico de botones (drag & drop): una sola transacción en BD,
    // un solo broadcast y un solo repintado del StreamDeck. Evita posiciones
    // duplicadas por fallos parciales de N PUTs individuales.
    if (path === '/api/v1/buttons/reorder') {
      if (method === 'POST') {
        try {
          const raw = (await req.json()) as any;
          const { page_id, order } = raw ?? {};
          if (!page_id || !Array.isArray(order)) {
            return jsonResponse({ error: 'page_id y order (array) requeridos' }, 400);
          }

          const updated = db.reorderButtons(page_id, order);
          services.wsManager.broadcastButtonsReordered(page_id, updated, (raw as any)?.mutationId);

          // Repintado diferido y coalescado (no bloquea la respuesta).
          if (streamDeckDriver.isConnected()) {
            streamDeckDriver.scheduleUpdateFromPage(page_id);
          }

          return jsonResponse({ success: true, buttons: updated });
        } catch (error) {
          if (error instanceof Error && /no encontrado|no pertenece|duplicada|inválido|vacío/.test(error.message)) {
            return jsonResponse({ error: error.message }, 400);
          }
          if (isUniqueConstraintError(error)) {
            return jsonResponse({ error: 'Conflicto de posiciones: recarga los botones e inténtalo de nuevo' }, 409);
          }
          throw error;
        }
      }
    }

    if (path.startsWith('/api/v1/buttons/')) {
      const buttonId = path.split('/')[4];

      if (method === 'GET') {
        const button = db.getButton(buttonId);
        if (!button) {
          return jsonResponse({ error: 'Button not found' }, 404);
        }
        return jsonResponse(button);
      }

      if (method === 'PUT') {
        const body = await req.json();

        try {
          // Use new complete update function if position is provided
          if (body.position !== undefined) {
            db.updateButtonComplete(buttonId, {
              data: body.data,
              position: body.position
            });
          } else {
            db.updateButton(buttonId, body.data);
          }
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            return jsonResponse({ error: `La posición ${body.position} ya está ocupada en esta página` }, 409);
          }
          throw error;
        }

        const updatedButton = db.getButton(buttonId);
        services.wsManager.broadcastButtonUpdate(buttonId, updatedButton, (body as any)?.mutationId);

        // Repintado diferido (no bloquea la respuesta).
        if (streamDeckDriver.isConnected() && updatedButton) {
          streamDeckDriver.scheduleUpdateFromPage(updatedButton.page_id);
        }

        return jsonResponse(updatedButton);
      }

      if (method === 'DELETE') {
        const button = db.getButton(buttonId);
        if (!button) {
          return jsonResponse({ error: 'Button not found' }, 404);
        }

        const pageId = button.page_id;
        db.deleteButton(buttonId);
        const deleteBody = await req.json().catch(() => ({}));
        services.wsManager.broadcastButtonDeleted(buttonId, (deleteBody as any)?.mutationId);

        // Repintado diferido (no bloquea la respuesta): vaciar respondía
        // tras el repintado completo y la UI parecía congelada.
        if (streamDeckDriver.isConnected()) {
          streamDeckDriver.scheduleUpdateFromPage(pageId);
        }

        return jsonResponse({ success: true });
      }
    }

    // Actions endpoints
    if (path === '/api/v1/actions/execute') {
      if (method === 'POST') {
        const body = await req.json();
        const { action, context } = body;

        const actionId = uuidv4();
        services.wsManager.broadcastActionStarted(actionId, { action, context });

        try {
          const result = await services.actionRunner.executeAction(action, {
            ...context,
            timestamp: Date.now()
          });

          if (result.success) {
            services.wsManager.broadcastActionFinished(actionId, result);

            // Check if this is a page navigation action
            if (result.result && result.result.action === 'navigate_to_page') {
              services.wsManager.broadcast('page.navigate', {
                pageId: result.result.pageId,
                pageName: result.result.pageName,
                context
              }, 'pages');
            }
          } else {
            services.wsManager.broadcastActionError(actionId, result.error);
          }

          return jsonResponse(result);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          services.wsManager.broadcastActionError(actionId, errorMessage);

          return jsonResponse({
            success: false,
            error: errorMessage
          }, 500);
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

    // Plugins endpoints
    if (path === '/api/v1/plugins') {
      if (method === 'GET') {
        const detailed = services.pluginLoader.listDetailed();
        const loadedPlugins = Array.from(services.pluginLoader.getLoadedPlugins().entries());
        const installed = db.getPlugins();

        return jsonResponse({
          installed,
          loaded: loadedPlugins.map(([id, plugin]) => ({
            id,
            manifest: plugin.manifest,
            enabled: plugin.enabled
          })),
          // Detalle enriquecido para el gestor (instalados + estado + errores)
          detailed,
        });
      }
    }

    // Marketplace: registry remoto (lista de plugins instalables)
    if (path === '/api/v1/marketplace') {
      if (method === 'GET') {
        try {
          const registryUrl = db.getSetting('marketplace.registry_url') || process.env.LIBREDECK_MARKETPLACE_URL || '';
          if (!registryUrl) {
            return jsonResponse({ plugins: [], registryUrl: null, hint: 'Configura marketplace.registry_url (settings) con la URL del registry JSON' });
          }
          const res = await fetch(registryUrl);
          if (!res.ok) return jsonResponse({ error: `Registry respondió ${res.status}` }, 502);
          const data = await res.json();
          const plugins = Array.isArray(data) ? data : (data.plugins ?? []);
          return jsonResponse({ plugins, registryUrl });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 502);
        }
      }
    }

    if (path === '/api/v1/plugins/install') {
      if (method === 'POST') {
        try {
          const body = await req.json();
          const { sourceType, url, ref, version, checksum, force, origin } = body ?? {};
          void version;
          const prog = (stage: string, message: string) =>
            services.wsManager.broadcast('plugin.install-progress', { key: url ?? '', stage, message, ts: Date.now() }, 'plugins');
          let id: string;
          const looksZip = /\.zip(\?|#|$)/i.test(url);
          if (sourceType === 'git' || (!sourceType && url && !looksZip)) {
            if (!url) return jsonResponse({ error: 'url requerida para git' }, 400);
            id = await services.pluginLoader.installPluginFromGit(url, { ref, force: !!force, onProgress: prog });
          } else if (sourceType === 'marketplace' || sourceType === 'url' || (url && looksZip)) {
            if (!url) return jsonResponse({ error: 'url requerida' }, 400);
            if (!looksZip) {
              // Marketplace apuntando a repo git: clonar, no descargar zip
              id = await services.pluginLoader.installPluginFromGit(url, { ref, force: !!force, onProgress: prog });
              // Marcar origen marketplace aunque venga de git
              try { db.upsertPluginRecord({ id, source_type: 'marketplace', origin: origin ?? url } as any); } catch {}
            } else {
              id = await services.pluginLoader.installPluginFromUrl(url, {
                force: !!force, checksum, origin: origin ?? url, sourceType: 'marketplace', onProgress: prog,
              });
            }
          } else {
            return jsonResponse({ error: 'sourceType inválido (git | marketplace | url)' }, 400);
          }
          const plugin = db.getPlugin(id);
          services.wsManager.broadcastPluginInstalled(id, plugin);
          const status = services.pluginLoader.getStatus(id) as any;
          const extra = status?.sourceType === 'elgato'
            ? { elgato: true, note: status?.status === 'elgato-stopped' ? 'Plugin Elgato habilitado por defecto (arrancando runtime en segundo plano).' : `Plugin Elgato: ${status?.status ?? 'instalado'}` }
            : {};
          return jsonResponse({ success: true, pluginId: id, plugin, ...extra }, 201);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
    }

    // ---- Importación Elgato (.sdPlugin / repo git). Fase 2: convierte,
    // compila desde fuentes si hace falta (DeckCal trae src/, no bin/),
    // instala dependencias con bun (fallback npm) y habilita por defecto
    // (elgato-stopped + auto-arranque). needs-runtime solo si es nativo
    // o falta CodePath. Con dryRun solo informe.
    if (path === '/api/v1/plugins/import-elgato') {
      if (method === 'POST') {
        try {
          const body = await req.json().catch(() => ({}));
          const { url, dir, zipPath, dryRun } = body ?? {};
          if (!url && !dir && !zipPath) {
            return jsonResponse({ error: 'url (repo git o .streamDeckPlugin), dir o zipPath requerido' }, 400);
          }
          const key = url ?? dir ?? zipPath ?? '';
          const prog = (stage: string, message: string) =>
            services.wsManager.broadcast('plugin.install-progress', { key, stage, message, ts: Date.now() }, 'plugins');
          const result = await importElgatoPlugin(db, { url, dir, zipPath }, { dryRun: !!dryRun, onProgress: prog });
          if (!result.installed) {
            services.wsManager.broadcast('plugin.install-progress', { key, stage: 'done', message: 'Diagnóstico completado (no instalado)', ts: Date.now() }, 'plugins');
          } else {
            // Habilitado por defecto: arranca el runtime en segundo plano
            // (sin bloquear la respuesta; el progreso va por WS).
            try {
              const rec = db.getPlugin(result.pluginId) as any;
              if (rec && Number(rec.enabled) === 1 && rec.status === 'elgato-stopped') {
                void services.pluginLoader.loadElgatoPlugin(result.pluginId).catch(() => {});
              }
            } catch {}
          }
          return jsonResponse(result, result.installed ? 201 : 200);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
    }

    if (path === '/api/v1/plugins/upload') {
      if (method === 'POST') {
        try {
          const form = await req.formData();
          const file = form.get('file') as any;
          const force = form.get('force') === 'true' || form.get('force') === '1';
          if (!file) return jsonResponse({ error: 'file requerido (.zip)' }, 400);
          const name = (file.name ?? 'plugin.zip') as string;
          if (!/\.(zip|plectro)$/i.test(name)) return jsonResponse({ error: 'Solo .zip / .plectro' }, 400);
          const tmp = `${process.cwd()}/.upload_${Date.now()}.zip`;
          const { writeFile } = await import('fs/promises');
          await writeFile(tmp, Buffer.from(await file.arrayBuffer()));
          try {
            const id = await services.pluginLoader.installPluginFromZip(tmp, { force });
            const plugin = db.getPlugin(id);
            services.wsManager.broadcastPluginInstalled(id, plugin);
            return jsonResponse({ success: true, pluginId: id, plugin }, 201);
          } finally {
            try { (await import('fs')).rmSync(tmp, { force: true }); } catch {}
          }
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
    }

    // Detalle / enable-disable / uninstall / reload / rollback / update (rutas con id)
    if (path.startsWith('/api/v1/plugins/') && !path.startsWith('/api/v1/plugins/actions')) {
      const rest = path.slice('/api/v1/plugins/'.length); // "<id>" o "<id>/accion"
      const [rawId, sub] = rest.split('/');
      const pluginId = decodeURIComponent(rawId);

      if (!sub) {
        if (method === 'GET') {
          const status = services.pluginLoader.getStatus(pluginId);
          if (!status) return jsonResponse({ error: 'Plugin not found' }, 404);
          return jsonResponse(status);
        }
        if (method === 'PUT') {
          try {
            const body = await req.json();
            const { enabled } = body ?? {};
            if (typeof enabled !== 'boolean') return jsonResponse({ error: 'enabled (boolean) requerido' }, 400);
            let ok = true;
            if (enabled) ok = await services.pluginLoader.enablePlugin(pluginId);
            else await services.pluginLoader.disablePlugin(pluginId);
            if (enabled && !ok) {
              const st = services.pluginLoader.getStatus(pluginId) as any;
              const err = st?.lastError ?? `No se pudo habilitar ${pluginId}`;
              return jsonResponse({ error: err, pluginId, enabled: true, ok: false }, 400);
            }
            services.wsManager.broadcastPluginEnabled(pluginId, enabled);
            return jsonResponse({ success: true, pluginId, enabled });
          } catch (e) {
            return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
          }
        }
        if (method === 'DELETE') {
          try {
            await services.pluginLoader.uninstallPlugin(pluginId);
            return jsonResponse({ success: true });
          } catch (e) {
            return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
          }
        }
      }

      if (sub === 'reload' && method === 'POST') {
        try {
          const ok = await services.pluginLoader.reloadPlugin(pluginId);
          return jsonResponse({ success: ok, pluginId });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
      // Ajustes generales del plugin (menú ⋯): schema + valores + instrucciones
      if (sub === 'settings') {
        if (method === 'GET') {
          try {
            return jsonResponse(services.pluginLoader.getPluginSettingsBundle(pluginId));
          } catch (e) {
            return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 404);
          }
        }
        if (method === 'PUT') {
          try {
            const body = await req.json().catch(() => ({}));
            const values = await services.pluginLoader.savePluginSettings(pluginId, body?.values ?? {});
            services.wsManager.broadcastPluginSettings(pluginId);
            return jsonResponse({ success: true, pluginId, values });
          } catch (e) {
            return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
          }
        }
      }
      // Captura de token OAuth extraído en local (Electrobun Web Player).
      // Genérico por plugin pero hoy solo spotify declara oauth en el manifest.
      // Guarda TODO el bundle (token + caducidad + tipo) vía savePluginSettings.
      if (sub === 'token-capture' && method === 'POST') {
        try {
          const body = await req.json().catch(() => ({}));
          if (pluginId !== 'spotify') {
            return jsonResponse({ error: `token-capture no soportado para ${pluginId}` }, 400);
          }
          const { normalizeSpotifyTokenCapture } = await import('../plugins/spotify.plugin');
          const stored = normalizeSpotifyTokenCapture(body ?? {}, Date.now());
          const values = services.pluginLoader.savePluginSettings(pluginId, stored);
          // Limpiar las peticiones de login pendientes (explícita y de fondo).
          try { db.deleteSetting('plugin.spotify.loginRequestedAt'); } catch {}
          try { db.deleteSetting('plugin.spotify.autoRefreshRequestedAt'); } catch {}
          services.wsManager.broadcastPluginSettings(pluginId);
          return jsonResponse({ success: true, pluginId, values, expiresAt: stored.tokenExpiresAt });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
      // Señalización de login para el host Electrobun (polling):
      // el dialog pide login, el host lo ve y abre la ventana del Web Player.
      if (sub === 'login-request') {
        if (pluginId !== 'spotify') {
          return jsonResponse({ error: `login-request no soportado para ${pluginId}` }, 400);
        }
        if (method === 'POST') {
          db.setSetting('plugin.spotify.loginRequestedAt', String(Date.now()));
          return jsonResponse({ success: true, pluginId, requestedAt: db.getSetting('plugin.spotify.loginRequestedAt') });
        }
        if (method === 'GET') {
          const requestedAt = db.getSetting('plugin.spotify.loginRequestedAt');
          let bundle: any = null;
          try { bundle = services.pluginLoader.getPluginSettingsBundle(pluginId); } catch {}
          return jsonResponse({
            pluginId,
            pending: requestedAt !== null && requestedAt !== '',
            requestedAt,
            configured: bundle?.configured ?? false,
            missing: bundle?.missing ?? [],
          });
        }
        if (method === 'DELETE') {
          db.deleteSetting('plugin.spotify.loginRequestedAt');
          return jsonResponse({ success: true, pluginId });
        }
      }
      if (sub === 'rollback' && method === 'POST') {
        try {
          const ok = await services.pluginLoader.rollbackPlugin(pluginId);
          return jsonResponse({ success: ok, pluginId });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
      if (sub === 'update' && method === 'POST') {
        try {
          const body = await req.json().catch(() => ({}));
          const prog = (stage: string, message: string) =>
            services.wsManager.broadcast('plugin.install-progress', { key: pluginId, stage, message, ts: Date.now() }, 'plugins');
          const id = await services.pluginLoader.updatePlugin(pluginId, { ...(body ?? {}), onProgress: prog });
          const plugin = db.getPlugin(id);
          services.wsManager.broadcastPluginInstalled(id, plugin);
          return jsonResponse({ success: true, pluginId: id, plugin });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
      // Estado visual Elgato (setTitle/setImage/setState por contexto).
      if (sub === 'elgato-state' && method === 'GET') {
        try {
          const action = url.searchParams.get('action') ?? undefined;
          const state = await services.pluginLoader.getElgatoState(pluginId, action ?? undefined);
          return jsonResponse(state);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 404);
        }
      }
      // Pulso Elgato (keyDown+keyUp) para probar sin hardware: emula pulsar la tecla.
      if (sub === 'key' && method === 'POST') {
        try {
          const body = await req.json().catch(() => ({}));
          const { action, context } = body ?? {};
          if (!action) return jsonResponse({ error: 'action (id corto o UUID Elgato) requerido' }, 400);
          const fullId = action.includes('.') ? action : `${pluginId}.${action}`;
          const res = await services.actionRunner.executeAction(
            { type: fullId, parameters: {} },
            { buttonId: typeof context === 'string' ? context : undefined, timestamp: Date.now(), pressType: 'short' } as any
          );
          return jsonResponse({ success: res.success, result: res.result, error: res.error });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
    }

    if (path === '/api/v1/plugins/actions') {
      if (method === 'GET') {
        const loadedPlugins = Array.from(services.pluginLoader.getLoadedPlugins().entries());
        const pluginActions = Array.from(services.pluginLoader.getPluginActions().entries());

        // Group actions by plugin
        const pluginsWithActions = loadedPlugins.map(([pluginId, plugin]) => [
          pluginId,
          {
            manifest: plugin.manifest,
            enabled: plugin.enabled,
            actions: pluginActions
              .filter(([actionId]) => actionId.startsWith(`${pluginId}.`))
              .map(([actionId, action]) => [actionId.split('.')[1], action])
          }
        ]);

        return jsonResponse(pluginsWithActions);
      }
    }

    // Assets endpoints  
    if (path === '/api/v1/assets') {
      if (method === 'POST') {
        // TODO: Implement file upload
        return jsonResponse({ error: 'Asset upload not implemented yet' }, 501);
      }
    }

    // Logs endpoints
    if (path === '/api/v1/logs') {
      if (method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '100');
        const level = url.searchParams.get('level') || undefined;

        const logs = db.getLogs(limit, level);
        return jsonResponse(logs);
      }
    }

    // Settings endpoints
    if (path === '/api/v1/settings') {
      if (method === 'GET') {
        const key = url.searchParams.get('key');
        if (key) {
          const value = db.getSetting(key);
          return jsonResponse({ key, value });
        }
        // TODO: Return all settings (needs implementation in DB)
        return jsonResponse({});
      }

      if (method === 'POST') {
        const body = await req.json();
        const { key, value } = body;

        if (!key || value === undefined) {
          return jsonResponse({ error: 'key and value required' }, 400);
        }

        db.setSetting(key, value);
        return jsonResponse({ key, value });
      }
    }

    // Windows monitoring endpoints
    if (path === '/api/v1/windows/active') {
      if (method === 'GET') {
        // Obtener la ventana activa actual usando PowerShell
        const powershellScript = `
          try {
            $code = @"
            [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
            [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
"@
            $win32 = Add-Type -MemberDefinition $code -Name Win32 -Namespace "" -PassThru

            $hwnd = $win32::GetForegroundWindow()
            if ($hwnd -ne 0) {
              $processId = 0
              $win32::GetWindowThreadProcessId($hwnd, [ref]$processId)
              
              $process = $null
              $processName = "Unknown"
              $executablePath = "Unknown"
              
              try {
                $process = Get-Process -Id $processId -ErrorAction Stop
                $processName = $process.Name
                $executablePath = $process.Path
              } catch {
                $processName = "Unknown"
                $executablePath = "Unknown"
              }
              
              $titleBuilder = New-Object System.Text.StringBuilder 256
              $win32::GetWindowText($hwnd, $titleBuilder, $titleBuilder.Capacity) | Out-Null
              
              $windowTitle = $titleBuilder.ToString().Trim()
              if (-not $windowTitle) {
                $windowTitle = "Untitled"
              }
              
              @{
                hwnd = $hwnd.ToString()
                title = $windowTitle
                processId = $processId
                processName = $processName
                executablePath = $executablePath
              } | ConvertTo-Json -Compress
            } else {
              @{ error = "No active window found" } | ConvertTo-Json -Compress
            }
          } catch {
            @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
          }
        `.trim()

        const proc = Bun.spawn({
          cmd: ['powershell.exe', '-Command', powershellScript],
          stdio: ['ignore', 'pipe', 'pipe']
        })

        const output = await new Response(proc.stdout).text()
        const error = await new Response(proc.stderr).text()

        await proc.exited

        if (proc.exitCode === 0 && output.trim()) {
          try {
            // Extract JSON from output (PowerShell might output extra lines)
            const lines = output.trim().split('\n').filter(line => line.trim())
            const jsonLine = lines.find(line => line.trim().startsWith('{') || line.trim().startsWith('@{'))

            if (jsonLine) {
              const windowInfo = JSON.parse(jsonLine.trim())
              return jsonResponse(windowInfo)
            } else {
              console.error('No JSON found in PowerShell output for active window')
              return jsonResponse({ error: 'No JSON found in PowerShell output' }, 500)
            }
          } catch (parseError) {
            console.error('Failed to parse window info JSON:', parseError)
            return jsonResponse({ error: 'Failed to parse window info' }, 500)
          }
        } else {
          console.error('PowerShell execution failed for active window')
          return jsonResponse({ error: 'Failed to get active window' }, 500)
        }
      }
    } if (path === '/api/v1/windows/list') {
      if (method === 'GET') {
        // Obtener lista de todas las ventanas visibles usando PowerShell
        const powershellScript = `
          try {
            Add-Type @"
              using System;
              using System.Runtime.InteropServices;
              using System.Collections.Generic;
              
              public class WindowInfo {
                  public IntPtr HWnd { get; set; }
                  public string Title { get; set; }
                  public uint ProcessId { get; set; }
                  public string ProcessName { get; set; }
                  public string ExecutablePath { get; set; }
              }
              
              public class Win32 {
                  [DllImport("user32.dll")]
                  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
                  
                  [DllImport("user32.dll")]
                  public static extern int GetWindowText(IntPtr hWnd, string lpString, int nMaxCount);
                  
                  [DllImport("user32.dll")]
                  public static extern bool IsWindowVisible(IntPtr hWnd);
                  
                  [DllImport("user32.dll")]
                  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
                  
                  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
              }
"@

            $windows = New-Object System.Collections.Generic.List[PSObject]
            
            $callback = {
              param($hwnd, $lParam)
              
              try {
                if ([Win32]::IsWindowVisible($hwnd)) {
                  $title = New-Object -TypeName "System.Text.StringBuilder" -ArgumentList 256
                  [Win32]::GetWindowText($hwnd, $title, $title.Capacity) | Out-Null
                  
                  if ($title.Length -gt 0) {
                    $processId = 0
                    [Win32]::GetWindowThreadProcessId($hwnd, [ref]$processId)
                    
                    $process = $null
                    try {
                      $process = Get-Process -Id $processId -ErrorAction Stop
                    } catch {
                      # Process might have ended, skip this window
                      return $true
                    }
                    
                    $windows.Add(@{
                      hwnd = $hwnd.ToString()
                      title = $title.ToString()
                      processId = $processId
                      processName = $process.Name
                      executablePath = $process.Path
                    })
                  }
                }
              } catch {
                # Skip problematic windows
              }
              
              return $true
            }
            
            [Win32]::EnumWindows($callback, 0) | Out-Null
            
            # Return JSON array
            $windows | ConvertTo-Json -Compress
          } catch {
            @{ error = $_.Exception.Message } | ConvertTo-Json
          }
        `.trim()

        const proc = Bun.spawn({
          cmd: ['powershell.exe', '-Command', powershellScript],
          stdio: ['ignore', 'pipe', 'pipe']
        })

        const output = await new Response(proc.stdout).text()
        const error = await new Response(proc.stderr).text()

        await proc.exited

        if (proc.exitCode === 0 && output.trim()) {
          try {
            const windows = JSON.parse(output.trim())
            return jsonResponse(windows)
          } catch (parseError) {
            return jsonResponse({ error: 'Failed to parse windows list' }, 500)
          }
        } else {
          // Return mock data as fallback
          const mockWindows = [
            {
              hwnd: "12345678",
              title: "Visual Studio Code",
              processId: 1234,
              processName: "Code",
              executablePath: "C:\\Users\\Mikel\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"
            },
            {
              hwnd: "87654321",
              title: "Google Chrome",
              processId: 5678,
              processName: "chrome",
              executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
            },
            {
              hwnd: "11223344",
              title: "Bloc de notas",
              processId: 9999,
              processName: "notepad",
              executablePath: "C:\\Windows\\System32\\notepad.exe"
            }
          ]

          return jsonResponse(mockWindows)
        }
      }
    }

    if (path === '/api/v1/windows/watcher') {
      if (method === 'POST') {
        const body = await req.json()
        const { action, rules, defaultProfileId } = body

        // El listener profile-switch debe registrarse una sola vez (antes se
        // duplicaba en cada 'start' y el perfil cambiaba N veces).
        const ensureSwitchListener = () => {
          const w: any = services.windowWatcher
          if (!w.__ldSwitchBound) {
            w.__ldSwitchBound = true
            services.windowWatcher.on('profile-switch', (profileId: string, window: any) => {
              // Update current profile in database and window watcher
              db.setCurrentProfile(profileId);
              services.windowWatcher.setCurrentProfile(profileId);
              services.wsManager?.broadcast('profile.navigate', { profileId }, 'profiles');
            });
          }
        }

        if (action === 'start' && rules) {
          services.windowWatcher.updateRules(rules)
          if (defaultProfileId !== undefined) services.windowWatcher.setDefaultProfile(defaultProfileId ?? null)

          // Connect window watcher events to WebSocket for profile switching
          ensureSwitchListener()

          services.windowWatcher.startWatching(rules)
          return jsonResponse({ status: 'started' })
        } else if (action === 'stop') {
          services.windowWatcher.stopWatching()
          return jsonResponse({ status: 'stopped' })
        } else if (action === 'update' && rules) {
          services.windowWatcher.updateRules(rules)
          if (defaultProfileId !== undefined) services.windowWatcher.setDefaultProfile(defaultProfileId ?? null)
          return jsonResponse({ status: 'updated' })
        }
      }

      if (method === 'GET') {
        return jsonResponse({
          isActive: services.windowWatcher.isActive()
        })
      }
    }

    if (path === '/api/v1/system/metrics') {
      if (method === 'GET') {
        try {
          const powershellScript = getSystemMetricsScript();

          const proc = Bun.spawn({
            cmd: ['powershell.exe', '-Command', powershellScript],
            stdio: ['ignore', 'pipe', 'pipe']
          })

          // Set a timeout for the PowerShell execution
          const timeout = setTimeout(() => {
            proc.kill()
          }, 10000) // 10 second timeout

          const output = await new Response(proc.stdout).text()
          const error = await new Response(proc.stderr).text()

          await proc.exited
          clearTimeout(timeout)

          if (proc.exitCode === 0 && output.trim()) {
            try {
              const metrics = JSON.parse(output.trim())

              // Check if we got an error response
              if (metrics.error) {
                // Return mock data as fallback
                const mockMetrics = {
                  cpu: {
                    usage: Math.random() * 100,
                    temperature: 45 + Math.random() * 30
                  },
                  ram: {
                    total: 16,
                    used: 8 + Math.random() * 8,
                    usage: Math.random() * 100
                  },
                  gpu: {
                    usage: Math.random() * 100,
                    temperature: 40 + Math.random() * 20
                  },
                  timestamp: new Date().toISOString()
                }

                return jsonResponse(mockMetrics)
              }

              return jsonResponse(metrics)
            } catch (parseError) {
              return jsonResponse({ error: 'Failed to parse system metrics' }, 500)
            }
          } else {
            // Return mock data as fallback
            const mockMetrics = {
              cpu: {
                usage: Math.random() * 100,
                temperature: 45 + Math.random() * 30
              },
              ram: {
                total: 16,
                used: 8 + Math.random() * 8,
                usage: Math.random() * 100
              },
              gpu: {
                usage: Math.random() * 100,
                temperature: 40 + Math.random() * 20
              },
              timestamp: new Date().toISOString()
            }

            return jsonResponse(mockMetrics)
          }
        } catch (error) {
          // Final fallback to mock data
          const mockMetrics = {
            cpu: {
              usage: Math.random() * 100,
              temperature: 45 + Math.random() * 30
            },
            ram: {
              total: 16,
              used: 8 + Math.random() * 8,
              usage: Math.random() * 100
            },
            gpu: {
              usage: Math.random() * 100,
              temperature: 40 + Math.random() * 20
            },
            timestamp: new Date().toISOString()
          }

          return jsonResponse(mockMetrics)
        }
      }
    }

    // Version endpoints
    if (path === '/api/v1/version') {
      if (method === 'GET') {
        try {
          // Read version from package.json - try multiple locations
          let packageJsonPath;
          const possiblePaths = [
            join(dirname(process.execPath), 'package.json'), // same dir as exe
            join(dirname(process.execPath), '..', 'package.json'), // parent dir
            join(process.cwd(), 'package.json'), // current working dir
            join(process.cwd(), '..', 'package.json') // parent of cwd
          ];

          for (const path of possiblePaths) {
            try {
              await Bun.file(path).stat();
              packageJsonPath = path;
              break;
            } catch { }
          }

          if (!packageJsonPath) {
            throw new Error(`package.json not found in any of: ${possiblePaths.join(', ')}`);
          }

          const packageJson = await Bun.file(packageJsonPath).json();
          const currentVersion = packageJson.version || '0.1.0';

          return jsonResponse({
            version: currentVersion,
            buildDate: new Date().toISOString()
          });
        } catch (error) {
          console.error('Failed to read version:', error);
          return errorResponse('Failed to read version', error);
        }
      }
    }

    // Deprecated: update flow moved to the Electrobun Updater (canonical).
    // Kept as 501 so old clients fail loudly instead of hanging.
    if (path === '/api/v1/version/check') {
      if (method === 'GET') {
        return jsonResponse(
          { error: 'Gone', message: 'Version check is managed by the Electrobun Updater, not the daemon API.' },
          501
        );
      }
    }

    // Admin endpoints
    if (path === '/api/v1/admin/shutdown') {
      if (method === 'POST') {
        console.log('Shutdown requested via API');

        // Graceful shutdown - wait longer to allow CLI to process response
        setTimeout(() => {
          process.exit(0);
        }, 2000); // Increased delay to 2 seconds

        return jsonResponse({ success: true, message: 'Shutting down...' });
      }
    }

    // Deprecated: update flow moved to the Electrobun Updater (canonical).
    // Kept as 501 so old clients fail loudly instead of hanging.
    if (path === '/api/v1/update') {
      if (method === 'POST') {
        return jsonResponse(
          { error: 'Gone', message: 'Updates are managed by the Electrobun Updater, not the daemon API.' },
          501
        );
      }
    }

    // StreamDeck devices endpoints
    if (path === '/api/v1/devices/streamdeck') {
      if (method === 'GET') {
        try {
          const devices = await streamDeckDriver.listDevices();
          return jsonResponse(devices);
        } catch (error) {
          console.error('Failed to list StreamDeck devices:', error);
          return jsonResponse({ error: 'Failed to list StreamDeck devices' }, 500);
        }
      }
    }

    // IPs LAN del host (el QR del panel necesita la IP LAN, no localhost,
    // y el WebRTC del navegador ya no la expone: Chrome devuelve .local por privacidad)
    if (path === '/api/v1/network/ips') {
      if (method === 'GET') {
        try {
          const { networkInterfaces } = await import('os');
          const nets = networkInterfaces();
          const ips: string[] = [];
          for (const addrs of Object.values(nets)) {
            for (const a of addrs || []) {
              if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
            }
          }
          return jsonResponse({ ips });
        } catch (error) {
          console.error('Failed to list network interfaces:', error);
          return jsonResponse({ error: 'Failed to list network interfaces' }, 500);
        }
      }
    }

    if (path === '/api/v1/devices/streamdeck/connect') {
      if (method === 'POST') {
        try {
          const body = await req.json();
          const { devicePath } = body;

          const success = await streamDeckDriver.connect(devicePath);
          
          if (success) {
            console.log('🎛️ StreamDeck connected successfully, checking for current page...');
            
            // Update with current page if available (initializeButtons is already called in connect())
            const currentProfile = db.getCurrentProfile();
            console.log('🎛️ Current profile:', currentProfile);
            
            if (currentProfile) {
              const currentPage = db.getCurrentPage(currentProfile.id);
              console.log('🎛️ Current page:', currentPage);
              
              if (currentPage) {
                console.log('🎛️ Updating StreamDeck with current page:', currentPage.id);
                await streamDeckDriver.updateFromPage(currentPage.id);
              } else {
                console.log('🎛️ No current page found');
              }
            } else {
              console.log('🎛️ No current profile found');
            }
          }
          
          return jsonResponse({ success, connectedDevice: streamDeckDriver.getConnectedDevice() });
        } catch (error) {
          console.error('Failed to connect to StreamDeck:', error);
          return jsonResponse({ error: 'Failed to connect to StreamDeck' }, 500);
        }
      }
    }

    if (path === '/api/v1/devices/streamdeck/disconnect') {
      if (method === 'POST') {
        try {
          await streamDeckDriver.disconnect();
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('Failed to disconnect StreamDeck:', error);
          return jsonResponse({ error: 'Failed to disconnect StreamDeck' }, 500);
        }
      }
    }

    if (path === '/api/v1/devices/streamdeck/status') {
      if (method === 'GET') {
        return jsonResponse({
          isConnected: streamDeckDriver.isConnected(),
          connectedDevice: streamDeckDriver.getConnectedDevice(),
          keyCount: streamDeckDriver.getKeyCount(),
          grid: streamDeckDriver.getGridGeometry()
        });
      }
    }

    if (path === '/api/v1/devices/streamdeck/test') {
      if (method === 'POST') {
        try {
          await streamDeckDriver.testStreamDeck();
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('Failed to test StreamDeck:', error);
          return jsonResponse({ error: 'Failed to test StreamDeck' }, 500);
        }
      }
    }

    if (path === '/api/v1/devices/streamdeck/update-buttons') {
      if (method === 'POST') {
        try {
          const { buttonStates, pageId } = ((await req.json()) as any) ?? {};

          console.log('🎛️ Received button states for update:', buttonStates);

          // No bloquear: el repintado completo va en segundo plano.
          // pageId manda; si no viene, el driver usa current.page_id.
          const { DatabaseService: DB } = await import('../db');
          const target = pageId ?? new DB().getSetting('current.page_id');
          if (streamDeckDriver.isConnected() && target && target !== 'null' && target !== '') {
            streamDeckDriver.scheduleUpdateFromPage(target);
          } else if (streamDeckDriver.isConnected()) {
            // Sin página conocida, delegar al path legacy en background.
            streamDeckDriver.updateButtons(buttonStates, pageId).catch((e) =>
              console.error('Failed to update StreamDeck buttons:', e)
            );
          }
          return jsonResponse({ success: true, scheduled: true });
        } catch (error) {
          console.error('Failed to update StreamDeck buttons:', error);
          return jsonResponse({ error: 'Failed to update StreamDeck buttons' }, 500);
        }
      }
    }

    // ---- Servidor MCP (el daemon ES el servidor) ----
    // Clientes (Claude Code, etc.): POST /api/v1/mcp con
    // Authorization: Bearer <token creado en Ajustes → MCP>.
    if (path === '/api/v1/mcp') {
      if (method === 'GET') {
        return jsonResponse({
          name: 'libredeck',
          protocol: 'mcp-streamable-http-json',
          endpoint: '/api/v1/mcp',
          auth: 'Bearer (token de Ajustes → MCP)',
          howto: 'Crea un token en Ajustes → MCP (marca sus permisos) y conéctalo desde tu cliente MCP. Control total: perfiles, páginas, botones, acciones, plugins, ajustes y logs.',
        });
      }
      if (method === 'POST') {
        const secret = bearerFromHeaders(req);
        const token = verifyMcpToken(db, secret);
        if (!token) {
          return jsonResponse({ error: 'No autorizado: usa Authorization: Bearer <token MCP>' }, 401);
        }
        try {
          const body = await req.json();
          const { status, payload } = await handleMcpBody(body, {
            pluginLoader: services.pluginLoader,
            actionRunner: services.actionRunner,
            db,
            auth: { tokenId: token.id, tokenName: token.name, scopes: token.scopes },
            ws: services.wsManager,
            repaint: (pageId: string) => {
              if (streamDeckDriver.isConnected()) {
                streamDeckDriver.scheduleUpdateFromPage(pageId);
              }
            },
          });
          if (status === 202) return new Response(null, { status: 202 });
          return jsonResponse(payload, status);
        } catch (e) {
          return jsonResponse(
            { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
            400
          );
        }
      }
    }

    // Catálogo de permisos marcables al crear/editar un token MCP (sin auth: metadatos públicos).
    if (path === '/api/v1/mcp/scopes') {
      if (method === 'GET') {
        return jsonResponse({ scopes: MCP_SCOPES });
      }
    }

    if (path === '/api/v1/mcp/tokens') {
      if (method === 'GET') {
        return jsonResponse({ tokens: listMcpTokens(db) });
      }
      if (method === 'POST') {
        const body = await req.json().catch(() => ({}));
        try {
          const { record, secret } = createMcpToken(db, body?.name ?? '', body?.scopes);
          return jsonResponse({ token: record, secret, warning: 'Guárdalo: el secreto no se vuelve a mostrar' }, 201);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
    }

    if (path.startsWith('/api/v1/mcp/tokens/')) {
      const tokenId = decodeURIComponent(path.split('/')[5] ?? '');
      if (method === 'PUT') {
        const body = await req.json().catch(() => ({}));
        try {
          const record = updateMcpToken(db, tokenId, { name: body?.name, scopes: body?.scopes });
          if (!record) return jsonResponse({ error: 'Token not found' }, 404);
          return jsonResponse({ success: true, token: record });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
      if (method === 'DELETE') {
        const ok = revokeMcpToken(db, tokenId);
        if (!ok) return jsonResponse({ error: 'Token not found' }, 404);
        return jsonResponse({ success: true });
      }
    }

    // ---- Jobs anti-cuelgue (operaciones largas: import/build/clone) ----
    if (path === '/api/v1/jobs') {
      if (method === 'GET') {
        const { getJobManager } = await import('../jobs/manager');
        return jsonResponse({ jobs: getJobManager().list() });
      }
    }
    if (path.startsWith('/api/v1/jobs/') && path.endsWith('/cancel')) {
      if (method === 'POST') {
        const id = decodeURIComponent(path.split('/')[4] ?? '');
        const { getJobManager } = await import('../jobs/manager');
        const ok = getJobManager().cancel(id);
        if (!ok) return jsonResponse({ error: 'Job not found o ya terminado' }, 404);
        return jsonResponse({ success: true, jobId: id });
      }
    }

    // 404 - Route not found
    return jsonResponse({ error: 'API endpoint not found' }, 404);

  } catch (error) {
    console.error('API Error:', error);
    return errorResponse('Internal server error', error);
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  const msg = error instanceof Error ? `${error.message} ${String((error as any)?.code ?? '')}` : String(error);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|SQLITE_CONSTRAINT/i.test(msg);
}

function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}

function errorResponse(message: string, error?: any, status: number = 500): Response {
  const details = error ? {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    type: error?.constructor?.name || 'Unknown'
  } : undefined;

  return jsonResponse({
    error: message,
    details
  }, status);
}