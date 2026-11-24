import { test, expect } from '@playwright/test';
import * as path from 'node:path';

/**
 * elgato-shim.spec.ts — E2E del shim Elgato en-Worker (API-level).
 *
 * Requiere daemon en http://localhost:3001 (levantado fuera, como el resto
 * de la suite). Usa como fixtures versionadas los paquetes de
 * `daemon/src/test/fixtures/elgato/*` (JS puro, Keypad, gratuitos y
 * propios: sin problema de licencias; los plugins reales de
 * marketplace.elgato.com se validan manualmente — ver
 * `docs/elgato-shim-compat.md`).
 *
 * Por fixture: import (dir) → key (pulso) → elgato-state → settings.
 * La desinstalación previa best-effort hace la suite re-ejecutable.
 */

const API = 'http://localhost:3001/api/v1';
const FIX = path.resolve(__dirname, '..', '..', '..', 'daemon', 'src', 'test', 'fixtures', 'elgato');

interface Fixture {
  dir: string;
  pluginId: string;
  action: string;
  expect: 'ok' | 'needs-manual';
}

const FIXTURES: Fixture[] = [
  { dir: 'counter-v1', pluginId: 'com.ld.counter', action: 'count', expect: 'ok' },
  { dir: 'clock-settings-v1', pluginId: 'com.ld.clocksettings', action: 'tick', expect: 'ok' },
  { dir: 'image-v1', pluginId: 'com.ld.image', action: 'badge', expect: 'ok' },
  { dir: 'alert-v1', pluginId: 'com.ld.alert', action: 'flash', expect: 'ok' },
  { dir: 'openurl-v1', pluginId: 'com.ld.openurl', action: 'open', expect: 'ok' },
  { dir: 'multi-v1', pluginId: 'com.ld.multi', action: 'alpha', expect: 'ok' },
  { dir: 'mixed-v1', pluginId: 'com.ld.mixed', action: 'tap', expect: 'ok' },
  // Dial-only: sin equivalente hardware → needs-manual apagado.
  { dir: 'dialonly-v1', pluginId: 'com.ld.dialonly', action: '', expect: 'needs-manual' },
];

test.describe('shim Elgato (import → key → state → settings)', () => {
  for (const fx of FIXTURES) {
    test(`${fx.dir}: import + key + state`, async ({ request }) => {
      // Re-ejecutable: limpiar instalación previa si existe.
      await request.delete(`${API}/plugins/${encodeURIComponent(fx.pluginId)}`);

      const imp = await request.post(`${API}/plugins/import-elgato`, {
        data: { dir: path.join(FIX, fx.dir) },
      });
      expect(imp.status(), `${fx.dir}: import status`).toBe(201);
      const body = await imp.json();
      expect(body.pluginId).toBe(fx.pluginId);

      const detail = await request.get(`${API}/plugins/${encodeURIComponent(fx.pluginId)}`);
      expect(detail.ok()).toBe(true);
      const status = await detail.json();
      if (fx.expect === 'needs-manual') {
        expect(status.status).toBe('needs-manual');
        expect(status.enabled).toBe(false);
        return;
      }
      expect(status.status).toBe('active');
      expect(status.enabled).toBe(true);

      const key = await request.post(
        `${API}/plugins/${encodeURIComponent(fx.pluginId)}/key`,
        { data: { action: fx.action, context: 'e2e-b1' } },
      );
      expect(key.ok(), `${fx.dir}: key`).toBe(true);
      const kres = await key.json();
      expect(kres.success).toBe(true);

      const st = await request.get(
        `${API}/plugins/${encodeURIComponent(fx.pluginId)}/elgato-state`,
      );
      expect(st.ok(), `${fx.dir}: elgato-state`).toBe(true);
      const sbody = await st.json();
      expect(sbody.pluginId).toBe(fx.pluginId);
      expect(sbody.running).toBe(true);
      expect(sbody.shim).toBe(true);
      expect(Array.isArray(sbody.state?.contexts)).toBe(true);
      expect(sbody.state.contexts.length).toBeGreaterThanOrEqual(1);

      // Segunda pulsación en otro botón: contexto independiente.
      const key2 = await request.post(
        `${API}/plugins/${encodeURIComponent(fx.pluginId)}/key`,
        { data: { action: fx.action, context: 'e2e-b2' } },
      );
      expect(key2.ok()).toBe(true);
      const st2 = await (await request.get(
        `${API}/plugins/${encodeURIComponent(fx.pluginId)}/elgato-state`,
      )).json();
      expect(st2.state.contexts.length).toBeGreaterThanOrEqual(2);
    });
  }

  test('clock-settings-v1: settings PUT con schema generado', async ({ request }) => {
    const id = 'com.ld.clocksettings';
    const got = await request.get(`${API}/plugins/${encodeURIComponent(id)}/settings`);
    expect(got.ok()).toBe(true);
    const bundle = await got.json();
    expect(bundle.schema?.properties?.interval?.type).toBe('number');

    const put = await request.put(`${API}/plugins/${encodeURIComponent(id)}/settings`, {
      data: { values: { interval: 11, label: 'e2e' } },
    });
    expect(put.ok()).toBe(true);

    const key = await request.post(`${API}/plugins/${encodeURIComponent(id)}/key`, {
      data: { action: 'tick', context: 'e2e-b1', params: undefined },
    });
    // El pulso con pressType largo verifica el hold real end-to-end.
    const keyLong = await request.post(`${API}/plugins/${encodeURIComponent(id)}/key`, {
      data: { action: 'tick', context: 'e2e-b1', pressType: 'long', holdMs: 150 },
    });
    expect(keyLong.ok()).toBe(true);
    expect((await keyLong.json()).success).toBe(true);
    void key;
  });

  test('counter-v1: el contador persiste entre pulsos (settings del Worker)', async ({ request }) => {
    const id = 'com.ld.counter';
    const key = await request.post(`${API}/plugins/${encodeURIComponent(id)}/key`, {
      data: { action: 'count', context: 'e2e-counter' },
    });
    expect(key.ok()).toBe(true);
    const st = await (await request.get(`${API}/plugins/${encodeURIComponent(id)}/elgato-state`)).json();
    const ctx = (st.state.contexts as any[]).find((c) => c.context.endsWith(':e2e-counter'));
    expect(ctx).toBeDefined();
    const n = Number(ctx.state.title);
    expect(Number.isFinite(n)).toBe(true);

    const key2 = await request.post(`${API}/plugins/${encodeURIComponent(id)}/key`, {
      data: { action: 'count', context: 'e2e-counter' },
    });
    expect(key2.ok()).toBe(true);
    const st2 = await (await request.get(`${API}/plugins/${encodeURIComponent(id)}/elgato-state`)).json();
    const ctx2 = (st2.state.contexts as any[]).find((c) => c.context.endsWith(':e2e-counter'));
    expect(Number(ctx2.state.title)).toBe(n + 1);
  });
});
