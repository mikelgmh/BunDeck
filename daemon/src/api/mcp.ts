/**
 * Rutas MCP: el daemon ES el servidor MCP (Streamable HTTP + JSON).
 * `POST /api/v1/mcp` exige `Authorization: Bearer <token de Ajustes → MCP>`.
 */
import { handleMcpBody } from '../mcp/server';
import {
  listMcpTokens,
  createMcpToken,
  updateMcpToken,
  revokeMcpToken,
  verifyMcpToken,
  bearerFromHeaders,
} from '../mcp/tokens';
import { MCP_SCOPES } from '../mcp/scopes';
import { streamDeckDriver } from '../hw-driver/streamdeck-driver';
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';

export const handleMcp: ApiHandler = async (_req, { method, path, db, services }) => {
  if (path === '/api/v1/mcp') {
    if (method === 'GET') {
      return jsonResponse({
        name: 'libredeck',
        protocol: 'mcp-streamable-http-json',
        endpoint: '/api/v1/mcp',
        auth: 'Bearer (token de Ajustes → MCP)',
        howto:
          'Crea un token en Ajustes → MCP (marca sus permisos) y conéctalo desde tu cliente MCP. Control total: perfiles, páginas, botones, acciones, plugins, ajustes y logs.',
      });
    }
    if (method === 'POST') {
      const secret = bearerFromHeaders(_req);
      const token = verifyMcpToken(db, secret);
      if (!token) {
        return jsonResponse({ error: 'No autorizado: usa Authorization: Bearer <token MCP>' }, 401);
      }
      try {
        const body = await _req.json();
        const { status, payload } = await handleMcpBody(body, {
          pluginLoader: services.pluginLoader,
          actionRunner: services.actionRunner,
          db,
          auth: { tokenId: token.id, tokenName: token.name, scopes: token.scopes },
          ws: services.wsManager,
          repaint: (pageId: string) => {
            if (streamDeckDriver.isConnected()) {
              // Como las rutas REST: solo refrescar si el HW ya muestra esa
              // página. Un repintado incondicional (scheduleUpdateFromPage)
              // SECUESTRABA la sesión del deck físico: editar por MCP una
              // página de otro tamaño (p.ej. XL 8×4) la pintaba en un HW de
              // 5×3 y dejaba la sesión clavada en ella.
              streamDeckDriver.scheduleRefreshIfVisible(pageId);
            }
          },
        });
        if (status === 202) return new Response(null, { status: 202 });
        return jsonResponse(payload, status);
      } catch (e) {
        return jsonResponse(
          { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
          400
        );
      }
    }
  }

  // Catálogo de permisos marcables al crear/editar un token MCP (sin auth: metadatos públicos).
  if (path === '/api/v1/mcp/scopes') {
    if (method === 'GET') {
      return jsonResponse({ scopes: MCP_SCOPES });
    }
  }

  if (path === '/api/v1/mcp/tokens') {
    if (method === 'GET') {
      return jsonResponse({ tokens: listMcpTokens(db) });
    }
    if (method === 'POST') {
      const body = await _req.json().catch(() => ({}));
      try {
        const { record, secret } = createMcpToken(db, body?.name ?? '', body?.scopes);
        return jsonResponse({ token: record, secret, warning: 'Guárdalo: el secreto no se vuelve a mostrar' }, 201);
      } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }
  }

  if (path.startsWith('/api/v1/mcp/tokens/')) {
    const tokenId = decodeURIComponent(path.split('/')[5] ?? '');
    if (method === 'PUT') {
      const body = await _req.json().catch(() => ({}));
      try {
        const record = updateMcpToken(db, tokenId, { name: body?.name, scopes: body?.scopes });
        if (!record) return jsonResponse({ error: 'Token not found' }, 404);
        return jsonResponse({ success: true, token: record });
      } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }
    if (method === 'DELETE') {
      const ok = revokeMcpToken(db, tokenId);
      if (!ok) return jsonResponse({ error: 'Token not found' }, 404);
      return jsonResponse({ success: true });
    }
  }

  return null;
};
