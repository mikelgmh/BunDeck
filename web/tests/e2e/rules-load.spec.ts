import { test, expect } from '@playwright/test';
import { setCurrentPage } from './helpers';

const API = 'http://localhost:3001/api/v1';
const TOAST_TEXT = 'E2E LOAD FIRED';

let testPageId = '';
let restorePageId = '';

test.beforeEach(async ({ page, request }) => {
  testPageId = '';
  await page.goto('/');
  await expect(page.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 30000 });

  // Crear la página de test por UI (queda auto-seleccionada).
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
  await page.waitForTimeout(250);

  // Fijar la página actual para que la recarga vuelva aquí.
  await setCurrentPage(request, testPageId);
  const cur = await request.get(`${API}/settings?key=current.page_id`);
  if (cur.ok()) restorePageId = (await cur.json()).value ?? '';
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

test('regla load con toast persiste y se ejecuta al abrir la página', async ({ page, request }) => {
  // Seleccionar tecla vacía y crearla añadiendo una acción (sin tecla no
  // hay pestañas en el inspector).
  await page.locator('[data-swapy-slot="slot-0"] [data-cy=bd-key]').click();
  await expect(page.locator('[data-cy=bd-key-title]')).toBeVisible({ timeout: 5000 });
  await page.locator('#bd-q').fill('Delay');
  const createPromise = page.waitForResponse(
    (res) => res.url().includes('/api/v1/buttons') && res.request().method() === 'POST',
  );
  await page.locator('[data-cy=bd-action-item]').first().click();
  await createPromise;

  await page.locator('[data-cy=bd-tab-rules]').click();
  await page.locator('[data-cy=bd-add-rule]').click();

  // when = load.
  await page.locator('#bd-rw-0').selectOption('load');

  // Añadir "Mostrar mensaje" al then vía paleta.
  await page.getByRole('button', { name: 'Añadir acción' }).first().click();
  await expect(page.locator('dialog.bd-cmd[open]')).toBeVisible({ timeout: 5000 });
  await page.locator('#bd-cq').fill('toast');
  await page.locator('[data-cy=bd-palette-item]').first().click();

  // Texto del toast.
  await page.locator('.bd-ac input[type="text"]').first().fill(TOAST_TEXT);

  // El autosave persiste la regla (PUT con rules).
  const putPromise = page.waitForResponse(
    (res) =>
      res.url().includes('/api/v1/buttons/') &&
      res.request().method() === 'PUT' &&
      (res.request().postData()?.includes('"rules"') ?? false),
    { timeout: 15000 },
  );
  await putPromise;
  const saved = await request.get(`${API}/buttons?pageId=${testPageId}`);
  expect(saved.ok()).toBeTruthy();
  const row = (await saved.json()).find((b: any) => b.position === 0);
  expect(row?.data?.rules?.[0]?.when).toBe('load');
  expect(row?.data?.rules?.[0]?.then?.[0]?.type).toContain('toast');

  // Al recargar, la regla load se ejecuta: aparece el toast.
  await page.reload();
  await expect(page.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.bd-toast', { hasText: TOAST_TEXT })).toBeVisible({ timeout: 15000 });
});
