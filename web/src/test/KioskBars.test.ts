import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import KioskBarShell from '../components/bundeck/KioskBarShell.vue'
import KioskNavBar from '../components/bundeck/KioskNavBar.vue'

describe('KioskBarShell: reutilizable arriba/abajo', () => {
  it('aplica la clase de posición superior e id propio', () => {
    const wrapper = mount(KioskBarShell, {
      props: {
        collapsed: false,
        position: 'top-left',
        barId: 'kbartop',
        collapseCy: 'bd-kiosk-topcollapse',
        collapseLabel: 'Contraer',
        expandLabel: 'Expandir',
        ariaLabel: 'Nav',
      },
      slots: { default: '<span>hola</span>' },
    })
    const bar = wrapper.find('#kbartop.kiosk-bar')
    expect(bar.exists()).toBe(true)
    expect(bar.classes()).toContain('kiosk-bar--top')
    expect(wrapper.find('[data-cy="bd-kiosk-topcollapse"]').exists()).toBe(true)
  })

  it('colapsada marca aria-expanded=false y emite toggle', async () => {
    const wrapper = mount(KioskBarShell, {
      props: { collapsed: true, position: 'bottom', expandLabel: 'Expandir', collapseLabel: 'Contraer' },
    })
    expect(wrapper.find('.kiosk-bar').classes()).toContain('is-collapsed')
    expect(wrapper.find('button').attributes('aria-expanded')).toBe('false')
    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('toggle')).toHaveLength(1)
  })
})

describe('KioskNavBar: filas de perfiles y páginas', () => {
  const profiles = [
    { id: 'p1', name: 'Casa' },
    { id: 'p2', name: 'Estudio' },
  ]
  const pages = [
    { id: 'g1', name: 'Principal' },
    { id: 'g2', name: 'Secundaria', disabled: true, disabledReason: 'Bloqueada' },
  ]

  it('muestra las dos filas y marca la selección', () => {
    const wrapper = mount(KioskNavBar, {
      props: { profiles, pages, selectedProfileId: 'p2', selectedPageId: 'g1' },
    })
    expect(wrapper.find('[data-cy="bd-kiosk-profiles"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-kiosk-pages"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-kiosk-profile-p2"]').classes()).toContain('is-active')
    expect(wrapper.find('[data-cy="bd-kiosk-page-g1"]').classes()).toContain('is-active')
    expect(wrapper.find('[data-cy="bd-kiosk-page-g2"]').attributes('disabled')).toBeDefined()
  })

  it('emite select-profile y select-page', async () => {
    const wrapper = mount(KioskNavBar, { props: { profiles, pages } })
    await wrapper.find('[data-cy="bd-kiosk-profile-p1"]').trigger('click')
    await wrapper.find('[data-cy="bd-kiosk-page-g1"]').trigger('click')
    expect(wrapper.emitted('select-profile')).toEqual([['p1']])
    expect(wrapper.emitted('select-page')).toEqual([['g1']])
  })

  it('estados vacíos sensatos', () => {
    const wrapper = mount(KioskNavBar, {
      props: { profiles: [], pages: [], noProfilesLabel: 'Sin perfiles', noPagesLabel: 'Sin páginas' },
    })
    expect(wrapper.find('[data-cy="bd-kiosk-profiles-empty"]').text()).toBe('Sin perfiles')
    expect(wrapper.find('[data-cy="bd-kiosk-pages-empty"]').text()).toBe('Sin páginas')
  })

  it('toggles arriba/abajo independientes (dos shells no comparten estado)', async () => {
    const bottom = mount(KioskBarShell, { props: { collapsed: false, position: 'bottom' } })
    const top = mount(KioskBarShell, { props: { collapsed: false, position: 'top-left' } })
    await top.find('button').trigger('click')
    expect(top.emitted('toggle')).toHaveLength(1)
    expect(bottom.emitted('toggle')).toBeUndefined()
    // El padre (BunDeckApp) guarda kioskTopCollapsed y kioskBarCollapsed por
    // separado: colapsar una no toca la otra (emisión aislada por instancia).
    expect(top.find('.kiosk-bar').classes()).not.toContain('is-collapsed')
  })
})
