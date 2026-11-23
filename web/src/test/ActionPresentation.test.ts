import { describe, it, expect } from 'vitest'
import {
  CONTROL_ACTION_COMPONENTS,
  actionSurfaceKind,
  actionTypeSurfaceKind,
  findActionAdata,
  findControlAction,
  isControlAction,
  controlComponentOf,
  matchesActionQuery
} from '../composables/useActionPresentation'

const pluginsOf = (...actions: any[]) => [['audio-mixer', { manifest: { name: 'Mezclador' }, actions: actions.map((a) => [a.id, a]) }]]

describe('useActionPresentation', () => {
  it('clasifica ejecución / dato / control', () => {
    expect(actionSurfaceKind({ name: 'X' })).toBe('plain')
    expect(actionSurfaceKind(null)).toBe('plain')
    expect(actionSurfaceKind({ dynamic: true, name: 'Métrica' })).toBe('data')
    expect(actionSurfaceKind({ surface: 'control', component: 'volume-range' })).toBe('control')
    // Componente desconocido: degrada a ejecución, nunca rompe el render.
    expect(actionSurfaceKind({ surface: 'control', component: 'holograma' })).toBe('plain')
    expect(actionSurfaceKind({ surface: 'invalida' })).toBe('plain')
  })

  it('el mapa cerrado manda aunque falte el manifest', () => {
    expect(actionTypeSurfaceKind([], 'audio-mixer.volume-control')).toBe('control')
    expect(actionTypeSurfaceKind(pluginsOf({ id: 'volume-control', surface: 'control', component: 'volume-range' }), 'audio-mixer.volume-control')).toBe('control')
    expect(actionTypeSurfaceKind(pluginsOf({ id: 'app-volume' }), 'audio-mixer.app-volume')).toBe('plain')
    expect(actionTypeSurfaceKind(pluginsOf({ id: 'monitor', dynamic: true }), 'audio-mixer.monitor')).toBe('data')
  })

  it('encuentra adata por tipo completo y por sufijo', () => {
    const plugins = pluginsOf({ id: 'app-volume', name: 'Volumen de app' })
    expect(findActionAdata(plugins, 'audio-mixer.app-volume')).toMatchObject({ name: 'Volumen de app' })
    expect(findActionAdata(plugins, 'desconocida')).toBeNull()
    expect(findActionAdata(undefined, 'x')).toBeNull()
  })

  it('detecta el control en la lista de acciones de la tecla', () => {
    const vol = { id: 'a1', type: 'audio-mixer.volume-control', parameters: {} }
    const play = { id: 'a2', type: 'multimedia.multimedia', parameters: {} }
    expect(isControlAction(vol)).toBe(true)
    expect(isControlAction(play)).toBe(false)
    expect(isControlAction(null)).toBe(false)
    expect(findControlAction([play, vol])).toBe(vol)
    expect(findControlAction([play])).toBeUndefined()
    expect(findControlAction([])).toBeUndefined()
    expect(findControlAction(null)).toBeUndefined()
  })

  it('resuelve componente por tipo de acción', () => {
    expect(controlComponentOf('audio-mixer.volume-control')).toBe('volume-range')
    expect(controlComponentOf('otra')).toBeNull()
    expect(CONTROL_ACTION_COMPONENTS['audio-mixer.volume-control']).toBe('volume-range')
  })

  it('matchesActionQuery: biblioteca y paleta usan nombre + tipo + grupo', () => {
    const toast = { name: 'Mostrar mensaje', type: 'local.toast', group: 'Lógica' }
    const delay = { name: 'Retardo', type: 'utility.delay', group: 'Utility Actions' }
    const ha = { name: 'Entidad', type: 'homeassistant.entity', group: 'Home Assistant' }
    // Casos que fallaban antes de unificar (0 resultados aunque existía):
    expect(matchesActionQuery(toast, 'toast')).toBe(true)
    expect(matchesActionQuery(delay, 'utility.delay')).toBe(true)
    expect(matchesActionQuery(delay, 'retardo')).toBe(true)
    expect(matchesActionQuery(ha, 'home assistant')).toBe(true)
    // Insensible a mayúsculas y a campos ausentes.
    expect(matchesActionQuery(toast, 'MOSTRAR')).toBe(true)
    expect(matchesActionQuery({ name: 'X' }, 'x')).toBe(true)
    // Sin query todo pasa; sin coincidencia nada pasa.
    expect(matchesActionQuery(toast, '')).toBe(true)
    expect(matchesActionQuery(toast, '   ')).toBe(true)
    expect(matchesActionQuery(toast, 'zzzz')).toBe(false)
    expect(matchesActionQuery(toast, 'mostrar zzz')).toBe(false)
    expect(matchesActionQuery(null as any, 'x')).toBe(false)
  })
})
