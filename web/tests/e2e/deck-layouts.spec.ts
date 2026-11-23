import { test, expect } from '@playwright/test';
import { collapseLeftPanel, toggleFreeMode } from './helpers';

const API = 'http://localhost:3001/api/v1';

const LABEL_A = 'E2E Libre A';
const LABEL_B = 'E2E Libre B';

let testPageId = '';
let restorePageId = '';
let buttonAId = '';
let buttonBId = '';

async function seedButtons(request: any, pageId: string) {
  const resA = await request.post(`${API}/buttons`, {
    data: {
      page_id: pageId,
      position: 0,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      data: { label: LABEL_A, actions: [] },
    },
  });
  expect(resA.status()).toBe(201);
  const bodyA = await resA.json();
  buttonAId = bodyA.id;

  const resB = await request.post(`${API}/buttons`, {
    data: {
      page_id: pageId,
      position: 1,
      x: 1,
      y: 0,
      w: 1,
      h: 1,
      data: { label: LABEL_B, actions: [] },
    },
  });
  expect(resB.status()).toBe(201);
  const bodyB = await resB.json();
  buttonBId = bodyB.id;
}

test.beforeEach(async ({ page, request }) => {
  testPageId = '';
  restorePageId = '';
  buttonAId = '';
  buttonBId = '';
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
  if (testPageId) {
    await request.delete(`${API}/pages/${testPageId}`);
  }
  if (restorePageId) {
    await request.post(`${API}/settings`, {
      data: { key: 'current.page_id', value: restorePageId },
    });
  }
});

test('crea una página, activa Libre y conserva las teclas visibles al recargar', async ({
  page,
  request,
}) => {
  const createPagePromise = page.waitForResponse(
    (res) => res.url().includes('/api/v1/pages') && res.request().method() === 'POST',
  );
  await page.locator('[data-cy=bd-page-add]').click();
  const createPageRes = await createPagePromise;
  expect(createPageRes.status()).toBe(201);
  const created = await createPageRes.json();
  testPageId = created.id;

  await seedButtons(request, testPageId);

  await toggleFreeMode(page);
  const plate = page.locator('[data-cy=bd-gs-plate]');
  await expect(plate).toBeVisible({ timeout: 10000 });
  await expect(plate.locator('.grid-stack-item')).toHaveCount(2);
  await expect(plate.locator('[data-cy=bd-key]')).toHaveCount(2);
  await expect(plate.getByText(LABEL_A)).toBeVisible();
  await expect(plate.getByText(LABEL_B)).toBeVisible();

  await page.reload();
  await expect(page.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 30000 });
  // El boot tras reload es secuencial (perfiles → página → botones → plugins):
  // esperar a la chip activa prueba que terminó en la página del test.
  await expect(
    page.locator('.bd-page .bd-chip[aria-pressed="true"]').filter({ hasText: created.name }).first(),
  ).toBeVisible({ timeout: 30000 });
  const plateAfter = page.locator('[data-cy=bd-gs-plate]');
  await expect(plateAfter).toBeVisible({ timeout: 30000 });
  await expect(plateAfter.locator('.grid-stack-item')).toHaveCount(2);
  await expect(plateAfter.getByText(LABEL_A)).toBeVisible();
  await expect(plateAfter.getByText(LABEL_B)).toBeVisible();
});

test('permite crear y redimensionar la primera tecla desde una página vacía en Libre', async ({
  page,
  request,
}) => {
  const createPagePromise = page.waitForResponse(
    (res) => res.url().includes('/api/v1/pages') && res.request().method() === 'POST',
  );
  await page.locator('[data-cy=bd-page-add]').click();
  const createPageRes = await createPagePromise;
  expect(createPageRes.status()).toBe(201);
  const created = await createPageRes.json();
  testPageId = created.id;
  const pageName: string = created.name;

  // createPage programa también una selección diferida; espera a que termine
  // antes de seleccionar una tecla nueva.
  await expect(
    page.locator('.bd-page .bd-chip[aria-pressed="true"]').filter({ hasText: pageName }).first(),
  ).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(250);

  await collapseLeftPanel(page);
  await toggleFreeMode(page);
  const plate = page.locator('[data-cy=bd-gs-plate]');
  await expect(plate).toBeVisible({ timeout: 10000 });
  await expect(plate.locator('.grid-stack-item')).toHaveCount(0);
  // Un solo botón "Añadir tecla" en la barra (sin CTA de estado vacío).
  await expect(page.locator('[data-cy=bd-gs-add-tool]')).toBeVisible();

  const createBtnPromise = page.waitForResponse(
    (res) => res.url().includes('/api/v1/buttons') && res.request().method() === 'POST',
  );
  await page.locator('[data-cy=bd-gs-add-tool]').click();
  const createBtnRes = await createBtnPromise;
  expect(createBtnRes.status()).toBe(201);
  const createdBtn = await createBtnRes.json();
  buttonAId = createdBtn.id;
  expect(createdBtn.w, 'new free-mode key defaults to 1 wide').toBe(1);
  expect(createdBtn.h, 'new free-mode key defaults to 1 tall').toBe(1);
  expect(createdBtn.data?.icon, 'new key gets the default icon').toBeTruthy();

  // La tecla 1×1 recién creada no tapa al resto: el grid sigue estable.
  await expect(plate.locator('.grid-stack-item')).toHaveCount(1);
  const itemBox0 = await page.locator(`[data-gs-id="${buttonAId}"]`).boundingBox();
  expect(itemBox0, 'grid item has a box').not.toBeNull();
  expect(itemBox0!.width, '1x1 widget is not full-width').toBeLessThan(800);

  // Seleccionar la tecla para editar su título.
  await plate.locator(`[data-gs-id="${buttonAId}"] [data-cy=bd-key]`).click();
  // type char-by-char como Cypress: el inspector autogarda por debounce.
  await page.locator('[data-cy=bd-key-title]').pressSequentially('E2E Libre UI', { delay: 20 });
  await page.waitForTimeout(600);

  const handle = page.locator(`[data-gs-id="${buttonAId}"] .ui-resizable-se`);
  await expect(handle).toBeAttached({ timeout: 10000 });
  // La asa puede estar oculta hasta hover: forzarla visible para el drag.
  await handle.evaluate((el: HTMLElement) => {
    el.style.display = 'block';
  });

  const handleBox = await handle.boundingBox();
  const itemBox = await page.locator(`[data-gs-id="${buttonAId}"]`).boundingBox();
  expect(handleBox, 'resize handle has a box').not.toBeNull();
  expect(itemBox, 'grid item has a box').not.toBeNull();
  const x1 = handleBox!.x + handleBox!.width / 2;
  const y1 = handleBox!.y + handleBox!.height / 2;
  const x2 = x1 + itemBox!.width + 16;
  const y2 = y1 + itemBox!.height + 16;

  const resizePromise = page.waitForResponse(
    // Solo el PUT geométrico (x/y/w/h): el autosave del título también hace
    // PUT /buttons/:id y resolvería la espera antes del resize real.
    (res) => res.url().includes(`/api/v1/buttons/${buttonAId}`) && res.request().method() === 'PUT' &&
      (res.request().postData()?.includes('"w"') ?? false),
    { timeout: 15000 },
  );
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const x = x1 + ((x2 - x1) * i) / steps;
    const y = y1 + ((y2 - y1) * i) / steps;
    await page.mouse.move(x, y, { steps: 2 });
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await resizePromise;

  const buttonsRes = await request.get(`${API}/buttons?pageId=${testPageId}`);
  expect(buttonsRes.ok()).toBeTruthy();
  const buttons = await buttonsRes.json();
  const button = buttons.find((b: any) => b.id === buttonAId);
  expect(button?.w, 'first UI-created button grows in width').toBeGreaterThan(1);
  expect(button?.h, 'first UI-created button grows in height').toBeGreaterThan(1);

  await page.reload();
  await expect(page.locator('[data-cy=bd-gs-plate]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator(`[data-gs-id="${buttonAId}"]`)).not.toHaveAttribute('gs-w', '1');
  await expect(page.locator(`[data-gs-id="${buttonAId}"]`)).not.toHaveAttribute('gs-h', '1');
});

test('Añadir usa el hueco visible aunque haya positions stale por arrastres', async ({
  page,
  request,
}) => {
  const createPagePromise = page.waitForResponse(
    (res) => res.url().includes('/api/v1/pages') && res.request().method() === 'POST',
  );
  await page.locator('[data-cy=bd-page-add]').click();
  const createPageRes = await createPagePromise;
  expect(createPageRes.status()).toBe(201);
  const created = await createPageRes.json();
  testPageId = created.id;
  const pageName: string = created.name;

  await expect(
    page.locator('.bd-page .bd-chip[aria-pressed="true"]').filter({ hasText: pageName }).first(),
  ).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(250);

  // B ocupa la celda (1,0) pero conserva position 2 (stale: simula un arrastre
  // en Libre, que solo persiste x/y/w/h). La celda (2,0) queda visible y libre.
  for (const [pos, x, label] of [[0, 0, 'E2E Hueco A'], [2, 1, 'E2E Hueco B']] as const) {
    const res = await request.post(`${API}/buttons`, {
      data: { page_id: testPageId, position: pos, x, y: 0, w: 1, h: 1, data: { label, actions: [] } },
    });
    expect(res.status()).toBe(201);
  }

  await collapseLeftPanel(page);
  await toggleFreeMode(page);
  const plate = page.locator('[data-cy=bd-gs-plate]');
  await expect(plate).toBeVisible({ timeout: 10000 });
  await expect(plate.locator('.grid-stack-item')).toHaveCount(2);

  const createBtnPromise = page.waitForResponse(
    (res) => res.url().includes('/api/v1/buttons') && res.request().method() === 'POST',
  );
  await page.locator('[data-cy=bd-gs-add-tool]').click();
  const createBtnRes = await createBtnPromise;
  expect(createBtnRes.status()).toBe(201);
  const createdBtn = await createBtnRes.json();
  // Va al hueco visible (2,0) y NO debajo de la cuadrícula; la position no
  // colisiona con el slot 2 retenido por el widget movido (antes: 409 o y=3).
  expect(createdBtn.x, 'new key lands in the visible gap').toBe(2);
  expect(createdBtn.y, 'new key lands in the visible gap').toBe(0);
  expect(createdBtn.position, 'position stays unique (no 409)').toBe(3);

  await expect(plate.locator('.grid-stack-item')).toHaveCount(3);
});

test('cambiar filas/columnas redimensiona la rejilla y persiste al recargar', async ({
  page,
  request,
}) => {
  const createPagePromise = page.waitForResponse(
    (res) => res.url().includes('/api/v1/pages') && res.request().method() === 'POST',
  );
  await page.locator('[data-cy=bd-page-add]').click();
  const createPageRes = await createPagePromise;
  expect(createPageRes.status()).toBe(201);
  const created = await createPageRes.json();
  testPageId = created.id;
  const pageName: string = created.name;

  await expect(
    page.locator('.bd-page .bd-chip[aria-pressed="true"]').filter({ hasText: pageName }).first(),
  ).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(250);
  await collapseLeftPanel(page);

  const rowsOut = page.locator('[data-cy=bd-grid-rows] output');
  const colsOut = page.locator('[data-cy=bd-grid-cols] output');
  const rows0 = Number(await rowsOut.innerText());
  const cols0 = Number(await colsOut.innerText());
  await expect(page.locator('[data-swapy-container] [data-cy=bd-key]')).toHaveCount(cols0 * rows0);

  // +1 fila: PUT al perfil y la rejilla crece.
  const putPromise = page.waitForResponse(
    (res) => res.url().includes('/api/v1/profiles/') && res.request().method() === 'PUT',
    { timeout: 10000 },
  );
  await page.locator('[data-cy=bd-grid-rows] [data-d="r1"]').click();
  await putPromise;
  await expect(rowsOut).toHaveText(String(rows0 + 1), { timeout: 10000 });
  await expect(page.locator('[data-swapy-container] [data-cy=bd-key]')).toHaveCount(
    cols0 * (rows0 + 1),
  );

  // Persiste al recargar (viene del perfil, no del override local).
  await page.reload();
  await expect(page.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator('[data-cy=bd-grid-rows] output')).toHaveText(String(rows0 + 1), {
    timeout: 10000,
  });

  // Restaurar el tamaño original para no contaminar otros tests.
  const backPromise = page.waitForResponse(
    (res) => res.url().includes('/api/v1/profiles/') && res.request().method() === 'PUT',
    { timeout: 10000 },
  );
  await page.locator('[data-cy=bd-grid-rows] [data-d="r-1"]').click();
  await backPromise;
  await expect(page.locator('[data-cy=bd-grid-rows] output')).toHaveText(String(rows0), {
    timeout: 10000,
  });
});

test('permite separar dos teclas y conserva la separación al recargar', async ({
  page,
  request,
}) => {
  const createPagePromise = page.waitForResponse(
    (res) => res.url().includes('/api/v1/pages') && res.request().method() === 'POST',
  );
  await page.locator('[data-cy=bd-page-add]').click();
  const createPageRes = await createPagePromise;
  expect(createPageRes.status()).toBe(201);
  const created = await createPageRes.json();
  testPageId = created.id;
  const pageName: string = created.name;

  await expect(
    page.locator('.bd-page .bd-chip[aria-pressed="true"]').filter({ hasText: pageName }).first(),
  ).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(250);

  await collapseLeftPanel(page);
  await toggleFreeMode(page);
  const plate = page.locator('[data-cy=bd-gs-plate]');
  await expect(plate).toBeVisible({ timeout: 10000 });

  // Dos teclas 1×1 en celdas contiguas vía el botón Añadir.
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const post = page.waitForResponse(
      (res) => res.url().includes('/api/v1/buttons') && res.request().method() === 'POST',
    );
    await page.locator('[data-cy=bd-gs-add-tool]').click();
    const res = await post;
    expect(res.status()).toBe(201);
    ids.push((await res.json()).id);
  }
  const [idA, idB] = ids;
  await expect(plate.locator('.grid-stack-item')).toHaveCount(2);

  // Arrastra B a la derecha con el asa: en flotación libre debe quedarse
  // separada (con "gravedad" se juntaban solas).
  const handle = plate.locator(`[data-gs-id="${idB}"] [data-cy=bd-gs-drag-handle]`);
  await handle.hover();
  const itemBox = await plate.locator(`[data-gs-id="${idB}"]`).boundingBox();
  expect(itemBox, 'grid item has a box').not.toBeNull();
  const hb = await handle.boundingBox();
  expect(hb, 'drag handle has a box').not.toBeNull();

  const putPromise = page.waitForResponse(
    // Solo el PUT geométrico del drag (ver comentario del test anterior).
    (res) => res.url().includes('/api/v1/buttons/') && res.request().method() === 'PUT' &&
      (res.request().postData()?.includes('"x"') ?? false),
    { timeout: 15000 },
  );
  await page.mouse.move(hb!.x + hb!.width / 2, hb!.y + hb!.height / 2);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      hb!.x + hb!.width / 2 + ((itemBox!.width * 2.5 * i) / steps),
      hb!.y + hb!.height / 2,
      { steps: 2 },
    );
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await putPromise;

  const buttonsRes = await request.get(`${API}/buttons?pageId=${testPageId}`);
  expect(buttonsRes.ok()).toBeTruthy();
  const list = await buttonsRes.json();
  const btnA = list.find((b: any) => b.id === idA);
  const btnB = list.find((b: any) => b.id === idB);
  expect(btnB?.x ?? 0, 'dragged key stays separated').toBeGreaterThan((btnA?.x ?? 0) + 1);

  await page.reload();
  await expect(page.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 30000 });
  await expect(
    page.locator('.bd-page .bd-chip[aria-pressed="true"]').filter({ hasText: pageName }).first(),
  ).toBeVisible({ timeout: 30000 });
  await expect(page.locator('[data-cy=bd-gs-plate]')).toBeVisible({ timeout: 30000 });
  await expect(page.locator(`[data-gs-id="${idA}"]`)).toBeVisible({ timeout: 30000 });
  await expect(page.locator(`[data-gs-id="${idB}"]`)).toBeVisible({ timeout: 30000 });
  const boxA = await page.locator(`[data-gs-id="${idA}"]`).boundingBox();
  const boxB = await page.locator(`[data-gs-id="${idB}"]`).boundingBox();
  expect(boxA).not.toBeNull();
  expect(boxB).not.toBeNull();
  const overlapX = Math.max(
    0,
    Math.min(boxA!.x + boxA!.width, boxB!.x + boxB!.width) - Math.max(boxA!.x, boxB!.x),
  );
  const overlapY = Math.max(
    0,
    Math.min(boxA!.y + boxA!.height, boxB!.y + boxB!.height) - Math.max(boxA!.y, boxB!.y),
  );
  expect(overlapX === 0 || overlapY === 0, 'separated keys do not overlap').toBe(true);
});
