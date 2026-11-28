import { test, expect } from '@playwright/test';
import { gotoBoard, API_BASE } from './helpers';

// Pantalla por dispositivo (brillo HW + dim + idle):
// - la API persiste por dispositivo (devices.<id>.*) y valida,
// - Ajustes → Dispositivos ya no muestra orientación y ofrece brillo HW,
//   atenuar e idle por dispositivo con inputs numéricos,
// - Apariencia ofrece el brillo de la interfaz (antes en Dispositivos).
//
// Requiere daemon en http://localhost:3001 y web en http://localhost:4321
// YA LEVANTADOS (como el resto de la suite Playwright).

test.describe('Pantalla por dispositivo (brillo + dim + idle)', () => {
  test('la API guarda por dispositivo, aísla y valida', async ({ request }) => {
    const put = (device: string, body: Record<string, unknown>) =>
      request.post(`${API_BASE}/devices/streamdeck/display`, { data: { device, ...body } });

    const res = await put('e2e-dd-1', {
      brightness: 61,
      dimAfterSec: 120,
      idleMinutes: 5,
      idleAction: 'dim',
    });
    expect(res.ok(), `POST display -> ${res.status()}`).toBe(true);
    expect(await res.json()).toMatchObject({
      device: 'e2e-dd-1',
      brightness: 61,
      dimAfterSec: 120,
      idleMinutes: 5,
      idleAction: 'dim',
    });

    const get = await request.get(`${API_BASE}/devices/streamdeck/display?device=e2e-dd-1`);
    expect(get.ok()).toBe(true);
    expect(await get.json()).toMatchObject({ brightness: 61, idleAction: 'dim' });

    // Otro dispositivo no se pisa: virgen → dim/idle desactivados (0/0).
    const other = await request.get(`${API_BASE}/devices/streamdeck/display?device=e2e-dd-2`);
    expect(other.ok()).toBe(true);
    expect(await other.json()).toMatchObject({
      brightness: 100,
      dimAfterSec: 0,
      idleMinutes: 0,
      idleAction: 'off',
    });

    // Validación: acción desconocida → 400.
    const bad = await put('e2e-dd-1', { idleAction: 'fiesta' });
    expect(bad.status()).toBe(400);

    // Limpieza: devolver defaults (dim/idle off) para no contaminar el daemon compartido.
    await put('e2e-dd-1', { brightness: 100, dimAfterSec: 0, idleMinutes: 0, idleAction: 'off' });
    await put('e2e-dd-2', { brightness: 100, dimAfterSec: 0, idleMinutes: 0, idleAction: 'off' });
  });

  test('Ajustes: sin orientación, brillo HW por dispositivo y brillo de interfaz', async ({
    page,
  }) => {
    await gotoBoard(page);
    await page.getByTestId('bd-open-settings').click();
    await expect(page.getByTestId('bd-settings')).toBeVisible();

    await page.locator('[data-sec="devices"]').click();
    // La orientación por modelo desapareció (cada modelo trae su grid).
    await expect(page.getByText('Gira el panel si lo colocas')).toHaveCount(0);
    await expect(page.getByText('Rotate the board')).toHaveCount(0);
    // Controles HW por dispositivo (deshabilitados sin deck, pero visibles).
    await expect(page.getByTestId('bd-hw-brightness')).toBeVisible();
    await expect(page.getByTestId('bd-hw-dim-min')).toBeVisible();
    await expect(page.getByTestId('bd-hw-idle-action')).toBeVisible();
    await expect(page.getByTestId('bd-hw-idle-min')).toBeVisible();

    // Apariencia: el brillo de la interfaz vive aquí (no toca el hardware).
    await page.locator('[data-sec="appearance"]').click();
    await expect(page.getByTestId('bd-ui-brightness')).toBeVisible();

    await page.keyboard.press('Escape');
  });
});
