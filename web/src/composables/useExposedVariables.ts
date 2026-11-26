import { computed } from 'vue'
import { vars, getVar } from './useVars'
import { fmt } from './useExpressions'

/**
 * Catálogo web espejo del contrato daemon (`variables/exposed.ts`):
 * qué variable expone cada acción. La fuente de verdad del VALOR es el
 * daemon (las escrituras llegan por WS `variable.changed` y se funden en
 * `vars` vía `upsertRemoteVar`); aquí solo se declara el mapeo para listar
 * "variables disponibles" en la pestaña Aspecto.
 */
export interface ExposedVarDecl {
  name: string
  type: 'bool'
  action: string
}

export const EXPOSED_ACTION_VARS: Record<string, ExposedVarDecl[]> = {
  'discord.toggle-mute': [{ name: 'discordMuted', type: 'bool', action: 'discord.toggle-mute' }],
  'discord.toggle-deafen': [{ name: 'discordDeafened', type: 'bool', action: 'discord.toggle-deafen' }],
  'obs.mute': [{ name: 'obsMuted', type: 'bool', action: 'obs.mute' }],
  'obs.stream': [{ name: 'obsStreaming', type: 'bool', action: 'obs.stream' }],
  'obs.record': [{ name: 'obsRecording', type: 'bool', action: 'obs.record' }],
  'audio-mixer.mic-mute': [{ name: 'audioMicMuted', type: 'bool', action: 'audio-mixer.mic-mute' }],
  'multimedia.multimedia': [
    { name: 'multimediaMuted', type: 'bool', action: 'multimedia.multimedia' },
    { name: 'multimediaPlaying', type: 'bool', action: 'multimedia.multimedia' },
  ],
}

export interface AvailableVar {
  name: string
  type: string
  /** 'action' = la expone una acción de esta tecla; 'global' = Ajustes → Variables. */
  origin: 'action' | 'global'
  fromAction?: string
  live: string
}

function asList(v: unknown): any[] {
  return Array.isArray(v) ? v : []
}

/** Acciones en todas las listas de la tecla (click/double/triple/long + reglas). */
export function keyActionsOf(buttonConfig: any): any[] {
  const out: any[] = []
  out.push(...asList(buttonConfig?.actions))
  const pa = buttonConfig?.pressActions
  if (pa && typeof pa === 'object') {
    for (const k of ['click', 'double', 'triple', 'long'] as const) out.push(...asList((pa as any)[k]))
  }
  for (const r of asList(buttonConfig?.rules)) {
    out.push(...asList((r as any)?.then), ...asList((r as any)?.else))
  }
  return out.filter((a) => a && typeof a === 'object')
}

/**
 * Variables disponibles en Aspecto: primero las que exponen las acciones
 * DE ESTA TECLA (con su valor actual en vivo), luego el resto de globales.
 */
export function availableVarsOf(buttonConfig: any): AvailableVar[] {
  const seen = new Set<string>()
  const out: AvailableVar[] = []
  for (const a of keyActionsOf(buttonConfig)) {
    const t = String(a?.type ?? '')
    // Solo cuenta el `multimedia` que realmente cambia estado (play/pause/
    // stop/mute/playpause): subir volumen no expone nada útil.
    const decls = (EXPOSED_ACTION_VARS[t] ?? []).filter((d) => {
      if (t !== 'multimedia.multimedia') return true
      const act = String(a?.parameters?.action ?? '').toLowerCase()
      if (d.name === 'multimediaMuted') return act === 'mute' || act === 'volumemute'
      return ['play', 'pause', 'playpause', 'stop'].includes(act)
    })
    for (const d of decls) {
      if (seen.has(d.name)) continue
      seen.add(d.name)
      const v = getVar(d.name)
      out.push({
        name: d.name,
        type: d.type,
        origin: 'action',
        fromAction: t,
        live: v ? fmt(v.v) : '',
      })
    }
  }
  for (const v of vars.value) {
    if (seen.has(v.n)) continue
    seen.add(v.n)
    out.push({ name: v.n, type: v.t, origin: 'global', live: fmt(v.v) })
  }
  // Variable de estados (sección Estados): se gobierna desde la tecla y sus
  // condiciones la leen; si aún no existe en Ajustes se muestra sin valor.
  const sv = String(buttonConfig?.stateVar ?? '').trim()
  if (sv && !seen.has(sv)) {
    const v = getVar(sv)
    out.push({ name: sv, type: 'num', origin: 'global', live: v ? fmt(v.v) : '' })
  }
  return out
}

/** Versión reactiva para la pestaña Aspecto. */
export function useAvailableVars(buttonConfig: () => any) {
  return computed(() => availableVarsOf(buttonConfig()))
}
