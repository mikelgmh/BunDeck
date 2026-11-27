import { test, expect, type Page } from '@playwright/test';
import { gotoBoard } from './helpers';

// E2E de los avisos del QR por internet según la causa del relay.
// La API remota se mockea a nivel de página (sin relay ni daemon real):
// se varía `relay.auth` en /remote/status y se comprueba el mensaje
// y la acción que muestra QrDialog. No crea fixtures ni muta datos.

type AuthCause = 'ok' | 'auth-required' | 'invalid-token' | 'rate-limited' | 'unreachable' | 'unsupported';

function statusFor(auth: AuthCause) {
  return {
    deviceId: 'dev-e2e-relay-link',
    fingerprint: 'ab12:34cd:56ef:78ab:90cd:12ef:34ab:56cd',
    publicKey: 'cHViLWtleQ==',
    relay: {
      url: 'wss://relay.example.test',
      status: auth === 'ok' ? 'connected' : 'disconnected',
      auth,
      deviceLinked: auth === 'ok',
    },
    tunnel: { status: auth === 'ok' ? 'connected' : 'disconnected' },
    pending: 0,
    trusted: 0,
    policy: [],
    uiEnabled: true,
  };
}

async function mockStatus(page: Page, auth: AuthCause) {
  await page.route('**/api/v1/remote/**', async (route) => {
    const url = route.request().url();
    const json = (data: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.includes('/remote/status')) return json(statusFor(auth));
    if (url.includes('/remote/devices')) return json({ devices: [] });
    if (url.includes('/remote/ui-pending')) return json({ pending: [] });
    if (url.includes('/remote/ui-sessions')) return json({ sessions: [] });
    return json({ ok: true });
  });
}

async function openInternetTab(page: Page) {
  await gotoBoard(page);
  await page.locator('[data-cy=bd-open-qr]').click({ timeout: 15000 });
  await expect(page.locator('dialog.bd-qr')).toBeVisible({ timeout: 15000 });
  await page.locator('[data-cy=qr-tab-internet]').click();
}

async function dismissWelcome(page: Page) {
  try {
    await page.evaluate(() => {
      try { window.localStorage.setItem('bundeck:welcome-seen', '1'); } catch { /* noop */ }
      const d = document.querySelector('[data-cy=bd-welcome]') as any;
      try { if (d && d.open) d.close(); } catch { /* noop */ }
    });
  } catch { /* noop */ }
}

test.describe('QrDialog causas del relay', () => {
  test.describe.configure({ timeout: 120000 });

  const cases: Array<{ auth: AuthCause; span: string; action?: string }> = [
    { auth: 'auth-required', span: 'relay-auth-required', action: 'qr-relay-link-now' },
    { auth: 'invalid-token', span: 'relay-invalid-token', action: 'qr-relay-link-now' },
    { auth: 'rate-limited', span: 'relay-rate-limited', action: 'qr-relay-retry' },
    { auth: 'unreachable', span: 'relay-unreachable' },
    { auth: 'unsupported', span: 'relay-unsupported' },
  ];

  for (const { auth, span, action } of cases) {
    test(`causa ${auth} muestra su aviso${action ? ' y acción' : ''}`, async ({ page }) => {
      await mockStatus(page, auth);
      await openInternetTab(page);
      await dismissWelcome(page);
      await expect(page.locator('[data-cy="qr-internet-tunnel-down"]')).toBeVisible({ timeout: 15000 });
      await expect(page.locator(`[data-cy="${span}"]`)).toBeVisible({ timeout: 10000 });
      if (action) {
        await expect(page.locator(`[data-cy="${action}"]`)).toBeVisible();
      }
      await page.keyboard.press('Escape');
    });
  }

  test('relay ok no muestra aviso de túnel', async ({ page }) => {
    await mockStatus(page, 'ok');
    await openInternetTab(page);
    await dismissWelcome(page);
    await expect(page.locator('[data-cy="qr-internet-tunnel-down"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });
});
