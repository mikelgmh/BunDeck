# Plugins LibreDeck (nativos + externos)

## Dos tipos

- **Nativos** (`daemon/src/plugins/*.plugin.ts`): TypeScript compilado con
  el daemon, acceso total al sistema. Se registran en `db.ts`
  (`installBuiltInPlugins`) y sus handlers viven en `action-runner.ts`.
  Para añadir uno: crea `*.plugin.ts`, expórtalo en `index.ts` e
  instáncialo en `ActionRunner.loadNativePlugins()`.

- **Externos** (`data/plugins/<id>/`): JS de terceros, un **Worker por
  plugin**. Manifiesto `manifest.json` + `main.js` (o `main.mjs`/`index.js`,
  o `main` en el manifest) que exporta `register(api)`.

## Plugin externo mínimo

Ver plantilla completa en `daemon/src/plugins/external-template/`.

`manifest.json`:

```json
{
  "id": "com.ejemplo.mi-plugin",
  "name": "Mi Plugin",
  "version": "1.0.0",
  "engine": "^1.0.0",
  "apiVersion": "2.1",
  "permissions": ["http"],
  "actions": [
    { "id": "saludo", "name": "Decir hola",
      "schema": { "type": "object", "properties": { "nombre": { "type": "string" } } } }
  ]
}
```

`main.js`:

```js
export function register(api) {
  api.onAction('saludo', async (params) => ({ message: `Hola, ${params.nombre ?? 'Mundo'}!` }));
}
```

API disponible en el Worker: `onAction`, `emitEvent`, `log`,
`getSetting/setSetting/deleteSetting` (async, namespaced),
`http.fetch` (permiso `http`/`network`, timeout 30s, máx 5MB),
`fs.readFile/writeFile/exists` (permiso `filesystem`, solo tu carpeta,
máx 2MB), más `api.version` y `api.pluginId`.

## Ciclo de vida (marketplace)

- **Instalación atómica**: el daemon extrae/clona a `.staging_*`,
  valida manifiesto + main + `engine`, calcula checksum y solo entonces
  intercambia con el directorio activo. Si la versión nueva no arranca,
  **revierte** a la anterior. Nunca hace `git pull` sobre el directorio
  activo.
- **Orígenes**: ZIP subido (UI), URL `.zip` (marketplace), repo git
  (marketplace con pull = `git clone` a staging) o carpeta local.
  Se guardan `source_type`, `origin`, `ref`, `commit`, `checksum`,
  `previous_version` para rollback.
- **Enabled gobierna**: `loadAllPlugins()` solo carga habilitados.
  El descubrimiento del filesystem registra deshabilitado por defecto
  (no auto-ejecuta). Activar/desactivar carga/descarga el Worker.
- **Diagnóstico**: `status` (`active`/`error`/`disabled`), `last_error`,
  `previous_version`. La UI muestra errores, permite recargar,
  actualizar y revertir.

Endpoints daemon:

```
GET    /api/v1/plugins               # installed + loaded + detailed
GET    /api/v1/plugins/actions       # acciones agrupadas (editores)
GET    /api/v1/plugins/:id           # detalle + estado
PUT    /api/v1/plugins/:id           # { enabled: bool }
DELETE /api/v1/plugins/:id           # desinstalar (no built-ins)
POST   /api/v1/plugins/:id/reload
POST   /api/v1/plugins/:id/rollback
POST   /api/v1/plugins/:id/update    # { url?, dir?, zipPath?, ref?, force? }
POST   /api/v1/plugins/install       # { sourceType: git|marketplace|url, url, ref?, checksum? }
POST   /api/v1/plugins/upload        # multipart file=.zip/.plectro
GET    /api/v1/marketplace           # proxy del registry configurado
```

Registry marketplace (JSON en `marketplace.registry_url`):

```json
{ "plugins": [
  { "id": "com.ejemplo.mi-plugin", "name": "Mi Plugin",
    "version": "1.0.0", "description": "...", "author": "...",
    "repository": "https://github.com/...", "zipUrl": "https://.../mi-plugin-1.0.0.zip" }
] }
```

## Seguridad

El Worker aísla **fallos** (crash/timeout con terminate + re-spawn) y
media permisos en el padre, pero **no es sandbox de seguridad**: un
plugin puede importar APIs del runtime. Los permisos (`shell`,
`system`, `filesystem` = privilegiados) son consentimiento y control
del API mediado, no contención OS. Instala solo plugins de autores
de confianza y revisa lo que piden.

## Importación Elgato (.sdPlugin) — fase 2 operativa

`daemon/src/elgato/`: detecta paquetes Elgato (repo git, `.streamDeckPlugin`
o carpeta), convierte el manifest, compila desde fuentes si el repo no trae
`bin/` (caso DeckCal: `bun install + bun run build`, con fallback a npm),
instala dependencias runtime y deja el plugin habilitado por defecto como
`elgato-stopped` con auto-arranque del runtime en segundo plano. `needs-runtime` queda solo para binarios nativos o CodePath ausente.
El host (`host.ts`: `Bun.serve` WS + `node <CodePath> -port -pluginUUID
-registerEvent -info`) traduce `willAppear/keyDown/keyUp/didReceiveSettings`
y `setTitle/setImage/setState/settings/openUrl/logMessage`. La instalación
normal (`POST /api/v1/plugins/install`) autodetecta Elgato y deriva al
importador; `POST /api/v1/plugins/import-elgato` permite dry-run.
Nuevos endpoints: `GET /api/v1/plugins/:id/elgato-state` y
`POST /api/v1/plugins/:id/key` (pulso sin hardware); WS emite `elgato.state`.

## Progreso en vivo

El loader emite `plugin.install-progress` por WS (topic `plugins`) con
`{ key, stage, message }`: `download` (con % y MB), `clone`, `extract`,
`detect`, `validate`, `activate`, `load`, `done`, `error`. La UI muestra
la caja de progreso y los errores sin que el usuario tenga que adivinar;
los métodos aceptan además `onProgress` para tests y otros consumidores.
