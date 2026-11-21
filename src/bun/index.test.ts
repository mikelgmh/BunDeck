/**
 * index.test.ts — ciclo de vida del host Electrobun (src/bun/index.ts).
 * - "Salir" del tray debe cerrar el daemon (vía su endpoint admin, que vale
 *   incluso si el daemon lo arrancó el usuario por su cuenta) + matar hijos.
 * - shutdownAll nunca lanza, aunque no haya nada que apagar.
 */
import { describe, it, expect } from 'bun:test';

// El entrypoint arranca solo (el launcher de Electrobun lo evalúa como
// módulo): para testear sin efectos, fijar el flag ANTES del import
// dinámico — con import estático main() ya habría arrancado.
process.env.LIBREDECK_HOST_TEST = '1';
const { shutdownAll, findLauncherBinary, spawnLauncher, shouldHostManageDaemon } = await import('./index');

function fakeChild() {
  const calls: string[] = [];
  return {
    calls,
    proc: {
      exitCode: null as number | null,
      // Sin pid: killTree no intenta taskkill real en el test
      pid: undefined as unknown as number,
      kill: () => {
        calls.push('kill');
        return true;
      },
    } as any,
  };
}

describe('electrobun host shutdown', () => {
  it('apaga front + daemon por API + kill de hijos', async () => {
    const front = fakeChild();
    const daemon = fakeChild();
    const fetches: Array<{ url: string; init: any }> = [];
    const kills: string[] = [];
    await shutdownAll({
      fetchFn: (async (url: string, init?: any) => {
        fetches.push({ url, init });
        return { ok: true };
      }) as any,
      killChild: ((c: any, label: string) => {
        if (c) {
          kills.push(label);
          c.kill();
        }
      }) as any,
      takeDaemon: () => daemon.proc,
      takeFrontend: () => front.proc,
      apiPort: 3999,
    });
    expect(fetches).toHaveLength(1);
    expect(fetches[0].url).toBe('http://localhost:3999/api/v1/admin/shutdown');
    expect(fetches[0].init.method).toBe('POST');
    expect(kills).toEqual(['front', 'daemon']);
    expect(front.calls).toEqual(['kill']);
    expect(daemon.calls).toEqual(['kill']);
  });

  it('no falla si no hay daemon (fetch rechaza, sin hijos)', async () => {
    const kills: string[] = [];
    await shutdownAll({
      fetchFn: (async () => {
        throw new Error('ECONNREFUSED');
      }) as any,
      killChild: ((c: any, label: string) => {
        if (c) kills.push(label);
      }) as any,
      takeDaemon: () => null,
      takeFrontend: () => null,
      apiPort: 3999,
    });
    expect(kills).toEqual([]);
  });
});

describe('electrobun host launcher GPUI', () => {
  it('findLauncherBinary respeta el override LIBREDECK_LAUNCHER si existe', async () => {
    const tmp = `${process.env.TEMP ?? '/tmp'}/ld-launcher-probe-${Date.now()}`;
    await Bun.write(tmp, 'probe');
    try {
      expect(findLauncherBinary(tmp)).toBe(tmp);
    } finally {
      try {
        await Bun.$`rm -f ${tmp}`.quiet();
      } catch { /* noop */ }
    }
  });

  it('spawnLauncher lanza el binario y devuelve true', () => {
    const seen: string[] = [];
    const logs: string[] = [];
    const ok = spawnLauncher({
      binary: '/tmp/fake-launcher',
      spawnFn: (bin: string) => {
        seen.push(bin);
      },
      onLog: (m: string) => {
        logs.push(m);
      },
    });
    expect(ok).toBe(true);
    expect(seen).toEqual(['/tmp/fake-launcher']);
    expect(logs.some((m) => m.includes('se omite BrowserWindow'))).toBe(true);
  });

  it('spawnLauncher sin binario devuelve false sin spawnear', () => {
    let called = 0;
    const ok = spawnLauncher({
      binary: null,
      spawnFn: () => {
        called++;
      },
      onLog: () => {},
    });
    expect(ok).toBe(false);
    expect(called).toBe(0);
  });

  it('spawnLauncher con spawn fallido devuelve false', () => {
    const logs: string[] = [];
    const ok = spawnLauncher({
      binary: '/tmp/fake-launcher',
      spawnFn: () => {
        throw new Error('ENOENT');
      },
      onLog: (m: string) => {
        logs.push(m);
      },
    });
    expect(ok).toBe(false);
    expect(logs.some((m) => m.includes('No se pudo lanzar'))).toBe(true);
  });
});

describe('shouldHostManageDaemon (host dev-only, launcher dueño en prod)', () => {
  it('en dev gestiona el daemon por defecto', () => {
    expect(shouldHostManageDaemon({} as any, true)).toBe(true);
  });
  it('en prod no spawnea (el launcher Rust es el dueño)', () => {
    expect(shouldHostManageDaemon({} as any, false)).toBe(false);
  });
  it('LIBREDECK_MANAGED=1 nunca duplica (ni en dev)', () => {
    expect(shouldHostManageDaemon({ LIBREDECK_MANAGED: '1' } as any, true)).toBe(false);
  });
  it('override explícito manda sobre el modo', () => {
    expect(shouldHostManageDaemon({ LIBREDECK_HOST_MANAGE_DAEMON: '1' } as any, false)).toBe(true);
    expect(shouldHostManageDaemon({ LIBREDECK_HOST_MANAGE_DAEMON: '0' } as any, true)).toBe(false);
  });
});
