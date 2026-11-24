import { test, expect } from '@playwright/test';

const API = 'http://localhost:3001/api/v1';

let testPageId = '';
let restorePageId = '';
let initialAssignments: Record<string, string | null> = {};
let profileId = '';
// Sin seed de dispositivos: cada spec aprovisiona los suyos por API.
let phoneId = '';
let deckId = '';

async function dismissWelcome(page: any) {
  // En contextos frescos aparece el diálogo de bienvenida (modal nativo):
  // cerrarlo o bloquea todos los clics de la prueba. El diálogo es un chunk
  // async y puede abrirse segundos después del load: cerrar por JS (y marcar
  // visto) funciona esté abierto o no, sin esperas.
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
}

async function currentProfileAndPage(request: any, page: any) {
  await page.goto('/');
  await dismissWelcome(page);
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
  profileId = profile.id;

  const pagesRes = await request.get(`${API}/pages?profileId=${profile.id}`);
  const pages = await pagesRes.json();
  const activePage = pages.find((p: any) => p.name === activePageName);
  expect(activePage, 'active page exists in API').toBeTruthy();
  restorePageId = activePage.id;

  const asgRes = await request.get(`${API}/profiles/${profile.id}/assignments`);
  expect(asgRes.ok()).toBeTruthy();
  initialAssignments = (await asgRes.json()).assignments ?? {};
  return activePage;
}

async function openDevicesPopover(page: any) {
  await dismissWelcome(page);
  await page.locator('[data-cy=bd-devices-btn]').click();
  await expect(page.locator('[data-cy=bd-devices-pop]')).toBeVisible({ timeout: 5000 });
}

async function createTestPage(page: any) {
  await dismissWelcome(page);
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

test.beforeEach(async ({ page, request }) => {
  testPageId = '';
  phoneId = '';
  deckId = '';
  await currentProfileAndPage(request, page);
});

async function ensurePhoneDevice(request: any) {
  if (phoneId) return phoneId;
  const res = await request.post(`${API}/devices`, {
    data: { name: 'E2E Navegador', kind: 'browser' },
  });
  expect(res.status()).toBe(201);
  phoneId = (await res.json()).id;
  return phoneId;
}

async function ensureDeckDevice(request: any) {
  if (deckId) return deckId;
  const res = await request.post(`${API}/devices`, {
    data: { name: 'E2E Deck', kind: 'deck', model: 'mk2' },
  });
  expect(res.status()).toBe(201);
  deckId = (await res.json()).id;
  return deckId;
}

test.afterEach(async ({ request }) => {
  if (testPageId) {
    await request.delete(`${API}/pages/${testPageId}`, { failOnStatusCode: false });
  }
  // Restaurar asignaciones iniciales para no contaminar otros specs.
  if (profileId) {
    await request.put(`${API}/profiles/${profileId}/assignments`, {
      data: { assignments: initialAssignments },
      failOnStatusCode: false,
    });
  }
  for (const id of [phoneId, deckId]) {
    if (id) await request.delete(`${API}/devices/${id}`, { failOnStatusCode: false });
  }
  if (restorePageId) {
    await request.post(`${API}/settings`, {
      data: { key: 'current.page_id', value: restorePageId },
    });
  }
});

test('asignar una página a un dispositivo persiste tras recargar', async ({ page, request }) => {
  const created = await createTestPage(page);
  // Navegador aprovisionado por API (ya no hay seed).
  const pid = await ensurePhoneDevice(request);
  await openDevicesPopover(page);

  const select = page.locator(`[data-cy=bd-device-page-${pid}]`);
  await expect(select).toBeVisible({ timeout: 5000 });

  const putPromise = page.waitForResponse(
    (res: any) => res.url().includes('/assignments') && res.request().method() === 'PUT',
    { timeout: 15000 },
  );
  await select.selectOption(testPageId);
  const putRes = await putPromise;
  expect(putRes.status()).toBe(200);

  // Toast de confirmación visible.
  await expect(page.locator('.bd-toast')).toBeVisible({ timeout: 5000 });

  // Persiste tras recargar.
  await page.reload();
  await expect(page.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 30000 });
  await openDevicesPopover(page);
  await expect(page.locator(`[data-cy=bd-device-page-${pid}]`)).toHaveValue(testPageId);

  const asgRes = await request.get(`${API}/profiles/${profileId}/assignments`);
  expect(((await asgRes.json()).assignments ?? {})[pid]).toBe(testPageId);
});

test('una página libre no se puede asignar a un deck (solo fijas compatibles)', async ({
  page,
  request,
}) => {
  const created = await createTestPage(page);

  // Pasar la página actual a Libre (aceptando el aviso de desasignación).
  await page.locator('[data-cy=bd-layout-gridstack]').click();
  const okBtn = page.locator('dialog.bd-confirm[open] .bd-confirm-actions .bd-pri');
  try {
    await okBtn.waitFor({ state: 'visible', timeout: 3000 });
    await okBtn.click();
  } catch {
    /* no asignada: sin diálogo */
  }
  await expect(page.locator('[data-cy=bd-gs-plate]')).toBeVisible({ timeout: 10000 });

  // En el desplegable del deck la opción de la página libre está deshabilitada.
  const did = await ensureDeckDevice(request);
  await openDevicesPopover(page);
  const option = page.locator(
    `[data-cy=bd-device-page-${did}] option[value="${created.id}"]`,
  );
  await expect(option).toBeAttached({ timeout: 5000 });
  await expect(option).toBeDisabled();

  // Y el daemon la rechaza aunque se intente por API (422).
  const direct = await request.put(`${API}/profiles/${profileId}/assignments`, {
    data: { assignments: { ...initialAssignments, [did]: created.id } },
  });
  expect(direct.status()).toBe(422);

  // Limpieza: volver a Fija para dejar la DB neutra.
  await page.locator('[data-cy=bd-layout-classic]').click();
  await expect(page.locator('[data-swapy-container]')).toBeVisible({ timeout: 10000 });
});

test('borrar una página se puede deshacer desde el toast', async ({ page, request }) => {
  const createPagePromise = page.waitForResponse(
    (res: any) => res.url().includes('/api/v1/pages') && res.request().method() === 'POST',
  );
  await page.locator('[data-cy=bd-page-add]').click();
  const createPageRes = await createPagePromise;
  expect(createPageRes.status()).toBe(201);
  const created = await createPageRes.json();
  testPageId = created.id;

  // Dos teclas con contenido: el Deshacer debe restaurarlas (no solo la página).
  for (const [pos, label] of [[0, 'E2E Undo A'], [1, 'E2E Undo B']] as const) {
    const res = await request.post(`${API}/buttons`, {
      data: { page_id: created.id, position: pos, data: { label, actions: [] } },
    });
    expect(res.status()).toBe(201);
  }
  // Esperar a que la UI las pinte: el snapshot de Deshacer sale de
  // currentButtons, y borrar antes del refetch (WS + debounce) dejaría
  // fuera a la segunda.
  await expect(page.getByText('E2E Undo A')).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('E2E Undo B')).toBeVisible({ timeout: 10000 });

  const chip = page.locator('.bd-page .bd-chip', { hasText: created.name }).first();
  await expect(chip).toBeVisible({ timeout: 10000 });

  // Menú de la página → Eliminar.
  const row = page.locator('.bd-page', { hasText: created.name });
  await dismissWelcome(page);
  await row.locator('.bd-pagemenu-btn').click();
  await row.locator('.bd-menu .bd-dng').click();

  await expect(
    page.locator('.bd-page .bd-chip', { hasText: created.name }),
  ).toHaveCount(0, { timeout: 10000 });
  const gone = await request.get(`${API}/pages?profileId=${profileId}`);
  expect((await gone.json()).some((p: any) => p.id === testPageId)).toBe(false);

  // Deshacer desde el toast restaura página Y botones.
  await expect(page.locator('.bd-toast')).toBeVisible({ timeout: 5000 });
  await page.locator('.bd-toast button').click();
  await expect(
    page.locator('.bd-page .bd-chip', { hasText: created.name }).first(),
  ).toBeVisible({ timeout: 15000 });
  const back = await request.get(`${API}/pages?profileId=${profileId}`);
  expect(back.ok()).toBeTruthy();
  const pagesAfter = await back.json();
  const restored = pagesAfter.find((p: any) => p.name === created.name);
  expect(restored, 'la página restaurada existe en BD').toBeTruthy();
  const btnsRes = await request.get(`${API}/buttons?pageId=${restored.id}`);
  expect(btnsRes.ok()).toBeTruthy();
  const labels = ((await btnsRes.json()) as any[]).map((b: any) => b?.data?.label).sort();
  // Sin el fix del Deshacer (fetch a "[object Object]/buttons") volvían 0.
  expect(labels).toEqual(['E2E Undo A', 'E2E Undo B']);
  // La restaurada es una página nueva: actualizar el id para la limpieza.
  testPageId = restored.id;
});
