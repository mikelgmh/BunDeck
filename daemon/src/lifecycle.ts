/**
 * Ciclo de vida del daemon: parada ordenada de todos los servidores.
 *
 * Extraído de server.ts para que el apagado (señales SIGINT/SIGTERM,
 * botón "Salir" del tray y `POST /api/v1/admin/shutdown`) comparta
 * el mismo camino: stop httpServer → stop frontendServer → close WS →
 * kill tray → (opcional) process.exit.
 *
 * La ruta admin/shutdown mantiene su contrato: responde `{success:true}`
 * INMEDIATAMENTE y cierra de forma diferida (2s) para que el CLI/web
 * procesen la respuesta antes de que el proceso muera.
 */

export interface ManagedServers {
  httpServer?: { stop: (...args: any[]) => void } | null;
  frontendServer?: { stop: (...args: any[]) => void } | null;
  wsManager?: { close: () => void } | null;
  tray?: { kill: (force?: boolean) => void } | null;
}

/** Parada ordenada. Nunca lanza: cada paso está protegido. */
export async function stopServers(servers: ManagedServers): Promise<void> {
  if (servers.httpServer) {
    try {
      servers.httpServer.stop();
    } catch (error) {
      console.error('Error stopping API server:', error);
    }
  }
  if (servers.frontendServer) {
    try {
      servers.frontendServer.stop();
    } catch (error) {
      console.error('Error stopping frontend server:', error);
    }
  }
  if (servers.wsManager) {
    try {
      servers.wsManager.close();
    } catch (error) {
      console.error('Error closing WebSocket manager:', error);
    }
  }
  if (servers.tray) {
    try {
      servers.tray.kill(false);
    } catch {
      /* noop */
    }
  }
  console.log('🛑 LibreDeck daemon stopped');
}

/**
 * Apagado diferido: responde primero al llamador y detiene todo tras
 * `delayMs`, terminando el proceso con código 0.
 */
export function requestShutdown(
  getServers: () => ManagedServers,
  delayMs: number = 2000
): void {
  console.log('Shutdown requested, stopping gracefully...');
  setTimeout(() => {
    void stopServers(getServers()).finally(() => process.exit(0));
  }, delayMs);
}

/** Salida inmediata por fallo de inicialización (nada que detener). */
export function abortStartup(error: unknown): never {
  console.error('Failed to initialize services:', error);
  process.exit(1);
}

/**
 * true si el tray del daemon debe desactivarse (hay launcher/host dueño).
 * El launcher Rust marca al hijo con LIBREDECK_NO_TRAY=1 / LIBREDECK_MANAGED=1
 * al spawnearlo (launcher/src/monitor.rs); bajo el host Electrobun el icono,
 * si lo hay, lo pone el launcher. El tray del daemon queda como fallback
 * solo-dev para no duplicar iconos.
 */
export function isTrayDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.LIBREDECK_NO_TRAY === '1' ||
    env.LIBREDECK_MANAGED === '1' ||
    typeof env.ELECTROBUN_DATA_DIR === 'string'
  );
}

let signalsInstalled = false;

/** Registra SIGINT/SIGTERM una sola vez (idempotente ante re-imports). */
export function installSignalHandlers(getServers: () => ManagedServers): void {
  if (signalsInstalled) return;
  signalsInstalled = true;

  process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    await stopServers(getServers());
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    await stopServers(getServers());
    process.exit(0);
  });
}
