import { test, expect, type APIRequestContext } from '@playwright/test';
import { getRunnerProfile, gotoBoard, setCurrentPage, collapseLeftPanel } from './helpers';

// Registros por pulsación: click derecho en tecla → Ver registros, y en
// fila de acción → Ver registros (con botón que lanzó y dispositivo).
// Las teclas usan `local.toast` (inocuo y permitido por el modo seguro e2e).

const API = 'http://localhost:3001/api/v1';
const TOAST = (text: string) => ({ type: 'local.toast', parameters: { text } });
// flow.log se ejecuta en el daemon (inocuo, permitido por el modo seguro):
// es lo que deja fila en button_press_logs. El toast solo prueba el
// disparo en la UI (local.* corre en cliente y no genera fila).
const FLOGLINE = (tag: string) => ({ type: 'flow.log', parameters: { message: `${tag}-LOGGED` } });

async function dismissWelcome(page: any) {
  try {
    await page.evaluate(() => {
      try { window.localStorage.setItem('bundeck:welcome-seen', '1'); } catch { /* noop */ }
      const d = document.querySelector('[data-cy=bd-welcome]') as any;
      try { if (d && d.open) d.close(); } catch { /* noop */ }
    });
  } catch { /* noop */ }
  try {
    const skip = page.locator('[data-cy=bd-welcome-skip]');
    await skip.waitFor({ state: 'visible', timeout: 1500 });
    await skip.click();
  } catch { /* noop */ }
}

async function apiJson(request: APIRequestContext, method: string, path: string, data?: any) {
  const res =
    method === 'GET' ? await request.get(`${API}${path}`) :
    method === 'POST' ? await request.post(`${API}${path}`, data !== undefined ? { data } : undefined) :
    await request.delete(`${API}${path}`, { failOnStatusCode: false });
  if (!res.ok()) throw new Error(`${method} ${path} -> ${res.status()}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
}

async function waitLogs(request: APIRequestContext, query: string, minTotal: number, timeoutMs = 15000) {
  const start = Date.now();
  let last: any = null;
  while (Date.now() - start < timeoutMs) {
    last = await apiJson(request, 'GET', query);
    if (last && last.total >= minTotal) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

interface Ctx {
  tag: string;
  pageId: string;
  buttonId: string;
  origPage: string;
  origProfile: string;
}

async function setup(request: APIRequestContext, tag: string): Promise<Ctx> {
  const profile = await getRunnerProfile(request);
  const origPage = (await apiJson(request, 'GET', '/settings?key=current.page_id'))?.value ?? '';
  const origProfile = (await apiJson(request, 'GET', '/settings?key=current.profile_id'))?.value ?? '';
  const created = await apiJson(request, 'POST', '/pages', {
    profile_id: profile.id, name: `${tag}-logs`, order_idx: 140, is_folder: 0, data: {},
  });
  const btn = await apiJson(request, 'POST', '/buttons', {
    page_id: created.id, position: 0,
    data: {
      label: `${tag}-key`,
      backgroundColor: '#374151',
      textColor: '#f1f5f9',
      pressActions: { click: [TOAST(`${tag}-FIRED`), FLOGLINE(tag)] },
    },
  });
  await apiJson(request, 'POST', '/settings', { key: 'current.profile_id', value: profile.id });
  await setCurrentPage(request, created.id);
  return { tag, pageId: created.id, buttonId: btn.id, origPage, origProfile };
}

async function setupLocalOnly(request: APIRequestContext, tag: string): Promise<Ctx> {
  const profile = await getRunnerProfile(request);
  const origPage = (await apiJson(request, 'GET', '/settings?key=current.page_id'))?.value ?? '';
  const origProfile = (await apiJson(request, 'GET', '/settings?key=current.profile_id'))?.value ?? '';
  const created = await apiJson(request, 'POST', '/pages', {
    profile_id: profile.id, name: `${tag}-local`, order_idx: 141, is_folder: 0, data: {},
  });
  const btn = await apiJson(request, 'POST', '/buttons', {
    page_id: created.id, position: 0,
    data: {
      label: `${tag}-localkey`,
      backgroundColor: '#374151',
      textColor: '#f1f5f9',
      // Solo acción local: se ejecuta en el cliente; el front la reporta
      // vía POST /press-logs (baliza) para que también quede registrada.
      pressActions: { click: [TOAST(`${tag}-LOCAL`)] },
    },
  });
  await apiJson(request, 'POST', '/settings', { key: 'current.profile_id', value: profile.id });
  await setCurrentPage(request, created.id);
  return { tag, pageId: created.id, buttonId: btn.id, origPage, origProfile };
}

async function teardown(request: APIRequestContext, ctx: Ctx) {
  // Sin rastro: ni logs de prueba, ni botones, ni página.
  await request.delete(`${API}/press-logs?buttonId=${ctx.buttonId}`, { failOnStatusCode: false }).catch(() => {});
  await request.delete(`${API}/buttons/${ctx.buttonId}`, { failOnStatusCode: false }).catch(() => {});
  await request.delete(`${API}/pages/${ctx.pageId}`, { failOnStatusCode: false }).catch(() => {});
  if (ctx.origProfile) {
    await request.post(`${API}/settings`, { data: { key: 'current.profile_id', value: ctx.origProfile } }).catch(() => {});
  }
  if (ctx.origPage) {
    await request.post(`${API}/settings`, { data: { key: 'current.page_id', value: ctx.origPage } }).catch(() => {});
  }
  // Verificación de limpieza: la página ya no existe.
  const gone = await request.get(`${API}/buttons?pageId=${ctx.pageId}`, { failOnStatusCode: false }).catch(() => null);
  expect(gone === null || gone.status() !== 200 || (await gone.json()).length === 0).toBe(true);
}

test.describe('Registros por pulsación', () => {
  test.describe.configure({ timeout: 120000 });

  test('click derecho en tecla → Ver registros muestra la pulsación', async ({ page, request }) => {
    const tag = `PL-${Date.now().toString(36)}`;
    const ctx = await setup(request, tag);
    try {
      await gotoBoard(page);
      await dismissWelcome(page);
      await collapseLeftPanel(page);
      await page.locator(`.bd-page .bd-chip`, { hasText: `${tag}-logs` }).first().click({ timeout: 15000 });
      await expect(page.locator(`[data-cy=bd-key]`, { hasText: `${tag}-key` }).first()).toBeVisible({ timeout: 15000 });
      await page.locator(`[data-cy=bd-key]`, { hasText: `${tag}-key` }).first().click({ timeout: 15000 });
      await expect(page.locator('[data-cy=bd-key-title]')).toBeVisible({ timeout: 5000 });

      // Probar ejecuta de verdad (toast permitido por el modo seguro e2e).
      await expect(page.locator('[data-cy=bd-test-key]')).toBeEnabled({ timeout: 5000 });
      await page.locator('[data-cy=bd-test-key]').click();
      await expect(page.locator('.bd-toast', { hasText: `${tag}-FIRED` })).toBeVisible({ timeout: 10000 });

      // API: el log existe con botón, acción y dispositivo atribuidos.
      const logs = await waitLogs(request, `/buttons/${ctx.buttonId}/logs?limit=10`, 1);
      expect(logs.total).toBeGreaterThanOrEqual(1);
      const row = logs.items.find((r: any) => r.actionType === 'flow.log');
      expect(row).toBeTruthy();
      expect(row.buttonId).toBe(ctx.buttonId);
      expect(row.success).toBe(true);
      expect(row.deviceId).toBeTruthy();

      // UI: click derecho → Ver registros → diálogo con la fila.
      await page.locator(`[data-swapy-slot="slot-0"] [data-cy=bd-key]`).click({ button: 'right', timeout: 15000 });
      await page.locator('[data-cy=bd-ctx-logs]').click({ timeout: 5000 });
      await expect(page.locator('[data-cy=bd-press-logs-dialog]')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-cy=bd-press-log-item]').first()).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-cy=bd-press-logs-dialog]')).toContainText('flow.log');
    } finally {
      await teardown(request, ctx);
    }
  });

  test('click derecho en acción → Ver registros con botón y dispositivo', async ({ page, request }) => {
    const tag = `PA-${Date.now().toString(36)}`;
    const ctx = await setup(request, tag);
    try {
      await gotoBoard(page);
      await dismissWelcome(page);
      await collapseLeftPanel(page);
      await page.locator(`.bd-page .bd-chip`, { hasText: `${tag}-logs` }).first().click({ timeout: 15000 });
      await expect(page.locator(`[data-cy=bd-key]`, { hasText: `${tag}-key` }).first()).toBeVisible({ timeout: 15000 });
      await page.locator(`[data-cy=bd-key]`, { hasText: `${tag}-key` }).first().click({ timeout: 15000 });
      await expect(page.locator('[data-cy=bd-key-title]')).toBeVisible({ timeout: 5000 });

      await expect(page.locator('[data-cy=bd-test-key]')).toBeEnabled({ timeout: 5000 });
      await page.locator('[data-cy=bd-test-key]').click();
      await expect(page.locator('.bd-toast', { hasText: `${tag}-FIRED` })).toBeVisible({ timeout: 10000 });

      // API por acción: filtra por tipo y conserva botón + dispositivo.
      const byAction = await waitLogs(request, `/actions/logs?actionType=flow.log&buttonId=${ctx.buttonId}&limit=10`, 1);
      expect(byAction.total).toBeGreaterThanOrEqual(1);
      expect(byAction.items[0].buttonId).toBe(ctx.buttonId);
      expect(byAction.items[0].deviceId).toBeTruthy();

      // UI: click derecho en la fila de acción del inspector (la de
      // flow.log, que sí se ejecuta en el daemon; el toast corre en cliente).
      const row = page.locator('[data-cy=bd-action-row]', { hasText: 'Registrar' }).first();
      await expect(row).toBeVisible({ timeout: 10000 });
      await row.click({ button: 'right' });
      await page.locator('[data-cy=bd-ctx-action-logs]').click({ timeout: 5000 });
      await expect(page.locator('[data-cy=bd-press-logs-dialog]')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-cy=bd-press-log-item]').first()).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-cy=bd-press-logs-dialog]')).toContainText('flow.log');
    } finally {
      await teardown(request, ctx);
    }
  });

  test('tecla solo-local → Probar deja fila (baliza) y el diálogo la muestra', async ({ page, request }) => {
    const tag = `LO-${Date.now().toString(36)}`;
    const ctx = await setupLocalOnly(request, tag);
    try {
      await gotoBoard(page);
      await dismissWelcome(page);
      await collapseLeftPanel(page);
      await page.locator(`.bd-page .bd-chip`, { hasText: `${tag}-local` }).first().click({ timeout: 15000 });
      await expect(page.locator(`[data-cy=bd-key]`, { hasText: `${tag}-localkey` }).first()).toBeVisible({ timeout: 15000 });
      await page.locator(`[data-cy=bd-key]`, { hasText: `${tag}-localkey` }).first().click({ timeout: 15000 });
      await expect(page.locator('[data-cy=bd-key-title]')).toBeVisible({ timeout: 5000 });

      await expect(page.locator('[data-cy=bd-test-key]')).toBeEnabled({ timeout: 5000 });
      await page.locator('[data-cy=bd-test-key]').click();
      await expect(page.locator('.bd-toast', { hasText: `${tag}-LOCAL` })).toBeVisible({ timeout: 10000 });

      // La baliza del cliente registra la acción local en el daemon.
      const logs = await waitLogs(request, `/buttons/${ctx.buttonId}/logs?limit=10`, 1);
      expect(logs.total).toBeGreaterThanOrEqual(1);
      const row = logs.items.find((r: any) => r.actionType === 'local.toast');
      expect(row).toBeTruthy();
      expect(row.buttonId).toBe(ctx.buttonId);
      expect(row.success).toBe(true);

      // El diálogo de la tecla la muestra.
      await page.locator(`[data-swapy-slot="slot-0"] [data-cy=bd-key]`).click({ button: 'right', timeout: 15000 });
      await page.locator('[data-cy=bd-ctx-logs]').click({ timeout: 5000 });
      await expect(page.locator('[data-cy=bd-press-logs-dialog]')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-cy=bd-press-log-item]').first()).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-cy=bd-press-logs-dialog]')).toContainText('local.toast');
    } finally {
      await teardown(request, ctx);
    }
  });

  test('diálogo pagina con anterior/siguiente (límite como tamaño de página)', async ({ page, request }) => {
    const tag = `PG-${Date.now().toString(36)}`;
    const ctx = await setup(request, tag);
    try {
      // Semilla: 55 filas vía baliza para forzar 2 páginas con límite 50.
      for (let i = 0; i < 55; i++) {
        await request.post(`${API}/press-logs`, {
          data: { buttonId: ctx.buttonId, pageId: ctx.pageId, pressType: 'short', source: 'web', actionType: 'flow.log', success: true },
        });
      }
      const seeded = await waitLogs(request, `/buttons/${ctx.buttonId}/logs?limit=1`, 55);
      expect(seeded.total).toBeGreaterThanOrEqual(55);

      await gotoBoard(page);
      await dismissWelcome(page);
      await collapseLeftPanel(page);
      await page.locator(`.bd-page .bd-chip`, { hasText: `${tag}-logs` }).first().click({ timeout: 15000 });
      await expect(page.locator(`[data-cy=bd-key]`, { hasText: `${tag}-key` }).first()).toBeVisible({ timeout: 15000 });
      await page.locator(`[data-cy=bd-key]`, { hasText: `${tag}-key` }).first().click({ timeout: 15000 });
      await expect(page.locator('[data-cy=bd-key-title]')).toBeVisible({ timeout: 5000 });

      await page.locator(`[data-swapy-slot="slot-0"] [data-cy=bd-key]`).click({ button: 'right', timeout: 15000 });
      await page.locator('[data-cy=bd-ctx-logs]').click({ timeout: 5000 });
      const dlg = page.locator('[data-cy=bd-press-logs-dialog]');
      await expect(dlg).toBeVisible({ timeout: 10000 });
      // Indicador de paginación con el total.
      await expect(page.locator('[data-cy=bd-press-logs-page]')).toContainText('55', { timeout: 10000 });
      const itemsPage1 = await page.locator('[data-cy=bd-press-log-item]').count();
      expect(itemsPage1).toBe(50);

      // Siguiente → segunda página con el resto.
      await page.locator('[data-cy=bd-press-logs-next]').click();
      await expect(page.locator('[data-cy=bd-press-logs-page]')).toContainText('2 de 2', { timeout: 10000 });
      expect(await page.locator('[data-cy=bd-press-log-item]').count()).toBeGreaterThanOrEqual(5);

      // Anterior → vuelve a la primera.
      await page.locator('[data-cy=bd-press-logs-prev]').click();
      await expect(page.locator('[data-cy=bd-press-logs-page]')).toContainText('1 de 2', { timeout: 10000 });
      expect(await page.locator('[data-cy=bd-press-log-item]').count()).toBe(50);
    } finally {
      await teardown(request, ctx);
    }
  });
});
