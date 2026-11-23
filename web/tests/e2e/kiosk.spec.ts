import { test, expect } from '@playwright/test';

// E2E del modo KIOSCO / PRESENTACIÓN (?kiosk=1).
// Requiere daemon en http://localhost:3001 y web en http://localhost:4321
// (baseURL en playwright.config.ts) + testIdAttribute: 'data-cy'.
// No muta datos: solo navega con el param y sale con confirmación.

test.describe('Modo kiosco', () => {
  test('con ?kiosk=1: solo grid, sin header/drawers/toolbar, con salida', async ({ page }) => {
    await page.goto('/?kiosk=1');
    await expect(page.getByTestId('bd-kiosk-grid')).toBeVisible({ timeout: 30000 });

    await expect(page.locator('header.bd-top')).toHaveCount(0);
    await expect(page.locator('#bd-drw')).toHaveCount(0);
    await expect(page.locator('#bd-ins')).toHaveCount(0);
    await expect(page.locator('.bd-tool')).toHaveCount(0);
    await expect(page.locator('.bd-pages')).toHaveCount(0);

    // El grid de teclas sigue operativo.
    await expect(page.getByTestId('bd-key').first()).toBeVisible();
    // Salida discreta + pantalla completa + zona de triple-tap.
    await expect(page.getByTestId('bd-kiosk-exit')).toBeVisible();
    await expect(page.getByTestId('bd-kiosk-fullscreen')).toBeVisible();
    await expect(page.getByTestId('bd-kiosk-corner')).toHaveCount(1);
  });

  test('?mode=kiosk también entra en kiosco', async ({ page }) => {
    await page.goto('/?mode=kiosk');
    await expect(page.getByTestId('bd-kiosk-grid')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('header.bd-top')).toHaveCount(0);
    await expect(page.getByTestId('bd-kiosk-exit')).toBeVisible();
  });

  test('salir con confirmación restaura la UI y limpia el param', async ({ page }) => {
    await page.goto('/?kiosk=1');
    await expect(page.getByTestId('bd-kiosk-grid')).toBeVisible({ timeout: 30000 });

    await page.getByTestId('bd-kiosk-exit').click();
    const dialog = page.locator('dialog.bd-confirm[open]');
    await expect(dialog).toBeVisible();
    await dialog.locator('.bd-confirm-actions .bd-pri').click();

    await expect(page.locator('header.bd-top')).toBeVisible();
    await expect(page.getByTestId('bd-kiosk-exit')).toHaveCount(0);
    expect(page.url()).not.toContain('kiosk');
  });

  test('Escape pide salir del kiosco (cancelar mantiene el kiosco)', async ({ page }) => {
    await page.goto('/?kiosk=1');
    await expect(page.getByTestId('bd-kiosk-grid')).toBeVisible({ timeout: 30000 });

    await page.keyboard.press('Escape');
    const dialog = page.locator('dialog.bd-confirm[open]');
    await expect(dialog).toBeVisible();
    // Cancelar: sigue en kiosco.
    await dialog.locator('.bd-confirm-actions .bd-btn').first().click();
    await expect(page.getByTestId('bd-kiosk-grid')).toBeVisible();
  });
});
