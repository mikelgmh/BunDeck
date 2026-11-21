/**
 * hw-repaint-scheduling.test.ts — regresión del bug "Vaciar / mover teclas
 * tarda una eternidad en el StreamDeck físico".
 *
 * Causa (daemon/src/hw-driver/streamdeck-driver.ts + api/routes.ts):
 *  - Cada PUT/POST/DELETE/reorder hacía `await updateFromPage(pageId)` ANTES
 *    de responder: repintado COMPLETO (15-32 teclas, render canvas + USB
 *    secuencial) bloqueando la respuesta HTTP → la UI parecía congelada y el
 *    vaciado "no terminaba nunca".
 *  - updateButtonsWithData hacía un fetch a /api/v1/system/metrics
 *    (PowerShell, ~s) POR CADA tecla dinámica, secuencial.
 *  - El frontend llamaba a updateStreamDeckButtons() hasta al SELECCIONAR
 *    una tecla (cada clic = repintado completo).
 *
 * Fix (réplicas puras aquí, sin HID):
 *  1. routes responden primero y repintan con scheduleUpdateFromPage()
 *     (debounce 150 ms, coalescado).
 *  2. updateFromPage coalesca repintados concurrentes (in-flight + queued).
 *  3. updateButtonsWithData obtiene métricas UNA vez por repintado.
 */

import { describe, it, expect } from 'bun:test';

// --- Réplica de scheduleUpdateFromPage (debounce + coalescado) ---
function makeScheduler(execute: (pageId: string) => Promise<void>, delayMs = 20) {
  let pending: { pageId: string; timer: ReturnType<typeof setTimeout> } | null = null;
  const schedule = (pageId: string) => {
    if (pending) clearTimeout(pending.timer);
    pending = {
      pageId,
      timer: setTimeout(() => {
        pending = null;
        void execute(pageId);
      }, delayMs),
    };
  };
  const pendingPage = () => pending?.pageId ?? null;
  return { schedule, pendingPage };
}

// --- Réplica de updateFromPage con guard in-flight + queued ---
function makeCoalescedUpdater(render: (pageId: string) => Promise<void>) {
  let inFlight = false;
  let queued: string | null = null;
  let calls = 0;
  const update = async (pageId: string): Promise<void> => {
    if (inFlight) {
      queued = pageId;
      return;
    }
    inFlight = true;
    try {
      calls += 1;
      await render(pageId);
    } finally {
      inFlight = false;
      const q = queued;
      queued = null;
      if (q) await update(q);
    }
  };
  return { update, calls: () => calls, isInFlight: () => inFlight };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('hw repaint scheduling (fix vaciar/reorder lento)', () => {
  it('1. N cambios seguidos colapsan en UN solo repintado diferido', async () => {
    let executions = 0;
    let lastPage = '';
    const { schedule } = makeScheduler(async (pageId) => {
      executions += 1;
      lastPage = pageId;
    }, 20);
    // Vaciar + mover + editar en ráfaga (como hace la UI al arrastrar)
    schedule('p1');
    schedule('p1');
    schedule('p1');
    schedule('p1');
    // La respuesta HTTP ya habría vuelto: nada ejecutado aún (no bloquea)
    expect(executions).toBe(0);
    await sleep(60);
    expect(executions).toBe(1);
    expect(lastPage).toBe('p1');
  });

  it('2. la última página manda si cambia durante el debounce', async () => {
    const seen: string[] = [];
    const { schedule } = makeScheduler(async (pageId) => {
      seen.push(pageId);
    }, 20);
    schedule('p1');
    await sleep(5);
    schedule('p2');
    await sleep(60);
    expect(seen).toEqual(['p2']);
  });

  it('3. repintado concurrente: el 2º se encola, no se solapa', async () => {
    const order: string[] = [];
    const { update, calls } = makeCoalescedUpdater(async (pageId) => {
      order.push(`start:${pageId}`);
      await sleep(30);
      order.push(`end:${pageId}`);
    });
    const a = update('p1');
    // Durante el vuelo llega otro cambio (reorder justo tras vaciar)
    await sleep(5);
    await update('p1');
    await a;
    // Dos renders secuenciales, nunca solapados: start,end,start,end
    expect(order).toEqual(['start:p1', 'end:p1', 'start:p1', 'end:p1']);
    expect(calls()).toBe(2);
  });

  it('4. métricas del sistema: UN fetch por repintado, no uno por tecla', async () => {
    let fetches = 0;
    const fetchMetrics = async () => {
      fetches += 1;
      await sleep(5);
      return { cpu: { usage: 42 } };
    };
    // Réplica del loop ANTIGUO: fetch por tecla dinámica
    const oldRepaint = async (dynamicCount: number) => {
      fetches = 0;
      for (let i = 0; i < dynamicCount; i++) await fetchMetrics();
      return fetches;
    };
    // Réplica del loop NUEVO: un fetch reutilizado por todas
    const newRepaint = async (dynamicCount: number) => {
      fetches = 0;
      const metrics = dynamicCount > 0 ? await fetchMetrics() : null;
      for (let i = 0; i < dynamicCount; i++) {
        if (!metrics) throw new Error('sin métricas');
      }
      return fetches;
    };
    expect(await oldRepaint(8)).toBe(8); // el bug: 8 PowerShell secuenciales
    expect(await newRepaint(8)).toBe(1); // el fix: 1 solo
    expect(await newRepaint(0)).toBe(0); // sin dinámicas: 0 fetches
  });

  it('5. DELETE/vaciar responde sin esperar al repintado (no bloquea)', async () => {
    // Réplica del handler ANTIGUO: await updateFromPage antes de responder
    const oldDelete = async (repaint: () => Promise<void>) => {
      const t0 = Date.now();
      await repaint(); // bloquea
      return Date.now() - t0;
    };
    // Réplica del handler NUEVO: schedule + respuesta inmediata
    const newDelete = async (scheduleFn: () => void) => {
      const t0 = Date.now();
      scheduleFn(); // no bloquea
      return Date.now() - t0;
    };
    const slowRepaint = () => sleep(80);
    const oldMs = await oldDelete(slowRepaint);
    let scheduled = false;
    const newMs = await newDelete(() => {
      scheduled = true;
      void slowRepaint();
    });
    expect(oldMs).toBeGreaterThanOrEqual(70); // bloqueaba ~80 ms (en real: segundos)
    expect(newMs).toBeLessThan(30); // responde al instante
    expect(scheduled).toBe(true); // pero el repintado sí se programó
  });
});
