import { describe, it, expect } from 'vitest'
import {
  CONTROL_ACTION_COMPONENTS,
  actionSurfaceKind,
  actionTypeSurfaceKind,
  findActionAdata,
  findControlAction,
  isControlAction,
  controlComponentOf
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
})
