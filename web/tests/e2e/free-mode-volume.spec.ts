import { test, expect } from '@playwright/test';
import { collapseLeftPanel, toggleFreeMode } from './helpers';

const API = 'http://localhost:3001/api/v1';

let testPageId = '';
const createdButtonIds: string[] = [];

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

async function gotoFreePage(page: any) {
  await createTestPage(page);
  await toggleFreeMode(page);
  const plate = page.locator('[data-cy=bd-gs-plate]');
  await expect(plate).toBeVisible({ timeout: 10000 });
  return plate;
}

async function addVolumeControl(page: any) {
  await page.locator('#bd-q').fill('volumen');
  const item = page.locator('[data-cy=bd-action-item]', { hasText: 'Control de volumen' });
  await expect(item).toBeVisible({ timeout: 10000 });
  const postPromise = page.waitForResponse(
    (res: any) => res.url().includes('/api/v1/buttons') && res.request().method() === 'POST',
    { timeout: 15000 },
  );
  // Sin tecla seleccionada: en modo libre el clic crea la tecla con el control.
  await item.click();
  const postRes = await postPromise;
  expect(postRes.status()).toBe(201);
  const created = await postRes.json();
  createdButtonIds.push(created.id);
  expect(created?.data?.actions?.[0]?.type, 'la tecla trae el control de volumen').toBe(
    'audio-mixer.volume-control',
  );
  return created;
}

const volWidget = (page: any) =>
  page.locator('.grid-stack-item', { has: page.locator('[data-cy=bd-key-vol]') });

test.beforeEach(async ({ page, request }) => {
  testPageId = '';
  createdButtonIds.length = 0;
  await page.goto('/');
  // En contextos frescos aparece el diálogo de bienvenida (modal nativo):
  // cerrarlo o bloquea todos los clics de la prueba.
  try {
    await page.evaluate(() => {
      try { window.localStorage.setItem('bundeck:welcome-seen', '1'); } catch { /* noop */ }
      const d = document.querySelector('[data-cy=bd-welcome]') as any;
      try { if (d && d.open) d.close(); } catch { /* noop */ }
    });
  } catch { /* ya cerrado o no toca */ }
  try {
    const skip = page.locator('[data-cy=bd-welcome-skip]');
    await skip.waitFor({ state: 'visible', timeout: 1500 });
    await skip.click();
  } catch { /* ya cerrado o no toca */ }
  await expect(page.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator('[data-cy=bd-layout-gridstack]')).toBeEnabled();
});

test.afterEach(async ({ request }) => {
  for (const id of createdButtonIds) {
    await request.delete(`${API}/buttons/${id}`, { failOnStatusCode: false });
  }
  if (testPageId) {
    await request.delete(`${API}/pages/${testPageId}`, { failOnStatusCode: false });
  }
});

test('pulsar Control de volumen sin selección crea la tecla con el control', async ({
  page,
}) => {
  await gotoFreePage(page);
  await addVolumeControl(page);

  await expect(page.locator('[data-cy=bd-key-vol]')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('[data-cy=vol-pct]').first()).toBeVisible();
  await expect(page.locator('[data-cy=bd-gs-plate] .grid-stack-item')).toHaveCount(1);
});

test('mover y redimensionar persisten por gesto sin tocar al resto', async ({
  page,
  request,
}) => {
  const plate = await gotoFreePage(page);

  // Tecla estática de referencia en (4,0): no debe moverse nunca.
  const seedRes = await request.post(`${API}/buttons`, {
    data: {
      page_id: testPageId, position: 20, x: 4, y: 0, w: 1, h: 1,
      data: { label: 'E2E Fija', actions: [] },
    },
  });
  expect(seedRes.status()).toBe(201);
  const seed = await seedRes.json();
  createdButtonIds.push(seed.id);
  await expect(plate.locator('.grid-stack-item')).toHaveCount(1);
  await addVolumeControl(page);
  await expect(plate.locator('.grid-stack-item')).toHaveCount(2);

  // Plegar la biblioteca para que no tape la placa durante los drags.
  await collapseLeftPanel(page);

  const widget = volWidget(page);
  await expect(widget).toBeVisible({ timeout: 10000 });

  // Mover +1 columna con el asa (gesto real de ratón).
  const moveHandle = widget.locator('[data-cy=bd-gs-drag-handle]');
  await moveHandle.hover();
  const moveBox = await moveHandle.boundingBox();
  expect(moveBox, 'asa de mover medible').not.toBeNull();
  const putMove = page.waitForResponse(
    (res: any) =>
      res.url().includes('/api/v1/buttons/') &&
      res.request().method() === 'PUT',
    { timeout: 15000 },
  );
  await page.mouse.move(moveBox!.x + moveBox!.width / 2, moveBox!.y + moveBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(moveBox!.x + moveBox!.width / 2 + 80, moveBox!.y + moveBox!.height / 2, { steps: 12 });
  await page.mouse.up();
  const moveRes = await putMove;
  expect(moveRes.status()).toBe(200);
  const movedBody = await moveRes.json();
  expect(movedBody.x, 'mover persiste la columna').toBe(1);
  expect(movedBody.y, 'mover conserva la fila').toBe(0);

  // Redimensionar a lo ancho con el tirador SE: aparece el slider horizontal.
  const se = widget.locator('.ui-resizable-se');
  await widget.hover();
  const seBox = await se.boundingBox();
  expect(seBox, 'tirador SE medible').not.toBeNull();
  const putResize = page.waitForResponse(
    (res: any) => res.url().includes('/api/v1/buttons/') && res.request().method() === 'PUT',
    { timeout: 15000 },
  );
  await page.mouse.move(seBox!.x + seBox!.width / 2, seBox!.y + seBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(seBox!.x + seBox!.width / 2 + 60, seBox!.y + seBox!.height / 2, { steps: 12 });
  await page.mouse.up();
  const resizeRes = await putResize;
  expect(resizeRes.status()).toBe(200);
  expect((await resizeRes.json()).w, 'resize persiste el ancho').toBe(2);
  await expect(page.locator('[data-cy=vol-slider-h]')).toBeVisible({ timeout: 10000 });

  // La referencia sigue intacta en la BD.
  const fresh = await request.get(`${API}/buttons?pageId=${testPageId}`);
  const rows = (await fresh.json()) as any[];
  const refRow = rows.find((b) => b.id === seed.id);
  expect(refRow, 'la tecla de referencia existe').toBeTruthy();
  expect({ x: refRow.x, y: refRow.y, w: refRow.w, h: refRow.h }).toEqual({ x: 4, y: 0, w: 1, h: 1 });
});

test('el slider por teclado cambia el nivel (modo seguro: sin tocar el sistema)', async ({
  page,
}) => {
  await gotoFreePage(page);
  await addVolumeControl(page);

  const arc = page.locator('[data-cy=vol-arc-slider]');
  await expect(arc).toBeVisible({ timeout: 10000 });
  const pct0 = Number((await page.locator('[data-cy=vol-pct]').first().innerText()).replace('%', ''));

  const execPromise = page.waitForResponse(
    (res: any) => res.url().includes('/api/v1/actions/execute') && res.request().method() === 'POST',
    { timeout: 15000 },
  );
  await arc.click();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-cy=vol-pct]').first()).toHaveText(`${pct0 + 1}%`, { timeout: 10000 });
  const execRes = await execPromise;
  expect(execRes.status()).toBe(200);

  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('[data-cy=vol-pct]').first()).toHaveText(`${pct0}%`, { timeout: 10000 });
});

test('re-montar la placa no emite PUTs: la geometría guardada no se reescribe', async ({
  page,
  request,
}) => {
  const plate = await gotoFreePage(page);
  // Dos teclas con geometría conocida (una fuera del rango visible a
  // propósito: el desborde histórico se conserva, no se reescribe).
  for (const [i, g] of [
    { x: 0, y: 0, w: 1, h: 1 },
    { x: 1, y: 4, w: 2, h: 1 },
  ].entries()) {
    const r = await request.post(`${API}/buttons`, {
      data: { page_id: testPageId, position: 30 + i, ...g, data: { label: `E2E G${i}`, actions: [] } },
    });
    expect(r.status()).toBe(201);
    createdButtonIds.push((await r.json()).id);
  }
  await expect(plate.locator('.grid-stack-item')).toHaveCount(2);

  let puts = 0;
  page.on('request', (req: any) => {
    if (/\/api\/v1\/buttons\/[^/]+$/.test(req.url()) && req.method() === 'PUT') puts += 1;
  });
  // Re-montar GridStack (destruir + adoptar de nuevo) sin gesto: antes cada
  // montaje emitía 'change' y reescribía la geometría (teletransportes por
  // el clamp, solapes "resueltos", fantasmas `<id>_1` con PUTs 500).
  await page.locator('[data-cy=bd-layout-classic]').click();
  await expect(page.locator('[data-swapy-container]')).toBeVisible({ timeout: 10000 });
  await page.locator('[data-cy=bd-layout-gridstack]').click();
  await expect(page.locator('[data-cy=bd-gs-plate]')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('[data-cy=bd-gs-plate] .grid-stack-item')).toHaveCount(2);
  await page.waitForTimeout(2500);
  expect(puts, 're-montar no persiste nada').toBe(0);

  // Y la geometría sigue intacta en la BD.
  const fresh = await request.get(`${API}/buttons?pageId=${testPageId}`);
  const rows = (await fresh.json()) as any[];
  const byLabel = new Map(rows.map((b: any) => [b?.data?.label, b]));
  expect({ x: byLabel.get('E2E G0')?.x, y: byLabel.get('E2E G0')?.y }).toEqual({ x: 0, y: 0 });
  expect({ x: byLabel.get('E2E G1')?.x, y: byLabel.get('E2E G1')?.y }).toEqual({ x: 1, y: 4 });
});
