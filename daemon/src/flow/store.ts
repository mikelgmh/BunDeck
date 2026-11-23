/**
 * Persistencia de flujos/automatizaciones/variables/ejecuciones.
 *
 * Usa los métodos de `DatabaseService` (tablas `flow_scripts`,
 * `flow_automations`, `flow_vars`, `flow_runs` creadas por la migración 6)
 * cuando existen.
 * Si el servicio no los expone (p. ej. mocks de tests antiguos), cae a un
 * almacenamiento en memoria para no romper nada.
 */
import type { Automation, FlowRun, FlowRunStatus, FlowScript, FlowVar } from './types';

export interface FlowStoreAdapter {
  listFlowScripts(): FlowScript[];
  getFlowScript(id: string): FlowScript | null;
  saveFlowScript(s: FlowScript): void;
  deleteFlowScript(id: string): void;
  listFlowAutomations(): Automation[];
  getFlowAutomation(id: string): Automation | null;
  saveFlowAutomation(a: Automation): void;
  deleteFlowAutomation(id: string): void;
  listFlowVars(): FlowVar[];
  getFlowVar(name: string): FlowVar | null;
  setFlowVar(v: FlowVar): void;
  deleteFlowVar(name: string): void;
  createFlowRun(r: FlowRun): void;
  updateFlowRun(id: string, patch: Partial<FlowRun>): void;
  listFlowRuns(limit?: number): FlowRun[];
}

const FLOW_METHODS = [
  'listFlowScripts', 'getFlowScript', 'saveFlowScript', 'deleteFlowScript',
  'listFlowAutomations', 'getFlowAutomation', 'saveFlowAutomation', 'deleteFlowAutomation',
  'listFlowVars', 'getFlowVar', 'setFlowVar', 'deleteFlowVar',
  'createFlowRun', 'updateFlowRun', 'listFlowRuns',
];

function asAdapter(db: any): FlowStoreAdapter | null {
  if (!db || typeof db !== 'object') return null;
  for (const m of FLOW_METHODS) {
    const fn = (db as any)[m];
    // Los mocks de bun:test son funciones; también valen si devuelven valores.
    if (typeof fn !== 'function') return null;
  }
  return db as FlowStoreAdapter;
}

class MemoryAdapter implements FlowStoreAdapter {
  scripts = new Map<string, FlowScript>();
  automations = new Map<string, Automation>();
  vars = new Map<string, FlowVar>();
  runs: FlowRun[] = [];

  listFlowScripts(): FlowScript[] { return [...this.scripts.values()]; }
  getFlowScript(id: string): FlowScript | null { return this.scripts.get(id) ?? null; }
  saveFlowScript(s: FlowScript): void { this.scripts.set(s.id, { ...s }); }
  deleteFlowScript(id: string): void { this.scripts.delete(id); }
  listFlowAutomations(): Automation[] { return [...this.automations.values()]; }
  getFlowAutomation(id: string): Automation | null { return this.automations.get(id) ?? null; }
  saveFlowAutomation(a: Automation): void { this.automations.set(a.id, { ...a }); }
  deleteFlowAutomation(id: string): void { this.automations.delete(id); }
  listFlowVars(): FlowVar[] { return [...this.vars.values()]; }
  getFlowVar(name: string): FlowVar | null { return this.vars.get(name) ?? null; }
  setFlowVar(v: FlowVar): void { this.vars.set(v.name, { ...v }); }
  deleteFlowVar(name: string): void { this.vars.delete(name); }
  createFlowRun(r: FlowRun): void { this.runs.unshift({ ...r }); }
  updateFlowRun(id: string, patch: Partial<FlowRun>): void {
    const r = this.runs.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
  }
  listFlowRuns(limit = 100): FlowRun[] { return this.runs.slice(0, limit); }
}

export class FlowStore {
  private adapter: FlowStoreAdapter;
  /** true si hay persistencia real (SQLite); false si es memoria. */
  readonly persistent: boolean;

  constructor(db?: any) {
    let adapter: FlowStoreAdapter | null = null;
    if (db) {
      adapter = asAdapter(db);
    } else {
      try {
        // Import perezoso para no romper los tests que mockean '../db'.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { DatabaseService } = require('../db') as any;
        adapter = asAdapter(new DatabaseService());
      } catch {
        adapter = null;
      }
    }
    this.adapter = adapter ?? new MemoryAdapter();
    this.persistent = !(this.adapter instanceof MemoryAdapter);
  }

  /** Marca como `interrupted` las ejecuciones que quedaron `running` (reinicio). */
  markInterruptedRuns(): number {
    let count = 0;
    try {
      for (const r of this.adapter.listFlowRuns(1000)) {
        if (r.status === 'running') {
          this.adapter.updateFlowRun(r.id, { status: 'interrupted' as FlowRunStatus, finished_at: Date.now(), error: 'interrupted: reinicio del daemon' });
          count++;
        }
      }
    } catch { /* mejor esfuerzo */ }
    return count;
  }

  listScripts(): FlowScript[] { return this.adapter.listFlowScripts(); }
  getScript(id: string): FlowScript | null { return this.adapter.getFlowScript(id); }
  saveScript(s: FlowScript): void { this.adapter.saveFlowScript(s); }
  deleteScript(id: string): void { this.adapter.deleteFlowScript(id); }

  listAutomations(): Automation[] { return this.adapter.listFlowAutomations(); }
  getAutomation(id: string): Automation | null { return this.adapter.getFlowAutomation(id); }
  saveAutomation(a: Automation): void { this.adapter.saveFlowAutomation(a); }
  deleteAutomation(id: string): void { this.adapter.deleteFlowAutomation(id); }

  listVars(): FlowVar[] { return this.adapter.listFlowVars(); }
  getVar(name: string): FlowVar | null { return this.adapter.getFlowVar(name); }
  setVar(v: FlowVar): void { this.adapter.setFlowVar(v); }
  deleteVar(name: string): void { this.adapter.deleteFlowVar(name); }

  createRun(r: FlowRun): void {
    try { this.adapter.createFlowRun(r); } catch { /* mejor esfuerzo */ }
  }
  finishRun(id: string, patch: Partial<FlowRun>): void {
    try { this.adapter.updateFlowRun(id, patch); } catch { /* mejor esfuerzo */ }
  }
  listRuns(limit = 100): FlowRun[] {
    try { return this.adapter.listFlowRuns(limit); } catch { return []; }
  }
}
