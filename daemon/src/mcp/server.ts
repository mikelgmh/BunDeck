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
import { checkPageCompatibility, resolveDeckSize, isHardwareDeviceId, DECK_MODELS, DEFAULT_DECK_MODEL } from '../devices';
import { hasScope } from './scopes';
import { getVariableStore, varToJSON } from '../variables/store';
import { pushHistory, listHistory, peekUndo, markUndone, clearHistory } from './history';
import { buildBackup, buildProfileBackup, validateBackup, restoreBackup, BACKUP_SECTIONS } from '../backup';
import { getVersion } from '../version';
import { getJobManager } from '../jobs/manager';
import { getAssetsDir } from '../paths';
import { safeAssetName } from '../http/key-images';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_NAME = 'libredeck';
export const MCP_SERVER_VERSION = '2.2.0';

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
  /** Broadcasts + sesiones/navegación WS para que la UI se actualice en vivo (opcional). */
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
    | 'getSessions'
    | 'getSessionView'
    | 'setSessionView'
    | 'navigatePageTo'
    | 'navigateProfileTo'
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
    description: 'Crea un perfil nuevo. Devuelve el perfil con su id. gridCols/gridRows fijan el tamaño de grid por defecto (1..12).',
    scope: 'profiles.write',
    inputSchema: {
      type: 'object',
      properties: {
        name: S('string'), data: S('object', 'Metadatos/layout (opcional)'),
        gridCols: S('number', 'Columnas por defecto del perfil (1..12, opcional)'),
        gridRows: S('number', 'Filas por defecto del perfil (1..12, opcional)'),
      },
      required: ['name'],
    },
  },
  {
    name: 'update_profile',
    description: 'Renombra o cambia los datos de un perfil. gridCols/gridRows cambian el grid por defecto.',
    scope: 'profiles.write',
    inputSchema: {
      type: 'object',
      properties: {
        id: S('string'), name: S('string'), data: S('object', 'Se fusiona con los datos actuales'),
        gridCols: S('number', 'Columnas por defecto (1..12, opcional)'),
        gridRows: S('number', 'Filas por defecto (1..12, opcional)'),
      },
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
    description: 'Crea una página en un perfil. grid_cols/grid_rows fijan su tamaño (1..12, hereda del perfil si se omite); layout_mode classic (cuadrícula) o gridstack (libre); parent_id mete la página en una carpeta.',
    scope: 'pages.write',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: S('string'), name: S('string'),
        order_idx: S('number', 'Orden (opcional)'), is_folder: S('number', '1 = carpeta (opcional)'),
        grid_cols: S('number', 'Columnas (1..12, opcional)'), grid_rows: S('number', 'Filas (1..12, opcional)'),
        parent_id: S('string', 'Carpeta padre (opcional, null = raíz)'),
        layout_mode: S('string', "'classic' o 'gridstack' (opcional)"),
        data: S('object', 'Layout/grid extra (opcional, se fusiona layoutMode)'),
      },
      required: ['profile_id', 'name'],
    },
  },
  {
    name: 'update_page',
    description: 'Renombra, reordena o cambia los datos de una página. También grid (grid_cols/grid_rows), carpeta (parent_id) y modo (layout_mode).',
    scope: 'pages.write',
    inputSchema: {
      type: 'object',
      properties: {
        id: S('string'), name: S('string'), order_idx: S('number'),
        is_folder: S('number'), data: S('object', 'Se fusiona con los datos actuales'),
        grid_cols: S('number', 'Columnas (1..12, null = heredar)'),
        grid_rows: S('number', 'Filas (1..12, null = heredar)'),
        parent_id: S('string', 'Carpeta padre (null = raíz)'),
        layout_mode: S('string', "'classic' o 'gridstack'"),
      },
      required: ['id'],
    },
  },
  {
    name: 'set_page_layout',
    description: "Cambia el modo de una página: 'classic' (cuadrícula para Stream Deck) o 'gridstack' (libre).",
    scope: 'pages.write',
    inputSchema: {
      type: 'object',
      properties: { id: S('string'), layout_mode: S('string', "'classic' o 'gridstack'") },
      required: ['id', 'layout_mode'],
    },
  },
  {
    name: 'set_page_grid',
    description: 'Cambia el tamaño del grid de una página (columnas × filas, 1..12). null = heredar del perfil.',
    scope: 'pages.write',
    inputSchema: {
      type: 'object',
      properties: {
        id: S('string'),
        grid_cols: S('number', 'Columnas 1..12 o null'),
        grid_rows: S('number', 'Filas 1..12 o null'),
      },
      required: ['id'],
    },
  },
  {
    name: 'set_profile_grid',
    description: 'Cambia el grid por defecto de un perfil (gridCols × gridRows, 1..12). Lo heredan las páginas sin tamaño propio.',
    scope: 'profiles.write',
    inputSchema: {
      type: 'object',
      properties: {
        id: S('string'),
        gridCols: S('number', 'Columnas 1..12'),
        gridRows: S('number', 'Filas 1..12'),
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
    description: 'Crea un botón. data admite label, textTop, textBottom, fontSize, icon, emoji, backgroundColor, textColor y actions. En modo libre usa x/y/w/h + widget_type.',
    scope: 'buttons.write',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: S('string'), position: S('number', 'Opcional; por defecto el primer hueco libre'),
        data: S('object', 'Contenido visual + actions (opcional)'),
        widget_type: S('string', "Tipo de widget en modo libre (opcional, ej 'action_button')"),
        x: S('number', 'Columna en modo libre (opcional)'), y: S('number', 'Fila en modo libre (opcional)'),
        w: S('number', 'Ancho en celdas 1..32 (opcional)'), h: S('number', 'Alto en celdas 1..32 (opcional)'),
        parent_widget_id: S('string', 'Widget padre (opcional)'),
      },
      required: ['page_id'],
    },
  },
  {
    name: 'set_button_geometry',
    description: 'Cambia geometría/posición de un botón en modo libre (x, y, w 1..32, h 1..32, widget_type, parent_widget_id, y opcionalmente position/page_id).',
    scope: 'buttons.write',
    inputSchema: {
      type: 'object',
      properties: {
        id: S('string'),
        x: S('number', 'Columna (>= 0, opcional)'), y: S('number', 'Fila (>= 0, opcional)'),
        w: S('number', 'Ancho 1..32 (opcional)'), h: S('number', 'Alto 1..32 (opcional)'),
        widget_type: S('string', 'Tipo de widget (opcional)'), parent_widget_id: S('string', 'Padre (null = ninguno)'),
        position: S('number', 'Posición legacy (opcional)'), page_id: S('string', 'Mover a otra página (opcional)'),
      },
      required: ['id'],
    },
  },
  {
    name: 'update_button',
    description: 'Cambia el contenido de un botón: patch fusiona label/icon/textos/colores; position y page_id lo mueven; x/y/w/h/widget_type cambian su geometría en modo libre.',
    scope: 'buttons.write',
    inputSchema: {
      type: 'object',
      properties: {
        id: S('string'),
        patch: S('object', 'Campos de data a fusionar: label, textTop, textBottom, fontSize, icon, emoji, backgroundColor, textColor'),
        position: S('number', 'Nueva posición (opcional)'),
        page_id: S('string', 'Mover a otra página (opcional)'),
        x: S('number', 'Columna en modo libre (opcional)'), y: S('number', 'Fila en modo libre (opcional)'),
        w: S('number', 'Ancho 1..32 (opcional)'), h: S('number', 'Alto 1..32 (opcional)'),
        widget_type: S('string', 'Tipo de widget (opcional)'), parent_widget_id: S('string', 'Padre (opcional)'),
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
    inputSchema: { type: 'object', properties: { button_id: S('string'), press_type: S('string', "'short'|'long'|'double'|'touch-start'|'touch-end' (opcional, defecto short)"), confirm: S('boolean', 'Obligatorio (true) si el botón tiene acciones sensibles'), device_id: S('string', 'Dispositivo objetivo para la navegación (opcional)'), context: S('object', 'Contexto extra de ejecución (opcional)') }, required: ['button_id'] },
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
  // ---- Dispositivos lógicos ----
  {
    name: 'list_devices',
    description: 'Lista los dispositivos (deck/phone/tablet/browser) con su tamaño.',
    scope: 'devices.read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_device',
    description: 'Detalle de un dispositivo por id (incluye effectiveSize en decks).',
    scope: 'devices.read',
    inputSchema: { type: 'object', properties: { id: S('string') }, required: ['id'] },
  },
  {
    name: 'create_device',
    description: "Crea un dispositivo. kind: 'deck'|'phone'|'tablet'|'browser' (defecto phone). En deck, model (mini/mk2/neo/xl) fija cols/rows salvo override explícito.",
    scope: 'devices.write',
    inputSchema: {
      type: 'object',
      properties: {
        id: S('string', 'Id explícito (opcional)'), name: S('string'),
        kind: S('string', "'deck'|'phone'|'tablet'|'browser' (opcional)"),
        model: S('string', "Modelo deck: 'mini'|'mk2'|'neo'|'xl' (opcional)"),
        cols: S('number', 'Columnas 1..12 (opcional)'), rows: S('number', 'Filas 1..12 (opcional)'),
        hw_path: S('string', 'Path HID del HW enlazado (opcional)'),
      },
      required: ['name'],
    },
  },
  {
    name: 'update_device',
    description: 'Actualiza nombre/kind/modelo/tamaño de un dispositivo. Repara asignaciones incompatibles en todos los perfiles.',
    scope: 'devices.write',
    inputSchema: {
      type: 'object',
      properties: {
        id: S('string'), name: S('string'), kind: S('string', "'deck'|'phone'|'tablet'|'browser'"),
        model: S('string', 'Modelo deck o null'), cols: S('number', 'Columnas 1..12 o null'),
        rows: S('number', 'Filas 1..12 o null'), hw_path: S('string', 'Path HID o null'),
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_device',
    description: 'Elimina un dispositivo lógico (y sus asignaciones).',
    scope: 'devices.write',
    inputSchema: { type: 'object', properties: { id: S('string') }, required: ['id'] },
  },
  {
    name: 'get_assignments',
    description: 'Asignaciones dispositivo → página de un perfil, con compatibilidad (tamaño/modo) de cada una.',
    scope: 'devices.read',
    inputSchema: { type: 'object', properties: { profile_id: S('string') }, required: ['profile_id'] },
  },
  {
    name: 'set_assignments',
    description: 'Fija pantallas por dispositivo en un perfil: {deviceId: pageId|null}. Valida que la página sea del perfil y compatible (deck = cuadrícula + tamaño exacto).',
    scope: 'devices.write',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: S('string'),
        assignments: S('object', 'Mapa deviceId → pageId o null (para quitar)'),
      },
      required: ['profile_id', 'assignments'],
    },
  },
  {
    name: 'get_streamdeck_status',
    description: 'Estado del StreamDeck físico: conectado, geometría detectada y modelo adivinado.',
    scope: 'devices.read',
    inputSchema: { type: 'object', properties: {} },
  },
  // ---- Sesiones y navegación ----
  {
    name: 'list_sessions',
    description: 'Lista clientes conectados y su vista actual (deviceId, perfil/página).',
    scope: 'sessions.read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_session',
    description: 'Vista actual (y persistida) de un dispositivo por deviceId.',
    scope: 'sessions.read',
    inputSchema: { type: 'object', properties: { device_id: S('string') }, required: ['device_id'] },
  },
  {
    name: 'set_session_view',
    description: 'Fija la vista de un dispositivo (perfil/página/startup). Notifica al cliente si está conectado.',
    scope: 'sessions.write',
    inputSchema: {
      type: 'object',
      properties: {
        device_id: S('string'),
        profile_id: S('string', 'Perfil (opcional, null = quitar)'),
        page_id: S('string', 'Página (opcional, null = quitar)'),
        startup_profile_id: S('string', 'Perfil de arranque (opcional, null = quitar)'),
        name: S('string', 'Nombre del cliente (opcional)'), kind: S('string', 'Kind del cliente (opcional)'),
      },
      required: ['device_id'],
    },
  },
  {
    name: 'navigate',
    description: 'Navega un dispositivo (o todos con broadcast:true) a una página o perfil. Exactamente uno de page_id/profile_id.',
    scope: 'sessions.write',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: S('string', 'Página destino (excluyente con profile_id)'),
        profile_id: S('string', 'Perfil destino (excluyente con page_id)'),
        device_id: S('string', 'Dispositivo objetivo (opcional si broadcast:true)'),
        broadcast: S('boolean', 'true = todos los dispositivos (opcional)'),
      },
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
  // ---- Variables tipadas (store nuevo) ----
  {
    name: 'render_variable',
    description: 'Renderiza una plantilla {{var}} con las variables tipadas (scope opcional).',
    scope: 'variables.read',
    inputSchema: {
      type: 'object',
      properties: { template: S('string'), scope: S('string'), scopeId: S('string') },
      required: ['template'],
    },
  },
  {
    name: 'get_scoped_variable',
    description: 'Lee una variable tipada por nombre y scope (global por defecto).',
    scope: 'variables.read',
    inputSchema: {
      type: 'object',
      properties: { name: S('string'), scope: S('string'), scopeId: S('string') },
      required: ['name'],
    },
  },
  {
    name: 'set_scoped_variable',
    description: 'Crea (define) o actualiza una variable tipada con scope (type/scope/scopeId/unavailable/bindings opcionales).',
    scope: 'variables.write',
    inputSchema: {
      type: 'object',
      properties: {
        name: S('string'), value: S(['string', 'number', 'boolean', 'object'] as any, 'Nuevo valor'),
        type: S('string', 'text|numeric|bool|color (opcional)'),
        scope: S('string', 'global|widget|script|automation (opcional)'), scopeId: S('string', 'Id del scope (opcional)'),
        unavailable: S('boolean', 'Marcar como no disponible (opcional)'),
        bindings: S('object', 'Bindings read/write (opcional)'),
      },
      required: ['name', 'value'],
    },
  },
  {
    name: 'delete_scoped_variable',
    description: 'Elimina una variable tipada (nombre + scope).',
    scope: 'variables.write',
    inputSchema: {
      type: 'object',
      properties: { name: S('string'), scope: S('string'), scopeId: S('string') },
      required: ['name'],
    },
  },
  {
    name: 'toggle_variable',
    description: 'Alterna una variable tipada (bool: true/false; numeric: 0/1; text: vacío/valor).',
    scope: 'variables.write',
    inputSchema: {
      type: 'object',
      properties: { name: S('string'), scope: S('string'), scopeId: S('string') },
      required: ['name'],
    },
  },
  // ---- Flow scripts (motor) ----
  {
    name: 'list_flow_scripts',
    description: 'Lista los scripts reutilizables del motor de flows.',
    scope: 'flows.read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_flow_script',
    description: 'Detalle de un script del motor por id.',
    scope: 'flows.read',
    inputSchema: { type: 'object', properties: { id: S('string') }, required: ['id'] },
  },
  {
    name: 'save_flow_script',
    description: 'Crea (id opcional, se genera si falta) o actualiza un script del motor (nodes, name, inputs, timeout).',
    scope: 'flows.write',
    inputSchema: {
      type: 'object',
      properties: {
        id: S('string', 'Id (opcional al crear)'), name: S('string'),
        nodes: S('array', 'Nodos del flow'), inputs: S('array', 'Inputs (opcional)'),
        timeout: S('number', 'Timeout ms (opcional)'),
      },
    },
  },
  {
    name: 'delete_flow_script',
    description: 'Elimina un script del motor por id.',
    scope: 'flows.write',
    inputSchema: { type: 'object', properties: { id: S('string') }, required: ['id'] },
  },
  // ---- Ejecución/observabilidad del motor ----
  {
    name: 'execute_flow_nodes',
    description: 'Ejecuta nodos del motor en orden (context/timeout opcionales). Nodos sensibles exigen confirm:true.',
    scope: 'actions.execute',
    inputSchema: {
      type: 'object',
      properties: {
        nodes: S('array', 'Nodos {kind, type, ...}'),
        context: S('object', 'Contexto (opcional)'), timeout: S('number', 'Timeout ms (opcional)'),
        confirm: S('boolean', 'Obligatorio (true) si hay nodos sensibles'),
      },
      required: ['nodes'],
    },
  },
  {
    name: 'cancel_flow',
    description: 'Cancela una ejecución del motor por run_id.',
    scope: 'flows.write',
    inputSchema: { type: 'object', properties: { run_id: S('string') }, required: ['run_id'] },
  },
  {
    name: 'get_flow_runs',
    description: 'Historial de ejecuciones del motor (limit opcional) o en curso si no hay historial.',
    scope: 'flows.read',
    inputSchema: { type: 'object', properties: { limit: S('number', 'Máx. ejecuciones (opcional)') } },
  },
  {
    name: 'get_flow_stats',
    description: 'Estadísticas del motor (en curso, scripts, automatizaciones, vars).',
    scope: 'flows.read',
    inputSchema: { type: 'object', properties: {} },
  },
  // ---- Automatizaciones (motor) ----
  {
    name: 'emit_automation_event',
    description: 'Dispara las automatizaciones del motor suscritas a un evento.',
    scope: 'automations.write',
    inputSchema: {
      type: 'object',
      properties: { event: S('string'), payload: S('object', 'Datos del evento (opcional)') },
      required: ['event'],
    },
  },
  {
    name: 'resync_automations',
    description: 'Relee todas las teclas y sincroniza las reglas load/timer/var del motor.',
    scope: 'automations.write',
    inputSchema: { type: 'object', properties: {} },
  },
  // ---- Flow-vars (motor) ----
  {
    name: 'list_flow_vars',
    description: 'Lista las variables globales del motor de flows.',
    scope: 'variables.read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_flow_var',
    description: 'Lee una variable del motor por nombre.',
    scope: 'variables.read',
    inputSchema: { type: 'object', properties: { name: S('string') }, required: ['name'] },
  },
  {
    name: 'set_flow_var',
    description: 'Crea o actualiza una variable del motor (name + value).',
    scope: 'variables.write',
    inputSchema: {
      type: 'object',
      properties: { name: S('string'), value: S(['string', 'number', 'boolean', 'object'] as any, 'Nuevo valor') },
      required: ['name', 'value'],
    },
  },
  {
    name: 'delete_flow_var',
    description: 'Elimina una variable del motor por nombre.',
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
  // ---- Backups ----
  {
    name: 'export_backup',
    description: 'Exporta un backup versionado completo (o solo sections: profiles,pages,buttons,widgets,flows,automations,variables,assets,plugins,settings,devices,assignments; las desconocidas se ignoran).',
    scope: 'backups.read',
    inputSchema: { type: 'object', properties: { sections: S('array', 'Secciones a incluir (opcional)', { items: { type: 'string' } }) } },
  },
  {
    name: 'export_profile_backup',
    description: 'Exportación portable de un perfil con sus pantallas, botones y assets usados.',
    scope: 'backups.read',
    inputSchema: { type: 'object', properties: { profile_id: S('string') }, required: ['profile_id'] },
  },
  {
    name: 'validate_backup',
    description: 'Validación pre-restore de un backup (no toca la BD). Devuelve {valid, errors, warnings, info}.',
    scope: 'backups.read',
    inputSchema: { type: 'object', properties: { backup: S('object', 'Objeto backup') }, required: ['backup'] },
  },
  {
    name: 'restore_backup',
    description: 'Restaura un backup (destructivo: exige confirm:true siempre; mode merge por defecto, clean vacía las secciones). Sin undo, prohibido en batch.',
    scope: 'backups.write',
    inputSchema: {
      type: 'object',
      properties: {
        backup: S('object', 'Objeto backup'),
        sections: S('array', 'Secciones a importar (opcional)', { items: { type: 'string' } }),
        mode: S('string', "'merge' (defecto) o 'clean'"),
        confirm: S('boolean', 'Obligatorio (true): el restore es destructivo'),
      },
      required: ['backup'],
    },
  },
  // ---- Assets ----
  {
    name: 'list_assets',
    description: 'Lista los metadatos de assets (imágenes de tecla) registrados.',
    scope: 'assets.read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_asset',
    description: 'Borra un fichero de asset por path o url (destructivo: exige confirm:true). Sin undo, prohibido en batch.',
    scope: 'assets.write',
    inputSchema: {
      type: 'object',
      properties: {
        path: S('string', 'Nombre o ruta del asset (opcional si hay url)'),
        url: S('string', 'URL /assets/<fichero> (opcional si hay path)'),
        confirm: S('boolean', 'Obligatorio (true): el borrado es destructivo'),
      },
    },
  },
  // ---- Sistema ----
  {
    name: 'get_version',
    description: 'Versión del daemon (canal + fecha de build).',
    scope: 'system.read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_system_metrics',
    description: 'Métricas ligeras del sistema (CPU/RAM nativas sin PowerShell; resto degradado honesto, nunca inventado).',
    scope: 'system.read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_network_ips',
    description: 'IPs LAN IPv4 no internas del host.',
    scope: 'system.read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_jobs',
    description: 'Lista las operaciones largas del JobManager (import/build/clone) con su estado.',
    scope: 'system.read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_job',
    description: 'Solicita la cancelación de un job en curso. Sin undo, prohibido en batch.',
    scope: 'system.write',
    inputSchema: { type: 'object', properties: { job_id: S('string') }, required: ['job_id'] },
  },
  {
    name: 'list_catalog',
    description: 'Catálogo local de plugins (offline): búsqueda/filtros opcionales q, category, compatible.',
    scope: 'system.read',
    inputSchema: {
      type: 'object',
      properties: {
        q: S('string', 'Búsqueda (opcional)'), category: S('string', 'Categoría (opcional)'),
        compatible: S('boolean', 'Solo compatibles con esta versión (opcional)'),
      },
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
  'profiles.write', 'pages.write', 'buttons.write', 'devices.write', 'sessions.write',
  'actions.execute', 'plugins.manage', 'plugins.install', 'settings.write',
  'widgets.write', 'flows.write', 'automations.write', 'variables.write',
  'backups.write', 'assets.write', 'system.write',
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

/** Valida dimensión de grid (columnas/filas 1..12). null = heredar. */
function gridDim(v: any, key: string): number | null {
  if (v === undefined) return undefined as any;
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 12) throw new Error(`${key} debe ser entero 1..12 (o null para heredar)`);
  return n;
}

/** Valida layout_mode. */
function layoutMode(v: any): 'classic' | 'gridstack' {
  if (v !== 'classic' && v !== 'gridstack') throw new Error(`layout_mode debe ser 'classic' o 'gridstack'`);
  return v;
}

/** Aplica layoutMode dentro de page.data (fuente canónica: data.layoutMode). */
function withLayoutMode(data: any, mode: 'classic' | 'gridstack' | undefined): any {
  const base = { ...parseData(data) };
  if (mode !== undefined) base.layoutMode = mode;
  return base;
}

/** Lee layoutMode canónico de una página. */
function readLayoutMode(page: any): 'classic' | 'gridstack' {
  return parseData(page?.data)?.layoutMode === 'gridstack' ? 'gridstack' : 'classic';
}

/** Normaliza una fila de página para respuestas MCP (data parseada). */
function pageOut(p: any): any {
  if (!p) return p;
  return { ...p, data: parseData((p as any).data) };
}

/** ¿Hay campos de geometría GridStack en los argumentos? */
function hasGeometryArgs(args: any): boolean {
  return args?.x !== undefined || args?.y !== undefined || args?.w !== undefined
    || args?.h !== undefined || args?.widget_type !== undefined || args?.kind !== undefined
    || args?.parent_widget_id !== undefined;
}

/** Valida geometría parcial para updateButtonWidget (lanza si inválida). */
function checkGeometryArgs(args: any): void {
  for (const k of ['w', 'h'] as const) {
    const v = args?.[k];
    if (v !== undefined && v !== null && (!Number.isInteger(Number(v)) || Number(v) < 1 || Number(v) > 32)) {
      throw new Error(`${k} debe ser entero 1..32`);
    }
  }
  for (const k of ['x', 'y'] as const) {
    const v = args?.[k];
    if (v !== undefined && v !== null && (!Number.isInteger(Number(v)) || Number(v) < 0)) {
      throw new Error(`${k} debe ser entero >= 0`);
    }
  }
}

const DEVICE_KINDS = ['deck', 'phone', 'tablet', 'browser'] as const;

/** Sanea argumentos de dispositivo (espejo de api/devices.ts). Lanza si inválido. */
function cleanDeviceArgs(body: any, isCreate: boolean): any {
  const kind = body?.kind ?? (isCreate ? 'phone' : undefined);
  if (kind !== undefined && !(DEVICE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`kind debe ser uno de: ${DEVICE_KINDS.join(', ')}`);
  }
  if (isCreate && (typeof body?.name !== 'string' || !body.name.trim())) {
    throw new Error('name es obligatorio');
  }
  const out: any = {};
  if (body?.name !== undefined) out.name = String(body.name).slice(0, 80);
  if (kind !== undefined) out.kind = kind;
  if (body?.model !== undefined) out.model = body.model === null ? null : String(body.model).slice(0, 24);
  for (const k of ['cols', 'rows'] as const) {
    if (body?.[k] !== undefined) {
      if (body[k] === null) out[k] = null;
      else {
        const n = Math.floor(Number(body[k]));
        if (!Number.isFinite(n) || n < 1 || n > 12) throw new Error(`${k} debe estar entre 1 y 12`);
        out[k] = n;
      }
    }
  }
  if (body?.hw_path !== undefined) out.hw_path = body.hw_path === null ? null : String(body.hw_path).slice(0, 300);
  const targetKind = kind as string | undefined;
  if (targetKind === 'deck' && (isCreate || body?.kind === 'deck' || body?.model !== undefined)) {
    const model = (body?.model ?? out.model ?? DEFAULT_DECK_MODEL) as string;
    const preset = DECK_MODELS.find((m) => m.id === model);
    if (body?.model !== undefined && body.model !== null && !preset) {
      throw new Error(`model debe ser uno de: ${DECK_MODELS.map((m) => m.id).join(', ')}`);
    }
    if (preset) {
      if (out.model === undefined && body?.model === undefined) out.model = preset.id;
      if (body?.cols === undefined && body?.rows === undefined && out.cols === undefined && out.rows === undefined) {
        out.cols = preset.cols;
        out.rows = preset.rows;
      }
    }
  }
  return out;
}

/** Fila de dispositivo + tamaño efectivo (como GET /devices/:id). */
function deviceOut(db: DatabaseService, id: string): any {
  const d = db.getDevice(id) as any;
  if (!d) return null;
  return { ...d, effectiveSize: d.kind === 'deck' ? resolveDeckSize(d) : null };
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
          try { db.createPage({ id: p.page.id, profile_id: p.page.profile_id, name: p.page.name, order_idx: p.page.order_idx ?? 0, is_folder: p.page.is_folder ?? 0, parent_id: p.page.parent_id ?? null, grid_cols: p.page.grid_cols ?? null, grid_rows: p.page.grid_rows ?? null, data: p.page.data ?? {} } as any); } catch { /* nombre duplicado: noop */ }
        }
        for (const b of p.buttons ?? []) {
          if (!db.getButton(b.id)) {
            try {
              db.createButtonWidget({
                id: b.id, page_id: b.page_id, position: b.position,
                kind: (b as any).widget_type ?? 'action_button',
                x: (b as any).x ?? null, y: (b as any).y ?? null,
                w: (b as any).w ?? 1, h: (b as any).h ?? 1,
                parent_widget_id: (b as any).parent_widget_id ?? null,
                data: (b as any).data ?? {},
              });
            } catch { /* noop */ }
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
        try { db.createPage({ id: page.id, profile_id: page.profile_id, name: page.name, order_idx: page.order_idx ?? 0, is_folder: page.is_folder ?? 0, parent_id: page.parent_id ?? null, grid_cols: page.grid_cols ?? null, grid_rows: page.grid_rows ?? null, data: page.data ?? {} } as any); } catch { /* noop */ }
      }
      for (const b of buttons ?? []) {
        if (!db.getButton(b.id)) {
          try {
            db.createButtonWidget({
              id: b.id, page_id: b.page_id, position: b.position,
              kind: (b as any).widget_type ?? 'action_button',
              x: (b as any).x ?? null, y: (b as any).y ?? null,
              w: (b as any).w ?? 1, h: (b as any).h ?? 1,
              parent_widget_id: (b as any).parent_widget_id ?? null,
              data: (b as any).data ?? {},
            });
          } catch { /* noop */ }
        }
      }
      return { success: true, pageId: page.id };
    }
    case 'update_page': db.updatePage(a.id, { ...(a.name !== undefined ? { name: a.name } : {}), ...(a.order_idx !== undefined ? { order_idx: a.order_idx } : {}), ...(a.is_folder !== undefined ? { is_folder: a.is_folder } : {}), ...(a.parent_id !== undefined ? { parent_id: a.parent_id } : {}), ...(a.grid_cols !== undefined ? { grid_cols: a.grid_cols } : {}), ...(a.grid_rows !== undefined ? { grid_rows: a.grid_rows } : {}), ...(a.data !== undefined ? { data: a.data } : {}) }); return { success: true, pageId: a.id };
    case 'delete_button': db.deleteButton(a.id); return { success: true, buttonId: a.id };
    case '__restore_button': {
      const { button } = a;
      if (!db.getButton(button.id) && db.getPage(button.page_id)) {
        try {
          db.createButtonWidget({
            id: button.id, page_id: button.page_id, position: button.position,
            kind: button.widget_type ?? 'action_button',
            x: button.x ?? null, y: button.y ?? null,
            w: button.w ?? 1, h: button.h ?? 1,
            parent_widget_id: button.parent_widget_id ?? null,
            data: button.data ?? {},
          });
        } catch { /* noop */ }
      }
      return { success: true, buttonId: button.id };
    }
    case '__restore_button_data': db.updateButton(a.button_id, a.data); return { success: true, buttonId: a.button_id };
    case '__restore_button_widget': {
      try {
        db.updateButtonWidget(a.id, {
          ...(a.widget_type !== undefined ? { kind: a.widget_type } : {}),
          ...(a.x !== undefined ? { x: a.x } : {}),
          ...(a.y !== undefined ? { y: a.y } : {}),
          ...(a.w !== undefined ? { w: a.w } : {}),
          ...(a.h !== undefined ? { h: a.h } : {}),
          ...(a.parent_widget_id !== undefined ? { parent_widget_id: a.parent_widget_id } : {}),
          ...(a.data !== undefined ? { data: a.data } : {}),
          ...(a.position !== undefined ? { position: a.position } : {}),
          ...(a.page_id !== undefined ? { page_id: a.page_id } : {}),
        });
      } catch (e) {
        // Posición ocupada al deshacer (el grid cambió): reintenta en hueco libre.
        const msg = e instanceof Error ? e.message : String(e);
        if (/UNIQUE|ocupada|position/i.test(msg) && a.page_id !== undefined) {
          const used = new Set(db.getButtonsByPage(a.page_id).map((b) => b.position));
          let pos = 0;
          while (used.has(pos)) pos++;
          db.updateButtonWidget(a.id, {
            ...(a.widget_type !== undefined ? { kind: a.widget_type } : {}),
            ...(a.x !== undefined ? { x: a.x } : {}),
            ...(a.y !== undefined ? { y: a.y } : {}),
            ...(a.w !== undefined ? { w: a.w } : {}),
            ...(a.h !== undefined ? { h: a.h } : {}),
            ...(a.parent_widget_id !== undefined ? { parent_widget_id: a.parent_widget_id } : {}),
            ...(a.data !== undefined ? { data: a.data } : {}),
            position: pos,
            page_id: a.page_id,
          });
        } else throw e;
      }
      return { success: true, buttonId: a.id };
    }
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
    case 'delete_device': {
      if (isHardwareDeviceId(a.id)) throw new Error('El hardware no se puede eliminar');
      db.deleteDevice(a.id); return { success: true, deviceId: a.id };
    }
    case 'update_device': {
      db.updateDevice(a.id, { ...(a.name !== undefined ? { name: a.name } : {}), ...(a.kind !== undefined ? { kind: a.kind } : {}), ...(a.model !== undefined ? { model: a.model } : {}), ...(a.cols !== undefined ? { cols: a.cols } : {}), ...(a.rows !== undefined ? { rows: a.rows } : {}), ...(a.hw_path !== undefined ? { hw_path: a.hw_path } : {}) });
      return { success: true, deviceId: a.id };
    }
    case '__restore_device': {
      const { device, assignments } = a;
      if (!db.getDevice(device.id)) {
        const { created_at: _c, updated_at: _u, ...cols } = device;
        db.createDevice({ id: cols.id, name: cols.name, kind: cols.kind, model: cols.model ?? null, cols: cols.cols ?? null, rows: cols.rows ?? null, hw_path: cols.hw_path ?? null });
      }
      for (const asg of assignments ?? []) {
        if (asg.pageId === null || asg.pageId === undefined) db.clearAssignment(asg.profileId, device.id);
        else if (db.getDevice(device.id) && db.getPage(asg.pageId)) db.setAssignment(asg.profileId, device.id, asg.pageId);
      }
      return { success: true, deviceId: device.id };
    }
    case '__restore_assignments': {
      const { profile_id, assignments } = a;
      if (!db.getProfile(profile_id)) throw new Error(`Perfil no encontrado: ${profile_id}`);
      for (const [deviceId, pageId] of Object.entries(assignments ?? {})) {
        if (!db.getDevice(deviceId)) continue;
        if (pageId === null || pageId === undefined) db.clearAssignment(profile_id, deviceId);
        else if (db.getPage(String(pageId))) db.setAssignment(profile_id, deviceId, String(pageId));
      }
      return { success: true, profileId: profile_id };
    }
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
    case '__restore_scoped_variable': {
      const store = getVariableStore();
      const { name, scope, scopeId, prev } = a;
      try { await store.delete(String(name), scope, scopeId); } catch { /* noop */ }
      if (prev) {
        const redef = {
          name: prev.name ?? String(name),
          type: prev.type,
          scope: prev.scope,
          scopeId: prev.scopeId,
          value: prev.value,
          unavailable: prev.unavailable,
          bindings: prev.bindings ?? null,
        };
        try {
          store.define(redef);
        } catch {
          // La fila previa seguía existiendo (fallback global): elimina exacto y re-define.
          try { await store.delete(redef.name, redef.scope, redef.scopeId); } catch { /* noop */ }
          store.define(redef);
        }
      }
      return { success: true, name };
    }
    case 'toggle_variable': {
      const store = getVariableStore();
      const def = await store.toggle(String(a.name), { scope: a.scope, scopeId: a.scopeId, source: 'mcp-undo' });
      return { success: true, variable: varToJSON(def) };
    }
    case 'delete_flow_script': {
      (ctx.actionRunner as any)?.deleteFlowScript?.(String(a.id));
      return { success: true, scriptId: a.id };
    }
    case '__restore_flow_script': {
      const r = ctx.actionRunner as any;
      if (typeof r?.saveFlowScript !== 'function' || typeof r?.deleteFlowScript !== 'function') {
        throw new Error('Motor sin flow-scripts (método no disponible)');
      }
      if (a.script === null || a.script === undefined) {
        try { r.deleteFlowScript(String(a.id)); } catch { /* ya eliminado */ }
        return { success: true, scriptId: a.id };
      }
      r.saveFlowScript({ ...a.script, id: a.script.id ?? a.id });
      return { success: true, scriptId: a.script.id ?? a.id };
    }
    case '__restore_flow_var': {
      const r = ctx.actionRunner as any;
      if (typeof r?.setFlowVar !== 'function' || typeof r?.deleteFlowVar !== 'function') {
        throw new Error('Motor sin flow-vars (método no disponible)');
      }
      if (a.prev === null || a.prev === undefined) {
        try { r.deleteFlowVar(String(a.name)); } catch { /* ya eliminada */ }
      } else {
        r.setFlowVar(a.prev.name ?? String(a.name), a.prev.value);
      }
      return { success: true, name: a.name };
    }
    default:
      throw new Error(`Inversa no soportada: ${inverse.tool}`);
  }
}

// ---- Batch atómico: validación previa + compensación ----

/** Tools con efectos no transaccionales: prohibidas dentro de execute_batch. */
const BATCH_DENY = new Set([
  'execute_action', 'press_button', 'execute_flow', 'execute_flow_nodes', 'cancel_flow',
  'emit_automation_event', 'resync_automations',
  'install_plugin', 'install_plugin_from_git', 'update_plugin', 'uninstall_plugin',
  'reload_plugin', 'rollback_plugin', 'enable_plugin', 'disable_plugin',
  'get_plugin_settings', 'save_plugin_settings',
  'navigate', 'set_session_view',
  'restore_backup', 'delete_asset', 'cancel_job',
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
  const { db, pluginLoader, actionRunner } = ctx;
  const need = (k: string) => {
    if (args?.[k] === undefined) throw new Error(`'${name}': ${k} requerido`);
  };
  /** Script del motor por id (flowStore.getScript o listFlowScripts; null si no existe/disponible). */
  const runnerScript = (id: string): any => {
    try {
      const r = actionRunner as any;
      const s = r?.flowStore?.getScript?.(String(id));
      if (s) return s;
      if (typeof r?.listFlowScripts === 'function') {
        return r.listFlowScripts().find((x: any) => x?.id === String(id)) ?? null;
      }
    } catch { /* noop */ }
    return null;
  };
  /** Variable del motor por nombre (null si no existe/disponible). */
  const runnerFlowVar = (vname: string): any => {
    try {
      const r = actionRunner as any;
      if (typeof r?.getFlowVar === 'function') return r.getFlowVar(String(vname)) ?? null;
    } catch { /* noop */ }
    return null;
  };
  switch (name) {
    case 'create_profile': {
      need('name');
      if (args?.gridCols !== undefined) gridDim(args.gridCols, 'gridCols');
      if (args?.gridRows !== undefined) gridDim(args.gridRows, 'gridRows');
      break;
    }
    case 'set_profile_grid': {
      need('id'); if (!db.getProfile(args.id)) throw new Error(`'${name}': perfil no encontrado`);
      if (args?.gridCols !== undefined) gridDim(args.gridCols, 'gridCols');
      if (args?.gridRows !== undefined) gridDim(args.gridRows, 'gridRows');
      break;
    }
    case 'update_profile': case 'delete_profile': {
      need('id'); if (name !== 'create_profile' && !db.getProfile(args.id)) throw new Error(`'${name}': perfil no encontrado`);
      if (args?.gridCols !== undefined) gridDim(args.gridCols, 'gridCols');
      if (args?.gridRows !== undefined) gridDim(args.gridRows, 'gridRows');
      break;
    }
    case 'set_current_profile': need('profile_id'); if (!db.getProfile(args.profile_id)) throw new Error('Perfil no encontrado'); break;
    case 'create_page': {
      need('profile_id'); need('name'); if (!db.getProfile(args.profile_id)) throw new Error('Perfil no encontrado');
      if (args?.grid_cols !== undefined && args.grid_cols !== null) gridDim(args.grid_cols, 'grid_cols');
      if (args?.grid_rows !== undefined && args.grid_rows !== null) gridDim(args.grid_rows, 'grid_rows');
      if (args?.layout_mode !== undefined) layoutMode(args.layout_mode);
      if (args?.parent_id !== undefined && args.parent_id !== null && !db.getPage(args.parent_id)) throw new Error('Carpeta padre no encontrada');
      break;
    }
    case 'update_page': case 'delete_page': {
      need('id'); if (!db.getPage(args.id)) throw new Error('Página no encontrada');
      if (args?.grid_cols !== undefined && args.grid_cols !== null) gridDim(args.grid_cols, 'grid_cols');
      if (args?.grid_rows !== undefined && args.grid_rows !== null) gridDim(args.grid_rows, 'grid_rows');
      if (args?.layout_mode !== undefined) layoutMode(args.layout_mode);
      if (args?.parent_id !== undefined && args.parent_id !== null && !db.getPage(args.parent_id)) throw new Error('Carpeta padre no encontrada');
      break;
    }
    case 'set_page_layout': {
      need('id'); need('layout_mode'); if (!db.getPage(args.id)) throw new Error('Página no encontrada');
      layoutMode(args.layout_mode); break;
    }
    case 'set_page_grid': {
      need('id'); if (!db.getPage(args.id)) throw new Error('Página no encontrada');
      if (args?.grid_cols !== undefined && args.grid_cols !== null) gridDim(args.grid_cols, 'grid_cols');
      if (args?.grid_rows !== undefined && args.grid_rows !== null) gridDim(args.grid_rows, 'grid_rows');
      break;
    }
    case 'set_current_page': need('page_id'); if (!db.getPage(args.page_id)) throw new Error('Página no encontrada'); break;
    case 'create_button': {
      need('page_id'); if (!db.getPage(args.page_id)) throw new Error('Página no encontrada');
      if (args.position !== undefined && (!Number.isInteger(Number(args.position)) || Number(args.position) < 0)) throw new Error('position inválida');
      if (hasGeometryArgs(args)) checkGeometryArgs({ ...args, w: args.w !== undefined ? Number(args.w) : undefined, h: args.h !== undefined ? Number(args.h) : undefined, x: args.x !== undefined ? Number(args.x) : undefined, y: args.y !== undefined ? Number(args.y) : undefined });
      break;
    }
    case 'update_button': case 'move_button': case 'delete_button': case 'duplicate_button': {
      need('id'); if (!db.getButton(args.id)) throw new Error('Botón no encontrado');
      const target = args.page_id ?? (name === 'update_button' ? undefined : db.getButton(args.id)?.page_id);
      if (target !== undefined && !db.getPage(target)) throw new Error('Página destino no encontrada');
      if (hasGeometryArgs(args)) checkGeometryArgs({ ...args, w: args.w !== undefined ? Number(args.w) : undefined, h: args.h !== undefined ? Number(args.h) : undefined, x: args.x !== undefined ? Number(args.x) : undefined, y: args.y !== undefined ? Number(args.y) : undefined });
      break;
    }
    case 'set_button_geometry': {
      need('id'); if (!db.getButton(args.id)) throw new Error('Botón no encontrado');
      if (args?.page_id !== undefined && !db.getPage(args.page_id)) throw new Error('Página destino no encontrada');
      checkGeometryArgs({ ...args, w: args.w !== undefined ? Number(args.w) : undefined, h: args.h !== undefined ? Number(args.h) : undefined, x: args.x !== undefined ? Number(args.x) : undefined, y: args.y !== undefined ? Number(args.y) : undefined });
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
    case 'create_device': {
      need('name'); cleanDeviceArgs(args, true); break;
    }
    case 'update_device': case 'delete_device': case 'get_device': {
      need('id'); if (!db.getDevice(args.id)) throw new Error('Dispositivo no encontrado');
      if (name === 'update_device') cleanDeviceArgs(args, false);
      break;
    }
    case 'get_assignments': {
      need('profile_id'); if (!db.getProfile(args.profile_id)) throw new Error('Perfil no encontrado'); break;
    }
    case 'set_assignments': {
      need('profile_id'); if (!db.getProfile(args.profile_id)) throw new Error('Perfil no encontrado');
      if (!args?.assignments || typeof args.assignments !== 'object' || Array.isArray(args.assignments)) throw new Error('assignments requerido (objeto deviceId → pageId|null)');
      break;
    }
    case 'get_session': need('device_id'); break;
    case 'update_widget': case 'delete_widget': case 'get_widget':
      need('id'); if (name.startsWith('update') || name.startsWith('delete')) { if (!db.getWidget(args.id)) throw new Error('Widget no encontrado'); } break;
    case 'update_flow': case 'delete_flow': case 'get_flow':
      need('id'); if (name !== 'get_flow' && !db.getFlow(args.id)) throw new Error('Flow no encontrado'); break;
    case 'update_automation': case 'delete_automation': case 'set_automation_enabled': case 'get_automation': {
      need('id'); if (name !== 'get_automation' && !db.getAutomation(args.id)) throw new Error('Automatización no encontrada'); break;
    }
    case 'get_variable': case 'delete_variable': need('name'); break;
    case 'set_variable': need('name'); if (args.value === undefined) throw new Error('value requerido'); break;
    case 'render_variable': need('template'); break;
    case 'set_scoped_variable': need('name'); if (args.value === undefined) throw new Error(`'${name}': value requerido`); break;
    case 'get_scoped_variable': case 'delete_scoped_variable': case 'toggle_variable': need('name'); break;
    case 'get_flow_script': case 'delete_flow_script': {
      need('id'); if (!runnerScript(args.id)) throw new Error('Script no encontrado');
      break;
    }
    case 'save_flow_script': {
      const existing = args?.id !== undefined ? runnerScript(args.id) : null;
      if (!existing && !args?.name) throw new Error(`'${name}': name requerido para crear`);
      if (args?.nodes !== undefined && !Array.isArray(args.nodes)) throw new Error('nodes debe ser un array');
      break;
    }
    case 'get_flow_var': case 'delete_flow_var': {
      need('name'); if (!runnerFlowVar(args.name)) throw new Error('Variable no encontrada');
      break;
    }
    case 'set_flow_var': need('name'); if (args.value === undefined) throw new Error(`'${name}': value requerido`); break;
    case 'set_setting': need('key'); if (args.value === undefined) throw new Error('value requerido'); break;
    case 'export_backup': {
      if (args?.sections !== undefined && !Array.isArray(args.sections)) throw new Error(`'${name}': sections debe ser un array`);
      break;
    }
    case 'export_profile_backup': {
      need('profile_id'); if (!db.getProfile(args.profile_id)) throw new Error(`'${name}': perfil no encontrado`); break;
    }
    case 'validate_backup': {
      if (args?.backup === undefined || typeof args.backup !== 'object' || Array.isArray(args.backup)) throw new Error(`'${name}': backup requerido (objeto)`);
      break;
    }
    case 'get_setting': case 'get_plugin': case 'get_profile': case 'get_page': case 'get_button':
    case 'list_devices':
    case 'list_sessions': case 'get_streamdeck_status':
    case 'list_profiles': case 'list_pages': case 'list_buttons': case 'list_widgets': case 'list_flows':
    case 'list_automations': case 'list_variables': case 'list_settings': case 'list_actions':
    case 'list_flow_scripts': case 'get_flow_runs': case 'get_flow_stats':
    case 'list_flow_vars':
    case 'get_state': case 'get_logs': case 'validate_manifest': case 'get_plugin_template':
    case 'list_assets': case 'get_version': case 'get_system_metrics': case 'get_network_ips':
    case 'list_jobs': case 'list_catalog':
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
      let devices: any[] = [];
      let assignments: Record<string, string> = {};
      try {
        devices = db.listDevices().map((d: any) => ({ ...d, effectiveSize: d.kind === 'deck' ? resolveDeckSize(d) : null }));
        if (profile) assignments = db.getAssignments(profile.id);
      } catch { /* sin tabla devices: se omite */ }
      let sessions: any[] | null = null;
      try { sessions = (ctx.ws as any)?.getSessions?.() ?? null; } catch { sessions = null; }
      return {
        // compat con 1.x
        profile: profile ? { id: profile.id, name: profile.name, data: parseData((profile as any).data) } : null,
        page: page ? { id: (page as any).id, name: (page as any).name, grid_cols: (page as any).grid_cols ?? null, grid_rows: (page as any).grid_rows ?? null, layoutMode: readLayoutMode(page) } : null,
        buttons: (buttons as any[]).map((b) => ({ id: b.id, position: b.position, data: b.data, widget_type: (b as any).widget_type ?? null, x: (b as any).x ?? null, y: (b as any).y ?? null, w: (b as any).w ?? 1, h: (b as any).h ?? 1 })),
        plugins,
        // extendido
        current: { profileId: profileId || null, pageId: pageId || null },
        profiles: profiles.map((p) => ({ id: p.id, name: p.name, data: parseData((p as any).data) })),
        pages: pages.map((p: any) => ({ id: p.id, name: p.name, order_idx: p.order_idx, is_folder: p.is_folder, parent_id: p.parent_id ?? null, grid_cols: p.grid_cols ?? null, grid_rows: p.grid_rows ?? null, layoutMode: readLayoutMode(p), data: parseData(p.data) })),
        devices,
        assignments,
        sessions,
        counts: { profiles: profiles.length, pages: pages.length, buttons: buttons.length, plugins: plugins.length, widgets: widgets.length, flows: flows.length, automations: automations.length, variables: variables.length, devices: devices.length },
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
      const data: any = { ...(parseData(args?.data)) };
      if (args?.gridCols !== undefined) data.gridCols = gridDim(args.gridCols, 'gridCols');
      if (args?.gridRows !== undefined) data.gridRows = gridDim(args.gridRows, 'gridRows');
      const created = db.createProfile({ id: randomUUID(), name: reqStr(args, 'name'), data });
      // Si el usuario recrea el `default`, se levanta el veto de borrado.
      if (String(args?.name ?? '').toLowerCase() === 'default') {
        try { db.deleteSetting('default.dismissed'); } catch { /* noop */ }
      }
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
      // Renombrar a `default` lo vuelve a gestionar (levanta el veto).
      if (String(args?.name ?? '').toLowerCase() === 'default') {
        try { db.deleteSetting('default.dismissed'); } catch { /* noop */ }
      }
      const merged: any = { ...parseData(existing.data), ...(args?.data !== undefined ? parseData(args.data) : {}) };
      if (args?.gridCols !== undefined) merged.gridCols = gridDim(args.gridCols, 'gridCols');
      if (args?.gridRows !== undefined) merged.gridRows = gridDim(args.gridRows, 'gridRows');
      if (args?.data !== undefined || args?.gridCols !== undefined || args?.gridRows !== undefined) updates.data = merged;
      db.updateProfile(id, updates);
      const updated = db.getProfile(id);
      ctx.ws?.broadcastProfileUpdate(id, updated);
      recordInverse(ctx, 'update_profile', `actualizar perfil ${id}`, {
        tool: 'update_profile', arguments: { id, name: existing.name, data: parseData(existing.data) },
      });
      return { profile: updated ? { ...updated, data: parseData(updated.data) } : null };
    }
    case 'set_profile_grid': {
      const id = reqStr(args, 'id');
      const existing = db.getProfile(id);
      if (!existing) throw new Error('Perfil no encontrado');
      const prevData = parseData(existing.data);
      const merged: any = { ...prevData };
      if (args?.gridCols !== undefined) merged.gridCols = gridDim(args.gridCols, 'gridCols');
      if (args?.gridRows !== undefined) merged.gridRows = gridDim(args.gridRows, 'gridRows');
      db.updateProfile(id, { data: merged });
      const updated = db.getProfile(id);
      ctx.ws?.broadcastProfileUpdate(id, updated);
      recordInverse(ctx, 'set_profile_grid', `grid del perfil ${id}`, {
        tool: 'update_profile', arguments: { id, data: prevData },
      });
      return { profile: updated ? { ...updated, data: parseData(updated.data) } : null };
    }
    case 'delete_profile': {
      const id = reqStr(args, 'id');
      const snap = db.getProfile(id);
      if (!snap) throw new Error('Perfil no encontrado');
      // El `default` SÍ se puede borrar: se marca el veto para no recrearlo
      // solo en el arranque (se respeta la decisión del usuario).
      if (id === 'default' || (snap as any).name === 'default') {
        try { db.setSetting('default.dismissed', '1'); } catch { /* noop */ }
      }
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
      // Cambio global: reasigna por dispositivo (cada pantalla salta a SU
      // página del perfil nuevo). Sin WS se degrada al camino antiguo.
      if (ctx.ws && typeof (ctx.ws as any).navigateProfileTo === 'function') {
        const res = (ctx.ws as any).navigateProfileTo({
          profileId, originDeviceId: null, targets: { kind: 'all' as const }, context: { via: 'mcp' },
        });
        if (!res?.ok) throw new Error(res?.error ?? 'No se pudo cambiar de perfil');
      } else {
        db.setCurrentProfile(profileId);
        ctx.ws?.broadcast('profile.navigate', { profileId }, 'profiles');
      }
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
      const profileId = reqStr(args, 'profile_id');
      if (!db.getProfile(profileId)) throw new Error('Perfil no encontrado');
      if (args?.parent_id !== undefined && args.parent_id !== null && !db.getPage(args.parent_id)) throw new Error('Carpeta padre no encontrada');
      const layout = args?.layout_mode !== undefined ? layoutMode(args.layout_mode) : undefined;
      const data = withLayoutMode(args?.data ?? {}, layout);
      const page = {
        id: randomUUID(),
        profile_id: profileId,
        name: reqStr(args, 'name'),
        order_idx: Number(args?.order_idx ?? 0),
        is_folder: Number(args?.is_folder ?? 0),
        parent_id: args?.parent_id ?? null,
        grid_cols: args?.grid_cols !== undefined ? gridDim(args.grid_cols, 'grid_cols') : null,
        grid_rows: args?.grid_rows !== undefined ? gridDim(args.grid_rows, 'grid_rows') : null,
        data,
      };
      db.createPage(page as any);
      ctx.ws?.broadcastPageCreated(page.id, page);
      recordInverse(ctx, 'create_page', `crear página ${page.name}`, { tool: 'delete_page', arguments: { id: page.id } });
      return { page: pageOut(db.getPage(page.id)) };
    }
    case 'update_page': {
      const id = reqStr(args, 'id');
      const existing = db.getPage(id) as any;
      if (!existing) throw new Error('Página no encontrada');
      if (args?.parent_id !== undefined && args.parent_id !== null && !db.getPage(args.parent_id)) throw new Error('Carpeta padre no encontrada');
      const prev = { name: existing.name, order_idx: existing.order_idx, is_folder: existing.is_folder, parent_id: existing.parent_id ?? null, grid_cols: existing.grid_cols ?? null, grid_rows: existing.grid_rows ?? null, data: parseData(existing.data) };
      const updates: any = {};
      if (args?.name !== undefined) updates.name = reqStr(args, 'name');
      if (args?.order_idx !== undefined) updates.order_idx = Number(args.order_idx);
      if (args?.is_folder !== undefined) updates.is_folder = Number(args.is_folder);
      if (args?.parent_id !== undefined) updates.parent_id = args.parent_id;
      if (args?.grid_cols !== undefined) updates.grid_cols = gridDim(args.grid_cols, 'grid_cols');
      if (args?.grid_rows !== undefined) updates.grid_rows = gridDim(args.grid_rows, 'grid_rows');
      const layout = args?.layout_mode !== undefined ? layoutMode(args.layout_mode) : undefined;
      if (args?.data !== undefined || layout !== undefined) updates.data = withLayoutMode({ ...parseData(existing.data), ...parseData(args?.data) }, layout);
      db.updatePage(id, updates);
      const updated = db.getPage(id);
      ctx.ws?.broadcast('page.updated', { pageId: id, page: updated }, 'pages');
      repaint(ctx, id);
      recordInverse(ctx, 'update_page', `actualizar página ${id}`, { tool: 'update_page', arguments: { id, ...prev } });
      return { page: pageOut(updated) };
    }
    case 'set_page_layout': {
      const id = reqStr(args, 'id');
      const existing = db.getPage(id) as any;
      if (!existing) throw new Error('Página no encontrada');
      const mode = layoutMode(reqStr(args, 'layout_mode'));
      const prevData = parseData(existing.data);
      db.updatePage(id, { data: withLayoutMode(prevData, mode) });
      const updated = db.getPage(id);
      ctx.ws?.broadcast('page.updated', { pageId: id, page: updated }, 'pages');
      repaint(ctx, id);
      recordInverse(ctx, 'set_page_layout', `modo ${mode} en página ${id}`, { tool: 'update_page', arguments: { id, data: prevData } });
      return { page: pageOut(updated) };
    }
    case 'set_page_grid': {
      const id = reqStr(args, 'id');
      const existing = db.getPage(id) as any;
      if (!existing) throw new Error('Página no encontrada');
      const prev = { grid_cols: existing.grid_cols ?? null, grid_rows: existing.grid_rows ?? null };
      const updates: any = {};
      if (args?.grid_cols !== undefined) updates.grid_cols = gridDim(args.grid_cols, 'grid_cols');
      if (args?.grid_rows !== undefined) updates.grid_rows = gridDim(args.grid_rows, 'grid_rows');
      db.updatePage(id, updates);
      const updated = db.getPage(id);
      ctx.ws?.broadcast('page.updated', { pageId: id, page: updated }, 'pages');
      repaint(ctx, id);
      recordInverse(ctx, 'set_page_grid', `grid de página ${id}`, { tool: 'update_page', arguments: { id, ...prev } });
      return { page: pageOut(updated) };
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
      checkGeometryArgs(args);
      const id = randomUUID();
      try {
        if (hasGeometryArgs(args)) {
          db.createButtonWidget({
            id, page_id: pageId, position,
            kind: args?.widget_type ?? args?.kind ?? 'action_button',
            x: args?.x !== undefined ? Number(args.x) : null,
            y: args?.y !== undefined ? Number(args.y) : null,
            w: args?.w !== undefined ? Number(args.w) : 1,
            h: args?.h !== undefined ? Number(args.h) : 1,
            parent_widget_id: args?.parent_widget_id ?? null,
            data: args?.data ?? {},
          });
        } else {
          db.createButton({ id, page_id: pageId, position, data: args?.data ?? {} } as any);
        }
      } catch (e) {
        throw new Error(`No se pudo crear el botón (¿posición ${position} ocupada?): ${e instanceof Error ? e.message : String(e)}`);
      }
      const created = db.getButton(id);
      ctx.ws?.broadcast('button.created', { buttonId: id, button: created }, 'buttons');
      repaint(ctx, pageId);
      recordInverse(ctx, 'create_button', `crear botón ${id}`, { tool: 'delete_button', arguments: { id } });
      return { button: created };
    }
    case 'set_button_geometry': {
      const id = reqStr(args, 'id');
      const existing = db.getButton(id);
      if (!existing) throw new Error('Botón no encontrado');
      checkGeometryArgs(args);
      if (args?.page_id !== undefined && !db.getPage(args.page_id)) throw new Error('Página destino no encontrada');
      const prev = snapshotButton(db, id)!;
      const updates: any = {};
      if (args?.widget_type !== undefined) updates.kind = args.widget_type;
      if (args?.x !== undefined) updates.x = args.x === null ? null : Number(args.x);
      if (args?.y !== undefined) updates.y = args.y === null ? null : Number(args.y);
      if (args?.w !== undefined) updates.w = Number(args.w);
      if (args?.h !== undefined) updates.h = Number(args.h);
      if (args?.parent_widget_id !== undefined) updates.parent_widget_id = args.parent_widget_id;
      if (args?.position !== undefined) {
        if (!Number.isInteger(Number(args.position)) || Number(args.position) < 0) throw new Error('position inválida');
        updates.position = Number(args.position);
      }
      if (args?.page_id !== undefined) updates.page_id = args.page_id;
      const updated = db.updateButtonWidget(id, updates);
      ctx.ws?.broadcastButtonUpdate(id, updated);
      repaint(ctx, (updated as any).page_id);
      recordInverse(ctx, 'set_button_geometry', `geometría del botón ${id}`, {
        tool: '__restore_button_widget',
        arguments: {
          id, widget_type: (prev as any).widget_type ?? null,
          x: (prev as any).x ?? null, y: (prev as any).y ?? null,
          w: (prev as any).w ?? 1, h: (prev as any).h ?? 1,
          parent_widget_id: (prev as any).parent_widget_id ?? null,
          data: (prev as any).data, position: (prev as any).position, page_id: (prev as any).page_id,
        },
      });
      return { button: updated };
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
      const geo = hasGeometryArgs(args);
      if (geo) checkGeometryArgs(args);
      try {
        if (geo) {
          db.updateButtonWidget(id, {
            ...(args?.widget_type !== undefined ? { kind: args.widget_type } : {}),
            ...(args?.x !== undefined ? { x: args.x === null ? null : Number(args.x) } : {}),
            ...(args?.y !== undefined ? { y: args.y === null ? null : Number(args.y) } : {}),
            ...(args?.w !== undefined ? { w: Number(args.w) } : {}),
            ...(args?.h !== undefined ? { h: Number(args.h) } : {}),
            ...(args?.parent_widget_id !== undefined ? { parent_widget_id: args.parent_widget_id } : {}),
            data, position, page_id: targetPage,
          });
        } else if (targetPage !== fromPage) db.moveButton(id, targetPage, position);
        else db.updateButtonComplete(id, { data, position });
      } catch (e) {
        throw new Error(`No se pudo mover/actualizar (¿posición ${position} ocupada?): ${e instanceof Error ? e.message : String(e)}`);
      }
      const updated = db.getButton(id);
      ctx.ws?.broadcastButtonUpdate(id, updated);
      repaint(ctx, fromPage);
      repaint(ctx, targetPage);
      // Una sola entrada de undo: restaura geometría + data y devuelve a su página/posición.
      recordInverse(ctx, name, `mover/actualizar botón ${id}`, {
        tool: '__batch',
        arguments: {},
        batch: [
          { tool: '__restore_button_widget', arguments: { id, widget_type: (prev as any).widget_type ?? null, x: (prev as any).x ?? null, y: (prev as any).y ?? null, w: (prev as any).w ?? 1, h: (prev as any).h ?? 1, parent_widget_id: (prev as any).parent_widget_id ?? null, data: prev.data, position: prev.position, page_id: prev.page_id } },
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
      const copyId = randomUUID();
      try {
        db.createButtonWidget({
          id: copyId, page_id: targetPage, position,
          kind: (existing as any).widget_type ?? 'action_button',
          x: (existing as any).x ?? null, y: (existing as any).y ?? null,
          w: (existing as any).w ?? 1, h: (existing as any).h ?? 1,
          parent_widget_id: (existing as any).parent_widget_id ?? null,
          data: structuredClone(parseData(existing.data)),
        });
      } catch (e) {
        throw new Error(`No se pudo duplicar (¿posición ${position} ocupada?): ${e instanceof Error ? e.message : String(e)}`);
      }
      const copy = db.getButton(copyId);
      ctx.ws?.broadcast('button.created', { buttonId: copyId, button: copy }, 'buttons');
      repaint(ctx, targetPage);
      recordInverse(ctx, 'duplicate_button', `duplicar botón ${id}`, { tool: 'delete_button', arguments: { id: copyId } });
      return { button: copy };
    }
    case 'press_button': {
      const PRESS_TYPES = ['short', 'long', 'double', 'touch-start', 'touch-end'] as const;
      const buttonId = reqStr(args, 'button_id');
      const existing = db.getButton(buttonId);
      if (!existing) throw new Error('Botón no encontrado');
      const rawPress = args?.press_type ?? args?.pressType ?? 'short';
      const pressType = String(rawPress);
      if (!(PRESS_TYPES as readonly string[]).includes(pressType)) {
        throw new Error(`press_type inválido: '${rawPress}' (usa ${PRESS_TYPES.join(', ')})`);
      }
      const actions = parseData(existing.data)?.actions ?? [];
      requireBatchConfirmIfSensitive(ctx, actions, args, `El botón ${buttonId}`);
      const targets = args?.device_id !== undefined && args.device_id !== null
        ? { kind: 'devices' as const, ids: [String(args.device_id)] }
        : { kind: 'all' as const };
      const pageId = (existing as any)?.page_id ?? (existing as any)?.pageId ?? null;
      const runCtx = { ...(args?.context ?? {}), buttonId, timestamp: Date.now(), pressType };
      // Camino canónico: executeButtonFlow (igual que web/HW en api/flows.ts).
      if (typeof (actionRunner as any)?.executeButtonFlow === 'function') {
        const result = await (actionRunner as any).executeButtonFlow(existing, runCtx);
        const leaves: any[] = [];
        const collect = (node: any) => {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) { for (const s of node) collect(s); return; }
          if (node.action === 'navigate_to_page' || node.action === 'navigate_to_profile') { leaves.push(node); }
          const inner = node.result ?? node.results ?? node.output ?? null;
          if (inner && inner !== node) collect(inner);
          const branches = node.branches;
          if (Array.isArray(branches)) for (const b of branches) collect(b?.results ?? b);
        };
        collect((result as any)?.results ?? []);
        for (const leaf of leaves) {
          if (leaf?.action === 'navigate_to_page' && leaf.pageId) {
            try {
              (ctx.ws as any)?.navigatePageTo?.({
                pageId: leaf.pageId, pageName: leaf.pageName,
                originDeviceId: null, targets, context: { via: 'mcp' },
              });
            } catch { /* mejor esfuerzo */ }
          }
          if (leaf?.action === 'navigate_to_profile' && leaf.profileId) {
            try {
              (ctx.ws as any)?.navigateProfileTo?.({
                profileId: leaf.profileId,
                originDeviceId: null, targets, context: { via: 'mcp' },
              });
            } catch { /* mejor esfuerzo */ }
          }
        }
        if (pageId) repaint(ctx, pageId);
        return { buttonId, pressType, ...result };
      }
      // Fallback legacy (tests viejos sin executeButtonFlow): bucle con executeAction.
      const results: any[] = [];
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        try {
          const r = await actionRunner.executeAction(
            { type: a.type, parameters: a.parameters ?? {} },
            { buttonId, timestamp: Date.now(), pressType } as any
          );
          results.push({ index: i, type: a.type, success: r?.success !== false, result: r });
        } catch (e) {
          results.push({ index: i, type: a?.type, success: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { buttonId, pressType, executed: results.length, results };
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
    // ---- dispositivos lógicos ----
    case 'list_devices':
      return { devices: db.listDevices().map((d: any) => ({ ...d, effectiveSize: d.kind === 'deck' ? resolveDeckSize(d) : null })) };
    case 'get_device': {
      const d = deviceOut(db, reqStr(args, 'id'));
      if (!d) throw new Error('Dispositivo no encontrado');
      return { device: d };
    }
    case 'create_device': {
      const cleaned = cleanDeviceArgs(args, true);
      let id = randomUUID();
      if (typeof args?.id === 'string' && args.id.length >= 1 && args.id.length <= 64 && !db.getDevice(args.id)) {
        id = args.id;
      }
      const created = db.createDevice({ id, ...cleaned });
      ctx.ws?.broadcast('device.created', { device: created }, 'pages');
      recordInverse(ctx, 'create_device', `crear dispositivo ${created.name}`, { tool: 'delete_device', arguments: { id } });
      return { device: deviceOut(db, id) };
    }
    case 'update_device': {
      const id = reqStr(args, 'id');
      const prevRaw = db.getDevice(id) as any;
      if (!prevRaw) throw new Error('Dispositivo no encontrado');
      // El hardware solo admite renombrar (igual que PUT /devices/:id).
      if (isHardwareDeviceId(id)) {
        const forbidden = ['kind', 'model', 'cols', 'rows', 'hw_path'].filter((k) => (args as any)?.[k] !== undefined);
        if (forbidden.length > 0) throw new Error(`El hardware solo admite renombrar (campos bloqueados: ${forbidden.join(', ')})`);
      }
      // Clon profundo: el store puede devolver referencias vivas (el mock
      // global de la suite muta la fila in place) y la inversa debe ver
      // los valores previos, no los ya actualizados (igual que snapshotButton).
      const prev = JSON.parse(JSON.stringify(prevRaw));
      const cleaned = cleanDeviceArgs(args, false);
      if (Object.keys(cleaned).length === 0) throw new Error('nada que actualizar: indica name, kind, model, cols, rows o hw_path');
      const updated = db.updateDevice(id, cleaned);
      const profiles = db.getProfiles();
      const repaired: Record<string, unknown> = {};
      for (const p of profiles) repaired[p.id] = db.repairAssignments(p.id);
      ctx.ws?.broadcast('device.updated', { device: updated }, 'pages');
      ctx.ws?.broadcast('assignment.updated', { repaired }, 'pages');
      recordInverse(ctx, 'update_device', `actualizar dispositivo ${id}`, {
        tool: 'update_device',
        arguments: { id, name: prev.name, kind: prev.kind, model: prev.model, cols: prev.cols, rows: prev.rows, hw_path: prev.hw_path },
      });
      return { device: deviceOut(db, id), repaired };
    }
    case 'delete_device': {
      const id = reqStr(args, 'id');
      if (isHardwareDeviceId(id)) throw new Error('El hardware no se puede eliminar');
      const existing = db.getDevice(id) as any;
      if (!existing) throw new Error('Dispositivo no encontrado');
      const snapshot = {
        device: { ...existing },
        assignments: db.getProfiles().map((p) => ({ profileId: p.id, pageId: db.getAssignments(p.id)[id] ?? null })),
      };
      db.deleteDevice(id);
      for (const p of db.getProfiles()) db.repairAssignments(p.id);
      ctx.ws?.broadcast('device.deleted', { deviceId: id }, 'pages');
      ctx.ws?.broadcast('assignment.updated', { deviceDeleted: id }, 'pages');
      recordInverse(ctx, 'delete_device', `eliminar dispositivo ${id}`, { tool: '__restore_device', arguments: snapshot });
      return { success: true, deviceId: id };
    }
    case 'get_assignments': {
      const profileId = reqStr(args, 'profile_id');
      const profile = db.getProfile(profileId);
      if (!profile) throw new Error('Perfil no encontrado');
      const pages = db.getPagesByProfile(profileId);
      const pageById = new Map(pages.map((p) => [p.id, p]));
      const devices = db.listDevices();
      const assignments = db.getAssignments(profileId);
      const compat = devices.map((d: any) => {
        const pageId = assignments[d.id] ?? null;
        if (!pageId) return { deviceId: d.id, deviceName: d.name, pageId: null, ok: true, why: 'sin asignar' };
        const page: any = pageById.get(pageId);
        if (!page) return { deviceId: d.id, deviceName: d.name, pageId, ok: false, why: 'página no existe' };
        const c = checkPageCompatibility(
          { id: page.id, profile_id: page.profile_id, name: page.name, is_folder: page.is_folder, parent_id: page.parent_id ?? null, grid_cols: page.grid_cols ?? null, grid_rows: page.grid_rows ?? null, data: page.data },
          { id: d.id, name: d.name, kind: d.kind, model: d.model, cols: d.cols, rows: d.rows },
          (profile as any).data,
        );
        return { deviceId: d.id, deviceName: d.name, pageId, pageName: page.name, ok: c.ok, why: c.why ?? null, short: c.short ?? null };
      });
      return { profileId, assignments, compat };
    }
    case 'set_assignments': {
      const profileId = reqStr(args, 'profile_id');
      const profile = db.getProfile(profileId);
      if (!profile) throw new Error('Perfil no encontrado');
      const wanted = args?.assignments;
      if (!wanted || typeof wanted !== 'object' || Array.isArray(wanted)) {
        throw new Error('assignments (objeto deviceId → pageId|null) requerido');
      }
      const devices = db.listDevices();
      const byId = new Map(devices.map((d) => [d.id, d]));
      const pages = db.getPagesByProfile(profileId);
      const pageById = new Map(pages.map((p) => [p.id, p]));
      const errors: Array<{ deviceId: string; pageId: string; reason: string }> = [];
      for (const [deviceId, pageId] of Object.entries(wanted)) {
        const device: any = byId.get(deviceId);
        if (!device) { errors.push({ deviceId, pageId: String(pageId), reason: 'dispositivo no existe' }); continue; }
        if (pageId === null) continue;
        const page: any = pageById.get(String(pageId));
        if (!page) { errors.push({ deviceId, pageId: String(pageId), reason: 'página no existe en este perfil' }); continue; }
        const c = checkPageCompatibility(
          { id: page.id, profile_id: page.profile_id, name: page.name, is_folder: page.is_folder, parent_id: page.parent_id ?? null, grid_cols: page.grid_cols ?? null, grid_rows: page.grid_rows ?? null, data: page.data },
          { id: device.id, name: device.name, kind: device.kind, model: device.model, cols: device.cols, rows: device.rows },
          (profile as any).data,
        );
        if (!c.ok) errors.push({ deviceId, pageId: page.id, reason: c.why ?? 'incompatible' });
      }
      if (errors.length > 0) {
        throw new Error(`Asignaciones incompatibles: ${errors.map((e) => `${e.deviceId}→${e.pageId} (${e.reason})`).join('; ')}`);
      }
      const prev = db.getAssignments(profileId);
      for (const [deviceId, pageId] of Object.entries(wanted)) {
        if (!byId.has(deviceId)) continue;
        if (pageId === null) db.clearAssignment(profileId, deviceId);
        else db.setAssignment(profileId, deviceId, String(pageId));
      }
      const fixed = db.repairAssignments(profileId);
      const assignments = db.getAssignments(profileId);
      ctx.ws?.broadcast('assignment.updated', { profileId, assignments }, 'pages');
      // La asignación manda también vía MCP: navegadores/móviles cuya vista
      // no coincide con la asignada abren su pantalla (sin current global).
      try {
        const nav = (ctx.ws as any)?.navigatePageTo;
        const viewOf = (ctx.ws as any)?.getSessionView;
        if (typeof nav === 'function') {
          for (const deviceId of Object.keys(wanted)) {
            if (!byId.has(deviceId)) continue;
            if ((byId.get(deviceId) as any)?.kind === 'deck') continue;
            const finalPage = assignments[deviceId];
            if (!finalPage) continue;
            let current: string | null = null;
            try {
              current = typeof viewOf === 'function' ? viewOf.call(ctx.ws, deviceId)?.pageId ?? null : prev[deviceId] ?? null;
            } catch { /* sin vista: se navega igual */ }
            if (current === finalPage) continue;
            nav.call(ctx.ws, {
              pageId: finalPage,
              originDeviceId: null,
              targets: { kind: 'devices', ids: [deviceId] },
              context: { via: 'device-assignment' },
              updateGlobal: false,
            });
          }
        }
      } catch { /* noop */ }
      recordInverse(ctx, 'set_assignments', `asignaciones del perfil ${profileId}`, { tool: '__restore_assignments', arguments: { profile_id: profileId, assignments: prev } });
      return { assignments, repaired: fixed };
    }
    case 'get_streamdeck_status': {
      try {
        const { streamDeckDriver } = await import('../hw-driver/streamdeck-driver');
        const { guessDeckModel } = await import('../devices');
        const grid = streamDeckDriver.getGridGeometry();
        return {
          isConnected: streamDeckDriver.isConnected(),
          connectedDevice: streamDeckDriver.getConnectedDevice?.() ?? null,
          keyCount: streamDeckDriver.getKeyCount?.() ?? null,
          grid: grid ?? null,
          modelGuess: guessDeckModel(grid),
        };
      } catch (e) {
        return { isConnected: false, grid: null, modelGuess: null, note: 'driver no disponible' };
      }
    }
    // ---- sesiones y navegación ----
    case 'list_sessions': {
      return { sessions: (ctx.ws as any)?.getSessions?.() ?? [] };
    }
    case 'get_session': {
      const deviceId = reqStr(args, 'device_id');
      const view = (ctx.ws as any)?.getSessionView?.(deviceId) ?? null;
      const persisted = db.getDeviceSession(deviceId);
      if (!view && !persisted) throw new Error('Sesión no encontrada');
      const sessions: any[] = (ctx.ws as any)?.getSessions?.() ?? [];
      return { deviceId, view, persisted: persisted ?? null, connected: sessions.some((s) => s.deviceId === deviceId) };
    }
    case 'set_session_view': {
      if (!ctx.ws) throw new Error('Sin WS: el daemon no expone sesiones en este contexto');
      const deviceId = reqStr(args, 'device_id');
      const view: any = {};
      if (args?.profile_id !== undefined) {
        if (args.profile_id !== null && !db.getProfile(args.profile_id)) throw new Error('Perfil no encontrado');
        view.profileId = args.profile_id;
      }
      if (args?.page_id !== undefined) {
        if (args.page_id !== null && !db.getPage(args.page_id)) throw new Error('Página no encontrada');
        view.pageId = args.page_id;
      }
      if (args?.startup_profile_id !== undefined) {
        if (args.startup_profile_id !== null && !db.getProfile(args.startup_profile_id)) throw new Error('Perfil no encontrado');
        view.startupProfileId = args.startup_profile_id;
      }
      if (args?.name !== undefined) view.name = args.name;
      if (args?.kind !== undefined) view.kind = args.kind;
      const res = (ctx.ws as any).setSessionView(deviceId, view);
      if (!res?.ok) throw new Error(res?.error ?? 'No se pudo fijar la vista');
      return { ok: true, deviceId, session: (ctx.ws as any)?.getSessionView?.(deviceId) ?? null };
    }
    case 'navigate': {
      if (!ctx.ws) throw new Error('Sin WS: el daemon no expone navegación en este contexto');
      const { page_id, profile_id, device_id, broadcast } = args ?? {};
      if ((page_id && profile_id) || (!page_id && !profile_id)) {
        throw new Error('Indica exactamente uno de page_id o profile_id');
      }
      if (!device_id && broadcast !== true) {
        throw new Error('Indica device_id o broadcast:true');
      }
      const targets = broadcast === true ? { kind: 'all' as const } : { kind: 'devices' as const, ids: [String(device_id)] };
      if (page_id) {
        const res = (ctx.ws as any).navigatePageTo({ pageId: String(page_id), originDeviceId: null, targets, context: { via: 'mcp' } });
        if (!res?.ok) throw new Error(res?.error ?? 'Navegación fallida');
        return res;
      }
      const res = (ctx.ws as any).navigateProfileTo({ profileId: String(profile_id), originDeviceId: null, targets, context: { via: 'mcp' } });
      if (!res?.ok) throw new Error(res?.error ?? 'Navegación fallida');
      return res;
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
    // ---- backups ----
    case 'export_backup': {
      const raw = args?.sections;
      const sections = Array.isArray(raw)
        ? [...new Set(raw.filter((s: unknown) => typeof s === 'string' && (BACKUP_SECTIONS as readonly string[]).includes(s)))]
        : undefined;
      return buildBackup(db, sections ? { sections } : undefined);
    }
    case 'export_profile_backup': {
      const b = buildProfileBackup(db, reqStr(args, 'profile_id'));
      if (!b) throw new Error('Perfil no encontrado');
      return b;
    }
    case 'validate_backup': {
      if (args?.backup === undefined || typeof args.backup !== 'object' || Array.isArray(args.backup)) {
        throw new Error('backup requerido (objeto)');
      }
      const v = validateBackup(args.backup);
      if (!v.valid) throw new Error(`Backup inválido: ${v.errors.join('; ')}`);
      return v;
    }
    case 'restore_backup': {
      // Destructivo y sin inversa fiable: exige confirm:true siempre
      // (también en merge) y está prohibido en batch (BATCH_DENY).
      if (args?.backup === undefined || typeof args.backup !== 'object' || Array.isArray(args.backup)) {
        throw new Error('backup requerido (objeto)');
      }
      if (args?.confirm !== true) {
        throw new Error('restore_backup es destructivo: confirma con { confirm: true }.');
      }
      const pre = validateBackup(args.backup);
      if (!pre.valid) throw new Error(`Backup inválido: ${pre.errors.join('; ')}`);
      const sections = Array.isArray(args?.sections)
        ? args.sections.filter((s: unknown) => typeof s === 'string')
        : undefined;
      const mode = args?.mode === 'clean' ? 'clean' : 'merge';
      return restoreBackup(db, args.backup, { sections, mode, onProgress: () => {} });
    }
    // ---- assets ----
    case 'list_assets':
      return { assets: db.listAssets() };
    case 'delete_asset': {
      // Destructivo y sin inversa: exige confirm:true y está prohibido en
      // batch (BATCH_DENY). Borrado mínimo directo equivalente a
      // handleKeyImageDelete (http/key-images.ts) pero sin HTTP: valida el
      // nombre con safeAssetName (un solo segmento, sin .. ni separadores)
      // y borra <assets>/<nombre>; los metadatos de la BD se limpian
      // best-effort por coincidencia de path.
      if (args?.confirm !== true) {
        throw new Error('delete_asset es destructivo: confirma con { confirm: true }.');
      }
      const raw = typeof args?.path === 'string' ? args.path : typeof args?.url === 'string' ? args.url : '';
      const name = safeAssetName(String(raw).split('?')[0].replace(/^\/assets\//, ''));
      if (!name) throw new Error('path o url requerido (nombre de asset válido)');
      try {
        const { unlink } = await import('node:fs/promises');
        const pathMod = await import('node:path');
        await unlink(pathMod.join(getAssetsDir(), name));
      } catch { /* ya no existe: igualmente ok */ }
      try {
        const found = db.listAssets().find((a) => a.path === name || a.path === `/assets/${name}` || a.path.endsWith(`/${name}`));
        if (found) db.deleteAsset(found.id);
      } catch { /* metadatos best-effort */ }
      return { ok: true, name };
    }
    // ---- sistema ----
    case 'get_version':
      return { version: getVersion(), channel: 'stable', buildDate: new Date().toISOString() };
    case 'get_system_metrics': {
      // Recolector nativo ligero sin PowerShell (igual que api/system.ts en
      // Unix): CPU por doble muestra de node:os + RAM. Temps/fans/GPU no
      // disponibles aquí → degradado honesto, NUNCA datos inventados.
      try {
        const os = await import('node:os');
        const totalGB = Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10;
        const freeGB = Math.round((os.freemem() / 1024 / 1024 / 1024) * 10) / 10;
        const usedGB = Math.round((totalGB - freeGB) * 10) / 10;
        const snap = () => os.cpus().map((c) => {
          const t = c.times;
          return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
        });
        const a = snap();
        await new Promise((r) => setTimeout(r, 200));
        const b = snap();
        let idle = 0;
        let total = 0;
        for (let i = 0; i < a.length; i++) {
          idle += b[i].idle - a[i].idle;
          total += b[i].total - a[i].total;
        }
        const cpuUsage = total > 0 ? Math.round(((1 - idle / total) * 100) * 10) / 10 : null;
        return {
          cpu: { usage: cpuUsage, temperature: null },
          ram: { total: totalGB, used: usedGB, usage: totalGB > 0 ? Math.round((usedGB / totalGB) * 1000) / 10 : null },
          gpu: { usage: null, temperature: null },
          fans: [],
          voltages: [],
          degraded: true,
          note: 'MCP ligero: solo CPU/RAM nativas; temps/fans/GPU no disponibles sin PowerShell/LHM',
          timestamp: new Date().toISOString(),
        };
      } catch (e) {
        return { degraded: true, note: `Métricas no disponibles: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    case 'get_network_ips': {
      const { networkInterfaces } = await import('node:os');
      const nets = networkInterfaces();
      const ips: string[] = [];
      for (const addrs of Object.values(nets)) {
        for (const a of addrs || []) {
          if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
        }
      }
      return { ips };
    }
    case 'list_jobs':
      return { jobs: getJobManager().list() };
    case 'cancel_job': {
      // Sin undo (opera sobre jobs externos en curso) y prohibido en batch.
      const jobId = reqStr(args, 'job_id');
      if (!getJobManager().cancel(jobId)) throw new Error('Job no encontrado o ya terminado');
      return { success: true, jobId };
    }
    case 'list_catalog': {
      // Solo lectura offline: getCatalog/searchCatalog trabajan sobre los
      // manifests nativos en memoria (sin red ni build).
      const { getCatalog, searchCatalog, isCompatible } = await import('../catalog');
      const appVersion = getVersion();
      const { entries } = getCatalog();
      const found = searchCatalog(entries, {
        q: typeof args?.q === 'string' ? args.q : undefined,
        category: typeof args?.category === 'string' ? args.category : undefined,
        compatible: typeof args?.compatible === 'boolean' ? args.compatible : undefined,
        appVersion,
      });
      return {
        version: appVersion,
        total: found.length,
        plugins: found.map((e: any) => ({
          id: e.id, name: e.name, version: e.version, description: e.description,
          category: e.category, compatible: isCompatible(e, appVersion),
        })),
      };
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
    // ---- variables tipadas (store nuevo) ----
    case 'render_variable': {
      const template = reqStr(args, 'template');
      return { result: getVariableStore().render(template, args?.scope, args?.scopeId) };
    }
    case 'get_scoped_variable': {
      const def = getVariableStore().require(reqStr(args, 'name'), args?.scope, args?.scopeId);
      return { variable: varToJSON(def) };
    }
    case 'set_scoped_variable': {
      const vname = reqStr(args, 'name');
      if (args?.value === undefined) throw new Error('value requerido');
      const store = getVariableStore();
      const addr = { scope: args?.scope, scopeId: args?.scopeId };
      let prev: any = null;
      let def: any;
      try {
        def = store.define({
          name: vname,
          type: args?.type,
          scope: args?.scope,
          scopeId: args?.scopeId,
          value: args.value,
          unavailable: args?.unavailable,
          bindings: args?.bindings ?? null,
        });
      } catch (e) {
        if (!/ya existe/.test(e instanceof Error ? e.message : String(e))) throw e;
        const cur = store.require(vname, args?.scope, args?.scopeId);
        // Clon profundo: el store puede devolver referencias vivas y mutarlas corrompe la inversa.
        prev = JSON.parse(JSON.stringify(cur));
        def = cur;
        if (args?.type !== undefined && args.type !== def.type) {
          def = await store.retype(vname, args.type, { ...addr, source: 'mcp' });
        }
        if (args?.bindings !== undefined) def = await store.setBindings(vname, args.bindings ?? null, addr);
        def = await store.set(vname, args.value, { ...addr, type: args?.type, source: 'mcp' });
        if (args?.unavailable !== undefined && !!args.unavailable !== def.unavailable) {
          def = await store.setUnavailable(vname, !!args.unavailable, addr);
        }
      }
      recordInverse(ctx, 'set_scoped_variable', `variable tipada ${vname}`, {
        tool: '__restore_scoped_variable',
        arguments: { name: vname, scope: def.scope, scopeId: def.scopeId, prev },
      });
      return { variable: varToJSON(def) };
    }
    case 'delete_scoped_variable': {
      const vname = reqStr(args, 'name');
      const store = getVariableStore();
      const cur = store.require(vname, args?.scope, args?.scopeId);
      // Clon profundo (ver set_scoped_variable): la inversa debe ver el snapshot previo.
      const prev = JSON.parse(JSON.stringify(cur));
      const okDeleted = await store.delete(vname, args?.scope, args?.scopeId);
      if (!okDeleted) throw new Error('Variable no encontrada');
      recordInverse(ctx, 'delete_scoped_variable', `eliminar variable tipada ${vname}`, {
        tool: '__restore_scoped_variable',
        arguments: { name: vname, scope: prev.scope, scopeId: prev.scopeId, prev },
      });
      return { success: true, name: vname };
    }
    case 'toggle_variable': {
      const vname = reqStr(args, 'name');
      const def = await getVariableStore().toggle(vname, { scope: args?.scope, scopeId: args?.scopeId, source: 'mcp' });
      recordInverse(ctx, 'toggle_variable', `alternar variable ${vname}`, {
        tool: 'toggle_variable', arguments: { name: vname, ...(args?.scope !== undefined ? { scope: args.scope } : {}), ...(args?.scopeId !== undefined ? { scopeId: args.scopeId } : {}) },
      });
      return { variable: varToJSON(def) };
    }
    // ---- flow scripts (motor) ----
    case 'list_flow_scripts': {
      if (typeof (actionRunner as any)?.listFlowScripts !== 'function') {
        throw new Error('Motor sin flow-scripts (método no disponible)');
      }
      return { scripts: (actionRunner as any).listFlowScripts() };
    }
    case 'get_flow_script': {
      const id = reqStr(args, 'id');
      const r = actionRunner as any;
      let s: any = null;
      try { s = r?.flowStore?.getScript?.(id) ?? null; } catch { s = null; }
      if (!s && typeof r?.listFlowScripts === 'function') {
        s = r.listFlowScripts().find((x: any) => x?.id === id) ?? null;
      }
      if (!s) throw new Error('Script no encontrado');
      return { script: s };
    }
    case 'save_flow_script': {
      const r = actionRunner as any;
      if (typeof r?.saveFlowScript !== 'function') {
        throw new Error('Motor sin flow-scripts (método no disponible)');
      }
      const id = typeof args?.id === 'string' && args.id ? args.id : undefined;
      let prev: any = null;
      if (id) {
        try { prev = r?.flowStore?.getScript?.(id) ?? null; } catch { prev = null; }
        if (!prev && typeof r?.listFlowScripts === 'function') {
          prev = r.listFlowScripts().find((x: any) => x?.id === id) ?? null;
        }
        // Clon profundo: el mock global de action-runner.test.ts devuelve
        // referencias vivas y mutarlas corrompe la inversa.
        prev = prev ? JSON.parse(JSON.stringify(prev)) : null;
      }
      const saved = r.saveFlowScript({ ...(args ?? {}), ...(id ? { id } : {}) });
      if (prev) {
        recordInverse(ctx, 'save_flow_script', `actualizar script ${saved.id}`, {
          tool: '__restore_flow_script', arguments: { id: saved.id, script: prev },
        });
      } else {
        recordInverse(ctx, 'save_flow_script', `crear script ${saved?.name ?? saved?.id}`, {
          tool: 'delete_flow_script', arguments: { id: saved.id },
        });
      }
      return { script: saved };
    }
    case 'delete_flow_script': {
      const id = reqStr(args, 'id');
      const r = actionRunner as any;
      if (typeof r?.deleteFlowScript !== 'function') {
        throw new Error('Motor sin flow-scripts (método no disponible)');
      }
      let prev: any = null;
      try { prev = r?.flowStore?.getScript?.(id) ?? null; } catch { prev = null; }
      if (!prev && typeof r?.listFlowScripts === 'function') {
        prev = r.listFlowScripts().find((x: any) => x?.id === id) ?? null;
      }
      if (!prev) throw new Error('Script no encontrado');
      prev = JSON.parse(JSON.stringify(prev));
      r.deleteFlowScript(id);
      recordInverse(ctx, 'delete_flow_script', `eliminar script ${id}`, {
        tool: '__restore_flow_script', arguments: { id, script: prev },
      });
      return { success: true, id };
    }
    // ---- ejecución/observabilidad del motor ----
    case 'execute_flow_nodes': {
      const nodes = args?.nodes;
      if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('nodes[] requerido (array no vacío de nodos)');
      const r = actionRunner as any;
      if (typeof r?.runFlowNodes !== 'function') {
        throw new Error('Motor sin ejecución de nodos (método no disponible)');
      }
      requireBatchConfirmIfSensitive(ctx, nodes, args, 'Los nodos');
      const context = { ...(args?.context ?? {}), timestamp: Date.now() };
      const timeout = typeof args?.timeout === 'number' ? args.timeout : undefined;
      return await r.runFlowNodes('flow', 'api', nodes, context, { timeout });
    }
    case 'cancel_flow': {
      const runId = reqStr(args, 'run_id');
      const r = actionRunner as any;
      if (typeof r?.cancelFlow !== 'function') {
        throw new Error('Motor sin cancelación (método no disponible)');
      }
      return { runId, cancelled: r.cancelFlow(runId) };
    }
    case 'get_flow_runs': {
      const limit = Math.min(Math.max(Number(args?.limit ?? 100), 1), 1000);
      const r = actionRunner as any;
      try {
        const runs = r?.flowStore?.listRuns?.(limit);
        if (Array.isArray(runs)) return { runs };
      } catch { /* sin historial: fallback a en curso */ }
      if (typeof r?.getFlowRunning === 'function') return { running: r.getFlowRunning() };
      throw new Error('Motor sin observabilidad de runs (método no disponible)');
    }
    case 'get_flow_stats': {
      const r = actionRunner as any;
      if (typeof r?.getFlowStats === 'function') return r.getFlowStats();
      if (typeof r?.getFlowRunning === 'function') return { running: r.getFlowRunning() };
      throw new Error('Motor sin estadísticas (método no disponible)');
    }
    // ---- automatizaciones (motor) ----
    case 'emit_automation_event': {
      const event = reqStr(args, 'event');
      const r = actionRunner as any;
      if (typeof r?.emitAutomationEvent !== 'function') {
        throw new Error('Motor sin eventos de automatización (método no disponible)');
      }
      r.emitAutomationEvent(event, args?.payload ?? {});
      return { success: true, event };
    }
    case 'resync_automations': {
      (actionRunner as any)?.resyncButtonAutomations?.();
      return { success: true };
    }
    // ---- flow-vars (motor) ----
    case 'list_flow_vars': {
      const r = actionRunner as any;
      if (typeof r?.listFlowVars !== 'function') {
        throw new Error('Motor sin flow-vars (método no disponible)');
      }
      return { variables: r.listFlowVars() };
    }
    case 'get_flow_var': {
      const vname = reqStr(args, 'name');
      const r = actionRunner as any;
      if (typeof r?.getFlowVar !== 'function') {
        throw new Error('Motor sin flow-vars (método no disponible)');
      }
      const v = r.getFlowVar(vname);
      if (!v) throw new Error('Variable no encontrada');
      return { variable: v };
    }
    case 'set_flow_var': {
      const vname = reqStr(args, 'name');
      if (args?.value === undefined) throw new Error('value requerido');
      const r = actionRunner as any;
      if (typeof r?.setFlowVar !== 'function' || typeof r?.getFlowVar !== 'function') {
        throw new Error('Motor sin flow-vars (método no disponible)');
      }
      let prev: any = null;
      try { prev = r.getFlowVar(vname) ?? null; } catch { prev = null; }
      prev = prev ? JSON.parse(JSON.stringify(prev)) : null;
      r.setFlowVar(vname, args.value);
      recordInverse(ctx, 'set_flow_var', `variable del motor ${vname}`, {
        tool: '__restore_flow_var', arguments: { name: vname, prev },
      });
      return { variable: r.getFlowVar(vname) ?? { name: vname, value: args.value } };
    }
    case 'delete_flow_var': {
      const vname = reqStr(args, 'name');
      const r = actionRunner as any;
      if (typeof r?.deleteFlowVar !== 'function' || typeof r?.getFlowVar !== 'function') {
        throw new Error('Motor sin flow-vars (método no disponible)');
      }
      let prev: any = null;
      try { prev = r.getFlowVar(vname) ?? null; } catch { prev = null; }
      if (!prev) throw new Error('Variable no encontrada');
      prev = JSON.parse(JSON.stringify(prev));
      r.deleteFlowVar(vname);
      recordInverse(ctx, 'delete_flow_var', `eliminar variable del motor ${vname}`, {
        tool: '__restore_flow_var', arguments: { name: vname, prev },
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
