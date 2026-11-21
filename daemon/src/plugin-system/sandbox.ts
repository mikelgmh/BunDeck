import type { PluginManifestV2 } from './types';
import { DatabaseService, getDatabase } from '../db';
import { checkUrlPermission, checkShellPermission, requirePermission } from './permissions';
import { getDataDir } from '../paths';
import type { WorkerOpName } from './protocol';
import path from 'path';
import fs from 'fs';

export interface SandboxOptions {
  timeoutMs: number;
  cooldownMs?: number;
}

/** Destino de `emitEvent`: normalmente `wsManager.broadcast(...)`. */
export type PluginEventSink = (eventName: string, payload: any, pluginId: string) => void;

const MAX_HTTP_BODY = 5 * 1024 * 1024; // 5MB
const MAX_FILE_WRITE = 2 * 1024 * 1024; // 2MB por archivo de plugin
const MAX_SETTING_VALUE = 64 * 1024; // 64KB por setting
const HTTP_TIMEOUT_MS = 30000;

/**
 * Resuelve una ruta relativa del plugin dentro de su sandbox
 * (`<data>/plugins/<pluginId>/`). Lanza si hay path traversal.
 */
export function resolvePluginPath(pluginId: string, relativePath: string): string {
  const base = path.resolve(getDataDir(), 'plugins', pluginId);
  const full = path.resolve(base, relativePath);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('Path traversal bloqueado');
  }
  return full;
}

export class PluginSandbox {
  private lastExecution = new Map<string, number>();
  private eventSink: PluginEventSink | null = null;

  /** Inyecta el destino real de eventos (WebSocketManager). Sin esto, `emitEvent` solo queda en logs. */
  public setEventSink(sink: PluginEventSink | null): void {
    this.eventSink = sink;
  }

  private db(): DatabaseService {
    return new DatabaseService();
  }

  /**
   * Ejecuta una operación pedida por el Worker del plugin, aplicando permisos
   * del manifest EN EL PADRE. El Worker nunca toca SQLite ni el FS directamente.
   */
  async runOp(manifest: PluginManifestV2, op: WorkerOpName, args: any): Promise<any> {
    const pluginId = manifest.id;
    const db = this.db();
    switch (op) {
      case 'get-setting':
        return db.getSetting(`plugin.${pluginId}.${args.key}`);
      case 'set-setting':
        if (String(args.value).length > MAX_SETTING_VALUE) throw new Error('Setting excede 64KB');
        db.setSetting(`plugin.${pluginId}.${args.key}`, String(args.value));
        return undefined;
      case 'delete-setting':
        getDatabase().prepare('DELETE FROM settings WHERE key = ?').run(`plugin.${pluginId}.${args.key}`);
        return undefined;
      case 'log':
        db.addLog({
          level: args.level,
          message: `[${pluginId}] ${args.message}`,
          meta: { pluginId, ...args.meta },
          ts: Date.now(),
        });
        return undefined;
      case 'emit-event':
        db.addLog({
          level: 'info',
          message: `[${pluginId}] emit ${args.eventName}`,
          meta: { pluginId, eventName: args.eventName, payload: args.payload },
          ts: Date.now(),
        });
        this.eventSink?.(args.eventName, args.payload, pluginId);
        return undefined;
      case 'http-fetch': {
        checkUrlPermission(manifest, args.url);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
        try {
          const res = await fetch(args.url, { ...(args.init ?? {}), signal: ctrl.signal });
          const bodyText = await res.text();
          if (bodyText.length > MAX_HTTP_BODY) throw new Error('Respuesta HTTP excede 5MB');
          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => { headers[k] = v; });
          return { status: res.status, statusText: res.statusText, headers, bodyText };
        } catch (e: any) {
          if (e?.name === 'AbortError') throw new Error(`HTTP timeout ${HTTP_TIMEOUT_MS}ms`);
          throw e;
        } finally {
          clearTimeout(timer);
        }
      }
      case 'fs-read': {
        requirePermission(manifest, 'filesystem');
        const full = resolvePluginPath(pluginId, args.relativePath);
        const st = await fs.promises.stat(full).catch(() => null);
        if (st && st.size > MAX_FILE_WRITE * 4) throw new Error('Archivo excede límite de lectura');
        return await fs.promises.readFile(full, 'utf8');
      }
      case 'fs-write': {
        requirePermission(manifest, 'filesystem');
        if (String(args.content).length > MAX_FILE_WRITE) throw new Error('Archivo excede 2MB');
        const full = resolvePluginPath(pluginId, args.relativePath);
        await fs.promises.mkdir(path.dirname(full), { recursive: true });
        await fs.promises.writeFile(full, String(args.content), 'utf8');
        return undefined;
      }
      case 'fs-exists': {
        requirePermission(manifest, 'filesystem');
        try {
          return fs.existsSync(resolvePluginPath(pluginId, args.relativePath));
        } catch {
          return false;
        }
      }
      default:
        throw new Error(`Op desconocida del worker: ${op}`);
    }
  }

  /**
   * LEGADO: ejecuta un handler EN PROCESO con timeout aparente.
   *
   * Solo para código nativo/tests. Los plugins externos SIEMPRE corren en
   * Worker (ver `plugin-worker.ts`), donde el timeout es real
   * (`Worker.terminate()` + re-spawn). Este `Promise.race` NO cancela el
   * handler: se mantiene únicamente por compatibilidad.
   */
  async executeWithSandbox(
    manifest: PluginManifestV2,
    fullActionId: string,
    handler: Function,
    params: any,
    context: any,
    opts: SandboxOptions
  ): Promise<any> {
    const cooldown = opts.cooldownMs ?? 0;
    if (cooldown > 0) {
      const last = this.lastExecution.get(fullActionId);
      if (last && Date.now() - last < cooldown) {
        throw new Error(`Action ${fullActionId} en cooldown (${cooldown}ms)`);
      }
    }

    // Política de shell: lista de denegados (NO es sandbox, ver permissions.ts).
    if (params?.command && typeof params.command === 'string') {
      try { checkShellPermission(manifest, params.command); } catch (e) { throw e; }
    }

    const execPromise = (async () => handler(params, context))();
    const timeoutMs = opts.timeoutMs ?? 30000;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout ${timeoutMs}ms en ${fullActionId}`)), timeoutMs)
    );

    try {
      const result = await Promise.race([execPromise, timeoutPromise]);
      if (cooldown) this.lastExecution.set(fullActionId, Date.now());
      return result;
    } catch (e) {
      throw e;
    }
  }
}
