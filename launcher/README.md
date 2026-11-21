# BunDeck Launcher (Rust + GPUI)

Ventanita de estado al abrir la app: muestra API (`:3001`), WebSocket (`:3003`)
y Frontend (`:3002`, o `:4321` en dev) con el lenguaje visual de bundeck
(`web/src/styles/bundeck.css`, tema automático dark: fondo `#121315`,
acento amarillo `#e0a84a`, primario invertido claro, pestañas con subrayado).
La cabecera muestra el logo a todo color (`web/public/apple-touch-icon.png`
vía `img()` con ruta de disco; reserva: cuadrado ámbar si no se encuentra).

Es la puerta de entrada en todos los flujos: al pulsar **Abrir panel** abre el
navegador y **se auto-cierra** (solo si API y frontend están en línea; si no,
se queda abierta con el motivo en el registro).

La ventana no usa el marco nativo de Windows: la barra de título es propia
(40 px, estilo `TitleBar` de bundeck: logo, arrastre para mover, doble clic
para maximizar, botones de minimizar / maximizar-restaurar / cerrar).

El icono de bandeja (system tray, solo Windows, ver `src/tray.rs`) es
propiedad del launcher, no del host Electrobun: al hacer clic se abre esta
ventana (o se trae al frente si ya existe). Cerrar la ventana con la X NO
cierra la app: la ventana se oculta y una ventana ancla invisible mantiene
vivo el proceso para que el tray siga respondiendo (minimizar al tray).
El menú del tray ofrece Abrir panel (esta ventana GPUI), Abrir en la web
(navegador), Abrir en Electrobun (ventana nativa del host, con fallback al
navegador si no hay host) y Salir (cierra el launcher; el daemon sigue en
marcha y se detiene con Detener). "Abrir en la web" auto-cierra la ventana
igual que el botón.
El icono de la ventana (barra de tareas / Alt-Tab) va incrustado en el exe
(`build.rs` + `app.rc` → `icon.ico` de la raíz) y se asigna además por HWND
(`WM_SETICON`), porque el marco es propio (`appears_transparent`).

## Panel de control (estilo XAMPP)

Dos pestañas:

- **Estado**: servicios API (`:3001`), WebSocket (`:3003`) y Frontend (`:3002`,
  o `:4321` en dev) con sondeo cada 2 s; Iniciar (reintenta hasta que la API
  sube), Detener (`POST /api/v1/admin/shutdown`) y Reiniciar del daemon;
  versión instalada (`GET /api/v1/version`) vs última (manifiesto
  versionado `bundeck-update-manifest.json`, botón Buscar); si hay más nueva,
  **Descargar** baja el bundle con barra de progreso y verificación
  (sha256 + firma ed25519), y **Aplicar ahora** lo activa con backup de la
  DB, health-check y rollback; si el launcher también cambia, el ayudante
  `libredeck-updater` lo reemplaza al salir; Abrir panel web (auto-cierra si
  todo está en línea) y ventana Electrobun (handoff con cierre, solo dev); Salir.
- **Registro**: historial amplio (200 líneas, muestra las 30 últimas) con
  Limpiar. Los sondeos ya no ensucian la vista de Estado.

Todo lo clicable tiene hover (borde apagado en fantasmas, gris claro en el
primario); los botones contextuales se atenúan (Iniciar con API en línea,
Detener con API caída; Detener en rojo bundeck).

## Actualización gestionada (este launcher es el dueño)

El updater canónico es el launcher (`src/updater.rs` + `src/updater_bin.rs`),
no Electrobun (dev-only). Layout: `versions/<ver>/` (daemon, CLI, launcher,
updater, `web-dist/`) + `active.json`; backups de DB en `backups/`.
Cada release publica `bundeck-v<ver>-<target>.zip` y
`bundeck-update-manifest.json` (sha256 + firma ed25519; ver
`scripts/build-update-manifest.mjs` y `scripts/gen-update-keys.mjs`).
Instalaciones planas legacy se migran solas al primer update.

## Host Electrobun: API de control (solo dev)

`src/bun/launcher-server.ts` sirve solo en `127.0.0.1:3031`
(`HOST_PORT` para cambiarlo):

- `POST /__launcher/open-window` → abre la BrowserWindow del dashboard
- `GET  /__launcher/update-check` → `{ updateAvailable, version? }` (legacy)
- `POST /__launcher/update-apply` → `{ ok }` (legacy)

## Flujos que la muestran

| Flujo | Cómo salta |
|---|---|
| Instalado (Menú inicio / escritorio) | El acceso directo apunta a `libredeck-launcher.exe` (installer.iss) |
| `./dev.sh dev` | Lanza `launcher/target/{release,debug}` si existe (salta navegador auto) |
| `bun run dev` | `dev:launcher:open` → `scripts/open-launcher.ts` (respeta `CI` y `NO_LAUNCHER=1`) |
| `electrobun dev` / app Electrobun | El host (`src/bun/index.ts`) la spawnea y omite su BrowserWindow |

Si el binario no existe, cada flujo cae a su comportamiento anterior
(navegador / ventana Electrobun) sin romperse.

## Requisitos

- Rust estable (https://rustup.rs) + toolchain MSVC y Windows SDK en Windows.
- En dev: `bun` en PATH (el launcher spawnea `bun run daemon/src/server.ts`
  si la API no responde, espejo de `spawnDaemon()` en `src/bun/index.ts`).
- Instalado: `libredeck-daemon(.exe)` en `versions/<activa>/` (gestionado)
  o junto al launcher (legacy plano, se migra solo al primer update).
- Actualizaciones: el launcher descarga el bundle del manifiesto con
  progreso, verifica sha256+firma, hace stage en `versions/<ver>/` y aplica
  con backup + rollback. Sin internet, Buscar informa y sugiere descarga manual.

## Uso

```bash
cd launcher
cargo run --bin libredeck-launcher
cargo test   # updater: versiones, manifiesto, layout
```

Variables respetadas: `PORT` (API, defecto 3001), `WS_PORT` (defecto 3003),
`FRONTEND_PORT` (defecto 3002), `DEV_MODE=true` (prueba `:4321` primero),
`BUN_PATH` (bun alternativo).

## Notas de diseño

- `src/theme.rs` es un espejo **manual** de los tokens `--ld-*` de
  `web/src/styles/global.css`. Si cambias el front, actualízalo a mano.
- `src/monitor.rs` no habla con Electrobun: sondea HTTP/TCP en localhost,
  así funciona con daemon standalone, `dev.sh` o Electrobun.
- La ventana es solo estado + accesos (Abrir panel / Reintentar / Salir).
  No reemplaza `src/bun/index.ts` (tray, menú, updater) en esta fase.

## Build release

```bash
cd launcher
cargo build --release
# -> target/release/libredeck-launcher(.exe)
```
