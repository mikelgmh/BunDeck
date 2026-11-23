import { test, expect, type APIRequestContext } from '@playwright/test';
import { gotoBoard } from './helpers';

// Requiere daemon en http://localhost:3001 y web en http://localhost:4321
// YA LEVANTADOS (playwright.config.ts no los arranca solo).
// Cubre: botón + abre diálogo con nombre, menú ··· por pestaña
// (renombrar / duplicar como "Copia de …" / eliminar).

const API = 'http://localhost:3001/api/v1';

const tag = (n: string) => `E2E Perf ${n} ${Date.now() % 100000}`;

async function createProfileViaApi(
  request: APIRequestContext,
  name: string,
): Promise<{ id: string; name: string }> {
  const res = await request.post(`${API}/profiles`, { data: { name, data: {} } });
  expect(res.status()).toBe(201);
  const profile = await res.json();
  // La UI espera al menos una página por perfil (createProfile la crea).
  const pageRes = await request.post(`${API}/pages`, {
    data: { profile_id: profile.id, name: 'Principal', order_idx: 0, data: {} },
  });
  expect([200, 201]).toContain(pageRes.status());
  return profile;
}

async function deleteProfileViaApi(request: APIRequestContext, id: string) {
  await request.delete(`${API}/profiles/${id}`, { failOnStatusCode: false });
}

async function profileIds(request: APIRequestContext): Promise<string[]> {
  const res = await request.get(`${API}/profiles`);
  expect(res.ok()).toBeTruthy();
  const list = await res.json();
  return list.map((p: any) => p.id);
}

/** Abre el menú ··· de la pestaña cuyo texto es `name`. */
async function openMenuFor(page: any, name: string) {
  const wrap = page.locator('.bd-tabwrap', { hasText: name }).first();
  await expect(wrap).toBeVisible({ timeout: 10000 });
  await wrap.locator('.bd-tabmenu-btn').click();
  await expect(page.locator('[data-cy=bd-profile-menu]').first()).toBeVisible({ timeout: 5000 });
  return wrap;
}

test.describe('Perfiles en la barra superior', () => {
  const created: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of created.splice(0)) {
      await deleteProfileViaApi(request, id);
    }
  });

  test('el botón + abre un diálogo que pide el nombre (no crea solo)', async ({
    page,
    request,
  }) => {
    await gotoBoard(page);
    const before = await profileIds(request);

    await page.getByTestId('bd-profile-add').click();

    const input = page.getByTestId('bd-profile-name-input');
    await expect(input).toBeVisible({ timeout: 5000 });

    // Sin nombre no se puede confirmar.
    await expect(page.getByTestId('bd-profile-name-confirm')).toBeDisabled();
    // Cancelar no crea nada.
    await page.keyboard.press('Escape');
    await expect(input).toBeHidden({ timeout: 5000 });
    expect(await profileIds(request)).toEqual(before);

    // Crear con nombre sí crea y selecciona.
    const name = tag('Nuevo');
    await page.getByTestId('bd-profile-add').click();
    await expect(input).toBeVisible({ timeout: 5000 });
    await input.fill(name);
    const createdRes = page.waitForResponse(
      (res) => res.url().includes('/api/v1/profiles') && res.request().method() === 'POST',
    );
    await page.getByTestId('bd-profile-name-confirm').click();
    const res = await createdRes;
    expect(res.status()).toBe(201);
    const body = await res.json();
    created.push(body.id);

    const newTab = page.locator('[data-cy=bd-profile-tab]', { hasText: name }).first();
    await expect(newTab).toBeVisible({ timeout: 10000 });
    await expect(newTab).toHaveAttribute('aria-selected', 'true');
  });

  test('cada pestaña tiene ··· con renombrar, duplicar y eliminar', async ({
    page,
    request,
  }) => {
    const base = tag('Base');
    const seed = await createProfileViaApi(request, base);
    created.push(seed.id);
    await gotoBoard(page);

    const wrap = await openMenuFor(page, base);
    await expect(wrap.locator('[data-cy=bd-profile-rename]')).toBeVisible();
    await expect(wrap.locator('[data-cy=bd-profile-duplicate]')).toBeVisible();
    await expect(wrap.locator('[data-cy=bd-profile-delete]')).toBeVisible();
    // Cerrar con Escape para no dejar el menú abierto al siguiente paso.
    await page.keyboard.press('Escape');
  });

  test('renombrar cambia el nombre de la pestaña', async ({ page, request }) => {
    const base = tag('Ren');
    const seed = await createProfileViaApi(request, base);
    created.push(seed.id);
    await gotoBoard(page);

    await openMenuFor(page, base);
    await page.getByTestId('bd-profile-rename').click();

    const input = page.getByTestId('bd-profile-name-input');
    await expect(input).toBeVisible({ timeout: 5000 });
    await expect(input).toHaveValue(base);

    const renamed = `${base} Editado`;
    await input.fill(renamed);
    await page.getByTestId('bd-profile-name-confirm').click();

    await expect(
      page.locator('[data-cy=bd-profile-tab]', { hasText: renamed }).first(),
    ).toBeVisible({ timeout: 10000 });

    const res = await request.get(`${API}/profiles`);
    const list = await res.json();
    expect(list.some((p: any) => p.id === seed.id && p.name === renamed)).toBe(true);
  });

  test('duplicar crea "Copia de …" con sus páginas', async ({ page, request }) => {
    const base = tag('Dup');
    const seed = await createProfileViaApi(request, base);
    created.push(seed.id);
    // Una página extra con un botón para comprobar la copia profunda.
    const pagesRes = await request.get(`${API}/pages?profileId=${seed.id}`);
    const pages = await pagesRes.json();
    const firstPageId = pages[0].id;
    await request.post(`${API}/buttons`, {
      data: { page_id: firstPageId, position: 0, data: { label: 'E2E btn', actions: [] } },
    });

    await gotoBoard(page);
    await openMenuFor(page, base);

    const dupRes = page.waitForResponse(
      (res) => res.url().includes('/api/v1/profiles') && res.request().method() === 'POST',
    );
    await page.getByTestId('bd-profile-duplicate').click();
    const res = await dupRes;
    expect(res.status()).toBe(201);
    const copy = await res.json();
    created.push(copy.id);

    // "Copia de <nombre>" (es) o "Copy of <nombre>" (en según idioma guardado).
    expect(copy.name === `Copia de ${base}` || copy.name === `Copy of ${base}`).toBe(true);

    const copyTab = page.locator('[data-cy=bd-profile-tab]', { hasText: copy.name }).first();
    await expect(copyTab).toBeVisible({ timeout: 15000 });
    await expect(copyTab).toHaveAttribute('aria-selected', 'true');

    // La copia trae las mismas páginas y botones.
    const copyPagesRes = await request.get(`${API}/pages?profileId=${copy.id}`);
    expect(copyPagesRes.ok()).toBeTruthy();
    const copyPages = await copyPagesRes.json();
    expect(copyPages.length).toBeGreaterThanOrEqual(pages.length);
    const btnRes = await request.get(`${API}/buttons?pageId=${copyPages[0].id}`);
    const btns = await btnRes.json();
    expect(btns.length).toBeGreaterThanOrEqual(1);
  });

  test('duplicar reescribe pageId hacia adelante al id nuevo', async ({ page, request }) => {
    const base = tag('Fwd');
    const seed = await createProfileViaApi(request, base);
    created.push(seed.id);
    // Página A (orden 0) con tecla que referencia a B (orden 1, posterior).
    const pageA = await request.post(`${API}/pages`, {
      data: { profile_id: seed.id, name: 'Fwd A', order_idx: 0, data: {} },
    });
    const pageB = await request.post(`${API}/pages`, {
      data: { profile_id: seed.id, name: 'Fwd B', order_idx: 1, data: {} },
    });
    const idA = (await pageA.json()).id;
    const idB = (await pageB.json()).id;
    const btnRes = await request.post(`${API}/buttons`, {
      data: {
        page_id: idA,
        position: 0,
        data: {
          label: 'salto',
          actions: [{ id: 'e2e-fwd', type: 'page.page', pluginId: 'page', parameters: { pageId: idB } }],
        },
      },
    });
    expect(btnRes.status()).toBe(201);

    await gotoBoard(page);
    await openMenuFor(page, base);
    const dupRes = page.waitForResponse(
      (res) => res.url().includes('/api/v1/profiles') && res.request().method() === 'POST',
    );
    await page.getByTestId('bd-profile-duplicate').click();
    const res = await dupRes;
    expect(res.status()).toBe(201);
    const copy = await res.json();
    created.push(copy.id);

    // El POST /profiles responde al crear la fila; las páginas/botones se
    // copian después en la misma rutina. Esperar a la selección del duplicado
    // (ocurre al final, tras copiar todo) antes de verificar por API.
    const copyTab = page.locator('[data-cy=bd-profile-tab]', { hasText: copy.name }).first();
    await expect(copyTab).toBeVisible({ timeout: 15000 });
    await expect(copyTab).toHaveAttribute('aria-selected', 'true');

    const copyPages = await (await request.get(`${API}/pages?profileId=${copy.id}`)).json();
    const copyA = copyPages.find((p: any) => p.name === 'Fwd A');
    const copyB = copyPages.find((p: any) => p.name === 'Fwd B');
    expect(copyA, 'copia de A existe').toBeTruthy();
    expect(copyB, 'copia de B existe').toBeTruthy();
    const copyBtns = await (await request.get(`${API}/buttons?pageId=${copyA.id}`)).json();
    expect(copyBtns.length).toBeGreaterThanOrEqual(1);
    const ref = copyBtns[0]?.data?.actions?.[0]?.parameters?.pageId;
    // Sin la segunda pasada quedaba el id ORIGINAL (referencia cross-perfil rota).
    expect(ref, 'pageId reescrito al duplicado').toBe(copyB.id);
    expect(ref).not.toBe(idB);
  });

  test('eliminar pide confirmación y quita la pestaña', async ({ page, request }) => {
    const base = tag('Del');
    const seed = await createProfileViaApi(request, base);
    // No se añade a `created`: el test debe eliminarlo vía UI.
    await gotoBoard(page);
    await openMenuFor(page, base);
    await page.getByTestId('bd-profile-delete').click();

    // Diálogo nativo de confirmación (bd-confirm con el nombre dentro).
    const confirm = page.locator('dialog.bd-confirm', { hasText: base });
    await expect(confirm.first()).toBeVisible({ timeout: 5000 });
    // El botón primario confirma (Eliminar / Delete).
    await confirm.first().locator('.bd-confirm-actions .bd-pri').click();

    await expect(
      page.locator('[data-cy=bd-profile-tab]', { hasText: base }),
    ).toHaveCount(0, { timeout: 10000 });
    expect(await profileIds(request)).not.toContain(seed.id);
  });
});
