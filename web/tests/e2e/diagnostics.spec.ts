import { test, expect } from '@playwright/test';

// Sección Ajustes → Registros: estados de servicios + logs del daemon.
// Cubre el diagnóstico del caso "tablet con UI vacía".

test.describe('Registros / diagnóstico', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    const tabs = page.getByTestId('bd-profile-tab');
    await expect(tabs.first()).toBeVisible({ timeout: 15000 });
  });

  test('la sección Registros está justo antes de Acerca de y muestra servicios + logs', async ({
    page,
  }) => {
    await page.getByTestId('bd-open-settings').click();
    await expect(page.getByTestId('bd-settings')).toBeVisible();

    // Orden del nav: Registros existe y va antes de Acerca de.
    const ids = await page
      .locator('[data-sec]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-sec')));
    expect(ids).toContain('logs');
    expect(ids.indexOf('logs')).toBeLessThan(ids.indexOf('about'));

    await page.locator('[data-sec="logs"]').click();
    await expect(page.getByTestId('diagnostics-pane')).toBeVisible();

    // Estados: API y WS siempre se evalúan (OK o Error, nunca vacío).
    const api = page.getByTestId('diagnostics-status-api');
    await expect(api).toBeVisible({ timeout: 15000 });
    await expect(api).toContainText(/OK|Error/);
    await expect(page.getByTestId('diagnostics-status-ws')).toBeVisible();
    await expect(page.getByTestId('diagnostics-status-ws')).toContainText(/OK|Error/);
    await expect(page.getByTestId('diagnostics-status-profiles')).toContainText(/perfiles|profiles|Error/);
    await expect(page.getByTestId('diagnostics-status-plugins')).toBeVisible();

    // Actualizar vuelve a evaluar sin romper.
    await page.getByTestId('diagnostics-refresh').click();
    await expect(page.getByTestId('diagnostics-status-api')).toContainText(/OK|Error/);

    // Logs: lista o mensaje de vacío (el daemon siempre responde una de las dos).
    const logs = page.getByTestId('diagnostics-logs');
    const empty = page.getByTestId('diagnostics-logs-empty');
    await expect(logs.or(empty)).toBeVisible({ timeout: 15000 });

    // Filtro por nivel no rompe la vista.
    await page.getByTestId('diagnostics-level').selectOption('error');
    await expect(logs.or(empty)).toBeVisible({ timeout: 15000 });
  });
});
