import { test, expect } from '@playwright/test';
import { collapseLeftPanel } from './helpers';

// Requiere en playwright.config.ts:
//   use: { baseURL: 'http://localhost:4321', testIdAttribute: 'data-cy' }
// para que getByTestId() resuelva los atributos data-cy de la app
// y page.goto('/') use la baseURL. Daemon esperado en http://localhost:3001.

test.describe('BunDeck E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should load the main page', async ({ page }) => {
    await expect(page.locator('.bd-brand')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.bd-brand')).toContainText('BunDeck');
  });

  test('should load the application interface', async ({ page }) => {
    await expect(page.locator('body')).toBeVisible();

    // Profile tabs must appear once profiles load
    const tabs = page.getByTestId('bd-profile-tab');
    await expect(tabs.first()).toBeVisible({ timeout: 10000 });
    expect(await tabs.count()).toBeGreaterThan(0);

    // Header buttons
    await expect(page.getByTestId('bd-open-plugins')).toBeVisible();
    await expect(page.getByTestId('bd-open-qr')).toBeVisible();
    await expect(page.getByTestId('bd-open-settings')).toBeVisible();
  });

  test('should allow profile selection', async ({ page }) => {
    const tabs = page.getByTestId('bd-profile-tab');
    await expect(tabs.first()).toBeVisible({ timeout: 10000 });
    expect(await tabs.count()).toBeGreaterThan(0);

    // Click the first profile tab: it becomes the selected tab
    await tabs.first().click();
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  });

  test('should allow creating a new button', async ({ page }) => {
    const tabs = page.getByTestId('bd-profile-tab');
    await expect(tabs.first()).toBeVisible({ timeout: 10000 });
    await collapseLeftPanel(page);

    // Select a key slot: the inspector shows the title field
    await page.getByTestId('bd-key').first().click();
    await expect(page.getByTestId('bd-key-title')).toBeVisible({ timeout: 5000 });

    // Fill in the key title (inspector autosaves via debounce, no save button)
    await page.getByTestId('bd-key-title').fill('Test Button');

    // Key label should be visible on the board (might take a moment to update)
    await expect(page.getByText('Test Button')).toBeVisible({ timeout: 10000 });
  });

  test('should allow adding actions to buttons', async ({ page }) => {
    await expect(page.getByTestId('bd-profile-tab').first()).toBeVisible({ timeout: 10000 });
    await collapseLeftPanel(page);

    // Select a key (con el panel plegado el grid no queda tapado)
    await page.getByTestId('bd-key').first().click();
    await expect(page.getByTestId('bd-key-title')).toBeVisible({ timeout: 5000 });

    // Reabrir biblioteca para pulsar la acción
    await page.getByTestId('bd-expand-left').click();
    await expect(page.getByTestId('bd-action-item').first()).toBeVisible({ timeout: 5000 });

    // Clicking a library action adds it to the selected key
    await page.getByTestId('bd-action-item').first().click();

    // Action should appear in the inspector list
    const rows = page.getByTestId('bd-action-row');
    await expect(rows.first()).toBeVisible({ timeout: 5000 });
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test('should switch between edit and use mode', async ({ page }) => {
    await expect(page.getByTestId('bd-profile-tab').first()).toBeVisible({ timeout: 10000 });

    // Use mode shows the "use mode" empty state in the inspector
    await page.getByRole('button', { name: 'Usar', exact: true }).click();
    await expect(page.getByText('Modo uso')).toBeVisible();

    // Back to edit mode
    await page.getByRole('button', { name: 'Editar', exact: true }).click();
    await expect(page.getByText('Elige una tecla')).toBeVisible();
  });

  test('should support multiple pages', async ({ page, request }) => {
    await expect(page.getByTestId('bd-profile-tab').first()).toBeVisible({ timeout: 10000 });

    // Add a new page (created with a default name)
    const pageCreated = page.waitForResponse(
      (res) => res.url().includes('/api/v1/pages') && res.request().method() === 'POST',
    );
    await page.getByTestId('bd-page-add').click();

    // The new page chip appears and becomes active (puede haber varias).
    await expect(page.getByText(/Página/).first()).toBeVisible({ timeout: 10000 });

    // Limpieza: borrar la página creada para no dejar residuos en la DB
    // del usuario (el spec Cypress original no limpiaba).
    try {
      const res = await pageCreated;
      const body = await res.json().catch(() => null);
      const pageId = (body as any)?.id;
      if (pageId) {
        await request.delete(`http://localhost:3001/api/v1/pages/${encodeURIComponent(pageId)}`);
      }
    } catch { /* mejor esfuerzo: el sweep global lo cubre */ }
  });

  test('should rename a page from its context menu', async ({ page }) => {
    await expect(page.getByTestId('bd-profile-tab').first()).toBeVisible({ timeout: 10000 });

    // Open the per-page menu (three dots) on the first page
    await page.locator('.bd-pagemenu-btn').first().click();
    await page.getByRole('menuitem', { name: /Renombrar/ }).click();

    // Inline input appears: rename and confirm with Enter
    const input = page.getByTestId('bd-page-rename-input');
    await input.fill('Principal');
    await input.press('Enter');

    // The chip shows the new name (puede haber varias páginas viejas).
    await expect(page.getByText('Principal').first()).toBeVisible();
  });

  test('should support language switching', async ({ page }) => {
    await expect(page.getByTestId('bd-profile-tab').first()).toBeVisible({ timeout: 10000 });

    // Inspector empty state in Spanish
    await expect(page.getByText('Elige una tecla')).toBeVisible();

    // Language lives in Settings → General
    await page.getByTestId('bd-open-settings').click();
    await page.getByTestId('bd-language-select').selectOption('en');

    // UI text should re-render in English inside the dialog
    await expect(page.getByTestId('bd-settings').getByText('Settings')).toBeVisible();
  });

  test('should open plugins, QR and icon dialogs', async ({ page }) => {
    await expect(page.getByTestId('bd-profile-tab').first()).toBeVisible({ timeout: 10000 });

    // Plugins vive ahora en Ajustes → Plugins (debajo de Apariencia)
    await page.getByTestId('bd-open-plugins').click();
    await expect(page.getByTestId('bd-settings')).toBeVisible();
    await expect(page.getByTestId('bd-plugins')).toBeVisible();
    await expect(page.getByTestId('bd-settings').getByText('Instalados')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByTestId('bd-open-qr').click();
    await expect(page.getByText('Abrir en el móvil')).toBeVisible();
  });
});
