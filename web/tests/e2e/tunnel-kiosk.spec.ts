import { test, expect, type Page } from '@playwright/test';

// E2E de kiosco por túnel (/t/<token>/?kiosk=1) con relay simulado.
// Astro dev (:4321) no tiene la ruta /t/<token>/ (404): se sirve la shell de
// `/` bajo el prefijo, como hace el relay en prod (allí pela /t/<token> y el
// daemon sirve la UI; aquí se reescribe API/config al daemon directo).
// El WS de señalización WebRTC se sustituye por un stub controlable: colgado
// por defecto (la negociación queda en `signaling` y la modal no resuelve
// sola) y con fallo bajo demanda para el caso relay.
// No muta datos: solo navega y pulsa la X del banner (estado local).

const TOKEN = 'a'.repeat(64); // 64-hex como los sessionToken reales
const PREFIX = `/t/${TOKEN}`;
const TUNNEL_URL = `${PREFIX}/?kiosk=1`;

/** Sirve la app bajo /t/<token>/ y reescribe API/config al daemon. */
async function mockTunnelRoute(page: Page) {
  await page.route(`**${PREFIX}/**`, async (route) => {
    const url = new URL(route.request().url());
    const rest = url.pathname.slice(PREFIX.length) || '/';
    try {
      if (rest.startsWith('/api/') || rest === '/config') {
        const res = await route.fetch({ url: `http://localhost:3001${rest}${url.search}` });
        await route.fulfill({ response: res });
        return;
      }
      if (rest === '/' || rest === '') {
        const res = await route.fetch({ url: `http://localhost:4321/${url.search}` });
        await route.fulfill({ body: await res.text(), contentType: 'text/html' });
        return;
      }
      const res = await route.fetch({ url: `http://localhost:4321${rest}${url.search}` });
      await route.fulfill({ response: res });
    } catch {
      await route.abort().catch(() => {});
    }
  });
}

/** WebSocket stub: nunca conecta solo; expone fallo bajo demanda. */
async function stubSignalingWs(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    interface ZzSocket { url: string; sent: string[]; fail: () => void }
    const sockets: ZzSocket[] = [];
    w.__zzSockets = sockets;
    class FakeWS {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = 0;
      readonly url: string;
      onopen: ((...a: unknown[]) => void) | null = null;
      onclose: ((...a: unknown[]) => void) | null = null;
      onmessage: ((...a: unknown[]) => void) | null = null;
      onerror: ((...a: unknown[]) => void) | null = null;
      binaryType = 'blob';
      bufferedAmount = 0;
      extensions = '';
      protocol = '';
      private readonly box: string[] = [];
      constructor(url: string | URL) {
        this.url = String(url);
        const entry: ZzSocket = {
          url: this.url,
          sent: this.box,
          fail: () => {
            this.readyState = 3;
            try { this.onerror?.(new Error('zz-fail')); } catch { /* noop */ }
            try { this.onclose?.({}); } catch { /* noop */ }
          },
        };
        sockets.push(entry);
      }
      send(data: unknown) {
        this.box.push(String(data));
      }
      close() {
        this.readyState = 3;
      }
      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() {
        return false;
      }
    }
    w.WebSocket = FakeWS;
    w.__zzFailTunnelWs = () => {
      for (const s of sockets) {
        try {
          if (s.url.includes('/t/')) s.fail();
        } catch { /* noop */ }
      }
    };
  });
}

async function gotoTunnelKiosk(page: Page) {
  await page.goto(TUNNEL_URL);
  await expect(page.getByTestId('bd-kiosk-grid')).toBeVisible({ timeout: 30000 });
}

test.describe('Túnel en kiosco (relay simulado)', () => {
  test.beforeEach(async ({ page }) => {
    await mockTunnelRoute(page);
    await stubSignalingWs(page);
  });

  test.describe('móvil 390x844', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('la modal sale al entrar y no se solapa con los fijos', async ({ page }) => {
      await gotoTunnelKiosk(page);
      const modal = page.getByTestId('tunnel-connect-dialog');
      await expect(modal).toBeVisible();
      // Durante la prueba (idle|signaling) el proceso vive SOLO en la modal:
      // el banner queda oculto por v-if (cero solape).
      await expect(page.getByTestId('tunnel-transport-banner')).toHaveCount(0);
      await expect(page.getByTestId('bd-kiosk-rtc')).toHaveAttribute('data-transport', /^(probing|connecting)$/);
      // Compacta: ya no es la caja gigante del marco .bd-dlg (640px) que
      // empujaba el grid fuera de la pantalla.
      const modalBox = await modal.boundingBox();
      expect(modalBox?.height).toBeLessThan(300);
      // La modal flota bajo los fijos (antes el <dialog> pintaba arriba del
      // todo, bajo el cluster).
      const exitBox = await page.locator('.bd-kiosk-exit').boundingBox();
      const exitBottom = (exitBox?.y ?? 0) + (exitBox?.height ?? 0);
      expect(modalBox?.y).toBeGreaterThanOrEqual(exitBottom);
      // Espera a signaling (el connect dispara a 1,5 s del montado) para que
      // el cierre manual no lo reactive el propio cambio idle→signaling.
      await expect(page.getByTestId('bd-kiosk-rtc')).toHaveAttribute('data-transport', 'probing');
      await page.getByTestId('tunnel-connect-dismiss').click();
      await expect(modal).toHaveCount(0);
      // Sin estado terminal sigue sin banner; el dot sigue marcando prueba.
      await expect(page.getByTestId('tunnel-transport-banner')).toHaveCount(0);
      await expect(page.getByTestId('bd-kiosk-rtc')).toHaveAttribute('data-transport', 'probing');
    });

    test('al fallar P2P la modal se cierra y queda el banner relay', async ({ page }) => {
      await gotoTunnelKiosk(page);
      const modal = page.getByTestId('tunnel-connect-dialog');
      await expect(modal).toBeVisible();
      await expect(page.getByTestId('tunnel-transport-banner')).toHaveCount(0);
      // connect() dispara a 1,5 s del montado (el grid ya implica montado):
      // espera a que exista el socket de señalización y fúerzale el fallo.
      // Si P2P ya hubiese resuelto solo, las aserciones siguientes valen igual.
      await page.waitForTimeout(2500);
      await page.evaluate(() => {
        ((window as unknown as Record<string, unknown>).__zzFailTunnelWs as () => void)();
      });
      await expect(modal).toHaveCount(0);
      // El stub de WS nunca abre (sin WS vivo el dot marca Desconectado);
      // el banner terminal relay sí sale, bajo el cluster fijo.
      await expect(page.getByTestId('bd-kiosk-rtc')).toHaveAttribute('data-transport', 'disconnected');
      const banner = page.getByTestId('tunnel-transport-banner');
      await expect(banner).toBeVisible();
      await expect(page.getByTestId('tunnel-transport-label')).toContainText(/relay/i);
      const labelBox = await page.getByTestId('tunnel-transport-label').boundingBox();
      const exitBox = await page.locator('.bd-kiosk-exit').boundingBox();
      const exitBottom = (exitBox?.y ?? 0) + (exitBox?.height ?? 0);
      expect(labelBox?.y).toBeGreaterThanOrEqual(exitBottom);
      // La X del banner es pulsable (antes quedaba bajo .bd-kiosk-exit y
      // .bd-kiosk-corner y no recibía el toque).
      await page.getByTestId('tunnel-transport-dismiss').click();
      await expect(banner).toHaveCount(0);
    });
  });

  test('desktop: banner y controles sin solape', async ({ page }) => {
    await gotoTunnelKiosk(page);
    const modal = page.getByTestId('tunnel-connect-dialog');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('tunnel-transport-banner')).toHaveCount(0);
    const modalBox = await modal.boundingBox();
    expect(modalBox?.height).toBeLessThan(300);
    const exitBox = await page.locator('.bd-kiosk-exit').boundingBox();
    const exitBottom = (exitBox?.y ?? 0) + (exitBox?.height ?? 0);
    expect(modalBox?.y).toBeGreaterThanOrEqual(exitBottom);
    await expect(page.getByTestId('bd-kiosk-rtc')).toHaveAttribute('data-transport', 'probing');
    await page.getByTestId('tunnel-connect-dismiss').click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId('tunnel-transport-banner')).toHaveCount(0);
  });
});
