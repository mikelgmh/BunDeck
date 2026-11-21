import { initDatabase } from './db';
import { WebSocketManager } from './ws';
import { PluginLoader } from './plugin-loader';
import { ActionRunner } from './action-runner';
import { windowWatcher } from './window-watcher';
import { DatabaseService } from './db';
import { setupAPIRoutes } from './api/routes';
import { streamDeckDriver } from './hw-driver/streamdeck-driver';
import { API_PORT as PORT, WS_PORT, FRONTEND_PORT, DEV_MODE } from './config';

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

import path from 'path';
import fs from 'fs';
import { TRAY_ICON_BASE64 } from './tray-icon';

class LibreDeckDaemon {
  private httpServer?: any;
  private frontendServer?: any;
  private wsManager?: WebSocketManager;
  private pluginLoader?: PluginLoader;
  private actionRunner?: ActionRunner;
  private tray?: any;

  constructor() { }

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
      // Propagar eventos de plugins externos (api.emitEvent) por WS
      this.pluginLoader.setWebSocketManager(this.wsManager);

      // Inicializar auto-profile switching si hay configuración guardada
      await this.initializeAutoProfileSwitching();

      // Inicializar tray icon
      this.initializeTray();

      console.log('✓ Services initialized');
    } catch (error) {
      console.error('Failed to initialize services:', error);
      process.exit(1);
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
            gridRows: 3
          }
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
            gridRows: 3
          }
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
          try { tray.kill(false); } catch { /* noop */ }
          process.exit(0);
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

  public async start() {
    await this.initializeServices();

    // Crear servidor API
    this.httpServer = Bun.serve({
      port: PORT,
      fetch: async (req: Request) => {
        const url = new URL(req.url);

        // Obtener origin del request
        const origin = req.headers.get('origin') || '*';

        // Configurar CORS - permitir localhost y cualquier IP local
        const isLocalOrigin = origin === 'null' ||
          origin.includes('localhost') ||
          origin.includes('127.0.0.1') ||
          origin.match(/https?:\/\/192\.168\.\d+\.\d+(:\d+)?/) ||
          origin.match(/https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?/) ||
          origin.match(/https?:\/\/172\.(1[6-9]|2[0-9]|3[0-1])\.\d+\.\d+(:\d+)?/);

        const corsHeaders = {
          'Access-Control-Allow-Origin': '*', // Allow all origins for development
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
          'Access-Control-Allow-Credentials': 'true'
        };

        // Manejar preflight OPTIONS
        if (req.method === 'OPTIONS') {
          return new Response(null, {
            status: 204,
            headers: corsHeaders
          });
        }

        // Servir assets estáticos
        if (url.pathname.startsWith('/assets/')) {
          try {
            const assetPath = url.pathname.replace('/assets/', '');
            const { getDataDir } = await import('./paths');
            const fullPath = path.join(getDataDir(), 'assets', assetPath);
            const file = Bun.file(fullPath);

            if (await file.exists()) {
              return new Response(file, {
                headers: {
                  ...corsHeaders,
                  'Cache-Control': 'public, max-age=3600'
                }
              });
            }
          } catch (error) {
            console.error('Error serving asset:', error);
          }

          return new Response('Asset not found', {
            status: 404,
            headers: corsHeaders
          });
        }

        // Manejar rutas API
        if (url.pathname.startsWith('/api/')) {
          const response = await setupAPIRoutes(req, {
            wsManager: this.wsManager!,
            pluginLoader: this.pluginLoader!,
            actionRunner: this.actionRunner!,
            windowWatcher: windowWatcher
          });

          // Agregar headers CORS a las respuestas API
          const headers = new Headers(response.headers);
          Object.entries(corsHeaders).forEach(([key, value]) => {
            headers.set(key, value);
          });

          return new Response(response.body, {
            status: response.status,
            headers
          });
        }

        // Config para el frontend (puertos centralizados).
        // También servido por el frontend embebido en prod; aquí para DEV_MODE.
        if (url.pathname === '/config') {
          return new Response(JSON.stringify({
            wsPort: WS_PORT,
            apiPort: PORT,
            frontendPort: FRONTEND_PORT
          }), {
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }

        // Health check
        if (url.pathname === '/health') {
          return new Response(JSON.stringify({
            status: 'ok',
            timestamp: Date.now(),
            version: '0.1.0',
            websocket: WS_PORT
          }), {
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }

        return new Response('LibreDeck API Server', {
          headers: corsHeaders
        });
      },
      error: (error) => {
        console.error('API Server error:', error);
        return new Response('Internal Server Error', { status: 500 });
      }
    });

    // Crear servidor frontend (solo en producción)
    if (!DEV_MODE) {
      this.frontendServer = Bun.serve({
        port: FRONTEND_PORT,
        fetch: async (req: Request) => {
          const url = new URL(req.url);

          // Obtener origin del request
          const origin = req.headers.get('origin') || '*';

          // Configurar CORS - permitir localhost y cualquier IP local
          const corsHeaders = {
            'Access-Control-Allow-Origin': '*', // Allow all origins for development
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
            'Access-Control-Allow-Credentials': 'true'
          };

          // Manejar preflight OPTIONS
          if (req.method === 'OPTIONS') {
            return new Response(null, {
              status: 204,
              headers: corsHeaders
            });
          }

          // Servir config
          if (url.pathname === '/config') {
            const config: any = {
              wsPort: WS_PORT,
              apiPort: PORT
            };

            return new Response(JSON.stringify(config), {
              headers: {
                ...corsHeaders,
                'Content-Type': 'application/json'
              }
            });
          }

          // Servir web-dist (UI embebida) — híbrido: soporta web/dist (dev) y web-dist (prod) y electrobun
          try {
            let filePath = url.pathname === '/' ? '/index.html' : url.pathname;

            // Buscar archivos web-dist en múltiples ubicaciones posibles
            const possiblePaths = [
              path.join(process.cwd(), 'web-dist'),           // Desde CWD (prod)
              path.join(path.dirname(process.execPath), 'web-dist'), // Desde el directorio del ejecutable
              path.join(process.cwd(), 'web', 'dist'),        // Astro dev/prod (web/dist)
              path.join(import.meta.dir, '..', '..', 'web', 'dist'), // Relativo a daemon/src
              path.join(import.meta.dir, '..', 'web-dist'),   // daemon/web-dist (build.sh)
            ];

            for (const basePath of possiblePaths) {
              const fullPath = path.join(basePath, filePath.slice(1));
              try {
                const file = Bun.file(fullPath);
                if (await file.exists()) {
                  return new Response(file, {
                    headers: {
                      ...corsHeaders,
                      'Content-Type': this.getContentType(filePath)
                    }
                  });
                }
              } catch (error) {
                // Continuar buscando en la siguiente ubicación
              }
            }
          } catch (error) {
            console.error('Error serving web file:', error);
          }

          // Fallback a index.html para SPA - buscar en las mismas ubicaciones
          const possibleIndexPaths = [
            path.join(process.cwd(), 'web-dist', 'index.html'),
            path.join(path.dirname(process.execPath), 'web-dist', 'index.html'),
            path.join(process.cwd(), 'web', 'dist', 'index.html'),
            path.join(import.meta.dir, '..', '..', 'web', 'dist', 'index.html'),
            path.join(import.meta.dir, '..', 'web-dist', 'index.html'),
          ];

          for (const indexPath of possibleIndexPaths) {
            try {
              const indexFile = Bun.file(indexPath);
              if (await indexFile.exists()) {
                return new Response(indexFile, {
                  headers: {
                    ...corsHeaders,
                    'Content-Type': 'text/html'
                  }
                });
              }
            } catch (error) {
              // Continuar buscando
            }
          }

          // Debug info si no se encuentra nada
          const debugInfo = possibleIndexPaths.map(p => `${p}: ${fs.existsSync(p)}`).join('<br>');
          return new Response(`LibreDeck Frontend Server<br>CWD: ${process.cwd()}<br>execPath: ${process.execPath}<br>execDir: ${path.dirname(process.execPath)}<br><br>Checked paths:<br>${debugInfo}`, {
            headers: {
              ...corsHeaders,
              'Content-Type': 'text/html'
            }
          });
        },
        error: (error) => {
          console.error('Frontend Server error:', error);
          return new Response('Internal Server Error', { status: 500 });
        }
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

  private getContentType(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const types: { [key: string]: string } = {
      'html': 'text/html',
      'css': 'text/css',
      'js': 'application/javascript',
      'json': 'application/json',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'svg': 'image/svg+xml',
      'ico': 'image/x-icon'
    };
    return types[ext || ''] || 'text/plain';
  }

  public async stop() {
    if (this.httpServer) {
      this.httpServer.stop();
    }
    if (this.frontendServer) {
      this.frontendServer.stop();
    }
    if (this.wsManager) {
      this.wsManager.close();
    }
    if (this.tray) {
      try { this.tray.kill(false); } catch { /* noop */ }
    }
    console.log('🛑 LibreDeck daemon stopped');
  }
}

// Manejo de señales del sistema — solo auto-arranca si es entrypoint directo (no cuando es importado por Electrobun)
export const daemon = new LibreDeckDaemon();

process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  await daemon.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  await daemon.stop();
  process.exit(0);
});

// Iniciar daemon solo si este archivo es el entrypoint (Bun --watch / bun run)
if (import.meta.main) {
  daemon.start().catch(console.error);
}