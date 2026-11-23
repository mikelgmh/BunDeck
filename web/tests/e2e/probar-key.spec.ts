import { test, expect } from '@playwright/test';

const API = 'http://localhost:3001/api/v1';
const PROBE_TEXT = 'E2E PROBE FIRED';

let testPageId = '';
let restorePageId = '';

test.beforeEach(async ({ page, request }) => {
  testPageId = '';
  await page.goto('/');
  await expect(page.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 30000 });
  const cur = await request.get(`${API}/settings?key=current.page_id`);
  if (cur.ok()) restorePageId = (await cur.json()).value ?? '';

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
  await request.post(`${API}/settings`, { data: { key: 'current.page_id', value: testPageId } });
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

test('Probar ejecuta la tecla y muestra su efecto', async ({ page }) => {
  // Seleccionar tecla vacía y añadirle un toast vía la biblioteca.
  await page.locator('[data-swapy-slot="slot-0"] [data-cy=bd-key]').click();
  await expect(page.locator('[data-cy=bd-key-title]')).toBeVisible({ timeout: 5000 });
  // Añadir "Mostrar mensaje": esperar al filtrado con debounce antes de clicar
  // (si no, se coge la primera acción sin filtrar).
  await page.locator('#bd-q').fill('toast');
  const toastItem = page.locator('[data-cy=bd-action-item]', { hasText: 'Mostrar mensaje' }).first();
  await expect(toastItem).toBeVisible({ timeout: 10000 });
  const createPromise = page.waitForResponse(
    (res: any) => res.url().includes('/api/v1/buttons') && res.request().method() === 'POST'
  );
  await toastItem.click();
  const created = await createPromise;
  expect(created.status()).toBe(201);

  // Texto del toast.
  await page.locator('.bd-ac input[type="text"]').first().fill(PROBE_TEXT);
  // Esperar al autosave para que Probar ejecute lo último.
  await page.waitForResponse(
    (res) => res.url().includes('/api/v1/buttons/') && res.request().method() === 'PUT',
    { timeout: 15000 },
  );

  // Probar: ejecuta la tecla y el toast aparece.
  await expect(page.locator('[data-cy=bd-test-key]')).toBeEnabled({ timeout: 5000 });
  await page.locator('[data-cy=bd-test-key]').click();
  await expect(page.locator('.bd-toast', { hasText: PROBE_TEXT })).toBeVisible({ timeout: 10000 });
});
