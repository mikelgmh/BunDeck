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
(`scripts/build-update-manifest.mjs` firma con `LIBREDECK_UPDATE_PRIVKEY`;
la pública vive en `launcher/UPDATE_PUBKEY` y se compila dentro del
launcher — ver `scripts/gen-update-keys.mjs`).

## Layout gestionado

```text
<install>/                    # junto al launcher, o $LIBREDECK_INSTALL_DIR
  libredeck-launcher(.exe)    # en ejecución
  libredeck-updater(.exe)     # reemplaza al launcher (fichero bloqueado en Windows)
  versions/<ver>/             # daemon, cli, launcher, updater, web-dist/
  active.json                 # {"version":"1.6.0"}
  backups/db-<ts>/db.sqlite* # copia antes de cada update
```

Instalaciones planas legacy (Windows installer antiguo) se migran solas al
primer update. Los datos del usuario (`db.sqlite`, `plugins/`, `assets/`,
`logs/`) nunca se tocan salvo el backup previo.

## Flujo

1. **Buscar**: el launcher descarga el manifiesto
   (`.../releases/latest/download/bundeck-update-manifest.json`) y compara
   con `GET /api/v1/version`. Sin manifiesto (release antigua) informa con
   la API de GitHub y sugiere descarga manual.
2. **Descargar**: hilo de fondo con progreso en la tarjeta ACTUALIZACIÓN
   de GPUI (porcentaje real por `Content-Length`, etapas legibles para el
   resto: verificar, extraer, aplicar…).
3. **Verificar**: sha256 obligatorio; firma ed25519 si hay pubkey compilada
   (sin pubkey: aviso, no bloqueo — solo en builds dev).
4. **Stage**: extracción a `versions/<ver>/` + `chmod +x` (unix).
5. **Aplicar**: `POST /api/v1/admin/prepare-update` (checkpoint WAL),
   backup DB, `POST /api/v1/admin/shutdown`, cambio atómico de
   `active.json`, arranque y health-check; si el nuevo daemon no responde,
   **rollback** a la versión anterior. Se conservan activa + 2 anteriores.
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

## CI / releases

- `build` (matriz 3 OS): daemon + CLI + launcher + updater + web-dist →
  `dist/` → `scripts/make-bundle.sh` → `bundeck-v<ver>-<target>.zip`.
- `release`: junta artefactos, `scripts/build-update-manifest.mjs`
  (firma si existe el secret `LIBREDECK_UPDATE_PRIVKEY`) y
  `semantic-release` publica el instalador Windows, los tres bundles
  gestionados y el manifiesto. Los binarios sueltos se distribuyen dentro
  de los bundles, no como assets duplicados.
- Secret requerido: `LIBREDECK_UPDATE_PRIVKEY` (seed hex).
  Opcional en build: `LIBREDECK_UPDATE_PUBKEY` (si no, `UPDATE_PUBKEY`).
- macOS necesita firma/notarización para no pedir Gatekeeper en cada
  versión; el instalador por usuario es `scripts/install-macos.sh`
  (Linux: `scripts/install-linux.sh`).

## Probar un update sin release

1. `cargo run` en `launcher/` (dev, con `LIBREDECK_INSTALL_DIR` temporal).
2. Servir un manifiesto + bundle falsos en local y apuntar
   `MANIFEST_URL`… (hoy la URL es fija; para E2E local, edita temporalmente
   `MANIFEST_URL` en `updater.rs` o usa `libredeck-cli update` contra
   `LIBREDECK_INSTALL_DIR` con un bundle real renombrado).
3. `cargo test --bins` (versiones, manifiesto, layout) +
   `bun test` en `daemon/` y `cli/`.
