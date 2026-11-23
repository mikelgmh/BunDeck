import { test, expect, type Page } from '@playwright/test';

// E2E del Catálogo de plugins (Ajustes → Plugins → Catálogo).
// Requiere daemon en http://localhost:3001 y web en http://localhost:4321
// (baseURL en playwright.config.ts) + testIdAttribute: 'data-cy'.
// Traducción fiel de cypress/e2e/catalog.cy.ts. No usa la API REST
// directamente, así que no necesita el fixture request.
// Usa solo data-cy existentes de PluginCatalog.vue (`bd-catalog*`) y de
// SettingsDialog/PluginsPane para navegar ([data-sec], bd-plugins).
// No asume idioma: acepta etiquetas en es/en (Catálogo/Catalog).

async function openCatalog(page: Page) {
  await page.getByTestId('bd-open-settings').click();
  await expect(page.getByTestId('bd-settings')).toBeVisible();
  // Ajustes → Plugins (nav lateral con data-sec).
  await page.locator('[data-sec="plugins"]').click();
  await expect(page.getByTestId('bd-plugins')).toBeVisible();
  // PluginsPane: pestaña Catálogo (sin data-cy propio: por texto es/en).
  await page.getByTestId('bd-plugins').getByText(/Catálogo|Catalog/).click();
  await expect(page.getByTestId('bd-catalog')).toBeVisible();
}

test.describe('Catálogo de plugins', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // La app cargó cuando hay pestañas de perfil.
    const tabs = page.getByTestId('bd-profile-tab');
    await expect(tabs.first()).toBeVisible({ timeout: 15000 });
    expect(await tabs.count()).toBeGreaterThan(0);
  });

  test('lista los plugins del catálogo del daemon', async ({ page }) => {
    await openCatalog(page);
    await expect(page.getByTestId('bd-catalog-search')).toBeVisible();
    await expect(page.getByTestId('bd-catalog-category')).toBeVisible();
    const items = page.getByTestId('bd-catalog-item');
    await expect(items.first()).toBeVisible({ timeout: 10000 });
    expect(await items.count()).toBeGreaterThan(0);
  });

  test('buscar filtra la lista y limpiar restaura', async ({ page }) => {
    await openCatalog(page);
    const items = page.getByTestId('bd-catalog-item');
    await expect(items.first()).toBeVisible({ timeout: 10000 });
    const total = await items.count();
    expect(total).toBeGreaterThan(0);

    const search = page.getByTestId('bd-catalog-search');
    await search.fill('obs');
    // Al menos el plugin OBS sigue visible…
    expect(await items.count()).toBeGreaterThan(0);
    expect(await items.count()).toBeLessThan(total + 1);
    await expect(page.locator('[data-cy="bd-catalog-item"]', { hasText: /OBS/i }).first()).toBeVisible();
    // …y al limpiar vuelve la lista completa.
    await search.fill('');
    expect(await items.count()).toBe(total);
  });

  test('el toggle de categoría filtra y "todas" restaura', async ({ page }) => {
    await openCatalog(page);
    const items = page.getByTestId('bd-catalog-item');
    await expect(items.first()).toBeVisible({ timeout: 10000 });
    const total = await items.count();
    expect(total).toBeGreaterThan(0);

    // 'system' es una categoría conocida del catálogo (CATALOG_CATEGORIES).
    const category = page.getByTestId('bd-catalog-category');
    await category.selectOption('system');
    expect(await items.count()).toBeGreaterThan(0);
    expect(await items.count()).toBeLessThan(total + 1);
    // Volver a "todas" restaura el total.
    await category.selectOption('all');
    expect(await items.count()).toBe(total);
  });

  test('el botón Activar/Desactivar cambia el estado (y se revierte)', async ({ page }) => {
    await openCatalog(page);
    // Solo plugins instalados tienen botón toggle (data-cy bd-catalog-toggle-<id>).
    const toggle = page.locator('[data-cy^="bd-catalog-toggle-"]').first();
    await expect(toggle).toBeVisible({ timeout: 10000 });
    await expect(toggle).toBeEnabled();

    const before = (await toggle.innerText()).trim();
    await toggle.click();
    // El estado cambia: el texto del botón debe cambiar tras el toggle.
    await expect
      .poll(async () => (await toggle.innerText()).trim(), { timeout: 10000 })
      .not.toBe(before);
    // Revertir para dejar el daemon como estaba.
    await toggle.click();
    await expect
      .poll(async () => (await toggle.innerText()).trim(), { timeout: 10000 })
      .toBe(before);
  });
});
