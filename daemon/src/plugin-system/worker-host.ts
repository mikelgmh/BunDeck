/**
 * worker-host.ts — Entry point que corre DENTRO del Bun Worker (un proceso
 * lógico aislado por plugin externo).
 *
 * - Recibe `init` con la ruta del `main.js`, lo importa y llama a
 *   `register(api)` con un API proxy compatible con el API histórico
 *   (`onAction`, `emitEvent`, `getSetting/setSetting/deleteSetting`, `log`,
 *   `http.fetch`, `fs.*`).
 * - El proxy NO toca SQLite ni la red directamente para operaciones
 *   mediadas: envía `op` al padre y espera `op-result`.
 * - Recibe `invoke` y ejecuta el handler registrado, devolviendo
 *   `invoke-result`.
 *
 * NOTA DE COMPATIBILIDAD: `getSetting/setSetting/deleteSetting` pasan a ser
 * asíncronos (devuelven Promise) porque la DB vive en el padre. El resto del
 * API mantiene su forma (`onAction`, `emitEvent`, `log`, `http.fetch`, `fs.*`).
 */

import type {
  ParentToWorkerMsg,
  WorkerOpName,
  ParentFetchResult,
} from './protocol';
import { nextMsgId } from './protocol';

const post = (msg: unknown): void => {
  (globalThis as any).postMessage(msg);
};

interface PendingOp {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

const pendingOps = new Map<string, PendingOp>();
const handlers = new Map<string, (params: any, context: any) => any>();
let pluginId = 'unknown';

/** Petición al padre con respuesta. */
function requestParent(op: WorkerOpName, args: any): Promise<any> {
  const opId = nextMsgId('op');
  return new Promise((resolve, reject) => {
    pendingOps.set(opId, { resolve, reject });
    post({ kind: 'op', opId, op, args });
  });
}

/** Notificación al padre sin esperar respuesta (log, eventos). */
function notifyParent(op: WorkerOpName, args: any): void {
  post({ kind: 'op', opId: null, op, args });
}

function serializeInit(init: RequestInit | undefined): any {
  if (!init) return {};
  const headers: Record<string, string> = {};
  if (init.headers) {
    if (typeof (init.headers as any).forEach === 'function') {
      (init.headers as Headers).forEach((v, k) => { headers[k] = v; });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers as [string, string][]) headers[k] = v;
    } else {
      Object.assign(headers, init.headers);
    }
  }
  let body: string | undefined;
  if (typeof init.body === 'string') body = init.body;
  else if (init.body !== undefined && init.body !== null) {
    throw new Error('http.fetch: el body debe ser string (limitación del puente Worker)');
  }
  return { method: init.method ?? 'GET', headers, body };
}

function buildAPI(id: string, apiVersion = '2.1'): any {
  const api: any = {
    version: apiVersion,
    pluginId: id,
    onAction(actionId: string, handler: (params: any, context: any) => any): void {
      if (typeof handler !== 'function') throw new Error(`onAction(${actionId}): handler no es función`);
      handlers.set(actionId, handler);
    },
    emitEvent(eventName: string, payload: any): void {
      notifyParent('emit-event', { eventName, payload });
    },
    getSetting(key: string): Promise<string | null> {
      return requestParent('get-setting', { key });
    },
    setSetting(key: string, value: string): Promise<void> {
      return requestParent('set-setting', { key, value }) as Promise<void>;
    },
    deleteSetting(key: string): Promise<void> {
      return requestParent('delete-setting', { key }) as Promise<void>;
    },
    log(level: string, message: string, meta?: any): void {
      notifyParent('log', { level, message, meta });
    },
    http: {
      fetch: async (url: string, init?: RequestInit): Promise<Response> => {
        const res: ParentFetchResult = await requestParent('http-fetch', {
          url,
          init: serializeInit(init),
        });
        return new Response(res.bodyText, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      },
    },
    fs: {
      readFile: (relativePath: string): Promise<string> =>
        requestParent('fs-read', { relativePath }),
      writeFile: (relativePath: string, content: string): Promise<void> =>
        requestParent('fs-write', { relativePath, content }) as Promise<void>,
      exists: (relativePath: string): Promise<boolean> =>
        requestParent('fs-exists', { relativePath }),
    },
  };
  // Compat: getSetting/setSetting històricos eran síncronos; ahora son async.
  return api;
}

async function handleInit(mainPath: string, apiVersion?: string): Promise<void> {
  handlers.clear();
  // Importar el main del plugin dentro del worker (file:// para Windows-safe)
  const { pathToFileURL } = await import('node:url');
  const mod = await import(pathToFileURL(mainPath).href);
  const register =
    mod.register ?? mod.default?.register ?? (typeof mod.default === 'function' ? mod.default : undefined);
  if (typeof register !== 'function') {
    throw new Error(`El plugin debe exportar register(api) (main: ${mainPath})`);
  }
  await register(buildAPI(pluginId, apiVersion ?? '2.0'));
  post({ kind: 'register-actions', actions: [...handlers.keys()] });
}

async function handleInvoke(callId: string, actionId: string, params: any, context: any): Promise<void> {
  const handler = handlers.get(actionId);
  if (!handler) {
    post({ kind: 'invoke-result', callId, ok: false, error: `Acción no registrada en worker: ${actionId}` });
    return;
  }
  try {
    const result = await handler(params, context);
    try {
      post({ kind: 'invoke-result', callId, ok: true, result });
    } catch {
      post({ kind: 'invoke-result', callId, ok: false, error: 'Resultado no serializable (structured clone falló)' });
    }
  } catch (e) {
    post({ kind: 'invoke-result', callId, ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  }
}

(globalThis as any).onmessage = async (ev: any): Promise<void> => {
  const msg = (ev?.data ?? ev) as ParentToWorkerMsg;
  try {
    switch (msg.kind) {
      case 'init':
        pluginId = msg.pluginId;
        try {
          await handleInit(msg.mainPath, (msg as any).apiVersion);
        } catch (e) {
          post({ kind: 'register-error', error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
        }
        break;
      case 'invoke':
        await handleInvoke(msg.callId, msg.actionId, msg.params, msg.context);
        break;
      case 'op-result': {
        const pending = pendingOps.get(msg.opId);
        if (pending) {
          pendingOps.delete(msg.opId);
          if (msg.ok) pending.resolve(msg.result);
          else pending.reject(new Error(msg.error ?? 'Op falló en el padre'));
        }
        break;
      }
      case 'shutdown':
        for (const [, p] of pendingOps) p.reject(new Error('Worker apagado'));
        pendingOps.clear();
        (globalThis as any).close?.();
        break;
    }
  } catch (e) {
    // Nunca tumbar el worker por un error de protocolo
    try {
      if ((msg as any).kind === 'invoke') {
        post({ kind: 'invoke-result', callId: (msg as any).callId, ok: false, error: String(e) });
      }
    } catch {}
  }
};

// Señal de vida: el padre espera `ready` antes de enviar `init`.
post({ kind: 'ready' });
