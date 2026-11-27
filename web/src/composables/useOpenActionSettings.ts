import { isHostClient } from './useBunDeckUi'

/**
 * useOpenActionSettings — abre el drawer derecho (KeyInspector) con los
 * ajustes de la acción de un control de superficie.
 *
 * Mecanismo (no existía ningún evento: se crea aquí):
 * - El widget dispara `window.dispatchEvent(new CustomEvent(
 *   'bundeck:open-action-settings', { detail, cancelable: true }))`.
 * - `BunDeckApp` (host local, vista completa con drawer) lo escucha:
 *   selecciona la tecla (`selectButton(position)`, igual que un clic en la
 *   tecla), asegura el drawer derecho abierto (`bdSetPanels(..., true)`) y
 *   llama `preventDefault()` para marcarlo como gestionado.
 * - Es necesario porque `ControlSurface.vue` detiene los eventos en modo
 *   uso: los clics dentro del widget NUNCA llegan al manejador de la tecla
 *   (`StageBoard` → `button-click` → `selectButton`). En edición los eventos
 *   sí burbujean y seleccionan directamente; el badge sigue usando este
 *   evento para además abrir el drawer con los ajustes de la acción.
 *
 * En remoto (cliente LAN/túnel, `!isHostClient()`, o vista solo-uso
 * `MobileDeck` sin inspector): si el evento no fue gestionado se abre la
 * UI web de bundeck en una pestaña nueva para configurar allí. Por defecto
 * se usa `window.location.origin + '/'` (best-effort: en LAN sirve la app;
 * en túnel puede no resolver); pásese `remoteUrl` explícito para fijarlo
 * (hook preparado, p. ej. la URL del QR de conexión).
 *
 * En kiosco no hay drawer: el evento queda sin gestionar y no se hace nada
 * (el badge de NeedsConfig sigue siendo informativo).
 */

export const OPEN_ACTION_SETTINGS_EVENT = 'bundeck:open-action-settings'

export interface OpenActionSettingsDetail {
  /** Tipo de acción (`pid.aid`), solo informativo para el listener. */
  actionType?: string
  /** Posición de la tecla en el grid (la que StageBoard pasa a ControlSurface). */
  position?: number | null
}

export type OpenActionSettingsResult = 'drawer' | 'remote' | 'unhandled'

export interface OpenActionSettingsOptions {
  actionType?: string
  position?: number | null
  /** URL de la UI de bundeck para el fallback remoto. Defecto: origin + '/'. */
  remoteUrl?: string
}

/** URL best-effort de la UI web de bundeck (fallback remoto). */
export function bundeckRootUrl(): string {
  try {
    if (typeof window !== 'undefined' && window.location?.origin) {
      return `${String(window.location.origin).replace(/\/$/, '')}/`
    }
  } catch {
    /* sin window (SSR/tests) */
  }
  return '/'
}

export function useOpenActionSettings() {
  const openActionSettings = (opts: OpenActionSettingsOptions = {}): OpenActionSettingsResult => {
    const detail: OpenActionSettingsDetail = {
      actionType: opts.actionType,
      position: typeof opts.position === 'number' ? opts.position : null,
    }
    let handled = false
    try {
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        const event = new CustomEvent<OpenActionSettingsDetail>(OPEN_ACTION_SETTINGS_EVENT, {
          detail,
          cancelable: true,
        })
        // dispatchEvent devuelve false si algún listener llamó preventDefault()
        // (= BunDeckApp gestionó el drawer).
        handled = window.dispatchEvent(event) === false
      }
    } catch {
      handled = false
    }
    if (handled) return 'drawer'
    // Sin drawer local y en remoto: abrir bundeck en la web para configurar.
    try {
      if (!isHostClient() && typeof window !== 'undefined' && typeof window.open === 'function') {
        window.open(opts.remoteUrl ?? bundeckRootUrl(), '_blank', 'noopener')
        return 'remote'
      }
    } catch {
      /* best-effort */
    }
    return 'unhandled'
  }

  return { openActionSettings, bundeckRootUrl, OPEN_ACTION_SETTINGS_EVENT }
}
