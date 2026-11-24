import { initDatabase } from './db';
import { WebSocketManager } from './ws';
import { PluginLoader } from './plugin-loader';
import { ActionRunner } from './action-runner';
import { windowWatcher } from './window-watcher';
import { DatabaseService } from './db';
import { streamDeckDriver } from './hw-driver/streamdeck-driver';
import { API_PORT as PORT, WS_PORT, FRONTEND_PORT, DEV_MODE, BIND_HOST } from './config';
import { buildCorsHeaders, isPreflight, preflightResponse } from './http/cors';
import { evaluateLanAccess, lanDeniedResponse, withLanCookie, getPeerIp } from './http/lan-guard';
import { createDaemonFetch } from './http/handler';
import {
  getContentType,
  findWebDistFile,
  findWebDistIndex,
  resolveWebDistIndexCandidates,
  webDistCacheHeaders,
} from './http/static';
import { stopServers, requestShutdown, abortStartup, installSignalHandlers } from './lifecycle';

import fs from 'fs';

class LibreDeckDaemon {
  private httpServer?: any;
  private frontendServer?: any;
  private wsManager?: WebSocketManager;
  private pluginLoader?: PluginLoader;
  private actionRunner?: ActionRunner;

  constructor() {}

  private serversSnapshot() {
    return {
      httpServer: this.httpServer,
      frontendServer: this.frontendServer,
      wsManager: this.wsManager,
    };
  }

  private async initializeServices() {
    try {
      // Inicializar base de datos
      await initDatabase();
      console.log('✓ Database initialized');

      // Crear perfil inicial si no existe ninguno
      await this.initializeDefaultProfile();

      // Inicializar sistemas
      this.pluginLoader = new PluginLoader();
      this.actionRunner = new ActionRunner(this.pluginLoader);

      // Cargar plugins
      await this.pluginLoader.loadAllPlugins();

      // StreamDeck en background: conectar el HW (HID + repintado inicial)
      // puede tardar segundos y no debe retrasar que la API/WS escuchen.
      void this.initializeStreamDeck();

      // Configurar WebSocket
      this.wsManager = new WebSocketManager(WS_PORT);
      // Exponer el manager para broadcast best-effort (p.ej. db.addLog → 'log.created').
      (globalThis as any).__libredeckWs = this.wsManager;
      // Propagar eventos de plugins externos (api.emitEvent) por WS
      this.pluginLoader.setWebSocketManager(this.wsManager);

      // Módulo remoto E2E (relay client + pairing + allowlist). Por defecto
      // usa el relay público; setting `remote.relay.url` a '' lo deja en
      // 'disabled' (el pairing local/QR y la policy siguen por REST).
      try {
        const { initRemote } = await import('./remote/index');
        const dbForRemote = new DatabaseService();
        (globalThis as any).__libredeckRemote = initRemote({
          db: dbForRemote,
          wsManager: this.wsManager,
          actionRunner: this.actionRunner,
        });
        // El túnel sirve la MISMA respuesta que el Bun.serve local
        // (http/handler.ts): se inyecta aquí porque necesita los servicios
        // ya inicializados (ws/plugin/actionRunner/windowWatcher).
        try {
          (globalThis as any).__libredeckRemote?.tunnel?.setHttpHandler?.(
            createDaemonFetch({
              wsManager: this.wsManager!,
              pluginLoader: this.pluginLoader!,
              actionRunner: this.actionRunner!,
              windowWatcher: windowWatcher,
              onShutdown: () => this.requestShutdown(),
            }),
          );
        } catch { /* best-effort: el túnel responde 503 sin handler */ }
        console.log('✓ Remote E2E module initialized');
      } catch (e) {
        console.error('⚠️ Remote E2E module failed to init (sigue sin relay):', e);
      }

      // Inicializar auto-profile switching si hay configuración guardada
      await this.initializeAutoProfileSwitching();

      // Servicio daemon de variables + bus de eventos persistente:
      // el store usa la BD real, el FlowEngine ejecuta flujos del
      // ActionRunner ante eventos, y el WS puentea el bus a topics.
      try {
        const { VariableStore, setVariableStore } = await import('./variables/store');
        const { getFlowEngine } = await import('./automation/flows');
        const { getEventBus } = await import('./events/bus');
        const dbForVars = new DatabaseService();
        setVariableStore(new VariableStore(dbForVars));
        const bus = getEventBus();
        this.wsManager?.attachEventBus(bus);
        const flows = getFlowEngine().attach(dbForVars, this.actionRunner!);
        (globalThis as any).__libredeckFlows = getFlowEngine();
        console.log(`✓ Variables service initialized (${flows.length} flows)`);
      } catch (e) {
        console.error('⚠️ Variables service failed to init (sigue sin variables):', e);
      }

      // Motor de flujos persistente (nodos If/Else/Switch/Repeat, scripts
      // reutilizables, automatizaciones por evento/timer/variable y triggers
      // short/long/double/touch): arranca timers, marca runs interrumpidos
      // y sincroniza reglas load/timer/var de las teclas.
      (globalThis as any).__libredeckRunner = this.actionRunner;
      try {
        await this.actionRunner!.initFlows();
        console.log('✓ Flow engine initialized');
      } catch (e) {
        console.error('⚠️ Flow engine failed to init (sigue sin flujos):', e);
      }

      console.log('✓ Services initialized');
    } catch (error) {
      abortStartup(error);
    }
  }

  private async initializeAutoProfileSwitching() {
    try {
      const db = new DatabaseService();
      const autoProfileConfig = db.getSetting('autoProfileSwitch');

      if (autoProfileConfig) {
        const config = JSON.parse(autoProfileConfig);
        if (config.enabled && config.rules && config.rules.length > 0) {
          // Connect window watcher events to WebSocket for profile switching
          windowWatcher.on('profile-switch', (profileId: string, window: any) => {
            // Update current profile in database and window watcher
            const db = new DatabaseService();
            db.setCurrentProfile(profileId);
            windowWatcher.setCurrentProfile(profileId);
            this.wsManager?.broadcast('profile.navigate', { profileId }, 'profiles');
          });

          if (config.defaultProfileId !== undefined) windowWatcher.setDefaultProfile(config.defaultProfileId ?? null);
          windowWatcher.startWatching(config.rules);
        }
      }
    } catch (error) {
      console.error('❌ Failed to initialize auto-profile switching:', error);
    }
  }

  private async initializeStreamDeck() {
    try {
      // Intentar conectar automáticamente al primer StreamDeck disponible
      const connected = await streamDeckDriver.connect();
      if (connected) {
        console.log('✓ StreamDeck driver initialized');
      } else {
        console.log('ℹ️ No StreamDeck devices found');
      }
    } catch (error) {
      console.error('❌ Failed to initialize StreamDeck driver:', error);
    }
  }

  private async initializeDefaultProfile() {
    try {
      const { ensureDefaultProfile } = await import('./default-profile');
      const db = new DatabaseService();
      const r = ensureDefaultProfile(db);
      if (!r) {
        console.log('ℹ️ Default profile dismissed by user, skipping');
        return;
      }
      console.log(`✅ Default profile ready: ${r.profileId} (deck=${r.deckPageId}, mini=${r.miniPageId}, neo=${r.neoPageId}, xl=${r.xlPageId}, libre=${r.freePageId}${r.seeded ? ', seeded' : ''})`);
    } catch (error) {
      console.error('❌ Failed to initialize default profile:', error);
    }
  }

  /** Apagado diferido (el host/la ruta admin responden antes de morir). */
  public requestShutdown(delayMs: number = 2000) {
    requestShutdown(() => this.serversSnapshot(), delayMs);
  }

  public async start() {
    await this.initializeServices();

    // Crear servidor API (fetch compartido con el túnel: ver http/handler.ts)
    this.httpServer = Bun.serve({
      // Bind explícito (config.ts): 0.0.0.0 = compat LAN (dev.sh/QR),
      // LIBREDECK_BIND=127.0.0.1 para solo-loopback.
      hostname: BIND_HOST,
      port: PORT,
      fetch: createDaemonFetch({
        wsManager: this.wsManager!,
        pluginLoader: this.pluginLoader!,
        actionRunner: this.actionRunner!,
        windowWatcher: windowWatcher,
        onShutdown: () => this.requestShutdown(),
      }),

      error: (error) => {
        console.error('API Server error:', error);
        return new Response('Internal Server Error', { status: 500 });
      },
    });

    // Crear servidor frontend (solo en producción)
    if (!DEV_MODE) {
      this.frontendServer = Bun.serve({
        hostname: BIND_HOST,
        port: FRONTEND_PORT,
        fetch: async (req: Request, server?: any) => {
          const url = new URL(req.url);
          const origin = req.headers.get('origin');
          const corsHeaders = buildCorsHeaders(origin);

          // Manejar preflight OPTIONS
          if (isPreflight(req)) {
            return preflightResponse(req);
          }

          // Guardia LAN solo-por-invitación (misma que la API): sin
          // invitación la UI embebida responde "Sin permiso".
          const peerIp = getPeerIp(req, server);
          let verdict;
          try {
            verdict = evaluateLanAccess(new DatabaseService(), req, peerIp, { allowNullPeer: server == null });
          } catch {
            verdict = { ok: false as const, status: 401 as const, code: 'LAN_INVITE_REQUIRED', message: 'Sin permiso' };
            if (peerIp === null && server == null) verdict = { ok: true as const, via: 'tunnel' as const };
          }
          if (!verdict.ok) {
            const denied = lanDeniedResponse(req, verdict);
            return new Response(denied.body, { status: denied.status, headers: { ...corsHeaders, ...Object.fromEntries(denied.headers) } });
          }
          const finish = (res: Response): Response => {
            const withCookie = withLanCookie(res, verdict);
            const headers = new Headers(withCookie.headers);
            for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
            return new Response(withCookie.body, { status: withCookie.status, headers });
          };

          // Servir config
          if (url.pathname === '/config') {
            const config: any = {
              wsPort: WS_PORT,
              apiPort: PORT,
            };

            return finish(new Response(JSON.stringify(config), {
              headers: {
                ...corsHeaders,
                'Content-Type': 'application/json',
              },
            }));
          }

          // Servir web-dist (UI embebida) — candidatos centralizados en http/static.
          try {
            const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
            const found = await findWebDistFile(filePath);
            if (found) {
              return finish(new Response(Bun.file(found), {
                headers: {
                  ...corsHeaders,
                  'Content-Type': getContentType(filePath),
                  ...webDistCacheHeaders(filePath),
                },
              }));
            }
          } catch (error) {
            console.error('Error serving web file:', error);
          }

          // Fallback a index.html para SPA
          const indexPath = await findWebDistIndex();
          if (indexPath) {
            return finish(new Response(Bun.file(indexPath), {
              headers: {
                ...corsHeaders,
                'Content-Type': 'text/html',
                'Cache-Control': 'no-store',
              },
            }));
          }

          // Debug info si no se encuentra nada
          const debugInfo = resolveWebDistIndexCandidates()
            .map((p) => `${p}: ${fs.existsSync(p)}`)
            .join('<br>');
          return finish(new Response(
            `LibreDeck Frontend Server<br>CWD: ${process.cwd()}<br>execPath: ${process.execPath}<br>execDir: ${require('path').dirname(process.execPath)}<br><br>Checked paths:<br>${debugInfo}`,
            {
              headers: {
                ...corsHeaders,
                'Content-Type': 'text/html',
              },
            }
          ));
        },
        error: (error) => {
          console.error('Frontend Server error:', error);
          return new Response('Internal Server Error', { status: 500 });
        },
      });
    }

    console.log(`🚀 LibreDeck daemon started${DEV_MODE ? ' (DEV MODE)' : ''}`);
    console.log(`📡 API Server: http://localhost:${PORT}`);
    if (!DEV_MODE) {
      console.log(`🌐 Frontend Server: http://localhost:${FRONTEND_PORT}`);
    } else {
      console.log(`🌐 Frontend Server: Disabled in DEV MODE (use npm run dev in web/)`);
    }
    console.log(`🔌 WebSocket: ws://localhost:${WS_PORT}`);
    console.log(`🩺 Health: http://localhost:${PORT}/health`);

    // Abrir navegador automáticamente solo en producción
    if (!DEV_MODE) {
      const { spawn } = require('child_process');
      const os = require('os');
      const interfaces = os.networkInterfaces() as any;
      let localIP = 'localhost';
      for (const iface of Object.values(interfaces)) {
        for (const addr of iface as any[]) {
          if (addr.family === 'IPv4' && !addr.internal) {
            localIP = addr.address;
            break;
          }
          if (localIP !== 'localhost') break;
        }
      }
      const frontendPort = process.env.PORT_FRONTEND || FRONTEND_PORT;
      try {
        spawn('cmd', ['/c', 'start', '', `http://${localIP}:${frontendPort}`], { detached: true, stdio: 'ignore', windowsHide: true } as any).unref?.();
      } catch (error) {
        console.error('Failed to open browser:', error);
      }
    }
  }

  public async stop() {
    await stopServers(this.serversSnapshot());
  }
}

// Manejo de señales del sistema — solo auto-arranca si es entrypoint directo (no cuando es importado por Electrobun)
export const daemon = new LibreDeckDaemon();

installSignalHandlers(() => ({
  httpServer: (daemon as any).httpServer,
  frontendServer: (daemon as any).frontendServer,
  wsManager: (daemon as any).wsManager,
}));

// Iniciar daemon solo si este archivo es el entrypoint (Bun --watch / bun run)
if (import.meta.main) {
  daemon.start().catch(console.error);
}
