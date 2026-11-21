/**
 * Servidor MCP de LibreDeck (el daemon ES el servidor MCP).
 *
 * Transporte: Streamable HTTP en modo JSON — POST /api/v1/mcp acepta un
 * mensaje JSON-RPC 2.0 (u array batch) y responde JSON. Sin sesiones: sin
 * estado, cada request es independiente. Autenticación con Bearer
 * (tokens creados en Ajustes → MCP, ver mcp/tokens.ts).
 *
 * Control total: perfiles, páginas, botones (icono, textos, colores,
 * posición, acciones y su orden), plugins (instalar, activar, configurar,
 * actualizar, revertir, desinstalar), ajustes y logs. Cada tool declara
 * el scope que requiere y se filtra/valida contra los scopes del token.
 */
import { randomUUID } from 'node:crypto';
import type { ActionRunner } from '../action-runner';
import type { PluginLoader } from '../plugin-loader';
import type { DatabaseService } from '../db';
import type { WebSocketManager } from '../ws';
import { validateManifest } from '../plugin-system/validator';
import { hasScope } from './scopes';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_NAME = 'libredeck';
export const MCP_SERVER_VERSION = '2.0.0';

export interface McpAuth {
  tokenId: string;
  tokenName: string;
  scopes?: string[] | null;
}

export interface McpContext {
  pluginLoader: PluginLoader;
  actionRunner: ActionRunner;
  db: DatabaseService;
  /** Auth del token Bearer (ausente = acceso total, solo tests internos). */
  auth?: McpAuth | null;
  /** Broadcasts WS para que la UI se actualice en vivo (opcional). */
  ws?: Pick<
    WebSocketManager,
    | 'broadcast'
    | 'broadcastProfileUpdate'
    | 'broadcastPageCreated'
    | 'broadcastPageDeleted'
    | 'broadcastButtonUpdate'
    | 'broadcastButtonDeleted'
    | 'broadcastButtonsReordered'
    | 'broadcastActionStarted'
    | 'broadcastActionFinished'
    | 'broadcastActionError'
    | 'broadcastPluginInstalled'
    | 'broadcastPluginEnabled'
    | 'broadcastPluginUninstalled'
  > | null;
  /** Repintado del StreamDeck tras mutar botones/páginas (opcional). */
  repaint?: ((pageId: string) => void) | null;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

function ok(id: any, result: any) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function err(id: any, code: number, message: string, data?: any) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

interface ToolDef {
  name: string;
  description: string;
  /** Scope requerido (ver mcp/scopes.ts). */
  scope: string;
  inputSchema: any;
}

const S = (type: string, description?: string, extra?: any) => ({
  type,
  ...(description ? { description } : {}),
  ...(extra ?? {}),
});

const TOOL_DEFS: ToolDef[] = [
  // ---- Acciones ----
  {
    name: 'list_actions',
    description: 'Lista todas las acciones disponibles (plugins cargados) con sus schemas de parámetros.',
    scope: 'actions.read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'execute_action',
    description: 'Ejecuta una acción por su type (ej "shell.shell") con parameters. Devuelve el resultado o el error.',
    scope: 'actions.execute',
    inputSchema: {
      type: 'object',
      properties: {
        type: S('string', 'Tipo de acción, ej shell.shell'),
        parameters: S('object', 'Parámetros según el schema de la acción'),
      },
      required: ['type'],
    },
  },
  // ---- Estado ----
  {
    name: 'get_state',
    description: 'Estado completo: perfiles, perfil/página actuales, páginas, botones y plugins instalados.',
    scope: 'state.read',
    inputSchema: { type: 'object', properties: {} },
  },
  // ---- Perfiles ----
  {
    name: 'list_profiles',
    description: 'Lista todos los perfiles.',
    scope: 'profiles.read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_profile',
    description: 'Detalle de un perfil por id.',
    scope: 'profiles.read',
    inputSchema: { type: 'object', properties: { id: S('string') }, required: ['id'] },
  },
  {
    name: 'create_profile',
    description: 'Crea un perfil nuevo. Devuelve el perfil con su id.',
    scope: 'profiles.write',
    inputSchema: {
      type: 'object',
      properties: { name: S('string'), data: S('object', 'Metadatos/layout (opcional)') },
      required: ['name'],
    },
  },
  {
    name: 'update_profile',
    description: 'Renombra o cambia los datos de un perfil.',
    scope: 'profiles.write',
    inputSchema: {
      type: 'object',
      properties: { id: S('string'), name: S('string'), data: S('object', 'Se fusiona con los datos actuales') },
      required: ['id'],
    },
  },
  {
    name: 'delete_profile',
    description: 'Elimina un perfil (y sus páginas/botones).',
    scope: 'profiles.write',
    inputSchema: { type: 'object', properties: { id: S('string') }, required: ['id'] },
  },
  {
    name: 'set_current_profile',
    description: 'Activa un perfil (lo muestra el StreamDeck).',
    scope: 'profiles.write',
    inputSchema: { type: 'object', properties: { profile_id: S('string') }, required: ['profile_id'] },
  },
  // ---- Páginas ----
  {
    name: 'list_pages',
    description: 'Lista las páginas de un perfil (por defecto, el actual).',
    scope: 'pages.read',
    inputSchema: { type: 'object', properties: { profile_id: S('string', 'Opcional; por defecto el perfil actual') } },
  },
  {
    name: 'get_page',
    description: 'Detalle de una página por id.',
    scope: 'pages.read',
    inputSchema: { type: 'object', properties: { id: S('string') }, required: ['id'] },
  },
  {
    name: 'create_page',
    description: 'Crea una página en un perfil.',
    scope: 'pages.write',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: S('string'), name: S('string'),
        order_idx: S('number', 'Orden (opcional)'), is_folder: S('number', '1 = carpeta (opcional)'),
        data: S('object', 'Layout/grid (opcional)'),
      },
      required: ['profile_id', 'name'],
    },
  },
  {
    name: 'update_page',
    description: 'Renombra, reordena o cambia los datos de una página.',
    scope: 'pages.write',
    inputSchema: {
      type: 'object',
      properties: {
        id: S('string'), name: S('string'), order_idx: S('number'),
        is_folder: S('number'), data: S('object', 'Se fusiona con los datos actuales'),
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_page',
    description: 'Elimina una página (y sus botones).',
    scope: 'pages.write',
    inputSchema: { type: 'object', properties: { id: S('string') }, required: ['id'] },
  },
  {
    name: 'set_current_page',
    description: 'Muestra una página en el StreamDeck.',
    scope: 'pages.write',
    inputSchema: { type: 'object', properties: { page_id: S('string') }, required: ['page_id'] },
  },
  // ---- Botones ----
  {
    name: 'list_buttons',
    description: 'Lista los botones de una página (por defecto, la actual) con icono, textos y acciones.',
    scope: 'buttons.read',
    inputSchema: { type: 'object', properties: { page_id: S('string', 'Opcional; por defecto la página actual') } },
  },
  {
    name: 'get_button',
    description: 'Detalle de un botón por id.',
    scope: 'buttons.read',
    inputSchema: { type: 'object', properties: { id: S('string') }, required: ['id'] },
  },
  {
    name: 'create_button',
    description: 'Crea un botón. data admite label, textTop, textBottom, fontSize, icon, emoji, backgroundColor, textColor y actions.',
    scope: 'buttons.write',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: S('string'), position: S('number', 'Opcional; por defecto el primer hueco libre'),
        data: S('object', 'Contenido visual + actions (opcional)'),
      },
      required: ['page_id'],
    },
  },
  {
    name: 'update_button',
    description: 'Cambia el contenido de un botón: patch fusiona label/icon/textos/colores; position y page_id lo mueven.',
    scope: 'buttons.write',
    inputSchema: {
      type: 'object',
      properties: {
        id: S('string'),
        patch: S('object', 'Campos de data a fusionar: label, textTop, textBottom, fontSize, icon, emoji, backgroundColor, textColor'),
        position: S('number', 'Nueva posición (opcional)'),
        page_id: S('string', 'Mover a otra página (opcional)'),
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_button',
    description: 'Elimina un botón.',
    scope: 'buttons.write',
    inputSchema: { type: 'object', properties: { id: S('string') }, required: ['id'] },
  },
  {
    name: 'move_button',
    description: 'Mueve un botón a otra página y/o posición.',
    scope: 'buttons.write',
    inputSchema: {
      type: 'object',
      properties: { id: S('string'), page_id: S('string'), position: S('number', 'Opcional; por defecto primer hueco libre') },
      required: ['id', 'page_id'],
    },
  },
  {
    name: 'reorder_buttons',
    description: 'Reordena botones de una página de forma atómica (drag & drop). order: [{id, position}].',
    scope: 'buttons.write',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: S('string'),
        order: S('array', 'Lista de {id, position}', { items: { type: 'object' } }),
      },
      required: ['page_id', 'order'],
    },
  },
  {
    name: 'duplicate_button',
    description: 'Duplica un botón (misma o distinta página).',
    scope: 'buttons.write',
    inputSchema: {
      type: 'object',
      properties: { id: S('string'), page_id: S('string', 'Opcional; por defecto la misma'), position: S('number', 'Opcional') },
      required: ['id'],
    },
  },
  {
    name: 'press_button',
    description: 'Pulsa un botón como si fuera hardware: ejecuta sus acciones en orden y devuelve cada resultado.',
    scope: 'buttons.write',
    inputSchema: { type: 'object', properties: { button_id: S('string') }, required: ['button_id'] },
  },
  // ---- Acciones dentro de un botón ----
  {
    name: 'add_button_action',
    description: 'Añade una acción a un botón (al final o en index).',
    scope: 'buttons.write',
    inputSchema: {
      type: 'object',
      properties: {
        button_id: S('string'), type: S('string', 'Tipo de acción, ej shell.shell'),
        parameters: S('object', 'Parámetros (opcional)'), index: S('number', 'Posición (opcional)'),
      },
      required: ['button_id', 'type'],
    },
  },
  {
    name: 'update_button_action',
    description: 'Cambia el type y/o parameters de la acción en la posición index de un botón.',
    scope: 'buttons.write',
    inputSchema: {
      type: 'object',
      properties: {
        button_id: S('string'), index: S('number'),
        type: S('string', 'Nuevo type (opcional)'), parameters: S('object', 'Nuevos parameters (opcional)'),
      },
      required: ['button_id', 'index'],
    },
  },
  {
    name: 'remove_button_action',
    description: 'Quita la acción en la posición index de un botón.',
    scope: 'buttons.write',
    inputSchema: {
      type: 'object',
      properties: { button_id: S('string'), index: S('number') },
      required: ['button_id', 'index'],
    },
  },
  {
    name: 'reorder_button_actions',
    description: 'Reordena las acciones de un botón. order es la permutación de índices (ej [2,0,1]).',
    scope: 'buttons.write',
    inputSchema: {
      type: 'object',
      properties: { button_id: S('string'), order: S('array', 'Permutación de índices', { items: { type: 'number' } }) },
      required: ['button_id', 'order'],
    },
  },
  // ---- Plugins ----
  {
    name: 'get_plugin_template',
    description: 'Devuelve la plantilla mínima de plugin externo (manifest.json + main.js de ejemplo) para andamiar un plugin nuevo.',
    scope: 'plugins.read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'validate_manifest',
    description: 'Valida un manifest de plugin contra el contrato de LibreDeck. Devuelve valid, errors y warnings.',
    scope: 'plugins.read',
    inputSchema: {
      type: 'object',
      properties: { manifest: S('object') },
      required: ['manifest'],
    },
  },
  {
    name: 'install_plugin_from_git',
    description: '(Legacy, usa install_plugin) Instala o actualiza un plugin desde un repo git.',
    scope: 'plugins.install',
    inputSchema: {
      type: 'object',
      properties: { url: S('string'), ref: S('string', 'Rama, tag o commit (opcional)') },
      required: ['url'],
    },
  },
  {
    name: 'install_plugin',
    description: 'Instala un plugin desde repo git (url), ZIP por URL (url .zip) o ZIP local del servidor (zipPath).',
    scope: 'plugins.install',
    inputSchema: {
      type: 'object',
      properties: {
        url: S('string', 'Repo git o URL de .zip (opcional si hay zipPath)'),
        zipPath: S('string', 'Ruta local del servidor a un .zip (opcional)'),
        ref: S('string', 'Rama/tag/commit para git (opcional)'),
        force: S('boolean', 'Forzar reinstalación (opcional)'),
      },
    },
  },
  {
    name: 'list_plugins',
    description: 'Lista plugins instalados con versión, estado (active/error/disabled) y último error.',
    scope: 'plugins.read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_plugin',
    description: 'Detalle y estado de un plugin por id.',
    scope: 'plugins.read',
    inputSchema: { type: 'object', properties: { plugin_id: S('string') }, required: ['plugin_id'] },
  },
  {
    name: 'enable_plugin',
    description: 'Activa un plugin desactivado.',
    scope: 'plugins.manage',
    inputSchema: { type: 'object', properties: { plugin_id: S('string') }, required: ['plugin_id'] },
  },
  {
    name: 'disable_plugin',
    description: 'Desactiva un plugin (los built-in no se pueden desinstalar, pero sí desactivar).',
    scope: 'plugins.manage',
    inputSchema: { type: 'object', properties: { plugin_id: S('string') }, required: ['plugin_id'] },
  },
  {
    name: 'reload_plugin',
    description: 'Recarga un plugin del disco.',
    scope: 'plugins.manage',
    inputSchema: { type: 'object', properties: { plugin_id: S('string') }, required: ['plugin_id'] },
  },
  {
    name: 'rollback_plugin',
    description: 'Revierte un plugin a su versión previa (si existe backup).',
    scope: 'plugins.manage',
    inputSchema: { type: 'object', properties: { plugin_id: S('string') }, required: ['plugin_id'] },
  },
  {
    name: 'update_plugin',
    description: 'Actualiza un plugin desde su origen (o desde url/ref indicados).',
    scope: 'plugins.install',
    inputSchema: {
      type: 'object',
      properties: { plugin_id: S('string'), url: S('string', 'Opcional'), ref: S('string', 'Opcional'), force: S('boolean', 'Opcional') },
      required: ['plugin_id'],
    },
  },
  {
    name: 'uninstall_plugin',
    description: 'Desinstala un plugin (los built-in están protegidos).',
    scope: 'plugins.install',
    inputSchema: { type: 'object', properties: { plugin_id: S('string') }, required: ['plugin_id'] },
  },
  {
    name: 'get_plugin_settings',
    description: 'Devuelve schema, valores e instrucciones de los ajustes generales de un plugin.',
    scope: 'plugins.manage',
    inputSchema: { type: 'object', properties: { plugin_id: S('string') }, required: ['plugin_id'] },
  },
  {
    name: 'save_plugin_settings',
    description: 'Guarda ajustes generales de un plugin (mapa clave → valor; valor "" o null elimina la clave).',
    scope: 'plugins.manage',
    inputSchema: {
      type: 'object',
      properties: { plugin_id: S('string'), values: S('object', 'Mapa clave → valor') },
      required: ['plugin_id', 'values'],
    },
  },
  // ---- Ajustes y logs ----
  {
    name: 'list_settings',
    description: 'Lista todos los ajustes (clave → valor) del daemon.',
    scope: 'settings.read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_setting',
    description: 'Lee un ajuste por clave.',
    scope: 'settings.read',
    inputSchema: { type: 'object', properties: { key: S('string') }, required: ['key'] },
  },
  {
    name: 'set_setting',
    description: 'Escribe un ajuste (clave → valor).',
    scope: 'settings.write',
    inputSchema: {
      type: 'object',
      properties: { key: S('string'), value: S(['string', 'number', 'boolean', 'object'] as any, 'Nuevo valor') },
      required: ['key', 'value'],
    },
  },
  {
    name: 'get_logs',
    description: 'Lee el registro del daemon (incluye la auditoría de acciones MCP).',
    scope: 'logs.read',
    inputSchema: {
      type: 'object',
      properties: { limit: S('number', 'Máx. entradas, 1-500 (opcional)'), level: S('string', 'Filtrar por nivel (opcional)') },
    },
  },
];

/** Scopes que implican escritura (auditoría en logs). */
const WRITE_SCOPES = new Set([
  'profiles.write', 'pages.write', 'buttons.write',
  'actions.execute', 'plugins.manage', 'plugins.install', 'settings.write',
]);

function parseData(data: any): any {
  if (data === null || data === undefined) return {};
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch { return {}; }
  }
  return data;
}

function reqStr(args: any, key: string): string {
  const v = args?.[key];
  if (!v || typeof v !== 'string') throw new Error(`${key} requerido (string)`);
  return v;
}

/** Primera posición libre de una página (0..N). */
function firstFreePosition(db: DatabaseService, pageId: string): number {
  const used = new Set(db.getButtonsByPage(pageId).map((b) => b.position));
  let pos = 0;
  while (used.has(pos)) pos++;
  return pos;
}

function audit(ctx: McpContext, tool: string, scope: string, args: any): void {
  if (!WRITE_SCOPES.has(scope)) return;
  try {
    ctx.db.addLog({
      level: 'info',
      message: `mcp:${tool}`,
      meta: {
        token: ctx.auth?.tokenName ?? 'internal',
        tokenId: ctx.auth?.tokenId ?? null,
        args: JSON.stringify(args ?? {}).slice(0, 2000),
      },
      ts: Date.now(),
    });
  } catch { /* auditoría best-effort */ }
}

function repaint(ctx: McpContext, pageId?: string | null): void {
  if (pageId) {
    try { ctx.repaint?.(pageId); } catch { /* noop */ }
  }
}

async function callTool(name: string, args: any, ctx: McpContext) {
  const { pluginLoader, actionRunner, db } = ctx;
  switch (name) {
    // ---- acciones ----
    case 'list_actions': {
      const actions = Array.from(pluginLoader.getPluginActions().entries()).map(([fullId, a]: any) => ({
        type: fullId,
        name: a.name ?? fullId,
        description: a.description ?? '',
        schema: a.schema ?? null,
      }));
      return { actions };
    }
    case 'execute_action': {
      const type = args?.type;
      if (!type || typeof type !== 'string') throw new Error('type requerido');
      const actionId = randomUUID();
      ctx.ws?.broadcastActionStarted(actionId, { action: { type, parameters: args?.parameters ?? {} } });
      try {
        const result = await actionRunner.executeAction(
          { type, parameters: args?.parameters ?? {} },
          { timestamp: Date.now(), pressType: 'short' }
        );
        if (result?.success) ctx.ws?.broadcastActionFinished(actionId, result);
        else ctx.ws?.broadcastActionError(actionId, result?.error);
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.ws?.broadcastActionError(actionId, msg);
        throw e;
      }
    }
    // ---- estado ----
    case 'get_state': {
      const profileId = db.getSetting('current.profile_id');
      const pageId = db.getSetting('current.page_id');
      const profile = profileId ? db.getProfile(profileId) : null;
      const profiles = db.getProfiles();
      const pages = profile ? db.getPagesByProfile(profile.id) : [];
      const page = pageId ? db.getPage(pageId) : null;
      const buttons = page ? db.getButtonsByPage(page.id) : [];
      const plugins = pluginLoader.listDetailed().map((p: any) => ({
        id: p.id, version: p.version, enabled: p.enabled, loaded: p.loaded, status: p.status,
      }));
      return {
        // compat con 1.x
        profile: profile ? { id: profile.id, name: profile.name } : null,
        page: page ? { id: (page as any).id, name: (page as any).name } : null,
        buttons: (buttons as any[]).map((b) => ({ id: b.id, position: b.position, data: b.data })),
        plugins,
        // extendido
        current: { profileId: profileId || null, pageId: pageId || null },
        profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
        pages: pages.map((p: any) => ({ id: p.id, name: p.name, order_idx: p.order_idx, is_folder: p.is_folder })),
        counts: { profiles: profiles.length, pages: pages.length, buttons: buttons.length, plugins: plugins.length },
      };
    }
    // ---- perfiles ----
    case 'list_profiles':
      return { profiles: db.getProfiles().map((p) => ({ ...p, data: parseData(p.data) })) };
    case 'get_profile': {
      const p = db.getProfile(reqStr(args, 'id'));
      if (!p) throw new Error('Perfil no encontrado');
      return { profile: { ...p, data: parseData(p.data) } };
    }
    case 'create_profile': {
      const created = db.createProfile({ id: randomUUID(), name: reqStr(args, 'name'), data: args?.data ?? {} });
      ctx.ws?.broadcastProfileUpdate(created.id, created);
      return { profile: { ...created, data: parseData(created.data) } };
    }
    case 'update_profile': {
      const id = reqStr(args, 'id');
      const existing = db.getProfile(id);
      if (!existing) throw new Error('Perfil no encontrado');
      const updates: any = {};
      if (args?.name !== undefined) updates.name = reqStr(args, 'name');
      if (args?.data !== undefined) updates.data = { ...parseData(existing.data), ...(parseData(args.data)) };
      db.updateProfile(id, updates);
      const updated = db.getProfile(id);
      ctx.ws?.broadcastProfileUpdate(id, updated);
      return { profile: updated ? { ...updated, data: parseData(updated.data) } : null };
    }
    case 'delete_profile': {
      const id = reqStr(args, 'id');
      if (!db.getProfile(id)) throw new Error('Perfil no encontrado');
      db.deleteProfile(id);
      ctx.ws?.broadcast('profile.deleted', { profileId: id }, 'profiles');
      return { success: true, profileId: id };
    }
    case 'set_current_profile': {
      const profileId = reqStr(args, 'profile_id');
      if (!db.getProfile(profileId)) throw new Error('Perfil no encontrado');
      db.setCurrentProfile(profileId);
      ctx.ws?.broadcast('profile.navigate', { profileId }, 'profiles');
      return { success: true, profileId };
    }
    // ---- páginas ----
    case 'list_pages': {
      const profileId = args?.profile_id ?? db.getSetting('current.profile_id');
      if (!profileId) throw new Error('Sin perfil actual: indica profile_id');
      return { pages: db.getPagesByProfile(profileId).map((p: any) => ({ ...p, data: parseData(p.data) })) };
    }
    case 'get_page': {
      const p = db.getPage(reqStr(args, 'id'));
      if (!p) throw new Error('Página no encontrada');
      return { page: { ...(p as any), data: parseData((p as any).data) } };
    }
    case 'create_page': {
      const page = {
        id: randomUUID(),
        profile_id: reqStr(args, 'profile_id'),
        name: reqStr(args, 'name'),
        order_idx: Number(args?.order_idx ?? 0),
        is_folder: Number(args?.is_folder ?? 0),
        data: args?.data ?? {},
      };
      db.createPage(page as any);
      ctx.ws?.broadcastPageCreated(page.id, page);
      return { page };
    }
    case 'update_page': {
      const id = reqStr(args, 'id');
      const existing = db.getPage(id) as any;
      if (!existing) throw new Error('Página no encontrada');
      const updates: any = {};
      if (args?.name !== undefined) updates.name = reqStr(args, 'name');
      if (args?.order_idx !== undefined) updates.order_idx = Number(args.order_idx);
      if (args?.is_folder !== undefined) updates.is_folder = Number(args.is_folder);
      if (args?.data !== undefined) updates.data = { ...parseData(existing.data), ...parseData(args.data) };
      db.updatePage(id, updates);
      const updated = db.getPage(id);
      ctx.ws?.broadcast('page.updated', { pageId: id, page: updated }, 'pages');
      return { page: updated };
    }
    case 'delete_page': {
      const id = reqStr(args, 'id');
      const existing = db.getPage(id);
      if (!existing) throw new Error('Página no encontrada');
      db.deletePage(id);
      ctx.ws?.broadcastPageDeleted(id);
      return { success: true, pageId: id };
    }
    case 'set_current_page': {
      const pageId = reqStr(args, 'page_id');
      const page = db.getPage(pageId) as any;
      if (!page) throw new Error('Página no encontrada');
      db.setCurrentPage(pageId);
      ctx.ws?.broadcast('page.navigate', { pageId, pageName: page.name }, 'pages');
      repaint(ctx, pageId);
      return { success: true, pageId };
    }
    // ---- botones ----
    case 'list_buttons': {
      const pageId = args?.page_id ?? db.getSetting('current.page_id');
      if (!pageId) throw new Error('Sin página actual: indica page_id');
      return { buttons: db.getButtonsByPage(pageId) };
    }
    case 'get_button': {
      const b = db.getButton(reqStr(args, 'id'));
      if (!b) throw new Error('Botón no encontrado');
      return { button: b };
    }
    case 'create_button': {
      const pageId = reqStr(args, 'page_id');
      if (!db.getPage(pageId)) throw new Error('Página no encontrada');
      const position = args?.position !== undefined ? Number(args.position) : firstFreePosition(db, pageId);
      if (!Number.isInteger(position) || position < 0) throw new Error('position inválida');
      const button = { id: randomUUID(), page_id: pageId, position, data: args?.data ?? {} };
      try {
        db.createButton(button as any);
      } catch (e) {
        throw new Error(`No se pudo crear el botón (¿posición ${position} ocupada?): ${e instanceof Error ? e.message : String(e)}`);
      }
      ctx.ws?.broadcast('button.created', { buttonId: button.id, button }, 'buttons');
      repaint(ctx, pageId);
      return { button: db.getButton(button.id) };
    }
    case 'update_button':
    case 'move_button': {
      const id = reqStr(args, 'id');
      const existing = db.getButton(id);
      if (!existing) throw new Error('Botón no encontrado');
      const fromPage = existing.page_id;
      const targetPage = args?.page_id ?? fromPage;
      if (args?.page_id && !db.getPage(targetPage)) throw new Error('Página destino no encontrada');
      let data = existing.data;
      if (args?.patch !== undefined) {
        if (!args.patch || typeof args.patch !== 'object') throw new Error('patch debe ser un objeto');
        const ALLOWED = ['label', 'textTop', 'textBottom', 'fontSize', 'icon', 'emoji', 'backgroundColor', 'textColor'];
        const patch: any = {};
        for (const k of ALLOWED) if (args.patch[k] !== undefined) patch[k] = args.patch[k];
        data = { ...(parseData(data)), ...patch };
      }
      const position = args?.position !== undefined
        ? Number(args.position)
        : (targetPage !== fromPage ? firstFreePosition(db, targetPage) : existing.position);
      if (!Number.isInteger(position) || position < 0) throw new Error('position inválida');
      try {
        if (targetPage !== fromPage) db.moveButton(id, targetPage, position);
        else db.updateButtonComplete(id, { data, position });
      } catch (e) {
        throw new Error(`No se pudo mover/actualizar (¿posición ${position} ocupada?): ${e instanceof Error ? e.message : String(e)}`);
      }
      const updated = db.getButton(id);
      ctx.ws?.broadcastButtonUpdate(id, updated);
      repaint(ctx, fromPage);
      repaint(ctx, targetPage);
      return { button: updated };
    }
    case 'delete_button': {
      const id = reqStr(args, 'id');
      const existing = db.getButton(id);
      if (!existing) throw new Error('Botón no encontrado');
      db.deleteButton(id);
      ctx.ws?.broadcastButtonDeleted(id);
      repaint(ctx, existing.page_id);
      return { success: true, buttonId: id };
    }
    case 'reorder_buttons': {
      const pageId = reqStr(args, 'page_id');
      if (!Array.isArray(args?.order)) throw new Error('order requerido (array de {id, position})');
      const updated = db.reorderButtons(pageId, args.order);
      ctx.ws?.broadcastButtonsReordered(pageId, updated);
      repaint(ctx, pageId);
      return { success: true, buttons: updated };
    }
    case 'duplicate_button': {
      const id = reqStr(args, 'id');
      const existing = db.getButton(id);
      if (!existing) throw new Error('Botón no encontrado');
      const targetPage = args?.page_id ?? existing.page_id;
      if (!db.getPage(targetPage)) throw new Error('Página destino no encontrada');
      const position = args?.position !== undefined ? Number(args.position) : firstFreePosition(db, targetPage);
      const copy = { id: randomUUID(), page_id: targetPage, position, data: structuredClone(parseData(existing.data)) };
      try {
        db.createButton(copy as any);
      } catch (e) {
        throw new Error(`No se pudo duplicar (¿posición ${position} ocupada?): ${e instanceof Error ? e.message : String(e)}`);
      }
      ctx.ws?.broadcast('button.created', { buttonId: copy.id, button: copy }, 'buttons');
      repaint(ctx, targetPage);
      return { button: db.getButton(copy.id) };
    }
    case 'press_button': {
      const buttonId = reqStr(args, 'button_id');
      const existing = db.getButton(buttonId);
      if (!existing) throw new Error('Botón no encontrado');
      const actions = parseData(existing.data)?.actions ?? [];
      const results: any[] = [];
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        try {
          const r = await actionRunner.executeAction(
            { type: a.type, parameters: a.parameters ?? {} },
            { buttonId, timestamp: Date.now(), pressType: 'short' } as any
          );
          results.push({ index: i, type: a.type, success: r?.success !== false, result: r });
        } catch (e) {
          results.push({ index: i, type: a?.type, success: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { buttonId, executed: results.length, results };
    }
    // ---- acciones dentro de un botón ----
    case 'add_button_action':
    case 'update_button_action':
    case 'remove_button_action':
    case 'reorder_button_actions': {
      const buttonId = reqStr(args, name === 'add_button_action' ? 'button_id' : 'button_id');
      const existing = db.getButton(buttonId);
      if (!existing) throw new Error('Botón no encontrado');
      const data = { ...parseData(existing.data) };
      const actions = Array.isArray(data.actions) ? [...data.actions] : [];
      if (name === 'add_button_action') {
        const type = reqStr(args, 'type');
        if (!pluginLoader.getPluginActions().has(type)) {
          throw new Error(`Tipo de acción desconocido: ${type} (usa list_actions para ver los disponibles)`);
        }
        const entry = { type, parameters: args?.parameters ?? {} };
        const index = args?.index !== undefined ? Number(args.index) : actions.length;
        if (!Number.isInteger(index) || index < 0 || index > actions.length) throw new Error('index fuera de rango');
        actions.splice(index, 0, entry);
      } else if (name === 'update_button_action') {
        const index = Number(args?.index);
        if (!Number.isInteger(index) || index < 0 || index >= actions.length) throw new Error('index fuera de rango');
        const cur = { ...(actions[index] ?? {}) };
        if (args?.type !== undefined) {
          if (!pluginLoader.getPluginActions().has(args.type)) throw new Error(`Tipo de acción desconocido: ${args.type}`);
          cur.type = args.type;
        }
        if (args?.parameters !== undefined) cur.parameters = args.parameters;
        actions[index] = cur;
      } else if (name === 'remove_button_action') {
        const index = Number(args?.index);
        if (!Number.isInteger(index) || index < 0 || index >= actions.length) throw new Error('index fuera de rango');
        actions.splice(index, 1);
      } else {
        const order = args?.order;
        if (!Array.isArray(order) || order.length !== actions.length) {
          throw new Error(`order debe ser una permutación de los ${actions.length} índices actuales`);
        }
        const sorted = [...order].map(Number).sort((a, b) => a - b);
        if (sorted.some((v, i) => v !== i)) throw new Error('order debe contener cada índice exactamente una vez');
        const reordered = order.map((i: number) => actions[Number(i)]);
        actions.length = 0;
        actions.push(...reordered);
      }
      data.actions = actions;
      db.updateButton(buttonId, data);
      const updated = db.getButton(buttonId);
      ctx.ws?.broadcastButtonUpdate(buttonId, updated);
      repaint(ctx, existing.page_id);
      return { button: updated };
    }
    // ---- plugins ----
    case 'get_plugin_template': {
      try {
        const base = new URL('../plugins/external-template/', import.meta.url);
        const manifest = await Bun.file(new URL('manifest.json', base)).text();
        const main = await Bun.file(new URL('main.js', base)).text();
        const readme = await Bun.file(new URL('README.md', base)).text().catch(() => '');
        return { manifest: JSON.parse(manifest), main, readme };
      } catch (e) {
        throw new Error(`Plantilla no disponible: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    case 'validate_manifest': {
      return validateManifest(args?.manifest);
    }
    case 'install_plugin_from_git':
    case 'install_plugin': {
      let id: string;
      if (name === 'install_plugin_from_git') {
        if (!args?.url) throw new Error('url requerida');
        id = await pluginLoader.installPluginFromGit(args.url, { ref: args.ref });
      } else {
        const { url, zipPath, ref, force } = args ?? {};
        if (zipPath) id = await (pluginLoader as any).installPluginFromZip(zipPath, { force: !!force });
        else if (!url) throw new Error('url o zipPath requerido');
        else if (/\.zip(\?|#|$)/i.test(url)) id = await pluginLoader.installPluginFromUrl(url, { force: !!force });
        else id = await pluginLoader.installPluginFromGit(url, { ref, force: !!force });
      }
      const plugin = db.getPlugin(id);
      ctx.ws?.broadcastPluginInstalled(id, plugin);
      return { pluginId: id, status: pluginLoader.getStatus(id) };
    }
    case 'list_plugins': {
      return { plugins: pluginLoader.listDetailed() };
    }
    case 'get_plugin': {
      const status = pluginLoader.getStatus(reqStr(args, 'plugin_id'));
      if (!status) throw new Error('Plugin no encontrado');
      return { plugin: status };
    }
    case 'enable_plugin': {
      const pluginId = reqStr(args, 'plugin_id');
      const okEnabled = await pluginLoader.enablePlugin(pluginId);
      if (!okEnabled) throw new Error(`No se pudo habilitar ${pluginId}`);
      return { success: true, pluginId, status: pluginLoader.getStatus(pluginId) };
    }
    case 'disable_plugin': {
      const pluginId = reqStr(args, 'plugin_id');
      await pluginLoader.disablePlugin(pluginId);
      ctx.ws?.broadcastPluginEnabled(pluginId, false);
      return { success: true, pluginId, status: pluginLoader.getStatus(pluginId) };
    }
    case 'reload_plugin': {
      const pluginId = reqStr(args, 'plugin_id');
      const okReload = await pluginLoader.reloadPlugin(pluginId);
      return { success: okReload, pluginId, status: pluginLoader.getStatus(pluginId) };
    }
    case 'rollback_plugin': {
      const pluginId = reqStr(args, 'plugin_id');
      const okRollback = await pluginLoader.rollbackPlugin(pluginId);
      return { success: okRollback, pluginId, status: pluginLoader.getStatus(pluginId) };
    }
    case 'update_plugin': {
      const pluginId = reqStr(args, 'plugin_id');
      const id = await pluginLoader.updatePlugin(pluginId, { url: args?.url, ref: args?.ref, force: !!args?.force });
      const plugin = db.getPlugin(id);
      ctx.ws?.broadcastPluginInstalled(id, plugin);
      return { success: true, pluginId: id, plugin };
    }
    case 'uninstall_plugin': {
      const pluginId = reqStr(args, 'plugin_id');
      await pluginLoader.uninstallPlugin(pluginId);
      ctx.ws?.broadcastPluginUninstalled(pluginId);
      return { success: true, pluginId };
    }
    case 'get_plugin_settings': {
      return pluginLoader.getPluginSettingsBundle(reqStr(args, 'plugin_id'));
    }
    case 'save_plugin_settings': {
      const pluginId = reqStr(args, 'plugin_id');
      if (!args?.values || typeof args.values !== 'object') throw new Error('values requerido (objeto)');
      const values = await pluginLoader.savePluginSettings(pluginId, args.values);
      return { success: true, pluginId, values };
    }
    // ---- ajustes y logs ----
    case 'list_settings':
      return { settings: db.getAllSettings() };
    case 'get_setting': {
      const key = reqStr(args, 'key');
      return { key, value: db.getSetting(key) };
    }
    case 'set_setting': {
      const key = reqStr(args, 'key');
      if (args?.value === undefined) throw new Error('value requerido');
      const value = typeof args.value === 'string' ? args.value : JSON.stringify(args.value);
      db.setSetting(key, value);
      return { key, value: db.getSetting(key) };
    }
    case 'get_logs': {
      const limit = Math.min(Math.max(Number(args?.limit ?? 100), 1), 500);
      return { logs: db.getLogs(limit, args?.level) };
    }
    default:
      throw new Error(`Tool desconocida: ${name}`);
  }
}

function toolDef(name: string): ToolDef | undefined {
  return TOOL_DEFS.find((t) => t.name === name);
}

function handleOne(msg: JsonRpcRequest, ctx: McpContext): Promise<any> {
  const id = msg?.id ?? null;
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return Promise.resolve(err(id, -32600, 'Invalid Request'));
  }
  switch (msg.method) {
    case 'initialize':
      return Promise.resolve(ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      }));
    case 'notifications/initialized':
      return Promise.resolve(null); // notificación: sin respuesta
    case 'ping':
      return Promise.resolve(ok(id, {}));
    case 'tools/list': {
      const tools = TOOL_DEFS.filter((t) => hasScope(ctx.auth, t.scope)).map((t) => ({
        name: t.name,
        description: `${t.description} [permiso: ${t.scope}]`,
        inputSchema: t.inputSchema,
      }));
      return Promise.resolve(ok(id, { tools }));
    }
    case 'tools/call': {
      const { name, arguments: args } = msg.params ?? {};
      if (!name) return Promise.resolve(err(id, -32602, 'name requerido'));
      const def = toolDef(name);
      if (!def) {
        return Promise.resolve(ok(id, {
          content: [{ type: 'text', text: `Error: Tool desconocida: ${name}` }],
          isError: true,
        }));
      }
      if (!hasScope(ctx.auth, def.scope)) {
        return Promise.resolve(ok(id, {
          content: [{ type: 'text', text: `Error: permiso denegado (esta tool requiere el permiso "${def.scope}")` }],
          isError: true,
        }));
      }
      return callTool(name, args ?? {}, ctx).then(
        (data) => {
          audit(ctx, name, def.scope, args ?? {});
          return ok(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
        },
        (e) => ok(id, { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true })
      );
    }
    default:
      return Promise.resolve(err(id, -32601, `Method not found: ${msg.method}`));
  }
}

export async function handleMcpBody(body: unknown, ctx: McpContext): Promise<{ status: number; payload: any }> {
  if (Array.isArray(body)) {
    const out: any[] = [];
    for (const m of body) {
      const r = await handleOne(m, ctx);
      if (r !== null) out.push(r);
    }
    return { status: 200, payload: out };
  }
  if (!body || typeof body !== 'object') {
    return { status: 400, payload: err(null, -32700, 'Parse error: se esperaba objeto JSON-RPC') };
  }
  const r = await handleOne(body as JsonRpcRequest, ctx);
  if (r === null) return { status: 202, payload: null };
  return { status: 200, payload: r };
}
