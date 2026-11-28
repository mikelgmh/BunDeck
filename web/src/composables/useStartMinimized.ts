/**
 * useStartMinimized — interruptor real de "Iniciar minimizado".
 *
 * FLUJO (ver daemon/src/system-autostart.ts):
 * este composable solo lee/escribe el setting `system.start_minimized` del
 * daemon (GET/POST /api/v1/settings, con broadcast WS `settings.changed`).
 * Quien lo lleva al SO es el launcher Rust (launcher/src/autostart.rs):
 * registra el exe con el flag `--minimized` para que el arranque automático
 * no robe la ventana (solo ancla + tray).
 *
 * Default ON: ausente o ilegible → true (el arranque automático no debe
 * robar la ventana).
 */

export const START_MINIMIZED_KEY = 'system.start_minimized'

/** Normaliza lo que devuelva el daemon a booleano (ausente → true). */
export function parseStartMinimizedSetting(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === '') return true
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return raw !== 0
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase()
    if (v === '') return true
    try {
      const parsed: unknown = JSON.parse(v)
      if (typeof parsed === 'boolean') return parsed
      if (typeof parsed === 'number') return (parsed as number) !== 0
    } catch {
      // No era JSON: comparación textual con veto explícito.
    }
    // Fail-open: solo las formas explícitas de apagado dan false.
    if (v === 'false' || v === '0' || v === 'no' || v === 'off' || v === 'disabled') return false
    return true
  }
  return true
}

/** Serialización canónica para el POST (siempre string 'true'/'false'). */
export function formatStartMinimizedSetting(enabled: boolean): string {
  return enabled ? 'true' : 'false'
}

/** GET /api/v1/settings?key=system.start_minimized → boolean. */
export async function loadStartMinimized(apiBase: string): Promise<boolean> {
  const res = await fetch(`${apiBase}/settings?key=${encodeURIComponent(START_MINIMIZED_KEY)}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json().catch(() => null)
  return parseStartMinimizedSetting(data?.value)
}

/** POST /api/v1/settings {key, value}. */
export async function saveStartMinimized(apiBase: string, enabled: boolean): Promise<void> {
  const res = await fetch(`${apiBase}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: START_MINIMIZED_KEY, value: formatStartMinimizedSetting(enabled) }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error || `HTTP ${res.status}`)
  }
}
