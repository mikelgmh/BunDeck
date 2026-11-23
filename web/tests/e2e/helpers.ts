import type { APIRequestContext, Page } from '@playwright/test';

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
