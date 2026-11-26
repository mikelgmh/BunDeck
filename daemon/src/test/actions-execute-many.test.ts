/**
 * actions-execute-many.test.ts — `POST /api/v1/actions/execute-many`.
 *
 * - 1 round-trip por botón (pulsación) / por tick de página (sondeo) en vez
 *   de N `POST /actions/execute` en serie: ejecuta en orden y devuelve el
 *   array de resultados.
 * - El singular sigue intacto (mismo orden, mismos códigos, 500 al lanzar).
 */
import { describe, it, expect } from 'bun:test';
import { handleActions } from '../api/actions';

function req(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function fakeServices(order: string[]) {
  return {
    actionRunner: {
      executeAction: async (action: any, context: any) => {
        order.push(String(action?.type));
        if (action?.type === 'boom') throw new Error('kaboom');
        if (action?.type === 'rejected') return { success: false, error: 'not available' };
        return { success: true, result: { echo: action?.type, btn: context?.buttonId ?? null } };
      },
      getRunningActions: () => [],
      getActionStats: () => ({}),
    },
    wsManager: {
      started: 0,
      finished: 0,
      errors: 0,
      broadcastActionStarted() { this.started++; },
      broadcastActionFinished(_id: string, _r: any) { this.finished++; },
      broadcastActionError(_id: string, _e: any) { this.errors++; },
      broadcast() {},
      navigatePageTo() {},
      navigateProfileTo() {},
    },
  } as any;
}

const fakeDb = {
  getSetting: () => null,
  addPressLog: () => {},
  getDevice: () => null,
  getDeviceSession: () => null,
} as any;

describe('POST /api/v1/actions/execute-many', () => {
  it('ejecuta en orden y devuelve los resultados (items con contexto propio)', async () => {
    const order: string[] = [];
    const services = fakeServices(order);
    const res = await handleActions!(
      req('/api/v1/actions/execute-many', {
        items: [
          { action: { type: 'a' }, context: { buttonId: 'b1', position: 0, quiet: true } },
          { action: { type: 'b' }, context: { buttonId: 'b1', position: 0, quiet: true } },
        ],
      }),
      { url: new URL('http://localhost/api/v1/actions/execute-many'), method: 'POST', path: '/api/v1/actions/execute-many', db: fakeDb, services },
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(order).toEqual(['a', 'b']);
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({ success: true, result: { echo: 'a' } });
    expect(body.results[1]).toMatchObject({ success: true, result: { echo: 'b' } });
    // quiet: sin broadcasts.
    expect(services.wsManager.started).toBe(0);
    expect(services.wsManager.finished).toBe(0);
  });

  it('acepta { actions } + contexto compartido (pulsación de tecla)', async () => {
    const order: string[] = [];
    const services = fakeServices(order);
    const ctx = { buttonId: 'b9', deviceId: 'dev-1' };
    const res = await handleActions!(
      req('/api/v1/actions/execute-many', {
        actions: [{ type: 'x' }, { type: 'y' }],
        context: ctx,
      }),
      { url: new URL('http://localhost/api/v1/actions/execute-many'), method: 'POST', path: '/api/v1/actions/execute-many', db: fakeDb, services },
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(order).toEqual(['x', 'y']);
    expect(body.results[1]).toMatchObject({ success: true, result: { echo: 'y', btn: 'b9' } });
    // No quiet: broadcasts por item (mismo comportamiento que el singular).
    expect(services.wsManager.started).toBe(2);
    expect(services.wsManager.finished).toBe(2);
  });

  it('un fallo de acción no tumba el lote (resultado en orden, error incluido)', async () => {
    const order: string[] = [];
    const services = fakeServices(order);
    const res = await handleActions!(
      req('/api/v1/actions/execute-many', {
        actions: [{ type: 'ok' }, { type: 'boom' }],
        context: { quiet: true },
      }),
      { url: new URL('http://localhost/api/v1/actions/execute-many'), method: 'POST', path: '/api/v1/actions/execute-many', db: fakeDb, services },
    );
    const body = (await res!.json()) as any;
    expect(order).toEqual(['ok', 'boom']);
    expect(body.results).toHaveLength(2);
    expect(body.results[0].success).toBe(true);
    // La excepción del runner se reporta como item fallido, no como 500.
    expect(body.results[1].success).toBe(false);
    // Las ejecuciones quiet son polling de fondo: sus errores se leen en la
    // respuesta del caller, no se convierten en toasts globales por WS.
    expect(services.wsManager.errors).toBe(0);
  });

  it('no difunde por WS los fallos devueltos por una acción quiet', async () => {
    const order: string[] = [];
    const services = fakeServices(order);
    const res = await handleActions!(
      req('/api/v1/actions/execute-many', {
        actions: [{ type: 'rejected' }],
        context: { quiet: true },
      }),
      { url: new URL('http://localhost/api/v1/actions/execute-many'), method: 'POST', path: '/api/v1/actions/execute-many', db: fakeDb, services },
    );
    const body = (await res!.json()) as any;
    expect(body.results[0]).toMatchObject({ success: false, error: 'not available' });
    expect(services.wsManager.errors).toBe(0);
  });

  it('valida el cuerpo (vacío, demasiados, sin type → 400)', async () => {
    const order: string[] = [];
    const services = fakeServices(order);
    const ctx = { url: new URL('http://localhost/x'), method: 'POST', path: '/api/v1/actions/execute-many', db: fakeDb, services } as any;
    for (const bad of [{}, { actions: [] }, { actions: [{ noType: 1 }] }, { actions: new Array(33).fill({ type: 'a' }) }]) {
      const res = await handleActions!(req('/api/v1/actions/execute-many', bad), ctx);
      expect(res!.status).toBe(400);
    }
    expect(order).toEqual([]);
  });

  it('el singular sigue intacto (200 + broadcasts; 500 al lanzar)', async () => {
    const order: string[] = [];
    const services = fakeServices(order);
    const ctx = { url: new URL('http://localhost/x'), method: 'POST', path: '/api/v1/actions/execute', db: fakeDb, services } as any;
    const ok = await handleActions!(req('/api/v1/actions/execute', { action: { type: 'solo' }, context: {} }), ctx);
    expect(ok!.status).toBe(200);
    expect(((await ok!.json()) as any).success).toBe(true);
    expect(services.wsManager.started).toBe(1);

    const fail = await handleActions!(req('/api/v1/actions/execute', { action: { type: 'boom' }, context: {} }), ctx);
    expect(fail!.status).toBe(500);
    expect(((await fail!.json()) as any).success).toBe(false);
    expect(services.wsManager.errors).toBe(1);
  });
});
