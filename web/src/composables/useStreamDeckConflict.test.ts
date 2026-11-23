import { describe, it, expect } from 'vitest'
import { shouldShowConflictDialog } from './useStreamDeckConflict'

describe('useStreamDeckConflict', () => {
  it('muestra el diálogo solo cuando hay proceso oficial vivo', () => {
    expect(shouldShowConflictDialog(null)).toBe(false)
    expect(shouldShowConflictDialog({})).toBe(false)
    expect(
      shouldShowConflictDialog({ conflict: { detected: false, processes: [], hidBusyHint: false, reason: 'none' } })
    ).toBe(false)
    // Solo la pista HID (sin proceso) no bloquea: también pasa sin dispositivo.
    expect(
      shouldShowConflictDialog({ conflict: { detected: false, processes: [], hidBusyHint: true, reason: 'hid-busy' } })
    ).toBe(false)
    expect(
      shouldShowConflictDialog({
        conflict: {
          detected: true,
          processes: [{ name: 'StreamDeck.exe', pid: 28708 }],
          hidBusyHint: true,
          reason: 'both',
        },
      })
    ).toBe(true)
  })

  it('tolera payload parcial del daemon', () => {
    expect(
      shouldShowConflictDialog({
        conflict: { processes: [{ name: 'Stream Deck', pid: null }] } as any,
      })
    ).toBe(true)
  })
})
