/**
 * Flujos disparados por eventos (variable-changed, timer, integration,
 * calendar, media, client-connected).
 *
 * Un flujo = { id, on: { event, var?, equals?, contains? }, actions: [...] }.
 * Se ejecutan en el ActionRunner en secuencia. Persisten en el setting
 * `automation.flows` (JSON) para sobrevivir reinicios.
 */

import { DatabaseService } from '../db';
import type { ActionDescriptor } from '../action-runner';
import { getEventBus, type EventBus } from '../events/bus';

export interface FlowTrigger {
  /** Canal del bus: variable-changed | integration | timer | calendar | media | client-connected */
  event: string;
  /** Solo variable-changed: nombre de la variable. */
  var?: string;
  /** Solo variable-changed: dispara si el nuevo valor === equals. */
  equals?: unknown;
  /** Solo flows de integración: entity que debe coincidir. */
  entity?: string;
}

export interface Flow {
  id: string;
  name?: string;
  enabled?: boolean;
  on: FlowTrigger;
  actions: ActionDescriptor[];
}

const SETTING_KEY = 'automation.flows';

interface RunnerLike {
  executeAction: (a: any, c: any) => Promise<any>;
}

export class FlowEngine {
  private flows = new Map<string, Flow>();
  private unsubs: Array<() => void> = [];
  private started = false;

  constructor(
    private bus: EventBus = getEventBus(),
    private runner: RunnerLike | null = null,
    private db?: DatabaseService,
  ) {}

  setRunner(runner: RunnerLike | null): void {
    this.runner = runner;
  }

  /** Enganche completo para server.ts: BD + runner, carga y suscribe. */
  attach(db: DatabaseService, runner: RunnerLike): Flow[] {
    this.db = db;
    this.runner = runner;
    this.start();
    return this.load();
  }

  // ---- Persistencia (setting automation.flows) ----

  load(): Flow[] {
    this.flows.clear();
    try {
      const raw = this.db?.getSetting(SETTING_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          for (const f of arr) {
            if (f && typeof f.id === 'string' && f.on && Array.isArray(f.actions)) {
              this.flows.set(f.id, { enabled: true, ...f });
            }
          }
        }
      }
    } catch { /* setting corrupto: se empieza vacío */ }
    return this.list();
  }

  save(): void {
    try {
      this.db?.setSetting(SETTING_KEY, JSON.stringify([...this.flows.values()]));
    } catch { /* mejor esfuerzo */ }
  }

  list(): Flow[] {
    return [...this.flows.values()];
  }

  upsert(flow: Flow): Flow {
    if (!flow || typeof flow.id !== 'string' || !flow.id) throw new Error('Flow sin id');
    if (!flow.on || typeof flow.on.event !== 'string') throw new Error('Flow sin trigger (on.event)');
    if (!Array.isArray(flow.actions)) throw new Error('Flow sin actions[]');
    const full: Flow = { enabled: true, ...flow };
    this.flows.set(full.id, full);
    this.save();
    return full;
  }

  remove(id: string): boolean {
    const ok = this.flows.delete(id);
    if (ok) this.save();
    return ok;
  }

  clear(): void {
    this.flows.clear();
    this.save();
  }

  // ---- Suscripción al bus ----

  start(): void {
    if (this.started) return;
    this.started = true;
    const events = ['variable-changed', 'integration', 'timer', 'calendar', 'media', 'client-connected'];
    for (const e of events) {
      this.unsubs.push(this.bus.on(e, (payload) => { void this.dispatch(e, payload); }));
    }
  }

  stop(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.started = false;
  }

  private matches(flow: Flow, event: string, payload: any): boolean {
    if (flow.enabled === false) return false;
    if (flow.on.event !== event) return false;
    if (event === 'variable-changed') {
      if (flow.on.var !== undefined && payload?.name !== flow.on.var) return false;
      if (flow.on.equals !== undefined && payload?.value !== flow.on.equals) return false;
    }
    if ((event === 'integration' || event === 'calendar' || event === 'media') && flow.on.entity !== undefined) {
      const entity = payload?.entity ?? payload?.integration ?? payload?.player;
      if (entity !== flow.on.entity) return false;
    }
    return true;
  }

  private async dispatch(event: string, payload: any): Promise<void> {
    if (!this.runner) return;
    for (const flow of this.flows.values()) {
      if (!this.matches(flow, event, payload)) continue;
      const ctx = {
        buttonId: undefined,
        timestamp: Date.now(),
        trigger: event,
        flowId: flow.id,
        event: payload,
      };
      for (const action of flow.actions) {
        try {
          const result = await this.runner.executeAction(action, ctx);
          this.bus.emit('flow.executed', {
            flowId: flow.id, event, action: action.type, success: result.success,
          });
          if (!result.success) break;
        } catch (e) {
          this.bus.emit('flow.executed', {
            flowId: flow.id, event, action: action.type, success: false,
            error: e instanceof Error ? e.message : String(e),
          });
          break;
        }
      }
    }
  }
}

let shared: FlowEngine | null = null;

export function getFlowEngine(): FlowEngine {
  if (!shared) shared = new FlowEngine();
  return shared;
}

export function resetFlowEngine(): FlowEngine {
  if (shared) shared.stop();
  shared = new FlowEngine();
  return shared;
}
