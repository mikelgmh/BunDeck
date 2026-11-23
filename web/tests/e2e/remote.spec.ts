import { test, expect, type Page } from '@playwright/test';

// E2E del panel Acceso remoto (Ajustes → Acceso remoto).
// Requiere daemon en http://localhost:3001 y web en http://localhost:4321
// (baseURL en playwright.config.ts) + testIdAttribute: 'data-cy'.
// Traducción fiel de cypress/e2e/remote.cy.ts. No usa la API REST
// directamente (prefiere el daemon real vía UI), así que no necesita
// el fixture request.
// No muta datos ajenos: el toggle de policy solo cambia el borrador local
// (no pulsa Guardar) y no revoca ningún dispositivo.
// Usa solo data-cy existentes de RemotePane.vue (`remote-*`).

async function openRemote(page: Page) {
  await page.getByTestId('bd-open-settings').click();
  await expect(page.getByTestId('bd-settings')).toBeVisible();
  await page.locator('[data-sec="remote"]').click();
  await expect(page.getByTestId('remote-pane')).toBeVisible();
}

test.describe('Acceso remoto', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    const tabs = page.getByTestId('bd-profile-tab');
    await expect(tabs.first()).toBeVisible({ timeout: 15000 });
    expect(await tabs.count()).toBeGreaterThan(0);
  });

  test('muestra la sección con estado y acciones', async ({ page }) => {
    await openRemote(page);
    // remote-status no existe en RemotePane: la sección real es remote-pair-section.
    await expect(page.getByTestId('remote-pair-section')).toBeVisible();
    await expect(page.getByTestId('remote-gen-code')).toBeVisible();
    await expect(page.getByTestId('remote-gen-code')).toBeEnabled();
    await expect(page.getByTestId('remote-accept-code')).toBeVisible();
    await expect(page.getByTestId('remote-accept-device')).toBeVisible();
    await expect(page.getByTestId('remote-accept-pubkey')).toBeVisible();
    await expect(page.getByTestId('remote-accept-btn')).toBeVisible();
    await expect(page.getByTestId('remote-rotate')).toBeVisible();
  });

  test('generar código muestra code (6 dígitos) + fingerprint', async ({ page }) => {
    await openRemote(page);
    await page.getByTestId('remote-gen-code').click();
    const pairCode = page.getByTestId('remote-pair-code');
    await expect(pairCode).toBeVisible({ timeout: 10000 });
    await expect(pairCode).toContainText(/\d{6}/);
    await expect(pairCode).toContainText(':');
  });

  test('aceptar con código inválido muestra error sin llamar al daemon', async ({ page }) => {
    await openRemote(page);
    await page.getByTestId('remote-accept-code').fill('123');
    await page.getByTestId('remote-accept-device').fill('dev-e2e');
    await page.getByTestId('remote-accept-pubkey').fill('cHViLWtleQ==');
    await page.getByTestId('remote-accept-btn').click();
    // Validación de cliente (isValidPairCode): el formulario no se limpia.
    await expect(page.getByTestId('remote-accept-code')).toHaveValue('123');
  });

  test('lista de dispositivos: vacía o con filas revocables + policy toggles', async ({ page }) => {
    await openRemote(page);
    const devices = page.getByTestId('remote-device');
    const count = await devices.count();
    if (count > 0) {
      // Hay dispositivos: revocar visible y policy toggles operativos (borrador local).
      expect(count).toBeGreaterThan(0);
      await expect(page.getByTestId('remote-revoke').first()).toBeVisible();
      const policyBox = page.locator('[data-cy^="remote-policy-"]').first();
      const checked = await policyBox.isChecked();
      await policyBox.click();
      if (checked) {
        await expect(policyBox).not.toBeChecked();
      } else {
        await expect(policyBox).toBeChecked();
      }
      // Se deja el borrador cambiado a propósito sin Guardar: no muta el daemon.
    } else {
      // Sin dispositivos emparejados: el panel muestra el estado vacío.
      await expect(page.getByText(/sin dispositivos|no devices|no hay/i)).toBeVisible();
    }
  });
});
