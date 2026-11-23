import { test, expect, type Browser } from '@playwright/test';
import { collapseLeftPanel, getRunnerProfile } from './helpers';

// Sincronización multi-dispositivo: lo que se hace en una ventana debe
// llegar a otra ventana aislada (contexto aparte = incógnito, como la
// tablet del reporte: sin perfiles/páginas/acciones).
//
// Requiere daemon en http://localhost:3001 y web en http://localhost:4321.
// Dos contextos de Playwright = dos deviceId distintos (localStorage aislado),
// mismo daemon. Las mutaciones se hacen por API (como las haría el otro
// dispositivo) y se verifica que la SEGUNDA ventana las refleja SIN recargar
// (vía broadcasts WS: profile.updated, page.created, button.*).

const API = 'http://localhost:3001/api/v1';

async function apiJson(request: any, method: string, path: string, data?: any) {
  const res =
    method === 'GET'
      ? await request.get(`${API}${path}`)
      : method === 'POST'
        ? await request.post(`${API}${path}`, data !== undefined ? { data } : undefined)
        : method === 'PUT'
          ? await request.put(`${API}${path}`, data !== undefined ? { data } : undefined)
          : await request.delete(`${API}${path}`);
  if (!res.ok()) throw new Error(`${method} ${path} -> ${res.status()}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function openBoard(browser: Browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  const tabs = page.getByTestId('bd-profile-tab');
  await expect(tabs.first()).toBeVisible({ timeout: 30000 });
  return { ctx, page };
}

test.describe('Multi-dispositivo (dos ventanas)', () => {
  test('ventana nueva en incógnito carga perfiles, páginas, botones y acciones (caso tablet)', async ({
    browser,
    request,
  }) => {
    // Fijar la vista actual para que ambas ventanas arranquen en lo mismo.
    // Siempre sobre el perfil dedicado (no tocar perfiles del usuario).
    const profile = await getRunnerProfile(request);
    const pages = await apiJson(request, 'GET', `/pages?profileId=${profile.id}`);
    const page0 = pages.find((p: any) => p.is_folder === 0) ?? pages[0];
    await apiJson(request, 'POST', '/settings', { key: 'current.profile_id', value: profile.id });
    await apiJson(request, 'POST', '/settings', { key: 'current.page_id', value: page0.id });

    const { ctx, page } = await openBoard(browser);
    try {
      // Perfiles visibles.
      const tabs = page.getByTestId('bd-profile-tab');
      expect(await tabs.count()).toBeGreaterThan(0);
      // Páginas visibles (chips con el nombre de la página actual).
      await expect(page.getByText(page0.name).first()).toBeVisible({ timeout: 15000 });
      // Botones de la página: los de la API aparecen en el grid sin recargar.
      const apiButtons = await apiJson(request, 'GET', `/buttons?pageId=${page0.id}`);
      for (const b of apiButtons.slice(0, 3)) {
        const label = b?.data?.label;
        if (typeof label === 'string' && label.trim()) {
          await expect(page.getByText(label).first()).toBeVisible({ timeout: 15000 });
        }
      }
      // Acciones: la biblioteca carga desde /plugins/actions.
      await collapseLeftPanel(page);
      await page.getByTestId('bd-key').first().click();
      await expect(page.getByTestId('bd-key-title')).toBeVisible({ timeout: 5000 });
      await page.getByTestId('bd-expand-left').click();
      const actions = page.getByTestId('bd-action-item');
      await expect(actions.first()).toBeVisible({ timeout: 15000 });
      expect(await actions.count()).toBeGreaterThan(0);
    } finally {
      await ctx.close();
    }
  });

  test('todo lo creado/editado en A llega a B sin recargar', async ({ browser, request }) => {
    const tag = `MD-${Date.now().toString(36)}`;
    const profileName = `${tag}-perfil`;
    const pageName = `${tag}-pagina`;
    const btnLabel = `${tag}-tecla`;
    const btnLabel2 = `${tag}-tecla-edit`;

    // Punto de partida: perfil dedicado + su primera página no-carpeta.
    const baseProfile = await getRunnerProfile(request);
    const basePages = await apiJson(request, 'GET', `/pages?profileId=${baseProfile.id}`);
    const basePage = basePages.find((p: any) => p.is_folder === 0) ?? basePages[0];
    await apiJson(request, 'POST', '/settings', { key: 'current.profile_id', value: baseProfile.id });
    await apiJson(request, 'POST', '/settings', { key: 'current.page_id', value: basePage.id });

    const a = await openBoard(browser);
    const b = await openBoard(browser);
    let createdProfileId = '';
    let createdPageId = '';
    let createdButtonId = '';
    try {
      // --- 1. Perfil creado "en A" (por API) aparece en B ---
      const createdProfile = await apiJson(request, 'POST', '/profiles', {
        name: profileName,
        data: {},
      });
      createdProfileId = createdProfile.id;
      await apiJson(request, 'POST', '/pages', {
        profile_id: createdProfileId,
        name: 'Página Principal',
        order_idx: 0,
        is_folder: 0,
        data: {},
      });
      await expect
        .poll(async () => a.page.getByText(profileName).count(), { timeout: 15000 })
        .toBeGreaterThan(0);
      await expect
        .poll(async () => b.page.getByText(profileName).count(), { timeout: 15000 })
        .toBeGreaterThan(0);

      // --- 2. Página creada "en A" aparece en B (tras volver al perfil base) ---
      // B sigue en el perfil base: crear la página ahí la ve al instante.
      const createdPage = await apiJson(request, 'POST', '/pages', {
        profile_id: baseProfile.id,
        name: pageName,
        order_idx: 9999,
        is_folder: 0,
        data: { gridCols: 5, gridRows: 3 },
      });
      createdPageId = createdPage.id;
      await expect
        .poll(async () => a.page.getByText(pageName).count(), { timeout: 15000 })
        .toBeGreaterThan(0);
      await expect
        .poll(async () => b.page.getByText(pageName).count(), { timeout: 15000 })
        .toBeGreaterThan(0);

      // --- 3. Botón creado "en A" aparece en B ---
      const buttonsBefore = await apiJson(request, 'GET', `/buttons?pageId=${basePage.id}`);
      const taken = new Set(buttonsBefore.map((x: any) => x.position));
      let freePos = -1;
      for (let i = 0; i < 5 * 3; i++) {
        if (!taken.has(i)) {
          freePos = i;
          break;
        }
      }
      expect(freePos, 'hay hueco libre en la página base').toBeGreaterThanOrEqual(0);
      const createdBtn = await apiJson(request, 'POST', '/buttons', {
        page_id: basePage.id,
        position: freePos,
        data: {
          label: btnLabel,
          actions: [
            {
              id: `${tag}-a1`,
              type: 'shell.shell',
              pluginId: 'shell',
              parameters: { command: 'echo hola' },
            },
          ],
          backgroundColor: '#374151',
          textColor: '#f1f5f9',
        },
      });
      createdButtonId = createdBtn.id;
      await expect(a.page.getByText(btnLabel).first()).toBeVisible({ timeout: 15000 });
      await expect(b.page.getByText(btnLabel).first()).toBeVisible({ timeout: 15000 });

      // --- 4. Botón editado "en A" se actualiza en B ---
      await apiJson(request, 'PUT', `/buttons/${createdButtonId}`, {
        data: {
          label: btnLabel2,
          actions: [],
          backgroundColor: '#374151',
          textColor: '#f1f5f9',
        },
      });
      await expect(a.page.getByText(btnLabel2).first()).toBeVisible({ timeout: 15000 });
      await expect(b.page.getByText(btnLabel2).first()).toBeVisible({ timeout: 15000 });

      // --- 5. Botón borrado "en A" desaparece en B ---
      await request.delete(`${API}/buttons/${createdButtonId}`);
      createdButtonId = '';
      await expect(a.page.getByText(btnLabel2)).toHaveCount(0, { timeout: 15000 });
      await expect(b.page.getByText(btnLabel2)).toHaveCount(0, { timeout: 15000 });

      // --- 6. Edición desde la UI de A llega a B ---
      // Reutilizar el hueco: crear por API y renombrar desde el inspector de A.
      const uiBtn = await apiJson(request, 'POST', '/buttons', {
        page_id: basePage.id,
        position: freePos,
        data: { label: `${tag}-ui`, actions: [], backgroundColor: '#374151', textColor: '#f1f5f9' },
      });
      createdButtonId = uiBtn.id;
      const uiLabel = `${tag}-ui-ok`;
      await expect(a.page.getByText(`${tag}-ui`).first()).toBeVisible({ timeout: 15000 });
      await expect(b.page.getByText(`${tag}-ui`).first()).toBeVisible({ timeout: 15000 });
      await collapseLeftPanel(a.page);
      // Seleccionar la tecla en A (por texto) y renombrarla en el inspector.
      await a.page.getByText(`${tag}-ui`).first().click();
      await expect(a.page.getByTestId('bd-key-title')).toBeVisible({ timeout: 5000 });
      await a.page.getByTestId('bd-key-title').fill(uiLabel);
      // Autosave por debounce (800ms) + broadcast WS con debounce (200ms).
      await expect(a.page.getByText(uiLabel).first()).toBeVisible({ timeout: 15000 });
      await expect(b.page.getByText(uiLabel).first()).toBeVisible({ timeout: 15000 });
    } finally {
      // Limpieza: no dejar rastro en el daemon compartido.
      if (createdButtonId) await request.delete(`${API}/buttons/${createdButtonId}`).catch(() => {});
      if (createdPageId) await request.delete(`${API}/pages/${createdPageId}`).catch(() => {});
      if (createdProfileId) await request.delete(`${API}/profiles/${createdProfileId}`).catch(() => {});
      await request
        .post(`${API}/settings`, { data: { key: 'current.page_id', value: basePage.id } })
        .catch(() => {});
      await a.ctx.close();
      await b.ctx.close();
    }
  });
});
