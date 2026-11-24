import { test, expect, type Browser, type APIRequestContext } from '@playwright/test';
import { getRunnerProfile, seedButton } from './helpers';

// Sincronización dispositivo <-> daemon en vivo (sin recargar):
// - asignar pantalla a un navegador la cambia al momento por WS,
// - el kiosco arranca en su página asignada,
// - reconectar aplica la asignación (hello con autoridad),
// - revocar la sesión LAN elimina el navegador,
// - dos navegadores iguales no se ven idénticos.
//
// Requiere daemon en http://localhost:3001 y web en http://localhost:4321.
// Todo lo creado lleva prefijo DS y se limpia en finally (daemon compartido).

const API = 'http://localhost:3001/api/v1';

async function apiJson(request: APIRequestContext, method: string, path: string, data?: any) {
  // El daemon en dev corre con --watch y puede reiniciarse a mitad del test:
  // reintentar errores de conexión en vez de tumbar la prueba.
  let lastErr: any = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res =
        method === 'GET'
          ? await request.get(`${API}${path}`)
          : method === 'POST'
            ? await request.post(`${API}${path}`, data !== undefined ? { data } : undefined)
            : method === 'PUT'
              ? await request.put(`${API}${path}`, data !== undefined ? { data } : undefined)
              : await request.delete(`${API}${path}`);
      if (!res.ok()) throw new Error(`${method} ${path} -> ${res.status()}`);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    } catch (e) {
      // Solo reintentar errores de conexión (ECONNRESET por reinicio con
      // --watch); un HTTP 4xx/5xx es respuesta válida y no se repite (los
      // POST no son idempotentes).
      if (e instanceof Error && /-> \d{3}$/.test(e.message)) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

async function openBoard(browser: Browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId('bd-profile-tab').first()).toBeVisible({ timeout: 30000 });
  // En contextos frescos aparece el diálogo de bienvenida (modal nativo):
  // cerrarlo o bloquea todos los clics de la prueba.
  try {
    const skip = page.getByRole('button', { name: 'Saltar' });
    await skip.waitFor({ state: 'visible', timeout: 3000 });
    await skip.click();
  } catch { /* ya cerrado o no toca */ }
  return { ctx, page };
}

async function ownDeviceId(page: any): Promise<string> {
  return await page.evaluate(() => window.localStorage.getItem('libredeck_device_id'));
}

/** Espera a que el dispositivo aparezca en línea en el listado unificado. */
async function waitDeviceOnline(request: APIRequestContext, deviceId: string, timeout = 15000) {
  await expect
    .poll(
      async () => {
        const devs = await apiJson(request, 'GET', '/devices');
        return (devs as any[]).find((d: any) => d.id === deviceId)?.online === true;
      },
      { timeout },
    )
    .toBe(true);
}

async function deleteDevice(request: APIRequestContext, deviceId: string) {
  try {
    await request.delete(`${API}/devices/${encodeURIComponent(deviceId)}`, { failOnStatusCode: false, timeout: 10000 });
  } catch { /* limpieza mejor-esfuerzo (daemon con --watch puede reiniciarse) */ }
}

test.describe('Sincronización de pantallas entre dispositivos', () => {
  // Dos navegadores + seed de botones + dropdown UI superan los 30 s por
  // defecto en máquinas cargadas; el daemon en dev (--watch) además puede
  // reiniciarse y tumbar una petición suelta (ver reintentos en los tests).
  test.describe.configure({ timeout: 120000 });
  test('asignar pantalla a un navegador la cambia en vivo, sin recargar', async ({
    browser,
    request,
  }) => {
    const tag = `DS-${Date.now().toString(36)}`;
    const profile = await getRunnerProfile(request);
    const origPage = await apiJson(request, 'GET', '/settings?key=current.page_id');
    const origProfile = await apiJson(request, 'GET', '/settings?key=current.profile_id');
    let pageAId = '';
    let pageBId = '';
    let aId = '';
    let bId = '';
    let a: Awaited<ReturnType<typeof openBoard>> | null = null;
    let b: Awaited<ReturnType<typeof openBoard>> | null = null;
    try {
      const mkPage = async (name: string, order: number) => {
        const p = await apiJson(request, 'POST', '/pages', {
          profile_id: profile.id,
          name,
          order_idx: order,
          is_folder: 0,
          data: {},
        });
        await seedButton(request, p.id, `${tag}-${name}`, 0);
        return p.id as string;
      };
      pageAId = await mkPage(`${tag}-A`, 100);
      pageBId = await mkPage(`${tag}-B`, 101);
      // Vista global: perfil runner en la página A.
      await apiJson(request, 'POST', '/settings', { key: 'current.profile_id', value: profile.id });
      await apiJson(request, 'POST', '/settings', { key: 'current.page_id', value: pageAId });

      a = await openBoard(browser);
      b = await openBoard(browser);
      aId = await ownDeviceId(a.page);
      bId = await ownDeviceId(b.page);
      expect(aId, 'A tiene deviceId').toBeTruthy();
      expect(bId, 'B tiene deviceId').toBeTruthy();
      expect(aId).not.toBe(bId);
      await waitDeviceOnline(request, bId);

      // Los navegadores frescos arrancan en su página auto-asignada (la
      // primera raíz compatible), no necesariamente en la global: llevar
      // ambos a la página A con un clic (navegación local) antes de asignar.
      for (const w of [a.page, b.page]) {
        await w.locator('.bd-page .bd-chip', { hasText: `${tag}-A` }).first().click();
      }
      await expect(
        b.page.locator('[data-cy=bd-key]').filter({ hasText: `${tag}-A` }).first(),
      ).toBeVisible({ timeout: 15000 });
      await expect(
        a.page.locator('[data-cy=bd-key]').filter({ hasText: `${tag}-A` }).first(),
      ).toBeVisible({ timeout: 15000 });

      // Asignar B -> página B DESDE LA UI DE A (desplegable de dispositivos).
      await a.page.getByTestId('bd-devices-btn').click();
      await expect(a.page.getByTestId('bd-devices-pop')).toBeVisible({ timeout: 5000 });
      const sel = a.page.getByTestId(`bd-device-page-${bId}`);
      await expect(sel).toBeVisible({ timeout: 10000 });
      const putPromise = a.page.waitForResponse(
        (res: any) => res.url().includes('/assignments') && res.request().method() === 'PUT',
        { timeout: 15000 },
      );
      await sel.selectOption(pageBId);
      const putRes = await putPromise;
      expect(putRes.status()).toBe(200);

      // B cambia solo, sin recargar (empuje WS page.navigate): su chip activo
      // es la página B (los chips listan todas las páginas, no valen para
      // afirmar "ya no se ve A").
      await expect(b.page.getByText(`${tag}-B`).first()).toBeVisible({ timeout: 15000 });
      await expect(
        b.page.locator('.bd-page .bd-chip[aria-pressed="true"]', { hasText: `${tag}-B` }).first(),
      ).toBeVisible({ timeout: 15000 });
      // …y A sigue en su página: la asignación no mueve el global.
      // (Acotar al grid: el desplegable abierto también contiene el texto en un <option> oculto.)
      await expect(
        a.page.locator('[data-cy=bd-key]').filter({ hasText: `${tag}-A` }).first(),
      ).toBeVisible({ timeout: 15000 });
      const cur = await apiJson(request, 'GET', '/settings?key=current.page_id');
      expect(cur?.value, 'el global no se mueve al asignar').toBe(pageAId);
    } finally {
      if (a) await a.ctx.close().catch(() => {});
      if (b) await b.ctx.close().catch(() => {});
      if (bId) await deleteDevice(request, bId);
      if (aId) await deleteDevice(request, aId);
      if (profile) {
        await request
          .put(`${API}/profiles/${profile.id}/assignments`, { data: { assignments: {} }, failOnStatusCode: false })
          .catch(() => {});
      }
      for (const pid of [pageAId, pageBId]) {
        if (pid) {
          const btns = await apiJson(request, 'GET', `/buttons?pageId=${pid}`).catch(() => []);
          for (const btn of btns ?? []) {
            await request.delete(`${API}/buttons/${btn.id}`, { failOnStatusCode: false }).catch(() => {});
          }
          await request.delete(`${API}/pages/${pid}`, { failOnStatusCode: false }).catch(() => {});
        }
      }
      if (origProfile?.value) {
        await request
          .post(`${API}/settings`, { data: { key: 'current.profile_id', value: origProfile.value } })
          .catch(() => {});
      }
      if (origPage?.value) {
        await request
          .post(`${API}/settings`, { data: { key: 'current.page_id', value: origPage.value } })
          .catch(() => {});
      }
    }
  });

  test('el kiosco arranca en su página asignada', async ({ browser, request }) => {
    const tag = `KSK-${Date.now().toString(36)}`;
    const profile = await getRunnerProfile(request);
    const origPage = await apiJson(request, 'GET', '/settings?key=current.page_id');
    const origProfile = await apiJson(request, 'GET', '/settings?key=current.profile_id');
    let pageOtherId = '';
    let pageKioskId = '';
    let kid = '';
    let k: Awaited<ReturnType<typeof openBoard>> | null = null;
    try {
      const mkPage = async (name: string, order: number) => {
        const p = await apiJson(request, 'POST', '/pages', {
          profile_id: profile.id,
          name,
          order_idx: order,
          is_folder: 0,
          data: {},
        });
        await seedButton(request, p.id, `${tag}-${name}`, 0);
        return p.id as string;
      };
      pageOtherId = await mkPage(`${tag}-otra`, 110);
      pageKioskId = await mkPage(`${tag}-kiosco`, 111);
      await apiJson(request, 'POST', '/settings', { key: 'current.profile_id', value: profile.id });
      await apiJson(request, 'POST', '/settings', { key: 'current.page_id', value: pageOtherId });

      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      k = { ctx, page } as any;
      await page.goto('/');
      await expect(page.getByTestId('bd-profile-tab').first()).toBeVisible({ timeout: 30000 });
      kid = await ownDeviceId(page);
      // Asignar a ESTE navegador su página de kiosco y entrar en modo kiosco.
      await apiJson(request, 'PUT', `/profiles/${profile.id}/assignments`, {
        assignments: { [kid]: pageKioskId },
      });
      await page.goto('/?kiosk=1');
      await expect(page.getByText(`${tag}-kiosco`).first()).toBeVisible({ timeout: 20000 });
      await expect(page.getByText(`${tag}-otra`)).toHaveCount(0, { timeout: 10000 });
    } finally {
      if (k) await k.ctx.close().catch(() => {});
      if (kid) await deleteDevice(request, kid);
      if (profile) {
        await request
          .put(`${API}/profiles/${profile.id}/assignments`, { data: { assignments: {} }, failOnStatusCode: false })
          .catch(() => {});
      }
      for (const pid of [pageOtherId, pageKioskId]) {
        if (pid) {
          const btns = await apiJson(request, 'GET', `/buttons?pageId=${pid}`).catch(() => []);
          for (const btn of btns ?? []) {
            await request.delete(`${API}/buttons/${btn.id}`, { failOnStatusCode: false }).catch(() => {});
          }
          await request.delete(`${API}/pages/${pid}`, { failOnStatusCode: false }).catch(() => {});
        }
      }
      if (origProfile?.value) {
        await request
          .post(`${API}/settings`, { data: { key: 'current.profile_id', value: origProfile.value } })
          .catch(() => {});
      }
      if (origPage?.value) {
        await request
          .post(`${API}/settings`, { data: { key: 'current.page_id', value: origPage.value } })
          .catch(() => {});
      }
    }
  });

  test('recargar aplica la asignación (hello con autoridad)', async ({ browser, request }) => {
    const tag = `RCN-${Date.now().toString(36)}`;
    const profile = await getRunnerProfile(request);
    const curPage = await apiJson(request, 'GET', '/settings?key=current.page_id');
    const curProfile = await apiJson(request, 'GET', '/settings?key=current.profile_id');
    let pageAId = '';
    let pageBId = '';
    let bid = '';
    let b: Awaited<ReturnType<typeof openBoard>> | null = null;
    try {
      pageAId = (
        await apiJson(request, 'POST', '/pages', {
          profile_id: profile.id,
          name: `${tag}-A`,
          order_idx: 120,
          is_folder: 0,
          data: {},
        })
      ).id as string;
      await seedButton(request, pageAId, `${tag}-A`, 0);
      pageBId = (
        await apiJson(request, 'POST', '/pages', {
          profile_id: profile.id,
          name: `${tag}-B`,
          order_idx: 121,
          is_folder: 0,
          data: {},
        })
      ).id as string;
      await seedButton(request, pageBId, `${tag}-B`, 0);
      await apiJson(request, 'POST', '/settings', { key: 'current.profile_id', value: profile.id });
      await apiJson(request, 'POST', '/settings', { key: 'current.page_id', value: pageAId });

      b = await openBoard(browser);
      bid = await ownDeviceId(b.page);
      await waitDeviceOnline(request, bid);
      await expect(b.page.getByText(`${tag}-A`).first()).toBeVisible({ timeout: 15000 });

      // Asignar B -> página B y mover el global a A (deriva): al recargar
      // debe mandar la asignación, no el global.
      await apiJson(request, 'PUT', `/profiles/${profile.id}/assignments`, {
        assignments: { [bid]: pageBId },
      });
      await expect(b.page.getByText(`${tag}-B`).first()).toBeVisible({ timeout: 15000 });
      await apiJson(request, 'POST', '/settings', { key: 'current.page_id', value: pageAId });
      await b.page.reload();
      await expect(b.page.getByTestId('bd-profile-tab').first()).toBeVisible({ timeout: 30000 });
      await expect(b.page.getByText(`${tag}-B`).first()).toBeVisible({ timeout: 20000 });
    } finally {
      if (b) await b.ctx.close().catch(() => {});
      if (bid) await deleteDevice(request, bid);
      if (profile) {
        await request
          .put(`${API}/profiles/${profile.id}/assignments`, { data: { assignments: {} }, failOnStatusCode: false })
          .catch(() => {});
      }
      for (const pid of [pageAId, pageBId]) {
        if (pid) {
          const btns = await apiJson(request, 'GET', `/buttons?pageId=${pid}`).catch(() => []);
          for (const btn of btns ?? []) {
            await request.delete(`${API}/buttons/${btn.id}`, { failOnStatusCode: false }).catch(() => {});
          }
          await request.delete(`${API}/pages/${pid}`, { failOnStatusCode: false }).catch(() => {});
        }
      }
      if (curProfile?.value) {
        await request
          .post(`${API}/settings`, { data: { key: 'current.profile_id', value: curProfile.value } })
          .catch(() => {});
      }
      if (curPage?.value) {
        await request
          .post(`${API}/settings`, { data: { key: 'current.page_id', value: curPage.value } })
          .catch(() => {});
      }
    }
  });

  test('revocar la sesión LAN elimina el navegador', async ({ browser, request }) => {
    // OJO: el e2e corre en localhost y el loopback está exento del veto LAN
    // (el anfitrión nunca se bloquea a sí mismo): aquí se verifica la
    // cascada revocación -> fila eliminada, con la pestaña ya cerrada para
    // que el hello de reconexión no la re-registre. El "sin permiso" en
    // remoto está cubierto en daemon (lan-invites.test.ts, cuarentena WS).
    const profile = await getRunnerProfile(request);
    const curPage = await apiJson(request, 'GET', '/settings?key=current.page_id');
    const curProfile = await apiJson(request, 'GET', '/settings?key=current.profile_id');
    let cid = '';
    try {
      const before = (await apiJson(request, 'GET', '/remote/lan-sessions')).sessions ?? [];
      const beforePrefixes = new Set(before.map((s: any) => s.tokenPrefix));
      const inv = await apiJson(request, 'POST', '/remote/lan-invite', { label: 'e2e-sync' });
      expect(inv?.code, 'invitación creada').toBeTruthy();

      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`/?invite=${encodeURIComponent(inv.code)}`);
      await expect(page.getByTestId('bd-profile-tab').first()).toBeVisible({ timeout: 30000 });
      cid = await ownDeviceId(page);
      expect(cid, 'invitado con deviceId').toBeTruthy();
      await waitDeviceOnline(request, cid);

      const after = (await apiJson(request, 'GET', '/remote/lan-sessions')).sessions ?? [];
      const fresh = after.find((s: any) => !beforePrefixes.has(s.tokenPrefix) && !s.revoked);
      expect(fresh, 'sesión canjeada visible').toBeTruthy();

      // Cerrar primero: sin socket vivo no hay re-registro tras el olvido.
      await ctx.close();

      // Al revocar, el navegador desaparece de dispositivos y no vuelve.
      await apiJson(request, 'DELETE', `/remote/lan-sessions/${fresh.tokenPrefix}`);
      await expect
        .poll(
          async () => {
            const devs = (await apiJson(request, 'GET', '/devices')) as any[];
            return devs.some((d: any) => d.id === cid);
          },
          { timeout: 15000 },
        )
        .toBe(false);
      await new Promise((r) => setTimeout(r, 4000));
      {
        const devs = (await apiJson(request, 'GET', '/devices')) as any[];
        expect(devs.some((d: any) => d.id === cid), 'no resucita').toBe(false);
      }
    } finally {
      if (cid) await deleteDevice(request, cid);
      await apiJson(request, 'DELETE', '/remote/lan-invite').catch(() => {});
      if (curProfile?.value) {
        await request
          .post(`${API}/settings`, { data: { key: 'current.profile_id', value: curProfile.value } })
          .catch(() => {});
      }
      if (curPage?.value) {
        await request
          .post(`${API}/settings`, { data: { key: 'current.page_id', value: curPage.value } })
          .catch(() => {});
      }
      void profile;
    }
  });

  test('dos navegadores iguales no se ven idénticos', async ({ browser, request }) => {
    let a: Awaited<ReturnType<typeof openBoard>> | null = null;
    let b: Awaited<ReturnType<typeof openBoard>> | null = null;
    let aid = '';
    let bid = '';
    try {
      a = await openBoard(browser);
      b = await openBoard(browser);
      aid = await ownDeviceId(a.page);
      bid = await ownDeviceId(b.page);
      expect(aid).not.toBe(bid);
      await waitDeviceOnline(request, aid);
      await waitDeviceOnline(request, bid);
      const devs = (await apiJson(request, 'GET', '/devices')) as any[];
      const ra = devs.find((d: any) => d.id === aid);
      const rb = devs.find((d: any) => d.id === bid);
      expect(ra?.name, 'A tiene nombre').toBeTruthy();
      expect(rb?.name, 'B tiene nombre').toBeTruthy();
      expect(ra.name, 'nombres distintos').not.toBe(rb.name);
    } finally {
      if (a) await a.ctx.close().catch(() => {});
      if (b) await b.ctx.close().catch(() => {});
      if (aid) await deleteDevice(request, aid);
      if (bid) await deleteDevice(request, bid);
    }
  });
});
