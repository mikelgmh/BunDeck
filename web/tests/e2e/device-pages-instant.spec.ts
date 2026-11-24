import { test, expect } from '@playwright/test';

const API = 'http://localhost:3001/api/v1';
const RUNNER_PROFILE = 'E2E Runner';

async function dismissWelcome(pg: any) {
  try {
    const skip = pg.getByRole('button', { name: 'Saltar' });
    await skip.waitFor({ state: 'visible', timeout: 3000 });
    await skip.click();
  } catch { /* ya cerrado o no toca */ }
}

async function apiProfile(request: any) {
  const res = await request.get(`${API}/profiles`);
  expect(res.ok()).toBeTruthy();
  const profiles = await res.json();
  const profile = profiles.find((p: any) => p.name === RUNNER_PROFILE);
  expect(profile, 'perfil E2E Runner existe (global-setup)').toBeTruthy();
  return profile;
}

async function waitForDevice(request: any, deviceId: string) {
  // El daemon crea la fila + sesión al `hello` del WS: esperar a verlo online.
  // Tolerante a reinicios del daemon en dev (--watch): un ECONNRESET aislado
  // no debe tumbar el test.
  for (let i = 0; i < 60; i++) {
    try {
      const res = await request.get(`${API}/devices`, { failOnStatusCode: false, timeout: 10000 });
      if (res.ok()) {
        const devices = await res.json();
        const found = devices.find((d: any) => d.id === deviceId);
        if (found?.online) return found;
      }
    } catch { /* reintentar: daemon reiniciando o socket ocupado */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`el dispositivo ${deviceId} no apareció online en /devices`);
}

test('asignar página al segundo dispositivo navega al instante por WS', async ({ page, request, browser }) => {
  test.slow();
  const profile = await apiProfile(request);

  // Segunda ventana/pestaña: contexto aislado = deviceId distinto.
  const guestCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const guest = await guestCtx.newPage();
  try {
    await page.goto('/');
    await dismissWelcome(page);
    await expect(page.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 30000 });
    await guest.goto('/');
    await dismissWelcome(guest);
    await expect(guest.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 30000 });

    const hostDeviceId = await page.evaluate(() => localStorage.getItem('libredeck_device_id'));
    const guestDeviceId: string = await guest.evaluate(() => localStorage.getItem('libredeck_device_id'));
    expect(hostDeviceId, 'host tiene deviceId').toBeTruthy();
    expect(guestDeviceId, 'guest tiene deviceId').toBeTruthy();
    expect(guestDeviceId).not.toBe(hostDeviceId);

    await waitForDevice(request, guestDeviceId);
    await waitForDevice(request, hostDeviceId as string);

    const homeName = (await page.locator('.bd-page .bd-chip[aria-pressed="true"]').first().innerText({ timeout: 15000 })).trim();

    // Página destino creada por API (como haría el host desde la UI).
    const targetName = `E2E iPad ${Date.now() % 100000}`;
    const created = await request.post(`${API}/pages`, {
      data: { profile_id: profile.id, name: targetName, order_idx: 99, is_folder: 0, data: {} },
    });
    expect(created.status()).toBe(201);
    const target = await created.json();

    try {
      // El guest aún no la conoce: esperar a que el WS page.created la traiga.
      await expect(guest.locator('.bd-page .bd-chip', { hasText: targetName })).toBeAttached({ timeout: 15000 });

      // Asignar al guest (equivale al desplegable de dispositivos del host).
      const put = await request.put(`${API}/profiles/${profile.id}/assignments`, {
        data: { assignments: { [guestDeviceId]: target.id } },
      });
      expect(put.status()).toBe(200);

      // El guest cambia AL INSTANTE sin recargar; el host se queda donde estaba.
      await expect(guest.locator('.bd-page .bd-chip[aria-pressed="true"]').filter({ hasText: targetName }).first()).toBeVisible({ timeout: 10000 });
      await expect(page.locator('.bd-page .bd-chip[aria-pressed="true"]').filter({ hasText: homeName }).first()).toBeVisible({ timeout: 10000 });

      // La asignación persiste en el daemon.
      const asg = await (await request.get(`${API}/profiles/${profile.id}/assignments`)).json();
      expect(asg.assignments?.[guestDeviceId]).toBe(target.id);
    } finally {
      try {
        await request.delete(`${API}/pages/${target.id}`, { failOnStatusCode: false });
      } catch { /* timeout: limpieza en el siguiente run */ }
      try {
        await request.put(`${API}/profiles/${profile.id}/assignments`, {
          data: { assignments: { [guestDeviceId]: null } },
          failOnStatusCode: false,
        });
      } catch { /* noop */ }
    }
  } finally {
    await guestCtx.close();
  }
});

test('enlace de invitación local da acceso y la asignación navega al instante', async ({ page, request, browser }) => {
  test.slow();
  const profile = await apiProfile(request);

  // El anfitrión (loopback) genera el enlace de invitación local.
  const inviteRes = await request.post(`${API}/remote/lan-invite`, { data: { label: 'e2e-ipad' } });
  expect(inviteRes.status()).toBe(200);
  const invite = await inviteRes.json();
  const code: string = invite.code ?? invite.invite ?? '';
  expect(code, 'código de invitación generado').toBeTruthy();

  const guestCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const guest = await guestCtx.newPage();
  try {
    // El invitado entra con el enlace (código de un solo uso): sin "Sin permiso".
    // Sin kiosk=1 para poder afirmar sobre los chips de página como en el otro test.
    await guest.goto(`/?invite=${encodeURIComponent(code)}`);
    await dismissWelcome(guest);
    await expect(guest.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 30000 });
    await expect(guest.locator('[data-cy=lan-denied]')).toHaveCount(0);

    const guestDeviceId: string = await guest.evaluate(() => localStorage.getItem('libredeck_device_id'));
    expect(guestDeviceId).toBeTruthy();
    await waitForDevice(request, guestDeviceId);

    const targetName = `E2E Invite ${Date.now() % 100000}`;
    const created = await request.post(`${API}/pages`, {
      data: { profile_id: profile.id, name: targetName, order_idx: 99, is_folder: 0, data: {} },
    });
    expect(created.status()).toBe(201);
    const target = await created.json();
    try {
      await expect(guest.locator('.bd-page .bd-chip', { hasText: targetName })).toBeAttached({ timeout: 15000 });
      const put = await request.put(`${API}/profiles/${profile.id}/assignments`, {
        data: { assignments: { [guestDeviceId]: target.id } },
      });
      expect(put.status()).toBe(200);
      await expect(guest.locator('.bd-page .bd-chip[aria-pressed="true"]').filter({ hasText: targetName }).first()).toBeVisible({ timeout: 10000 });
    } finally {
      await request.delete(`${API}/pages/${target.id}`, { failOnStatusCode: false });
      await request.put(`${API}/profiles/${profile.id}/assignments`, {
        data: { assignments: { [guestDeviceId]: null } },
        failOnStatusCode: false,
      });
    }
  } finally {
    await guestCtx.close();
    await request.delete(`${API}/remote/lan-invite`, { failOnStatusCode: false });
  }
});
