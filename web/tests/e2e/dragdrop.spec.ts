import { test, expect, type APIRequestContext, type PlaywrightTestArgs } from '@playwright/test';
import { collapseLeftPanel, dragSlotToSlot } from './helpers';

const API = 'http://localhost:3001/api/v1';
const LABEL_A = 'E2E-DRAG-A';
const LABEL_B = 'E2E-DRAG-B';

let pageId = '';
let restorePageId = '';
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
    // Perfil dedicado de la suite: nunca tocar un perfil del usuario
    // (antes se usaba profiles[0], que podía ser cualquiera).
    const profile = (profiles as any[]).find((p) => p?.name === 'E2E Runner');
    expect(profile?.id, 'perfil "E2E Runner" creado por global-setup').toBeTruthy();

    // Página propia (no depende del modo de la primera página del perfil:
    // si es libre no hay slots swapy y el drag clásico no aplica).
    const curRes = await api.get(`${API}/settings?key=current.page_id`);
    if (curRes.ok()) restorePageId = (await curRes.json()).value ?? '';

    const pageRes = await api.post(`${API}/pages`, {
      data: { profile_id: profile.id, name: 'E2E Drag Page', order_idx: 999, data: {} },
    });
    expect(pageRes.status()).toBe(201);
    pageId = (await pageRes.json()).id;

    // Fijar la página actual para que la app la cargue al visitar
    await api.post(`${API}/settings`, { data: { key: 'current.page_id', value: pageId } });

    posA = 0;
    posB = 1;

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
    if (pageId) {
      await api.delete(`${API}/pages/${pageId}`);
    }
    if (restorePageId) {
      await api.post(`${API}/settings`, { data: { key: 'current.page_id', value: restorePageId } });
    }
  } finally {
    await api.dispose();
  }
});

test('drags a button to another slot: optimistic immediately, persisted after reload', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 15000 });
  await collapseLeftPanel(page);
  await expect(page.getByText(LABEL_A).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(LABEL_B).first()).toBeVisible();

  // Gesto con mouse real (lo que Swapy escucha: pointerdown en el item,
  // movimientos con frames intermedios y pointerup en destino).
  const { reordered, order } = await dragSlotToSlot(page, posA, posB);
  expect(reordered, 'swap disparó la persistencia (POST /buttons/reorder)').toBe(true);
  // Como en Cypress: verificar el body del REQUEST (order), no la respuesta.
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
