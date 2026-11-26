import { test, expect, type Page } from '@playwright/test';

// Barra inferior del kiosco (#kbar): pill flotante en desktop, absoluta
// sobre el grid en móvil (<=640px), colapsable en todos los viewports y
// marquee infinito solo con overflow real (con fades) o fijo sin fades.

async function kbarReport(page: Page, tag: string) {
  try { await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2000))])) } catch { /* noop */ }
  const r = await page.evaluate(() => {
    const bar = document.querySelector('#kbar') as HTMLElement | null;
    const marq = document.querySelector('#kmarq') as HTMLElement | null;
    const g = document.querySelector('#kmarq .kmarquee-group') as HTMLElement | null;
    const t = document.querySelector('#kmarq .kmarquee-group > span') as HTMLElement | null;
    const toggle = document.querySelector('[data-cy="bd-kiosk-barcollapse"]') as HTMLElement | null;
    if (!bar || !marq) return null;
    const b = bar.getBoundingClientRect();
    const cs = getComputedStyle(bar);
    const ms = getComputedStyle(marq);
    const gs = g ? getComputedStyle(g) : null;
    return {
      bar: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      vw: window.innerWidth, vh: window.innerHeight,
      position: cs.position, radius: cs.borderRadius,
      collapsed: bar.classList.contains('is-collapsed'),
      static: marq.classList.contains('is-static'),
      mask: ms.maskImage || (ms as unknown as Record<string, string>).webkitMaskImage || 'none',
      anim: gs?.animationName ?? 'n/a',
      toggleCount: document.querySelectorAll('[data-cy="bd-kiosk-barcollapse"]').length,
      toggleAria: toggle?.getAttribute('aria-expanded'),
      textOverflow: t ? t.scrollWidth > (marq as HTMLElement).clientWidth + 1 : null,
    };
  });
  console.log(tag + ' ' + JSON.stringify(r));
  return r;
}

async function dismissWelcome(page: Page) {
  // En contextos frescos aparece el diálogo de bienvenida (modal nativo)
  // segundos después del load y bloquea los clics: cerrar por JS (y marcar
  // visto) funcione esté abierto o no, sin esperas.
  try {
    await page.evaluate(() => {
      try { window.localStorage.setItem('bundeck:welcome-seen', '1'); } catch { /* noop */ }
      const d = document.querySelector('[data-cy=bd-welcome]') as { open?: boolean; close?: () => void } | null;
      try { if (d && d.open) d.close?.(); } catch { /* noop */ }
    });
  } catch { /* ya cerrado o no toca */ }
}

test.describe('Barra del kiosco', () => {
  test('desktop: pill flotante centrada, marquee estático sin fades, colapso funciona', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/?kiosk=1');
    await expect(page.getByTestId('bd-kiosk-grid')).toBeVisible({ timeout: 30000 });
    await dismissWelcome(page);
    const r = await kbarReport(page, 'DESKTOP');
    expect(r?.position).toBe('fixed');
    expect(r?.radius).toBe('999px');
    expect(r?.toggleCount).toBe(1);
    // Caja ancha: el texto corto cabe → estático sin fades (invariante).
    expect(r?.textOverflow).toBe(false);
    expect(r?.static).toBe(true);
    expect(r?.mask).toBe('none');
    expect(r?.anim).toBe('none');
    const left = r!.bar.x;
    const right = r!.vw - (r!.bar.x + r!.bar.w);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(4);
    await page.getByTestId('bd-kiosk-barcollapse').click();
    await page.waitForTimeout(400);
    expect(await page.locator('#kbar.is-collapsed').count()).toBe(1);
    expect(await page.getByTestId('bd-kiosk-barcollapse').getAttribute('aria-expanded')).toBe('false');
    await page.getByTestId('bd-kiosk-barcollapse').click();
    await page.waitForTimeout(400);
    expect(await page.locator('#kbar.is-collapsed').count()).toBe(0);
  });

  test('móvil 390: absoluta sobre el grid, invariantes scroll⟺overflow, colapso', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?kiosk=1');
    await expect(page.getByTestId('bd-kiosk-grid')).toBeVisible({ timeout: 30000 });
    await dismissWelcome(page);
    const r1 = await kbarReport(page, 'MOB');
    expect(r1?.position).toBe('absolute');
    expect(r1?.toggleCount).toBe(1);
    // Invariantes (el texto por defecto puede o no desbordar a 390 según
    // fuentes/dispositivo): scroll ⟺ overflow, fades ⟺ scroll.
    expect(r1?.static).toBe(!r1?.textOverflow);
    expect(r1?.mask === 'none').toBe(!!r1?.static);
    expect(r1?.anim === 'none').toBe(!!r1?.static);
    await page.getByTestId('bd-kiosk-barcollapse').click();
    await page.waitForTimeout(400);
    const r2 = await kbarReport(page, 'MOB-COLLAPSED');
    expect(r2?.collapsed).toBe(true);
    expect(r2?.toggleAria).toBe('false');
    await page.getByTestId('bd-kiosk-barcollapse').click();
    await page.waitForTimeout(400);
    expect(await page.locator('#kbar.is-collapsed').count()).toBe(0);
  });

  test('móvil 390 con página larga: overflow real → marquee continuo con fades', async ({ page, request }) => {
    const { getRunnerProfile, getPages } = await import('./helpers');
    const profile = await getRunnerProfile(request);
    const pages = await getPages(request, profile.id);
    const first = pages[0];
    const origName = (first as { name?: string }).name ?? '';
    const longName = 'Página de demostración con un nombre muy largo';
    try {
      const put = await request.put(`http://localhost:3001/api/v1/pages/${first.id}`, { data: { name: longName } });
      if (!put.ok()) throw new Error(`PUT page -> ${put.status()}`);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/?kiosk=1');
      await expect(page.getByTestId('bd-kiosk-grid')).toBeVisible({ timeout: 30000 });
      await dismissWelcome(page);
      await expect(page.locator('#kmarq:not(.is-static)')).toBeVisible({ timeout: 10000 });
      const r = await kbarReport(page, 'LONG');
      expect(r?.textOverflow).toBe(true);
      expect(r?.static).toBe(false);
      expect(r?.mask).not.toBe('none');
      expect(r?.anim).toBe('kbar-scroll');
      const seamless = await page.evaluate(() => {
        const groups = [...document.querySelectorAll('#kmarq .kmarquee-group')] as HTMLElement[];
        if (groups.length !== 2) return null;
        const w = groups.map((g) => Math.round(g.getBoundingClientRect().width));
        const t0 = groups.map((g) => getComputedStyle(g).transform);
        return new Promise((resolve) => {
          setTimeout(() => {
            const t1 = groups.map((g) => getComputedStyle(g).transform);
            resolve({ w, moved: t0[0] !== t1[0] && t1[0] === t1[1] });
          }, 400);
        });
      });
      expect(seamless?.w[0]).toBeGreaterThan(0);
      expect(seamless?.w[0]).toBe(seamless?.w[1]);
      expect(seamless?.moved).toBe(true);
    } finally {
      await request.put(`http://localhost:3001/api/v1/pages/${first.id}`, { data: { name: origName } });
    }
  });

  test('redimensionar reevalúa el marquee (scroll ⟺ overflow)', async ({ page, request }) => {
    const { getRunnerProfile, getPages } = await import('./helpers');
    const profile = await getRunnerProfile(request);
    const pages = await getPages(request, profile.id);
    const first = pages[0];
    const origName = (first as { name?: string }).name ?? '';
    const longName = 'Página de demostración con un nombre muy largo';
    try {
      const put = await request.put(`http://localhost:3001/api/v1/pages/${first.id}`, { data: { name: longName } });
      if (!put.ok()) throw new Error(`PUT page -> ${put.status()}`);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/?kiosk=1');
      await expect(page.getByTestId('bd-kiosk-grid')).toBeVisible({ timeout: 30000 });
      await dismissWelcome(page);
      await expect(page.locator('#kmarq:not(.is-static)')).toBeVisible({ timeout: 10000 });
      // A 1600 el mismo texto cabe: vuelve a estático sin fades.
      await page.setViewportSize({ width: 1600, height: 900 });
      await expect(page.locator('#kmarq.is-static')).toBeVisible({ timeout: 10000 });
      const rWide = await kbarReport(page, 'RESIZE-WIDE');
      expect(rWide?.static).toBe(true);
      expect(rWide?.mask).toBe('none');
      // Y de vuelta a 390 vuelve a animar: la medición sigue viva.
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator('#kmarq:not(.is-static)')).toBeVisible({ timeout: 10000 });
    } finally {
      await request.put(`http://localhost:3001/api/v1/pages/${first.id}`, { data: { name: origName } });
    }
  });

  test('contraída: el grid llega igual abajo que arriba; botón anclado a la izquierda', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/?kiosk=1');
    await expect(page.getByTestId('bd-kiosk-grid')).toBeVisible({ timeout: 30000 });
    await dismissWelcome(page);
    const floorPads = () => page.evaluate(() => {
      const f = document.querySelector('.bd-floor') as HTMLElement | null;
      if (!f) return null;
      const cs = getComputedStyle(f);
      return { top: cs.paddingTop, bottom: cs.paddingBottom };
    });
    // La barra es overlay: mismo aire arriba que abajo, expandida o contraída.
    expect(await floorPads()).toEqual({ top: '12px', bottom: '12px' });
    await page.getByTestId('bd-kiosk-barcollapse').click();
    await page.waitForFunction(() => {
      const bar = document.querySelector('#kbar') as HTMLElement | null;
      return bar ? Math.abs(bar.getBoundingClientRect().x - 12) <= 2 : false;
    }, null, { timeout: 5000 });
    expect(await floorPads()).toEqual({ top: '12px', bottom: '12px' });
    const bx = await page.evaluate(() => {
      const bar = document.querySelector('#kbar') as HTMLElement | null;
      return bar ? Math.round(bar.getBoundingClientRect().x) : null;
    });
    expect(Math.abs((bx ?? 99) - 12)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: 'test-results/kiosk-collapsed-left.png' });
    await page.getByTestId('bd-kiosk-barcollapse').click();
    await page.waitForTimeout(500);
    expect(await floorPads()).toEqual({ top: '12px', bottom: '12px' });
  });

  test('horizontal 844: pill fija con botón y colapso (sin modo móvil)', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto('/?kiosk=1');
    await expect(page.getByTestId('bd-kiosk-grid')).toBeVisible({ timeout: 30000 });
    await dismissWelcome(page);
    const r = await kbarReport(page, 'WIDE-LAND');
    expect(r?.position).toBe('fixed');
    expect(r?.toggleCount).toBe(1);
    const hit = await page.evaluate(() => {
      const t = document.querySelector('[data-cy="bd-kiosk-barcollapse"]') as HTMLElement | null;
      if (!t) return null;
      const b = t.getBoundingClientRect();
      const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) as HTMLElement | null;
      return { at: el ? (el.getAttribute('data-cy') || el.tagName + '.' + el.className) : 'none', veil: document.querySelectorAll('[data-cy="bd-idle-veil"]').length };
    });
    console.log('HIT-844 ' + JSON.stringify(hit));
    await page.getByTestId('bd-kiosk-barcollapse').click();
    await page.waitForTimeout(400);
    expect(await page.locator('#kbar.is-collapsed').count()).toBe(1);
  });
});
