# Servidor MCP de LibreDeck

Este daemon **ES un servidor MCP** (Streamable HTTP en modo JSON):
`POST /api/v1/mcp` acepta mensajes JSON-RPC 2.0 (o batch) y responde JSON.
Sin sesiones: cada request es independiente.

## Autenticación y permisos

`Authorization: Bearer <token>`. Los tokens se crean en la UI
(Ajustes → MCP) o vía API. Al crear/editar un token se marcan sus
permisos (scopes); vacío = acceso total (admin):

```
GET    /api/v1/mcp/scopes       # catálogo de permisos marcables
GET    /api/v1/mcp/tokens       # lista (sin secretos)
POST   /api/v1/mcp/tokens       # { name, scopes? } → { token, secret } (el secreto solo se muestra una vez)
PUT    /api/v1/mcp/tokens/:id   # { name?, scopes? } → edita el token
DELETE /api/v1/mcp/tokens/:id   # revoca
GET    /api/v1/mcp              # info sin auth (nombre, endpoint, cómo conectar)
```

Solo se guarda el SHA-256 del secreto (`settings.mcp.tokens`).
Las tools que no cubre el token no aparecen en `tools/list` y devuelven
`isError: permiso denegado` en `tools/call`.
Toda mutación queda auditada en `logs` (`mcp:<tool>`).

## Herramientas

| Grupo | Tools |
|---|---|
| Acciones | `list_actions`, `execute_action` |
| Estado | `get_state` (perfiles, actual, páginas con grid/modo, botones con geometría, plugins, dispositivos, asignaciones, sesiones) |
| Perfiles | `list_profiles`, `get_profile`, `create_profile` (gridCols/gridRows), `update_profile` (gridCols/gridRows), `delete_profile`, `set_current_profile`, `set_profile_grid` |
| Páginas | `list_pages`, `get_page`, `create_page` (grid_cols/grid_rows/parent_id/layout_mode), `update_page` (grid/grid/padre/modo), `delete_page`, `set_current_page`, `set_page_layout` (classic/gridstack), `set_page_grid` |
| Botones | `list_buttons`, `get_button`, `create_button` (x/y/w/h/widget_type), `update_button` (patch + mover + geometría), `set_button_geometry` (modo libre), `delete_button`, `move_button`, `reorder_buttons`, `duplicate_button` (conserva geometría), `press_button` (ejecuta sus acciones con pressType short/long/double/touch-start/touch-end) |
| Dispositivos | `list_devices`, `get_device` (+effectiveSize), `create_device`, `update_device`, `delete_device`, `get_assignments` (con compatibilidad), `set_assignments`, `get_streamdeck_status` |
| Sesiones | `list_sessions`, `get_session`, `set_session_view`, `navigate` (page_id o profile_id + device_id o broadcast) |
| Acciones del botón | `add_button_action`, `update_button_action`, `remove_button_action`, `reorder_button_actions` |
| Plugins | `get_plugin_template`, `validate_manifest`, `install_plugin` (+ legacy `install_plugin_from_git`), `list_plugins`, `get_plugin`, `enable_plugin`, `disable_plugin`, `reload_plugin`, `rollback_plugin`, `update_plugin`, `uninstall_plugin`, `get_plugin_settings`, `save_plugin_settings` |
| Ajustes/logs | `list_settings`, `get_setting`, `set_setting`, `get_logs` |
| Backups | `export_backup` (sections), `export_profile_backup`, `validate_backup`, `restore_backup` (confirm:true, sin undo, no batch) |
| Assets | `list_assets`, `delete_asset` (confirm:true, sin undo, no batch) |
| Sistema | `get_version`, `get_system_metrics` (ligero, degradado honesto), `get_network_ips`, `list_jobs`, `cancel_job` (sin undo, no batch), `list_catalog` (offline) |
| Variables | `list_variables`, `get_variable`, `set_variable`, `delete_variable` (tabla simple) + tipadas (store nuevo): `render_variable`, `get_scoped_variable`, `set_scoped_variable`, `delete_scoped_variable`, `toggle_variable` + motor: `list_flow_vars`, `get_flow_var`, `set_flow_var`, `delete_flow_var` |
| Flows/Automatizaciones | `list_flows`, `get_flow`, `create_flow`, `update_flow`, `delete_flow`, `execute_flow` + motor: `list_flow_scripts`, `get_flow_script`, `save_flow_script`, `delete_flow_script`, `execute_flow_nodes`, `cancel_flow`, `get_flow_runs`, `get_flow_stats` + `list_automations`, `get_automation`, `create_automation`, `update_automation`, `delete_automation`, `set_automation_enabled` + motor: `emit_automation_event`, `resync_automations` |

Tras cada mutación el daemon emite el broadcast WS correspondiente y
repinta el StreamDeck.
