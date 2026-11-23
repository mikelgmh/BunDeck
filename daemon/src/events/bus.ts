/**
 * Bus interno de eventos del daemon.
 *
 * Canales: variable-changed | integration | timer | calendar | media |
 * client-connected (+ cualquier canal personalizado). Los suscriptores
 * disparan flujos (automation/flows.ts); server.ts lo puentea a WS.
 */

export type BusEventType =
  | 'variable-changed'
  | 'integration'
  | 'timer'
  | 'calendar'
  | 'media'
  | 'client-connected';

export interface VariableChangedPayload {
  name: string;
  scope: string;
  scopeId: string;
  value: unknown;
  previous: unknown;
  unavailable: boolean;
  source?: string;
  ts: number;
}

export interface IntegrationPayload {
  integration: string;
  entity?: string;
  state?: unknown;
  attributes?: Record<string, any>;
  ts: number;
}

export interface TimerPayload {
  tick: number;
  every?: number;
  label?: string;
  ts: number;
}

export interface CalendarPayload {
  kind: 'event-start' | 'event-end' | 'reminder' | 'sync';
  title?: string;
  start?: string;
  end?: string;
  meta?: Record<string, any>;
  ts: number;
}

export interface MediaPayload {
  kind: 'play' | 'pause' | 'track' | 'volume' | 'state';
  player?: string;
  title?: string;
  state?: unknown;
  ts: number;
}

export interface ClientConnectedPayload {
  clientId: string;
  via?: string;
  ts: number;
}

export type BusListener = (payload: any) => void | Promise<void>;

const WILDCARD = '*';

export class EventBus {
  private listeners = new Map<string, Set<BusListener>>();
  private history: Array<{ type: string; payload: any; ts: number }> = [];
  private timerHandle: ReturnType<typeof setInterval> | null = null;
  private tick = 0;

  on(type: string, listener: BusListener): () => void {
    let set = this.listeners.get(type);
    if (!set) { set = new Set(); this.listeners.set(type, set); }
    set.add(listener);
    return () => this.off(type, listener);
  }

  once(type: string, listener: BusListener): () => void {
    const wrap: BusListener = (p) => { this.off(type, wrap); return listener(p); };
    return this.on(type, wrap);
  }

  off(type: string, listener: BusListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type?: string): number {
    if (type) return this.listeners.get(type)?.size ?? 0;
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }

  emit(type: string, payload: any = {}): void {
    const withTs = payload && typeof payload === 'object' && !Array.isArray(payload) && !('ts' in payload)
      ? { ...payload, ts: Date.now() }
      : payload;
    this.history.push({ type, payload: withTs, ts: Date.now() });
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
    const targets: BusListener[] = [
      ... (this.listeners.get(type) ?? []),
      ... (this.listeners.get(WILDCARD) ?? []),
    ];
    for (const fn of targets) {
      try {
        const r = fn(withTs);
        if (r && typeof (r as any).catch === 'function') (r as Promise<void>).catch((e) => console.error(`[bus] listener ${type}:`, e));
      } catch (e) {
        console.error(`[bus] listener ${type}:`, e);
      }
    }
  }

  /** Últimos eventos (debug / tests). */
  recent(type?: string, limit: number = 20): Array<{ type: string; payload: any; ts: number }> {
    const h = type ? this.history.filter((e) => e.type === type) : this.history;
    return h.slice(-limit);
  }

  /** Espera un evento (tests/automatizaciones). Rechaza por timeout. */
  waitFor(type: string, predicate?: (p: any) => boolean, timeoutMs: number = 2000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(type, handler);
        reject(new Error(`Timeout esperando evento ${type}`));
      }, timeoutMs);
      const handler = (p: any) => {
        if (!predicate || predicate(p)) {
          clearTimeout(timer);
          this.off(type, handler);
          resolve(p);
        }
      };
      this.on(type, handler);
    });
  }

  /** Ticker interno de 1 s: emite `timer` (integración/timer). */
  startTimer(intervalMs: number = 1000): void {
    if (this.timerHandle) return;
    this.timerHandle = setInterval(() => {
      this.tick++;
      this.emit('timer', { tick: this.tick, every: intervalMs, ts: Date.now() });
    }, intervalMs);
    if (typeof (this.timerHandle as any)?.unref === 'function') (this.timerHandle as any).unref();
  }

  stopTimer(): void {
    if (this.timerHandle) clearInterval(this.timerHandle);
    this.timerHandle = null;
  }

  clear(): void {
    this.listeners.clear();
    this.history = [];
  }
}

let shared: EventBus | null = null;

/** Singleton del daemon (inyectable en tests con resetEventBus). */
export function getEventBus(): EventBus {
  if (!shared) shared = new EventBus();
  return shared;
}

export function resetEventBus(): EventBus {
  if (shared) shared.clear();
  shared = new EventBus();
  return shared;
}

/** Emisores con tipo para integraciones (calendario/media/timer/cliente). */
export function emitIntegration(bus: EventBus, p: Omit<IntegrationPayload, 'ts'>): void {
  bus.emit('integration', { ...p });
}
export function emitCalendar(bus: EventBus, p: Omit<CalendarPayload, 'ts'>): void {
  bus.emit('calendar', { ...p });
}
export function emitMedia(bus: EventBus, p: Omit<MediaPayload, 'ts'>): void {
  bus.emit('media', { ...p });
}
export function emitClientConnected(bus: EventBus, p: Omit<ClientConnectedPayload, 'ts'>): void {
  bus.emit('client-connected', { ...p });
}

/**
 * Mapeo bus interno → WS (lo usa WebSocketManager.attachEventBus):
 * variable-changed → `variable.changed` (topic `variables`); el resto →
 * `event.*` / `flow.executed` (topic `events`).
 */
export const BUS_WS_FORWARD: Record<string, string> = {
  'variable-changed': 'variable.changed',
  integration: 'event.integration',
  timer: 'event.timer',
  calendar: 'event.calendar',
  media: 'event.media',
  'flow.executed': 'flow.executed',
};

export function busWsTopic(type: string): string {
  return type === 'variable-changed' ? 'variables' : 'events';
}
