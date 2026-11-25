/**
 * Modo seguro E2E (`../e2e-safe.ts` + filtro en `ActionRunner.executeAction`).
 *
 * - Las acciones con efectos fuera de la app (shell, ventanas, hotkeys…)
 *   son no-ops con `skipped:'e2e-safe-mode'` cuando el modo está activo.
 * - Las internas (`local.*`, `page.*`, `flow.*`, `utility.*`, …) siguen
 *   ejecutándose (los specs e2e de Probar/kiosco/reglas dependen de ello).
 * - Sin modo seguro, todo ejecuta con normalidad (flujo dev intacto).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

import { isSafeModeEnabled, isGatedActionType, E2E_SAFE_MODE_SETTING } from '../e2e-safe';
import { ActionRunner } from '../action-runner';
import type { PluginLoader } from '../plugin-loader';

function makeFakeLoader(): PluginLoader {
  return { setActionCallbacks: () => {} } as unknown as PluginLoader;
}

/** Igual que en flow-runner.test.ts: funciona aislado y en suite completa. */
async function ensureDb(): Promise<void> {
  const dbMod: any = await import('../db');
  try {
    // eslint-disable-next-line no-new
    new dbMod.DatabaseService();
  } catch {
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    process.env.LIBREDECK_DATA_DIR = mkdtempSync(join(tmpdir(), 'e2e-safe-'));
    await dbMod.initDatabase();
  }
}

describe('e2e-safe: clasificación de acciones', () => {
  it('bloquea acciones con efectos en el PC', () => {
    for (const t of [
      'shell.shell',
      'window-manager.minimize',
      'window-manager.maximize',
      'hotkey.hotkey',
      'type-text.type',
      'multimedia.multimedia',
      'open-app.open',
      'browser.open',
      'audio-mixer.set-volume',
      'clipboard.set',
      'http.http',
      'obs.set-scene',
      'homeassistant.call',
      'hue-extra.lights',
      'minecraft.command',
    ]) {
      expect(isGatedActionType(t), t).toBe(true);
    }
  });

  it('permite acciones internas de la app y contenedores refiltrados', () => {
    for (const t of [
      'local.toast',
      'local.set-var',
      'local.toggle-var',
      'page.page',
      'flow.set-var',
      'profile-auto.switch-profile',
      'utility.delay',
      'utility.macro',
      'multiaction.run',
    ]) {
      expect(isGatedActionType(t), t).toBe(false);
    }
  });

  it('tipos raros/vacíos se bloquean (fail-closed)', () => {
    expect(isGatedActionType('')).toBe(true);
    expect(isGatedActionType(undefined)).toBe(true);
    expect(isGatedActionType(null)).toBe(true);
    expect(isGatedActionType(42)).toBe(true);
  });
});

describe('e2e-safe: activación', () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => {
    process.env.E2E_NO_SIDE_EFFECTS = OLD_ENV.E2E_NO_SIDE_EFFECTS;
    process.env.LIBREDECK_E2E_SAFE = OLD_ENV.LIBREDECK_E2E_SAFE;
    if (OLD_ENV.E2E_NO_SIDE_EFFECTS === undefined) delete process.env.E2E_NO_SIDE_EFFECTS;
    if (OLD_ENV.LIBREDECK_E2E_SAFE === undefined) delete process.env.LIBREDECK_E2E_SAFE;
  });

  it('env E2E_NO_SIDE_EFFECTS=1 manda sin BD', () => {
    process.env.E2E_NO_SIDE_EFFECTS = '1';
    expect(isSafeModeEnabled(null)).toBe(true);
    expect(isSafeModeEnabled({ getSetting: () => '0' })).toBe(true);
  });

  it('env LIBREDECK_E2E_SAFE=1 también activa', () => {
    process.env.LIBREDECK_E2E_SAFE = '1';
    expect(isSafeModeEnabled(null)).toBe(true);
  });

  it('ajuste e2e.safe_mode en BD activa/desactiva', () => {
    delete process.env.E2E_NO_SIDE_EFFECTS;
    delete process.env.LIBREDECK_E2E_SAFE;
    expect(isSafeModeEnabled({ getSetting: (k: string) => (k === E2E_SAFE_MODE_SETTING ? '1' : null) })).toBe(true);
    expect(isSafeModeEnabled({ getSetting: () => '0' })).toBe(false);
    expect(isSafeModeEnabled({ getSetting: () => null })).toBe(false);
    expect(isSafeModeEnabled(null)).toBe(false);
  });
});

describe('e2e-safe: ActionRunner filtra sin romper lo interno', () => {
  const OLD_ENV = { ...process.env };
  beforeEach(async () => {
    await ensureDb();
    delete process.env.E2E_NO_SIDE_EFFECTS;
    delete process.env.LIBREDECK_E2E_SAFE;
  });
  afterEach(() => {
    process.env.E2E_NO_SIDE_EFFECTS = OLD_ENV.E2E_NO_SIDE_EFFECTS;
    process.env.LIBREDECK_E2E_SAFE = OLD_ENV.LIBREDECK_E2E_SAFE;
    if (OLD_ENV.E2E_NO_SIDE_EFFECTS === undefined) delete process.env.E2E_NO_SIDE_EFFECTS;
    if (OLD_ENV.LIBREDECK_E2E_SAFE === undefined) delete process.env.LIBREDECK_E2E_SAFE;
  });

  it('en modo seguro: shell/window no se ejecutan (el handler ni se llama)', async () => {
    process.env.E2E_NO_SIDE_EFFECTS = '1';
    const runner = new ActionRunner(makeFakeLoader());
    const spy = mock(async () => ({ ran: true }));
    runner.registerAction('shell.shell', spy);
    runner.registerAction('window-manager.minimize', spy);
    try {
      const r1 = await runner.executeAction(
        { type: 'shell.shell', parameters: { command: 'echo E2E-SHOULD-NOT-RUN' } },
        { timestamp: Date.now() } as any,
      );
      expect(r1.success).toBe(true);
      expect((r1.result as any)?.skipped).toBe('e2e-safe-mode');
      const r2 = await runner.executeAction(
        { type: 'window-manager.minimize', parameters: { action: 'minimize' } },
        { timestamp: Date.now() } as any,
      );
      expect(r2.success).toBe(true);
      expect((r2.result as any)?.skipped).toBe('e2e-safe-mode');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      runner.dispose();
    }
  });

  it('en modo seguro: executeButtonFlow omite tecla de sistema, ejecuta toast', async () => {
    process.env.E2E_NO_SIDE_EFFECTS = '1';
    const runner = new ActionRunner(makeFakeLoader());
    try {
      const sys = await runner.executeButtonFlow(
        { id: 'sys1', data: { mode: 'seq', actions: [{ type: 'shell.shell', parameters: { command: 'echo X' } }], rules: [] } },
        { timestamp: Date.now() } as any,
      );
      expect(sys.success).toBe(true);
      expect(JSON.stringify(sys.results)).toContain('e2e-safe-mode');
      const inner = await runner.executeButtonFlow(
        { id: 'in1', data: { mode: 'seq', actions: [{ type: 'local.toast', parameters: { text: 'hola' } }], rules: [] } },
        { timestamp: Date.now() } as any,
      );
      expect(inner.success).toBe(true);
      expect(JSON.stringify(inner.results)).not.toContain('e2e-safe-mode');
    } finally {
      runner.dispose();
    }
  });

  it('sin modo seguro: todo ejecuta con normalidad (flujo dev intacto)', async () => {
    const runner = new ActionRunner(makeFakeLoader());
    const spy = mock(async (p: any) => ({ echo: p?.msg ?? 'ok' }));
    runner.registerAction('test.e2e-boom', spy);
    try {
      const r = await runner.executeAction(
        { type: 'test.e2e-boom', parameters: { msg: 'dev' } },
        { timestamp: Date.now() } as any,
      );
      expect(r.success).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      runner.dispose();
    }
  });
});
