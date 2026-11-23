/**
 * Migración de la configuración actual de teclas (KeyInspector/useKeyEngine)
 * a flujos equivalentes del daemon.
 *
 * Formato cliente (`button.data`):
 * - `actions`: lista de acciones base con `waitMs` opcional y `mode`:
 *   'seq' | 'par' | 'alt'. Es el espejo de `pressActions.click` (compat).
 * - `pressActions`: { click, double, triple, long } — listas por tipo de
 *   pulsación (Fase B). `click` equivale a `actions[]`.
 * - `rules`: [{ on, when: 'press'|'double'|'triple'|'long'|'load'|'timer'|'var',
 *   cond, then, else, every, vn }]
 * - Acciones locales `local.set-var` / `local.toggle-var` / `local.toast`.
 *
 * Reglas de equivalencia:
 * - press/click → pressType 'short'; long → 'long'; double/triple → igual.
 *   `touch-start`/`touch-end` son nuevos (sin equivalente heredado: solo
 *   reglas con ese `when` escrito a mano o creadas por la API).
 * - `mode: 'par'` → nodo parallel; `'alt'` → rotación persistente por tecla
 *   (solo 'short'; double/triple/long siempre seq/par).
 * - `local.toast` → nodo log (el daemon no tiene toasts).
 * - `load`/`timer`/`var` no se ejecutan en el press: van a automatizaciones
 *   con scope de botón (ver `syncButtonAutomations` en action-runner).
 */
import type { FlowNode, PressType } from './types';
import { legacyTriggerToPress } from './types';

export interface LegacyAction {
  id?: string;
  type: string;
  parameters?: Record<string, any>;
  waitMs?: number;
  delayMs?: number;
  timeout?: number;
  continueOnError?: boolean;
}

export interface LegacyRule {
  id?: string;
  on?: boolean;
  when?: string;
  cond?: string;
  then?: LegacyAction[];
  else?: LegacyAction[];
  every?: number;
  vn?: string;
}

/** Convierte una acción heredada (incluidas `local.*`) a nodo de flujo. */
export function legacyActionToNode(a: LegacyAction): FlowNode {
  const type = String(a?.type ?? '');
  if (type === 'local.set-var') {
    return { kind: 'set-var', name: String(a?.parameters?.name ?? ''), expr: String(a?.parameters?.expr ?? '') };
  }
  if (type === 'local.toggle-var') {
    return { kind: 'toggle-var', name: String(a?.parameters?.name ?? '') };
  }
  if (type === 'local.toast') {
    return { kind: 'log', level: 'info', message: String(a?.parameters?.text ?? '(mensaje vacío)') };
  }
  const node: Extract<FlowNode, { kind: 'action' }> = { kind: 'action', type, parameters: a?.parameters ?? {} };
  if (typeof a?.waitMs === 'number') node.waitMs = a.waitMs;
  if (typeof a?.delayMs === 'number') node.delayMs = a.delayMs;
  if (typeof a?.timeout === 'number') node.timeout = a.timeout;
  if (typeof a?.continueOnError === 'boolean') node.continueOnError = a.continueOnError;
  return node;
}

function ruleToNode(r: LegacyRule): FlowNode | null {
  if (!r || r.on === false) return null;
  const then = (r.then ?? []).map(legacyActionToNode);
  const els = (r.else ?? []).map(legacyActionToNode);
  const cond = (r.cond ?? '').trim();
  if (!cond) {
    if (!then.length && !els.length) return null;
    return { kind: 'sequence', nodes: then };
  }
  return { kind: 'if', cond, then, else: els };
}

/**
 * Construye los nodos de flujo para una pulsación concreta.
 * Devuelve también si la tecla tiene contenido ejecutable.
 *
 * Las listas directas salen de `pressActions[click|double|triple|long]`
 * (`actions[]` legacy = click); las reglas `when` del pressType se añaden
 * después, igual que en el cliente (useKeyEngine).
 */
export function buttonDataToNodes(data: any, pressType: PressType): { nodes: FlowNode[]; hasContent: boolean; mode: string } {
  const rawPa = data?.pressActions && typeof data.pressActions === 'object' ? data.pressActions : {};
  const shortActs: LegacyAction[] = Array.isArray(rawPa.click) && rawPa.click.length
    ? rawPa.click
    : (Array.isArray(data?.actions) ? data.actions : []);
  const kindActs: LegacyAction[] = pressType === 'short' ? shortActs
    : pressType === 'double' && Array.isArray(rawPa.double) ? rawPa.double
    : pressType === 'triple' && Array.isArray(rawPa.triple) ? rawPa.triple
    : pressType === 'long' && Array.isArray(rawPa.long) ? rawPa.long
    : [];
  const rules: LegacyRule[] = Array.isArray(data?.rules) ? data.rules : [];
  const mode = data?.mode ?? 'seq';
  const nodes: FlowNode[] = [];

  // Acciones base: solo pertenecen a su pressType (igual que el cliente).
  if (kindActs.length) {
    if (mode === 'par') {
      nodes.push({ kind: 'parallel', branches: kindActs.map((a) => [legacyActionToNode(a)]) });
    } else if (mode !== 'alt' || pressType !== 'short') {
      for (const a of kindActs) nodes.push(legacyActionToNode(a));
    }
    // mode 'alt': lo resuelve el runner (rotación persistente) solo en
    // 'short'. Aquí no se expande; ver executeButtonFlow.
  }

  // Reglas cuyo `when` corresponde a este pressType.
  for (const r of rules) {
    if (!r || r.on === false) continue;
    const when = r.when ?? 'press';
    if (when === 'load' || when === 'timer' || when === 'var') continue; // -> automatizaciones
    const mapped = legacyTriggerToPress(when);
    const rulePress: PressType | null = mapped ?? (when as PressType);
    if (rulePress !== pressType) continue;
    const n = ruleToNode(r);
    if (n) nodes.push(n);
  }

  const hasContent = nodes.length > 0 || (mode === 'alt' && pressType === 'short' && shortActs.length > 0);
  return { nodes, hasContent, mode };
}

/** Reglas de botón que deben convertirse en automatizaciones (load/timer/var). */
export function buttonDataToAutomations(data: any, scope: { buttonId: string; pageId?: string; position?: number }): Array<{ when: string; node: FlowNode; everySec?: number; varName?: string }> {
  const out: Array<{ when: string; node: FlowNode; everySec?: number; varName?: string }> = [];
  const rules: LegacyRule[] = Array.isArray(data?.rules) ? data.rules : [];
  for (const r of rules) {
    if (!r || r.on === false) continue;
    if (r.when !== 'load' && r.when !== 'timer' && r.when !== 'var') continue;
    const n = ruleToNode(r);
    if (!n) continue;
    if (r.when === 'timer') out.push({ when: 'timer', node: n, everySec: Math.max(1, Math.round(Number(r.every) || 5)) });
    else if (r.when === 'var' && r.vn) out.push({ when: 'var', node: n, varName: r.vn });
    else if (r.when === 'load') out.push({ when: 'load', node: n });
  }
  return out;
}

/** ¿La tecla tiene reglas/acciones para un pressType (para el driver HW)? */
export function buttonHasTrigger(data: any, pressType: PressType): boolean {
  const { hasContent } = buttonDataToNodes(data, pressType);
  return hasContent;
}
