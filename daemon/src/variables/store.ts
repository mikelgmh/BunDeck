/**
 * Servicio daemon de variables tipadas y persistentes.
 *
 * - Tipos: text | numeric | bool | color. Scopes: global | widget | script |
 *   automation (los no-globales heredan el global como fallback).
 * - Persistencia en la tabla `variables` (db.ts, migración 4) + caché en
 *   memoria. Escrituras por clave serializadas (mutex) para concurrencia.
 * - Cada cambio emite `variable-changed` en el bus interno y
 *   `variable.changed` por WS (topic `variables`, best-effort).
 * - Bindings: `bindings.read` = entidad de integración que alimenta la
 *   variable (syncFromIntegration); `bindings.write` = destino(s) a los que
 *   se propaga el cambio vía el propio evento `variable-changed`.
 */

import { DatabaseService, type VariableRow } from '../db';
import { getEventBus, type EventBus, type VariableChangedPayload } from '../events/bus';
import {
  coerceVarValue,
  defaultVarValue,
  deserializeVarValue,
  normalizeVarScope,
  normalizeVarType,
  parseBindings,
  serializeVarValue,
  toggleVarValue,
  validateVarName,
  COLOR_RE,
  type Coerced,
  type VariableDef,
  type VarScope,
  type VarType,
} from './types';
import { baseEnv, ev, type Env } from './expressions';
import { lookupFromList, renderTemplate } from './templates';

export type { VariableDef };

export interface VarAddress {
  scope?: string;
  scopeId?: string;
}

export interface SetOptions extends VarAddress {
  /** Origen del cambio (ui, action, integration:<id>, timer, …). */
  source?: string;
  /** Tipo esperado (si la variable no existe y se crea al vuelo). */
  type?: string;
}

function cacheKey(scope: string, scopeId: string, name: string): string {
  return `${scope}\0${scopeId}\0${name}`;
}

function inferType(value: unknown): VarType {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number' && Number.isFinite(value)) return 'numeric';
  if (typeof value === 'string' && COLOR_RE.test(value.trim())) return 'color';
  return 'text';
}

function rowToDef(row: VariableRow): VariableDef {
  let type: VarType;
  try { type = normalizeVarType(row.type); } catch { type = 'text'; }
  return {
    name: row.name,
    scope: normalizeVarScope(row.scope),
    scopeId: row.scope_id ?? '',
    type,
    value: deserializeVarValue(type, row.value ?? ''),
    unavailable: row.unavailable === 1,
    bindings: parseBindings(row.bindings),
    updatedAt: row.updated_at ?? Date.now(),
  };
}

export function varToJSON(def: VariableDef): Record<string, any> {
  return {
    name: def.name,
    scope: def.scope,
    scopeId: def.scopeId,
    type: def.type,
    value: def.value,
    unavailable: def.unavailable,
    bindings: def.bindings,
    updatedAt: def.updatedAt,
  };
}

export class VariableStore {
  private db?: DatabaseService;
  private bus: EventBus;
  private cache = new Map<string, VariableDef>();
  private locks = new Map<string, Promise<void>>();
  /** Versión de escritura: invalida resolvedCache sin recorrerlo. */
  private rev = 0;
  private resolvedCache = new Map<string, { rev: number; defs: VariableDef[] }>();

  constructor(db?: DatabaseService, bus?: EventBus) {
    this.db = db;
    this.bus = bus ?? getEventBus();
  }

  private database(): DatabaseService {
    if (!this.db) this.db = new DatabaseService();
    return this.db;
  }

  private async withLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const cur = new Promise<void>((r) => { release = r; });
    this.locks.set(key, prev.then(() => cur));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === cur) this.locks.delete(key);
    }
  }

  /** Vacía la caché (tests / recarga). */
  clearCache(): void {
    this.cache.clear();
    this.resolvedCache.clear();
  }

  // ---- Lectura ----

  list(scope?: string, scopeId?: string): VariableDef[] {
    const rows = this.database().listVariableRows(scope, scopeId);
    const defs = rows.map(rowToDef);
    for (const d of defs) this.cache.set(cacheKey(d.scope, d.scopeId, d.name), d);
    return defs;
  }

  get(name: string, scope: string = 'global', scopeId: string = ''): VariableDef | null {
    const s = normalizeVarScope(scope);
    const sid = s === 'global' ? '' : String(scopeId ?? '');
    const hit = this.cache.get(cacheKey(s, sid, name));
    if (hit) return { ...hit };
    const row = this.database().getVariableRow(name, s, sid);
    // Fallback: los scopes no-globales heredan el valor global.
    const effective = row ?? (s !== 'global' ? this.database().getVariableRow(name, 'global', '') : null);
    if (!effective) return null;
    const def = rowToDef(effective);
    this.cache.set(cacheKey(def.scope, def.scopeId, def.name), def);
    return { ...def };
  }

  require(name: string, scope: string = 'global', scopeId: string = ''): VariableDef {
    const def = this.get(name, scope, scopeId);
    if (!def) throw new Error(`Variable desconocida «${name}» (${scope}${scopeId ? `:${scopeId}` : ''})`);
    return def;
  }

  /** Variables resueltas para un scope (global + propias; las propias ganan). */
  resolved(scope: string = 'global', scopeId: string = ''): VariableDef[] {
    const s = normalizeVarScope(scope);
    const sid = s === 'global' ? '' : String(scopeId ?? '');
    // Fase C+D: memo por versión. envFor/render/evalExpr llamaban a
    // resolved() (2 queries + N JSON.parse) por tecla y tick; ahora solo
    // recalcula cuando hubo una escritura (rev cambia en persist()).
    const key = `${s} ${sid}`;
    const hit = this.resolvedCache.get(key);
    if (hit && hit.rev === this.rev) return hit.defs.map((d) => ({ ...d }));
    const byName = new Map<string, VariableDef>();
    for (const d of this.list('global', '')) byName.set(d.name, d);
    if (s !== 'global') {
      for (const d of this.list(s, sid)) byName.set(d.name, d);
    }
    const defs = [...byName.values()];
    this.resolvedCache.set(key, { rev: this.rev, defs: defs.map((d) => ({ ...d })) });
    return defs;
  }

  /** Entorno de evaluación (variables + incorporadas hora/minuto/…). */
  envFor(scope: string = 'global', scopeId: string = '', perfil = '', pagina = ''): Env {
    const vars = this.resolved(scope, scopeId).map((d) => ({ n: d.name, v: d.value }));
    return baseEnv(vars, perfil, pagina);
  }

  // ---- Escritura ----

  define(input: {
    name: string;
    type?: string;
    scope?: string;
    scopeId?: string;
    value?: unknown;
    unavailable?: boolean;
    bindings?: VariableDef['bindings'];
  }): VariableDef {
    const name = validateVarName(input.name);
    const type = normalizeVarType(input.type ?? (input.value === undefined ? 'text' : inferType(input.value)));
    const scope = normalizeVarScope(input.scope);
    const scopeId = scope === 'global' ? '' : String(input.scopeId ?? '');
    if (this.database().getVariableRow(name, scope, scopeId)) {
      throw new Error(`La variable «${name}» ya existe en ${scope}${scopeId ? `:${scopeId}` : ''}`);
    }
    const value = input.value === undefined ? defaultVarValue(type) : coerceVarValue(type, input.value);
    const def: VariableDef = {
      name, scope, scopeId, type, value,
      unavailable: !!input.unavailable,
      bindings: input.bindings ?? null,
      updatedAt: Date.now(),
    };
    this.persist(def);
    return { ...def };
  }

  async set(name: string, value: unknown, opts: SetOptions = {}): Promise<VariableDef> {
    const scope = normalizeVarScope(opts.scope);
    const scopeId = scope === 'global' ? '' : String(opts.scopeId ?? '');
    return this.withLock(cacheKey(scope, scopeId, name), () => {
      let def = this.get(name, scope, scopeId);
      if (!def) {
        // Upsert: crea al vuelo con tipo inferido o el indicado.
        def = this.define({ name, type: opts.type ?? inferType(value), scope, scopeId, value });
        this.emitChanged(def, undefined, opts.source ?? 'set');
        return { ...def };
      }
      const coerced = coerceVarValue(def.type, value);
      return this.applyValue(def, coerced, { unavailable: false, source: opts.source ?? 'set' });
    });
  }

  /** Versión síncrona (la BD bun:sqlite es síncrona; el lock solo ordena async). */
  setSync(name: string, value: unknown, opts: SetOptions = {}): VariableDef {
    const scope = normalizeVarScope(opts.scope);
    const scopeId = scope === 'global' ? '' : String(opts.scopeId ?? '');
    let def = this.get(name, scope, scopeId);
    if (!def) {
      def = this.define({ name, type: opts.type ?? inferType(value), scope, scopeId, value });
      this.emitChanged(def, undefined, opts.source ?? 'set');
      return { ...def };
    }
    return this.applyValue(def, coerceVarValue(def.type, value), { unavailable: false, source: opts.source ?? 'set' });
  }

  /**
   * Read-modify-write atómico bajo lock (contadores concurrentes sin
   * lecturas perdidas). Crea la variable si no existe.
   */
  async update(
    name: string,
    fn: (current: Coerced, def: VariableDef) => unknown,
    opts: SetOptions = {},
  ): Promise<VariableDef> {
    const scope = normalizeVarScope(opts.scope);
    const scopeId = scope === 'global' ? '' : String(opts.scopeId ?? '');
    return this.withLock(cacheKey(scope, scopeId, name), () => {
      let def = this.get(name, scope, scopeId);
      if (!def) {
        def = this.define({ name, type: opts.type ?? 'numeric', scope, scopeId, value: defaultVarValue(normalizeVarType(opts.type ?? 'numeric')) });
      }
      const next = coerceVarValue(def.type, fn(def.value, def));
      return this.applyValue(def, next, { unavailable: false, source: opts.source ?? 'update' });
    });
  }

  async toggle(name: string, opts: SetOptions = {}): Promise<VariableDef> {
    const scope = normalizeVarScope(opts.scope);
    const scopeId = scope === 'global' ? '' : String(opts.scopeId ?? '');
    return this.withLock(cacheKey(scope, scopeId, name), () => {
      const def = this.require(name, scope, scopeId);
      return this.applyValue(def, toggleVarValue(def.type, def.value), { unavailable: false, source: opts.source ?? 'toggle' });
    });
  }

  async setUnavailable(name: string, unavailable: boolean, opts: VarAddress = {}): Promise<VariableDef> {
    const def = this.require(name, opts.scope, opts.scopeId);
    return this.applyValue(def, def.value, { unavailable, source: 'unavailable' });
  }

  async setBindings(name: string, bindings: VariableDef['bindings'], opts: VarAddress = {}): Promise<VariableDef> {
    const def = this.require(name, opts.scope, opts.scopeId);
    const next: VariableDef = { ...def, bindings: bindings ?? null, updatedAt: Date.now() };
    this.persist(next);
    return { ...next };
  }

  /** Cambia el tipo re-coercionando el valor actual. */
  async retype(name: string, type: string, opts: SetOptions = {}): Promise<VariableDef> {
    const scope = normalizeVarScope(opts.scope);
    const scopeId = scope === 'global' ? '' : String(opts.scopeId ?? '');
    return this.withLock(cacheKey(scope, scopeId, name), () => {
      const def = this.require(name, scope, scopeId);
      const t = normalizeVarType(type);
      if (t === def.type) return { ...def };
      const next: VariableDef = { ...def, type: t, value: coerceVarValue(t, def.value), updatedAt: Date.now() };
      this.persist(next);
      this.emitChanged(next, def.value, opts.source ?? 'retype');
      return { ...next };
    });
  }

  async delete(name: string, scope: string = 'global', scopeId: string = ''): Promise<boolean> {
    const s = normalizeVarScope(scope);
    const sid = s === 'global' ? '' : String(scopeId ?? '');
    const def = this.get(name, s, sid);
    const ok = this.database().deleteVariableRow(name, s, sid);
    if (ok) {
      this.rev++;
      this.cache.delete(cacheKey(s, sid, name));
      const payload: VariableChangedPayload = {
        name, scope: s, scopeId: sid,
        type: def?.type ?? 'text',
        value: undefined, previous: def?.value,
        unavailable: false, source: 'delete', ts: Date.now(),
      };
      this.bus.emit('variable-changed', payload);
      this.broadcastWs('variable.deleted', payload);
    }
    return ok;
  }

  // ---- Plantillas y expresiones ----

  render(template: string, scope: string = 'global', scopeId: string = ''): string {
    const list = this.resolved(scope, scopeId).map((d) => ({ name: d.name, value: d.value, unavailable: d.unavailable }));
    const { lookup, env } = lookupFromList(list);
    return renderTemplate(template, lookup, env);
  }

  /**
   * Interpolación tolerante para parámetros de acciones: sustituye las
   * variables conocidas y deja intacto lo desconocido (plantillas Jinja
   * de Home Assistant, literales con {{}}, …).
   */
  renderLenient(template: string, scope: string = 'global', scopeId: string = ''): string {
    const list = this.resolved(scope, scopeId).map((d) => ({ name: d.name, value: d.value, unavailable: d.unavailable }));
    const { lookup, env } = lookupFromList(list);
    return renderTemplate(template, lookup, env, { keepUnknown: true });
  }

  evalExpr(expr: string, scope: string = 'global', scopeId: string = ''): unknown {
    return ev(expr, this.envFor(scope, scopeId));
  }

  // ---- Bindings de lectura (integraciones → variables) ----

  /**
   * Propaga el estado de una integración a las variables cuyo
   * `bindings.read` coincide con `entity`. Devuelve las actualizadas.
   */
  async syncFromIntegration(entity: string, value: unknown, source?: string): Promise<VariableDef[]> {
    const out: VariableDef[] = [];
    for (const def of this.list()) {
      if (def.bindings?.read === entity) {
        out.push(await this.set(def.name, value, { scope: def.scope, scopeId: def.scopeId, source: source ?? `integration:${entity}` }));
      }
    }
    return out;
  }

  // ---- Suscripciones ----

  onChange(listener: (p: VariableChangedPayload) => void): () => void {
    return this.bus.on('variable-changed', listener);
  }

  onVarChange(name: string, listener: (p: VariableChangedPayload) => void, scope?: string): () => void {
    return this.bus.on('variable-changed', (p: VariableChangedPayload) => {
      if (p?.name === name && (!scope || p.scope === scope)) listener(p);
    });
  }

  // ---- Internos ----

  private persist(def: VariableDef): void {
    this.rev++;
    this.database().setVariableRow({
      name: def.name,
      scope: def.scope,
      scope_id: def.scopeId,
      type: def.type,
      value: serializeVarValue(def.type, def.value as Coerced),
      unavailable: def.unavailable ? 1 : 0,
      bindings: def.bindings ? JSON.stringify(def.bindings) : null,
      updated_at: def.updatedAt,
    });
    this.cache.set(cacheKey(def.scope, def.scopeId, def.name), { ...def });
  }

  private applyValue(
    def: VariableDef,
    value: Coerced,
    opts: { unavailable: boolean; source: string },
  ): VariableDef {
    const previous = def.value;
    const prevUnavail = def.unavailable;
    const changed = previous !== value || prevUnavail !== opts.unavailable;
    // Sin cambio no se toca la BD (evita JSON.stringify + UPDATE + churn de
    // updatedAt/WS por tecla cuando el valor ya era el mismo).
    if (!changed) return { ...def };
    const next: VariableDef = { ...def, value, unavailable: opts.unavailable, updatedAt: Date.now() };
    this.persist(next);
    if (changed) this.emitChanged(next, previous, opts.source);
    return { ...next };
  }

  private emitChanged(def: VariableDef, previous: unknown, source: string): void {
    const payload: VariableChangedPayload = {
      name: def.name,
      scope: def.scope,
      scopeId: def.scopeId,
      type: def.type,
      value: def.value,
      previous,
      unavailable: def.unavailable,
      source,
      ts: Date.now(),
    };
    this.bus.emit('variable-changed', payload);
    this.broadcastWs('variable.changed', payload);
  }

  private broadcastWs(event: string, payload: unknown): void {
    try {
      (globalThis as any).__libredeckWs?.broadcast?.(event, payload, 'variables');
    } catch { /* mejor esfuerzo */ }
  }
}

let shared: VariableStore | null = null;

/** Singleton del daemon (server.ts lo inicializa con la BD real). */
export function getVariableStore(): VariableStore {
  if (!shared) shared = new VariableStore();
  return shared;
}

export function setVariableStore(store: VariableStore): void {
  shared = store;
}

export function resetVariableStore(): VariableStore {
  shared = new VariableStore();
  return shared;
}
