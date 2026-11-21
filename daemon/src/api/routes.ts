/**
 * Dispatcher de la API del daemon.
 *
 * La lógica vive en submódulos (profiles/pages/buttons/actions/plugins/
 * system/mcp/jobs/admin); aquí solo se encadenan EN EL MISMO ORDEN que el
 * if-chain original, así que URLs, códigos y payloads no cambian.
 *
 * Para añadir una familia nueva: crea `api/<familia>.ts` con un `ApiHandler`
 * y añádelo a HANDLERS en la posición que le corresponda.
 */
import { DatabaseService } from '../db';
import { jsonResponse, errorResponse } from './http-helpers';
import type { APIServices, ApiHandler } from './types';
import { handleProfiles } from './profiles';
import { handlePages } from './pages';
import { handleButtons } from './buttons';
import { handleActions } from './actions';
import { handlePlugins } from './plugins';
import { handleSystem } from './system';
import { handleMcp } from './mcp';
import { handleJobs } from './jobs';
import { handleAdmin } from './admin';

export type { APIServices } from './types';

const HANDLERS: ApiHandler[] = [
  handleSystem, // /api/v1/test, /config, assets, logs, settings, windows, metrics, version, devices, network
  handleProfiles,
  handlePages,
  handleButtons, // incluye /buttons/reorder (antes que /buttons/:id)
  handleActions,
  handlePlugins, // incluye /marketplace y /plugins/* (excluye /plugins/actions del prefijo)
  handleMcp,
  handleJobs,
  handleAdmin, // /admin/shutdown + /update (501)
];

export async function setupAPIRoutes(req: Request, services: APIServices): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;
  const path = url.pathname;

  const db = new DatabaseService();

  try {
    for (const handler of HANDLERS) {
      const res = await handler(req, { url, method, path, db, services });
      if (res) return res;
    }

    // 404 - Route not found
    return jsonResponse({ error: 'API endpoint not found' }, 404);
  } catch (error) {
    console.error('API Error:', error);
    return errorResponse('Internal server error', error);
  }
}
