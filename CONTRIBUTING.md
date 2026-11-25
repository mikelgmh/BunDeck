# Contributing to BunDeck

Thanks for stopping by. BunDeck is a local-first Stream Deck alternative:
Bun daemon (API + SQLite + plugins) + Astro/Vue panel + Rust launcher + CLI.

## Quick start (from source)

```bash
git clone https://github.com/mikelgmh/BunDeck.git
cd BunDeck
bun run install:all   # daemon+cli via bun, web via npm (on purpose, don't mix)
bun run dev           # daemon (DEV_MODE) + Astro panel (:4321) + launcher
```

- API: `http://localhost:3001/health` — panel dev: `http://localhost:4321`
- Prod panel: `http://localhost:3002` (embedded `web-dist`)
- Phone on LAN: `http://<lan-ip>:3002` with `LIBREDECK_BIND_LAN=1` (also `BUNDECK_BIND_LAN`, see env compat)

## Repo rules (CI enforces these)

- **DB:** always use `DatabaseService` (`daemon/src/db.ts`). Never raw SQL outside it.
  `data` columns are JSON-as-TEXT — parse/stringify at the boundary.
- **API:** new routes go in `daemon/src/api/<family>.ts`. `routes.ts` only dispatches.
  Always attach CORS headers, return `Response` with JSON.
- **Plugins:** new action type = new file in `daemon/src/plugins/*.plugin.ts` +
  export in `daemon/src/plugins/index.ts`. External plugins live in
  `<data>/plugins/<id>/` with `manifest.json` + `main.js`.
- **Web:** Astro + Vue + Tailwind/DaisyUI. Don't change the stack.
  Use `apiRequest()` + `useStreamDeck.ts` composable. Add `data-cy` for Cypress/Playwright.
- **Package managers:** `daemon/` + `cli/` with **bun**, `web/` with **npm**.
- **Env compat:** canonical prefix is `BUNDECK_*`, `LIBREDECK_*` still works as
  deprecated fallback. New code: read `BUNDECK_X ?? LIBREDECK_X`.
  Binaries: `bundeck-daemon`, `bundeck-cli`, `bundeck-launcher`, `bundeck-updater`.

## Tests

```bash
bun run test              # daemon (bun:test) + web (vitest) — what CI runs
cd daemon && bun test <file>   # single daemon test
cd web && npx vitest run <file>
bun run test:e2e           # boots dev, waits :4321, runs Playwright (needs daemon :3001)
```

- Daemon tests: `bun:test` + `mock.module()`. Web: `vitest` + jsdom.
- Canvas text tests need system fonts (`fonts-dejavu-core`, `fonts-liberation`
  on Linux). CI installs them.
- `frontend-cache.test.ts` needs `web/dist` — run `cd web && npm run build` first
  (CI does this in the test job).

## Screenshots (for docs / Reddit)

```bash
bun run dev:hybrid   # daemon :3001 + Astro :4321, no launcher
cd web && npx playwright screenshot --viewport-size=1600,900 \
  --wait-for-timeout=8000 "http://localhost:4321/" docs/shot-dashboard.png
```

Docs shots live in `docs/shots/` (dashboard, editor, mobile `4321/use`).

## Commits & releases

- Conventional Commits (`feat:`, `fix:`…). `semantic-release` on push to `master`:
  test → per-OS build (`bundeck-v*-<target>.zip` + Windows installer) →
  signed manifest → GitHub release.
- Don't commit `data/`, `*/dist/`, `daemon/web-dist/`, `*.exe`, `version.iss`.
- Reset local state: `bun run clean` (wipes `data/db.sqlite*`).

## Good first issues

Look for `good first issue`: new plugin manifest, i18n (`web/src/i18n/locales/`),
small `daemon/src/api/*` endpoint, or a Playwright `data-cy` gap.
