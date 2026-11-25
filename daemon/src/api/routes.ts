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
import { handleDevices } from './devices';
import { handlePages } from './pages';
import { handleButtons } from './buttons';
import { handleActions } from './actions';
import { handleFlows } from './flows';
import { handleVariables } from './variables';
import { handleCatalog } from './catalog';
import { handlePlugins } from './plugins';
import { handleSystem } from './system';
import { handleMcp } from './mcp';
import { handleBackups } from './backups';
import { handleStreamDeck } from './streamdeck';
import { handleSessions } from './sessions';
import { handleShortcuts } from './shortcuts';
import { handleJobs } from './jobs';
import { handleAdmin } from './admin';
import { handleRemote } from './remote';

export type { APIServices } from './types';

const HANDLERS: ApiHandler[] = [
  handleSystem, // /api/v1/test, /config, assets, logs, settings, windows, metrics, version, devices, network
  handleDevices, // ANTES que perfiles: /profiles/:id/assignments matchea su prefijo
  handleProfiles,
  handlePages,
  handleButtons, // incluye /buttons/reorder (antes que /buttons/:id)
  handleActions,
  handleFlows, // /api/v1/buttons/press, /flows/*, /flow-scripts/*, /flow-automations/*, /flow-vars/*
  handleVariables, // /api/v1/variables (servicio daemon de variables)
  handleCatalog, // /api/v1/catalog (solo lectura, offline)
  handlePlugins, // incluye /marketplace y /plugins/* (excluye /plugins/actions del prefijo)
  handleMcp,
  handleBackups, // /api/v1/backups/* (export/validate/restore + progreso WS)
  handleStreamDeck, // /api/v1/streamdeck/* (detect/validate/import + progreso WS)
  handleSessions, // /api/v1/sessions/* + /api/v1/navigate (vistas por dispositivo)
  handleShortcuts, // /api/v1/shortcuts/* (atajos globales: trigger + lista)
  handleJobs,
  handleAdmin, // /admin/shutdown + /admin/reset + /update (501)
  handleRemote, // /api/v1/remote/* (E2E relay client)
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
