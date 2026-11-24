/**
 * host.ts — Emulador de host Elgato Stream Deck (fase 2, POR PROCESO).
 *
 * @deprecated El shim en-Worker (`elgato/shim/`) es el camino por defecto:
 * cero procesos `node`, cero `Bun.serve` por plugin. Este host solo se usa
 * con `LIBREDECK_ELGATO_SHIM=0` y no recibe mantenimiento.
 *
 * Por cada plugin Elgato Node se levanta un `Bun.serve` WebSocket dedicado
 * en un puerto libre y se spawnea `node <CodePath> -port <p> -pluginUUID
 * <uuid> -registerEvent <event> -info <json>`. El plugin se registra con
 * `registerEvent` y a partir de ahí el host traduce:
 *  - host → plugin: willAppear/willDisappear/keyDown/keyUp,
 *    didReceiveSettings/didReceiveGlobalSettings, sendToPlugin.
 *  - plugin → host: setTitle/setImage/setState/showAlert/showOk (→
 *    `onStateChange`), setSettings/getSettings/setGlobalSettings/
 *    getGlobalSettings (persistidos en DB `settings`), openUrl, logMessage.
 *
 * Sin dependencias nuevas: solo `Bun.serve` + `node:child_process` spawn.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import type { DatabaseService } from '../db';
import {
  REGISTER_EVENT,
  VIRTUAL_DEVICE_ID,
  buildHostMessage,
  buildInfoObject,
  isRegisterMessage,
  payloadOf,
  type HostToPluginEvent,
} from './protocol';

export interface ElgatoActionState {
  title?: string | null;
  image?: string | null;
  /** Estado visual (slot de `States[]` del manifest Elgato). */
  state?: number | null;
  alert?: boolean | null;
  updatedAt: number;
}

export type ElgatoStateCallback = (
  pluginId: string,
  context: string,
  state: ElgatoActionState
) => void;

export interface ElgatoHostOptions {
  pluginsDir: string;
  db: DatabaseService;
  onStateChange?: ElgatoStateCallback;
  /** Timeout de registro del plugin (ms). Por defecto 15000. */
  registerTimeoutMs?: number;
  /** Reintentos de arranque tras crash/timeout (además del intento inicial). */
  maxRestarts?: number;
  /** En tests: no abre el navegador, solo lo registra en logs. */
  noOpen?: boolean;
}

interface ContextInfo {
  action: string;
  device: string;
}

interface ElgatoSession {
  pluginId: string;
  elgatoManifest: any;
  codePathAbs: string;
  port: number;
  server: any;
  child: ChildProcess | null;
  socket: any | null;
  registered: boolean;
  registerTimer: ReturnType<typeof setTimeout> | null;
  registerSettled: { resolve: () => void; reject: (e: Error) => void } | null;
  contexts: Map<string, ContextInfo>;
  states: Map<string, ElgatoActionState>;
  settings: Map<string, any>;
  globalSettings: any;
  stopping: boolean;
  restarts: number;
  // Versión del manifest para el -info (el cuatripartito Elgato tal cual).
  version: string;
}

const DEFAULT_REGISTER_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESTARTS = 3;
const KILL_GRACE_MS = 2000;

export function elgatoGlobalKey(pluginId: string): string {
  return `plugin.${pluginId}.elgato.global`;
}

export function elgatoSettingsKey(pluginId: string, context: string): string {
  return `plugin.${pluginId}.elgato.settings.${context}`;
}

function readJsonSetting(db: DatabaseService, key: string): any | null {
  try {
    const raw = db.getSetting(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJsonSetting(db: DatabaseService, key: string, value: any): void {
  try {
    db.setSetting(key, JSON.stringify(value ?? null));
  } catch {}
}

export class ElgatoHost {
  private sessions = new Map<string, ElgatoSession>();
  private opts: Required<Omit<ElgatoHostOptions, 'pluginsDir' | 'db' | 'onStateChange'>> & {
    pluginsDir: string;
    db: DatabaseService;
    onStateChange?: ElgatoStateCallback;
  };

  constructor(opts: ElgatoHostOptions) {
    this.opts = {
      pluginsDir: opts.pluginsDir,
      db: opts.db,
      onStateChange: opts.onStateChange,
      registerTimeoutMs: opts.registerTimeoutMs ?? DEFAULT_REGISTER_TIMEOUT_MS,
      maxRestarts: opts.maxRestarts ?? DEFAULT_MAX_RESTARTS,
      noOpen: opts.noOpen ?? process.env.NODE_ENV === 'test',
    };
  }

  // -- ciclo de vida ---------------------------------------------------------

  public isRunning(pluginId: string): boolean {
    const s = this.sessions.get(pluginId);
    return !!s && !s.stopping && !!s.child && s.registered;
  }

  /**
   * Arranca el proceso Node del plugin Elgato y espera su `registerEvent`.
   * Reintenta `maxRestarts` veces ante crash/timeout de registro.
   */
  public async startPlugin(pluginId: string, elgatoManifest: any): Promise<void> {
    const existing = this.sessions.get(pluginId);
    if (existing && !existing.stopping && existing.child && existing.registered) return;

    const codeRel = this.pickCodePath(elgatoManifest);
    if (!codeRel) {
      throw new Error(`Plugin Elgato ${pluginId} sin CodePath .js ejecutable`);
    }
    const codePathAbs = this.resolveCodeAbs(pluginId, codeRel);
    if (!codePathAbs) {
      throw new Error(`CodePath no encontrado para ${pluginId}: ${codeRel}`);
    }
    const version =
      typeof elgatoManifest?.Version === 'string' ? elgatoManifest.Version : '1.0.0.0';

    const session: ElgatoSession = {
      pluginId,
      elgatoManifest,
      codePathAbs,
      port: 0,
      server: null,
      child: null,
      socket: null,
      registered: false,
      registerTimer: null,
      registerSettled: null,
      contexts: new Map(),
      states: new Map(),
      settings: new Map(),
      globalSettings: {},
      stopping: false,
      restarts: 0,
      version,
    };
    // Restaurar persistencia previa (settings) antes de arrancar.
    const persistedGlobal = readJsonSetting(this.opts.db, elgatoGlobalKey(pluginId));
    if (persistedGlobal && typeof persistedGlobal === 'object') {
      session.globalSettings = persistedGlobal;
    }
    this.sessions.set(pluginId, session);

    // Un Bun.serve por plugin, en puerto efímero (port: 0).
    session.server = Bun.serve({
      port: 0,
      fetch: (req: Request, server: any) => {
        try {
          if (server.upgrade(req)) return undefined as any;
        } catch {}
        return new Response('LibreDeck Elgato host', { status: 200 });
      },
      websocket: {
        open: (ws: any) => {
          // El socket activo es el último que se conectó.
          session.socket = ws;
        },
        message: (_ws: any, message: any) => {
          this.handlePluginMessage(session, typeof message === 'string' ? message : String(message));
        },
        close: () => {
          if (session.socket) {
            try { session.socket = null; } catch {}
          }
        },
      },
    });
    session.port = Number(session.server?.port ?? 0);
    if (!session.port) {
      this.dropSession(session);
      throw new Error(`No se pudo abrir puerto WS para ${pluginId}`);
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.opts.maxRestarts; attempt++) {
      session.restarts = attempt;
      try {
        await this.spawnAndWaitRegister(session);
        try {
          this.opts.db.addLog({
            level: 'info',
            message: `Plugin Elgato ${pluginId} registrado (puerto ${session.port})`,
            meta: { pluginId },
            ts: Date.now(),
          });
        } catch {}
        // Empujar estado global conocido para que el plugin arranque coherente.
        this.pushGlobalSettings(session);
        return;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (session.stopping) break;
        this.killChild(session);
        if (attempt < this.opts.maxRestarts) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          if (session.stopping) break;
        }
      }
    }
    this.dropSession(session);
    const msg = `Plugin Elgato ${pluginId} no se registró: ${lastError?.message ?? 'desconocido'}`;
    try {
      this.opts.db.addLog({ level: 'error', message: msg, meta: { pluginId }, ts: Date.now() });
    } catch {}
    throw new Error(msg);
  }

  public async stopPlugin(pluginId: string): Promise<void> {
    const session = this.sessions.get(pluginId);
    if (!session) return;
    session.stopping = true;
    if (session.registerTimer) {
      clearTimeout(session.registerTimer);
      session.registerTimer = null;
    }
    if (session.registerSettled) {
      const s = session.registerSettled;
      session.registerSettled = null;
      s.reject(new Error(`Plugin ${pluginId} detenido durante el registro`));
    }
    this.killChild(session, true);
    try {
      session.socket?.close?.();
    } catch {}
    session.socket = null;
    try {
      session.server?.stop?.(true);
    } catch {}
    session.server = null;
    this.sessions.delete(pluginId);
  }

  public async stopAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      try {
        await this.stopPlugin(id);
      } catch {}
    }
  }

  // -- eventos host → plugin --------------------------------------------------

  /**
   * Envía keyDown/keyUp a un contexto. Si el contexto es nuevo, primero se
   * emite willAppear para que el plugin lo conozca (patrón Elgato real).
   */
  public sendKey(
    pluginId: string,
    actionUUID: string,
    context: string,
    event: 'keyDown' | 'keyUp'
  ): boolean {
    const session = this.sessions.get(pluginId);
    if (!session || !session.registered || !session.socket) return false;
    if (!session.contexts.has(context)) {
      session.contexts.set(context, { action: actionUUID, device: VIRTUAL_DEVICE_ID });
      this.sendToPlugin(session, buildHostMessage('willAppear', {
        action: actionUUID,
        context,
        payload: {
          settings: session.settings.get(context) ?? {},
          coordinates: { column: 0, row: 0 },
        },
      }));
    }
    return this.sendToPlugin(
      session,
      buildHostMessage(event, {
        action: actionUUID,
        context,
        payload: {
          settings: session.settings.get(context) ?? {},
          coordinates: { column: 0, row: 0 },
          userDesiredState: session.states.get(context)?.state ?? 0,
        },
      })
    );
  }

  /** Emite willDisappear y olvida el contexto. */
  public removeContext(pluginId: string, context: string): boolean {
    const session = this.sessions.get(pluginId);
    if (!session) return false;
    const info = session.contexts.get(context);
    if (info) {
      this.sendToPlugin(session, buildHostMessage('willDisappear', {
        action: info.action, context, payload: { settings: session.settings.get(context) ?? {} },
      }));
      session.contexts.delete(context);
      return true;
    }
    return false;
  }

  /**
   * Anuncia un contexto (willAppear) sin pulsar: hace que el plugin arranque
   * su render (DeckCal empieza su polling nada más aparecer la tecla).
   * Idempotente por contexto.
   */
  public ensureContext(pluginId: string, actionUUID: string, context: string): boolean {
    const session = this.sessions.get(pluginId);
    if (!session || !session.registered || !session.socket) return false;
    if (session.contexts.has(context)) return true;
    session.contexts.set(context, { action: actionUUID, device: VIRTUAL_DEVICE_ID });
    return this.sendToPlugin(session, buildHostMessage('willAppear', {
      action: actionUUID,
      context,
      payload: {
        settings: session.settings.get(context) ?? readJsonSetting(this.opts.db, elgatoSettingsKey(pluginId, context)) ?? {},
        coordinates: { column: 0, row: 0 },
      },
    }));
  }

  /**
   * Fija settings de un contexto desde LibreDeck (p.ej. Property Inspector
   * propio): persiste y empuja `didReceiveSettings` al plugin.
   */
  public setSettings(pluginId: string, context: string, settings: any): boolean {
    const session = this.sessions.get(pluginId);
    const value = settings ?? {};
    if (session) session.settings.set(context, value);
    writeJsonSetting(this.opts.db, elgatoSettingsKey(pluginId, context), value);
    if (!session) return false;
    return this.sendToPlugin(session, {
      event: 'didReceiveSettings',
      action: session.contexts.get(context)?.action ?? '',
      context,
      device: VIRTUAL_DEVICE_ID,
      payload: { settings: value, coordinates: { column: 0, row: 0 } },
    } as any);
  }

  public getContexts(pluginId: string): string[] {
    return [...(this.sessions.get(pluginId)?.contexts.keys() ?? [])];
  }

  public getActionState(pluginId: string, context: string): ElgatoActionState | null {
    return this.sessions.get(pluginId)?.states.get(context) ?? null;
  }

  public getGlobalSettings(pluginId: string): any {
    return this.sessions.get(pluginId)?.globalSettings ?? null;
  }

  // -- internos ---------------------------------------------------------------

  private pickCodePath(manifest: any): string | null {
    if (!manifest || typeof manifest !== 'object') return null;
    if (process.platform === 'win32') {
      return manifest.CodePathWin ?? manifest.CodePath ?? null;
    }
    if (process.platform === 'darwin') {
      return manifest.CodePathMac ?? manifest.CodePath ?? null;
    }
    return manifest.CodePath ?? manifest.CodePathMac ?? manifest.CodePathWin ?? null;
  }

  /** Resuelve el CodePath relativo al dir instalado (`elgato/` primero). */
  private resolveCodeAbs(pluginId: string, codeRel: string): string | null {
    const safe = codeRel.replace(/^\.[\\/]/, '').replace(/\.\./g, '');
    const baseCandidates = [
      path.join(this.opts.pluginsDir, pluginId),
      path.join(this.opts.pluginsDir, pluginId.replace(/\//g, '__')),
    ];
    for (const base of baseCandidates) {
      for (const root of [path.join(base, 'elgato'), base]) {
        const abs = path.join(root, safe);
        try {
          if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
        } catch {}
      }
    }
    return null;
  }

  /** Sube desde el binario hasta el dir con manifest.json (el SDK lo exige en CWD). */
  private findManifestDir(codeAbs: string): string {
    let dir = path.dirname(codeAbs);
    for (let i = 0; i < 4; i++) {
      try {
        if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
      } catch {}
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return path.dirname(codeAbs);
  }

  private spawnAndWaitRegister(session: ElgatoSession): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      session.registered = false;
      session.registerSettled = { resolve, reject };
      const info = buildInfoObject({ pluginUUID: session.pluginId, pluginVersion: session.version });
      // El SDK Elgato lee manifest.json desde el CWD: usar el dir que contiene
      // el manifest, no el dir del binario (DeckCal: manifest en elgato/,
      // binario en elgato/bin/).
      const cwd = this.findManifestDir(session.codePathAbs);
      let child: ChildProcess;
      try {
        child = spawn(
          'node',
          [
            session.codePathAbs,
            '-port', String(session.port),
            '-pluginUUID', session.pluginId,
            '-registerEvent', REGISTER_EVENT,
            '-info', JSON.stringify(info),
          ],
          { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
        );
      } catch (e) {
        session.registerSettled = null;
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      session.child = child;
      child.stdout?.on('data', (d) => this.appendChildLog(session, 'stdout', String(d)));
      child.stderr?.on('data', (d) => this.appendChildLog(session, 'stderr', String(d)));
      child.on('error', (err) => {
        const settled = session.registerSettled;
        session.registerSettled = null;
        if (session.registerTimer) { clearTimeout(session.registerTimer); session.registerTimer = null; }
        settled?.reject(err instanceof Error ? err : new Error(String(err)));
        // Crash fuera de registro: reintento gestionado por startPlugin o respawn perezoso.
        if (!settled && !session.stopping) {
          try {
            this.opts.db.addLog({
              level: 'error',
              message: `Plugin Elgato ${session.pluginId} crash: ${String((err as Error)?.message ?? err).slice(0, 300)}`,
              meta: { pluginId: session.pluginId },
              ts: Date.now(),
            });
          } catch {}
        }
      });
      child.on('exit', (code, signal) => {
        const was = session.child;
        if (was === child) session.child = null;
        const settled = session.registerSettled;
        if (settled && !session.registered) {
          session.registerSettled = null;
          if (session.registerTimer) { clearTimeout(session.registerTimer); session.registerTimer = null; }
          settled.reject(new Error(`Proceso Elgato ${session.pluginId} salió antes de registrarse (code=${code} signal=${signal})`));
          return;
        }
        if (!session.stopping && session.registered) {
          // Crash post-registro: marcar y dejar que el próximo sendKey/start lo recupere.
          try {
            this.opts.db.addLog({
              level: 'warn',
              message: `Plugin Elgato ${session.pluginId} terminó (code=${code} signal=${signal})`,
              meta: { pluginId: session.pluginId },
              ts: Date.now(),
            });
          } catch {}
          session.registered = false;
        }
      });
      session.registerTimer = setTimeout(() => {
        session.registerTimer = null;
        const settled = session.registerSettled;
        session.registerSettled = null;
        settled?.reject(new Error(`Timeout de registro (${this.opts.registerTimeoutMs}ms)`));
      }, this.opts.registerTimeoutMs);
    });
  }

  private appendChildLog(session: ElgatoSession, stream: string, text: string): void {
    const line = text.trim();
    if (!line) return;
    try {
      this.opts.db.addLog({
        level: stream === 'stderr' ? 'warn' : 'info',
        message: `[elgato:${session.pluginId}:${stream}] ${line.slice(0, 500)}`,
        meta: { pluginId: session.pluginId, stream },
        ts: Date.now(),
      });
    } catch {}
  }

  /** Termina el proceso real con process.kill (SIGTERM + SIGKILL de gracia). */
  private killChild(session: ElgatoSession, wait = false): void {
    const child = session.child;
    session.child = null;
    if (!child || child.exitCode !== null) return;
    const pid = child.pid;
    try {
      if (pid) process.kill(pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {}
    if (wait) {
      // Espera breve y síncrona evitada: el SIGKILL de gracia cubre el caso colgado.
    }
    setTimeout(() => {
      try {
        if (pid) process.kill(pid, 0);
        else return;
        try { process.kill(pid, 'SIGKILL'); } catch {}
      } catch {
        // Ya terminó.
      }
    }, KILL_GRACE_MS).unref?.();
  }

  private dropSession(session: ElgatoSession): void {
    session.stopping = true;
    if (session.registerTimer) { clearTimeout(session.registerTimer); session.registerTimer = null; }
    this.killChild(session);
    try { session.socket?.close?.(); } catch {}
    try { session.server?.stop?.(true); } catch {}
    if (this.sessions.get(session.pluginId) === session) {
      this.sessions.delete(session.pluginId);
    }
  }

  private sendToPlugin(session: ElgatoSession, msg: any): boolean {
    if (!session.socket) return false;
    try {
      session.socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private pushGlobalSettings(session: ElgatoSession): void {
    this.sendToPlugin(session, {
      event: 'didReceiveGlobalSettings',
      payload: { settings: session.globalSettings ?? {} },
    });
  }

  /** openUrl del plugin: abre el navegador del SO (en tests solo se loguea). */
  private openUrl(session: ElgatoSession, url: string): void {
    try {
      this.opts.db.addLog({
        level: 'info',
        message: `[elgato:${session.pluginId}] openUrl ${url.slice(0, 300)}`,
        meta: { pluginId: session.pluginId, url: url.slice(0, 500) },
        ts: Date.now(),
      });
    } catch {}
    if (this.opts.noOpen) return;
    try {
      const plat = process.platform;
      const child =
        plat === 'win32'
          ? spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true })
          : plat === 'darwin'
            ? spawn('open', [url], { detached: true, stdio: 'ignore', windowsHide: true })
            : spawn('xdg-open', [url], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref?.();
    } catch {}
  }

  private updateState(
    session: ElgatoSession,
    context: string,
    patch: Partial<ElgatoActionState>
  ): void {
    const prev = session.states.get(context) ?? { updatedAt: Date.now() };
    const next: ElgatoActionState = { ...prev, ...patch, updatedAt: Date.now() };
    session.states.set(context, next);
    try {
      this.opts.onStateChange?.(session.pluginId, context, { ...next });
    } catch {}
  }

  private handlePluginMessage(session: ElgatoSession, raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.event !== 'string') return;

    // Registro inicial.
    if (isRegisterMessage(msg)) {
      session.registered = true;
      if (session.registerTimer) { clearTimeout(session.registerTimer); session.registerTimer = null; }
      const settled = session.registerSettled;
      session.registerSettled = null;
      // Hidratar settings persistidos por contexto bajo demanda (lazy en getSettings).
      settled?.resolve();
      return;
    }

    const context: string | undefined = typeof msg.context === 'string' ? msg.context : undefined;
    const payload = payloadOf(msg);
    const ctxInfo = (actionFallback = ''): ContextInfo | null => {
      if (!context) return null;
      let info = session.contexts.get(context);
      if (!info) {
        info = {
          action: typeof msg.action === 'string' && msg.action ? msg.action : actionFallback,
          device: typeof msg.device === 'string' && msg.device ? msg.device : VIRTUAL_DEVICE_ID,
        };
        session.contexts.set(context, info);
      }
      return info;
    };

    switch (msg.event as string) {
      case 'setTitle': {
        if (!context) break;
        ctxInfo();
        const title = payload.title ?? (msg as any).title ?? payload.payload?.title ?? null;
        this.updateState(session, context, { title: title != null ? String(title) : null });
        break;
      }
      case 'setImage': {
        if (!context) break;
        ctxInfo();
        const image =
          typeof payload.image === 'string' ? payload.image
          : typeof (msg as any).image === 'string' ? (msg as any).image
          : null;
        this.updateState(session, context, { image });
        break;
      }
      case 'setState': {
        if (!context) break;
        ctxInfo();
        const n = Number(payload.state ?? (msg as any).state);
        this.updateState(session, context, { state: Number.isFinite(n) ? n : null });
        break;
      }
      case 'showAlert': {
        if (!context) break;
        ctxInfo();
        this.updateState(session, context, { alert: true });
        break;
      }
      case 'showOk': {
        if (!context) break;
        ctxInfo();
        this.updateState(session, context, { alert: false });
        break;
      }
      case 'setSettings': {
        if (!context) break;
        ctxInfo();
        const value = payload.settings ?? payload;
        const clean = value && typeof value === 'object' ? value : {};
        session.settings.set(context, clean);
        writeJsonSetting(this.opts.db, elgatoSettingsKey(session.pluginId, context), clean);
        break;
      }
      case 'getSettings': {
        if (!context) break;
        const info = ctxInfo();
        let value = session.settings.get(context);
        if (value === undefined) {
          const persisted = readJsonSetting(this.opts.db, elgatoSettingsKey(session.pluginId, context));
          value = persisted && typeof persisted === 'object' ? persisted : {};
          session.settings.set(context, value);
        }
        this.sendToPlugin(session, {
          event: 'didReceiveSettings',
          action: info?.action ?? (typeof msg.action === 'string' ? msg.action : ''),
          context,
          device: info?.device ?? VIRTUAL_DEVICE_ID,
          payload: { settings: value, coordinates: { column: 0, row: 0 } },
        });
        break;
      }
      case 'setGlobalSettings': {
        const value = payload.settings ?? payload;
        const clean = value && typeof value === 'object' ? value : {};
        session.globalSettings = clean;
        writeJsonSetting(this.opts.db, elgatoGlobalKey(session.pluginId), clean);
        break;
      }
      case 'getGlobalSettings': {
        let value = session.globalSettings;
        if (!value || typeof value !== 'object') {
          const persisted = readJsonSetting(this.opts.db, elgatoGlobalKey(session.pluginId));
          value = persisted && typeof persisted === 'object' ? persisted : {};
          session.globalSettings = value;
        }
        this.sendToPlugin(session, {
          event: 'didReceiveGlobalSettings',
          payload: { settings: value },
        });
        break;
      }
      case 'openUrl': {
        const url = payload.url ?? payload.payload?.url;
        if (typeof url === 'string' && url) this.openUrl(session, url);
        break;
      }
      case 'logMessage': {
        const message = payload.message ?? (typeof payload === 'string' ? payload : JSON.stringify(payload));
        try {
          this.opts.db.addLog({
            level: 'info',
            message: `[elgato:${session.pluginId}] ${String(message).slice(0, 500)}`,
            meta: { pluginId: session.pluginId },
            ts: Date.now(),
          });
        } catch {}
        break;
      }
      case 'sendToPropertyInspector': {
        // Sin PI en LibreDeck: se registra para diagnóstico.
        try {
          this.opts.db.addLog({
            level: 'info',
            message: `[elgato:${session.pluginId}] sendToPropertyInspector (${context ?? 'sin contexto'})`,
            meta: { pluginId: session.pluginId, context, payload: JSON.stringify(payload).slice(0, 300) },
            ts: Date.now(),
          });
        } catch {}
        break;
      }
      case 'switchToProfile':
      case 'sendToPlugin':
        break;
      default:
        break;
    }
  }
}
