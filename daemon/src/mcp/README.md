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
| Estado | `get_state` (perfiles, actual, páginas, botones, plugins) |
| Perfiles | `list_profiles`, `get_profile`, `create_profile`, `update_profile`, `delete_profile`, `set_current_profile` |
| Páginas | `list_pages`, `get_page`, `create_page`, `update_page`, `delete_page`, `set_current_page` |
| Botones | `list_buttons`, `get_button`, `create_button`, `update_button` (patch de label/icon/textos/colores + mover), `delete_button`, `move_button`, `reorder_buttons`, `duplicate_button`, `press_button` (ejecuta sus acciones) |
| Acciones del botón | `add_button_action`, `update_button_action`, `remove_button_action`, `reorder_button_actions` |
| Plugins | `get_plugin_template`, `validate_manifest`, `install_plugin` (+ legacy `install_plugin_from_git`), `list_plugins`, `get_plugin`, `enable_plugin`, `disable_plugin`, `reload_plugin`, `rollback_plugin`, `update_plugin`, `uninstall_plugin`, `get_plugin_settings`, `save_plugin_settings` |
| Ajustes/logs | `list_settings`, `get_setting`, `set_setting`, `get_logs` |

Tras cada mutación el daemon emite el broadcast WS correspondiente y
repinta el StreamDeck.
