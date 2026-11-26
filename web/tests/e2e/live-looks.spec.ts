import { test, expect } from '@playwright/test';

/**
 * live-looks.spec.ts — la apariencia condicional reacciona EN VIVO al
 * cambiar una variable en el daemon (sin recargar la página).
 *
 * 1. Botón nuevo + "Silenciar / reactivar micro" (Discord) vía PALETA
 *    (la biblioteca bloquea acciones de plugins sin configurar; la paleta
 *    no): al ser única acción se auto-añade el par
 *    `discordMuted` / `discordMuted == falso`. En Aspecto se ven 2 tarjetas
 *    `.bd-rl`; al cambiar la variable en el daemon vía REST, la tarjeta con
 *    `is-matched` cambia en vivo por el WS `variable.changed`.
 * 2. Condición numérica manual (`e2eContador > 10` escrita en el input del
 *    look): matchea/unmatchea en vivo al cambiar la variable por API.
 */

const API = 'http://localhost:3001/api/v1';

let testPageId = '';
let restorePageId = '';

test.beforeEach(async ({ page, request }) => {
  testPageId = '';
  await page.goto('/');
  await dismissWelcome(page);
  await expect(page.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 30000 });

  // Higiene: barrer páginas huérfanas de runs anteriores (nombres auto
  // "Página N" duplicados confunden al filtro del chip).
  try {
    const profiles = await (await request.get(`${API}/profiles`)).json();
    const runner = (profiles as any[]).find((p: any) => p.name === 'E2E Runner');
    if (runner) {
      const pages = await (await request.get(`${API}/pages?profileId=${runner.id}`)).json();
      for (const p of pages as any[]) {
        if (p.name !== 'E2E Home') {
          await request.delete(`${API}/pages/${p.id}`, { failOnStatusCode: false });
        }
      }
    }
  } catch { /* best-effort */ }

  const cur = await request.get(`${API}/settings?key=current.page_id`);
  if (cur.ok()) restorePageId = (await cur.json()).value ?? '';

  // Página nueva por UI (queda auto-seleccionada).
  const createPagePromise = page.waitForResponse(
    (res) => res.url().includes('/api/v1/pages') && res.request().method() === 'POST',
  );
  await page.locator('[data-cy=bd-page-add]').click();
  const createPageRes = await createPagePromise;
  expect(createPageRes.status()).toBe(201);
  const created = await createPageRes.json();
  testPageId = created.id;
  await expect(
    page.locator('.bd-page .bd-chip[aria-pressed="true"]').filter({ hasText: created.name }).first(),
  ).toBeVisible({ timeout: 10000 });

  // Dejar que se asiente la recarga por WS tras crear la página antes de
  // clicar la tecla (si no, la selección se pierde).
  await page.waitForTimeout(1500);
});

test.afterEach(async ({ request }) => {
  if (testPageId) {
    await request.delete(`${API}/pages/${testPageId}`, { failOnStatusCode: false });
  }
  if (restorePageId) {
    await request.post(`${API}/settings`, {
      data: { key: 'current.page_id', value: restorePageId },
    });
  }
});

async function dismissWelcome(page: any) {
  try {
    await page.evaluate(() => {
      try { window.localStorage.setItem('bundeck:welcome-seen', '1'); } catch { /* noop */ }
      const d = document.querySelector('[data-cy=bd-welcome]') as any;
      try { if (d && d.open) d.close(); } catch { /* noop */ }
    });
  } catch { /* noop */ }
  try {
    const skip = page.locator('[data-cy=bd-welcome-skip]');
    await skip.waitFor({ state: 'visible', timeout: 1500 });
    await skip.click();
  } catch { /* noop */ }
}

/** Fija una variable en el daemon (PUT; si no existe, la crea con POST). */
async function setDaemonVar(request: any, name: string, value: unknown, type: string) {
  const put = await request.put(`${API}/variables/${encodeURIComponent(name)}`, {
    data: { value },
    failOnStatusCode: false,
  });
  if (put.status() === 404) {
    const post = await request.post(`${API}/variables`, {
      data: { name, type, value },
    });
    expect(post.status()).toBe(201);
  } else {
    expect(put.ok()).toBeTruthy();
  }
}

test('la apariencia reacciona al cambio de variable en vivo', async ({ page, request }) => {
  // Tecla vacía + acción con estados vía paleta (la biblioteca bloquea
  // acciones de plugins sin configurar; la paleta no).
  await page.locator('[data-swapy-slot="slot-0"] [data-cy=bd-key]').click();
  await expect(page.locator('[data-cy=bd-key-title]')).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: /Añadir acción/ }).first().click();
  await expect(page.locator('dialog.bd-cmd[open]')).toBeVisible({ timeout: 5000 });
  await page.locator('#bd-cq').fill('Silenciar');
  const muteItem = page
    .locator('[data-cy=bd-palette-item]', { hasText: 'Silenciar / reactivar micro' })
    .first();
  await expect(muteItem).toBeVisible({ timeout: 10000 });

  const putPromise = page.waitForResponse(
    (res: any) =>
      res.url().includes('/api/v1/buttons/') &&
      res.request().method() === 'PUT' &&
      (res.request().postData()?.includes('discordMuted') ?? false),
    { timeout: 15000 },
  );
  await muteItem.click();
  await putPromise;

  // Sin diálogo: era la única acción y no había condiciones.
  await expect(page.locator('dialog.bd-confirm[open]')).toHaveCount(0);

  // Aspecto: el par on/off auto-añadido.
  await page.locator('[data-cy=bd-tab-appearance]').click();
  const cards = page.locator('.bd-rl');
  await expect(cards).toHaveCount(2, { timeout: 10000 });
  const liveChip = page.locator('[data-cy=bd-available-vars] .bd-var-chip', { hasText: 'discordMuted' });
  await expect(liveChip).toBeVisible({ timeout: 10000 });
  const liveVal = liveChip.locator('.bd-var-ro');

  // Normalizar a false: matchea la SEGUNDA (`== falso`), la primera no.
  await setDaemonVar(request, 'discordMuted', false, 'bool');
  await expect(cards.nth(1)).toHaveClass(/is-matched/, { timeout: 10000 });
  await expect(cards.nth(0)).not.toHaveClass(/is-matched/, { timeout: 10000 });

  // Pasar a true EN EL DAEMON: la PRIMERA tarjeta matchea en vivo, sin recargar.
  await setDaemonVar(request, 'discordMuted', true, 'bool');
  await expect(cards.nth(0)).toHaveClass(/is-matched/, { timeout: 10000 });
  await expect(cards.nth(1)).not.toHaveClass(/is-matched/, { timeout: 10000 });
  // La rejilla de variables muestra el valor en vivo.
  await expect(liveVal).toHaveText(/verdadero/, { timeout: 10000 });

  // Volver a false: vuelve a matchear la segunda.
  await setDaemonVar(request, 'discordMuted', false, 'bool');
  await expect(cards.nth(1)).toHaveClass(/is-matched/, { timeout: 10000 });
  await expect(cards.nth(0)).not.toHaveClass(/is-matched/, { timeout: 10000 });
  await expect(liveVal).toHaveText(/falso/, { timeout: 10000 });
});

test('condición numérica manual matchea en vivo al cambiar la variable', async ({
  page,
  request,
}) => {
  // Variable global numérica (se crea si no existe) normalizada a 0.
  await setDaemonVar(request, 'e2eContador', 0, 'numeric');

  // Botón con una acción normal vía la biblioteca (toast).
  await page.locator('[data-swapy-slot="slot-0"] [data-cy=bd-key]').click();
  await expect(page.locator('[data-cy=bd-key-title]')).toBeVisible({ timeout: 5000 });
  await page.locator('#bd-q').fill('toast');
  const toastItem = page.locator('[data-cy=bd-action-item]', { hasText: 'Mostrar mensaje' }).first();
  await expect(toastItem).toBeVisible({ timeout: 10000 });
  const createPromise = page.waitForResponse(
    (res: any) => res.url().includes('/api/v1/buttons') && res.request().method() === 'POST',
  );
  await toastItem.click();
  await createPromise;

  // Aspecto: añadir un look y escribir la condición a mano.
  await page.locator('[data-cy=bd-tab-appearance]').click();
  await page.locator('[data-cy=bd-add-look]').click();
  const cards = page.locator('.bd-rl');
  await expect(cards).toHaveCount(1, { timeout: 10000 });
  const condInput = cards.last().locator('input.bd-inp.bd-mono');
  await expect(condInput).toBeVisible({ timeout: 5000 });

  const savePromise = page.waitForResponse(
    (res: any) =>
      res.url().includes('/api/v1/buttons/') &&
      res.request().method() === 'PUT' &&
      (res.request().postData()?.includes('e2eContador') ?? false),
    { timeout: 15000 },
  );
  await condInput.fill('e2eContador > 10');
  await savePromise;

  // Con 0 no matchea ninguna.
  await expect(cards.nth(0)).not.toHaveClass(/is-matched/, { timeout: 10000 });

  // Subir a 20 en el daemon: la tarjeta matchea en vivo, sin recargar.
  await setDaemonVar(request, 'e2eContador', 20, 'numeric');
  await expect(cards.nth(0)).toHaveClass(/is-matched/, { timeout: 10000 });

  // Bajar a 0: deja de matchear.
  await setDaemonVar(request, 'e2eContador', 0, 'numeric');
  await expect(cards.nth(0)).not.toHaveClass(/is-matched/, { timeout: 10000 });
});
