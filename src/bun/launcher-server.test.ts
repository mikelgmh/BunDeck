/**
 * launcher-server.test.ts — mini API solo-localhost para la ventanita GPUI.
 * Rutas __launcher/* con dependencias inyectadas (sin Electrobun real).
 */
import { describe, it, expect } from 'bun:test';

process.env.LIBREDECK_HOST_TEST = '1';
const { handleLauncherRequest } = await import('./launcher-server');

const deps = {
  openWindow: () => ({ opened: true, url: 'http://localhost:3002' }),
  checkUpdate: async () => ({ updateAvailable: true, version: '9.9.9' }),
  applyUpdate: async () => ({ ok: true }),
};

async function body(res: Response): Promise<any> {
  return res.json();
}

describe('launcher-server', () => {
  it('POST open-window abre la ventana del dashboard', async () => {
    const res = await handleLauncherRequest(
      new Request('http://127.0.0.1:3031/__launcher/open-window', { method: 'POST' }),
      deps as any,
    );
    expect(res.status).toBe(200);
    const json = await body(res);
    expect(json).toMatchObject({ ok: true, opened: true, url: 'http://localhost:3002' });
  });

  it('GET update-check propaga el resultado del Updater', async () => {
    const res = await handleLauncherRequest(
      new Request('http://127.0.0.1:3031/__launcher/update-check'),
      deps as any,
    );
    const json = await body(res);
    expect(json).toMatchObject({ ok: true, updateAvailable: true, version: '9.9.9' });
  });

  it('POST update-apply propaga el resultado', async () => {
    const res = await handleLauncherRequest(
      new Request('http://127.0.0.1:3031/__launcher/update-apply', { method: 'POST' }),
      deps as any,
    );
    const json = await body(res);
    expect(json).toEqual({ ok: true });
  });

  it('propaga errores de las deps como 500', async () => {
    const res = await handleLauncherRequest(
      new Request('http://127.0.0.1:3031/__launcher/open-window', { method: 'POST' }),
      {
        ...deps,
        openWindow: () => {
          throw new Error('no window');
        },
      } as any,
    );
    expect(res.status).toBe(500);
    const json = await body(res);
    expect(json.ok).toBe(false);
  });

  it('rutas desconocidas o método erróneo -> 404', async () => {
    const notFound = await handleLauncherRequest(
      new Request('http://127.0.0.1:3031/__launcher/ayuda', { method: 'POST' }),
      deps as any,
    );
    expect(notFound.status).toBe(404);
    const wrongMethod = await handleLauncherRequest(
      new Request('http://127.0.0.1:3031/__launcher/open-window', { method: 'GET' }),
      deps as any,
    );
    expect(wrongMethod.status).toBe(404);
  });
});
