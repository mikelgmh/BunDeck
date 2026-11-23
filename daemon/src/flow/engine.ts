/**
 * Motor de ejecución de flujos (daemon).
 *
 * Semántica espejo de `web/src/composables/useKeyEngine.ts` para que web y
 * HW se comporten igual; el daemon además persiste, soporta timeout real,
 * cancelación, scripts con ámbito propio y ejecución en paralelo.
 */
import { v4 as uuidv4 } from 'uuid';
import { baseEnv, ev, evb, intp, resolveNum, type Env } from './expressions';
import { normalizeNodes, type FlowContext, type FlowNode, type FlowScript, type FlowVar } from './types';

export interface LeafResult {
  success: boolean;
  result?: any;
  error?: string;
}

export interface EngineDeps {
  /** Ejecuta una acción hoja (ActionRunner.executeAction). */
  executeAction: (action: { type: string; parameters?: Record<string, any>; timeout?: number }, ctx: FlowContext) => Promise<LeafResult & { duration?: number }>;
  getVar(name: string): FlowVar | undefined;
  /** Devuelve true si el valor cambió. */
  setVar(name: string, value: any): boolean;
  getScript(id: string): FlowScript | null | undefined;
  log(level: string, message: string, meta?: any): void;
  /** Difusión WS (best-effort). */
  emit(event: string, payload: any): void;
  /** Allowlist opcional (p. ej. remoto): si devuelve false, el leaf se deniega. */
  canExecute?(type: string): boolean;
  /** Lista completa de variables globales (para el entorno de expresiones). */
  listVars?(): FlowVar[];
}

export interface ExecuteOptions {
  /** Id de ejecución preasignado (para el registro persistente de runs). */
  runId?: string;
  /** Etiqueta para logs/runs (p. ej. `button:<id>:short`). */
  runLabel?: string;
  /** Timeout global en ms (defecto 30000, 0 = sin límite). */
  timeout?: number;
  /** Allowlist de hojas (p. ej. remoto). Gana a `deps.canExecute`. */
  canExecute?: (type: string) => boolean;
  /** Señal externa de cancelación. */
  signal?: { cancelled: boolean };
  /** Profundidad inicial (scripts anidados). */
  depth?: number;
  /** Ámbito local previo (llamadas a script anidadas). */
  parentScope?: Record<string, any>;
  /** Variables globales extra para este run (p. ej. inputs). */
  extraEnv?: Record<string, any>;
}

export interface FlowExecResult {
  success: boolean;
  runId: string;
  cancelled: boolean;
  results: Array<{ index: number; kind: string; type?: string; success: boolean; result?: any; error?: string }>;
  error?: string;
  duration: number;
}

interface RunState {
  cancelled: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  /** Hooks que rechazan promesas pendientes (sleeps) al cancelar. */
  cancelHooks: Set<() => void>;
  canExecute?: (type: string) => boolean;
}

const MAX_DEPTH = 8;
const MAX_REPEAT = 1000;
const DEFAULT_TIMEOUT = 30000;

export class FlowEngine {
  private deps: EngineDeps;
  private runs = new Map<string, RunState>();
  /** Snapshot de vars globales por run activo (Fase C+D, ver execute()). */
  private snaps = new Map<string, Map<string, any>>();

  constructor(deps: EngineDeps) {
    this.deps = deps;
  }

  getRunning(): string[] {
    return [...this.runs.keys()];
  }

  isRunning(runId: string): boolean {
    return this.runs.has(runId);
  }

  cancel(runId: string): boolean {
    const st = this.runs.get(runId);
    if (!st) return false;
    st.cancelled = true;
    for (const t of st.timers) clearTimeout(t);
    st.timers.clear();
    // Rechazar sleeps pendientes para que el execute no quede colgado.
    for (const hook of [...st.cancelHooks]) {
      try { hook(); } catch { /* noop */ }
    }
    st.cancelHooks.clear();
    return true;
  }

  async execute(nodes: FlowNode[] | FlowNode, ctx: FlowContext, opts: ExecuteOptions = {}): Promise<FlowExecResult> {
    const runId = opts.runId ?? uuidv4();
    const state: RunState = { cancelled: false, timers: new Set(), cancelHooks: new Set(), canExecute: opts.canExecute ?? this.deps.canExecute };
    this.runs.set(runId, state);
    const start = Date.now();
    const list = normalizeNodes(nodes);
    const label = opts.runLabel ?? 'flow';
    const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT;
    const scope: Record<string, any> = { ...(opts.parentScope ?? {}) };
    // Fase C+D: snapshot de variables globales UNA vez por ejecución.
    // Antes cada env() hacía listVars() (SELECT * FROM flow_vars) → N nodos
    // × M evaluaciones de DB. El snapshot se mantiene coherente dentro del
    // run con write-through en writeVar(); escrituras externas concurrentes
    // no se ven a mitad de run (semántica de snapshot, más consistente).
    const varsSnap = new Map<string, any>();
    try {
      const listVars = this.deps.listVars?.();
      if (Array.isArray(listVars)) for (const v of listVars) varsSnap.set(v.name, v.value);
    } catch { /* solo scope */ }
    this.snaps.set(runId, varsSnap);

    this.deps.log('info', `Flow started: ${label}`, { runId, ctx });
    this.deps.emit('flow.started', { runId, label, context: ctx, timestamp: start });

    let cancelled = false;
    const checkCancel = () => {
      if (state.cancelled || opts.signal?.cancelled) {
        cancelled = true;
        throw new Error('Flow cancelled');
      }
    };

    const execPromise = (async (): Promise<FlowExecResult['results']> => {
      const results: FlowExecResult['results'] = [];
      const env = () => this.buildEnv(ctx, scope, varsSnap, opts.extraEnv);
      let idx = 0;
      for (const node of list) {
        checkCancel();
        const r = await this.execNode(node, ctx, scope, env, state, checkCancel, opts.depth ?? 0, runId, true);
        results.push({ index: idx++, ...r });
        if (!r.success && (node as any).continueOnError !== true && node.kind !== 'if' && node.kind !== 'switch') {
          // Los bloques if/switch/repeat ya agregan su resultado consolidado;
          // un leaf con error detiene la secuencia salvo continueOnError.
          if (node.kind === 'action' || node.kind === 'script' || node.kind === 'sequence' || node.kind === 'wait' || node.kind === 'set-var' || node.kind === 'toggle-var' || node.kind === 'log') {
            break;
          }
        }
      }
      return results;
    })();

    try {
      const results = timeoutMs > 0
        ? await this.withTimeout(execPromise, timeoutMs, `Flow timeout (${timeoutMs}ms)`, state)
        : await execPromise;
      const success = results.every((r) => r.success);
      const duration = Date.now() - start;
      this.deps.log(success ? 'info' : 'error', `Flow ${success ? 'finished' : 'failed'}: ${label}`, { runId, duration });
      this.deps.emit(success ? 'flow.finished' : 'flow.error', { runId, label, results, duration, timestamp: Date.now() });
      return { success, runId, cancelled: false, results, duration };
    } catch (error) {
      const duration = Date.now() - start;
      const message = error instanceof Error ? error.message : 'Unknown error';
      const wasCancel = cancelled || /cancelled/i.test(message);
      this.deps.log(wasCancel ? 'info' : 'error', `Flow ${wasCancel ? 'cancelled' : 'error'}: ${label} - ${message}`, { runId, duration });
      this.deps.emit(wasCancel ? 'flow.finished' : 'flow.error', { runId, label, cancelled: wasCancel, error: message, duration, timestamp: Date.now() });
      return { success: false, runId, cancelled: wasCancel, results: [], error: message, duration };
    } finally {
      for (const t of state.timers) clearTimeout(t);
      state.timers.clear();
      this.runs.delete(runId);
      this.snaps.delete(runId);
    }
  }

  // ---- Nodos ----

  private async execNode(
    node: FlowNode, ctx: FlowContext, scope: Record<string, any>,
    env: () => Env, state: RunState, checkCancel: () => void, depth: number, runId: string,
    isTop = false,
  ): Promise<{ kind: string; type?: string; success: boolean; result?: any; error?: string }> {
    if (depth > MAX_DEPTH) throw new Error('Profundidad máxima de flujo superada (posible recursión)');
    switch (node.kind) {
      case 'action': return this.execAction(node, ctx, env, state, runId);
      case 'wait': {
        const E = env();
        const ms = Math.min(Math.max(0, resolveNum((node as any).ms, E, 0)), 120000);
        await this.sleep(ms, state);
        checkCancel();
        return { kind: 'wait', success: true, result: { waitedMs: ms } };
      }
      case 'if': {
        const condSrc = (node.cond ?? '').trim();
        const E = env();
        let ok = true;
        try { ok = !condSrc || !!ev(condSrc, E); }
        catch (e) { throw new Error(`Condición inválida «${node.cond}»: ${(e as Error).message}`); }
        const branch = ok ? node.then : (node.else ?? []);
        const sub: Array<FlowExecResult['results'][number]> = [];
        let i = 0;
        for (const n of normalizeNodes(branch)) {
          checkCancel();
          const r = await this.execNode(n, ctx, scope, env, state, checkCancel, depth + 1, runId, isTop);
          sub.push({ index: i++, ...r });
          if (!r.success && (n as any).continueOnError !== true && (n.kind === 'action' || n.kind === 'script' || n.kind === 'sequence' || n.kind === 'wait')) break;
        }
        const success = sub.every((r) => r.success);
        return { kind: 'if', success, result: { cond: node.cond, taken: ok ? 'then' : 'else', results: sub } };
      }
      case 'switch': {
        const E = env();
        let key: any;
        try { key = ev(node.expr ?? '', E); }
        catch (e) { throw new Error(`Expresión switch inválida «${node.expr}»: ${(e as Error).message}`); }
        let branch: FlowNode[] | null = null;
        for (const c of node.cases ?? []) {
          if (c.cond !== undefined && String(c.cond).trim() !== '') {
            let hit = false;
            try { hit = !!ev(String(c.cond), E); } catch { hit = false; }
            if (hit) { branch = normalizeNodes(c.nodes); break; }
          } else if (c.value !== undefined) {
            // eslint-disable-next-line eqeqeq
            if (key == c.value) { branch = normalizeNodes(c.nodes); break; }
          }
        }
        branch ??= normalizeNodes(node.default ?? []);
        const sub: Array<FlowExecResult['results'][number]> = [];
        let i = 0;
        for (const n of branch) {
          checkCancel();
          const r = await this.execNode(n, ctx, scope, env, state, checkCancel, depth + 1, runId, isTop);
          sub.push({ index: i++, ...r });
          if (!r.success && (n as any).continueOnError !== true && (n.kind === 'action' || n.kind === 'script' || n.kind === 'sequence' || n.kind === 'wait')) break;
        }
        return { kind: 'switch', success: sub.every((r) => r.success), result: { expr: node.expr, key, results: sub } };
      }
      case 'repeat': {
        const E0 = env();
        const delayMs = Math.min(Math.max(0, resolveNum((node as any).delayMs ?? 0, E0, 0)), 60000);
        const inner = normalizeNodes(node.nodes);
        const sub: Array<FlowExecResult['results'][number]> = [];
        let i = 0;
        if (node.count !== undefined) {
          const count = Math.min(Math.max(0, Math.floor(resolveNum(node.count, E0, 0))), MAX_REPEAT);
          for (let k = 0; k < count; k++) {
            checkCancel();
            scope.iteration = k;
            for (const n of inner) {
              checkCancel();
              const r = await this.execNode(n, ctx, scope, env, state, checkCancel, depth + 1, runId, isTop);
              sub.push({ index: i++, ...r });
              if (!r.success && (n as any).continueOnError !== true && (n.kind === 'action' || n.kind === 'script')) break;
            }
            if (delayMs) await this.sleep(delayMs, state);
          }
          delete scope.iteration;
        } else if (node.while && node.while.trim()) {
          let guard = 0;
          for (;;) {
            checkCancel();
            if (guard++ >= MAX_REPEAT) throw new Error('Repeat: límite de 1000 iteraciones superado');
            let cond = false;
            try { cond = !!ev(node.while, env()); } catch (e) { throw new Error(`Condición repeat inválida: ${(e as Error).message}`); }
            if (!cond) break;
            scope.iteration = guard - 1;
            for (const n of inner) {
              checkCancel();
              const r = await this.execNode(n, ctx, scope, env, state, checkCancel, depth + 1, runId, isTop);
              sub.push({ index: i++, ...r });
              if (!r.success && (n as any).continueOnError !== true && (n.kind === 'action' || n.kind === 'script')) break;
            }
            if (delayMs) await this.sleep(delayMs, state);
          }
          delete scope.iteration;
        }
        return { kind: 'repeat', success: sub.every((r) => r.success), result: { executed: i, results: sub } };
      }
      case 'parallel': {
        const branches = node.branches ?? [];
        const settled = await Promise.all(branches.map(async (b, bi) => {
          const sub: Array<FlowExecResult['results'][number]> = [];
          let i = 0;
          for (const n of normalizeNodes(b)) {
            checkCancel();
            const r = await this.execNode(n, ctx, scope, env, state, checkCancel, depth + 1, runId, isTop);
            sub.push({ index: i++, ...r });
            if (!r.success && (n as any).continueOnError !== true && (n.kind === 'action' || n.kind === 'script')) break;
          }
          return { branch: bi, results: sub };
        }));
        const success = settled.every((b) => b.results.every((r) => r.success));
        return { kind: 'parallel', success, result: { branches: settled } };
      }
      case 'set-var': {
        const name = String(node.name ?? '').trim();
        if (!name) throw new Error('set-var sin nombre de variable');
        let value: any;
        try { value = ev(String(node.expr ?? ''), env()); }
        catch (e) { throw new Error(`Expresión set-var inválida: ${(e as Error).message}`); }
        this.writeVar(name, value, scope, false, isTop, runId);
        return { kind: 'set-var', success: true, result: { name, value } };
      }
      case 'toggle-var': {
        const name = String(node.name ?? '').trim();
        if (!name) throw new Error('toggle-var sin nombre de variable');
        const cur = this.readVar(name, scope, runId);
        const next = typeof cur === 'boolean' ? !cur : typeof cur === 'number' ? (cur ? 0 : 1) : cur ? '' : 'sí';
        this.writeVar(name, next, scope, false, isTop, runId);
        return { kind: 'toggle-var', success: true, result: { name, value: next } };
      }
      case 'log': {
        this.deps.log(node.level ?? 'info', intp(node.message ?? '', env()), { runId, flow: true });
        return { kind: 'log', success: true };
      }
      case 'script': {
        const script = this.deps.getScript(node.scriptId);
        if (!script) throw new Error(`Script no encontrado: ${node.scriptId}`);
        const childScope: Record<string, any> = { ...scope };
        const inputs = node.inputs ?? {};
        for (const k of script.inputs ?? []) {
          if (k in inputs) childScope[k] = inputs[k];
        }
        // Inputs extra no declarados también pasan (compatibilidad).
        for (const [k, v] of Object.entries(inputs)) {
          if (!(k in childScope)) childScope[k] = typeof v === 'string' ? intp(v, env()) : v;
        }
        const childEnv = () => this.buildEnv(ctx, { ...opts_extraEnv(env), ...childScope }, this.snaps.get(runId));
        const sub: Array<FlowExecResult['results'][number]> = [];
        let i = 0;
        for (const n of normalizeNodes(script.nodes)) {
          checkCancel();
          const r = await this.execNode(n, ctx, childScope, childEnv, state, checkCancel, depth + 1, runId, false);
          sub.push({ index: i++, ...r });
          if (!r.success && (n as any).continueOnError !== true && (n.kind === 'action' || n.kind === 'script' || n.kind === 'sequence' || n.kind === 'wait')) break;
        }
        const success = sub.every((r) => r.success);
        if (node.outputVar) {
          const out = node.outputVar in childScope ? childScope[node.outputVar] : (sub.length ? sub[sub.length - 1].result : undefined);
          // outputVar siempre vuelve al global: es el valor de retorno.
          this.writeVar(node.outputVar, out, scope, true, isTop, runId);
        }
        return { kind: 'script', type: node.scriptId, success, result: { scriptId: node.scriptId, results: sub } };
      }
      case 'sequence': {
        const sub: Array<FlowExecResult['results'][number]> = [];
        let i = 0;
        for (const n of normalizeNodes(node.nodes)) {
          checkCancel();
          const r = await this.execNode(n, ctx, scope, env, state, checkCancel, depth + 1, runId, isTop);
          sub.push({ index: i++, ...r });
          if (!r.success && (n as any).continueOnError !== true && (n.kind === 'action' || n.kind === 'script' || n.kind === 'sequence' || n.kind === 'wait')) break;
        }
        return { kind: 'sequence', success: sub.every((r) => r.success), result: { results: sub } };
      }
      default:
        throw new Error(`Nodo de flujo desconocido: ${(node as any).kind}`);
    }
  }

  private async execAction(
    node: Extract<FlowNode, { kind: 'action' }>, ctx: FlowContext, env: () => Env, state: RunState, runId: string,
  ): Promise<{ kind: string; type?: string; success: boolean; result?: any; error?: string }> {
    const type = String(node.type ?? '');
    if (!type) throw new Error('Acción sin type');
    const canExecute = state.canExecute ?? this.deps.canExecute;
    if (canExecute && !canExecute(type)) {
      throw new Error(`Acción no permitida: ${type}`);
    }
    if (node.delayMs && node.delayMs > 0) {
      await this.sleep(Math.min(node.delayMs, 60000), state);
    }
    const E = env();
    const rawParams = node.parameters ?? {};
    const parameters: Record<string, any> = {};
    for (const [k, v] of Object.entries(rawParams)) {
      if ((k === 'pageId' || k === 'page_id') && typeof v === 'string') { parameters[k] = v; continue; }
      parameters[k] = typeof v === 'string' ? intp(v, E) : v;
    }
    this.deps.emit('action.started', { actionId: `${runId}:${type}`, action: { type, parameters }, context: ctx, timestamp: Date.now() });
    try {
      const invocation: any = { type, parameters };
      if (typeof node.timeout === 'number') invocation.timeout = node.timeout;      const raw = await this.deps.executeAction(invocation, ctx);
      if (raw && typeof raw === 'object' && 'success' in raw && !(raw as any).success) {
        const err = (raw as any).error ?? 'Unknown error';
        this.deps.emit('action.error', { actionId: `${runId}:${type}`, error: err, timestamp: Date.now() });
        if (node.continueOnError) return { kind: 'action', type, success: true, result: { continuedAfterError: err } };
        return { kind: 'action', type, success: false, error: err };
      }
      this.deps.emit('action.finished', { actionId: `${runId}:${type}`, result: raw, timestamp: Date.now() });
      const waitMs = Math.min(Math.max(0, resolveNum((node as any).waitMs ?? 0, E, 0)), 10000);
      if (waitMs) await this.sleep(waitMs, state);
      return { kind: 'action', type, success: true, result: (raw as any)?.result ?? raw };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.deps.emit('action.error', { actionId: `${runId}:${type}`, error: message, timestamp: Date.now() });
      if (node.continueOnError) return { kind: 'action', type, success: true, result: { continuedAfterError: message } };
      return { kind: 'action', type, success: false, error: message };
    }
  }

  // ---- Ámbito / variables ----

  private buildEnv(ctx: FlowContext, scope: Record<string, any>, snap?: Map<string, any> | null, extra?: Record<string, any>): Env {
    const globals: Array<{ n: string; v: any }> = [];
    try {
      if (snap) {
        for (const [n, v] of snap) globals.push({ n, v });
      } else {
        const list = this.deps.listVars?.();
        if (Array.isArray(list)) for (const v of list) globals.push({ n: v.name, v: v.value });
      }
    } catch { /* solo scope */ }
    const base = baseEnv(globals, String((ctx as any).profileName ?? ctx.profileId ?? ''), String((ctx as any).pageName ?? ctx.pageId ?? ''));
    return {
      ...base,
      ...scope,
      ...(extra ?? {}),
      pressType: ctx.pressType ?? ctx.trigger ?? 'short',
      trigger: ctx.trigger ?? ctx.pressType ?? 'short',
      buttonId: ctx.buttonId ?? null,
      pageId: ctx.pageId ?? null,
      profileId: ctx.profileId ?? null,
      position: ctx.position ?? null,
    };
  }

  private readVar(name: string, scope: Record<string, any>, runId?: string): any {
    if (name in scope) return scope[name];
    if (runId) {
      const snap = this.snaps.get(runId);
      if (snap?.has(name)) return snap.get(name);
    }
    return this.deps.getVar(name)?.value;
  }

  private writeVar(name: string, value: any, scope: Record<string, any>, forceGlobal = false, isTop = false, runId?: string): void {
    // En el nivel superior (flujo/automatización) un nombre nuevo crea la
    // global (coherente con la UI); dentro de un script queda en el ámbito
    // local (variables propias). outputVar siempre vuelve al global.
    if (forceGlobal || isTop || this.deps.getVar(name) !== undefined) {
      this.deps.setVar(name, value);
      // Write-through al snapshot: el resto del run ve el valor sin otra query.
      if (runId) this.snaps.get(runId)?.set(name, value);
    } else {
      scope[name] = value;
    }
  }

  private sleep(ms: number, state: RunState): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onCancel = () => {
        clearTimeout(t);
        state.cancelHooks.delete(onCancel);
        reject(new Error('Flow cancelled'));
      };
      const t = setTimeout(() => {
        state.timers.delete(t);
        state.cancelHooks.delete(onCancel);
        if (state.cancelled) reject(new Error('Flow cancelled'));
        else resolve();
      }, ms);
      state.timers.add(t);
      state.cancelHooks.add(onCancel);
    });
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, message: string, state: RunState): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        state.cancelled = true;
        reject(new Error(message));
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    }) as Promise<T>;
  }
}

/** Env extra derivado del env actual (para llamadas a script anidadas). */
function opts_extraEnv(env: () => Env): Record<string, any> {
  try { return { ...env() }; } catch { return {}; }
}
