import { test, expect } from '@playwright/test';
import { collapseLeftPanel, toggleFreeMode, dragSlotToSlot } from './helpers';

const API = 'http://localhost:3001/api/v1';

const LABEL_A = 'E2E Toggle A';
const LABEL_B = 'E2E Toggle B';

let testPageId = '';
let restorePageId = '';
const createdButtonIds: string[] = [];

async function seedButton(request: any, pageId: string, position: number, label: string, extra: any = {}) {
  const res = await request.post(`${API}/buttons`, {
    data: { page_id: pageId, position, data: { label, actions: [] }, ...extra },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  createdButtonIds.push(body.id);
  return body;
}

test.beforeEach(async ({ page, request }) => {
  testPageId = '';
  restorePageId = '';
  createdButtonIds.length = 0;
  await page.goto('/');
  await expect(page.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 30000 });

  const activePageName = (
    await page.locator('.bd-page .bd-chip[aria-pressed="true"]').first().innerText({ timeout: 30000 })
  ).trim();
  const activeProfileName = (
    await page.locator('[data-cy=bd-profile-tab][aria-selected="true"]').first().innerText()
  ).trim();

  const profilesRes = await request.get(`${API}/profiles`);
  expect(profilesRes.ok()).toBeTruthy();
  const profiles = await profilesRes.json();
  const profile = profiles.find((p: any) => p.name === activeProfileName);
  expect(profile, 'active profile exists in API').toBeTruthy();

  const pagesRes = await request.get(`${API}/pages?profileId=${profile.id}`);
  expect(pagesRes.ok()).toBeTruthy();
  const pages = await pagesRes.json();
  const activePage = pages.find((p: any) => p.name === activePageName);
  expect(activePage, 'active page exists in API').toBeTruthy();
  restorePageId = activePage.id;

  await expect(page.locator('[data-cy=bd-layout-gridstack]')).toBeEnabled();
});

test.afterEach(async ({ request }) => {
  for (const id of createdButtonIds) {
    await request.delete(`${API}/buttons/${id}`, { failOnStatusCode: false });
  }
  if (testPageId) {
    await request.delete(`${API}/pages/${testPageId}`);
  }
  if (restorePageId) {
    await request.post(`${API}/settings`, {
      data: { key: 'current.page_id', value: restorePageId },
    });
  }
});

async function createTestPage(page: any) {
  const createPagePromise = page.waitForResponse(
    (res: any) => res.url().includes('/api/v1/pages') && res.request().method() === 'POST',
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
  return created;
}

async function gridSize(page: any) {
  const cols = Number(await page.locator('[data-cy=bd-grid-cols] output').innerText());
  const rows = Number(await page.locator('[data-cy=bd-grid-rows] output').innerText());
  return { cols, rows };
}

test('crear tecla con acción conserva el icono por defecto tras el autosave', async ({
  page,
  request,
}) => {
  await createTestPage(page);

  // Click en tecla vacía (slot 0) y añadir Delay desde la biblioteca.
  await page.locator('[data-swapy-slot="slot-0"] [data-cy=bd-key]').click();
  await page.locator('#bd-q').fill('Delay');
  const postPromise = page.waitForResponse(
    (res: any) => res.url().includes('/api/v1/buttons') && res.request().method() === 'POST',
    { timeout: 10000 },
  );
  await page.locator('[data-cy=bd-action-item]').first().click();
  const postRes = await postPromise;
  expect(postRes.status()).toBe(201);
  const created = await postRes.json();
  createdButtonIds.push(created.id);
  expect(created?.data?.icon, 'la tecla creada trae icono por defecto').toBeTruthy();

  // El autosave posterior (800 ms) no debe borrarlo.
  await page.waitForTimeout(2000);
  const fresh = await request.get(`${API}/buttons?pageId=${testPageId}`);
  expect(fresh.ok()).toBeTruthy();
  const row = ((await fresh.json()) as any[]).find((b: any) => b.id === created.id);
  expect(row?.data?.icon, 'el icono sobrevive al autosave').toBe(created.data.icon);
});

test('Fija -> Libre persiste sin revertir y respeta las filas configuradas', async ({
  page,
  request,
}) => {
  await createTestPage(page);
  await seedButton(request, testPageId, 0, LABEL_A, { x: 0, y: 0, w: 1, h: 1 });
  await seedButton(request, testPageId, 1, LABEL_B, { x: 1, y: 0, w: 1, h: 1 });

  await collapseLeftPanel(page);
  await toggleFreeMode(page);

  const plate = page.locator('[data-cy=bd-gs-plate]');
  await expect(plate).toBeVisible({ timeout: 10000 });
  await expect(plate.locator('.grid-stack-item')).toHaveCount(2);

  // Sin flash-revert: tras asentarse sigue en Libre y la clásica no vuelve.
  await page.waitForTimeout(1500);
  await expect(plate).toBeVisible();
  await expect(page.locator('[data-swapy-container]')).toHaveCount(0);

  // Las filas pintadas no superan las configuradas (+1 de cortesía por la
  // extensión de "Añadir" con el grid lleno): nada de "tropecientas filas".
  const { cols, rows } = await gridSize(page);
  const box = await plate.boundingBox();
  expect(box, 'gs plate has a box').not.toBeNull();
  const rowH = box!.width / cols;
  expect(box!.height, `plate height bounded by ${rows} configured rows`).toBeLessThan(
    (rows + 1) * rowH + 120,
  );

  // Persiste al recargar (el modo viene del servidor, no del override).
  await page.reload();
  await expect(page.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 30000 });
  const plateAfter = page.locator('[data-cy=bd-gs-plate]');
  await expect(plateAfter).toBeVisible({ timeout: 30000 });
  await expect(plateAfter.locator('.grid-stack-item')).toHaveCount(2);
});

test('una tecla legacy con position fuera del grid no estira la placa', async ({
  page,
  request,
}) => {
  await createTestPage(page);
  await seedButton(request, testPageId, 0, LABEL_A, { x: 0, y: 0, w: 1, h: 1 });
  // Tecla clásica sin geometría y con position más allá del grid (el caso
  // real: position 99 en 5×3 derivaba y=19 y la placa salía de 20 filas).
  await seedButton(request, testPageId, 99, 'E2E Legacy 99');

  await collapseLeftPanel(page);
  await toggleFreeMode(page);
  const plate = page.locator('[data-cy=bd-gs-plate]');
  await expect(plate).toBeVisible({ timeout: 10000 });
  await expect(plate.locator('.grid-stack-item')).toHaveCount(2);

  const { cols, rows } = await gridSize(page);
  const box = await plate.boundingBox();
  expect(box, 'gs plate has a box').not.toBeNull();
  const rowH = box!.width / cols;
  expect(box!.height, 'legacy out-of-grid key stays wrapped').toBeLessThan(
    (rows + 1) * rowH + 120,
  );
  const stale = plate.locator('.grid-stack-item', { hasText: 'E2E Legacy 99' });
  await expect(stale).toBeVisible();
  const gsY = Number(await stale.getAttribute('gs-y'));
  expect(gsY, 'legacy key wrapped into configured rows').toBeLessThan(rows);
});

test('cancelar el aviso mantiene la página en Fija sin llamar al daemon', async ({ page, request }) => {
  const created = await createTestPage(page);
  await collapseLeftPanel(page);

  // Pre-asignar el deck a la página para que el aviso salga siempre
  // (sin depender del auto-repair de asignaciones).
  const profilesRes = await request.get(`${API}/profiles`);
  const profiles = await profilesRes.json();
  const profile = profiles[0];
  await request.put(`${API}/profiles/${profile.id}/assignments`, {
    data: { assignments: { 'dev-deck-mk2': testPageId } },
  });
  // Recargar para que la UI lea la asignación (esperar al GET, no solo a los
  // chips: sin esto el toggle puede correr antes de que lleguen las
  // asignaciones y el aviso no sale).
  const asgPromise = page.waitForResponse(
    (res: any) => res.url().includes('/assignments') && res.request().method() === 'GET',
    { timeout: 15000 },
  );
  await page.reload();
  await asgPromise;
  await expect(page.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 30000 });
  await expect(
    page.locator('.bd-page .bd-chip[aria-pressed="true"]').filter({ hasText: created.name }).first(),
  ).toBeVisible({ timeout: 10000 });

  let putSeen = false;
  page.on('request', (req: any) => {
    if (req.url().includes('/api/v1/pages/') && req.method() === 'PUT') putSeen = true;
  });

  await page.locator('[data-cy=bd-layout-gridstack]').click();
  const dialog = page.locator('dialog.bd-confirm[open]');
  await expect(dialog).toBeVisible({ timeout: 5000 });
  await dialog.locator('.bd-confirm-actions .bd-btn:not(.bd-pri)').click();

  // Sin PUT y sin placa libre: el aviso cumplió su función.
  await page.waitForTimeout(1000);
  expect(putSeen).toBe(false);
  await expect(page.locator('[data-swapy-container]')).toBeVisible();
  await expect(page.locator('[data-cy=bd-gs-plate]')).toHaveCount(0);
});

test('Libre -> Fija persiste y el drag clásico sigue vivo', async ({ page, request }) => {  await createTestPage(page);
  await seedButton(request, testPageId, 0, LABEL_A, { x: 0, y: 0, w: 1, h: 1 });
  await seedButton(request, testPageId, 1, LABEL_B, { x: 1, y: 0, w: 1, h: 1 });

  await collapseLeftPanel(page);
  await toggleFreeMode(page);
  await expect(page.locator('[data-cy=bd-gs-plate]')).toBeVisible({ timeout: 10000 });

  // Vuelta a Fija: PUT clásico + rejilla clásica persistente tras recargar.
  const putClassic = page.waitForResponse(
    (res: any) =>
      res.url().includes('/api/v1/pages/') &&
      res.request().method() === 'PUT' &&
      (res.request().postData()?.includes('classic') ?? false),
    { timeout: 15000 },
  );
  await page.locator('[data-cy=bd-layout-classic]').click();
  await putClassic;
  const classicPlate = page.locator('[data-swapy-container]');
  await expect(classicPlate).toBeVisible({ timeout: 10000 });
  await expect(classicPlate.locator('[data-cy=bd-key]')).toHaveCount(15);
  await expect(page.locator('[data-cy=bd-gs-plate]')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator('[data-swapy-container]')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('[data-cy=bd-gs-plate]')).toHaveCount(0);

  // El drag clásico funciona tras el round-trip (Swapy re-vinculado): antes
  // quedaba atado al DOM desmontado y el tablero se "bloqueaba".
  // dragSlotToSlot espera a la re-vinculación post-carga (ver helpers).
  const { reordered } = await dragSlotToSlot(page, 0, 1);
  expect(reordered, 'swap tras round-trip persiste (POST /buttons/reorder)').toBe(true);
  await expect(page.locator('[data-swapy-slot="slot-1"]')).toContainText(LABEL_A, {
    timeout: 10000,
  });
});
