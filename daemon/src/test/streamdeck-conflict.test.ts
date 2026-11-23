import { describe, it, expect } from 'bun:test'
import {
  isConflictProcessName,
  filterConflictProcesses,
  parsePsOutput,
  ALL_CONFLICT_NAMES,
} from '../hw-driver/streamdeck-conflict'

describe('streamdeck-conflict', () => {
  it('reconoce la app oficial (Windows, con y sin ruta)', () => {
    expect(isConflictProcessName('StreamDeck.exe')).toBe(true)
    expect(isConflictProcessName('C:\\Program Files\\Elgato\\StreamDeck\\StreamDeck.exe')).toBe(true)
    expect(isConflictProcessName('STREAMDECK.EXE')).toBe(true)
    expect(isConflictProcessName('stream deck')).toBe(true)
  })

  it('no confunde otras apps de Elgato ni procesos del sistema', () => {
    expect(isConflictProcessName('ElgatoAudioControlServer')).toBe(false)
    expect(isConflictProcessName('ElgatoAudioControlServerWatcher')).toBe(false)
    expect(isConflictProcessName('notepad.exe')).toBe(false)
    expect(isConflictProcessName('')).toBe(false)
    expect(isConflictProcessName(null)).toBe(false)
  })

  it('filtra solo la allowlist y conserva el pid', () => {
    const out = filterConflictProcesses([
      { name: 'StreamDeck.exe', pid: 28708 },
      { name: 'ElgatoAudioControlServer', pid: 6608 },
      { name: 'chrome', pid: 1234 },
    ])
    expect(out).toEqual([{ name: 'StreamDeck.exe', pid: 28708 }])
  })

  it('parsea salida de ps sin spawnear procesos', () => {
    const stdout = 'Stream Deck                         1234\nDock                                  12\nelgato-streamdeck                   5678\n'
    const out = parsePsOutput(stdout)
    expect(out.map((p) => p.pid).sort()).toEqual([1234, 5678])
  })

  it('la allowlist no está vacía y cubre el exe real visto en Windows', () => {
    expect(ALL_CONFLICT_NAMES.length).toBeGreaterThan(0)
    expect(ALL_CONFLICT_NAMES.map((n) => n.toLowerCase())).toContain('streamdeck.exe')
  })
})
