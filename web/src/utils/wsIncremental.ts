/**
 * wsIncremental — aplica los payloads de los broadcasts en vez de refetchear.
 *
 * Por el túnel relay todo (HTTP bulk + eventos + señalización) viaja por un
 * único WS ordenado, así que cada `GET /buttons` completo tras pulsar una
 * tecla o cambiar de página se suma a la cola del túnel (trompicones). Los
 * broadcasts YA traen el objeto (`button.updated` incluye `button` completo,
 * `page.updated` la página, `buttons.reordered` la lista), así que la UI
 * los aplica en local y solo refetchea cuando el payload no alcanza.
 *
 * Funciones puras (testeables sin Vue/DOM) + constantes de ritmo en túnel:
 * - debounce de recargas: 200 ms local → ~1 s en túnel.
 * - intervalo dinámico: ×4 en túnel.
 */
import type { ButtonEntity, PageData } from '../types/streamdeck'

export const LOCAL_RELOAD_DEBOUNCE_MS = 200
export const TUNNEL_RELOAD_DEBOUNCE_MS = 1000
export const TUNNEL_DYNAMIC_INTERVAL_SCALE = 4

/** Debounce de recargas WS según modo (túnel ~1 s, local 200 ms). */
export function reloadDebounceMs(isTunnel: boolean): number {
  return isTunnel ? TUNNEL_RELOAD_DEBOUNCE_MS : LOCAL_RELOAD_DEBOUNCE_MS
}

/** Factor del intervalo de sondeo dinámico (×4 en túnel). */
export function dynamicIntervalScale(isTunnel: boolean): number {
  return isTunnel ? TUNNEL_DYNAMIC_INTERVAL_SCALE : 1
}

/** ¿Debe sonar este botón dinámico ahora? (intervalo individual × escala). */
export function isDynamicDue(
  now: number,
  lastRun: number,
  baseIntervalMs: number,
  isTunnel: boolean,
): boolean {
  const interval = (baseIntervalMs > 0 ? baseIntervalMs : 1000) * dynamicIntervalScale(isTunnel)
  return now - lastRun >= interval
}

const pageOfButton = (button: any): string | null =>
  (typeof button?.page_id === 'string' && button.page_id) ||
  (typeof button?.pageId === 'string' && button.pageId) ||
  null

const pageOfPayload = (payload: any, button?: any): string | null =>
  (typeof payload?.pageId === 'string' && payload.pageId) ||
  (button ? pageOfButton(button) : null)

/**
 * Inserta o sustituye un botón por id (copia nueva, sin mutar la entrada).
 * Siempre "maneja" el evento si el botón trae id: el llamador decide si la
 * página coincide antes de llamar (ver `applyButtonPayload`).
 */
export function upsertButton(list: ButtonEntity[], button: any): ButtonEntity[] {
  if (!button || typeof button.id !== 'string') return list
  const idx = list.findIndex((b) => b.id === button.id)
  if (idx === -1) return [...list, button as ButtonEntity]
  const next = list.slice()
  next[idx] = { ...list[idx], ...button, data: (button as any).data ?? list[idx].data } as ButtonEntity
  return next
}

/** Quita un botón por id. Devuelve la lista (nueva solo si cambió) y si estaba. */
export function removeButton(
  list: ButtonEntity[],
  buttonId: string,
): { list: ButtonEntity[]; removed: boolean } {
  const idx = list.findIndex((b) => b.id === buttonId)
  if (idx === -1) return { list, removed: false }
  const next = list.slice()
  next.splice(idx, 1)
  return { list: next, removed: true }
}

export interface ApplyResult<T> {
  /** Nuevo estado (el mismo array si no cambió nada). */
  list: T
  /**
   * ¿Quedó manejado SIN refetch? true = el llamador NO debe pedir
   * `GET /buttons` (el payload alcanzó o era de otra página).
   */
  handled: boolean
}

/**
 * Aplica `button.created` / `button.updated` con el objeto del evento.
 * - Otra página → handled (nada que refetchear: no es nuestra vista).
 * - Sin `button` en el payload → no manejado (fallback a recarga).
 */
export function applyButtonPayload(
  list: ButtonEntity[],
  currentPageId: string | null,
  payload: any,
): ApplyResult<ButtonEntity[]> {
  const button = payload?.button
  if (!button || typeof button.id !== 'string') return { list, handled: false }
  if (!currentPageId) return { list, handled: false }
  const target = pageOfPayload(payload, button)
  if (target && target !== currentPageId) return { list, handled: true }
  return { list: upsertButton(list, button), handled: true }
}

/** Aplica `button.deleted` con el id del evento (sin `GET /buttons`). */
export function applyButtonDeleted(
  list: ButtonEntity[],
  currentPageId: string | null,
  payload: any,
): ApplyResult<ButtonEntity[]> {
  const buttonId =
    (typeof payload?.buttonId === 'string' && payload.buttonId) ||
    (typeof payload?.button?.id === 'string' && payload.button.id) ||
    null
  if (!buttonId || !currentPageId) return { list, handled: false }
  const target = pageOfPayload(payload, payload?.button)
  if (target && target !== currentPageId) return { list, handled: true }
  const { list: next } = removeButton(list, buttonId)
  return { list: next, handled: true }
}

/**
 * Aplica `buttons.reordered` con la lista del evento (el daemon ya manda
 * el orden final). Sin array en el payload → no manejado (recarga).
 */
export function applyButtonsReordered(
  list: ButtonEntity[],
  currentPageId: string | null,
  payload: any,
): ApplyResult<ButtonEntity[]> {
  const pageId = typeof payload?.pageId === 'string' ? payload.pageId : null
  if (!currentPageId || !pageId || pageId !== currentPageId) {
    // Otra página (o sin página): no es nuestra vista, nada que refetchear.
    return { list, handled: pageId !== currentPageId }
  }
  if (!Array.isArray(payload?.buttons)) return { list, handled: false }
  return { list: (payload.buttons as ButtonEntity[]).slice(), handled: true }
}

/** Inserta o sustituye una página por id (eventos `page.created/updated`). */
export function upsertPage(list: PageData[], page: any): PageData[] {
  if (!page || typeof page.id !== 'string') return list
  const idx = list.findIndex((p) => p.id === page.id)
  if (idx === -1) return [...list, page as PageData]
  const next = list.slice()
  next[idx] = { ...list[idx], ...page } as PageData
  return next
}

/**
 * Aplica `page.created` / `page.updated` con el objeto del evento.
 * Sin `page` en el payload → no manejado (fallback a recarga).
 */
export function applyPagePayload(
  list: PageData[],
  payload: any,
): ApplyResult<PageData[]> {
  const page = payload?.page
  if (!page || typeof page.id !== 'string') {
    // Algunos emisores mandan solo el id: si ya la tenemos, basta con
    // marcar manejado (el renombrado viaja en el siguiente `page.updated`
    // completo); si no, recarga.
    const onlyId = typeof payload?.pageId === 'string' ? payload.pageId : null
    if (onlyId && list.some((p) => p.id === onlyId)) return { list, handled: true }
    return { list, handled: false }
  }
  return { list: upsertPage(list, page), handled: true }
}

/** Quita una página por id (`page.deleted`). */
export function applyPageDeleted(
  list: PageData[],
  pageId: string | null | undefined,
): { list: PageData[]; removed: boolean } {
  if (typeof pageId !== 'string' || !pageId) return { list, removed: false }
  const idx = list.findIndex((p) => p.id === pageId)
  if (idx === -1) return { list, removed: false }
  const next = list.slice()
  next.splice(idx, 1)
  return { list: next, removed: true }
}

export interface BatchItem {
  action: any
  context: Record<string, any>
}

/**
 * Cuerpo del batch de ejecución/sondeo (`POST /actions/execute-many`):
 * un solo round-trip por botón (pulsación) o por tick de página (sondeo)
 * en vez de N `POST /actions/execute` en serie/ráfaga.
 */
export function buildExecuteManyBody(items: BatchItem[]): { items: BatchItem[] } {
  return { items: items.map(({ action, context }) => ({ action, context })) }
}

/** ¿El error es "endpoint desconocido" (daemon viejo sin batch)? → fallback serie. */
export function isBatchUnsupported(error: unknown): boolean {
  const msg = String((error as any)?.message ?? error ?? '')
  return /404|endpoint not found|not found/i.test(msg)
}
