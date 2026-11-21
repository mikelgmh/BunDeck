# BunDeck — Alternativa abierta a Stream Deck

[![Build](https://github.com/mikelgmh/libredeck/workflows/Release/badge.svg)](https://github.com/mikelgmh/libredeck/actions)
[![Release](https://img.shields.io/github/v/release/mikelgmh/libredeck)](https://github.com/mikelgmh/libredeck/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Automatiza tu PC con botones físicos o virtuales: abre apps, lanza scripts, controla OBS, Spotify, Home Assistant, multimedia y más. **Sin nube, sin cuenta, en local.**

- 🖥️ **Para usuarios:** instala, abre la ventanita de estado, pulsa “Abrir panel” y listo.
- 🧩 **Para desarrolladores:** daemon Bun + panel Astro/Vue + CLI + launcher nativo Rust. Todo documentado abajo.

> Versión actual: **1.5.0** (fuente única: `package.json` raíz).

---

## Índice

1. [En 60 segundos](#en-60-segundos)
2. [Arquitectura: por qué cada pieza](#arquitectura-por-qué-cada-pieza)
3. [Consumo real medido + comparativa](#consumo-real-medido--comparativa)
4. [Instalación](#instalación)
5. [Uso diario](#uso-diario)
6. [Puertos, bind y datos](#puertos-bind-y-datos)
7. [CLI `libredeck-cli`](#cli-libredeck-cli)
8. [API y WebSocket](#api-y-websocket)
9. [Plugins](#plugins)
10. [Desarrollo](#desarrollo)
11. [Build y release](#build-y-release)
12. [Variables de entorno](#variables-de-entorno)
13. [Solución de problemas](#solución-de-problemas)
14. [FAQ: por qué no Electron](#faq-por-qué-no-electron)

---

## En 60 segundos

```bash
# 1) Descarga el instalador de Releases e instala
# 2) Abre BunDeck (ventanita de estado) → “Abrir panel”
# 3) Crea un botón y asígnale una acción. Ya está.
```

El panel es una web local (`http://localhost:3002` en prod, `:4321` en dev). Puedes abrirlo también desde el móvil en la misma Wi-Fi con la IP LAN que muestra la ventana de estado.

---

## Arquitectura: por qué cada pieza

```
┌─────────────────┐      HTTP :3001 / WS :3003      ┌──────────────────┐
│  Panel web       │ ◄────────────────────────────► │  Daemon (Bun)     │
│  Astro + Vue     │   API + eventos en vivo        │  SQLite + plugins │
│  (tu navegador)  │                                │  + Stream Deck HW │
└─────────────────┘                                └────────▲──────────┘
                                                           │ spawn / shutdown
                                                  ┌────────┴──────────┐
                                                  │ Launcher Rust/GPUI │
                                                  │ ventana + tray     │
                                                  │ dueño ciclo de vida│
                                                  └───────────────────┘
```

| Pieza | Qué es | Por qué existe así |
|---|---|---|
| **Daemon** (`daemon/`, Bun + SQLite) | Dueño de datos, acciones, plugins, hardware y API/WS. | Un solo proceso de verdad: si cierras la ventana, la automatización sigue. Bun arranca rápido, consume poco y compila a un `.exe` único con `bun build --compile`. |
| **Panel web** (`web/`, Astro + Vue) | Solo UI de control. | Va en tu navegador: cero coste de un Chromium embebido. Astro genera una web estática diminuta (~1,3 MB). Vue solo donde hay interactividad. |
| **Launcher** (`launcher/`, Rust + GPUI) | Ventanita de estado + bandeja. Inicia, vigila y apaga el daemon. | Estilo XAMPP: panel nativo mínimo siempre visible sin cargar una vista web. En prod es el **único dueño** del ciclo de vida —no hay doble spawn ni doble icono—. |
| **CLI** (`cli/`, Bun) | Cliente de la API + gestor del proceso. | Para automatizar y administrar sin GUI: `start/stop/status/plugin/logs`. No duplica lógica: todo pasa por la misma API que el panel. |
| **Electrobun** (`src/bun/`, dev-only) | Host de ventana nativa con WebView del sistema. | Útil en desarrollo/experimentos. Fuera del release canónico: en prod no aporta nada que justifique otro proceso residente. |

Decisiones que evitamos a propósito:

- **Sin doble supervisor:** o arranca el launcher, o arrancas tú el daemon. Nunca los dos a la vez (`LIBREDECK_MANAGED`, health-check previo).
- **Sin doble bandeja:** el daemon desactiva la suya cuando lo lanza el launcher (`LIBREDECK_NO_TRAY=1`).
- **Un solo apagado:** `POST /api/v1/admin/shutdown` → `lifecycle.ts` → para API, frontend, WS y tray en orden. CLI, launcher y host piden lo mismo.
- **Contrato único:** la API vive bajo `/api/v1`. El CLI y el panel usan los mismos endpoints.

---

## Consumo real medido + comparativa

Medido en este repo, Windows 10 Pro 64-bit, en reposo, con `Get-Process` (WorkingSet):

| Componente | RAM en reposo | Tamaño en disco | Notas |
|---|---|---|---|
| Daemon `bun run daemon/src/server.ts` | **~55 MB** | — | Dev, con SQLite + plugins nativos cargados |
| Daemon compilado `libredeck-daemon.exe` | **~46 MB** | **~138 MB** | Incluye runtime Bun + SQLite + nativos; menos RAM que en dev |
| Launcher `libredeck-launcher.exe` (release) | **~54 MB** con ventana | **~6,5 MB** | GPUI nativo, sondeo cada 2 s |
| CLI compilado | efímero (solo mientras corre) | **~110 MB** | No es residente |
| Panel `web/dist` | 0 (vive en tu navegador) | **~1,3 MB**, 10 ficheros | Astro estático |

**Total prod en reposo: ~100 MB** (daemon 46 + launcher 54). El panel no suma proceso propio.

### Frente a una app Electron equivalente

|  | BunDeck | Electron típico |
|---|---|---|
| Motor UI | Tu navegador o WebView del sistema (compartido) | Chromium **embebido por app** + Node propio |
| Procesos en reposo | 2 (daemon + launcher) | 4–7 (main + renderer por ventana + GPU + helpers) |
| RAM idle orientativa | **~100 MB** medidos | **~250–500 MB** en apps con ventana + backend |
| Binario | Daemon 138 MB + launcher 6,5 MB + web 1,3 MB | App Electron 80–150 MB + datos Chromium |
| Arranque | Bun ~ms, Rust nativo | Arranque frío de Chromium |

Por qué Electron gasta más: cada app lleva su propio Chromium aunque ya tengas Chrome/Edge instalado, y cada ventana es un renderer completo con su heap JS, su compositor y a menudo su proceso GPU. Para un panel que el 90 % del tiempo está cerrado y un backend que debe vivir siempre, pagar un Chromium residente no compensa. BunDeck separa ambas cosas: backend siempre vivo y barato (Bun), UI bajo demanda (navegador) y control mínimo nativo (Rust).

> Nota honesta: las cifras Electron son rangos típicos del ecosistema, no una medición de un clon nuestro. Las de BunDeck sí son mediciones de este repo (ver tabla). Si repites la medición, usa `Get-Process` tras 1 min en reposo y con el mismo `LIBREDECK_DATA_DIR`.

¿Y Electrobun? Usa la WebView del sistema (WebView2 en Windows), mucho más ligera que Chromium embebido. Aun así, en prod sería un tercer proceso residente solo para envolver el panel. Como el panel ya abre perfecto en el navegador y el launcher cubre estado/tray/updates, Electrobun queda como **dev-only**. Menos procesos = menos RAM y menos cosas que pueden fallar.

---

## Instalación

### Windows (recomendado)

1. Descarga `BunDeck-Setup-vX.Y.Z.exe` de [Releases](https://github.com/mikelgmh/libredeck/releases).
2. Instala (instala daemon + CLI + launcher + panel).
3. Abre **BunDeck** → **Abrir panel**.

### Desde fuentes

```bash
git clone https://github.com/mikelgmh/libredeck.git
cd libredeck
bun run install:all   # daemon+cli con bun, web con npm (a propósito)
bun run dev           # daemon + panel Astro + launcher
```

---

## Uso diario

- **Abrir panel:** botón en la ventanita o `http://localhost:3002` (prod) / `http://localhost:4321` (dev).
- **Móvil en LAN:** usa la IP que muestra el launcher, p. ej. `http://192.168.1.20:3002`.
- **Apagar:** “Salir” en la ventanita o tray. Cierra daemon + ventana en orden.
- **Stream Deck físico:** conéctalo y el daemon lo detecta solo (el fallo de init no tumba el daemon).

---

## Puertos, bind y datos

| Servicio | Defecto | Override |
|---|---|---|
| API | `3001` | `PORT` o `--port=` |
| WebSocket | `3003` | `WS_PORT` |
| Frontend embebido | `3002` | `FRONTEND_PORT` o `--web-port=` |
| Astro dev | `4321` | `astro.config.mjs` |
| Launcher API (solo 127.0.0.1) | `3031` | `HOST_PORT` |

Seguridad por defecto:

- El daemon escucha en **`127.0.0.1`**. Para LAN (móvil/QR): `LIBREDECK_BIND_LAN=1` o `LIBREDECK_BIND=0.0.0.0`. `dev.sh`, el launcher y el host dev ya lo ponen cuando toca.
- CORS no usa `*` con credenciales: refleja el `Origin` solo si es local (`localhost`, `127.0.0.1`, `::1`, `10/8`, `172.16/12`, `192.168/16`).
- `POST /api/v1/admin/shutdown` es local por diseño; no lo expongas a WAN.

Datos (`daemon/src/config.ts:resolveDataDir`):

```
LIBREDECK_DATA_DIR > ELECTROBUN_DATA_DIR/libredeck > %APPDATA%/LibreDeck/data (instalado) > <repo>/data (dev)
```

Ahí viven `db.sqlite`, `assets/`, `plugins/` y `logs/`. `data/` es estado local: no se commitea.

---

## CLI `libredeck-cli`

```bash
libredeck-cli start --detach        # arranca en segundo plano (pidfile + log en data/)
libredeck-cli status               # API + WS (descubre WS vía /config → /health)
libredeck-cli stop                 # 1) API shutdown 2) pidfile 3) kill dirigido por PID
libredeck-cli plugin list
libredeck-cli plugin install ./mi-plugin        # carpeta local
libredeck-cli plugin install ./mi-plugin.zip    # zip local (upload)
libredeck-cli plugin install https://github.com/org/plugin.git --ref v1.2.0
libredeck-cli logs -n 50 --level error
libredeck-cli logs --follow        # WS en vivo (topic logs), con fallback a polling 2 s
```

El CLI es otro cliente más: no habla a la DB directamente, todo va por `http://localhost:<port>/api/v1`.

---

## API y WebSocket

Base: `http://localhost:3001`. Salud: `GET /health` → `{ status, timestamp, version, websocket }`. Config UI: `GET /config` → `{ wsPort, apiPort, frontendPort }`.

Familias principales (`daemon/src/api/*.ts`, `routes.ts` solo reparte):

```
GET/POST /api/v1/profiles   GET/PUT/DELETE /api/v1/profiles/:id
GET/POST /api/v1/pages?profileId= ...
GET/PUT/DELETE /api/v1/pages/:id   GET/POST/PUT/DELETE /api/v1/buttons...
POST /api/v1/actions/execute
GET /api/v1/plugins  POST /api/v1/plugins/install  POST /api/v1/plugins/upload
GET /api/v1/devices/streamdeck/*   GET /api/v1/network/ips
GET /api/v1/logs  GET/POST /api/v1/settings  GET /api/v1/mcp/*  GET /api/v1/jobs
POST /api/v1/admin/shutdown
GET /api/v1/version
```

WebSocket `ws://localhost:3003`:

- Cliente → `subscribe` / `unsubscribe` / `button.press` / `page.select` / `profile.select`
- Servidor → `button.pressed`, `action.started/finished/error`, `profile.updated/navigate`, `page.created/updated/deleted/navigate`, `button.updated/deleted`, `plugin.installed/enabled`, **`log.created`** (topic `logs`)

---

## Plugins

- Nativo: crea `daemon/src/plugins/mi.plugin.ts`, expórtalo en `daemon/src/plugins/index.ts`. Se autoinstala con versión y respeta `enabled`.
- Externo: carpeta en `<data>/plugins/<id>/` con `manifest.json` + `main.js` (`register(api)` / `onAction` / `emitEvent`). Validación en `plugin-system/validator.ts`, sandbox en `sandbox.ts`.

Instalar uno local sin comprimir:

```bash
libredeck-cli plugin install ./mi-plugin --force
# equivale a POST /api/v1/plugins/install { sourceType:'directory', path:'<abs>' }
```

---

## Desarrollo

```bash
bun run install:all
bun run dev              # daemon (DEV_MODE) + Astro + launcher
./dev.sh setup           # primera vez: deps + data/ + perfil + plugin ejemplo
./dev.sh dev             # dev con detección LAN + auto-open

cd daemon && bun test    # 236 tests
cd cli && bun test       # 30 tests
bun test src/bun/        # 46 tests
cd web && npm run test   # vitest
```

Reglas del repo (`AGENTS.md` manda):

- Usa `DatabaseService` (`daemon/src/db.ts`), nunca SQL suelto. `data` es JSON-as-TEXT: parsea en el borde.
- Rutas nuevas en `daemon/src/api/<familia>.ts`, no en el dispatcher.
- Web con **npm**, daemon/CLI con **bun**. No lo mezcles.
- No arranques dev servers si no te lo piden: el usuario ya los tiene abiertos.

---

## Build y release

Canónico prod = **launcher Rust + daemon compilado + web-dist**:

```bash
./build.sh
# web → daemon/web-dist + dist/ → daemon+cli compilados (versión incrustada)
# → launcher Rust (si hay cargo) → Inno Setup (Windows)
```

- Fuente única de versión: `package.json` raíz. Daemon/CLI la leen de `*/src/version.ts` (`LIBREDECK_VERSION` > JSON raíz incrustado > `dev`). `/health` y `/api/v1/version` usan `getVersion()`, sin `0.1.0` fijos.
- CI (`.github/workflows/release.yml`): test → build por OS (daemon + CLI + `web-dist.tar.gz`; Windows además `BunDeck-Setup`) → `semantic-release` en `master`.
- Electrobun queda fuera del release canónico (sus artefactos van a `.../releases/latest/download`).

---

## Variables de entorno

| Var | Efecto |
|---|---|
| `PORT` / `WS_PORT` / `FRONTEND_PORT` / `HOST_PORT` | Puertos (ver tabla) |
| `DEV_MODE=true` | Sin frontend embebido; UI en Astro `:4321` |
| `LIBREDECK_DATA_DIR` | Data dir explícito (también tests) |
| `LIBREDECK_BIND` / `LIBREDECK_BIND_LAN=1` | `0.0.0.0` para LAN; por defecto loopback |
| `LIBREDECK_VERSION` | Override de versión (build/CI la inyectan) |
| `LIBREDECK_NO_TRAY=1` / `LIBREDECK_MANAGED=1` | El daemon no crea tray / no se aut Gestiona (lo pone el launcher) |
| `LIBREDECK_HOST_MANAGE_DAEMON=0/1` | Prohíbe/fuerza que Electrobun gestione el daemon |
| `BUN_PATH` | Bun alternativo para el host dev |
| `NO_LAUNCHER=1` / `NO_BROWSER=1` | No abrir launcher / navegador en dev |

---

## Solución de problemas

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| Panel no abre en `:3002` | Daemon en `DEV_MODE` o puerto ocupado | En dev usa `:4321`; revisa `http://localhost:3001/health` y `HOST_PORT` |
| Móvil no llega al panel | Bind loopback sin LAN | Arranca con `LIBREDECK_BIND_LAN=1` (dev.sh/launcher ya lo hacen) |
| Dos iconos en tray | Daemon con tray + launcher | Normal solo en dev manual; en instalado el daemon lo desactiva solo |
| `plugin install` carpeta falla | Ruta relativa o sin `manifest.json` | Pasa ruta absoluta con `manifest.json` + `main.js`; el CLI ya la absolutiza |
| DB vieja con versión rara | `app.version` antiguo | Se auto-actualiza al arrancar (`getVersion()`); si no, `./dev.sh clean` |
| Puerto ocupado | Otro daemon corriendo | `libredeck-cli status` / `stop`, o cambia `PORT`/`WS_PORT` |

Logs: `libredeck-cli logs --follow` o `<data>/logs/daemon.log` (modo detach).

---

## FAQ: por qué no Electron

**¿No era más fácil un Electron?**
Más fácil de empaquetar, sí. Pero pagarías un Chromium entero siempre residente para un panel que pasa cerrado y un backend que debe ser diminuto. Medido aquí: stack completo ~100 MB frente a 250–500 MB típicos de Electron equivalente.

**¿Por qué Bun y no Node?**
Arranque instantáneo, SQLite y WS integrados sin nativos frágiles, y `bun build --compile` produce un exe único sin instalador de runtime.

**¿Por qué Astro + Vue y no React SPA?**
El panel es 90 % estático + islas interactivas. Astro genera 1,3 MB estáticos; Vue solo donde hay estado (botones, inspector, streaming). Menos JS = menos RAM en el navegador.

**¿Por qué Rust para el launcher?**
Porque su trabajo es mínimo y siempre residente: vigilar 3 puertos, mostrar estado y pedir shutdown. En Rust son 6,5 MB de binario y ~54 MB con ventana. En Electron serían cientos de MB para lo mismo.

**¿Y Electrobun entonces?**
Buena tecnología (WebView del sistema, no Chromium embebido) y útil en dev. Pero en prod duplicaba el rol del launcher. Un proceso menos, un problema menos.
