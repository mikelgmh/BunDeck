/**
 * Catálogo de permisos (scopes) para los tokens del servidor MCP.
 *
 * Cada tool del MCP declara el scope que requiere (ver server.ts).
 * Al crear un token se puede marcar cualquier subconjunto; vacío u
 * omitido = acceso total (admin). Los tokens antiguos sin `scopes`
 * se tratan como admin por compatibilidad.
 */

export interface McpScopeDef {
  /** p.ej. "buttons.write" */
  id: string;
  /** grupo para la UI: profiles | pages | buttons | actions | plugins | system */
  group: string;
}

export const MCP_SCOPES: McpScopeDef[] = [
  { id: 'profiles.read', group: 'profiles' },
  { id: 'profiles.write', group: 'profiles' },
  { id: 'pages.read', group: 'pages' },
  { id: 'pages.write', group: 'pages' },
  { id: 'buttons.read', group: 'buttons' },
  { id: 'buttons.write', group: 'buttons' },
  { id: 'actions.read', group: 'actions' },
  { id: 'actions.execute', group: 'actions' },
  { id: 'plugins.read', group: 'plugins' },
  { id: 'plugins.manage', group: 'plugins' },
  { id: 'plugins.install', group: 'plugins' },
  { id: 'state.read', group: 'system' },
  { id: 'settings.read', group: 'system' },
  { id: 'settings.write', group: 'system' },
  { id: 'logs.read', group: 'system' },
  // Nuevas entidades controlables por MCP (grupos propios; los
  // anteriores se mantienen intactos para no romper tokens/roles).
  { id: 'widgets.read', group: 'widgets' },
  { id: 'widgets.write', group: 'widgets' },
  { id: 'flows.read', group: 'flows' },
  { id: 'flows.write', group: 'flows' },
  { id: 'automations.read', group: 'automations' },
  { id: 'automations.write', group: 'automations' },
  { id: 'variables.read', group: 'variables' },
  { id: 'variables.write', group: 'variables' },
  // Batch atómico + historial/undo propios (grupo system).
  { id: 'batch.write', group: 'system' },
  { id: 'history.read', group: 'system' },
  { id: 'history.write', group: 'system' },
  // Webhooks LAN, registros por pulsación y atajos globales.
  { id: 'webhooks.read', group: 'webhooks' },
  { id: 'webhooks.write', group: 'webhooks' },
  { id: 'presslogs.read', group: 'presslogs' },
  { id: 'presslogs.write', group: 'presslogs' },
  { id: 'shortcuts.read', group: 'shortcuts' },
  { id: 'shortcuts.write', group: 'shortcuts' },
  // Dispositivos lógicos, asignaciones y sesiones (grupos propios).
  { id: 'devices.read', group: 'devices' },
  { id: 'devices.write', group: 'devices' },
  { id: 'sessions.read', group: 'sessions' },
  { id: 'sessions.write', group: 'sessions' },
  // Backups, assets y sistema (grupos propios).
  { id: 'backups.read', group: 'backups' },
  { id: 'backups.write', group: 'backups' },
  { id: 'assets.read', group: 'assets' },
  { id: 'assets.write', group: 'assets' },
  { id: 'system.read', group: 'system' },
  { id: 'system.write', group: 'system' },
];

/** Todos los ids de scope (acceso total). */
export const ALL_SCOPE_IDS: string[] = MCP_SCOPES.map((s) => s.id);

const KNOWN = new Set(ALL_SCOPE_IDS);

/**
 * Normaliza los scopes pedidos al crear/editar un token.
 * undefined/null/[] = todos (admin). Lanza si hay ids desconocidos.
 */
export function normalizeScopes(input: unknown): string[] {
  if (input === undefined || input === null) return [...ALL_SCOPE_IDS];
  if (!Array.isArray(input)) throw new Error('scopes debe ser un array de strings');
  if (input.length === 0) return [...ALL_SCOPE_IDS];
  const out: string[] = [];
  for (const s of input) {
    if (typeof s !== 'string' || !KNOWN.has(s)) {
      throw new Error(`Scope desconocido: ${JSON.stringify(s)}. Válidos: ${ALL_SCOPE_IDS.join(', ')}`);
    }
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** ¿Concede este token el scope pedido? (tokens legacy sin scopes = admin) */
export function hasScope(
  auth: { scopes?: string[] | null } | null | undefined,
  scope: string
): boolean {
  if (!auth) return true; // llamadas internas / tests sin auth
  if (!auth.scopes || auth.scopes.length === 0) return true; // legacy = admin
  return auth.scopes.includes(scope);
}
