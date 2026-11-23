/**
 * Tipos del motor de flujos persistente (daemon).
 *
 * Un flujo es una lista de nodos que el daemon ejecuta sin necesidad de UI.
 * Es la contrapartida servidor de `web/src/composables/useKeyEngine.ts`:
 * ambos deben mantener la misma semántica (ver `flow/migrate.ts`).
 */

/** Pulsación física/lógica que dispara un flujo de botón. */
export type PressType = 'short' | 'long' | 'double' | 'triple' | 'touch-start' | 'touch-end';

/** Triggers heredados del cliente (KeyInspector/useKeyEngine). */
export type LegacyTrigger = 'press' | 'long' | 'load' | 'timer' | 'var';

/** Mapea triggers heredados a PressType de botón. Solo press/long son de botón. */
export function legacyTriggerToPress(trigger: string): PressType | null {
  if (trigger === 'press' || trigger === 'click') return 'short';
  if (trigger === 'long') return 'long';
  if (trigger === 'double' || trigger === 'triple') return trigger;
  return null;
}

export type FlowNode =
  | { kind: 'action'; type: string; parameters?: Record<string, any>; waitMs?: number; delayMs?: number; timeout?: number; continueOnError?: boolean }
  | { kind: 'wait'; ms: number }
  | { kind: 'if'; cond: string; then: FlowNode[]; else?: FlowNode[] }
  | { kind: 'switch'; expr: string; cases: Array<{ value?: any; cond?: string; nodes: FlowNode[] }>; default?: FlowNode[] }
  | { kind: 'repeat'; count?: number; while?: string; nodes: FlowNode[]; delayMs?: number }
  | { kind: 'parallel'; branches: FlowNode[][] }
  | { kind: 'set-var'; name: string; expr: string }
  | { kind: 'toggle-var'; name: string }
  | { kind: 'log'; level?: string; message: string }
  | { kind: 'script'; scriptId: string; inputs?: Record<string, any>; outputVar?: string }
  | { kind: 'sequence'; nodes: FlowNode[] };

/** Script reutilizable con inputs y variables propias (ámbito local). */
export interface FlowScript {
  id: string;
  name: string;
  /** Nombres de inputs aceptados (se inyectan en el ámbito local). */
  inputs?: string[];
  /** Timeout global del script en ms (por defecto 30000). */
  timeout?: number;
  nodes: FlowNode[];
  created_at: number;
  updated_at: number;
}

export type AutomationTrigger =
  | { kind: 'event'; event: string }
  | { kind: 'timer'; everySec: number }
  | { kind: 'var'; varName: string }
  | { kind: 'load' };

/** Automatización global: se dispara por evento/timer/cambio de variable. */
export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  /** Script referenciado (o nodos en línea si no hay scriptId). */
  scriptId?: string;
  nodes?: FlowNode[];
  inputs?: Record<string, any>;
  /** Alcance opcional: regla de botón sincronizada (load/timer/var por tecla). */
  scope?: { buttonId?: string; pageId?: string; position?: number };
  created_at: number;
  updated_at: number;
}

export interface FlowVar {
  name: string;
  type: 'num' | 'bool' | 'txt';
  value: any;
}

export type FlowRunStatus = 'running' | 'finished' | 'error' | 'cancelled' | 'interrupted';

export interface FlowRun {
  id: string;
  kind: string;
  label: string;
  status: FlowRunStatus;
  started_at: number;
  finished_at?: number;
  error?: string;
}

/** Contexto de ejecución (compatible con ActionContext existente). */
export interface FlowContext {
  buttonId?: string;
  pageId?: string;
  profileId?: string;
  position?: number;
  userId?: string;
  timestamp: number;
  pressType?: PressType;
  trigger?: string;
  source?: string;
  [k: string]: any;
}

export function isFlowNode(v: any): v is FlowNode {
  return !!v && typeof v === 'object' && typeof v.kind === 'string';
}

export function normalizeNodes(input: unknown): FlowNode[] {
  if (Array.isArray(input)) return input.filter(isFlowNode);
  if (isFlowNode(input)) return [input];
  return [];
}
