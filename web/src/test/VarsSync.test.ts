import { describe, it, expect, beforeEach } from 'vitest'
import {
  vars,
  getVar,
  upsertRemoteVar,
  removeVar,
  importVar,
  daemonTypeToLocal,
  localTypeToDaemon,
  setVarPushSender,
  pushVarToDaemon,
} from '../composables/useVars'
import { presetsFor, presetsForAction, presetOfferFor, mergePresetLooks, isDefaultAppearance, resolvePresetLook, resolvePresetLooks } from '../composables/useExposedVariables'
import { ev } from '../composables/useExpressions'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({ t: (key: string) => key }),
}))

const P = 'sync_'

function clean(name: string) {
  removeVar(name)
}

beforeEach(() => {
  localStorage.clear()
  setVarPushSender(null)
})

describe('sincronía de tipos daemon → web', () => {
  it('mapea tipos daemon a locales', () => {
    expect(daemonTypeToLocal('bool')).toBe('bool')
    expect(daemonTypeToLocal('boolean')).toBe('bool')
    expect(daemonTypeToLocal('numeric')).toBe('num')
    expect(daemonTypeToLocal('num')).toBe('num')
    expect(daemonTypeToLocal('text')).toBe('txt')
    expect(daemonTypeToLocal('color')).toBe('txt')
    expect(daemonTypeToLocal(undefined)).toBe(undefined)
    expect(daemonTypeToLocal('raro')).toBe(undefined)
  })

  it('mapea tipos locales a daemon', () => {
    expect(localTypeToDaemon('bool')).toBe('bool')
    expect(localTypeToDaemon('num')).toBe('numeric')
    expect(localTypeToDaemon('txt')).toBe('text')
  })

  it('un evento con tipo conserva bool (regresión discordMuted)', () => {
    const n = `${P}muted`
    // Antes: el payload venía sin tipo y se guardaba como texto.
    upsertRemoteVar(n, true)
    expect(getVar(n)?.t).toBe('txt')
    expect(ev(`${n} == true`, Object.fromEntries(vars.value.map((v) => [v.n, v.v])))).toBe(false)
    clean(n)

    // Ahora: con tipo del daemon, la condición matchea.
    upsertRemoteVar(n, true, 'bool')
    expect(getVar(n)?.t).toBe('bool')
    expect(getVar(n)?.v).toBe(true)
    const env = Object.fromEntries(vars.value.map((v) => [v.n, v.v]))
    expect(ev(`${n} == true`, env)).toBe(true)
    expect(ev(`${n} == falso`, env)).toBe(false)
    clean(n)
  })

  it('false en bool apaga la condición (vuelve a la base)', () => {
    const n = `${P}back`
    upsertRemoteVar(n, true, 'bool')
    let env = Object.fromEntries(vars.value.map((v) => [v.n, v.v]))
    expect(Boolean(ev(n, env))).toBe(true)
    upsertRemoteVar(n, false, 'bool')
    env = Object.fromEntries(vars.value.map((v) => [v.n, v.v]))
    expect(Boolean(ev(n, env))).toBe(false)
    expect(ev(`${n} == falso`, env)).toBe(true)
    clean(n)
  })

  it('sin tipo en el payload se conserva el tipo local conocido', () => {
    const n = `${P}keep`
    importVar({ n, t: 'bool', v: true })
    // Daemon antiguo / evento sin tipo: no debe degradar a texto.
    upsertRemoteVar(n, true)
    expect(getVar(n)?.t).toBe('bool')
    expect(getVar(n)?.v).toBe(true)
    clean(n)
  })

  it('numérico con tipo matchea comparaciones numéricas', () => {
    const n = `${P}count`
    upsertRemoteVar(n, 5, 'numeric')
    expect(getVar(n)?.t).toBe('num')
    const env = Object.fromEntries(vars.value.map((v) => [v.n, v.v]))
    expect(ev(`${n} > 3`, env)).toBe(true)
    clean(n)
  })
})

describe('push web → daemon', () => {
  it('sin socket no hace nada', () => {
    importVar({ n: `${P}push`, t: 'bool', v: false })
    expect(pushVarToDaemon(`${P}push`)).toBe(false)
    clean(`${P}push`)
  })

  it('envía variable.set con nombre, valor y tipo', () => {
    const sent: unknown[] = []
    setVarPushSender((m) => sent.push(m))
    try {
      importVar({ n: `${P}push2`, t: 'num', v: 7 })
      expect(pushVarToDaemon(`${P}push2`)).toBe(true)
      expect(sent).toEqual([
        { type: 'variable.set', payload: { name: `${P}push2`, value: 7, type: 'numeric' } },
      ])
    } finally {
      setVarPushSender(null)
      clean(`${P}push2`)
    }
  })
})

describe('presets de estado por acción', () => {
  it('discord mute ofrece el par on/off', () => {
    const groups = presetsFor({ actions: [{ id: 'a1', type: 'discord.toggle-mute', parameters: {} }] })
    expect(groups.map((g) => g.varName)).toEqual(['discordMuted'])
    expect(groups[0].on).toMatchObject({ cond: 'discordMuted' })
    expect(groups[0].off).toMatchObject({ cond: 'discordMuted == falso' })
  })

  it('sin acciones con estado no hay presets', () => {
    expect(presetsFor({ actions: [{ id: 'a1', type: 'shell.exec', parameters: {} }] })).toEqual([])
  })

  it('no duplica variables', () => {
    const groups = presetsFor({
      actions: [
        { id: 'a1', type: 'discord.toggle-mute', parameters: {} },
        { id: 'a2', type: 'discord.toggle-mute', parameters: {} },
      ],
    })
    expect(groups.map((g) => g.varName)).toEqual(['discordMuted'])
  })

  it('presetsForAction devuelve el par de una acción', () => {
    const groups = presetsForAction('obs.stream')
    expect(groups.map((g) => g.varName)).toEqual(['obsStreaming'])
    expect(presetsForAction('shell.exec')).toEqual([])
    expect(presetsForAction('')).toEqual([])
  })
})

describe('diálogo de presets al añadir acción', () => {
  const DISCORD = [{ cond: 'discordMuted', t: 'Muteado', i: 'MicOff', c: 4, bg: 1 }]
  const EXISTING = [{ cond: 'contador > 1', t: 'X', i: '', c: null, bg: 0 }]

  it('no pregunta sin presets o con todo aplicado', () => {
    expect(presetOfferFor(EXISTING, 'shell.exec')).toBeNull()
    expect(
      presetOfferFor(
        [...DISCORD, { cond: 'discordMuted == falso', t: 'En vivo', i: 'Mic', c: null, bg: 0 }],
        'discord.toggle-mute',
      ),
    ).toBeNull()
  })

  it('sin condiciones previas también propone (el llamador decide auto o diálogo)', () => {
    for (const looks of [[], [null, 'x']]) {
      const offer = presetOfferFor(looks, 'discord.toggle-mute')
      expect(offer?.groups.map((g) => g.varName)).toEqual(['discordMuted'])
      expect(offer?.missing.map((p) => p.cond)).toEqual(['discordMuted', 'discordMuted == falso'])
    }
  })

  it('pregunta cuando faltan presets', () => {
    const offer = presetOfferFor(EXISTING, 'discord.toggle-mute')
    expect(offer?.groups.map((g) => g.varName)).toEqual(['discordMuted'])
    expect(offer?.missing.map((p) => p.cond)).toEqual(['discordMuted', 'discordMuted == falso'])
  })

  it('ignorar lo deja todo; añadir respeta; reemplazar sustituye', () => {
    expect(mergePresetLooks(EXISTING, DISCORD, 'ignore')).toEqual(EXISTING)
    expect(mergePresetLooks(EXISTING, DISCORD, 'add')).toEqual([...EXISTING, ...DISCORD])
    expect(mergePresetLooks(EXISTING, DISCORD, 'replace')).toEqual(DISCORD)
  })

  it('añadir no duplica condiciones existentes', () => {
    const both = [...EXISTING, ...DISCORD]
    expect(mergePresetLooks(both, DISCORD, 'add')).toEqual(both)
  })

  it('tolera looks corruptos', () => {
    expect(mergePresetLooks([null, undefined, 42, ...EXISTING], DISCORD, 'add')).toEqual([...EXISTING, ...DISCORD])
  })
})

describe('herencia del icono del botón en presets', () => {
  const t = (k: string) => k
  const groups = presetsForAction('discord.toggle-mute')
  const on = groups[0].on
  const off = groups[0].off

  it('detecta la apariencia de fábrica', () => {
    expect(isDefaultAppearance(null)).toBe(true)
    expect(isDefaultAppearance(undefined)).toBe(true)
    expect(isDefaultAppearance({})).toBe(true)
    expect(isDefaultAppearance({ icon: '', textColor: '', backgroundColor: '', iconImage: '' })).toBe(true)
    expect(isDefaultAppearance({ icon: 'Zap' })).toBe(true)
    expect(isDefaultAppearance({ icon: 'Zap', textColor: '#e8e9eb' })).toBe(true)
    expect(isDefaultAppearance({ icon: 'Zap', textColor: '#E8E9EB' })).toBe(true)
    expect(isDefaultAppearance({ icon: 'Mic' })).toBe(false)
    expect(isDefaultAppearance({ icon: 'Zap', textColor: '#e8b04e' })).toBe(false)
    expect(isDefaultAppearance({ icon: 'Zap', backgroundColor: '#5a2b2b' })).toBe(false)
    expect(isDefaultAppearance({ icon: 'Zap', iconImage: '/assets/x.webp' })).toBe(false)
  })

  it('con apariencia de fábrica usa los iconos de la acción', () => {
    expect(resolvePresetLook(on, false, { icon: 'Zap' }, t)).toMatchObject({ cond: 'discordMuted', i: 'MicOff' })
    expect(resolvePresetLook(off, true, { icon: 'Zap' }, t)).toMatchObject({ cond: 'discordMuted == falso', i: 'Mic' })
  })

  it('con botón personalizado el off hereda su icono y el on no', () => {
    const base = { icon: 'Spotify', textColor: '#86cba5', backgroundColor: '#2b5a3a' }
    expect(resolvePresetLook(off, true, base, t)).toMatchObject({ cond: 'discordMuted == falso', i: 'Spotify' })
    expect(resolvePresetLook(on, false, base, t)).toMatchObject({ cond: 'discordMuted', i: 'MicOff' })
  })

  it('resolvePresetLooks resuelve el par en orden', () => {
    expect(resolvePresetLooks(groups, { icon: 'Zap' }, t).map((l) => [l.cond, l.i])).toEqual([
      ['discordMuted', 'MicOff'],
      ['discordMuted == falso', 'Mic'],
    ])
    expect(resolvePresetLooks(groups, { icon: 'Mic', textColor: '#fff' }, t).map((l) => [l.cond, l.i])).toEqual([
      ['discordMuted', 'MicOff'],
      ['discordMuted == falso', 'Mic'],
    ])
  })
})
