import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E — sustituto de Cypress (cypress.config.ts).
 *
 * Requiere daemon en http://localhost:3001 y web en http://localhost:4321
 * YA LEVANTADOS fuera (dev server + daemon corren por separado).
 * Sin webServer auto-start a propósito: `bun run dev` / `./dev.sh dev`
 * los gestionan. Ver web/cypress.config.ts (baseUrl) como referencia.
 */
export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  timeout: 30_000,
  // El daemon es compartido: los workers en paralelo se pisan
  // (current.page_id, páginas creadas). Serie como Cypress.
  workers: 1,
  fullyParallel: false,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: 'http://localhost:4321',
    testIdAttribute: 'data-cy',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // 1600px: la biblioteca lateral (320px) no tapa el grid (a <1360
        // la app la pliega por defecto, pero con prefs persistidas puede
        // quedar abierta y solapar a 1280).
        viewport: { width: 1600, height: 900 },
      },
    },
  ],
});
