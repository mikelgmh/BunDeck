import { describe, it, expect, vi } from 'vitest'
import StageBoard from '../components/bundeck/StageBoard.vue'
import KeyInspector from '../components/bundeck/KeyInspector.vue'
// Solo import: demuestra que BunDeckApp + SettingsDialog compilan con el
// nuevo cableado (tap/long-press-ms/pressActions) sin montarlos.
import BunDeckApp from '../components/bundeck/BunDeckApp.vue'
import SettingsDialog from '../components/bundeck/SettingsDialog.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {},
  }),
}))

/**
 * Contrato de cableado Fase A+B: StageBoard emite button-tap y acepta
 * long-press-ms; KeyInspector expone subtabs press:* y drop con tipo.
 * Si alguien renombra un emit/prop, falla aquí y no en producción.
 */
describe('cableado press-kind entre componentes', () => {
  it('StageBoard declara button-tap y long-press-ms', () => {
    const emits = (StageBoard as any).emits ?? []
    expect(emits).toContain('button-tap')
    expect(emits).toContain('button-long-press')
    const props = (StageBoard as any).props ?? {}
    expect('longPressMs' in props).toBe(true)
  })

  it('KeyInspector declara open-palette y action-drop-selected', () => {
    const emits = (KeyInspector as any).emits ?? []
    expect(emits).toContain('open-palette')
    expect(emits).toContain('action-drop-selected')
    expect(emits).toContain('update-field')
  })

  it('BunDeckApp y SettingsDialog importan sin romperse', () => {
    expect(typeof BunDeckApp).toBe('object')
    expect(typeof SettingsDialog).toBe('object')
  })
})
