import { test, expect, type Page } from '@playwright/test';
import { gotoBoard } from './helpers';

// REGRESIÓN BUG1: la modal de aprobación remota ocupaba toda la pantalla.
// Causa: `dialog:modal` del UA fija top:0/bottom:0 + `height:auto` en la
// variante → la caja abspos se estira al alto disponible. El fix es
// `height: fit-content` (igual que sus hermanas `bd-qr`/`bd-ios`).
// Se mide layout REAL en Chromium: con el bug la caja roza el viewport
// (~868px a 900px de alto por el max-height); con el fix es compacta.
// La API remota se mockea a nivel de página (sin relay): no se crea ningún
// fixture en :3001, así que no hay nada que limpiar.

const PENDING = {
  reqId: 'e2e-appr-1',
  urlCode: 'E2EAPPRV',
  ua: 'E2E-Test/1.0 (Playwright)',
  ip: '9.9.9.9',
  createdAt: Date.now(),
};

async function mockRemoteApi(page: Page) {
  await page.route('**/api/v1/remote/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    const json = (data: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.includes('/remote/status')) {
      return json({
        deviceId: 'dev-e2e-qr-height',
        fingerprint: 'ab12:34cd:56ef:78ab:90cd:12ef:34ab:56cd',
        publicKey: 'cHViLWtleQ==',
        relay: { url: '', status: 'disabled' },
        tunnel: { status: 'connected' },
        pending: 1,
        trusted: 0,
        policy: [],
        uiEnabled: true,
      });
    }
    if (url.includes('/remote/devices')) return json({ devices: [] });
    if (url.includes('/remote/ui-pending')) return json({ pending: [PENDING] });
    if (url.includes('/remote/ui-sessions')) return json({ sessions: [] });
    if (url.includes('/remote/ui-code') && method === 'POST') {
      return json({
        code: '123456',
        urlCode: 'E2EAPPRV',
        url: 'https://relay.example.test/ui/E2EAPPRV',
        expiresAt: Date.now() + 600_000,
      });
    }
    // Resto (allow/deny/…): no se usan aquí; respuesta inocua.
    return json({ ok: true });
  });
}

async function dismissWelcome(page: Page) {
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

test.describe('QrDialog aprobación compacta (BUG1)', () => {
  test.describe.configure({ timeout: 120000 });

  test('el diálogo de aprobación no ocupa toda la pantalla', async ({ page }) => {
    await mockRemoteApi(page);
    await gotoBoard(page);
    await dismissWelcome(page);

    await page.locator('[data-cy=bd-open-qr]').click({ timeout: 15000 });
    await expect(page.locator('dialog.bd-qr')).toBeVisible({ timeout: 15000 });

    const approval = page.locator('[data-cy="qr-internet-approval-dialog"]');
    await expect(approval).toBeVisible({ timeout: 15000 });
    // Contenido renderizado (evita un falso positivo con el diálogo vacío).
    await expect(page.locator('[data-cy="qr-internet-approval-allow"]')).toBeVisible({ timeout: 10000 });

    const viewport = page.viewportSize();
    expect(viewport).toBeTruthy();
    const box = await approval.boundingBox();
    expect(box).toBeTruthy();
    // Con el bug: ~868px (max-height 100dvh-32 a 900px de viewport).
    // Con el fix: compacta (<~500px con este contenido).
    expect(box!.height).toBeGreaterThan(50);
    expect(box!.height).toBeLessThan(viewport!.height * 0.8);

    await page.keyboard.press('Escape');
  });
});
