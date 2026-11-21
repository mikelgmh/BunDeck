import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mock de DB in-memory COMPARTIDO por toda la run de `bun test` (los
// mock.module de Bun son globales al proceso, no por fichero): debe ser
// completo para no romper a los plugin-*.test.ts, que usan la DB real cuando
// corren aislados y este mock cuando corren en suite completa.
const mockDbModule = mock.module('../db', () => {
  const settings = new Map<string, string>();
  const logs: any[] = [];
  const plugins: any[] = [];
  const profiles: any[] = [];
  const pages: any[] = [];
  const buttons: any[] = [];
  let logId = 1;
  const dupPage = (profileId: string, name: string, except?: string) =>
    pages.some((p) => p.profile_id === profileId && p.name === name && p.id !== except);
  const posTaken = (pageId: string, position: number, except?: string) =>
    buttons.some((b) => b.page_id === pageId && b.position === position && b.id !== except);
  return {
    initDatabase: mock(async () => {}),
    getDatabase: mock(() => ({
      prepare: (sql: string) => ({
        run: (...args: any[]) => {
          const s = sql.toUpperCase();
          if (s.includes('DELETE FROM PLUGINS WHERE ID')) {
            const id = args[0];
            const i = plugins.findIndex((x: any) => x.id === id);
            if (i >= 0) plugins.splice(i, 1);
          }
          return {};
        },
        get: () => undefined,
        all: () => [],
      }),
    })),
    DatabaseService: class MockDatabaseService {
      getSetting = mock((key: string) => settings.get(key) ?? null);
      setSetting = mock((key: string, value: string) => { settings.set(key, value); });
      deleteSetting = mock((key: string) => { settings.delete(key); });
      getPluginSettings = mock((pluginId: string) => {
        const out: Record<string, string> = {};
        for (const [k, v] of settings) {
          if (k.startsWith(`plugin.${pluginId}.`)) {
            const sub = k.slice(`plugin.${pluginId}.`.length);
            if (sub && !sub.includes('.')) out[sub] = v;
          }
        }
        return out;
      });
      setPluginSettings = mock((pluginId: string, values: Record<string, any>) => {
        for (const [k, v] of Object.entries(values ?? {})) {
          if (v === null || v === undefined || v === '') settings.delete(`plugin.${pluginId}.${k}`);
          else settings.set(`plugin.${pluginId}.${k}`, String(v));
        }
      });
      addLog = mock((entry: any) => { logs.push({ ...entry, id: logId++ }); });
      getLogs = mock((limit = 100, level?: string) =>
        logs.filter(l => !level || l.level === level).slice(-limit).reverse());
      getProfiles = mock(() => []);
      getProfile = mock(() => null);
      createProfile = mock(() => {});
      updateProfile = mock(() => {});
      deleteProfile = mock(() => {});
      // Perfiles/páginas/botones/ajustes para mcp.test.ts (misma semántica que la DB real)
      getAllSettings = mock(() => Object.fromEntries(settings));
      setCurrentProfile = mock((id: string) => { settings.set('current.profile_id', id); });
      getCurrentProfile = mock(() => {
        const id = settings.get('current.profile_id');
        return (id ? profiles.find((p: any) => p.id === id) : null) ?? null;
      });
      setCurrentPage = mock((id: string) => { settings.set('current.page_id', id); });
      getCurrentPage = mock(() => {
        const id = settings.get('current.page_id');
        return (id ? pages.find((p: any) => p.id === id) : null) ?? null;
      });
      getProfiles = mock(() => [...profiles]);
      getProfile = mock((id: string) => profiles.find((p: any) => p.id === id) ?? null);
      createProfile = mock((p: any) => {
        const full = { ...p, created_at: Date.now(), updated_at: Date.now() };
        profiles.push(full);
        return full;
      });
      updateProfile = mock((id: string, updates: any) => {
        const p = profiles.find((x: any) => x.id === id);
        if (!p) return;
        if (updates.name !== undefined && updates.name !== null) p.name = updates.name;
        if (updates.data !== undefined && updates.data !== null) p.data = updates.data;
        p.updated_at = Date.now();
      });
      deleteProfile = mock((id: string) => {
        const i = profiles.findIndex((x: any) => x.id === id);
        if (i >= 0) profiles.splice(i, 1);
      });
      getPagesByProfile = mock((profileId: string) => pages.filter((p: any) => p.profile_id === profileId));
      getPage = mock((id: string) => pages.find((p: any) => p.id === id) ?? null);
      createPage = mock((p: any) => {
        if (dupPage(p.profile_id, p.name)) throw new Error(`A page with the name "${p.name}" already exists in this profile`);
        pages.push({ ...p });
      });
      updatePage = mock((id: string, updates: any) => {
        const p = pages.find((x: any) => x.id === id);
        if (!p) return;
        if (updates.name !== undefined) {
          if (dupPage(p.profile_id, updates.name, id)) throw new Error(`A page with the name "${updates.name}" already exists in this profile`);
          p.name = updates.name;
        }
        if (updates.order_idx !== undefined) p.order_idx = updates.order_idx;
        if (updates.is_folder !== undefined) p.is_folder = updates.is_folder;
        if (updates.data !== undefined) p.data = updates.data;
      });
      deletePage = mock((id: string) => {
        const i = pages.findIndex((x: any) => x.id === id);
        if (i >= 0) pages.splice(i, 1);
        for (let j = buttons.length - 1; j >= 0; j--) if (buttons[j].page_id === id) buttons.splice(j, 1);
      });
      getButtonsByPage = mock((pageId: string) =>
        buttons.filter((b: any) => b.page_id === pageId).sort((a: any, b: any) => a.position - b.position));
      getButton = mock((id: string) => buttons.find((b: any) => b.id === id) ?? null);
      createButton = mock((b: any) => {
        if (posTaken(b.page_id, b.position)) throw new Error(`UNIQUE constraint failed: buttons.page_id, buttons.position`);
        buttons.push({ ...b });
      });
      updateButton = mock((id: string, data: any) => {
        const b = buttons.find((x: any) => x.id === id);
        if (b) b.data = data;
      });
      updateButtonComplete = mock((id: string, updates: any) => {
        const b = buttons.find((x: any) => x.id === id);
        if (!b) return;
        if (updates.position !== undefined && posTaken(b.page_id, updates.position, id)) {
          throw new Error(`UNIQUE constraint failed: buttons.page_id, buttons.position`);
        }
        if (updates.data !== undefined) b.data = updates.data;
        if (updates.position !== undefined) b.position = updates.position;
      });
      deleteButton = mock((id: string) => {
        const i = buttons.findIndex((x: any) => x.id === id);
        if (i >= 0) buttons.splice(i, 1);
      });
      moveButton = mock((id: string, pageId: string, position?: number) => {
        const b = buttons.find((x: any) => x.id === id);
        if (!b) return;
        if (!pages.some((p: any) => p.id === pageId)) throw new Error(`Página destino no encontrada: ${pageId}`);
        const pos = position ?? b.position;
        if (posTaken(pageId, pos, id)) throw new Error(`UNIQUE constraint failed: buttons.page_id, buttons.position`);
        b.page_id = pageId;
        b.position = pos;
      });
      reorderButtons = mock((pageId: string, order: Array<{ id: string; position: number }>) => {
        const seen = new Set<number>();
        for (const o of order) {
          if (seen.has(o.position)) throw new Error(`Posición destino duplicada: ${o.position}`);
          seen.add(o.position);
        }
        for (const o of order) {
          const b = buttons.find((x: any) => x.id === o.id);
          if (!b) throw new Error(`Botón no encontrado: ${o.id}`);
          if (b.page_id !== pageId) throw new Error(`Botón ${o.id} no pertenece a la página ${pageId}`);
        }
        for (const o of order) buttons.find((x: any) => x.id === o.id).position = o.position;
        return buttons.filter((b: any) => b.page_id === pageId && seen.has(b.position));
      });
      getPlugins = mock(() => [...plugins]);
      getPlugin = mock((id: string) => plugins.find((p: any) => p.id === id) ?? null);
      getEnabledPlugins = mock(() => plugins.filter(p => p.enabled));
      installPlugin = mock((p: any) => {
        const i = plugins.findIndex(x => x.id === p.id);
        if (i >= 0) plugins[i] = p; else plugins.push(p);
      });
      upsertPluginRecord = mock((rec: any) => {
        const i = plugins.findIndex((x: any) => x.id === rec.id);
        const merged = {
          enabled: 1, installed_at: Date.now(), updated_at: Date.now(),
          ...(i >= 0 ? plugins[i] : {}), ...rec,
          manifest: typeof rec.manifest === 'string' ? JSON.parse(rec.manifest) : (rec.manifest ?? {}),
        };
        if (i >= 0) plugins[i] = merged; else plugins.push(merged);
      });
      setPluginEnabled = mock((id: string, enabled: boolean) => {
        const p = plugins.find((x: any) => x.id === id);
        if (p) { p.enabled = enabled ? 1 : 0; p.status = enabled ? 'active' : 'disabled'; }
      });
      setPluginStatus = mock((id: string, status: string, lastError: string | null = null) => {
        const p = plugins.find((x: any) => x.id === id);
        if (p) { p.status = status; p.last_error = lastError; }
      });
      getDatabase = mock(() => ({
        prepare: () => ({ run: () => {}, get: () => undefined, all: () => [] }),
      }));
    }
  };
});

import { ActionRunner } from '../action-runner';
import type { PluginLoader } from '../plugin-loader';

// Fake mínimo por constructor (sin mock.module: así plugin-loader.test.ts
// puede usar el PluginLoader real en la misma run de `bun test`).
function makeFakeLoader(): PluginLoader {
  return {
    setActionCallbacks: () => {},
  } as unknown as PluginLoader;
}

describe('ActionRunner', () => {
  let actionRunner: ActionRunner;
  let mockPluginLoader: PluginLoader;

  beforeEach(() => {
    mockPluginLoader = makeFakeLoader();
    actionRunner = new ActionRunner(mockPluginLoader);
  });

  it('should initialize with plugin loader', () => {
    expect(actionRunner).toBeDefined();
    expect(actionRunner.getNativePlugins()).toBeDefined();
    expect(actionRunner.getNativePlugins().length).toBeGreaterThan(0);
  });

  it('should register action handlers', () => {
    const testHandler = mock(() => ({ success: true }));

    actionRunner.registerAction('test.action', testHandler);

    const stats = actionRunner.getActionStats();
    expect(stats.registered).toBeGreaterThan(0);
  });

  it('should execute a simple action', async () => {
    const testAction = {
      id: 'test-1',
      type: 'utility.delay',
      parameters: { delay: 100 }
    };

    const context = {
      buttonId: 'btn-1',
      profileId: 'profile-1',
      pageId: 'page-1'
    };

    const result = await actionRunner.executeAction(testAction, context);

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('should handle unknown action types', async () => {
    const unknownAction = {
      id: 'test-2',
      type: 'unknown.action'
    };

    const context = {
      buttonId: 'btn-1',
      profileId: 'profile-1',
      pageId: 'page-1'
    };

    const result = await actionRunner.executeAction(unknownAction, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown action type');
  });

  it('should prevent double execution of the same action', async () => {
    const longRunningAction = {
      id: 'test-3',
      type: 'utility.delay',
      parameters: { delay: 1000 },
      timeout: 2000
    };

    const context = {
      buttonId: 'btn-1',
      profileId: 'profile-1',
      pageId: 'page-1'
    };

    // Start first execution
    const firstExecution = actionRunner.executeAction(longRunningAction, context);

    // Try to start second execution immediately
    const secondExecution = actionRunner.executeAction(longRunningAction, context);

    const firstResult = await firstExecution;
    const secondResult = await secondExecution;

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(false);
    expect(secondResult.error).toBe('Action is already running');
  });

  it('should handle action timeouts', async () => {
    const slowAction = {
      id: 'test-4',
      type: 'utility.delay',
      parameters: { delay: 2000 },
      timeout: 100
    };

    const context = {
      buttonId: 'btn-1',
      profileId: 'profile-1',
      pageId: 'page-1'
    };

    const result = await actionRunner.executeAction(slowAction, context);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Action timeout');
  });

  it('should track running actions', () => {
    const runningActions = actionRunner.getRunningActions();
    expect(Array.isArray(runningActions)).toBe(true);
  });

  it('should provide action statistics', () => {
    const stats = actionRunner.getActionStats();
    expect(stats).toBeDefined();
    expect(typeof stats.running).toBe('number');
    expect(typeof stats.registered).toBe('number');
    expect(typeof stats.lastExecutions).toBe('object');
  });

  it('should dispose properly', () => {
    actionRunner.dispose();

    const stats = actionRunner.getActionStats();
    expect(stats.registered).toBe(0);
  });
});