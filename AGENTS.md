# AGENTS.md — BunDeck

Multi-process StreamDeck alternative. Web UI is only the control panel; automation lives in the daemon.

## Layout

- `daemon/src/server.ts` — Bun backend (REST API + static frontend + WS manager). Entrypoint; also imported by Electrobun (`if (import.meta.main)` guard).
- `daemon/src/config.ts` — port/data-dir source of truth. `daemon/src/paths.ts` — runtime dirs. `daemon/src/db.ts` — SQLite schema + `DatabaseService`.
- `daemon/src/api/routes.ts` — all REST routes. `daemon/src/ws.ts` — WebSocket server. `daemon/src/action-runner.ts` — action execution. `daemon/src/plugin-loader.ts` + `daemon/src/plugin-system/` + `daemon/src/plugins/` — plugin runtime (10 built-ins auto-installed on DB init).
- `web/` — Astro + Vue 3 (Composition API) + Tailwind/DaisyUI, Pinia, vue-i18n (en/es). **Uses `npm`, not `bun`** (`npm install`, `npm run dev/build`).
- `cli/src/cli.ts` — `sdctl` (commander). `src/bun/index.ts` — Electrobun host (spawns daemon, opens window). `scripts/copy-web-dist.js` — used by CI to embed web into daemon. Legacy standalone launcher (`web-server/`, `entrypoint.js`, `web/src/server.ts`, `web/src/components/deprecated/`) removed — the only static server is the embedded one in `daemon/src/server.ts`.

## Commands (from repo root)

```bash
bun run install:all   # daemon+cli via bun, web via npm (correct per-package managers)
bun run dev           # daemon (DEV_MODE, no embedded frontend) + Astro dev + launcher GPUI, concurrently
bun run build         # daemon + web + cli (rápido, sin empaquetar; para release usa ./build.sh)
./build.sh            # CANÓNICO prod: web → web-dist en daemon/ y dist/ → daemon+cli compilados (versión incrustada) → launcher Rust → Inno Setup (Windows only)
./dev.sh setup        # first-time: deps + data/ + default profile + example plugin
./dev.sh dev          # dev with LAN URL detection + auto-open browser
```

Per-package: `cd daemon && bun run dev` (`--watch src/server.ts`); `cd web && npm run dev`; `cd cli && bun run dev`.

## Ports & env (trust `daemon/src/config.ts`, not old docs)

| Service  | Default | Override                              |
| -------- | ------- | ------------------------------------- |
| API      | 3001    | `PORT` or `--port=`                   |
| WS       | **3003**| `WS_PORT` (old docs saying 3002 are stale) |
| Frontend (embedded/prod) | 3002 | `FRONTEND_PORT` or `--web-port=` |
| Astro dev | 4321   | `astro.config.mjs` (`host: true`, LAN-reachable) |

- `DEV_MODE=true` disables the daemon's embedded frontend server (dev uses Astro on 4321). `dev.sh` sets it; root `bun run dev:daemon` does not — prefer root `bun run dev` or `./dev.sh dev`.
- Bind seguro por defecto: `127.0.0.1`. LAN explícita con `LIBREDECK_BIND_LAN=1` (lo ponen `dev.sh`, launcher Rust y host Electrobun en dev) o `LIBREDECK_BIND=0.0.0.0`. `dev.sh`/QR necesitan LAN; sin opt-in no hay escucha LAN.
- Health: `http://localhost:3001/health`. Frontend config: `/config` → `{ wsPort, apiPort, frontendPort }`.
- Data dir resolution (`resolveDataDir`): `LIBREDECK_DATA_DIR` > `ELECTROBUN_DATA_DIR/libredeck` > `%APPDATA%/LibreDeck/data` (installed) > `<repo>/data` (dev). DB is `<data>/db.sqlite`. `data/` is runtime state — never commit; reset with `bun run clean` (root `clean` also wipes `data/db.sqlite*`).

## DB, API, WS conventions

- Always use `DatabaseService` from `daemon/src/db.ts`; never raw SQL outside it. `data` columns are JSON-as-TEXT (profiles/pages/buttons `data`, plugin `manifest`); parse/stringify at the boundary (see `getButtonsByPage`).
- Schema changes: edit `SQL_SCHEMA` + `runMigrations()` in `db.ts`, then `./dev.sh clean` to reset. Page names are unique per profile (enforced in `createPage`/`updatePage`).
- API: add routes in `daemon/src/api/*.ts` (`routes.ts` solo dispatcher, mismo orden/URLs), always attach CORS headers, return `Response` with JSON. Static assets served from `<data>/assets` under `/assets/`.
- WS (`daemon/src/ws.ts`, separate `Bun.serve`): client msgs `subscribe`/`unsubscribe`/`button.press`/`page.select`/`profile.select`; server broadcasts `button.pressed`, `action.started/finished/error`, `profile.updated/navigate`, `page.created/updated/deleted/navigate`, `button.updated/deleted`, `plugin.installed/enabled`, `log.created` (topic `logs`). Broadcasts take an optional topic filter (`profiles|pages|buttons|plugins|logs`).

## Plugins & actions

- New action type = new file in `daemon/src/plugins/*.plugin.ts` + export in `daemon/src/plugins/index.ts` (auto-installed via `installBuiltInPlugins` in `db.ts`, version-keyed update preserving `enabled`).
- External plugins live in `<data>/plugins/<id>/` with `manifest.json` + `main.js` (`register(api)` / `onAction` / `emitEvent`); validation in `daemon/src/plugin-system/validator.ts`, sandbox in `sandbox.ts`.
- Frontend button editor is `web/src/components/` (`Dashboard.vue` per history); use the `apiRequest()` helper and existing WS composable (`useStreamDeck.ts`), add `data-cy` attributes for Cypress.

## Test

```bash
bun run test          # daemon (bun:test) then web (vitest) — what CI runs
bun run test:e2e      # start-server-and-test: boots dev, waits on :4321, runs Cypress (needs daemon on 3001)
cd daemon && bun test <file>          # single daemon test, e.g. bun test action-runner.test.ts
cd web && npx vitest run <file>       # single web test
cd web && npm run test:e2e:open       # Cypress GUI
```

- Daemon tests import from `bun:test` and use `mock.module()`; web tests use `vitest` + jsdom. Root scripts: `bun run test` (daemon+web), `bun run test:coverage`, `bun run test:e2e`. There is no `test:all` script.
- No eslint config exists in-repo despite `lint` scripts referencing eslint — do not present lint as a working gate.

## Releases

- Build canónico prod = launcher Rust + daemon compilado + web-dist (`./build.sh`; en CI, `.github/workflows/release.yml`). Electrobun es solo dev/experimental: no usar para distribuir.
- Fuente única de versión: root `package.json` (canónica). Daemon y CLI la leen de `daemon/src/version.ts` / `cli/src/version.ts` (`getVersion()`): import del JSON de root (incrustado en el binario por `bun build --compile`) con override `LIBREDECK_VERSION` (inyectado por `build.sh` y CI en tiempo de build). `GET /health` y `GET /api/v1/version` (`{ version, channel: 'stable', buildDate }`) usan `getVersion()` (sin `'0.1.0'` fijos). Launcher la expone vía `build.rs` (`LIBREDECK_VERSION` o root JSON) + pubkey de `UPDATE_PUBKEY`. `electrobun.config.ts` `app.version` lo sincroniza `scripts/electrobun-prebuild.ts` desde root (dev-only). `installer.iss` recibe la versión vía `version.iss` generado por `build.sh`/CI (no `/DAppVersion`). No hardcodear versiones nuevas: basta con el bump de semantic-release en root.
- `semantic-release` on push to `master`: test → matrix build ubuntu/windows/macos (cada OS publica bundle gestionado `bundeck-v*-<target>.zip` con daemon+cli+launcher+updater+web-dist, más binarios sueltos legacy; Windows además `BunDeck-Setup-v*.exe`) → manifiesto firmado (`scripts/build-update-manifest.mjs`, secret `LIBREDECK_UPDATE_PRIVKEY`) → release.
- Updater canónico: **launcher Rust** (`launcher/src/updater.rs` + helper `launcher/src/updater_bin.rs`; layout `versions/<ver>/` + `active.json`, manifiesto `bundeck-update-manifest.json`, detalle en `UPDATE_SYSTEM.md`). Legacy GitHub-ZIP flow (`daemon/src/update.ts`, `GET /api/v1/version/check`, `POST /api/v1/update`) removed — endpoints return `501`. `GET /api/v1/version` (solo lectura) se mantiene; `POST /api/v1/admin/prepare-update` es el gancho pre-update. `libredeck-cli update` solo aplica en instalaciones standalone (gestionadas → usar el launcher).

## Gotchas

- Do not start long-running dev servers (`./dev.sh dev`, `bun run dev`, `electrobun dev`) unless asked — the user runs them; assume they auto-reload.
- `dev.sh`/`build.sh` are bash scripts with Windows-isms (`start`, hardcoded `C:\...` paths) — run from Git Bash on Windows.
- Tray icon is Windows-only and owned solely by the Rust launcher (`launcher/src/tray.rs`); the daemon has no tray code. StreamDeck driver init failure is non-fatal by design.
- Electrobun es dev-only/experimental: `electrobun build --env=stable` publica artefactos de updater en `.../releases/latest/download` (`electrobun.config.ts`), fuera del release canónico; window prefers `http://localhost:3002`, falls back to `views://mainview/index.html` (offline copy from `copy: {"web/dist": "views/mainview"}`).
