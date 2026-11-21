# Plantilla de plugin externo

Copia esta carpeta a `data/plugins/com.ejemplo.mi-plugin/` o instálala
desde un ZIP / repo git, y el daemon la cargará como plugin externo.

## Estructura mínima

```
mi-plugin/
  manifest.json  # identidad, versión, permisos, acciones (validado)
  main.js        # exporta register(api)
```

## Manifest

Ver `manifest.json`. Campos clave:

- `id`: `nombre` o `@scope/nombre`. Debe coincidir con la carpeta
  (`@` y `/` se normalizan a `__` en disco).
- `version`: semver (`1.0.0`).
- `engine`: rango de LibreDeck requerido (ej. `^1.0.0`).
- `apiVersion`: `2.1` (la que ofrece este daemon).
- `main`: punto de entrada (por defecto `main.js`).
- `permissions`: solo lo que necesites (`http`, `filesystem`, ...).
  `shell`/`system`/`filesystem` son privilegiados: la UI los marca
  y solo deberías pedirlos si confías en el autor.
- `actions[]`: cada acción declara `id`, `name` y `schema` (JSON Schema).
  Solo se exponen acciones declaradas aquí.

## API del plugin (`register(api)`)

- `api.onAction(id, handler)` — registra handler `(params, context)`.
- `api.emitEvent(nombre, payload)` — evento WS (`plugin.event`).
- `api.log(nivel, mensaje, meta?)` — log en DB.
- `api.getSetting / setSetting / deleteSetting(key)` — storage namespaced.
- `api.http.fetch(url, init?)` — requiere permiso `http`/`network`.
  Timeout 30s, máx. 5MB.
- `api.fs.readFile/writeFile/exists(ruta)` — restringido a tu carpeta,
  requiere permiso `filesystem`, máx. 2MB por escritura.
- `api.version` / `api.pluginId` — versión del API y tu id.

## Instalación y actualizaciones (marketplace)

- No hagas `git pull` sobre `data/plugins/<id>/` en producción.
  El daemon clona a staging, valida y activa de forma atómica:
  si la versión nueva no arranca, revierte a la anterior.
- Desde la UI: marketplace → Instalar (ZIP o repo git), y después
  Actualizar / Revertir si algo falla.
- El estado `enabled` gobierna: un plugin deshabilitado no se carga
  aunque sus archivos sigan en disco.

## Seguridad

Un plugin instalado corre con tus permisos de usuario. El Worker
aísla fallos y permite timeouts, pero **no es sandbox de seguridad**:
instala solo plugins de autores en los que confíes y revisa los
permisos que pide.
