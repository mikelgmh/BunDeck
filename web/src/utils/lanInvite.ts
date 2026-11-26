/**
 * lanInvite — helpers puros para la invitación LAN (?invite=<código>).
 *
 * El QR local y el enlace copiable llevan la MISMA URL con el MISMO código
 * de un solo uso (un único sistema): el daemon la canjea por una sesión
 * (cookie `ld_lan` + token en memoria) al abrir el enlace o vía
 * POST /remote/lan-redeem.
 */

export const LAN_INVITE_PARAM = 'invite'
export const LAN_SESSION_KEY = 'libredeck_lan_session'
export const LAN_DENIED_CODE = 'LAN_INVITE_REQUIRED'
/**
 * Vía de escape al relay cuando el canje LAN falla (`?relayFallback=<urlCode>`).
 * Lo pone la waiting del relay al redirigir al fast-path LAN. Solo es un
 * CÓDIGO (nunca un dominio: la LAN no puede saber el dominio del relay, así
 * que jamás se construye una URL con él): se muestra + se copia, sin
 * redirigir jamás de vuelta solo (anti-bucle).
 */
export const RELAY_FALLBACK_PARAM = 'relayFallback'
/** urlCode válido: alfanumérico + `_-`, 4–64 chars (p. ej. `AbC123xYz`). */
const RELAY_FALLBACK_RE = /^[A-Za-z0-9_-]{4,64}$/

/** Código de escape al relay en la URL (`?relayFallback=<urlCode>`), o null. */
export function parseRelayFallbackFromUrl(search?: string | null): string | null {
  try {
    const q = String(search ?? (typeof window !== 'undefined' ? window.location.search : ''))
    if (!q) return null
    const params = new URLSearchParams(q.startsWith('?') ? q : `?${q}`)
    const v = (params.get(RELAY_FALLBACK_PARAM) ?? '').trim()
    return RELAY_FALLBACK_RE.test(v) ? v : null
  } catch {
    return null
  }
}

/** Código de invitación en la URL (`?invite=<código>`). */
export function parseLanInviteFromUrl(search?: string | null): string | null {
  try {
    const q = String(search ?? (typeof window !== 'undefined' ? window.location.search : ''))
    if (!q) return null
    const params = new URLSearchParams(q.startsWith('?') ? q : `?${q}`)
    const v = (params.get('invite') ?? params.get('lanInvite') ?? '').trim()
    return v ? v : null
  } catch {
    return null
  }
}

/**
 * URL de invitado: misma base + `?invite=<código>` (+ `kiosk=1` para que el
 * móvil aterrice en modo uso). Es lo que codifica el QR y lo que se copia
 * con el botón Copiar: un único enlace, sin segundo sistema.
 */
export function buildLanInviteUrl(base: string, code: string, kiosk = true): string {
  const c = String(code ?? '').trim()
  if (!c) return String(base ?? '')
  try {
    const u = new URL(String(base ?? ''), 'http://localhost')
    u.searchParams.set(LAN_INVITE_PARAM, c)
    if (kiosk) u.searchParams.set('kiosk', '1')
    const s = u.toString()
    // Base relativa → devolver relativa.
    if (!/^[a-z]+:\/\//i.test(String(base ?? ''))) return u.pathname + u.search + u.hash
    return s
  } catch {
    const sep = String(base).includes('?') ? '&' : '?'
    return `${base}${sep}${LAN_INVITE_PARAM}=${encodeURIComponent(c)}`
  }
}

/** Quita `?invite=` de la URL (el código es de un solo uso: no reenviarlo). */
export function stripLanInviteFromUrl(url: string): string {
  try {
    const u = new URL(String(url), 'http://localhost')
    u.searchParams.delete('invite')
    u.searchParams.delete('lanInvite')
    const s = u.toString()
    if (!/^[a-z]+:\/\//i.test(String(url ?? ''))) return u.pathname + u.search + u.hash
    return s
  } catch {
    return String(url)
  }
}

export function getStoredLanSession(
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null,
): string | null {
  try {
    const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
    const v = s?.getItem(LAN_SESSION_KEY)?.trim()
    return v ? v : null
  } catch {
    return null
  }
}

export function setStoredLanSession(
  token: string,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null,
): void {
  try {
    const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
    if (String(token ?? '').trim()) s?.setItem(LAN_SESSION_KEY, String(token).trim())
  } catch {
    /* almacenamiento no disponible */
  }
}

export function clearStoredLanSession(
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null,
): void {
  try {
    const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
    s?.removeItem(LAN_SESSION_KEY)
  } catch {
    /* noop */
  }
}

/** ¿Es un error de falta de invitación? (el que muestra "Sin permiso"). */
export function isLanDeniedError(input: unknown, status?: number): boolean {
  const code = (input as { code?: unknown } | null)?.code
  if (code === LAN_DENIED_CODE) return true
  const msg = String((input as { message?: unknown } | null)?.message ?? input ?? '')
  if (msg.includes(LAN_DENIED_CODE)) return true
  // Respuesta JSON del daemon: { error, code } con 401/403.
  if ((status === 401 || status === 403) && /sin permiso|LAN_INVITE_REQUIRED/i.test(msg)) return true
  return false
}
