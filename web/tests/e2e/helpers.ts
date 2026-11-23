import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Helpers API para los E2E Playwright — equivalentes a los cy.request()
 * de web/cypress/e2e/deck-layouts.cy.ts y dragdrop.cy.ts.
 *
 * Solo API (sin creación de páginas vía UI). La web corre en
 * http://localhost:4321 y el daemon en http://localhost:3001/api/v1.
 */

export const API_BASE = 'http://localhost:3001/api/v1';

export interface Profile {
  id: string;
  name: string;
  data?: string | Record<string, unknown>;
}

export interface DeckPage {
  id: string;
  name: string;
  profile_id?: string;
  is_folder?: number;
}

export interface DeckButton {
  id: string;
  page_id?: string;
  position: number;
  w?: number;
  h?: number;
}

export async function getProfiles(request: APIRequestContext): Promise<Profile[]> {
  const res = await request.get(`${API_BASE}/profiles`);
  if (!res.ok()) throw new Error(`GET /profiles -> ${res.status()}`);
  return (await res.json()) as Profile[];
}

export async function getPages(
  request: APIRequestContext,
  profileId: string,
): Promise<DeckPage[]> {
  const res = await request.get(`${API_BASE}/pages?profileId=${profileId}`);
  if (!res.ok()) throw new Error(`GET /pages?profileId=${profileId} -> ${res.status()}`);
  return (await res.json()) as DeckPage[];
}

export async function getButtons(
  request: APIRequestContext,
  pageId: string,
): Promise<DeckButton[]> {
  const res = await request.get(`${API_BASE}/buttons?pageId=${pageId}`);
  if (!res.ok()) throw new Error(`GET /buttons?pageId=${pageId} -> ${res.status()}`);
  return (await res.json()) as DeckButton[];
}

/** Crea un botón con label en la página dada (equiv. seedButtons de deck-layouts). */
export async function seedButton(
  request: APIRequestContext,
  pageId: string,
  label: string,
  position = 0,
  actions: unknown[] = [],
): Promise<DeckButton> {
  const res = await request.post(`${API_BASE}/buttons`, {
    data: {
      page_id: pageId,
      position,
      data: {
        label,
        actions,
        backgroundColor: '#374151',
        textColor: '#f1f5f9',
      },
    },
  });
  if (!res.ok()) throw new Error(`POST /buttons (${label}) -> ${res.status()}`);
  return (await res.json()) as DeckButton;
}

/** Crea dos botones (equiv. seedButtons LABEL_A/LABEL_B de deck-layouts). */
export async function seedTwoButtons(
  request: APIRequestContext,
  pageId: string,
  labelA: string,
  labelB: string,
): Promise<[DeckButton, DeckButton]> {
  const a = await seedButton(request, pageId, labelA, 0);
  const b = await seedButton(request, pageId, labelB, 1);
  return [a, b];
}

/** Busca dos slots libres del grid (equiv. lógica `free` de dragdrop.cy.ts). */
export async function findFreeSlots(
  request: APIRequestContext,
  pageId: string,
  gridCols: number,
  gridRows: number,
  count = 2,
): Promise<number[]> {
  const buttons = await getButtons(request, pageId);
  const taken = new Set(buttons.map((b) => b.position));
  const free: number[] = [];
  for (let i = 0; i < gridCols * gridRows && free.length < count; i++) {
    if (!taken.has(i)) free.push(i);
  }
  return free;
}

/** Fija la página actual para que la app la cargue al visitar `/`. */
export async function setCurrentPage(
  request: APIRequestContext,
  pageId: string,
): Promise<void> {
  const res = await request.post(`${API_BASE}/settings`, {
    data: { key: 'current.page_id', value: pageId },
  });
  if (!res.ok()) throw new Error(`POST /settings current.page_id -> ${res.status()}`);
}

export async function deleteButton(
  request: APIRequestContext,
  buttonId: string,
): Promise<void> {
  await request.delete(`${API_BASE}/buttons/${buttonId}`, { failOnStatusCode: false });
}

export async function deletePage(
  request: APIRequestContext,
  pageId: string,
): Promise<void> {
  await request.delete(`${API_BASE}/pages/${pageId}`, { failOnStatusCode: false });
}

/** Visita `/` y espera a que la app cargue (pestañas de perfil visibles). */
export async function gotoBoard(page: Page): Promise<void> {
  await page.goto('/');
  await page
    .locator('[data-cy=bd-profile-tab]')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });
}

/** Perfil dedicado de la suite E2E (creado por global-setup). */
export const RUNNER_PROFILE = 'E2E Runner';

/** Busca el perfil dedicado; falla alto si el globalSetup no corrió. */
export async function getRunnerProfile(request: APIRequestContext): Promise<Profile> {
  const res = await request.get(`${API_BASE}/profiles`);
  if (!res.ok()) throw new Error(`GET /profiles -> ${res.status()}`);
  const profiles = (await res.json()) as Profile[];
  const runner = profiles.find((p) => p.name === RUNNER_PROFILE);
  if (!runner) {
    throw new Error(
      `No existe el perfil "${RUNNER_PROFILE}" (¿corrió global-setup? ¿arrancaste con playwright test?)`,
    );
  }
  return runner;
}

/** Acepta el diálogo "esta página se muestra en un Stream Deck" si aparece.
 *
 *  Las páginas clásicas nuevas se auto-asignan al deck de ejemplo y pasar a
 *  Libre exige desasignarla: sin aceptar, la placa libre nunca aparece.
 *  El selector se acota al diálogo abierto (hay dos <dialog> .bd-confirm).
 */
export async function acceptFreeModeConfirm(page: Page): Promise<void> {
  const ok = page.locator('dialog.bd-confirm[open] .bd-confirm-actions .bd-pri');
  try {
    await ok.waitFor({ state: 'visible', timeout: 3000 });
    await ok.click();
  } catch {
    /* sin diálogo: la página no estaba asignada a ningún deck */
  }
}

/** Cambia a modo Libre aceptando el aviso y esperando al PUT que persiste. */
export async function toggleFreeMode(page: Page): Promise<void> {
  const putPromise = page.waitForResponse(
    (res) =>
      res.url().includes('/api/v1/pages/') &&
      res.request().method() === 'PUT' &&
      (res.request().postData()?.includes('gridstack') ?? false),
    { timeout: 15000 },
  );
  await page.locator('[data-cy=bd-layout-gridstack]').click();
  await acceptFreeModeConfirm(page);
  await putPromise;
}

/** Pliega el panel izquierdo si tapa el grid (a 1280px el drawer cubre teclas). */
export async function collapseLeftPanel(page: Page): Promise<void> {
  const collapse = page.locator('[data-cy=bd-collapse-left]');
  if (await collapse.count()) {
    // click por JS: el edge del drawer puede quedar fuera de viewport estable
    // y el click normal de Playwright espera estabilidad eternamente.
    await collapse.first().evaluate((el) => (el as HTMLElement).click());
    await page.locator('[data-cy=bd-expand-left]').first().waitFor({ timeout: 5000 });
  }
}

/** Arrastra una tecla de un slot a otro con gesto de ratón real.
 *
 *  Espera a que Swapy se haya re-vinculado tras la llegada de los botones: al
 *  arrancar, Swapy se crea con el grid vacío y se re-vincula cuando la API
 *  trae las teclas (resyncSwapy). Arrastrar en esa ventana (~200-500 ms) opera
 *  sobre el mapa rancio y la suelta se ignora en silencio. Devuelve si el
 *  daemon recibió el reorder y con qué order.
 */
export async function dragSlotToSlot(
  page: Page,
  from: number,
  to: number,
  timeout = 10000,
): Promise<{ reordered: boolean; order: any[] }> {
  const src = page.locator(`[data-swapy-slot="slot-${from}"] [data-swapy-item]`);
  const tgt = page.locator(`[data-swapy-slot="slot-${to}"]`);
  await expect(src).toBeVisible({ timeout });
  await expect(tgt).toBeVisible({ timeout });
  // Dar tiempo a la re-vinculación de Swapy (ver comentario arriba).
  await page.waitForTimeout(1500);
  const srcBox = await src.boundingBox();
  const tgtBox = await tgt.boundingBox();
  let order: any[] = [];
  if (!srcBox || !tgtBox) return { reordered: false, order };
  const reorderPromise = page
    .waitForResponse(
      (res) => res.url().includes('/api/v1/buttons/reorder') && res.request().method() === 'POST',
      { timeout },
    )
    .then(
      (res) => {
        try {
          order = (res.request().postDataJSON() as any)?.order ?? [];
        } catch {
          order = [];
        }
        return true;
      },
      () => false,
    );
  await page.mouse.move(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(
      srcBox.x + ((tgtBox.x - srcBox.x) * i) / 10,
      srcBox.y + ((tgtBox.y - srcBox.y) * i) / 10,
      { steps: 2 },
    );
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  return { reordered: await reorderPromise, order };
}
