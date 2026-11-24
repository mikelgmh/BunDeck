import { test, expect, type APIRequestContext } from '@playwright/test';
import { gotoBoard, API_BASE } from './helpers';

// Requiere daemon en http://localhost:3001 y web en http://localhost:4321
// YA LEVANTADOS. Cubre: menú ··· con Exportar/Importar, exportar descarga
// el backup del perfil e importar un JSON lo crea como copia con ids nuevos.

const tag = (n: string) => `E2E Pbk ${n} ${Date.now() % 100000}`;

async function createProfileViaApi(
  request: APIRequestContext,
  name: string,
): Promise<{ id: string; name: string }> {
  const res = await request.post(`${API_BASE}/profiles`, { data: { name, data: {} } });
  expect(res.status()).toBe(201);
  const profile = await res.json();
  const pageRes = await request.post(`${API_BASE}/pages`, {
    data: { profile_id: profile.id, name: 'Principal', order_idx: 0, data: {} },
  });
  expect([200, 201]).toContain(pageRes.status());
  return profile;
}

async function openMenuFor(page: any, name: string) {
  const wrap = page.locator('.bd-tabwrap', { hasText: name }).first();
  await expect(wrap).toBeVisible({ timeout: 10000 });
  await wrap.locator('.bd-tabmenu-btn').click();
  await expect(page.locator('[data-cy=bd-profile-menu]').first()).toBeVisible({ timeout: 5000 });
}

test.describe('Exportar / importar perfiles desde el tab', () => {
  const created: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of created.splice(0)) {
      await request.delete(`${API_BASE}/profiles/${id}`, { failOnStatusCode: false });
    }
  });

  test('el menú muestra Exportar e Importar', async ({ page, request }) => {
    const base = tag('Menu');
    const seed = await createProfileViaApi(request, base);
    created.push(seed.id);
    await gotoBoard(page);
    await openMenuFor(page, base);
    await expect(page.getByTestId('bd-profile-export')).toBeVisible();
    await expect(page.getByTestId('bd-profile-import')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('exportar pide el backup del perfil', async ({ page, request }) => {
    const base = tag('Exp');
    const seed = await createProfileViaApi(request, base);
    created.push(seed.id);
    await gotoBoard(page);
    await openMenuFor(page, base);

    const exportRes = page.waitForResponse(
      (res) => res.url().includes(`/backups/profiles/${seed.id}/export`) && res.request().method() === 'GET',
      { timeout: 15000 },
    );
    await page.getByTestId('bd-profile-export').click();
    const res = await exportRes;
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.format).toBe('libredeck-backup');
    expect(body.data.profiles?.[0]?.id).toBe(seed.id);
  });

  test('importar un JSON lo crea como copia con nombre único', async ({ page, request }) => {
    const base = tag('Imp');
    const seed = await createProfileViaApi(request, base);
    created.push(seed.id);

    // Backup real del perfil vía API para importar.
    const exp = await request.get(`${API_BASE}/backups/profiles/${seed.id}/export`);
    expect(exp.ok()).toBeTruthy();
    const backup = await exp.json();

    await gotoBoard(page);
    await openMenuFor(page, base);

    const restoreRes = page.waitForResponse(
      (res) => res.url().includes('/backups/restore') && res.request().method() === 'POST',
      { timeout: 15000 },
    );
    await page
      .locator('[data-cy=bd-profile-import-input]')
      .setInputFiles({
        name: 'perfil.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(backup)),
      });
    const res = await restoreRes;
    expect(res.ok()).toBeTruthy();

    // Aparece una pestaña nueva con el mismo nombre uniquificado y se selecciona.
    const copyTab = page.locator('[data-cy=bd-profile-tab]', { hasText: base }).nth(1);
    await expect(copyTab).toBeVisible({ timeout: 15000 });

    const list = (await (await request.get(`${API_BASE}/profiles`)).json()) as any[];
    const copies = list.filter((p) => p.name === base && p.id !== seed.id);
    expect(copies.length).toBeGreaterThanOrEqual(1);
    for (const c of copies) created.push(c.id);
  });

  test('importar un archivo inválido avisa sin crear nada', async ({ page, request }) => {
    const base = tag('Bad');
    const seed = await createProfileViaApi(request, base);
    created.push(seed.id);
    const before = (await (await request.get(`${API_BASE}/profiles`)).json()).length;

    await gotoBoard(page);
    await openMenuFor(page, base);
    await page
      .locator('[data-cy=bd-profile-import-input]')
      .setInputFiles({
        name: 'roto.json',
        mimeType: 'application/json',
        buffer: Buffer.from('{"no":"es un backup"}'),
      });

    // Toast de error visible (el mensaje exacto depende del idioma guardado).
    const toast = page.locator('.bd-toast, [role=status], [role=alert]').first();
    await expect(toast).toBeVisible({ timeout: 10000 });

    const after = (await (await request.get(`${API_BASE}/profiles`)).json()).length;
    expect(after).toBe(before);
  });
});
