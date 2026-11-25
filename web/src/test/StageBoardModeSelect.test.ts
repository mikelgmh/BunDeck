import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import StageBoard from '../components/bundeck/StageBoard.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {},
  }),
}))

vi.mock('../composables/useKeyShare', () => ({
  assetUrl: () => '',
  isAssetRef: () => false,
}))

const baseProps = {
  gridCols: 5,
  gridRows: 3,
  keySize: 76,
  selectedButton: null,
  executingButtons: [],
  buttonConfig: {},
  getButton: () => undefined,
  allButtons: [],
  getButtonData: () => null,
  displayData: () => null,
  mode: 'edit',
  labelMode: 'a',
  currentPages: [],
  currentPage: null,
  navTrail: [],
  profileName: '',
  busy: false,
} as any

describe('StageBoard: selector nativo de modo en viewport estrecho', () => {
  it('renderiza el <select> accesible con las claves i18n de modo', () => {
    const wrapper = mount(StageBoard, { props: { ...baseProps } })
    const sel = wrapper.find('[data-cy=bd-mode-select]')
    expect(sel.exists()).toBe(true)
    expect(sel.element.tagName).toBe('SELECT')
    // <label> asociado (envuelve al select) + aria-label accesible.
    expect(sel.element.closest('label.bd-modesel')?.tagName).toBe('LABEL')
    expect(sel.attributes('aria-label')).toBe('bd.mode')
    const values = sel.findAll('option').map((o) => (o.element as HTMLOptionElement).value)
    expect(values).toEqual(['edit', 'use', 'kiosk'])
    expect(sel.text()).toContain('bd.edit')
    expect(sel.text()).toContain('bd.use')
    expect(sel.text()).toContain('bd.kiosk')
    wrapper.unmount()
  })

  it('el select refleja el modo actual; en kiosco la toolbar se oculta (como antes)', async () => {
    const wrapper = mount(StageBoard, { props: { ...baseProps, mode: 'edit' } })
    const sel = () => wrapper.find('[data-cy=bd-mode-select]').element as HTMLSelectElement
    expect(sel().value).toBe('edit')
    await wrapper.setProps({ mode: 'use' })
    expect(sel().value).toBe('use')
    // En kiosco no hay toolbar (v-if="!kiosk" preexistente): la salida con
    // confirmación vive en BunDeckApp (botón salir / triple-tap / Escape).
    await wrapper.setProps({ kiosk: true })
    expect(wrapper.find('[data-cy=bd-mode-select]').exists()).toBe(false)
    expect(wrapper.find('[data-md=use]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('el select cambia de modo con los mismos eventos que las tabs', async () => {
    const wrapper = mount(StageBoard, { props: { ...baseProps, mode: 'edit' } })
    const sel = wrapper.find('[data-cy=bd-mode-select]')
    await sel.setValue('use')
    expect(wrapper.emitted('mode-change')).toEqual([['use']])
    await sel.setValue('kiosk')
    expect(wrapper.emitted('kiosk-enter')).toHaveLength(1)
    // Elegir kiosco no pasa por mode-change (el guard vive en el padre).
    expect(wrapper.emitted('mode-change')).toEqual([['use']])
    await sel.setValue('edit')
    expect(wrapper.emitted('mode-change')).toEqual([['use'], ['edit']])
    wrapper.unmount()
  })

  it('mantiene las tabs de escritorio para el e2e (viewport ancho)', async () => {
    const wrapper = mount(StageBoard, { props: { ...baseProps, mode: 'edit' } })
    expect(wrapper.find('[data-md=edit]').exists()).toBe(true)
    expect(wrapper.find('[data-md=use]').exists()).toBe(true)
    expect(wrapper.find('[data-cy=bd-mode-kiosk]').exists()).toBe(true)
    await wrapper.find('[data-md=use]').trigger('click')
    expect(wrapper.emitted('mode-change')).toEqual([['use']])
    await wrapper.find('[data-cy=bd-mode-kiosk]').trigger('click')
    expect(wrapper.emitted('kiosk-enter')).toHaveLength(1)
    wrapper.unmount()
  })

  it('el CSS oculta las tabs y muestra el select a 700px (breakpoint móvil del proyecto)', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/bundeck.css'), 'utf8')
    // Oculto en escritorio por defecto…
    expect(css).toMatch(/\.bd-modesel\s*\{\s*display:\s*none/)
    // …y conmutado dentro del bloque móvil existente de 700px.
    const mobile700 = css.match(/@media\s*\(max-width:\s*700px\)\s*\{([\s\S]*)/)?.[1] ?? ''
    expect(mobile700).toContain('.bd-modeseg')
    expect(mobile700).toMatch(/\.bd-modeseg\s*\{\s*display:\s*none/)
    expect(mobile700).toMatch(/\.bd-modesel\s*\{\s*display:\s*inline-flex/)
  })
})
