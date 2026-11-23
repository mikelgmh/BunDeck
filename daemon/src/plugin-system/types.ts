/**
 * Plugin System v2 — tipos centralizados
 * Usa bun:sqlite nativo para persistencia, sin libs externas
 */

/** Versión del API que el daemon ofrece a los plugins externos. */
export const PLUGIN_API_VERSION = '2.2';
/** Versión mínima de LibreDeck que este daemon declara (para `engine`). */
export const LIBREDECK_ENGINE_VERSION = '1.5.0';
/** Rango engine recomendado para manifests nativos/externos actuales. */
export const RECOMMENDED_ENGINE_RANGE = '^1.5.0';

export type PluginPermission =
  | 'shell'
  | 'filesystem'
  | 'http'
  | 'network'
  | 'system'
  | 'monitoring'
  | 'clipboard'
  | 'notifications';

export interface PluginActionSchema {
  type: 'object';
  properties: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface PluginSettingsSchema {
  type: 'object';
  properties: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface PluginActionV2 {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  schema?: PluginActionSchema;
  // Para acciones dinámicas (pc-vitals) que hacen polling
  dynamic?: boolean;
  /** Intervalo de polling sugerido para botones dinámicos (ms). */
  pollMs?: number;
  // Timeout y cooldown opcionales
  timeoutMs?: number;
  cooldownMs?: number;
  /**
   * Estados discretos del botón para iconos dinámicos desde integraciones
   * (ej. spotify: playing/paused; obs: streaming on/off). La UI mapea
   * `result.state` (string) a label/icono sin lógica custom por plugin.
   */
  states?: PluginButtonStateDef[];
  /**
   * Opciones dinámicas de un campo del schema: se resuelven ejecutando
   * otra acción del MISMO plugin (sin red directa desde la UI).
   * Ej. obs.scene.scene <- obs.scene-list.
   */
  optionsFrom?: PluginDynamicOptions;
}

/** Estado discreto de botón/icono declarado por una acción. */
export interface PluginButtonStateDef {
  /** Valor que devuelve la acción en `result.state`. */
  value: string;
  /** Etiqueta legible para la UI. */
  label: string;
  /** Icono (nombre Lucide) cuando el botón está en este estado. */
  icon?: string;
}

/** Origen de opciones dinámicas para un campo select. */
export interface PluginDynamicOptions {
  /** Campo del schema (properties) cuyas options se rellenan. */
  field: string;
  /** Acción del mismo plugin que devuelve `{ options: [{value,label}] }`. */
  sourceAction: string;
  /** Caché sugerida en la UI (ms). Por defecto 30000. */
  cacheMs?: number;
  /** Campos de `params` que se reenvían a sourceAction (whitelist). */
  forwardParams?: string[];
}

/** Widget básico personalizado (texto/progreso/lista). Renderea `result.widget`. */
export interface PluginWidgetDefinition {
  id: string;
  kind: 'text' | 'progress' | 'list' | 'gauge' | 'toggle';
  title?: string;
  description?: string;
  /** Acción del plugin que devuelve los datos del widget. */
  sourceAction?: string;
  /** Refresco sugerido (ms). Por defecto 5000. */
  refreshMs?: number;
}

export interface PluginManifestV2 {
  id: string; // ej: 'shell' o '@scope/my-plugin'
  name: string;
  version: string; // semver
  description?: string;
  author?: string;
  license?: string;
  engine?: string; // ej: '^1.0.0' versión LibreDeck requerida
  apiVersion?: string; // versión del Plugin API usada (ej: '2.2')
  main?: string; // punto de entrada (por defecto main.js)
  permissions: PluginPermission[];
  actions: PluginActionV2[];
  /** Categoría funcional (system | integrations | media | input | utility). */
  category?: string;
  /** SO soportados estilo process.platform. Por defecto todos. */
  os?: string[];
  /**
   * Widgets básicos personalizados del plugin (contrato público v2.2).
   * Cada widget declara kind + sourceAction; el daemon no ejecuta JS
   * de terceros para renderizar: solo transporta `result.widget`.
   */
  widgets?: PluginWidgetDefinition[];
  ui?: {
    components?: string[];
    routes?: string[];
    settingsSchema?: any;
  };
  // Ajustes generales del plugin (token, URL...). Se editan desde la UI
  // (menú ⋯ del plugin) y los handlers los leen como valores por defecto.
  settingsSchema?: PluginSettingsSchema;
  // Instrucciones de configuración/uso en texto plano (se muestran en la UI).
  instructions?: string;
  // Metadatos instalables
  homepage?: string;
  repository?: string | { url?: string; type?: string };
}

export interface LoadedPluginV2 {
  manifest: PluginManifestV2;
  path: string; // built-in:// o data/plugins/<id>
  enabled: boolean;
  // Para externos: worker o módulo
  worker?: Worker;
  module?: any;
  // Estado
  installedAt: number;
  updatedAt: number;
}

export type PluginSourceType = 'builtin' | 'zip' | 'git' | 'marketplace' | 'directory';

export interface PluginInstallSource {
  kind: PluginSourceType | 'url';
  /** URL git, URL zip, o ruta local (según kind). */
  url?: string;
  /** rama/tag/commit para git. */
  ref?: string;
  /** Versión esperada (marketplace). */
  version?: string;
  /** checksum sha256 esperado (zip/marketplace). */
  checksum?: string;
}

export interface PluginAPI {
  // Eventos → WS broadcast
  emitEvent(eventName: string, payload: any): void;
  /**
   * Estado del botón (contrato v2.2): la UI lo mapea a label/icono
   * según `states` de la acción. Transporte sobre `button.state`.
   */
  setButtonState?(buttonId: string, state: PluginButtonStateUpdate): void;
  /** Actualización de widget personalizado (transporte sobre `widget.update`). */
  setWidget?(widgetId: string, data: unknown): void;
  /** Todos los ajustes del plugin de una vez (evita N llamadas). */
  getSettings?(): Promise<Record<string, string>>;
  // Storage namespaced (bun:sqlite)
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  deleteSetting(key: string): void;
  // Logging → db.addLog
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string, meta?: any): void;
  // HTTP con whitelist por permisos
  http: {
    fetch(url: string, init?: RequestInit): Promise<Response>;
  };
  // FS restringido a data/plugins/<id>/
  fs: {
    readFile(relativePath: string): Promise<string>;
    writeFile(relativePath: string, content: string): Promise<void>;
    exists(relativePath: string): Promise<boolean>;
  };
  // Registrar handler (solo dentro de register)
  onAction(actionId: string, handler: (params: any, context: any) => Promise<any>): void;
}

export interface PluginModule {
  register(api: PluginAPI): void | Promise<void>;
  unload?(): void | Promise<void>;
  // Opcional: activate/deactivate
  activate?(): void;
  deactivate?(): void;
}

/** Actualización de estado de botón emitida por un plugin (v2.2). */
export interface PluginButtonStateUpdate {
  /** Debe coincidir con un `states[].value` de la acción si existe. */
  state: string;
  /** Etiqueta opcional (override puntual). */
  label?: string;
  /** Icono opcional (nombre Lucide). */
  icon?: string;
  /** Valor principal para botones dinámicos (ej. "23°C", "3 en vivo"). */
  value?: string | number;
}

const SECRET_HINTS = ['token', 'secret', 'password', 'passwd', 'api_key', 'apikey', 'private', 'bearer', 'oauth'];

/** ¿Un campo del settingsSchema/actionSchema guarda un secreto? */
export function isSecretField(fieldName: string, prop: any): boolean {
  if (prop?.secret === true) return true;
  const ui = prop?.ui ?? {};
  if (ui.type === 'password' || prop?.format === 'password') return true;
  const lower = String(fieldName).toLowerCase();
  return SECRET_HINTS.some((h) => lower.includes(h));
}

/** Nombres de campos secretos de un schema (settingsSchema). */
export function secretFieldsOf(schema: any): string[] {
  const props = schema?.properties ?? {};
  return Object.keys(props).filter((k) => isSecretField(k, props[k]));
}

/**
 * Copia de valores con secretos enmascarados (para logs/diagnóstico).
 * Nunca se persiste: solo para no filtrar tokens en respuestas de debug.
 */
export function redactSettings(schema: any, values: Record<string, any>): Record<string, any> {
  const secrets = new Set(secretFieldsOf(schema));
  const out: Record<string, any> = { ...(values ?? {}) };
  for (const k of secrets) {
    if (out[k] !== undefined && out[k] !== null && String(out[k]).length > 0) out[k] = '****';
  }
  return out;
}

/** Normaliza el `state` devuelto por una acción al catálogo `states`. */
export function normalizeButtonState(states: PluginButtonStateDef[] | undefined, raw: unknown): string | null {
  if (!Array.isArray(states) || states.length === 0) return null;
  const s = String(raw ?? '');
  return states.some((d) => d.value === s) ? s : null;
}
