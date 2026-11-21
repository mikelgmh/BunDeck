/**
 * Ciclo de vida del daemon: parada ordenada de todos los servidores.
 *
 * Extraído de server.ts para que el apagado (señales SIGINT/SIGTERM y
 * `POST /api/v1/admin/shutdown`) comparta el mismo camino:
 * stop httpServer → stop frontendServer → close WS → (opcional) process.exit.
 *
 * La ruta admin/shutdown mantiene su contrato: responde `{success:true}`
 * INMEDIATAMENTE y cierra de forma diferida (2s) para que el CLI/web
 * procesen la respuesta antes de que el proceso muera.
 *
 * Nota: el daemon no tiene icono de bandeja propio. El dueño único del
 * tray es el launcher GPUI (launcher/src/tray.rs).
 */

export interface ManagedServers {
  httpServer?: { stop: (...args: any[]) => void } | null;
  frontendServer?: { stop: (...args: any[]) => void } | null;
  wsManager?: { close: () => void } | null;
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
