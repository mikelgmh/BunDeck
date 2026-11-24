/**
 * runtime.ts — Fachada del runtime de compatibilidad Elgato (fase 2, por proceso).
 *
 * @deprecated Ver `elgato/shim/`: el shim en-Worker es el camino por defecto
 * (cero procesos `node`, cero `Bun.serve` por plugin). Este manager solo se
 * usa con `LIBREDECK_ELGATO_SHIM=0` y no recibe mantenimiento.
 *
 * Mantiene un `ElgatoHost` por plugin y normaliza el `CodePath` del
 * manifest Elgato según la plataforma (`CodePathWin` / `CodePathMac` /
 * `CodePath`). El `PluginLoader` (otro agente) la integrará para arrancar
 * plugins `needs-manual` habilitados.
 */

import { ElgatoHost, type ElgatoActionState, type ElgatoStateCallback } from './host';
import { DatabaseService } from '../db';
import { getPluginsDir } from '../paths';
import type { ElgatoManifest } from './manifest';

export interface ElgatoRuntimeOptions {
  pluginsDir: string;
  db: DatabaseService;
  onStateChange?: ElgatoStateCallback;
  registerTimeoutMs?: number;
  maxRestarts?: number;
  noOpen?: boolean;
}

/**
 * Elige el ejecutable Node del plugin según la plataforma.
 * Windows prefiere `CodePathWin`, macOS `CodePathMac`, el resto `CodePath`
 * (con fallback cruzado si el específico falta).
 */
export function resolveCodePath(
  manifest: ElgatoManifest | any,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (!manifest || typeof manifest !== 'object') return null;
  if (platform === 'win32') {
    return manifest.CodePathWin ?? manifest.CodePath ?? null;
  }
  if (platform === 'darwin') {
    return manifest.CodePathMac ?? manifest.CodePath ?? null;
  }
  return manifest.CodePath ?? manifest.CodePathMac ?? manifest.CodePathWin ?? null;
}

export class ElgatoRuntimeManager {
  private hosts = new Map<string, ElgatoHost>();
  private opts: ElgatoRuntimeOptions;

  constructor(opts: ElgatoRuntimeOptions) {
    this.opts = opts;
  }

  private hostFor(pluginId: string): ElgatoHost {
    let host = this.hosts.get(pluginId);
    if (!host) {
      host = new ElgatoHost({
        pluginsDir: this.opts.pluginsDir,
        db: this.opts.db,
        onStateChange: this.opts.onStateChange,
        registerTimeoutMs: this.opts.registerTimeoutMs,
        maxRestarts: this.opts.maxRestarts,
        noOpen: this.opts.noOpen,
      });
      this.hosts.set(pluginId, host);
    }
    return host;
  }

  /** Arranca el plugin Elgato (idempotente si ya corre). */
  public async start(pluginId: string, elgatoManifest: ElgatoManifest | any): Promise<void> {
    console.warn(
      `[DEPRECATED] ElgatoRuntimeManager.start(${pluginId}): runtime por proceso en desuso; ` +
      `el shim en-Worker (elgato/shim/) es el camino. Solo con LIBREDECK_ELGATO_SHIM=0.`
    );
    const code = resolveCodePath(elgatoManifest);
    if (!code) throw new Error(`Plugin Elgato ${pluginId} sin CodePath ejecutable`);
    await this.hostFor(pluginId).startPlugin(pluginId, elgatoManifest);
  }

  public async stop(pluginId: string): Promise<void> {
    const host = this.hosts.get(pluginId);
    if (!host) return;
    try {
      await host.stopPlugin(pluginId);
    } finally {
      this.hosts.delete(pluginId);
    }
  }

  public async stopAll(): Promise<void> {
    for (const [id, host] of [...this.hosts.entries()]) {
      try {
        await host.stopPlugin(id);
      } catch {}
      this.hosts.delete(id);
    }
  }

  public isRunning(pluginId: string): boolean {
    return this.hosts.get(pluginId)?.isRunning(pluginId) ?? false;
  }

  /** Último estado visual conocido (setTitle/setImage/setState) de un contexto. */
  public getStateForAction(pluginId: string, context: string): ElgatoActionState | null {
    return this.hosts.get(pluginId)?.getActionState(pluginId, context) ?? null;
  }

  public sendKey(
    pluginId: string,
    actionUUID: string,
    contextOrEvent: string,
    eventOrPayload?: any
  ): boolean {
    // Firma canónica: (pluginId, actionUUID, context, event)
    // Firma loader fase 2: (id, elgatoUuid, 'keyDown'|'keyUp', { params, context })
    let context: string;
    let event: 'keyDown' | 'keyUp';
    if (contextOrEvent === 'keyDown' || contextOrEvent === 'keyUp') {
      event = contextOrEvent;
      const p = eventOrPayload as any;
      const c = p?.context;
      context =
        (typeof c === 'object' ? (c?.buttonId ?? c?.button_id ?? null) : (typeof c === 'string' ? c : null)) ??
        p?.contextId ?? p?.context?.id ?? `ld-${actionUUID}`;
      if (typeof context !== 'string' || !context) context = `ld-${actionUUID}`;
    } else {
      context = contextOrEvent;
      event = (eventOrPayload === 'keyUp' ? 'keyUp' : 'keyDown') as any;
    }
    return this.hosts.get(pluginId)?.sendKey(pluginId, actionUUID, context, event) ?? false;
  }

  public setSettings(pluginId: string, context: string, settings: any): boolean {
    return this.hosts.get(pluginId)?.setSettings(pluginId, context, settings) ?? false;
  }

  public getContexts(pluginId: string): string[] {
    return this.hosts.get(pluginId)?.getContexts(pluginId) ?? [];
  }

  /** Anuncia un contexto virtual (willAppear sin pulsar) para arrancar el render. */
  public ensureContext(pluginId: string, actionUUID: string, context: string): boolean {
    return this.hosts.get(pluginId)?.ensureContext(pluginId, actionUUID, context) ?? false;
  }

  /** Alias compat loader: startPlugin({ pluginId, elgatoManifest, manifest, ... }) */
  public async startPlugin(args: any, maybeManifest?: any): Promise<void> {
    if (typeof args === 'string') return this.start(args, maybeManifest);
    const pluginId = args?.pluginId ?? args?.id;
    const elgatoManifest = args?.elgatoManifest ?? args?.manifest?.['x-elgato']?.raw ?? maybeManifest ?? args?.manifest;
    // El host necesita el manifest Elgato ORIGINAL (CodePath...); si solo hay
    // convertido, reconstruir CodePath desde x-elgato.
    let raw = elgatoManifest;
    if (raw && !raw.CodePath && !raw.CodePathWin && !raw.CodePathMac) {
      const x = args?.manifest?.['x-elgato'];
      if (x?.codePath) raw = { ...raw, CodePath: x.codePath };
    }
    if (args?.onEvent && typeof args.onEvent === 'function' && !this.opts.onStateChange) {
      this.opts = { ...this.opts, onStateChange: (pid: string, ctx: string, state: any) => {
        try { (args.onEvent as any)({ pluginId: pid, context: ctx, state }); } catch {}
      } };
    }
    return this.start(pluginId, raw ?? args?.manifest);
  }

  /** Alias compat loader: load(startArgs) */
  public async load(args: any): Promise<void> {
    return this.startPlugin(args);
  }

  /** Alias compat loader: stopPlugin(id) */
  public async stopPlugin(pluginId: string): Promise<void> {
    return this.stop(pluginId);
  }

  /** Alias compat loader: getState(id, action?) */
  public getState(pluginId: string, context?: string): any {
    if (context) return this.getStateForAction(pluginId, context);
    return {
      running: this.isRunning(pluginId),
      contexts: this.getContexts(pluginId),
    };
  }

  public getStates(pluginId: string): any {
    return this.getState(pluginId);
  }

  /** Hosts vivos (para diagnóstico). */
  public runningPlugins(): string[] {
    return [...this.hosts.keys()].filter((id) => this.hosts.get(id)?.isRunning(id));
  }
}

let singleton: ElgatoRuntimeManager | null = null;

/** Singleton perezoso para el PluginLoader (import dinámico). */
export function getElgatoRuntimeManager(): ElgatoRuntimeManager {
  if (singleton) return singleton;
  const db = new DatabaseService();
  singleton = new ElgatoRuntimeManager({ pluginsDir: getPluginsDir(), db });
  return singleton;
}

/** Aliases que el loader prueba por nombre. */
export const getElgatoRuntime = getElgatoRuntimeManager;
export const getManager = getElgatoRuntimeManager;
export const getInstance = getElgatoRuntimeManager;
