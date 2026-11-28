# BunDeck Auto-Update (gestionado por el launcher)

> El updater canónico es el **launcher Rust** (`launcher/src/updater.rs`).
> Electrobun es dev-only y queda fuera del release canónico.

Cada release publica un **bundle gestionado** por plataforma y un
**manifiesto versionado**:

- `bundeck-v<ver>-windows-x64.zip` / `-linux-x64.zip` / `-darwin-x64.zip`
  (daemon + CLI + launcher + `libredeck-updater` + `web-dist/`)
- `bundeck-update-manifest.json`:
  `{ version, channel, assets: { <target>: { bundle, url, sha256, size, signature } } }`

La firma es ed25519 sobre `"<version>|<target>|<sha256>"`
(`scripts/build-update-manifest.mjs` firma con `BUNDECK_UPDATE_PRIVKEY`;
la pública vive en `launcher/UPDATE_PUBKEY` y se compila dentro del
launcher — ver `scripts/gen-update-keys.mjs`).

## Layout gestionado

```text
<install>/                    # junto al launcher, o $BUNDECK_INSTALL_DIR
  libredeck-launcher(.exe)    # en ejecución
  libredeck-updater(.exe)     # reemplaza al launcher (fichero bloqueado en Windows)
  versions/<ver>/             # daemon, cli, launcher, updater, web-dist/
  active.json                 # {"version":"1.6.0"}
```

El instalador de Windows es por usuario: `{localappdata}\Programs\BunDeck`.
Por eso el launcher puede escribir versiones nuevas sin elevación. Los datos
siguen en `%APPDATA%\LibreDeck\data`; los backups de `db.sqlite*` se guardan
en `<data>/backups/db-<ts>/`. Ninguno de esos datos se elimina al actualizar.

## Flujo

1. **Buscar**: el launcher descarga el manifiesto
    (`.../releases/latest/download/bundeck-update-manifest.json`) y compara
    con `GET /api/v1/version` al abrirse y cada seis horas (reintenta a los
    15 minutos si falla la red). Si no hay manifiesto, informa con la API de
    GitHub y no instala paquetes no verificables.
2. **Descargar**: hilo de fondo con progreso en la tarjeta ACTUALIZACIÓN
   de GPUI (porcentaje real por `Content-Length`); comienza automáticamente
   al detectar una versión nueva y se descarga a `%TEMP%`.
3. **Verificar**: sha256 obligatorio; firma ed25519 si hay pubkey compilada
   (sin pubkey: aviso, no bloqueo — solo en builds dev).
4. **Stage**: extracción a `versions/<ver>/` + `chmod +x` (Unix); escribe
   `pending-update.json` para conservar el aviso entre aperturas.
5. **Aplicar**: al pulsar **Reiniciar para actualizar**, o automáticamente
   en el siguiente inicio, `POST /api/v1/admin/prepare-update` (checkpoint
   WAL), backup DB, apagado, cambio de `active.json`, arranque y health-check.
   Si el nuevo daemon no responde, **rollback** a la versión anterior. Se
   conservan activa + 2 anteriores. El launcher se reemplaza al salir y
   relanza la nueva versión. En Windows, al instalar por usuario, no requiere
   UAC.
6. **Self-update del launcher**: `libredeck-updater --wait-pid …` copia el
   nuevo launcher tras salir este proceso y lo relanza.

## CLI

- `libredeck-cli update` → comprueba el manifiesto.
- Instalación **gestionada**: indica usar el launcher (único dueño).
- Instalación **standalone** (binarios sueltos): descarga verificada
  (sha256) a `libredeck-daemon-v<ver>[.exe]` versionado; `getLatestDaemonExe()`
  ya elige el más nuevo, basta `stop` + `start`.
- `libredeck-cli update --check` solo informa.

## Endpoints del daemon

- `GET /api/v1/version` → `{ version, channel: 'stable', buildDate }`.
- `POST /api/v1/admin/prepare-update` → `{ ok: true }` (gancho pre-update).
- `GET /api/v1/version/check` y `POST /api/v1/update` → `501 Gone`
  (el update lo hace el launcher, no la API).

## Autostart + inicio minimizado (gobernados por el daemon)

- Settings del daemon (tabla `settings`, solo `DatabaseService`):
  `system.autostart` (seed `false`) e `system.start_minimized` (seed `true`,
  default ON). La web los edita (Ajustes → General) con POST
  `/api/v1/settings` normalizado a `'true'/'false'`; el POST emite
  `settings.changed` (topic `settings`).
- El launcher los sondea cada 2 s (`sync_from_daemon`) y los aplica al SO.
  Si la API no responde, usa la caché local `launcher-startup.json`
  (junto a `launcher-update.log`) y no toca nada del SO.
- **Se mantiene Run (HKCU\…\Run), NO Task Scheduler**: Run respeta el flag
  `--minimized` que el launcher registra cuando `system.start_minimized`
  está activo (arranque sin ventana: solo ancla + tray), no pide elevación
  y no exige tarea logon ni salvedades UAC. El Scheduler solo añadiría
  fricción sin ningún beneficio para un arranque por usuario.
- El flag `--minimized` al arrancar significa: sin ventana visible, sin
  diálogos modales de instancia/servidor (log + salida silenciosa) y sin
  abrir el navegador en el camino de boot. La pestaña **Ajustes** del panel
  expone idioma (`ui.language`, se aplica al momento), autostart y
  minimizado, con I/O en hilo de fondo y valores iniciales desde la caché
  local si el daemon está caído.

## CI / releases

- `build` (matriz 3 OS): daemon + CLI + launcher + updater + web-dist →
  `dist/` → `scripts/make-bundle.sh` → `bundeck-v<ver>-<target>.zip`.
- `release`: junta artefactos, `scripts/build-update-manifest.mjs`
  (firma si existe el secret `BUNDECK_UPDATE_PRIVKEY`) y
  `semantic-release` publica el instalador Windows, los tres bundles
  gestionados y el manifiesto. Los binarios sueltos se distribuyen dentro
  de los bundles, no como assets duplicados.
- Secret requerido: `BUNDECK_UPDATE_PRIVKEY` (seed hex).
  Opcional en build: `BUNDECK_UPDATE_PUBKEY` (si no, `UPDATE_PUBKEY`).
- macOS necesita firma/notarización para no pedir Gatekeeper en cada
  versión; el instalador por usuario es `scripts/install-macos.sh`
  (Linux: `scripts/install-linux.sh`).

## Probar un update sin release

1. `cargo run` en `launcher/` (dev, con `BUNDECK_INSTALL_DIR` temporal).
2. Servir un manifiesto + bundle falsos en local y apuntar
   `MANIFEST_URL`… (hoy la URL es fija; para E2E local, edita temporalmente
   `MANIFEST_URL` en `updater.rs` o usa `libredeck-cli update` contra
   `BUNDECK_INSTALL_DIR` con un bundle real renombrado).
3. `cargo test --bins` (versiones, manifiesto, layout, liveness de
   instancia, matching CSV de PIDs, `stack_down`/`wait_for_stack_down`) +
   `bun test` en `daemon/` y `cli/`.

### Checklist de regresión (bug "ya hay instancia" tras actualizar)

- **Self-update con launcher nuevo**: tras aplicar, el helper debe esperar
  al mutex libre (`wait_for_single_instance_free`) antes de relanzar. Si al
  abrir aparece "Ya hay BunDeck abierto", mirar `launcher-update.log`:
  debe mostrar `Stack detenido` → `handoff` → `Esperando al launcher` →
  `relanzar`, sin `taskkill`.
- **Sin `/T` sobre el launcher**: reemplazar la instancia desde el diálogo
  ya no mata el árbol (el daemon actualizado sobrevive). Solo el Astro-dev
  huérfano de `:4321` usa `/T`.
- **Metadata stale**: matar el launcher a la brava y reabrir no debe ofrecer
  matar un PID muerto/reutilizado (el diálogo solo sale si el PID vive y su
  línea de comandos es `*-launcher`).
- **Salir cierra todo**: tras "Salir" del tray, nada debe escuchar en
  `:3001/:3003/:3002` (`wait_for_stack_down` + `stack_down` en el log).
  En dev, `:4321` (Astro) puede seguir: es proceso aparte, no del daemon.
- **Sin pestañas fantasma**: con `BUNDECK_MANAGED=1` el daemon ya no hace
  auto-open; cada apply no debe abrir pestañas nuevas.
