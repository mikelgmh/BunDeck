/**
 * Protocolo de mensajes entre el daemon (padre) y el Worker de cada plugin externo.
 *
 * Diseño:
 * - UN Worker (Bun `Worker`) por plugin externo. El `main.js` del plugin se
 *   importa DENTRO del worker; el daemon nunca hace `import()` del plugin.
 * - El Worker solo PIDE operaciones (settings, log, http, fs, eventos); el
 *   PADRE las ejecuta y aplica permisos del manifest. El Worker nunca abre la DB.
 * - Toda respuesta correlaciona por `callId` / `opId`.
 */

/** Padre -> Worker */
export type ParentToWorkerMsg =
  | { kind: 'init'; pluginId: string; mainPath: string; apiVersion: string }
  | { kind: 'invoke'; callId: string; actionId: string; params: any; context: any }
  | { kind: 'op-result'; opId: string; ok: boolean; result?: any; error?: string }
  | { kind: 'shutdown' };

/** Worker -> Padre */
export type WorkerToParentMsg =
  | { kind: 'ready' }
  | { kind: 'register-actions'; actions: string[] }
  | { kind: 'register-error'; error: string }
  | { kind: 'invoke-result'; callId: string; ok: boolean; result?: any; error?: string }
  | { kind: 'op'; opId: string | null; op: WorkerOpName; args: any };

export type WorkerOpName =
  | 'get-setting'
  | 'set-setting'
  | 'delete-setting'
  | 'log'
  | 'emit-event'
  | 'http-fetch'
  | 'fs-read'
  | 'fs-write'
  | 'fs-exists';

/** Respuesta serializable de un fetch hecho por el padre */
export interface ParentFetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyText: string;
}

let msgSeq = 0;

/** Genera ids de correlación únicos por proceso. */
export function nextMsgId(prefix: string): string {
  msgSeq += 1;
  return `${prefix}_${Date.now()}_${msgSeq}_${Math.floor(Math.random() * 1e6)}`;
}
