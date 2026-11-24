# Plugins BunDeck (nativos + externos)

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

## Importación Elgato (.sdPlugin) — shim en-Worker (sin procesos extra)

`daemon/src/elgato/`: detecta paquetes Elgato (repo git, `.streamDeckPlugin`
o carpeta), convierte el manifest, compila desde fuentes si el repo no trae
`bin/` (DeckCal vía rollup, SEMS vía `rollup -c`, AUS-UV vía esbuild:
`bun install + bun run build` con fallback a `scripts.bundle` y reintento con
npm), instala solo dependencias JS puras (las nativas dejan el plugin en
`needs-manual` con motivo) y genera el bridge del shim (`shim-bridge.js` +
falso `@elgato/streamdeck` en `node_modules/`). El plugin corre en el
`ExternalPluginWorker` actual: cero procesos `node`, cero `Bun.serve` por
plugin, arranque perezoso (el Worker se crea en la primera pulsación) y
parada tras 60s sin uso. `needs-manual` (apagado) queda para binarios
nativos, dial-only o CodePath ausente. El contexto es único por botón
(`ld:<plugin>:<acción>:<buttonId>`); el hold largo de LibreDeck es el delay
real entre `keyDown` y `keyUp`. `switchToProfile`/`sendToPropertyInspector`
son emulados y avisados (log + evento). Dos estilos de CodePath
(`detectElgatoCodeStyle`): `sdk` (importa `@elgato/streamdeck`, bridge
clásico) y `raw` (protocolo WebSocket en crudo sin SDK, como AUS-UV: bridge
con transporte virtual en memoria, `WebSocket` global + `process.argv`
virtuales y copia generada `shim-raw-entry.js` con `ws` reescrito, sin tocar
las fuentes; si el CodePath es un bundle opaco se prefiere la fuente raw del
paquete). El estilo queda en `x-elgato.codeStyle`/`bridgeEntry`. La instalación
normal (`POST /api/v1/plugins/install`) autodetecta Elgato y deriva al
importador; `POST /api/v1/plugins/import-elgato` permite dry-run.
Nuevos endpoints: `GET /api/v1/plugins/:id/elgato-state` y
`POST /api/v1/plugins/:id/key` (pulso sin hardware, con `pressType`/`holdMs`);
WS emite `elgato.state`. El runtime por proceso (`host.ts`/`runtime.ts`)
queda deprecated (solo con `LIBREDECK_ELGATO_SHIM=0`).

## Progreso en vivo

El loader emite `plugin.install-progress` por WS (topic `plugins`) con
`{ key, stage, message }`: `download` (con % y MB), `clone`, `extract`,
`detect`, `validate`, `activate`, `load`, `done`, `error`. La UI muestra
la caja de progreso y los errores sin que el usuario tenga que adivinar;
los métodos aceptan además `onProgress` para tests y otros consumidores.
