/**
 * Plugin System v2 — tipos centralizados
 * Usa bun:sqlite nativo para persistencia, sin libs externas
 */

/** Versión del API que el daemon ofrece a los plugins externos. */
export const PLUGIN_API_VERSION = '2.1';
/** Versión mínima de LibreDeck que este daemon declara (para `engine`). */
export const LIBREDECK_ENGINE_VERSION = '1.5.0';

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
  // Timeout y cooldown opcionales
  timeoutMs?: number;
  cooldownMs?: number;
}

export interface PluginManifestV2 {
  id: string; // ej: 'shell' o '@scope/my-plugin'
  name: string;
  version: string; // semver
  description?: string;
  author?: string;
  license?: string;
  engine?: string; // ej: '^1.0.0' versión LibreDeck requerida
  apiVersion?: string; // versión del Plugin API usada (ej: '2.1')
  main?: string; // punto de entrada (por defecto main.js)
  permissions: PluginPermission[];
  actions: PluginActionV2[];
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
