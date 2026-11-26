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

/**
 * Pareja de apariencias predefinidas para una variable de estado (on/off).
 * `color`/`bg` son índices de paleta (como los looks: SWATCHES/LOOK_BGS);
 * `titleKey` es clave i18n resuelta al añadir (respeta el idioma actual).
 */
export interface VarStatePreset {
  varName: string
  cond: string
  titleKey: string
  icon: string
  color: number | null
  bg: number
}
export interface VarStatePresetGroup {
  varName: string
  fromAction: string
  on: VarStatePreset
  off: VarStatePreset
}

/** Curaduría por variable expuesta: qué par on/off se ofrece. */
const VAR_STATE_PRESET_DEFS: Record<
  string,
  { action: string; iconOn: string; iconOff: string; titleOnKey: string; titleOffKey: string; colorOn: number | null; bgOn: number }
> = {
  discordMuted: { action: 'discord.toggle-mute', iconOn: 'MicOff', iconOff: 'Mic', titleOnKey: 'bd.presetDiscordMuted', titleOffKey: 'bd.presetDiscordLive', colorOn: 4, bgOn: 1 },
  discordDeafened: { action: 'discord.toggle-deafen', iconOn: 'VolumeX', iconOff: 'Volume2', titleOnKey: 'bd.presetDiscordDeafened', titleOffKey: 'bd.presetDiscordAudio', colorOn: 4, bgOn: 1 },
  obsMuted: { action: 'obs.mute', iconOn: 'MicOff', iconOff: 'Mic', titleOnKey: 'bd.presetObsMuted', titleOffKey: 'bd.presetObsAudio', colorOn: 4, bgOn: 1 },
  obsStreaming: { action: 'obs.stream', iconOn: 'Radio', iconOff: '', titleOnKey: 'bd.presetObsLive', titleOffKey: 'bd.presetObsOffline', colorOn: 4, bgOn: 1 },
  obsRecording: { action: 'obs.record', iconOn: 'Disc', iconOff: '', titleOnKey: 'bd.presetObsRec', titleOffKey: 'bd.presetObsNotRec', colorOn: 4, bgOn: 1 },
  audioMicMuted: { action: 'audio-mixer.mic-mute', iconOn: 'MicOff', iconOff: 'Mic', titleOnKey: 'bd.presetMicMuted', titleOffKey: 'bd.presetMicOpen', colorOn: 4, bgOn: 1 },
  multimediaMuted: { action: 'multimedia.multimedia', iconOn: 'VolumeX', iconOff: 'Volume2', titleOnKey: 'bd.presetMmMuted', titleOffKey: 'bd.presetMmSound', colorOn: 4, bgOn: 1 },
  multimediaPlaying: { action: 'multimedia.multimedia', iconOn: 'Play', iconOff: 'Pause', titleOnKey: 'bd.presetMmPlaying', titleOffKey: 'bd.presetMmPaused', colorOn: 2, bgOn: 0 },
}

/**
 * Pares on/off predefinidos para las variables de estado DE ESTA TECLA.
 * Un clic añade el look correspondiente (se omite si la cond ya existe).
 */
export function presetsFor(buttonConfig: any): VarStatePresetGroup[] {
  const seen = new Set<string>()
  const out: VarStatePresetGroup[] = []
  for (const a of keyActionsOf(buttonConfig)) {
    for (const g of presetsForAction(String(a?.type ?? ''))) {
      if (seen.has(g.varName)) continue
      seen.add(g.varName)
      out.push(g)
    }
  }
  return out
}

/** Pares on/off de UNA acción (los que aporta al añadirla a la tecla). */
export function presetsForAction(type: string): VarStatePresetGroup[] {
  const out: VarStatePresetGroup[] = []
  for (const d of EXPOSED_ACTION_VARS[String(type ?? '')] ?? []) {
    if (d.type !== 'bool') continue
    const def = VAR_STATE_PRESET_DEFS[d.name]
    if (!def) continue
    out.push({
      varName: d.name,
      fromAction: String(type ?? ''),
      on: { varName: d.name, cond: d.name, titleKey: def.titleOnKey, icon: def.iconOn, color: def.colorOn, bg: def.bgOn },
      off: { varName: d.name, cond: `${d.name} == falso`, titleKey: def.titleOffKey, icon: def.iconOff, color: null, bg: 0 },
    })
  }
  return out
}

export type PresetMergeMode = 'ignore' | 'add' | 'replace'

/** Looks válidos de una lista posiblemente corrupta. */
export function cleanLooksList(v: unknown): any[] {
  return (Array.isArray(v) ? v : []).filter((l) => l && typeof l === 'object')
}

/**
 * Decisión al añadir una acción con estados: null = no hay nada que
 * proponer (sin presets para la acción, o todo ya aplicado). Si la tecla
 * aún no tiene condiciones, `missing` trae el par completo (el llamador
 * decide entre añadir en silencio o preguntar).
 */
export function presetOfferFor(
  currentLooks: unknown,
  actionType: string,
): { groups: VarStatePresetGroup[]; missing: VarStatePreset[] } | null {
  const groups = presetsForAction(actionType)
  if (!groups.length) return null
  const current = cleanLooksList(currentLooks)
  const have = new Set(current.map((l) => String(l?.cond ?? '').trim()).filter(Boolean))
  const missing = groups.flatMap((g) => [g.on, g.off]).filter((p) => !have.has(p.cond))
  if (!missing.length) return null
  return { groups, missing }
}

/** Apariencia base para decidir si el usuario la personalizó. */
export interface PresetBase {
  icon?: string
  textColor?: string
  backgroundColor?: string
  iconImage?: string
}

/** Icono 'Zap'/vacío + colores de fábrica + sin imagen = aspecto de fábrica.
 *  Ojo: el borrador trae textColor '#e8e9eb' de serie (equivale a vacío). */
export function isDefaultAppearance(base: PresetBase | null | undefined): boolean {
  if (!base || typeof base !== 'object') return true
  if (String(base.iconImage ?? '') !== '') return false
  const icon = String(base.icon ?? '')
  if (icon !== '' && icon !== 'Zap') return false
  const fg = String(base.textColor ?? '').toLowerCase()
  if (fg !== '' && fg !== '#e8e9eb') return false
  if (String(base.backgroundColor ?? '') !== '') return false
  return true
}

/**
 * Resuelve un preset a look definitivo: si el usuario ya personalizó la
 * tecla, la condición del estado por defecto (off) hereda SU icono para
 * que el estado normal siga pareciendo su botón; si todo es de fábrica,
 * se usan los iconos de la acción.
 */
export function resolvePresetLook(
  p: VarStatePreset,
  isOff: boolean,
  base: PresetBase | null | undefined,
  t: (key: string) => string,
): { cond: string; t: string; i: string; c: number | null; bg: number } {
  const customized = !isDefaultAppearance(base)
  return {
    cond: p.cond,
    t: t(p.titleKey),
    i: isOff && customized ? String((base as PresetBase)?.icon ?? '') : p.icon,
    c: p.color,
    bg: p.bg,
  }
}

/** Resuelve el par on/off de varios grupos (orden: on, off, on, off…). */
export function resolvePresetLooks(
  groups: VarStatePresetGroup[],
  base: PresetBase | null | undefined,
  t: (key: string) => string,
): Array<{ cond: string; t: string; i: string; c: number | null; bg: number }> {
  return groups.flatMap((g) => [
    resolvePresetLook(g.on, false, base, t),
    resolvePresetLook(g.off, true, base, t),
  ])
}

/**
 * Fusión pura de presets según el modo del diálogo:
 * - ignore: se queda todo como está.
 * - add: añade los que falten (respeta las condiciones existentes).
 * - replace: sustituye todas por las del par nuevo.
 */
export function mergePresetLooks(
  currentLooks: unknown,
  resolved: Array<{ cond: string; t: string; i: string; c: number | null; bg: number }>,
  mode: PresetMergeMode,
): any[] {
  const current = cleanLooksList(currentLooks)
  if (mode === 'ignore') return current
  if (mode === 'replace') return [...resolved]
  const have = new Set(current.map((l) => String(l?.cond ?? '').trim()))
  return [...current, ...resolved.filter((r) => !have.has(r.cond))]
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
