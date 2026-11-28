import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

// Webhooks LAN: CRUD + disparo por token + veto de relay (vía UI y API).
// Requiere daemon en http://localhost:3001 y web en http://localhost:4321.
// Usa acciones `local.toast` (inocuas y permitidas por el modo seguro e2e).
// Limpia todo lo que crea (nombres con tag WH-E2E).

const API = 'http://localhost:3001/api/v1';
const TAG = `WH-E2E-${Date.now()}`;
const TOAST = (text: string) => ({ type: 'local.toast', parameters: { text } });

async function apiJson(request: APIRequestContext, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, data?: any) {
  const res =
    method === 'GET' ? await request.get(`${API}${path}`) :
    method === 'POST' ? await request.post(`${API}${path}`, data !== undefined ? { data } : undefined) :
    method === 'PUT' ? await request.put(`${API}${path}`, { data }) :
    await request.delete(`${API}${path}`, { failOnStatusCode: false });
  let body: any = null;
  try {
    body = JSON.parse(await res.text());
  } catch { /* vacío */ }
  return { status: res.status(), body };
}

async function dismissWelcome(page: Page) {
  try {
    await page.evaluate(() => {
      try { window.localStorage.setItem('bundeck:welcome-seen', '1'); } catch { /* noop */ }
    });
  } catch { /* noop */ }
  try {
    const skip = page.locator('[data-cy=bd-welcome-skip]');
    await skip.waitFor({ state: 'visible', timeout: 1500 });
    await skip.click();
  } catch { /* noop */ }
}

async function openWebhooks(page: Page) {
  await page.goto('/');
  await page.getByTestId('bd-profile-tab').first().waitFor({ state: 'visible', timeout: 15000 });
  await dismissWelcome(page);
  await page.getByTestId('bd-open-webhooks').click();
  await expect(page.getByTestId('bd-settings')).toBeVisible();
  await expect(page.getByTestId('bd-webhooks')).toBeVisible();
}

test.describe('Webhooks LAN', () => {
  test('API: crear → disparar por token ejecuta las acciones → 404 tras borrar', async ({ request }) => {
    const name = `${TAG}-api`;
    const created = await apiJson(request, 'POST', '/webhooks', {
      name,
      method: 'POST',
      actions: [TOAST(`${TAG}-hola`)],
    });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^[0-9a-f]{64}$/);
    const id = created.body.id as string;
    const token = created.body.token as string;
    try {
      // Lista lo incluye
      const list = await apiJson(request, 'GET', '/webhooks');
      expect(list.status).toBe(200);
      expect((list.body as any[]).some((w) => w.id === id)).toBe(true);

      // Disparo: ejecuta la acción y cuenta el trigger
      const fired = await apiJson(request, 'POST', `/webhooks/${token}`, {});
      expect(fired.status).toBe(200);
      expect(fired.body.ok).toBe(true);
      expect(fired.body.executed).toBe(1);

      const detail = await apiJson(request, 'GET', `/webhooks/${id}`);
      expect(detail.body.trigger_count).toBeGreaterThanOrEqual(1);

      // Método distinto → 405
      const wrong = await apiJson(request, 'GET', `/webhooks/${token}`);
      expect(wrong.status).toBe(405);

      // Token inexistente → 404
      const missing = await apiJson(request, 'POST', `/webhooks/${'f'.repeat(64)}`, {});
      expect(missing.status).toBe(404);
    } finally {
      await apiJson(request, 'DELETE', `/webhooks/${id}`);
      const gone = await apiJson(request, 'GET', `/webhooks/${id}`);
      expect(gone.status).toBe(404);
    }
  });

  test('API: deshabilitado no dispara (404)', async ({ request }) => {
    const created = await apiJson(request, 'POST', '/webhooks', {
      name: `${TAG}-off`, method: 'GET', actions: [TOAST('x')],
    });
    const id = created.body.id as string;
    const token = created.body.token as string;
    try {
      const off = await apiJson(request, 'PUT', `/webhooks/${id}`, { enabled: false });
      expect(off.status).toBe(200);
      const fired = await apiJson(request, 'GET', `/webhooks/${token}`);
      expect(fired.status).toBe(404);
    } finally {
      await apiJson(request, 'DELETE', `/webhooks/${id}`);
    }
  });

  test('UI: icono del nav abre la modal, crear y probar', async ({ page, request }) => {
    const name = `${TAG}-ui`;
    await openWebhooks(page);

    // Crear desde la modal (sin acciones: el daemon acepta lista vacía)
    await page.getByTestId('bd-webhook-new').click();
    await page.getByTestId('bd-webhook-name').fill(name);
    await page.getByTestId('bd-webhook-save').click();
    const item = page.locator('[data-cy^="bd-webhook-item-"]', { hasText: name });
    await expect(item).toBeVisible({ timeout: 10000 });

    // La URL es completa y local (IP LAN o loopback + token de 64 hex)
    const urlInput = item.getByTestId(/bd-webhook-url-/);
    await expect(urlInput).toHaveValue(/http:\/\/[^/]+\/api\/v1\/webhooks\/[0-9a-f]{64}/);

    // Probar dispara (0 acciones → ok igual)
    await item.getByTestId(/bd-webhook-test-/).click();

    // Limpieza por API
    const list = await apiJson(request, 'GET', '/webhooks');
    const mine = (list.body as any[]).find((w) => w.name === name);
    expect(mine).toBeTruthy();
    await apiJson(request, 'DELETE', `/webhooks/${mine.id}`);
  });
});
