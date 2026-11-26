/**
 * Presentación que una acción aporta a la tecla.
 *
 * - `plain`: acción de ejecución. Hace algo al pulsar, no cambia lo que se ve.
 * - `data`: dato dinámico (`dynamic: true` en el manifest). Su valor se
 *   muestra DENTRO de la tecla estándar (icono/texto/imagen se conservan).
 *   Pueden coexistir varias; gana la primera (igual que el polling actual).
 * - `control`: control interactivo (`surface: 'control'` + `component`
 *   conocido). POSEE la superficie: reemplaza el contenido de la tecla por un
 *   componente propio. Solo cabe un control por tecla.
 *
 * El render solo usa la lista cerrada CONTROL_ACTION_COMPONENTS (tipo de
 * acción → componente). El daemon nunca envía HTML/JS a renderizar.
 */

/** Componentes visuales que la UI sabe renderizar para un control. */
export const CONTROL_COMPONENTS = [
  'volume-range',
  'audio-control',
  'media-transport',
  'smart-home',
  'spotify-player',
  'voice-panel',
  'soundboard',
  'stream-studio',
  'creative-tools',
  'calendar-agenda',
  'pomodoro',
  'status-cards',
  'workflow-control',
] as const
export type ControlComponent = (typeof CONTROL_COMPONENTS)[number]

/**
 * ¿Coincide una acción con la búsqueda del usuario? Biblioteca y paleta usan
 * el MISMO criterio (nombre + tipo + grupo): antes la biblioteca miraba
 * nombre+tipo y la paleta nombre+grupo, así que `toast` daba 0 en paleta y
 * `home assistant` 0 en biblioteca aunque la acción existía.
 */
export function matchesActionQuery(
  action: { name?: unknown; type?: unknown; group?: unknown },
  query: unknown,
): boolean {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return true
  const haystack = [action?.name, action?.type, action?.group]
    .map((v) => (typeof v === 'string' ? v : ''))
    .join(' ')
    .toLowerCase()
  return q.split(/\s+/).every((token) => token.length === 0 || haystack.includes(token))
}

/**
 * Qué tipo de acción renderiza cada componente de control.
 * Fuente de verdad del render y de las reglas de compatibilidad.
 */
export const CONTROL_ACTION_COMPONENTS: Record<string, ControlComponent> = {
  'audio-mixer.volume-control': 'volume-range',
  'audio-mixer.mic-mute': 'audio-control',
  'audio-mixer.output-switch': 'audio-control',
  'multimedia.multimedia': 'media-transport',
  'homeassistant.entity': 'smart-home',
  'homeassistant.light': 'smart-home',
  'homeassistant.switch': 'smart-home',
  'homeassistant.cover-control': 'smart-home',
  'homeassistant.climate-set': 'smart-home',
  'homeassistant.sensor-value': 'smart-home',
  'homeassistant.get-state': 'smart-home',
  'hue-extra.toggle': 'smart-home',
  'hue-extra.brightness': 'smart-home',
  'hue-extra.color': 'smart-home',
  'hue-extra.scene': 'smart-home',
  'govee.toggle': 'smart-home',
  'govee.brightness': 'smart-home',
  'govee.color': 'smart-home',
  'govee.scene': 'smart-home',
  'spotify.now-playing': 'spotify-player',
  'discord.toggle-mute': 'voice-panel',
  'discord.status': 'voice-panel',
  'meetings.control': 'voice-panel',
  'voicemod.get-status': 'voice-panel',
  'voicemeeter.strip-mute': 'voice-panel',
  'voicemeeter.bus-mute': 'voice-panel',
  'soundboard.play': 'soundboard',
  'obs.status': 'stream-studio',
  'twitch.viewer-count': 'stream-studio',
  'youtube.viewer-count': 'stream-studio',
  'shadowplay.check-status': 'stream-studio',
  'premiere.transport': 'creative-tools',
  'davinci.transport': 'creative-tools',
  'photoshop.brush-size': 'creative-tools',
  'blender.viewport': 'creative-tools',
  'calendar.next-event': 'calendar-agenda',
  'timer.start': 'pomodoro',
  'timer.stop': 'pomodoro',
  'timer.status': 'pomodoro',
  'pc-vitals.summary': 'status-cards',
  'pc-vitals.monitor': 'status-cards',
  'pc-vitals.fan-speed': 'status-cards',
  'pc-vitals.disk-usage': 'status-cards',
  'pc-vitals.net-speed': 'status-cards',
  'pc-vitals.uptime': 'status-cards',
  'pc-vitals.process-top': 'status-cards',
  'weather.now': 'status-cards',
  'weather.forecast': 'status-cards',
  'email.unread': 'status-cards',
  'email.open-inbox': 'status-cards',
  'slack.unread-count': 'status-cards',
  'slack.open-channel': 'status-cards',
  'minecraft.server-status': 'status-cards',
  'minecraft.query-latency': 'status-cards',
  'steam.presence': 'status-cards',
  'steam.server-status': 'status-cards',
  'webcam.snapshot': 'status-cards',
  'clipboard.history': 'workflow-control',
  'clipboard.list-slots': 'workflow-control',
  'clipboard.paste-slot': 'workflow-control',
  'clipboard.save-slot': 'workflow-control',
  'flow.set-var': 'workflow-control',
  'flow.toggle-var': 'workflow-control',
  'flow.get-var': 'workflow-control',
  'profile-auto.status': 'workflow-control',
  'profile-auto.switch-profile': 'workflow-control',
  'page.page': 'workflow-control',
  'window-manager.layout-list': 'workflow-control',
  'window-manager.layout-restore': 'workflow-control',
  'midi-osc.send-osc': 'workflow-control',
}

export type SurfaceKind = 'plain' | 'data' | 'control'

/** Busca la definición (adata) de un tipo de acción en la lista de plugins. */
export function findActionAdata(plugins: any[] | undefined, type: string): any | null {
  if (!type || typeof type !== 'string') return null
  for (const entry of plugins ?? []) {
    const [pid, pdata] = entry as [string, any]
    for (const [aid, adata] of pdata?.actions ?? []) {
      if (`${pid}.${aid}` === type) return adata ?? null
    }
  }
  // Tipo sin prefijo o legacy: coincide por sufijo.
  for (const entry of plugins ?? []) {
    const [, pdata] = entry as [string, any]
    for (const [aid, adata] of pdata?.actions ?? []) {
      if (aid === type) return adata ?? null
    }
  }
  return null
}

/** Clase de presentación de una acción a partir de su adata de manifest. */
export function actionSurfaceKind(adata: any): SurfaceKind {
  if (!adata || typeof adata !== 'object') return 'plain'
  if (adata.surface === 'control' && typeof adata.component === 'string' &&
    (CONTROL_COMPONENTS as readonly string[]).includes(adata.component)) {
    return 'control'
  }
  if (adata.dynamic === true) return 'data'
  return 'plain'
}

/** Clase de presentación de un tipo de acción (`pid.aid`). */
export function actionTypeSurfaceKind(plugins: any[] | undefined, type: string): SurfaceKind {
  // Mapa cerrado primero: vale aunque el manifest aún no haya llegado.
  if (typeof type === 'string' && CONTROL_ACTION_COMPONENTS[type]) return 'control'
  return actionSurfaceKind(findActionAdata(plugins, type))
}

/** ¿Es este objeto de acción guardado un control de superficie? */
export function isControlAction(action: any): boolean {
  if (!action || typeof action.type !== 'string') return false
  return !!CONTROL_ACTION_COMPONENTS[action.type]
}

/** Primer control de superficie en una lista de acciones (o undefined). */
export function findControlAction(actions: any): any | undefined {
  if (!Array.isArray(actions)) return undefined
  return actions.find(isControlAction)
}

/** Componente que debe renderizar un tipo de acción de control (o null). */
export function controlComponentOf(type: string): ControlComponent | null {
  return (typeof type === 'string' && CONTROL_ACTION_COMPONENTS[type]) || null
}
