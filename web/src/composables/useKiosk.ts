/**
 * useKiosk — modo KIOSCO / PRESENTACIÓN de BunDeck.
 *
 * Fuente de verdad: la URL.
 * - Entrada: `?kiosk=1` (también `?kiosk=true|yes|on`, `?mode=kiosk` o `#kiosk`).
 *   Los QR y enlaces de conexión (QrDialog local, RemotePane/túnel `/ui/…`)
 *   propagan el parámetro para que el escaneo aterrice ya en kiosco.
 * - Salida: botón Salir de la barra inferior `data-cy="bd-kiosk-exit"`
 *   (+ confirmación), triple-tap en la esquina superior derecha o tecla
 *   Escape. Al salir se limpia el parámetro de la URL con
 *   `history.replaceState` (sin recargar).
 *
 * Mientras dura el kiosco el modo `edit` queda bloqueado: `guardModeChange`
 * veta el paso a `'edit'` y `BunDeckApp` no renderiza header/drawers/toolbars.
 */

export type KioskExitReason = 'button' | 'corner' | 'escape'

/** Valores truthy aceptados para `?kiosk=`. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

/**
 * ¿Pide la URL entrar en kiosco?
 * Acepta `URLSearchParams`-like en `search` (`?kiosk=1`, `?mode=kiosk`, …)
 * y el fragmento en `hash` (`#kiosk`, `#…kiosk=1`, `#mode=kiosk`).
 * Nunca lanza (jsdom/SSR sin location).
 */
export function parseKioskMode(search?: string | null, hash?: string | null): boolean {
  try {
    const q = String(search ?? '')
    if (q) {
      const params = new URLSearchParams(q.startsWith('?') ? q : `?${q}`)
      const k = params.get('kiosk')
      if (k !== null && TRUTHY.has(k.trim().toLowerCase())) return true
      if ((params.get('mode') ?? '').trim().toLowerCase() === 'kiosk') return true
    }
    const h = String(hash ?? '').replace(/^#/, '')
    if (h) {
      if (/(^|[&#;])kiosk([=&#;]|$)/i.test(`&${h}`)) return true
      try {
        const hp = new URLSearchParams(h)
        const hk = hp.get('kiosk')
        if (hk !== null && TRUTHY.has(hk.trim().toLowerCase())) return true
        if ((hp.get('mode') ?? '').trim().toLowerCase() === 'kiosk') return true
      } catch {
        /* hash no parseable como query: ya cubierto por la regex */
      }
    }
    return false
  } catch {
    return false
  }
}

/** Lee `window.location` (inyectable para tests). */
export function parseKioskFromLocation(
  loc?: { search?: string | null; hash?: string | null } | null,
): boolean {
  try {
    const l =
      loc ??
      (typeof window !== 'undefined'
        ? { search: window.location.search, hash: window.location.hash }
        : null)
    if (!l) return false
    return parseKioskMode(l.search ?? '', l.hash ?? '')
  } catch {
    return false
  }
}

/**
 * Devuelve la URL con `kiosk=1` añadido (query, preservando hash).
 * Idempotente: si ya pide kiosco, la devuelve tal cual.
 */
export function withKioskParam(rawUrl: string): string {
  try {
    const u = new URL(String(rawUrl ?? ''), 'http://localhost')
    if (parseKioskMode(u.search, u.hash)) return String(rawUrl)
    u.searchParams.set('kiosk', '1')
    // URL absoluta → string completo; relativa → solo path+query+hash.
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(String(rawUrl))) return u.toString()
    return `${u.pathname}${u.search}${u.hash}`
  } catch {
    return String(rawUrl ?? '')
  }
}

/** Quita `kiosk`/`mode=kiosk` de la URL (para la salida del kiosco). */
export function withoutKioskParam(rawUrl: string): string {
  try {
    const absolute = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(String(rawUrl))
    const u = new URL(String(rawUrl ?? ''), 'http://localhost')
    u.searchParams.delete('kiosk')
    if ((u.searchParams.get('mode') ?? '').toLowerCase() === 'kiosk') {
      u.searchParams.delete('mode')
    }
    let h = u.hash
    if (h) {
      try {
        const hp = new URLSearchParams(h.replace(/^#/, ''))
        hp.delete('kiosk')
        if ((hp.get('mode') ?? '').toLowerCase() === 'kiosk') hp.delete('mode')
        const rest = hp.toString()
        h = rest ? `#${rest}` : ''
      } catch {
        h = h.replace(/(^|[&#;])kiosk([=&#;]|$)/gi, '$1').replace(/[#&;]+$/, '')
      }
    }
    if (absolute) return `${u.origin === 'http://localhost' && !absolute ? '' : u.origin}${u.pathname}${u.search}${h}`
    return `${u.pathname}${u.search}${h}`
  } catch {
    return String(rawUrl ?? '')
  }
}

/**
 * ¿Son estos taps un triple-tap? `times` = marcas (ms) de los últimos taps.
 * Ventana por defecto 600 ms.
 */
export function isTripleTap(times: number[], now: number, windowMs = 600): boolean {
  if (!Array.isArray(times) || times.length < 3) return false
  const recent = times.filter((t) => Number.isFinite(t) && now - t >= 0 && now - t <= windowMs)
  return recent.length >= 3
}

/**
 * Intenta pantalla completa. Nunca lanza ni rechaza: devuelve `true` si se
 * logró, `false` si el navegador lo bloqueó (el kiosco sigue funcionando).
 */
export async function requestFullscreen(): Promise<boolean> {
  try {
    if (typeof document === 'undefined') return false
    if (document.fullscreenElement) return true
    const el = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void
    }
    if (typeof el.requestFullscreen === 'function') {
      await el.requestFullscreen()
      return true
    }
    if (typeof el.webkitRequestFullscreen === 'function') {
      await el.webkitRequestFullscreen()
      return false
    }
    return false
  } catch {
    return false
  }
}

/** Veta el modo `edit` mientras dure el kiosco. */
export function guardModeChange(kiosk: boolean, next: 'edit' | 'use'): 'edit' | 'use' {
  if (kiosk && next === 'edit') return 'use'
  return next
}

/**
 * ¿Debe animarse el marquee de la barra? Solo con overflow REAL del texto
 * (`textWidth` = ancho del `span` del texto, `boxWidth` = ancho visible).
 * Se mide el `span`, NO el grupo: su `padding-right` de separación entre
 * copias inflaría `scrollWidth` y activaría el marquee aun con espacio de
 * sobra. +1px de tolerancia anti-subpíxel.
 */
export function marqueeOverflows(textWidth: number, boxWidth: number): boolean {
  if (!Number.isFinite(textWidth) || !Number.isFinite(boxWidth)) return false
  return textWidth > boxWidth + 1
}
