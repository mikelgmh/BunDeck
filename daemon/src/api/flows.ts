/**
 * Rutas `/api/v1/buttons/press`, `/api/v1/flows/*`, `/api/v1/flow-scripts/*`,
 * `/api/v1/flow-automations/*` y `/api/v1/flow-vars/*` — motor de flujos.
 *
 * Camino canónico de ejecución de teclas (web y StreamDeck HW): resuelve el
 * botón en BD y ejecuta sus acciones + reglas como flujo (pressType
 * short/long/double/touch-start/touch-end). Funciona con la UI cerrada.
 */
import { jsonResponse } from './http-helpers';
import { resolveNavTargets } from '../sessions';
import type { ApiHandler } from './types';

const PRESS_TYPES = ['short', 'long', 'double', 'triple', 'touch-start', 'touch-end'] as const;

function normalizePressType(v: unknown): string {
  if (typeof v === 'string' && (PRESS_TYPES as readonly string[]).includes(v)) return v;
  if (v === 'press' || v === 'click') return 'short';
  return 'short';
}

/** Replica los side-effects de navegación de /actions/execute para presses. */
function broadcastNavSideEffects(services: any, flowResult: any, context: any): void {
  const results = flowResult?.results ?? [];
  const flat: any[] = [];
  const collect = (r: any) => {
    if (!r || typeof r !== 'object') return;
    if (r.kind === 'action' && r.result) flat.push(r.result);
    const sub = r.result?.results ?? r.result?.branches?.flatMap?.((b: any) => b.results) ?? [];
    for (const s of sub) collect(s);
  };
  for (const r of results) collect(r);

  for (const leaf of flat) {
    if (leaf && leaf.action === 'navigate_to_page' && leaf.pageId) {
      const origin = context?.deviceId ?? context?.device_id ?? context?.clientId ?? null;
      const targets = origin
        ? resolveNavTargets(context, String(origin))
        : { kind: 'all' as const };
      if (typeof services.wsManager.navigatePageTo === 'function') {
        services.wsManager.navigatePageTo({
          pageId: leaf.pageId,
          pageName: leaf.pageName,
          originDeviceId: origin ? String(origin) : null,
          targets,
          context,
        });
        try {
          (globalThis as any).__libredeckRunner?.handlePageLoad?.(leaf.pageId);
        } catch { /* mejor esfuerzo */ }
      } else {
        services.wsManager.broadcast('page.navigate', { pageId: leaf.pageId, pageName: leaf.pageName, context }, 'pages');
      }
    }
    if (leaf && leaf.action === 'navigate_to_profile' && leaf.profileId) {
      const origin = context?.deviceId ?? context?.device_id ?? context?.clientId ?? null;
      const targets = origin
        ? resolveNavTargets(context, String(origin))
        : { kind: 'all' as const };
      if (typeof services.wsManager.navigateProfileTo === 'function') {
        services.wsManager.navigateProfileTo({
          profileId: leaf.profileId,
          originDeviceId: origin ? String(origin) : null,
          targets,
          context,
        });
      } else {
        services.wsManager.broadcast('profile.navigate', { profileId: leaf.profileId, context }, 'profiles');
      }
    }
  }
}

export const handleFlows: ApiHandler = async (_req, { url, method, path, db, services }) => {
  const runner: any = services.actionRunner;

  // ---- Press canónico de tecla (web + HW) ----
  if (path === '/api/v1/buttons/press' && method === 'POST') {
    const body: any = await _req.json().catch(() => ({}));
    const pressType = normalizePressType(body.pressType ?? body.context?.pressType);
    const context = { ...(body.context ?? {}), pressType };
    let button: any = null;
    if (body.buttonId) {
      button = db.getButton(String(body.buttonId));
      if (!button) return jsonResponse({ error: 'Button not found' }, 404);
    } else if (body.pageId && body.position !== undefined) {
      const buttons = db.getButtonsByPage(String(body.pageId));
      button = buttons.find((b: any) => b.position === Number(body.position)) ?? null;
      if (!button) return jsonResponse({ success: true, empty: true, pressType });
    } else if (body.button) {
      button = body.button;
    } else {
      return jsonResponse({ error: 'buttonId o (pageId + position) requeridos' }, 400);
    }
    const result = await runner.executeButtonFlow(button, { ...context, timestamp: Date.now() });
    broadcastNavSideEffects(services, result, context);
    return jsonResponse({ ...result, pressType });
  }

  // ---- Ejecutar flujo ad-hoc o script ----
  if (path === '/api/v1/flows/execute' && method === 'POST') {
    const body: any = await _req.json().catch(() => ({}));
    const context = { ...(body.context ?? {}), timestamp: Date.now() };
    const timeout = typeof body.timeout === 'number' ? body.timeout : undefined;
    let result: any;
    if (body.scriptId) {
      result = await runner.executeFlow({ scriptId: String(body.scriptId), inputs: body.inputs ?? {}, outputVar: body.outputVar }, context, { timeout });
    } else if (Array.isArray(body.nodes)) {
      result = await runner.runFlowNodes('flow', 'api', body.nodes, context, { timeout });
    } else {
      return jsonResponse({ error: 'scriptId o nodes[] requeridos' }, 400);
    }
    broadcastNavSideEffects(services, result, context);
    return jsonResponse(result);
  }

  // ---- Cancelar ejecución ----
  if (path === '/api/v1/flows/cancel' && method === 'POST') {
    const body: any = await _req.json().catch(() => ({}));
    if (!body.runId) return jsonResponse({ error: 'runId requerido' }, 400);
    const cancelled = runner.cancelFlow(String(body.runId));
    return jsonResponse({ runId: body.runId, cancelled });
  }

  if (path === '/api/v1/flows/running' && method === 'GET') {
    return jsonResponse(runner.getFlowRunning());
  }

  if (path === '/api/v1/flows/stats' && method === 'GET') {
    return jsonResponse(runner.getFlowStats());
  }

  if (path === '/api/v1/flows/runs' && method === 'GET') {
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 100));
    return jsonResponse(runner.flowStore?.listRuns?.(limit) ?? []);
  }

  // ---- Scripts reutilizables ----
  if (path === '/api/v1/flow-scripts' && method === 'GET') {
    return jsonResponse(runner.listFlowScripts());
  }
  if (path === '/api/v1/flow-scripts' && method === 'POST') {
    const body: any = await _req.json().catch(() => ({}));
    try {
      return jsonResponse(runner.saveFlowScript(body), 201);
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
  if (path.startsWith('/api/v1/flow-scripts/')) {
    const id = decodeURIComponent(path.slice('/api/v1/flow-scripts/'.length));
    if (method === 'GET') {
      const s = runner.flowStore?.getScript?.(id);
      if (!s) return jsonResponse({ error: 'Script no encontrado' }, 404);
      return jsonResponse(s);
    }
    if (method === 'PUT') {
      const body: any = await _req.json().catch(() => ({}));
      try {
        return jsonResponse(runner.saveFlowScript({ ...body, id }));
      } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }
    if (method === 'DELETE') {
      runner.deleteFlowScript(id);
      return jsonResponse({ success: true });
    }
  }

  // ---- Automatizaciones globales ----
  if (path === '/api/v1/flow-automations' && method === 'GET') {
    return jsonResponse(runner.listAutomations());
  }
  if (path === '/api/v1/flow-automations' && method === 'POST') {
    const body: any = await _req.json().catch(() => ({}));
    try {
      return jsonResponse(runner.saveAutomation(body), 201);
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
  if (path === '/api/v1/flow-automations/emit' && method === 'POST') {
    const body: any = await _req.json().catch(() => ({}));
    if (!body.event) return jsonResponse({ error: 'event requerido' }, 400);
    runner.emitAutomationEvent(String(body.event), body.payload ?? {});
    return jsonResponse({ success: true, event: body.event });
  }
  if (path === '/api/v1/flow-automations/resync' && method === 'POST') {
    runner.resyncButtonAutomations?.();
    return jsonResponse({ success: true });
  }
  if (path.startsWith('/api/v1/flow-automations/')) {
    const id = decodeURIComponent(path.slice('/api/v1/flow-automations/'.length));
    if (method === 'GET') {
      const a = runner.flowStore?.getAutomation?.(id);
      if (!a) return jsonResponse({ error: 'Automatización no encontrada' }, 404);
      return jsonResponse(a);
    }
    if (method === 'PUT') {
      const body: any = await _req.json().catch(() => ({}));
      try {
        return jsonResponse(runner.saveAutomation({ ...body, id }));
      } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }
    if (method === 'DELETE') {
      runner.deleteAutomation(id);
      return jsonResponse({ success: true });
    }
  }

  // ---- Variables globales del motor ----
  if (path === '/api/v1/flow-vars' && method === 'GET') {
    return jsonResponse(runner.listFlowVars());
  }
  if (path.startsWith('/api/v1/flow-vars/')) {
    const name = decodeURIComponent(path.slice('/api/v1/flow-vars/'.length));
    if (method === 'GET') {
      const v = runner.getFlowVar(name);
      if (!v) return jsonResponse({ error: 'Variable no encontrada' }, 404);
      return jsonResponse(v);
    }
    if (method === 'PUT') {
      const body: any = await _req.json().catch(() => ({}));
      try {
        const changed = runner.setFlowVar(name, body.value);
        return jsonResponse(runner.getFlowVar(name) ?? { name, value: body.value, changed });
      } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }
    if (method === 'DELETE') {
      runner.deleteFlowVar(name);
      return jsonResponse({ success: true });
    }
  }

  return null;
};
