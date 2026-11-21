/**
 * plugin-worker.ts — Gestor PADRE de UN plugin externo aislado en Bun Worker.
 *
 * Responsabilidades:
 * - Spawn/terminate/re-spawn del Worker (reload limpio, sin fugas de módulos).
 * - `invoke()` con timeout REAL: vencido el plazo se hace `terminate()`,
 *   se re-spawnea en background y la acción falla con error de timeout.
 * - Cooldown por acción en el padre (sobrevive a re-spawns).
 * - Permisos enforced en el padre vía `PluginSandbox.runOp` (el Worker solo
 *   pide; nunca toca SQLite ni el FS directamente).
 * - Un crash del plugin (throw en register/handler, error del Worker) NUNCA
 *   tumba el daemon: se marca el plugin en error, se loguea y se re-spawnea
 *   de forma perezosa en la próxima invocación.
 */

import { DatabaseService } from '../db';
import { checkShellPermission } from './permissions';
import { PluginSandbox, type PluginEventSink } from './sandbox';
import type { PluginManifestV2 } from './types';
import { PLUGIN_API_VERSION } from './types';
import type { ParentToWorkerMsg, WorkerOpName, WorkerToParentMsg } from './protocol';
import { nextMsgId } from './protocol';

export interface PluginWorkerOptions {
  /** Destino de `emitEvent` (típicamente wsManager.broadcast). */
  emitEvent?: PluginEventSink;
  /** Timeout del handshake init/register (ms). */
  handshakeTimeoutMs?: number;
  /** Timeout por defecto de acciones (ms) si el manifest no define uno. */
  defaultTimeoutMs?: number;
}

interface PendingInvoke {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  actionId: string;
}

const WORKER_HOST_URL = new URL('./worker-host.ts', import.meta.url).href;

export class ExternalPluginWorker {
  private worker: Worker | null = null;
  private workerGeneration = 0;
  private readyReceived = false;
  private startSettled: { resolve: (a: string[]) => void; reject: (e: Error) => void } | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private starting: Promise<string[]> | null = null;
  private registeredActions: string[] = [];
  private pendingInvokes = new Map<string, PendingInvoke>();
  private pendingOps = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private lastExecution = new Map<string, number>();
  private status: 'ok' | 'error' = 'ok';
  private lastError: string | null = null;
  private respawns = 0;
  private terminated = false;
  private sandbox = new PluginSandbox();
  private db: DatabaseService;
  private handshakeTimeoutMs: number;
  private defaultTimeoutMs: number;

  constructor(
    private manifest: PluginManifestV2,
    private mainPath: string,
    opts: PluginWorkerOptions = {}
  ) {
    this.db = new DatabaseService();
    if (opts.emitEvent) this.sandbox.setEventSink(opts.emitEvent);
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 15000;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30000;
  }

  // -- estado ---------------------------------------------------------------

  public getStatus(): 'ok' | 'error' {
    return this.status;
  }

  public getLastError(): string | null {
    return this.lastError;
  }

  public getRespawnCount(): number {
    return this.respawns;
  }

  public isAlive(): boolean {
    return this.worker !== null && !this.terminated;
  }

  private markError(message: string): void {
    this.status = 'error';
    this.lastError = message;
    try {
      this.db.addLog({ level: 'error', message: `[${this.manifest.id}] ${message}`, meta: { pluginId: this.manifest.id }, ts: Date.now() });
    } catch {}
  }

  // -- ciclo de vida ----------------------------------------------------------

  private spawnWorker(): Worker {
    const w: any = new Worker(WORKER_HOST_URL);
    w.onmessage = (ev: any) => this.handleMessage((ev?.data ?? ev) as WorkerToParentMsg);
    w.onerror = (ev: any) => this.handleWorkerError(ev);
    return w as Worker;
  }

  /**
   * Arranca el Worker y espera a que el plugin se registre.
   * Resuelve con los actionIds registrados vía `api.onAction`.
   * Llamadas concurrentes comparten el mismo arranque (sin workers duplicados).
   */
  public start(): Promise<string[]> {
    if (this.terminated) return Promise.reject(new Error(`Worker de ${this.manifest.id} terminado`));
    if (this.worker && this.readyReceived && this.registeredActions.length > 0 && !this.starting) {
      return Promise.resolve([...this.registeredActions]);
    }
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async doStart(): Promise<string[]> {
    this.workerGeneration += 1;
    const generation = this.workerGeneration;
    this.readyReceived = false;
    this.worker = this.spawnWorker();

    return new Promise<string[]>((resolve, reject) => {
      this.startSettled = { resolve, reject };
      this.startTimer = setTimeout(() => {
        if (this.workerGeneration !== generation) return;
        this.startSettled = null;
        const msg = `Timeout registrando plugin ${this.manifest.id} (${this.handshakeTimeoutMs}ms)`;
        this.markError(msg);
        this.killWorker();
        reject(new Error(msg));
      }, this.handshakeTimeoutMs);
    });
  }

  /** Termina el Worker actual sin re-spawn (usado por unload/dispose/timeout). */
  public terminate(): void {
    this.terminated = true;
    this.failAllPending(new Error(`Worker de ${this.manifest.id} terminado`));
    if (this.startSettled) {
      const s = this.startSettled;
      this.startSettled = null;
      if (this.startTimer) { clearTimeout(this.startTimer); this.startTimer = null; }
      s.reject(new Error(`Worker de ${this.manifest.id} terminado durante el arranque`));
    }
    this.starting = null;
    this.killWorker();
  }

  private killWorker(): void {
    const w = this.worker;
    this.worker = null;
    try { (w as any)?.terminate(); } catch {}
  }

  /** Re-spawn tras timeout: mata el worker colgado y levanta uno fresco. */
  private async respawn(reason: string): Promise<string[]> {
    if (this.terminated) throw new Error(`Worker de ${this.manifest.id} terminado`);
    // Si ya hay un arranque en curso (p.ej. otro timeout concurrente), unirse a él.
    if (this.starting) return this.starting;
    this.killWorker();
    this.respawns += 1;
    try {
      this.db.addLog({
        level: 'warn',
        message: `[${this.manifest.id}] re-spawn del worker (${reason})`,
        meta: { pluginId: this.manifest.id, reason },
        ts: Date.now(),
      });
    } catch {}
    const actions = await this.start();
    // El re-spawn con registro OK limpia el estado de error.
    this.status = 'ok';
    this.lastError = null;
    return actions;
  }

  // -- invocación ---------------------------------------------------------------

  private actionMeta(actionId: string): { timeoutMs: number; cooldownMs: number } {
    const def = this.manifest.actions.find(a => a.id === actionId);
    return { timeoutMs: def?.timeoutMs ?? this.defaultTimeoutMs, cooldownMs: def?.cooldownMs ?? 0 };
  }

  /**
   * Invoca una acción en el Worker con timeout REAL. Si vence:
   * terminate + re-spawn en background, y la acción falla con timeout.
   */
  public async invoke(actionId: string, params: any, context: any, timeoutOverrideMs?: number): Promise<any> {
    if (this.terminated) throw new Error(`Plugin ${this.manifest.id} descargado`);

    // Self-heal perezoso: si el worker murió, re-spawnear antes de invocar.
    if (!this.worker) {
      try {
        await this.respawn('lazy-respawn');
      } catch (e) {
        throw new Error(`Plugin ${this.manifest.id} en error: ${this.lastError ?? (e as Error).message}`);
      }
    }

    const { timeoutMs: metaTimeout, cooldownMs } = this.actionMeta(actionId);
    const timeoutMs = timeoutOverrideMs ?? metaTimeout;

    if (cooldownMs > 0) {
      const last = this.lastExecution.get(actionId);
      if (last && Date.now() - last < cooldownMs) {
        throw new Error(`Action ${this.manifest.id}.${actionId} en cooldown (${cooldownMs}ms)`);
      }
    }

    // Política de shell sobre params (lista de denegados, documentada en permissions.ts).
    if (params?.command && typeof params.command === 'string') {
      checkShellPermission(this.manifest, params.command);
    }

    const callId = nextMsgId('call');
    const post = (msg: ParentToWorkerMsg): void => {
      const w = this.worker;
      if (!w) throw new Error(`Worker de ${this.manifest.id} no disponible`);
      (w as any).postMessage(msg);
    };

    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInvokes.delete(callId);
        const msg = `Timeout ${timeoutMs}ms en ${this.manifest.id}.${actionId}`;
        // Timeout REAL: matar el worker colgado y re-spawnear en background.
        this.markError(msg);
        const old = this.worker;
        this.worker = null;
        try { (old as any)?.terminate(); } catch {}
        this.failAllPendingExcept(callId, new Error(msg));
        reject(new Error(msg));
        this.respawn('timeout').catch(() => {});
      }, timeoutMs);

      this.pendingInvokes.set(callId, { resolve, reject, timer, actionId });
      try {
        post({ kind: 'invoke', callId, actionId, params, context });
      } catch (e) {
        this.pendingInvokes.delete(callId);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    }).then(
      (result) => {
        if (cooldownMs > 0) this.lastExecution.set(actionId, Date.now());
        return result;
      },
      (e) => { throw e; }
    );
  }

  private failAllPending(err: Error): void {
    for (const [id, p] of this.pendingInvokes) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pendingInvokes.delete(id);
    }
  }

  private failAllPendingExcept(exceptId: string, err: Error): void {
    for (const [id, p] of this.pendingInvokes) {
      if (id === exceptId) continue;
      clearTimeout(p.timer);
      p.reject(new Error(`Worker reiniciado: ${err.message}`));
      this.pendingInvokes.delete(id);
    }
  }

  // -- mensajes del worker ------------------------------------------------------

  private handleMessage(msg: WorkerToParentMsg): void {
    switch (msg.kind) {
      case 'ready':
        this.readyReceived = true;
        try {
          (this.worker as any)?.postMessage({ kind: 'init', pluginId: this.manifest.id, mainPath: this.mainPath, apiVersion: PLUGIN_API_VERSION } satisfies ParentToWorkerMsg);
        } catch (e) {
          this.settleStartError(e instanceof Error ? e : new Error(String(e)));
        }
        break;
      case 'register-actions':
        this.settleStartOk(msg.actions);
        break;
      case 'register-error':
        this.settleStartError(new Error(msg.error));
        break;
      case 'invoke-result': {
        const pending = this.pendingInvokes.get(msg.callId);
        if (pending) {
          this.pendingInvokes.delete(msg.callId);
          clearTimeout(pending.timer);
          if (msg.ok) pending.resolve(msg.result);
          else pending.reject(new Error(msg.error ?? 'Error en plugin'));
        }
        break;
      }
      case 'op':
        void this.handleOp(msg.opId, msg.op, msg.args);
        break;
    }
  }

  private settleStartOk(actions: string[]): void {
    if (!this.startSettled) return;
    const s = this.startSettled;
    this.startSettled = null;
    if (this.startTimer) { clearTimeout(this.startTimer); this.startTimer = null; }
    this.status = 'ok';
    this.lastError = null;
    this.registeredActions = [...actions];
    s.resolve(actions);
  }

  private settleStartError(e: Error): void {
    if (!this.startSettled) {
      // Error fuera de handshake (p.ej. register tardío): marcar y seguir.
      this.markError(e.message);
      return;
    }
    const s = this.startSettled;
    this.startSettled = null;
    if (this.startTimer) { clearTimeout(this.startTimer); this.startTimer = null; }
    this.markError(`Registro fallido: ${e.message}`);
    this.killWorker();
    s.reject(new Error(`Plugin ${this.manifest.id} falló al registrarse: ${e.message}`));
  }

  private handleWorkerError(ev: any): void {
    const message = ev?.message ?? ev?.error?.message ?? String(ev ?? 'Worker error');
    // Si estábamos en handshake, falla el start; si no, marca error y rechaza pendientes.
    if (this.startSettled) {
      this.settleStartError(new Error(message));
    } else {
      this.markError(`Worker error: ${message}`);
      this.failAllPending(new Error(`Plugin ${this.manifest.id} falló: ${message}`));
      this.killWorker();
    }
  }

  private async handleOp(opId: string | null, op: WorkerOpName, args: any): Promise<void> {
    const reply = (ok: boolean, result?: any, error?: string): void => {
      if (opId === null) return;
      try {
        (this.worker as any)?.postMessage({ kind: 'op-result', opId, ok, result, error } satisfies ParentToWorkerMsg);
      } catch {}
    };
    try {
      const result = await this.sandbox.runOp(this.manifest, op, args);
      reply(true, result);
    } catch (e) {
      reply(false, undefined, e instanceof Error ? e.message : String(e));
    }
  }

  /** Envía op-result pendientes al cerrar (evita promesas colgadas en el worker). */
  public dispose(): void {
    this.terminate();
    this.pendingOps.clear();
  }
}
