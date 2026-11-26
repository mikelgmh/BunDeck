import { test, expect } from '@playwright/test';
import { setCurrentPage } from './helpers';

/**
 * preset-conditions.spec.ts — condiciones predefinidas de acciones con estado.
 *
 * 1. Botón nuevo + acción con estados (mute/unmute de Discord) como ÚNICA
 *    acción: el par on/off se añade solo, sin diálogo.
 * 2. Botón con icono personalizado + segunda acción con estados: sale el
 *    diálogo (ignorar / añadir; reemplazar oculto al no haber condiciones)
 *    y al añadir, el off hereda el icono elegido por el usuario.
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
  // clicar la tecla (si no, la selección se pierde). Sin recargas: la app
  // ya está en la página nueva y recargar nos sacaría de ella.
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

async function getButtonAt(request: any, position: number) {
  const res = await request.get(`${API}/buttons?pageId=${testPageId}`);
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as any[]).find((b: any) => b.position === position);
}

/** PUT de guardado cuyo cuerpo ya trae las condiciones (auto o diálogo). */
function waitForLooksPut(page: any) {
  return page.waitForResponse(
    (res: any) =>
      res.url().includes('/api/v1/buttons/') &&
      res.request().method() === 'PUT' &&
      (res.request().postData()?.includes('discordMuted') ?? false),
    { timeout: 15000 },
  );
}

test('botón nuevo + mute/unmute añade el par sin preguntar', async ({ page, request }) => {
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

  const putPromise = waitForLooksPut(page);
  await muteItem.click();
  await putPromise;

  // Sin diálogo: era la única acción y no había condiciones.
  await expect(page.locator('dialog.bd-confirm[open]')).toHaveCount(0);

  const row = await getButtonAt(request, 0);
  expect(row?.data?.actions?.map((a: any) => a.type)).toContain('discord.toggle-mute');
  const looks = row?.data?.looks ?? [];
  expect(looks.map((l: any) => l.cond)).toEqual(['discordMuted', 'discordMuted == falso']);
  expect(looks[0]).toMatchObject({ i: 'MicOff', c: 4, bg: 1 });
  expect(looks[1]).toMatchObject({ i: 'Mic', c: null, bg: 0 });

  // Y se ven en la pestaña Aspecto.
  await page.locator('[data-cy=bd-tab-appearance]').click();
  await expect(page.locator('.bd-rl')).toHaveCount(2, { timeout: 10000 });
});

test('icono propio + segunda acción con estados: diálogo y herencia del icono', async ({
  page,
  request,
}) => {
  // 1. Botón con una acción normal (ya hay acciones previas).
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

  // 2. Cambiar el icono del botón (Mic).
  await page.locator('[data-cy=bd-key-preview]').click();
  const iconDialog = page.locator('dialog.bd-dlg[open]');
  await expect(iconDialog).toBeVisible({ timeout: 5000 });
  await page.locator('#bd-iq').fill('mic');
  const micBtn = iconDialog.locator('button[aria-label="mic"]');
  await expect(micBtn).toBeVisible({ timeout: 10000 });
  await micBtn.click();
  await page.waitForResponse(
    (res: any) =>
      res.url().includes('/api/v1/buttons/') &&
      res.request().method() === 'PUT' &&
      (res.request().postData()?.includes('"icon":"Mic"') ?? false),
    { timeout: 15000 },
  );

  // 3. Añadir mute/unmute vía paleta → hay acciones previas: sale el diálogo.
  await page.locator('[data-cy=bd-tab-actions]').click();
  await page.locator('[data-cy=bd-add-action]').click();
  await expect(page.locator('dialog.bd-cmd[open]')).toBeVisible({ timeout: 5000 });
  await page.locator('#bd-cq').fill('Silenciar');
  const paletteItem = page
    .locator('[data-cy=bd-palette-item]', { hasText: 'Silenciar / reactivar micro' })
    .first();
  await expect(paletteItem).toBeVisible({ timeout: 10000 });

  const presetDialog = page.locator('dialog.bd-confirm[open]');
  await paletteItem.click();
  await expect(presetDialog).toBeVisible({ timeout: 10000 });
  // Sin condiciones previas no hay nada que reemplazar.
  await expect(presetDialog.locator('[data-cy=bd-preset-dlg-replace]')).toHaveCount(0);

  const putPromise = waitForLooksPut(page);
  await presetDialog.locator('[data-cy=bd-preset-dlg-add]').click();
  await putPromise;

  const row = await getButtonAt(request, 0);
  const looks = row?.data?.looks ?? [];
  expect(looks.map((l: any) => l.cond)).toEqual(['discordMuted', 'discordMuted == falso']);
  // El on trae el de la acción; el off hereda el icono del botón.
  expect(looks[0]).toMatchObject({ i: 'MicOff', c: 4, bg: 1 });
  expect(looks[1]).toMatchObject({ i: 'Mic', c: null, bg: 0 });
});
