import { initDatabase } from './db';
import { WebSocketManager } from './ws';
import { PluginLoader } from './plugin-loader';
import { ActionRunner } from './action-runner';
import { windowWatcher } from './window-watcher';
import { DatabaseService } from './db';
import { setupAPIRoutes } from './api/routes';
import { streamDeckDriver } from './hw-driver/streamdeck-driver';
import { API_PORT as PORT, WS_PORT, FRONTEND_PORT, DEV_MODE, BIND_HOST } from './config';
import { buildCorsHeaders, isPreflight, preflightResponse, withCors } from './http/cors';
import {
  getContentType,
  serveDataAsset,
  findWebDistFile,
  findWebDistIndex,
  resolveWebDistIndexCandidates,
} from './http/static';
import { stopServers, requestShutdown, abortStartup, installSignalHandlers, isTrayDisabled } from './lifecycle';
import { getVersion } from './version';

// Import opcional del tray (solo funciona en Windows)
// systray v1 exporta una clase por defecto: `new SysTray({menu, ...})`
let SysTrayClass: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('systray');
  SysTrayClass = mod?.default ?? mod?.SysTray ?? mod;
} catch (error) {
  console.log('ℹ️ Tray module not available (this is normal on Linux/macOS)');
}

import fs from 'fs';

class LibreDeckDaemon {
  private httpServer?: any;
  private frontendServer?: any;
  private wsManager?: WebSocketManager;
  private pluginLoader?: PluginLoader;
  private actionRunner?: ActionRunner;
  private tray?: any;

  constructor() {}

  private serversSnapshot() {
    return {
      httpServer: this.httpServer,
      frontendServer: this.frontendServer,
      wsManager: this.wsManager,
      tray: this.tray,
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

      // Módulo remoto E2E (relay client + pairing + allowlist). Sin RELAY_URL
      // queda en 'disabled' pero el pairing local/QR y la policy siguen
      // disponibles por REST. Best-effort: nunca tumba el arranque.
      try {
        const { initRemote } = await import('./remote/index');
        const dbForRemote = new DatabaseService();
        (globalThis as any).__libredeckRemote = initRemote({
          db: dbForRemote,
          wsManager: this.wsManager,
          actionRunner: this.actionRunner,
        });
        console.log('✓ Remote E2E module initialized');
      } catch (e) {
        console.error('⚠️ Remote E2E module failed to init (sigue sin relay):', e);
      }

      // Inicializar auto-profile switching si hay configuración guardada
      await this.initializeAutoProfileSwitching();

      // Inicializar tray icon
      this.initializeTray();

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
      const db = new DatabaseService();
      const profiles = db.getProfiles();

      // Si no hay perfiles, crear uno por defecto
      if (profiles.length === 0) {
        console.log('📝 Creating default profile...');

        const { v4: uuidv4 } = await import('uuid');

        // Crear perfil por defecto
        const defaultProfile = {
          id: uuidv4(),
          name: 'Perfil Principal',
          data: {
            isDefault: true,
            gridCols: 5,
            gridRows: 3,
          },
        };

        db.createProfile(defaultProfile);
        console.log('✅ Default profile created:', defaultProfile.id);

        // Crear página por defecto
        const defaultPage = {
          id: uuidv4(),
          profile_id: defaultProfile.id,
          name: 'Página Principal',
          order_idx: 0,
          is_folder: 0,
          data: {
            gridCols: 5,
            gridRows: 3,
          },
        };

        db.createPage(defaultPage);
        console.log('✅ Default page created:', defaultPage.id);
      } else {
        console.log('ℹ️ Profiles already exist, skipping default profile creation');
      }
    } catch (error) {
      console.error('❌ Failed to initialize default profile:', error);
    }
  }

  private initializeTray() {
    try {
      // El launcher Rust es el dueño del tray en instalado/prod: al spawnear
      // pone LIBREDECK_NO_TRAY=1 (ver launcher/src/monitor.rs). El tray del
      // daemon queda como fallback solo-dev para no duplicar iconos.
      if (isTrayDisabled()) {
        console.log('ℹ️ Tray del daemon desactivado: corre bajo el launcher/host (dueño del icono)');
        return;
      }
      // Solo intentar inicializar tray en Windows y si el módulo está disponible
      if (process.platform !== 'win32' || !SysTrayClass) {
        console.log('ℹ️ Tray icon not supported on this platform or module not available');
        return;
      }

      const { exec } = require('child_process');
      const openDashboard = () => {
        try {
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
          // En dev el panel es Astro (4321); en prod es el frontend embebido
          const url = DEV_MODE
            ? `http://${localIP}:4321`
            : `http://${localIP}:${process.env.PORT_FRONTEND || FRONTEND_PORT}`;
          exec(`start "" "${url}"`);
        } catch (e) {
          console.error('Failed to open dashboard from tray:', e);
        }
      };

      // API systray v1: menú declarativo + onClick por índice.
      // icon es el .ico de BunDeck en base64 (daemon/src/tray-icon.ts,
      // generado desde assets/bundeck.svg): en Windows pide .ico.
      const { TRAY_ICON_BASE64 } = require('./tray-icon');
      const tray = new SysTrayClass({
        menu: {
          icon: TRAY_ICON_BASE64,
          title: 'LibreDeck',
          tooltip: 'LibreDeck Daemon',
          items: [
            { title: 'Abrir LibreDeck', tooltip: 'Abrir panel', checked: false, enabled: true },
            { title: 'Salir', tooltip: 'Detener daemon y salir', checked: false, enabled: true },
          ],
        },
        debug: false,
        copyDir: true,
      });

      tray.onClick((action: any) => {
        const idx = action?.seq_id;
        if (idx === 0) openDashboard();
        else if (idx === 1) {
          // Apagado ordenado vía lifecycle (cierra servidores antes de salir).
          this.requestShutdown(0);
        }
      });
      tray.onError?.((err: unknown) => {
        console.log('ℹ️ Tray error (daemon sigue corriendo):', err);
      });

      this.tray = tray;
      console.log('✓ Tray icon initialized (LibreDeck en bandeja del sistema)');
    } catch (error) {
      console.log('ℹ️ Tray icon not available on this system (daemon sigue corriendo). Reason:', error);
    }
  }

  /** Apagado diferido (el host/la ruta admin responden antes de morir). */
  public requestShutdown(delayMs: number = 2000) {
    // El tray ya se cierra dentro de stopServers; matar la copia local evita
    // que el icono quede colgado si el proceso tarda en salir.
    requestShutdown(() => this.serversSnapshot(), delayMs);
  }

  public async start() {
    await this.initializeServices();

    // Crear servidor API
    this.httpServer = Bun.serve({
      // Bind explícito (config.ts): 0.0.0.0 = compat LAN (dev.sh/QR),
      // LIBREDECK_BIND=127.0.0.1 para solo-loopback.
      hostname: BIND_HOST,
      port: PORT,
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        const origin = req.headers.get('origin');
        const corsHeaders = buildCorsHeaders(origin);

        // Manejar preflight OPTIONS
        if (isPreflight(req)) {
          return preflightResponse(req);
        }

        // Servir assets estáticos (subidos por el usuario en <data>/assets)
        if (url.pathname.startsWith('/assets/')) {
          const served = await serveDataAsset(url.pathname.replace('/assets/', ''), corsHeaders);
          if (served) return served;

          return new Response('Asset not found', {
            status: 404,
            headers: corsHeaders,
          });
        }

        // Manejar rutas API
        if (url.pathname.startsWith('/api/')) {
          const response = await setupAPIRoutes(req, {
            wsManager: this.wsManager!,
            pluginLoader: this.pluginLoader!,
            actionRunner: this.actionRunner!,
            windowWatcher: windowWatcher,
            onShutdown: () => this.requestShutdown(),
          });

          return withCors(response, origin);
        }

        // Config para el frontend (puertos centralizados).
        // También servido por el frontend embebido en prod; aquí para DEV_MODE.
        if (url.pathname === '/config') {
          return new Response(
            JSON.stringify({
              wsPort: WS_PORT,
              apiPort: PORT,
              frontendPort: FRONTEND_PORT,
            }),
            {
              headers: {
                ...corsHeaders,
                'Content-Type': 'application/json',
              },
            }
          );
        }

        // Health check
        if (url.pathname === '/health') {
          return new Response(
            JSON.stringify({
              status: 'ok',
              timestamp: Date.now(),
              version: getVersion(),
              websocket: WS_PORT,
            }),
            {
              headers: {
                ...corsHeaders,
                'Content-Type': 'application/json',
              },
            }
          );
        }

        return new Response('BunDeck API Server', {
          headers: corsHeaders,
        });
      },
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
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          const origin = req.headers.get('origin');
          const corsHeaders = buildCorsHeaders(origin);

          // Manejar preflight OPTIONS
          if (isPreflight(req)) {
            return preflightResponse(req);
          }

          // Servir config
          if (url.pathname === '/config') {
            const config: any = {
              wsPort: WS_PORT,
              apiPort: PORT,
            };

            return new Response(JSON.stringify(config), {
              headers: {
                ...corsHeaders,
                'Content-Type': 'application/json',
              },
            });
          }

          // Servir web-dist (UI embebida) — candidatos centralizados en http/static.
          try {
            const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
            const found = await findWebDistFile(filePath);
            if (found) {
              return new Response(Bun.file(found), {
                headers: {
                  ...corsHeaders,
                  'Content-Type': getContentType(filePath),
                },
              });
            }
          } catch (error) {
            console.error('Error serving web file:', error);
          }

          // Fallback a index.html para SPA
          const indexPath = await findWebDistIndex();
          if (indexPath) {
            return new Response(Bun.file(indexPath), {
              headers: {
                ...corsHeaders,
                'Content-Type': 'text/html',
              },
            });
          }

          // Debug info si no se encuentra nada
          const debugInfo = resolveWebDistIndexCandidates()
            .map((p) => `${p}: ${fs.existsSync(p)}`)
            .join('<br>');
          return new Response(
            `LibreDeck Frontend Server<br>CWD: ${process.cwd()}<br>execPath: ${process.execPath}<br>execDir: ${require('path').dirname(process.execPath)}<br><br>Checked paths:<br>${debugInfo}`,
            {
              headers: {
                ...corsHeaders,
                'Content-Type': 'text/html',
              },
            }
          );
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
        spawn('cmd', ['/c', 'start', '', `http://${localIP}:${frontendPort}`], { detached: true, stdio: 'ignore' });
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
  tray: (daemon as any).tray,
}));

// Iniciar daemon solo si este archivo es el entrypoint (Bun --watch / bun run)
if (import.meta.main) {
  daemon.start().catch(console.error);
}
