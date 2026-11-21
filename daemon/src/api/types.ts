/**
 * Tipos compartidos por el dispatcher (api/routes.ts) y los submódulos
 * (api/profiles.ts, pages.ts, buttons.ts, ...). Sin URLs ni lógica.
 */
import type { WebSocketManager } from '../ws';
import type { PluginLoader } from '../plugin-loader';
import type { ActionRunner } from '../action-runner';
import type { windowWatcher } from '../window-watcher';
import type { DatabaseService } from '../db';

export interface APIServices {
  wsManager: WebSocketManager;
  pluginLoader: PluginLoader;
  actionRunner: ActionRunner;
  windowWatcher: typeof windowWatcher;
  /**
   * Apagado ordenado diferido (lo inyecta server.ts desde lifecycle.ts).
   * La ruta admin/shutdown lo invoca DESPUÉS de construir su respuesta
   * `{success:true}`; si falta (tests), la ruta responde igual sin apagar.
   */
  onShutdown?: () => void;
}

export interface RouteContext {
  url: URL;
  method: string;
  path: string;
  db: DatabaseService;
  services: APIServices;
}

/**
 * Un submódulo devuelve `Response` si la ruta es suya, o `null` para
 * ceder al siguiente. El dispatcher (routes.ts) los encadena en el mismo
 * orden que el if-chain original, así que no cambian los contratos.
 */
export type ApiHandler = (req: Request, ctx: RouteContext) => Promise<Response | null>;
