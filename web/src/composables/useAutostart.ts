/**
 * useAutostart — interruptor real de "Iniciar con el sistema".
 *
 * FLUJO (ver daemon/src/system-autostart.ts):
 * este composable solo lee/escribe el setting `system.autostart` del daemon
 * (GET/POST /api/v1/settings, con broadcast WS `settings.changed`).
 * Quien lo lleva al SO es el launcher Rust (launcher/src/autostart.rs):
 * Windows HKCU…\Run, Linux ~/.config/autostart, macOS LaunchAgents.
 * El tray del launcher siempre está activo y los updates los gestiona el
 * launcher/updater: por eso aquí no hay toggles para eso (se eliminaron
 * los mocks `mock.tray`, `mock.updates`, `mock.undo`).
 */

export const AUTOSTART_KEY = 'system.autostart'

/** Normaliza lo que devuelva el daemon a booleano (nunca arrancar por defecto). */
export function parseAutostartSetting(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return raw !== 0
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase()
    try {
      const parsed: unknown = JSON.parse(v)
      if (typeof parsed === 'boolean') return parsed
      if (typeof parsed === 'number') return (parsed as number) !== 0
    } catch {
      // No era JSON: comparación textual.
    }
    return v === '1' || v === 'true' || v === 'on' || v === 'yes' || v === 'enabled'
  }
  return false
}

/** Serialización canónica para el POST (siempre string 'true'/'false'). */
export function formatAutostartSetting(enabled: boolean): string {
  return enabled ? 'true' : 'false'
}

/** GET /api/v1/settings?key=system.autostart → boolean. */
export async function loadAutostart(apiBase: string): Promise<boolean> {
  const res = await fetch(`${apiBase}/settings?key=${encodeURIComponent(AUTOSTART_KEY)}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json().catch(() => null)
  return parseAutostartSetting(data?.value)
}

/** POST /api/v1/settings {key, value}. */
export async function saveAutostart(apiBase: string, enabled: boolean): Promise<void> {
  const res = await fetch(`${apiBase}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: AUTOSTART_KEY, value: formatAutostartSetting(enabled) }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error || `HTTP ${res.status}`)
  }
}
