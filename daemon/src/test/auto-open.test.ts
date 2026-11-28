/**
 * auto-open.test.ts — el daemon no abre el navegador solo cuando lo
 * gestiona el launcher.
 *
 * Regresión: cada `ensure_daemon_spawned` del apply abría una pestaña
 * (`cmd /c start http://localhost:FRONTEND`), y tras Salir/actualizar el
 * usuario veía "el front levantado" aunque el stack ya hubiera caído.
 */
import { describe, it, expect } from 'bun:test';
import { shouldAutoOpenBrowser } from '../server';

describe('shouldAutoOpenBrowser', () => {
  it('abre en standalone prod (sin marcas del launcher)', () => {
    expect(shouldAutoOpenBrowser({} as any)).toBe(true);
  });

  it('no abre cuando lo spawnea el launcher (BUNDECK_MANAGED=1)', () => {
    expect(shouldAutoOpenBrowser({ BUNDECK_MANAGED: '1' } as any)).toBe(false);
  });

  it('no abre durante un apply (BUNDECK_NO_AUTO_OPEN=1)', () => {
    expect(shouldAutoOpenBrowser({ BUNDECK_NO_AUTO_OPEN: '1' } as any)).toBe(false);
  });

  it('acepta las variantes legacy LIBREDECK_*', () => {
    expect(shouldAutoOpenBrowser({ LIBREDECK_MANAGED: '1' } as any)).toBe(false);
    expect(shouldAutoOpenBrowser({ LIBREDECK_NO_AUTO_OPEN: '1' } as any)).toBe(false);
  });
});
