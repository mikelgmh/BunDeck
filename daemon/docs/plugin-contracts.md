# Contrato público de plugins — LibreDeck v2.2

Evolución del sistema de plugins hacia contratos públicos **sin romper los
actuales**: todo lo nuevo es opcional y validado de forma permisiva
(errores solo si está mal formado, warnings si pide más de lo disponible).

Referencia de código: `daemon/src/plugin-system/` (`types.ts`,
`validator.ts`, `permissions.ts`, `sandbox.ts`, `protocol.ts`,
`plugin-worker.ts`, `worker-host.ts`), helpers nativos en
`daemon/src/plugins/contract.ts`.

## 1. Manifest versionado (`apiVersion` + `engine`)

```json
{
  "id": "mi-plugin",
  "version": "1.0.0",
  "apiVersion": "2.2",
  "engine": "^1.5.0",
  "category": "integrations",
  "os": ["win32", "linux", "darwin"],
  "permissions": ["network"],
  "actions": []
}
```

- `apiVersion`: versión del Plugin API usada. Si el major pedido es mayor
  que el del daemon, el validator emite un **warning** (no error).
- `engine`: rango semver de LibreDeck (`^`, `~`, `>=`, `*`). La instalación
  lo comprueba; con `force` solo avisa.
- `category`: `system | integrations | media | input | utility`
  (desconocida → warning, el catálogo infiere por permisos).
- `os`: plataformas estilo `process.platform`. Informativo para el catálogo.
- Los nativos declaran el contrato vía `withContract()` en
  `daemon/src/plugins/contract.ts` (`apiVersion: 2.2`, `engine: ^1.5.0`).

## 2. Permisos validados

`permissions` se valida contra la lista conocida (ver `validator.ts`;
incluye legados `keyboard`, `multimedia`, `process`… para no romper).
En ejecución el **padre** los aplica (`sandbox.ts` + `permissions.ts`):

- `http`/`network`: fetch saliente. Sin ellos, `api.http.fetch` es denegado.
- `system` (además): permite `localhost` (evita SSRF al daemon) y shell.
- `filesystem`: solo `data/plugins/<id>/` (sin path traversal).
- Metadatos cloud (`169.254.169.254`) bloqueados siempre.
- `shell`: lista de patrones denegados (documentada en `permissions.ts`).
  No es sandbox a nivel OS: el aislamiento real es el Worker + timeout con
  `terminate()` + I/O mediada por el padre.

## 3. Opciones dinámicas (`optionsFrom`)

Un campo `select` se rellena ejecutando otra acción **del mismo plugin**
(sin red directa desde la UI):

```json
{ "id": "scene", "optionsFrom": { "field": "scene", "sourceAction": "scene-list", "cacheMs": 30000 } }
```

`sourceAction` debe devolver `{ options: [{ value, label }] }`
(ver `normalizeOptionsResult`). Ejemplo real: `obs.scene` ← `obs.scene-list`
/ `obs.status`.

## 4. Config flows seguros (`settingsSchema` + `PluginSettingsDialog`)

- Los secretos se detectan por nombre (`token`, `apiKey`, `password`…),
  `format: "password"`, `ui.type: "password"` o `secret: true`
  (`secretFieldsOf` en `types.ts`).
- `PluginLoader.getPluginSettingsBundle()` devuelve `secretFields` para que
  la UI pinte inputs password (los valores nunca van a logs: usar
  `redactSettings()` en diagnósticos).
- Tokens con caducidad (Spotify) guardan `tokenExpiresAt`; las acciones
  chequean expiración y piden refresco silencioso en vez de fallar en seco.

## 5. Estados de botón e iconos dinámicos

```json
{ "id": "stream", "states": [
  { "value": "live", "label": "En directo", "icon": "Radio" },
  { "value": "offline", "label": "Fuera de línea", "icon": "RadioTower" }
]}
```

La acción devuelve `state` (o `discreteState` si `state` ya tiene otro uso,
como en Home Assistant) y la UI mapea a label/icono. Acciones dinámicas
marcan `dynamic: true` + `pollMs` sugerido. Ejemplos: `obs.status`,
`spotify.now-playing`, `homeassistant.get-state`, `twitch.viewer-count`,
`youtube.viewer-count`, `weather.now`, `email.unread`, `pc-vitals.summary`.

Plugins externos: `api.setButtonState(buttonId, { state, label?, icon?, value? })`
→ evento `button.state` (validado, máx. 8KB).

## 6. Widgets básicos personalizados

```json
{ "widgets": [{ "id": "viewers", "kind": "text", "sourceAction": "viewer-count", "refreshMs": 60000 }] }
```

Kinds: `text | progress | list | gauge | toggle`. La acción devuelve
`result.widget`. El daemon **no ejecuta JS de terceros para renderizar**:
solo transporta datos. Plugins externos: `api.setWidget(id, data)` →
evento `widget.update` (máx. 32KB).

## 7. Sandbox / Worker (sin `eval` en el daemon)

- Un `Worker` por plugin externo (`plugin-worker.ts`); el `main.js` se
  importa **dentro** del worker, nunca en el daemon.
- El worker solo **pide** operaciones (`get-setting`, `set-setting`,
  `get-settings`, `log`, `emit-event`, `button-state`, `widget-update`,
  `http-fetch`, `fs-read/write/exists`); el padre las ejecuta con permisos.
- Timeouts reales: vencido el plazo se hace `terminate()` + re-spawn en
  background; crash del plugin nunca tumba el daemon (queda en error/log).
- `getSetting/setSetting` son **async** en el worker (la DB vive en el padre).
- En el daemon no hay `eval`/`new Function` sobre código de plugins.

## 8. Catálogo local e instalación versionada

`daemon/src/catalog.ts` (offline-first, en memoria):

- Índice desde `getNativeManifests()` + `validateManifest()`: incluye
  `apiVersion`, `engine`, `widgets`, checksum sha256 e integridad.
- Búsqueda `?q=` / `?category=` / `?compatible=` puras y testeadas.
- Instalación versionada git: si `ref` es un rango (`^1.0.0`, `>=2.0.0`,
  `*`, `latest`), se clona completo, se elige el mejor tag con
  `pickBestTag(tags, rango)` y se hace `checkout`. Sin tags compatibles se
  usa HEAD avisando por progreso WS.
- `zip` verifica checksum opcional; `directory` copia a staging; toda
  activación es atómica con backup + rollback si el arranque falla.
- El loader invalida el catálogo tras instalar/desinstalar.

## 9. Tests

`cd daemon && bun test`:

- `plugin-contracts.test.ts`: secretos, validator, permisos, `pickBestTag`,
  weather/email puros, `today-count`, `summary`, viewer states.
- Un test por plugin (`*.plugin.test.ts`), loader (`plugin-loader.test.ts`,
  `plugin-install.test.ts`, `plugin-lifecycle.test.ts`), worker con timeouts
  reales (`plugin-worker.test.ts`), catálogo (`catalog*.test.ts`).
