import { test, expect, type Browser, type APIRequestContext } from '@playwright/test';
import { getRunnerProfile, collapseLeftPanel } from './helpers';

// Pulsaciones en KIOSCO (?kiosk=1) con pantalla táctil (como el iPad):
// click, doble, triple y hold deben ejecutar sus acciones igual que en
// modo uso. La tecla de prueba usa `local.toast` (se ejecuta en cliente y
// deja el texto visible en `.bd-toast`), sin depender de plugins.

const API = 'http://localhost:3001/api/v1';

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
  let lastErr: any = null;
  for (let i = 0; i < 4; i++) {
    try {
      const res =
        method === 'GET' ? await request.get(`${API}${path}`) :
        method === 'POST' ? await request.post(`${API}${path}`, data !== undefined ? { data } : undefined) :
        method === 'PUT' ? await request.put(`${API}${path}`, data !== undefined ? { data } : undefined) :
        await request.delete(`${API}${path}`);
      if (!res.ok()) {
        const body = await res.text().catch(() => '');
        throw new Error(`${method} ${path} -> ${res.status} :: ${body.slice(0, 300)}`);
      }
      const text = await res.text();
      try { return JSON.parse(text); } catch { return null; }
    } catch (e) {
      if (e instanceof Error && /-> \d{3}$/.test(e.message)) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

test.describe('Pulsaciones en kiosco (touch)', () => {
  // Los 4 gestos + arranque en dos ventanas superan los 30 s por defecto.
  test.describe.configure({ timeout: 120000 });
  test('click, doble, triple y hold funcionan en kiosco como en uso', async ({ browser, request }) => {
    const tag = `KP-${Date.now().toString(36)}`;
    const profile = await getRunnerProfile(request);
    const origPage = await apiJson(request, 'GET', '/settings?key=current.page_id');
    const origProfile = await apiJson(request, 'GET', '/settings?key=current.profile_id');
    let pageId = '';
    let initialAsg: Record<string, string> = {};
    // Contexto táctil (como el iPad): locator.tap() exige hasTouch.
    // Viewport ancho como la config (1600): a 1280 el drawer tapa la toolbar.
    const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 1600, height: 900 } });
    const page = await ctx.newPage();
    try {
      const created = await apiJson(request, 'POST', '/pages', {
        profile_id: profile.id, name: `${tag}-page`, order_idx: 130, is_folder: 0, data: {},
      });
      pageId = created.id;
      const toast = (text: string) => ({ type: 'local.toast', parameters: { text } });
      // Idempotente ante reintentos de red: limpiar la posición antes de sembrar.
      const existing = await apiJson(request, 'GET', `/buttons?pageId=${pageId}`).catch(() => []);
      for (const b of existing ?? []) {
        await request.delete(`${API}/buttons/${b.id}`, { failOnStatusCode: false }).catch(() => {});
      }
      await apiJson(request, 'POST', '/buttons', {
        page_id: pageId, position: 0,
        data: {
          label: `${tag}-key`,
          pressActions: {
            click: [toast(`${tag}-CLICK`)],
            double: [toast(`${tag}-DOUBLE`)],
            triple: [toast(`${tag}-TRIPLE`)],
            long: [toast(`${tag}-LONG`)],
          },
        },
      });
      await apiJson(request, 'POST', '/settings', { key: 'current.profile_id', value: profile.id });
      await apiJson(request, 'POST', '/settings', { key: 'current.page_id', value: pageId });
      const initialAsgRes = await apiJson(request, 'GET', `/profiles/${profile.id}/assignments`);
      initialAsg = (initialAsgRes?.assignments ?? {}) as Record<string, string>;

      // Control en modo uso: llevar la ventana a la página (el auto-repair
      // manda a los frescos a su asignada), pasar a Usar y el tap simple
      // ejecuta el click. Se pliega la biblioteca: su borde solapa la
      // toolbar en este viewport y bloquea los clics (también rompería
      // la espera de estabilidad del tap).
      await page.goto('/');
      await dismissWelcome(page);
      await collapseLeftPanel(page);
      await page.locator('.bd-page .bd-chip', { hasText: `${tag}-page` }).first().click({ timeout: 15000 });
      await page.locator('[data-md="use"]').click({ timeout: 15000 });
      await expect(page.locator('[data-md="use"]')).toHaveAttribute('aria-pressed', 'true', { timeout: 10000 });
      const key = page.locator('[data-cy=bd-key]').filter({ hasText: `${tag}-key` }).first();
      await expect(key).toBeVisible({ timeout: 10000 });
      await key.tap({ timeout: 15000 });
      await expect(page.locator('.bd-toast')).toContainText(`${tag}-CLICK`, { timeout: 10000 });

      // Kiosco: sin navegación entre páginas, así que se asigna la página
      // al dispositivo para que arranque en ella (como el iPad real).
      const myDeviceId: string = await page.evaluate(() => window.localStorage.getItem('libredeck_device_id'));
      expect(myDeviceId, 'deviceId propio').toBeTruthy();
      await apiJson(request, 'PUT', `/profiles/${profile.id}/assignments`, {
        assignments: { ...initialAsg, [myDeviceId]: pageId },
      });
      await page.goto('/?kiosk=1');
      await dismissWelcome(page);
      await expect(page.getByTestId('bd-kiosk-grid')).toBeVisible({ timeout: 30000 });
      const kkey = page.locator('[data-cy=bd-key]').filter({ hasText: `${tag}-key` }).first();
      await expect(kkey).toBeVisible({ timeout: 10000 });
      const kbox = await kkey.boundingBox();
      expect(kbox, 'la tecla tiene geometría').toBeTruthy();
      const kpt = { x: kbox!.x + kbox!.width / 2, y: kbox!.y + kbox!.height / 2 };
      // Toques directos por coordenadas (sin actionability entre medias):
      // dos locator.tap() seguidos superan la ventana multi-tap de 340 ms.
      const ktap = () => page.touchscreen.tap(kpt.x, kpt.y);

      // 1) Tap simple → click (tras el debounce multi-tap de ~340 ms).
      await ktap();
      await expect(page.locator('.bd-toast')).toContainText(`${tag}-CLICK`, { timeout: 10000 });

      // 2) Doble tap → double (y no el click simple).
      await ktap();
      await ktap();
      await expect(page.locator('.bd-toast')).toContainText(`${tag}-DOUBLE`, { timeout: 10000 });

      // 3) Triple tap → triple.
      await ktap();
      await ktap();
      await ktap();
      await expect(page.locator('.bd-toast')).toContainText(`${tag}-TRIPLE`, { timeout: 10000 });

      // 4) Mantener ~900 ms → long (consume el tap posterior).
      await page.mouse.move(kpt.x, kpt.y);
      await page.mouse.down();
      await page.waitForTimeout(900);
      await page.mouse.up();
      await expect(page.locator('.bd-toast')).toContainText(`${tag}-LONG`, { timeout: 10000 });
    } finally {
      await ctx.close().catch(() => {});
      if (pageId) {
        const btns = await apiJson(request, 'GET', `/buttons?pageId=${pageId}`).catch(() => []);
        for (const b of btns ?? []) {
          await request.delete(`${API}/buttons/${b.id}`, { failOnStatusCode: false }).catch(() => {});
        }
        await request.delete(`${API}/pages/${pageId}`, { failOnStatusCode: false }).catch(() => {});
      }
      if (profile) {
        await request.put(`${API}/profiles/${profile.id}/assignments`, {
          data: { assignments: initialAsg },
          failOnStatusCode: false,
        }).catch(() => {});
      }
      if (origProfile?.value) {
        await request.post(`${API}/settings`, { data: { key: 'current.profile_id', value: origProfile.value } }).catch(() => {});
      }
      if (origPage?.value) {
        await request.post(`${API}/settings`, { data: { key: 'current.page_id', value: origPage.value } }).catch(() => {});
      }
    }
  });
});
