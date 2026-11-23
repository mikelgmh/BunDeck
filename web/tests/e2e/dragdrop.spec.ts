import { test, expect, type APIRequestContext, type PlaywrightTestArgs } from '@playwright/test';
import { collapseLeftPanel } from './helpers';

const API = 'http://localhost:3001/api/v1';
const LABEL_A = 'E2E-DRAG-A';
const LABEL_B = 'E2E-DRAG-B';

let pageId = '';
let posA = -1;
let posB = -1;
const createdIds: string[] = [];

async function apiContext(playwright: PlaywrightTestArgs['playwright']): Promise<APIRequestContext> {
  return playwright.request.newContext();
}

test.beforeAll(async ({ playwright }) => {
  const api = await apiContext(playwright);
  try {
    const profilesRes = await api.get(`${API}/profiles`);
    expect(profilesRes.ok()).toBeTruthy();
    const profiles = await profilesRes.json();
    const profile = profiles[0];
    let gridCols = 5;
    let gridRows = 3;
    try {
      const data = typeof profile.data === 'string' ? JSON.parse(profile.data) : profile.data;
      if (data?.gridCols) gridCols = data.gridCols;
      if (data?.gridRows) gridRows = data.gridRows;
    } catch {
      /* defaults */
    }
    const total = gridCols * gridRows;

    const pagesRes = await api.get(`${API}/pages?profileId=${profile.id}`);
    expect(pagesRes.ok()).toBeTruthy();
    const pages = await pagesRes.json();
    const page = pages.find((p: any) => p.is_folder === 0) ?? pages[0];
    pageId = page.id;

    // Fijar la página actual para que la app la cargue al visitar
    await api.post(`${API}/settings`, { data: { key: 'current.page_id', value: pageId } });

    const buttonsRes = await api.get(`${API}/buttons?pageId=${pageId}`);
    expect(buttonsRes.ok()).toBeTruthy();
    const buttons = await buttonsRes.json();
    const taken = new Set(buttons.map((b: any) => b.position));
    const free: number[] = [];
    for (let i = 0; i < total && free.length < 2; i++) {
      if (!taken.has(i)) free.push(i);
    }
    expect(free, 'need two free slots in the grid').toHaveLength(2);
    posA = free[0];
    posB = free[1];

    const mk = async (position: number, label: string, actions: any[]) => {
      const res = await api.post(`${API}/buttons`, {
        data: {
          page_id: pageId,
          position,
          data: { label, actions, backgroundColor: '#374151', textColor: '#f1f5f9' },
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      createdIds.push(body.id);
    };

    await mk(posA, LABEL_A, [
      { id: 'e2e-a1', type: 'shell.shell', pluginId: 'shell', parameters: { command: 'echo a' } },
    ]);
    await mk(posB, LABEL_B, [
      { id: 'e2e-b1', type: 'http.http', pluginId: 'http', parameters: { url: 'http://localhost/', method: 'GET' } },
    ]);
  } finally {
    await api.dispose();
  }
});

test.afterAll(async ({ playwright }) => {
  const api = await apiContext(playwright);
  try {
    for (const id of createdIds) {
      await api.delete(`${API}/buttons/${id}`);
    }
  } finally {
    await api.dispose();
  }
});

test('drags a button to another slot: optimistic immediately, persisted after reload', async ({
  page,
}) => {
  const reorderPromise = page.waitForResponse(
    (res) => res.url().includes('/api/v1/buttons/reorder') && res.request().method() === 'POST',
    { timeout: 10000 },
  );

  await page.goto('/');
  await expect(page.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 15000 });
  await collapseLeftPanel(page);
  await expect(page.getByText(LABEL_A).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(LABEL_B).first()).toBeVisible();

  const src = page.locator(`[data-swapy-slot="slot-${posA}"] [data-swapy-item]`);
  const tgt = page.locator(`[data-swapy-slot="slot-${posB}"]`);
  await expect(src).toBeVisible();
  await expect(tgt).toBeVisible();

  const srcBox = await src.boundingBox();
  const tgtBox = await tgt.boundingBox();
  expect(srcBox, 'drag source item has a box').not.toBeNull();
  expect(tgtBox, 'drag target slot has a box').not.toBeNull();
  const x1 = srcBox!.x + srcBox!.width / 2;
  const y1 = srcBox!.y + srcBox!.height / 2;
  const x2 = tgtBox!.x + tgtBox!.width / 2;
  const y2 = tgtBox!.y + tgtBox!.height / 2;

  // Gesto con mouse real (lo que Swapy escucha: pointerdown en el item,
  // movimientos con frames intermedios y pointerup en destino).
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
  await page.waitForTimeout(50);

  // UI optimista: SIN recargar, A ya está en el slot de B y viceversa.
  // Además el swap disparó la persistencia (POST /buttons/reorder).
  const reorderRes = await reorderPromise;
  // Como en Cypress: verificar el body del REQUEST (order), no la respuesta.
  const reorderReq = reorderRes.request().postDataJSON() as any;
  const order = reorderReq?.order ?? [];
  expect(order).toEqual(expect.arrayContaining([{ id: createdIds[0], position: posB }]));

  await expect(page.locator(`[data-swapy-slot="slot-${posB}"]`), 'A moved to B slot').toContainText(
    LABEL_A,
    { timeout: 10000 },
  );
  await expect(page.locator(`[data-swapy-slot="slot-${posA}"]`), 'B moved to A slot').toContainText(
    LABEL_B,
  );

  // Persistido en BD: tras recargar sigue igual (no "vuelve donde estaba")
  await page.reload();
  await expect(page.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(`[data-swapy-slot="slot-${posB}"]`)).toContainText(LABEL_A, {
    timeout: 10000,
  });
  await expect(page.locator(`[data-swapy-slot="slot-${posA}"]`)).toContainText(LABEL_B);
});
