/**
 * Gestor de automatizaciones globales: eventos, timers y cambios de variable.
 *
 * - `timer`: un setInterval por automatización (unref, no bloquea la salida).
 * - `var`: se evalúa vía `handleVariableChange(name)`.
 * - `event`: se evalúa vía `handleEvent(event, payload)`.
 * - `load`: se evalúa vía `handlePageLoad(pageId)` (página abierta).
 *
 * Además sincroniza las reglas de botón `load`/`timer`/`var` (KeyInspector)
 * como automatizaciones con scope, para que funcionen con la UI cerrada.
 */
import type { Automation, FlowContext, FlowNode } from './types';
import { buttonDataToAutomations } from './migrate';

export interface AutomationRunner {
  execute(nodes: FlowNode[], ctx: FlowContext, opts?: { runLabel?: string; timeout?: number }): Promise<{ success: boolean; error?: string }>;
  log(level: string, message: string, meta?: any): void;
  emit(event: string, payload: any): void;
  getButtonsByPage?(pageId: string): Array<{ id: string; page_id: string; position: number; data: any }>;
  listPages?(): Array<{ id: string; profile_id: string }>;
}

interface TimerEntry {
  timer: ReturnType<typeof setInterval>;
  automationId: string;
}

const BUTTON_AUTO_PREFIX = 'btn:';

export class AutomationManager {
  private runner: AutomationRunner;
  private timers = new Map<string, TimerEntry>();
  private buttonAutos: Automation[] = [];

  constructor(runner: AutomationRunner) {
    this.runner = runner;
  }

  /** Arranca timers de automatizaciones globales (llamar tras init). */
  startGlobal(automations: Automation[]): void {
    for (const a of automations) {
      if (!a || a.enabled === false) continue;
      if (a.trigger?.kind === 'timer') this.startTimer(a);
    }
  }

  /** (Re)sincroniza reglas load/timer/var de teclas como automatizaciones. */
  syncButtons(
    buttons: Array<{ id: string; page_id: string; position: number; data: any }>,
  ): void {
    // Parar timers de botón anteriores.
    for (const [key, entry] of [...this.timers.entries()]) {
      if (entry.automationId.startsWith(BUTTON_AUTO_PREFIX)) {
        clearInterval(entry.timer);
        this.timers.delete(key);
      }
    }
    this.buttonAutos = [];
    for (const b of buttons ?? []) {
      let rules: Array<{ when: string; node: FlowNode; everySec?: number; varName?: string }>;
      try {
        rules = buttonDataToAutomations(b.data, { buttonId: b.id, pageId: b.page_id, position: b.position });
      } catch { continue; }
      for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        const auto: Automation = {
          id: `${BUTTON_AUTO_PREFIX}${b.id}:${r.when}:${i}`,
          name: `Tecla ${b.position} (${r.when})`,
          enabled: true,
          trigger: r.when === 'timer'
            ? { kind: 'timer', everySec: r.everySec ?? 5 }
            : r.when === 'var'
              ? { kind: 'var', varName: r.varName ?? '' }
              : { kind: 'load' },
          nodes: [r.node],
          scope: { buttonId: b.id, pageId: b.page_id, position: b.position },
          created_at: Date.now(),
          updated_at: Date.now(),
        };
        this.buttonAutos.push(auto);
        if (r.when === 'timer') this.startTimer(auto);
      }
    }
  }

  stopAll(): void {
    for (const [, entry] of this.timers) clearInterval(entry.timer);
    this.timers.clear();
  }

  /** Releer globales (tras CRUD): para timers viejos y arranca de nuevo. */
  reload(automations: Automation[]): void {
    for (const [key, entry] of [...this.timers.entries()]) {
      if (!entry.automationId.startsWith(BUTTON_AUTO_PREFIX)) {
        clearInterval(entry.timer);
        this.timers.delete(key);
      }
    }
    this.startGlobal(automations);
  }

  handleVariableChange(varName: string, automations: Automation[]): void {
    const all = [...automations, ...this.buttonAutos];
    for (const a of all) {
      if (!a || a.enabled === false) continue;
      if (a.trigger?.kind === 'var' && (a.trigger as any).varName === varName) {
        void this.fire(a, { trigger: 'var', varName, timestamp: Date.now() });
      }
    }
  }

  handleEvent(event: string, payload: any, automations: Automation[]): void {
    for (const a of automations ?? []) {
      if (!a || a.enabled === false) continue;
      if (a.trigger?.kind === 'event' && (a.trigger as any).event === event) {
        void this.fire(a, { trigger: `event:${event}`, timestamp: Date.now(), ...(payload ?? {}) });
      }
    }
  }

  handlePageLoad(pageId: string, globals: Automation[] = []): void {
    for (const a of this.buttonAutos) {
      if (a.trigger?.kind !== 'load') continue;
      if (a.scope?.pageId && a.scope.pageId !== pageId) continue;
      void this.fire(a, { trigger: 'load', pageId, buttonId: a.scope?.buttonId, position: a.scope?.position, timestamp: Date.now() });
    }
    for (const a of globals ?? []) {
      if (!a || a.enabled === false) continue;
      if (a.trigger?.kind === 'load') {
        void this.fire(a, { trigger: 'load', pageId, timestamp: Date.now() });
      }
    }
  }

  private startTimer(a: Automation): void {
    const everySec = Math.max(1, Math.round(Number((a.trigger as any)?.everySec) || 5));
    if (this.timers.has(a.id)) return;
    const timer = setInterval(() => {
      void this.fire(a, {
        trigger: 'timer',
        pageId: a.scope?.pageId,
        buttonId: a.scope?.buttonId,
        position: a.scope?.position,
        timestamp: Date.now(),
      });
    }, everySec * 1000);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    this.timers.set(a.id, { timer, automationId: a.id });
  }

  private async fire(a: Automation, ctx: FlowContext): Promise<void> {
    try {
      this.runner.emit('automation.triggered', { automationId: a.id, name: a.name, trigger: a.trigger, timestamp: Date.now() });
      const nodes = a.scriptId ? [{ kind: 'script', scriptId: a.scriptId, inputs: a.inputs } as FlowNode] : (a.nodes ?? []);
      const r = await this.runner.execute(nodes, ctx, { runLabel: `automation:${a.id}` });
      if (!r.success) {
        this.runner.log('error', `Automatización fallida: ${a.name}`, { automationId: a.id, error: (r as any).error });
      }
    } catch (error) {
      this.runner.log('error', `Automatización error: ${a.name} - ${error instanceof Error ? error.message : error}`, { automationId: a.id });
    }
  }
}
