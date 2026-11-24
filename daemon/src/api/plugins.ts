/**
 * Rutas `/api/v1/plugins*` y `/api/v1/marketplace` — gestión del ciclo de vida
 * de plugins (instalar/habilitar/ajustes/key Elgato/import Elgato/upload).
 *
 * OJO: `/api/v1/plugins/actions` se excluye del prefijo `/api/v1/plugins/`
 * (mismo guard que el routes.ts original).
 */
import { importElgatoPlugin } from '../elgato/import';
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';

export const handlePlugins: ApiHandler = async (_req, { url, method, path, db, services }) => {
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
          enabled: plugin.enabled,
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
        const registryUrl =
          db.getSetting('marketplace.registry_url') || process.env.LIBREDECK_MARKETPLACE_URL || '';
        if (!registryUrl) {
          return jsonResponse({
            plugins: [],
            registryUrl: null,
            hint: 'Configura marketplace.registry_url (settings) con la URL del registry JSON',
          });
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
        const body = await _req.json();
        const { sourceType, url: pluginUrl, path: dirPath, dir, ref, version, checksum, force, origin } = body ?? {};
        void version;
        const localDir = dirPath ?? dir;
        const prog = (stage: string, message: string) =>
          services.wsManager.broadcast(
            'plugin.install-progress',
            { key: pluginUrl ?? localDir ?? '', stage, message, ts: Date.now() },
            'plugins'
          );
        let id: string;
        const looksZip = typeof pluginUrl === 'string' && /\.zip(\?|#|$)/i.test(pluginUrl);
        if (sourceType === 'directory' || (!sourceType && localDir && !pluginUrl)) {
          if (!localDir || typeof localDir !== 'string') return jsonResponse({ error: 'path requerido (carpeta local del plugin)' }, 400);
          id = await services.pluginLoader.installPluginFromDirectory(localDir, {
            force: !!force,
            origin: origin ?? localDir,
            onProgress: prog,
          });
        } else if (sourceType === 'git' || (!sourceType && pluginUrl && !looksZip)) {
          if (!pluginUrl) return jsonResponse({ error: 'url requerida para git' }, 400);
          id = await services.pluginLoader.installPluginFromGit(pluginUrl, {
            ref,
            force: !!force,
            onProgress: prog,
          });
        } else if (sourceType === 'marketplace' || sourceType === 'url' || (pluginUrl && looksZip)) {
          if (!pluginUrl) return jsonResponse({ error: 'url requerida' }, 400);
          if (!looksZip) {
            // Marketplace apuntando a repo git: clonar, no descargar zip
            id = await services.pluginLoader.installPluginFromGit(pluginUrl, {
              ref,
              force: !!force,
              onProgress: prog,
            });
            // Marcar origen marketplace aunque venga de git
            try {
              db.upsertPluginRecord({ id, source_type: 'marketplace', origin: origin ?? pluginUrl } as any);
            } catch {}
          } else {
            id = await services.pluginLoader.installPluginFromUrl(pluginUrl, {
              force: !!force,
              checksum,
              origin: origin ?? pluginUrl,
              sourceType: 'marketplace',
              onProgress: prog,
            });
          }
        } else {
          return jsonResponse({ error: 'sourceType inválido (git | marketplace | url | directory)' }, 400);
        }
        const plugin = db.getPlugin(id);
        services.wsManager.broadcastPluginInstalled(id, plugin);
        const status = services.pluginLoader.getStatus(id) as any;
        const extra =
          status?.sourceType === 'elgato'
            ? {
                elgato: true,
                note:
                  status?.status === 'active'
                    ? 'Plugin Elgato habilitado por defecto (shim en-Worker, arranque perezoso).'
                    : `Plugin Elgato: ${status?.status ?? 'instalado'}`,
              }
            : {};
        return jsonResponse({ success: true, pluginId: id, plugin, ...extra }, 201);
      } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }
  }

  // ---- Importación Elgato (.sdPlugin / repo git). Modo shim: convierte,
  // compila desde fuentes si hace falta (DeckCal trae src/, no bin/),
  // instala dependencias JS puras con bun (fallback npm, no bloqueante) y
  // genera el bridge en-Worker (shim-bridge.js). Habilitado por defecto con
  // arranque perezoso (sin procesos node). needs-manual si es nativo,
  // dial-only o falta CodePath. Con dryRun solo informe.
  if (path === '/api/v1/plugins/import-elgato') {
    if (method === 'POST') {
      try {
        const body = await _req.json().catch(() => ({}));
        const { url: elgatoUrl, dir, zipPath, dryRun } = body ?? {};
        if (!elgatoUrl && !dir && !zipPath) {
          return jsonResponse({ error: 'url (repo git o .streamDeckPlugin), dir o zipPath requerido' }, 400);
        }
        const key = elgatoUrl ?? dir ?? zipPath ?? '';
        const prog = (stage: string, message: string) =>
          services.wsManager.broadcast('plugin.install-progress', { key, stage, message, ts: Date.now() }, 'plugins');
        const result = await importElgatoPlugin(db, { url: elgatoUrl, dir, zipPath }, { dryRun: !!dryRun, onProgress: prog });
        if (!result.installed) {
          services.wsManager.broadcast(
            'plugin.install-progress',
            { key, stage: 'done', message: 'Diagnóstico completado (no instalado)', ts: Date.now() },
            'plugins'
          );
        } else {
          // Habilitado por defecto: registro perezoso del shim en segundo
          // plano (sin bloquear la respuesta; el progreso va por WS).
          try {
            const rec = db.getPlugin(result.pluginId) as any;
            if (rec && Number(rec.enabled) === 1 && (rec.status === 'active' || rec.status === 'elgato-stopped')) {
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
        const form = await _req.formData();
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
          try {
            (await import('fs')).rmSync(tmp, { force: true });
          } catch {}
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
          const body = await _req.json();
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
          const body = await _req.json().catch(() => ({}));
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
        const body = await _req.json().catch(() => ({}));
        if (pluginId !== 'spotify') {
          return jsonResponse({ error: `token-capture no soportado para ${pluginId}` }, 400);
        }
        const { normalizeSpotifyTokenCapture } = await import('../plugins/spotify.plugin');
        const stored = normalizeSpotifyTokenCapture(body ?? {}, Date.now());
        const values = services.pluginLoader.savePluginSettings(pluginId, stored);
        // Limpiar las peticiones de login pendientes (explícita y de fondo).
        try {
          db.deleteSetting('plugin.spotify.loginRequestedAt');
        } catch {}
        try {
          db.deleteSetting('plugin.spotify.autoRefreshRequestedAt');
        } catch {}
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
        try {
          bundle = services.pluginLoader.getPluginSettingsBundle(pluginId);
        } catch {}
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
        const body = await _req.json().catch(() => ({}));
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
    // `pressType: 'long'` (o `holdMs`) produce hold real (delay keyDown→keyUp).
    if (sub === 'key' && method === 'POST') {
      try {
        const body = await _req.json().catch(() => ({}));
        const { action, context, pressType, holdMs } = body ?? {};
        if (!action) return jsonResponse({ error: 'action (id corto o UUID Elgato) requerido' }, 400);
        const fullId = action.includes('.') ? action : `${pluginId}.${action}`;
        const pt = pressType === 'long' ? 'long' : 'short';
        const hold = Number(holdMs) > 0 ? Math.min(Number(holdMs), 10_000) : undefined;
        const res = await services.actionRunner.executeAction(
          { type: fullId, parameters: {} },
          { buttonId: typeof context === 'string' ? context : undefined, timestamp: Date.now(), pressType: pt, ...(hold !== undefined ? { holdMs: hold } : {}) } as any
        );
        return jsonResponse({ success: res.success, result: res.result, error: res.error });
      } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }
  }

  if (path === '/api/v1/plugins/action-options') {
    if (method === 'POST') {
      // Resuelve el `optionsFrom` de una acción: ejecuta la sourceAction del
      // MISMO plugin y devuelve `{ options: [{value,label,...}] }`.
      // Solo lectura pensada para rellenar selects (ej. entidades de HA).
      try {
        const body = await _req.json().catch(() => ({}));
        const { pluginId, actionId, field, params } = body ?? {};
        if (!pluginId || !actionId) {
          return jsonResponse({ error: 'pluginId y actionId son obligatorios' }, 400);
        }
        const plugin = services.pluginLoader.getPlugin(pluginId);
        if (!plugin || !plugin.enabled) {
          return jsonResponse({ error: `Plugin no disponible: ${pluginId}` }, 404);
        }
        const action = (plugin.manifest.actions ?? []).find((a: any) => a.id === actionId);
        const optionsFrom = (action as any)?.optionsFrom;
        if (!optionsFrom?.sourceAction || !optionsFrom?.field) {
          return jsonResponse({ error: `La acción ${pluginId}.${actionId} no declara opciones dinámicas` }, 400);
        }
        if (field && field !== optionsFrom.field) {
          return jsonResponse({ error: `Campo no válido: ${field} (se esperaba ${optionsFrom.field})` }, 400);
        }
        // Solo se ejecuta la sourceAction declarada, nunca una arbitraria.
        const forward: Record<string, any> = {};
        const src = String(optionsFrom.sourceAction);
        if (Array.isArray(optionsFrom.forwardParams)) {
          for (const k of optionsFrom.forwardParams) {
            const v = (params ?? {})[k];
            if (v !== undefined && v !== null && v !== '') forward[k] = v;
          }
        } else {
          Object.assign(forward, params ?? {});
        }
        const res = await services.actionRunner.executeAction(
          { type: `${plugin.manifest.id}.${src}`, parameters: forward, timeout: 20000 },
          { timestamp: Date.now(), pressType: 'short', quiet: true } as any
        );
        if (!res.success) {
          // 200 con success:false: la UI muestra el mensaje y deja escribir a mano.
          return jsonResponse({ success: false, pluginId, actionId, field: optionsFrom.field, error: res.error ?? 'No se pudieron obtener las opciones' });
        }
        const raw = (res.result as any)?.options;
        const options = (Array.isArray(raw) ? raw : [])
          .filter((o: any) => o && o.value !== undefined)
          .map((o: any) => ({ ...o, value: String(o.value), label: String(o.label ?? o.value) }));
        return jsonResponse({ success: true, pluginId, actionId, field: optionsFrom.field, options, count: options.length });
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
            .map(([actionId, action]) => [actionId.split('.')[1], action]),
        },
      ]);

      return jsonResponse(pluginsWithActions);
    }
  }

  return null;
};
