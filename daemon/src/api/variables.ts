/**
 * Rutas `/api/v1/variables*` — servicio daemon de variables tipadas.
 *
 * GET    /api/v1/variables[?scope&scopeId]        lista
 * POST   /api/v1/variables                        define {name,type?,scope?,scopeId?,value?,unavailable?,bindings?}
 * POST   /api/v1/variables/render                 renderiza {template,scope?,scopeId?}
 * GET    /api/v1/variables/:name[?scope&scopeId]  obtiene (con fallback global)
 * PUT    /api/v1/variables/:name                  {value?,type?,unavailable?,bindings?,scope?,scopeId?}
 * DELETE /api/v1/variables/:name[?scope&scopeId]  elimina
 * POST   /api/v1/variables/:name/toggle           toggle
 *
 * WS: cada cambio emite `variable.changed` / `variable.deleted` (topic `variables`).
 */
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';
import { getVariableStore, varToJSON } from '../variables/store';

function statusFor(error: unknown): number {
  const msg = error instanceof Error ? error.message : String(error);
  if (/ya existe/.test(msg)) return 409;
  if (/desconocida/i.test(msg)) return 404;
  if (/no pertenece|inválid|vacío|largo|reservado|scope|tipo|color|excede/i.test(msg)) return 400;
  return 500;
}

export const handleVariables: ApiHandler = async (req, { url, method, path }) => {
  if (!path.startsWith('/api/v1/variables')) return null;
  const store = getVariableStore();

  // POST /api/v1/variables/render (antes que :name)
  if (path === '/api/v1/variables/render' && method === 'POST') {
    try {
      const body = await req.json() as any;
      const template = String(body?.template ?? '');
      const result = store.render(template, body?.scope, body?.scopeId);
      return jsonResponse({ result });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, statusFor(error));
    }
  }

  // GET /api/v1/variables/render?template=… (atajo de lectura)
  if (path === '/api/v1/variables/render' && method === 'GET') {
    try {
      const template = url.searchParams.get('template') ?? '';
      const result = store.render(template,
        url.searchParams.get('scope') ?? undefined,
        url.searchParams.get('scopeId') ?? undefined);
      return jsonResponse({ result });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, statusFor(error));
    }
  }

  // GET /api/v1/variables · POST /api/v1/variables
  if (path === '/api/v1/variables') {
    if (method === 'GET') {
      const scope = url.searchParams.get('scope') ?? undefined;
      const scopeId = url.searchParams.get('scopeId') ?? undefined;
      try {
        const list = scope ? store.resolved(scope, scopeId) : store.list();
        return jsonResponse({ variables: list.map(varToJSON) });
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, statusFor(error));
      }
    }
    if (method === 'POST') {
      try {
        const body = await req.json() as any;
        const def = store.define({
          name: body?.name,
          type: body?.type,
          scope: body?.scope,
          scopeId: body?.scopeId,
          value: body?.value,
          unavailable: body?.unavailable,
          bindings: body?.bindings ?? null,
        });
        return jsonResponse({ variable: varToJSON(def) }, 201);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, statusFor(error));
      }
    }
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // /api/v1/variables/:name[/toggle]
  const rest = path.slice('/api/v1/variables/'.length);
  if (!rest || rest.includes('/__') || rest.startsWith('/')) return null;
  const [rawName, rawAction] = rest.split('/');
  if (!rawName || rawAction !== undefined && rawAction !== 'toggle') return null;
  const name = decodeURIComponent(rawName);
  const scope = url.searchParams.get('scope') ?? undefined;
  const scopeId = url.searchParams.get('scopeId') ?? undefined;

  if (rawAction === 'toggle') {
    if (method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
    try {
      const body = (method === 'POST' ? await req.json().catch(() => ({})) : {}) as any;
      const def = await store.toggle(name, {
        scope: body?.scope ?? scope,
        scopeId: body?.scopeId ?? scopeId,
        source: 'api',
      });
      return jsonResponse({ variable: varToJSON(def) });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, statusFor(error));
    }
  }

  if (method === 'GET') {
    try {
      const def = store.require(name, scope, scopeId);
      return jsonResponse({ variable: varToJSON(def) });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, statusFor(error));
    }
  }

  if (method === 'PUT') {
    try {
      const body = await req.json() as any;
      const addr = { scope: body?.scope ?? scope, scopeId: body?.scopeId ?? scopeId };
      let def = store.require(name, addr.scope, addr.scopeId);
      if (body?.type !== undefined && body.type !== def.type) {
        def = await store.retype(name, body.type, { ...addr, source: 'api' });
      }
      if (body?.bindings !== undefined) def = await store.setBindings(name, body.bindings ?? null, addr);
      if (body?.value !== undefined) {
        def = await store.set(name, body.value, { ...addr, source: 'api' });
      }
      if (body?.unavailable !== undefined && !!body.unavailable !== def.unavailable) {
        def = await store.setUnavailable(name, !!body.unavailable, addr);
      }
      return jsonResponse({ variable: varToJSON(def) });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, statusFor(error));
    }
  }

  if (method === 'DELETE') {
    try {
      const ok = await store.delete(name, scope, scopeId);
      if (!ok) return jsonResponse({ error: `Variable desconocida «${name}»` }, 404);
      return jsonResponse({ success: true, name });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, statusFor(error));
    }
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
};
