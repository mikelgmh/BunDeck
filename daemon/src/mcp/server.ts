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
import { pushHistory, listHistory, peekUndo, markUndone, clearHistory } from './history';

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
    description: 'Ejecuta una acción por su type (ej "shell.shell") con parameters. Las acciones sensibles (shell/http/power/system) exigen confirm:true.',
    scope: 'actions.execute',
    inputSchema: {
      type: 'object',
      properties: {
        type: S('string', 'Tipo de acción, ej shell.shell'),
        parameters: S('object', 'Parámetros según el schema de la acción'),
        confirm: S('boolean', 'Obligatorio (true) si la acción es sensible: shell/http/power/system'),
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
    description: 'Pulsa un botón como si fuera hardware: ejecuta sus acciones en orden y devuelve cada resultado. Si contiene acciones sensibles exige confirm:true.',
    scope: 'buttons.write',
    inputSchema: { type: 'object', properties: { button_id: S('string'), confirm: S('boolean', 'Obligatorio (true) si el botón tiene acciones sensibles') }, required: ['button_id'] },
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
  // ---- Widgets ----
  {
    name: 'list_widgets',
    description: 'Lista todos los widgets.',
    scope: 'widgets.read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_widget',
    description: 'Detalle de un widget por id.',
    scope: 'widgets.read',
    inputSchema: { type: 'object', properties: { id: S('string') }, required: ['id'] },
  },
  {
    name: 'create_widget',
    description: 'Crea un widget (id opcional; se genera si falta).',
    scope: 'widgets.write',
    inputSchema: {
      type: 'object',
      properties: { id: S('string'), name: S('string'), kind: S('string'), data: S('object') },
      required: ['name'],
    },
  },
  {
    name: 'update_widget',
    description: 'Actualiza un widget (data se fusiona).',
    scope: 'widgets.write',
    inputSchema: {
      type: 'object',
      properties: { id: S('string'), name: S('string'), kind: S('string'), data: S('object') },
      required: ['id'],
    },
  },
  {
    name: 'delete_widget',
    description: 'Elimina un widget.',
    scope: 'widgets.write',
    inputSchema: { type: 'object', properties: { id: S('string') }, required: ['id'] },
  },
  // ---- Flows ----
  {
    name: 'list_flows',
    description: 'Lista todos los flows (secuencias de acciones con nombre).',
    scope: 'flows.read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_flow',
    description: 'Detalle de un flow por id.',
    scope: 'flows.read',
    inputSchema: { type: 'object', properties: { id: S('string') }, required: ['id'] },
  },
  {
    name: 'create_flow',
    description: 'Crea un flow (id opcional). steps es el array de {type, parameters}.',
    scope: 'flows.write',
    inputSchema: {
      type: 'object',
      properties: { id: S('string'), name: S('string'), steps: S('array', 'Pasos {type, parameters}'), data: S('object', 'Alternativa a steps') },
      required: ['name'],
    },
  },
  {
    name: 'update_flow',
    description: 'Actualiza un flow (steps sustituye los pasos; data se fusiona si no hay steps).',
    scope: 'flows.write',
    inputSchema: {
      type: 'object',
      properties: { id: S('string'), name: S('string'), steps: S('array'), data: S('object') },
      required: ['id'],
    },
  },
  {
    name: 'delete_flow',
    description: 'Elimina un flow.',
    scope: 'flows.write',
    inputSchema: { type: 'object', properties: { id: S('string') }, required: ['id'] },
  },
  {
    name: 'execute_flow',
    description: 'Ejecuta los pasos de un flow en orden. Pasos sensibles exigen confirm:true.',
    scope: 'actions.execute',
    inputSchema: {
      type: 'object',
      properties: { id: S('string', 'Id del flow (alias: flow_id)'), flow_id: S('string'), confirm: S('boolean', 'Obligatorio (true) si hay pasos sensibles') },
    },
  },
  // ---- Automatizaciones ----
  {
    name: 'list_automations',
    description: 'Lista todas las automatizaciones (trigger + acciones).',
    scope: 'automations.read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_automation',
    description: 'Detalle de una automatización por id.',
    scope: 'automations.read',
    inputSchema: { type: 'object', properties: { id: S('string') }, required: ['id'] },
  },
  {
    name: 'create_automation',
    description: 'Crea una automatización (id opcional). actions es el array de {type, parameters}.',
    scope: 'automations.write',
    inputSchema: {
      type: 'object',
      properties: { id: S('string'), name: S('string'), enabled: S('boolean'), trigger: S('object'), actions: S('array'), data: S('object') },
      required: ['name'],
    },
  },
  {
    name: 'update_automation',
    description: 'Actualiza una automatización.',
    scope: 'automations.write',
    inputSchema: {
      type: 'object',
      properties: { id: S('string'), name: S('string'), enabled: S('boolean'), trigger: S('object'), actions: S('array'), data: S('object') },
      required: ['id'],
    },
  },
  {
    name: 'delete_automation',
    description: 'Elimina una automatización.',
    scope: 'automations.write',
    inputSchema: { type: 'object', properties: { id: S('string') }, required: ['id'] },
  },
  {
    name: 'set_automation_enabled',
    description: 'Activa o desactiva una automatización.',
    scope: 'automations.write',
    inputSchema: {
      type: 'object',
      properties: { id: S('string'), enabled: S('boolean') },
      required: ['id', 'enabled'],
    },
  },
  // ---- Variables ----
  {
    name: 'list_variables',
    description: 'Lista todas las variables globales.',
    scope: 'variables.read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_variable',
    description: 'Lee una variable por nombre.',
    scope: 'variables.read',
    inputSchema: { type: 'object', properties: { name: S('string') }, required: ['name'] },
  },
  {
    name: 'set_variable',
    description: 'Crea o actualiza una variable global (nombre: letras, dígitos, _, ., -).',
    scope: 'variables.write',
    inputSchema: {
      type: 'object',
      properties: { name: S('string'), value: S(['string', 'number', 'boolean', 'object'] as any, 'Nuevo valor'), type: S('string', 'Tipo (opcional)') },
      required: ['name', 'value'],
    },
  },
  {
    name: 'delete_variable',
    description: 'Elimina una variable.',
    scope: 'variables.write',
    inputSchema: { type: 'object', properties: { name: S('string') }, required: ['name'] },
  },
  // ---- Batch atómico + historial/undo ----
  {
    name: 'execute_batch',
    description: 'Ejecuta varias operaciones CRUD de una vez: primero valida TODAS (scopes y argumentos) y si alguna falla no aplica ninguna (atómico). No admite execute/press/install ni historial.',
    scope: 'batch.write',
    inputSchema: {
      type: 'object',
      properties: {
        operations: S('array', 'Lista de {tool, arguments}', { items: { type: 'object' } }),
        atomic: S('boolean', 'true (defecto): valida todo antes de aplicar y revierte si algo falla'),
      },
      required: ['operations'],
    },
  },
  {
    name: 'get_history',
    description: 'Historial propio del MCP: mutaciones aplicadas por este token (para revisar antes de deshacer).',
    scope: 'history.read',
    inputSchema: { type: 'object', properties: { limit: S('number', 'Máx. entradas (opcional)') } },
  },
  {
    name: 'undo_last',
    description: 'Deshace la última mutación no deshecha de este token.',
    scope: 'history.write',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'clear_history',
    description: 'Vacía el historial de este token.',
    scope: 'history.write',
    inputSchema: { type: 'object', properties: {} },
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
  'widgets.write', 'flows.write', 'automations.write', 'variables.write',
  'batch.write', 'history.write',
]);

/** Prefijos de acciones sensibles: exigen confirmación explícita. */
export const SENSITIVE_ACTION_PREFIXES = ['shell.', 'http.', 'power.', 'system.'];

export function isSensitiveActionType(type: unknown): boolean {
  return typeof type === 'string' && SENSITIVE_ACTION_PREFIXES.some((p) => type === p.slice(0, -1) || type.startsWith(p));
}

/** Extrae y valida la confirmación para una acción sensible. Lanza si falta.
 * Solo aplica a llamadas con token MCP (ctx.auth): las internas del daemon
 * (sin auth: tests, motor) están exentas para no romper el flujo local. */
function requireSensitiveConfirm(ctx: McpContext, type: string, args: any): any {
  const params = args?.parameters;
  if (!ctx.auth) return params ?? {};
  const confirmed = args?.confirm === true || (params && typeof params === 'object' && (params as any)._confirm === true);
  if (!confirmed) {
    throw new Error(
      `Acción sensible '${type}': confirma con { confirm: true } (o parameters._confirm=true). ` +
      `shell/http/power/system pueden dañar el sistema.`
    );
  }
  if (params && typeof params === 'object' && (params as any)._confirm !== undefined) {
    const { _confirm: _omit, ...rest } = params as any;
    return rest;
  }
  return params ?? {};
}

/** ¿Alguno de estos pasos/acciones es sensible? */
function hasSensitiveStep(steps: any): boolean {
  if (!Array.isArray(steps)) return false;
  return steps.some((s) => isSensitiveActionType(s?.type));
}

function requireBatchConfirmIfSensitive(ctx: McpContext, steps: any, args: any, what: string): void {
  if (!ctx.auth) return; // llamadas internas exentas (ver requireSensitiveConfirm)
  if (hasSensitiveStep(steps) && args?.confirm !== true) {
    throw new Error(
      `${what} contiene acciones sensibles (shell/http/power/system): confirma con { confirm: true }.`
    );
  }
}

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

/** Registra la inversa en el historial propio (o en el colector de un batch). */
function recordInverse(ctx: McpContext, tool: string, label: string, inverse: { tool: string; arguments: any; batch?: any[] }): void {
  try {
    const collector = (ctx as any).__batchCollect;
    if (Array.isArray(collector)) collector.push({ tool, label, inverse });
    else pushHistory(ctx.auth, tool, label, inverse);
  } catch { /* historial best-effort */ }
}

function snapshotButton(db: DatabaseService, id: string): any {
  const b = db.getButton(id);
  return b ? JSON.parse(JSON.stringify(b)) : null;
}

/** Aplica una inversa del historial usando la BD/cargador directamente (sin re-auditar). */
async function applyInverse(inverse: { tool: string; arguments: any; batch?: any[] }, ctx: McpContext): Promise<any> {
  const { pluginLoader, db } = ctx;
  if (inverse.tool === '__batch' && Array.isArray(inverse.batch)) {
    const out: any[] = [];
    for (const inv of inverse.batch) out.push(await applyInverse(inv as any, ctx));
    return { undone: out.length };
  }
  const a = inverse.arguments ?? {};
  switch (inverse.tool) {
    case 'delete_profile': db.deleteProfile(a.id); return { success: true, profileId: a.id };
    case '__restore_profile': {
      const { profile, pages } = a;
      if (!db.getProfile(profile.id)) db.createProfile({ id: profile.id, name: profile.name, data: profile.data ?? {} });
      else db.updateProfile(profile.id, { name: profile.name, data: profile.data ?? {} });
      for (const p of pages ?? []) {
        if (!db.getPage(p.page.id)) {
          try { db.createPage({ id: p.page.id, profile_id: p.page.profile_id, name: p.page.name, order_idx: p.page.order_idx ?? 0, is_folder: p.page.is_folder ?? 0, data: p.page.data ?? {} } as any); } catch { /* nombre duplicado: noop */ }
        }
        for (const b of p.buttons ?? []) {
          if (!db.getButton(b.id)) {
            try { db.createButton({ id: b.id, page_id: b.page_id, position: b.position, data: b.data ?? {} } as any); } catch { /* noop */ }
          }
        }
      }
      ctx.ws?.broadcastProfileUpdate(profile.id, db.getProfile(profile.id));
      return { success: true, profileId: profile.id };
    }
    case 'update_profile': {
      db.updateProfile(a.id, { ...(a.name !== undefined ? { name: a.name } : {}), ...(a.data !== undefined ? { data: a.data } : {}) });
      return { success: true, profileId: a.id };
    }
    case 'delete_page': db.deletePage(a.id); return { success: true, pageId: a.id };
    case '__restore_page': {
      const { page, buttons } = a;
      if (!db.getPage(page.id)) {
        try { db.createPage({ id: page.id, profile_id: page.profile_id, name: page.name, order_idx: page.order_idx ?? 0, is_folder: page.is_folder ?? 0, data: page.data ?? {} } as any); } catch { /* noop */ }
      }
      for (const b of buttons ?? []) {
        if (!db.getButton(b.id)) {
          try { db.createButton({ id: b.id, page_id: b.page_id, position: b.position, data: b.data ?? {} } as any); } catch { /* noop */ }
        }
      }
      return { success: true, pageId: page.id };
    }
    case 'update_page': db.updatePage(a.id, { ...(a.name !== undefined ? { name: a.name } : {}), ...(a.order_idx !== undefined ? { order_idx: a.order_idx } : {}), ...(a.is_folder !== undefined ? { is_folder: a.is_folder } : {}), ...(a.data !== undefined ? { data: a.data } : {}) }); return { success: true, pageId: a.id };
    case 'delete_button': db.deleteButton(a.id); return { success: true, buttonId: a.id };
    case '__restore_button': {
      const { button } = a;
      if (!db.getButton(button.id) && db.getPage(button.page_id)) {
        try { db.createButton({ id: button.id, page_id: button.page_id, position: button.position, data: button.data ?? {} } as any); } catch { /* noop */ }
      }
      return { success: true, buttonId: button.id };
    }
    case '__restore_button_data': db.updateButton(a.button_id, a.data); return { success: true, buttonId: a.button_id };
    case 'reorder_buttons': db.reorderButtons(a.page_id, a.order); return { success: true };
    case '__restore_setting': {
      if (a.hadValue) db.setSetting(a.key, a.value);
      else db.deleteSetting(a.key);
      return { success: true, key: a.key };
    }
    case 'delete_widget': db.deleteWidget(a.id); return { success: true };
    case '__restore_widget': {
      const { widget } = a;
      db.replaceWidget({ id: widget.id, name: widget.name, kind: widget.kind, data: widget.data, created_at: widget.created_at, updated_at: widget.updated_at });
      return { success: true };
    }
    case 'update_widget': {
      db.replaceWidget({ id: a.id, name: a.name, kind: a.kind ?? null, data: a.data ?? {} });
      return { success: true };
    }
    case 'delete_flow': db.deleteFlow(a.id); return { success: true };
    case '__restore_flow': {
      const { flow } = a;
      db.replaceFlow({ id: flow.id, name: flow.name, data: flow.data, created_at: flow.created_at, updated_at: flow.updated_at });
      return { success: true };
    }
    case 'update_flow': db.replaceFlow({ id: a.id, name: a.name, data: a.data }); return { success: true };
    case 'delete_automation': db.deleteAutomation(a.id); return { success: true };
    case '__restore_automation': {
      const { automation } = a;
      db.replaceAutomation({ id: automation.id, name: automation.name, enabled: automation.enabled, trigger: automation.trigger, data: automation.data, created_at: automation.created_at, updated_at: automation.updated_at });
      return { success: true };
    }
    case 'update_automation': {
      const cur = db.getAutomation(a.id);
      db.replaceAutomation({
        id: a.id,
        name: a.name ?? cur?.name ?? a.id,
        enabled: a.enabled !== undefined ? (a.enabled ? 1 : 0) : (cur?.enabled ?? 1),
        trigger: a.trigger ?? cur?.trigger ?? {},
        data: a.data ?? cur?.data ?? { actions: [] },
      });
      return { success: true };
    }
    case 'set_automation_enabled': db.updateAutomation(a.id, { enabled: a.enabled ? 1 : 0 }); return { success: true };
    case 'delete_variable': db.deleteVariable(a.name); return { success: true };
    case '__restore_variable': {
      const { variable } = a;
      if (variable === null) db.deleteVariable(a.name);
      else db.setVariable(a.name, variable.value, variable.type);
      return { success: true };
    }
    case 'enable_plugin': {
      const ok = await pluginLoader.enablePlugin(a.plugin_id);
      if (!ok) throw new Error(`No se pudo habilitar ${a.plugin_id}`);
      return { success: true };
    }
    case 'disable_plugin': await pluginLoader.disablePlugin(a.plugin_id); return { success: true };
    case '__restore_plugin_settings': await pluginLoader.savePluginSettings(a.plugin_id, a.values ?? {}); return { success: true };
    case 'set_current_profile': db.setCurrentProfile(a.profile_id); return { success: true };
    case 'set_current_page': db.setCurrentPage(a.page_id); return { success: true };
    case 'move_button': {
      const cur = db.getButton(a.id);
      if (cur) {
        try {
          db.moveButton(a.id, a.page_id, a.position);
        } catch {
          // Posición ocupada al deshacer (el grid cambió): primer hueco libre.
          const used = new Set(db.getButtonsByPage(a.page_id).map((b) => b.position));
          let pos = 0;
          while (used.has(pos)) pos++;
          db.moveButton(a.id, a.page_id, pos);
        }
      }
      return { success: true };
    }
    default:
      throw new Error(`Inversa no soportada: ${inverse.tool}`);
  }
}

// ---- Batch atómico: validación previa + compensación ----

/** Tools con efectos no transaccionales: prohibidas dentro de execute_batch. */
const BATCH_DENY = new Set([
  'execute_action', 'press_button', 'execute_flow',
  'install_plugin', 'install_plugin_from_git', 'update_plugin', 'uninstall_plugin',
  'reload_plugin', 'rollback_plugin', 'enable_plugin', 'disable_plugin',
  'get_plugin_settings', 'save_plugin_settings',
  'execute_batch', 'get_history', 'undo_last', 'clear_history',
]);

/** Validación read-only de una operación del batch (no muta nada). */
function preflightBatchOp(name: string, args: any, ctx: McpContext): void {
  const def = toolDef(name);
  if (!def) throw new Error(`Tool desconocida en batch: ${name}`);
  if (BATCH_DENY.has(name)) {
    throw new Error(`Tool no admitida en batch (efectos no transaccionales): ${name}`);
  }
  if (!hasScope(ctx.auth, def.scope)) {
    throw new Error(`permiso denegado en batch para '${name}' (requiere "${def.scope}")`);
  }
  const { db, pluginLoader } = ctx;
  const need = (k: string) => {
    if (args?.[k] === undefined) throw new Error(`'${name}': ${k} requerido`);
  };
  switch (name) {
    case 'create_profile': need('name'); break;
    case 'update_profile': case 'delete_profile': need('id'); if (name !== 'create_profile' && !db.getProfile(args.id)) throw new Error(`'${name}': perfil no encontrado`); break;
    case 'set_current_profile': need('profile_id'); if (!db.getProfile(args.profile_id)) throw new Error('Perfil no encontrado'); break;
    case 'create_page': need('profile_id'); need('name'); if (!db.getProfile(args.profile_id)) throw new Error('Perfil no encontrado'); break;
    case 'update_page': case 'delete_page': need('id'); if (!db.getPage(args.id)) throw new Error('Página no encontrada'); break;
    case 'set_current_page': need('page_id'); if (!db.getPage(args.page_id)) throw new Error('Página no encontrada'); break;
    case 'create_button': {
      need('page_id'); if (!db.getPage(args.page_id)) throw new Error('Página no encontrada');
      if (args.position !== undefined && (!Number.isInteger(Number(args.position)) || Number(args.position) < 0)) throw new Error('position inválida');
      break;
    }
    case 'update_button': case 'move_button': case 'delete_button': case 'duplicate_button': {
      need('id'); if (!db.getButton(args.id)) throw new Error('Botón no encontrado');
      const target = args.page_id ?? (name === 'update_button' ? undefined : db.getButton(args.id)?.page_id);
      if (target !== undefined && !db.getPage(target)) throw new Error('Página destino no encontrada');
      break;
    }
    case 'reorder_buttons': {
      need('page_id'); if (!Array.isArray(args.order)) throw new Error('order requerido');
      break;
    }
    case 'add_button_action': {
      need('button_id'); need('type');
      if (!db.getButton(args.button_id)) throw new Error('Botón no encontrado');
      if (!pluginLoader.getPluginActions().has(args.type)) throw new Error(`Tipo de acción desconocido: ${args.type}`);
      break;
    }
    case 'update_button_action': case 'remove_button_action': case 'reorder_button_actions': {
      need('button_id');
      const b = db.getButton(args.button_id);
      if (!b) throw new Error('Botón no encontrado');
      const n = Array.isArray(parseData(b.data)?.actions) ? parseData(b.data).actions.length : 0;
      if (name === 'reorder_button_actions') {
        if (!Array.isArray(args.order) || args.order.length !== n) throw new Error(`order debe ser permutación de ${n} índices`);
      } else {
        const i = Number(args.index);
        if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error('index fuera de rango');
      }
      if (args.type !== undefined && !pluginLoader.getPluginActions().has(args.type)) throw new Error(`Tipo de acción desconocido: ${args.type}`);
      break;
    }
    case 'create_widget': case 'create_flow': case 'create_automation': need('name'); break;
    case 'update_widget': case 'delete_widget': case 'get_widget':
      need('id'); if (name.startsWith('update') || name.startsWith('delete')) { if (!db.getWidget(args.id)) throw new Error('Widget no encontrado'); } break;
    case 'update_flow': case 'delete_flow': case 'get_flow':
      need('id'); if (name !== 'get_flow' && !db.getFlow(args.id)) throw new Error('Flow no encontrado'); break;
    case 'update_automation': case 'delete_automation': case 'set_automation_enabled': case 'get_automation': {
      need('id'); if (name !== 'get_automation' && !db.getAutomation(args.id)) throw new Error('Automatización no encontrada'); break;
    }
    case 'get_variable': case 'delete_variable': need('name'); break;
    case 'set_variable': need('name'); if (args.value === undefined) throw new Error('value requerido'); break;
    case 'set_setting': need('key'); if (args.value === undefined) throw new Error('value requerido'); break;
    case 'get_setting': case 'get_plugin': case 'get_profile': case 'get_page': case 'get_button':
    case 'list_profiles': case 'list_pages': case 'list_buttons': case 'list_widgets': case 'list_flows':
    case 'list_automations': case 'list_variables': case 'list_settings': case 'list_actions':
    case 'get_state': case 'get_logs': case 'validate_manifest': case 'get_plugin_template':
      break;
    default:
      throw new Error(`Tool no admitida en batch: ${name}`);
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
      // Endurecido: shell/http/power/system exigen confirmación explícita.
      // Un token de solo lectura jamás llega aquí (scope actions.execute).
      const parameters = isSensitiveActionType(type) ? requireSensitiveConfirm(ctx, type, args) : (args?.parameters ?? {});
      const actionId = randomUUID();
      ctx.ws?.broadcastActionStarted(actionId, { action: { type, parameters } });
      try {
        const result = await actionRunner.executeAction(
          { type, parameters },
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
      let widgets: any[] = [];
      let flows: any[] = [];
      let automations: any[] = [];
      let variables: any[] = [];
      try {
        widgets = db.listWidgets().map((w) => ({ id: w.id, name: w.name, kind: w.kind }));
        flows = db.listFlows().map((f) => ({ id: f.id, name: f.name, steps: Array.isArray((f.data as any)?.steps) ? (f.data as any).steps.length : 0 }));
        automations = db.listAutomations().map((a) => ({ id: a.id, name: a.name, enabled: a.enabled }));
        variables = db.listVariables().map((v) => ({ name: v.name, type: v.type }));
      } catch { /* BD antigua sin migración 4: se omite */ }
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
        counts: { profiles: profiles.length, pages: pages.length, buttons: buttons.length, plugins: plugins.length, widgets: widgets.length, flows: flows.length, automations: automations.length, variables: variables.length },
        widgets,
        flows,
        automations,
        variables,
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
      recordInverse(ctx, 'create_profile', `crear perfil ${created.name}`, { tool: 'delete_profile', arguments: { id: created.id } });
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
      recordInverse(ctx, 'update_profile', `actualizar perfil ${id}`, {
        tool: 'update_profile', arguments: { id, name: existing.name, data: parseData(existing.data) },
      });
      return { profile: updated ? { ...updated, data: parseData(updated.data) } : null };
    }
    case 'delete_profile': {
      const id = reqStr(args, 'id');
      const snap = db.getProfile(id);
      if (!snap) throw new Error('Perfil no encontrado');
      const snapPages = db.getPagesByProfile(id).map((pg: any) => ({
        page: { ...pg, data: parseData(pg.data) },
        buttons: db.getButtonsByPage(pg.id),
      }));
      db.deleteProfile(id);
      ctx.ws?.broadcast('profile.deleted', { profileId: id }, 'profiles');
      recordInverse(ctx, 'delete_profile', `eliminar perfil ${id}`, {
        tool: '__restore_profile',
        arguments: { profile: { ...snap, data: parseData(snap.data) }, pages: snapPages },
      });
      return { success: true, profileId: id };
    }
    case 'set_current_profile': {
      const profileId = reqStr(args, 'profile_id');
      if (!db.getProfile(profileId)) throw new Error('Perfil no encontrado');
      const prev = db.getSetting('current.profile_id');
      db.setCurrentProfile(profileId);
      ctx.ws?.broadcast('profile.navigate', { profileId }, 'profiles');
      if (prev) recordInverse(ctx, 'set_current_profile', `activar perfil ${profileId}`, { tool: 'set_current_profile', arguments: { profile_id: prev } });
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
      recordInverse(ctx, 'create_page', `crear página ${page.name}`, { tool: 'delete_page', arguments: { id: page.id } });
      return { page };
    }
    case 'update_page': {
      const id = reqStr(args, 'id');
      const existing = db.getPage(id) as any;
      if (!existing) throw new Error('Página no encontrada');
      const prev = { name: existing.name, order_idx: existing.order_idx, is_folder: existing.is_folder, data: parseData(existing.data) };
      const updates: any = {};
      if (args?.name !== undefined) updates.name = reqStr(args, 'name');
      if (args?.order_idx !== undefined) updates.order_idx = Number(args.order_idx);
      if (args?.is_folder !== undefined) updates.is_folder = Number(args.is_folder);
      if (args?.data !== undefined) updates.data = { ...parseData(existing.data), ...parseData(args.data) };
      db.updatePage(id, updates);
      const updated = db.getPage(id);
      ctx.ws?.broadcast('page.updated', { pageId: id, page: updated }, 'pages');
      recordInverse(ctx, 'update_page', `actualizar página ${id}`, { tool: 'update_page', arguments: { id, ...prev } });
      return { page: updated };
    }
    case 'delete_page': {
      const id = reqStr(args, 'id');
      const existing = db.getPage(id);
      if (!existing) throw new Error('Página no encontrada');
      const snap = { ...(existing as any), data: parseData((existing as any).data) };
      const snapButtons = db.getButtonsByPage(id);
      db.deletePage(id);
      ctx.ws?.broadcastPageDeleted(id);
      recordInverse(ctx, 'delete_page', `eliminar página ${id}`, { tool: '__restore_page', arguments: { page: snap, buttons: snapButtons } });
      return { success: true, pageId: id };
    }
    case 'set_current_page': {
      const pageId = reqStr(args, 'page_id');
      const page = db.getPage(pageId) as any;
      if (!page) throw new Error('Página no encontrada');
      const prev = db.getSetting('current.page_id');
      db.setCurrentPage(pageId);
      ctx.ws?.broadcast('page.navigate', { pageId, pageName: page.name }, 'pages');
      repaint(ctx, pageId);
      if (prev) recordInverse(ctx, 'set_current_page', `mostrar página ${pageId}`, { tool: 'set_current_page', arguments: { page_id: prev } });
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
      recordInverse(ctx, 'create_button', `crear botón ${button.id}`, { tool: 'delete_button', arguments: { id: button.id } });
      return { button: db.getButton(button.id) };
    }
    case 'update_button':
    case 'move_button': {
      const id = reqStr(args, 'id');
      const existing = db.getButton(id);
      if (!existing) throw new Error('Botón no encontrado');
      const prev = snapshotButton(db, id)!;
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
      // Una sola entrada de undo: vuelve a su página/posición y restaura la data previa.
      recordInverse(ctx, name, `mover/actualizar botón ${id}`, {
        tool: '__batch',
        arguments: {},
        batch: [
          { tool: '__restore_button_data', arguments: { button_id: id, data: prev.data } },
          { tool: 'move_button', arguments: { id, page_id: prev.page_id, position: prev.position } },
        ],
      });
      return { button: updated };
    }
    case 'delete_button': {
      const id = reqStr(args, 'id');
      const existing = db.getButton(id);
      if (!existing) throw new Error('Botón no encontrado');
      const snap = snapshotButton(db, id)!;
      db.deleteButton(id);
      ctx.ws?.broadcastButtonDeleted(id);
      repaint(ctx, existing.page_id);
      recordInverse(ctx, 'delete_button', `eliminar botón ${id}`, { tool: '__restore_button', arguments: { button: snap } });
      return { success: true, buttonId: id };
    }
    case 'reorder_buttons': {
      const pageId = reqStr(args, 'page_id');
      if (!Array.isArray(args?.order)) throw new Error('order requerido (array de {id, position})');
      const prevOrder = db.getButtonsByPage(pageId).map((b) => ({ id: b.id, position: b.position }));
      const updated = db.reorderButtons(pageId, args.order);
      ctx.ws?.broadcastButtonsReordered(pageId, updated);
      repaint(ctx, pageId);
      recordInverse(ctx, 'reorder_buttons', `reordenar página ${pageId}`, { tool: 'reorder_buttons', arguments: { page_id: pageId, order: prevOrder } });
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
      recordInverse(ctx, 'duplicate_button', `duplicar botón ${id}`, { tool: 'delete_button', arguments: { id: copy.id } });
      return { button: db.getButton(copy.id) };
    }
    case 'press_button': {
      const buttonId = reqStr(args, 'button_id');
      const existing = db.getButton(buttonId);
      if (!existing) throw new Error('Botón no encontrado');
      const actions = parseData(existing.data)?.actions ?? [];
      requireBatchConfirmIfSensitive(ctx, actions, args, `El botón ${buttonId}`);
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
      const prevData = structuredClone(parseData(existing.data));
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
      recordInverse(ctx, name, `${name} en botón ${buttonId}`, { tool: '__restore_button_data', arguments: { button_id: buttonId, data: prevData } });
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
      recordInverse(ctx, 'enable_plugin', `habilitar plugin ${pluginId}`, { tool: 'disable_plugin', arguments: { plugin_id: pluginId } });
      return { success: true, pluginId, status: pluginLoader.getStatus(pluginId) };
    }
    case 'disable_plugin': {
      const pluginId = reqStr(args, 'plugin_id');
      await pluginLoader.disablePlugin(pluginId);
      ctx.ws?.broadcastPluginEnabled(pluginId, false);
      recordInverse(ctx, 'disable_plugin', `desactivar plugin ${pluginId}`, { tool: 'enable_plugin', arguments: { plugin_id: pluginId } });
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
      let prev: Record<string, any> = {};
      try { prev = (await pluginLoader.getPluginSettingsBundle(pluginId) as any)?.values ?? {}; } catch { /* noop */ }
      const values = await pluginLoader.savePluginSettings(pluginId, args.values);
      recordInverse(ctx, 'save_plugin_settings', `ajustes de ${pluginId}`, { tool: '__restore_plugin_settings', arguments: { plugin_id: pluginId, values: prev } });
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
      const prevRaw = db.getSetting(key);
      const value = typeof args.value === 'string' ? args.value : JSON.stringify(args.value);
      db.setSetting(key, value);
      recordInverse(ctx, 'set_setting', `ajuste ${key}`, {
        tool: '__restore_setting', arguments: { key, hadValue: prevRaw !== null, value: prevRaw },
      });
      return { key, value: db.getSetting(key) };
    }
    case 'get_logs': {
      const limit = Math.min(Math.max(Number(args?.limit ?? 100), 1), 500);
      return { logs: db.getLogs(limit, args?.level) };
    }
    // ---- widgets ----
    case 'list_widgets':
      return { widgets: db.listWidgets() };
    case 'get_widget': {
      const w = db.getWidget(reqStr(args, 'id'));
      if (!w) throw new Error('Widget no encontrado');
      return { widget: w };
    }
    case 'create_widget': {
      const widget = db.createWidget({
        id: typeof args?.id === 'string' && args.id ? args.id : randomUUID(),
        name: reqStr(args, 'name'),
        kind: args?.kind !== undefined ? String(args.kind) : null,
        data: args?.data ?? {},
      });
      recordInverse(ctx, 'create_widget', `crear widget ${widget.name}`, { tool: 'delete_widget', arguments: { id: widget.id } });
      return { widget };
    }
    case 'update_widget': {
      const id = reqStr(args, 'id');
      const prev = db.getWidget(id);
      if (!prev) throw new Error('Widget no encontrado');
      const widget = db.updateWidget(id, {
        ...(args?.name !== undefined ? { name: reqStr(args, 'name') } : {}),
        ...(args?.kind !== undefined ? { kind: args.kind === null ? null : String(args.kind) } : {}),
        ...(args?.data !== undefined ? { data: args.data } : {}),
      });
      recordInverse(ctx, 'update_widget', `actualizar widget ${id}`, {
        tool: 'update_widget', arguments: { id, name: prev.name, kind: prev.kind, data: prev.data },
      });
      return { widget };
    }
    case 'delete_widget': {
      const id = reqStr(args, 'id');
      const prev = db.getWidget(id);
      if (!prev) throw new Error('Widget no encontrado');
      db.deleteWidget(id);
      recordInverse(ctx, 'delete_widget', `eliminar widget ${id}`, { tool: '__restore_widget', arguments: { widget: prev } });
      return { success: true, id };
    }
    // ---- flows ----
    case 'list_flows':
      return { flows: db.listFlows() };
    case 'get_flow': {
      const f = db.getFlow(reqStr(args, 'id'));
      if (!f) throw new Error('Flow no encontrado');
      return { flow: f };
    }
    case 'create_flow': {
      const data = normalizeFlowData(args);
      const flow = db.createFlow({
        id: typeof args?.id === 'string' && args.id ? args.id : randomUUID(),
        name: reqStr(args, 'name'),
        data,
      });
      recordInverse(ctx, 'create_flow', `crear flow ${flow.name}`, { tool: 'delete_flow', arguments: { id: flow.id } });
      return { flow };
    }
    case 'update_flow': {
      const id = reqStr(args, 'id');
      const prev = db.getFlow(id);
      if (!prev) throw new Error('Flow no encontrado');
      const flow = db.updateFlow(id, {
        ...(args?.name !== undefined ? { name: reqStr(args, 'name') } : {}),
        ...(args?.steps !== undefined || args?.data !== undefined ? { data: normalizeFlowData(args, prev.data) } : {}),
      });
      recordInverse(ctx, 'update_flow', `actualizar flow ${id}`, { tool: 'update_flow', arguments: { id, name: prev.name, data: prev.data } });
      return { flow };
    }
    case 'delete_flow': {
      const id = reqStr(args, 'id');
      const prev = db.getFlow(id);
      if (!prev) throw new Error('Flow no encontrado');
      db.deleteFlow(id);
      recordInverse(ctx, 'delete_flow', `eliminar flow ${id}`, { tool: '__restore_flow', arguments: { flow: prev } });
      return { success: true, id };
    }
    case 'execute_flow': {
      const id = args?.id ?? args?.flow_id;
      if (!id || typeof id !== 'string') throw new Error('id (o flow_id) requerido');
      const flow = db.getFlow(id);
      if (!flow) throw new Error('Flow no encontrado');
      const steps = Array.isArray((flow.data as any)?.steps) ? (flow.data as any).steps : [];
      requireBatchConfirmIfSensitive(ctx, steps, args, `El flow ${id}`);
      const results: any[] = [];
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (!s?.type) { results.push({ index: i, success: false, error: 'paso sin type' }); continue; }
        try {
          const r = await actionRunner.executeAction(
            { type: s.type, parameters: s.parameters ?? {} },
            { timestamp: Date.now(), pressType: 'short' } as any
          );
          results.push({ index: i, type: s.type, success: r?.success !== false, result: r });
          if (r?.success === false && (flow.data as any)?.stopOnError !== false) break;
        } catch (e) {
          results.push({ index: i, type: s?.type, success: false, error: e instanceof Error ? e.message : String(e) });
          if ((flow.data as any)?.stopOnError !== false) break;
        }
      }
      try {
        db.addLog({ level: 'info', message: `mcp:execute_flow ${id}`, meta: { steps: steps.length, ok: results.filter((r) => r.success).length }, ts: Date.now() });
      } catch { /* noop */ }
      return { flowId: id, executed: results.length, results };
    }
    // ---- automatizaciones ----
    case 'list_automations':
      return { automations: db.listAutomations() };
    case 'get_automation': {
      const auto = db.getAutomation(reqStr(args, 'id'));
      if (!auto) throw new Error('Automatización no encontrada');
      return { automation: auto };
    }
    case 'create_automation': {
      const automation = db.createAutomation({
        id: typeof args?.id === 'string' && args.id ? args.id : randomUUID(),
        name: reqStr(args, 'name'),
        enabled: args?.enabled === undefined ? 1 : (args.enabled ? 1 : 0),
        trigger: args?.trigger ?? {},
        data: normalizeAutomationData(args),
      });
      recordInverse(ctx, 'create_automation', `crear automatización ${automation.name}`, { tool: 'delete_automation', arguments: { id: automation.id } });
      return { automation };
    }
    case 'update_automation': {
      const id = reqStr(args, 'id');
      const prev = db.getAutomation(id);
      if (!prev) throw new Error('Automatización no encontrada');
      const automation = db.updateAutomation(id, {
        ...(args?.name !== undefined ? { name: reqStr(args, 'name') } : {}),
        ...(args?.enabled !== undefined ? { enabled: args.enabled ? 1 : 0 } : {}),
        ...(args?.trigger !== undefined ? { trigger: args.trigger } : {}),
        ...(args?.actions !== undefined || args?.data !== undefined ? { data: normalizeAutomationData(args, prev.data) } : {}),
      });
      recordInverse(ctx, 'update_automation', `actualizar automatización ${id}`, {
        tool: 'update_automation',
        arguments: { id, name: prev.name, enabled: prev.enabled === 1, trigger: prev.trigger, data: prev.data },
      });
      return { automation };
    }
    case 'delete_automation': {
      const id = reqStr(args, 'id');
      const prev = db.getAutomation(id);
      if (!prev) throw new Error('Automatización no encontrada');
      db.deleteAutomation(id);
      recordInverse(ctx, 'delete_automation', `eliminar automatización ${id}`, { tool: '__restore_automation', arguments: { automation: prev } });
      return { success: true, id };
    }
    case 'set_automation_enabled': {
      const id = reqStr(args, 'id');
      if (args?.enabled === undefined || typeof args.enabled !== 'boolean') throw new Error('enabled (boolean) requerido');
      const prev = db.getAutomation(id);
      if (!prev) throw new Error('Automatización no encontrada');
      const automation = db.updateAutomation(id, { enabled: args.enabled ? 1 : 0 });
      recordInverse(ctx, 'set_automation_enabled', `${args.enabled ? 'activar' : 'desactivar'} automatización ${id}`, {
        tool: 'set_automation_enabled', arguments: { id, enabled: prev.enabled === 1 },
      });
      return { automation };
    }
    // ---- variables ----
    case 'list_variables':
      return { variables: db.listVariables() };
    case 'get_variable': {
      const v = db.getVariable(reqStr(args, 'name'));
      if (!v) throw new Error('Variable no encontrada');
      return { variable: v };
    }
    case 'set_variable': {
      const vname = reqStr(args, 'name');
      if (args?.value === undefined) throw new Error('value requerido');
      const prev = db.getVariable(vname);
      const variable = db.setVariable(vname, args.value, args?.type !== undefined ? String(args.type) : null);
      recordInverse(ctx, 'set_variable', `variable ${vname}`, {
        tool: '__restore_variable', arguments: { name: vname, variable: prev ? { value: prev.value, type: prev.type } : null },
      });
      return { variable };
    }
    case 'delete_variable': {
      const vname = reqStr(args, 'name');
      const prev = db.getVariable(vname);
      if (!prev) throw new Error('Variable no encontrada');
      db.deleteVariable(vname);
      recordInverse(ctx, 'delete_variable', `eliminar variable ${vname}`, {
        tool: '__restore_variable', arguments: { name: vname, variable: { value: prev.value, type: prev.type } },
      });
      return { success: true, name: vname };
    }
    // ---- batch atómico ----
    case 'execute_batch': {
      const ops = args?.operations;
      if (!Array.isArray(ops) || ops.length === 0) throw new Error('operations requerido (array no vacío de {tool, arguments})');
      if (ops.length > 100) throw new Error('operations: máximo 100 por batch');
      const atomic = args?.atomic !== false;
      // Fase 1: validación completa ANTES de mutar (scopes + argumentos).
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        if (!op || typeof op.tool !== 'string') throw new Error(`operations[${i}]: tool requerido`);
        try {
          preflightBatchOp(op.tool, op.arguments ?? {}, ctx);
        } catch (e) {
          throw new Error(`operations[${i}] (${op.tool}) inválida: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Fase 2: ejecución secuencial con colector de inversas.
      const childCtx: McpContext = { ...ctx, __batchCollect: [] } as any;
      const results: any[] = [];
      try {
        for (let i = 0; i < ops.length; i++) {
          const op = ops[i];
          try {
            const data = await callTool(op.tool, op.arguments ?? {}, childCtx);
            results.push({ index: i, tool: op.tool, success: true, result: data });
          } catch (e) {
            throw new Error(`operations[${i}] (${op.tool}) falló: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } catch (e) {
        if (atomic) {
          // Compensación: deshacer lo aplicado, en orden inverso (best-effort).
          const applied: any[] = (childCtx as any).__batchCollect ?? [];
          const errors: string[] = [];
          for (let i = applied.length - 1; i >= 0; i--) {
            try { await applyInverse(applied[i].inverse, ctx); }
            catch (ce) { errors.push(ce instanceof Error ? ce.message : String(ce)); }
          }
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`${msg} (batch atómico: ${applied.length} aplicadas y revertidas${errors.length ? `; revertir falló en ${errors.length}` : ''})`);
        }
        throw e;
      }
      // Éxito: una sola entrada de undo para todo el batch.
      const collected: any[] = (childCtx as any).__batchCollect ?? [];
      if (collected.length > 0) {
        recordInverse(ctx, 'execute_batch', `batch de ${ops.length} operaciones`, {
          tool: '__batch',
          arguments: {},
          batch: collected.map((c) => c.inverse).reverse(),
        });
      }
      return { success: true, applied: results.length, results };
    }
    // ---- historial/undo propios ----
    case 'get_history': {
      const limit = Math.min(Math.max(Number(args?.limit ?? 50), 1), 200);
      return { history: listHistory(ctx.auth, limit).map((e) => ({
        id: e.id, seq: e.seq, ts: e.ts, tokenName: e.tokenName, tool: e.tool,
        label: e.label, undone: e.undone, undoneAt: e.undoneAt ?? null, undoError: e.undoError ?? null,
      })) };
    }
    case 'undo_last': {
      const entry = peekUndo(ctx.auth);
      if (!entry) throw new Error('Nada que deshacer: el historial de este token está vacío');
      try {
        const r = await applyInverse(entry.inverse, ctx);
        markUndone(entry);
        return { success: true, undone: { tool: entry.tool, label: entry.label, seq: entry.seq }, result: r };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        markUndone(entry, msg);
        throw new Error(`Deshacer falló (${entry.label}): ${msg}`);
      }
    }
    case 'clear_history': {
      const n = clearHistory(ctx.auth);
      return { success: true, cleared: n };
    }
    default:
      throw new Error(`Tool desconocida: ${name}`);
  }
}

function normalizeFlowData(args: any, prev?: any): any {
  if (args?.steps !== undefined) {
    if (!Array.isArray(args.steps)) throw new Error('steps debe ser un array de {type, parameters}');
    for (const s of args.steps) {
      if (!s || typeof s.type !== 'string') throw new Error('cada step requiere type (string)');
    }
    return { ...((prev && typeof prev === 'object' ? prev : {}) ?? {}), ...(args?.data ?? {}), steps: args.steps };
  }
  return args?.data ?? prev ?? { steps: [] };
}

function normalizeAutomationData(args: any, prev?: any): any {
  const base = { ...((prev && typeof prev === 'object' ? prev : {}) ?? {}), ...(args?.data ?? {}) };
  if (args?.actions !== undefined) {
    if (!Array.isArray(args.actions)) throw new Error('actions debe ser un array de {type, parameters}');
    for (const s of args.actions) {
      if (!s || typeof s.type !== 'string') throw new Error('cada action requiere type (string)');
    }
    base.actions = args.actions;
  }
  if (!Array.isArray(base.actions)) base.actions = [];
  return base;
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
