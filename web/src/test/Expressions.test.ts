import { describe, it, expect } from 'vitest'
import { ev, evb, intp, usedVarNames } from '../composables/useExpressions'

const E = { contador: 4, micSilenciado: false, modoDirecto: 'charla', hora: 21, perfil: 'Directo', pagina: 'Inicio' }

describe('useExpressions', () => {
  it('aritmética y comparaciones', () => {
    expect(ev('contador + 1', E)).toBe(5)
    expect(ev('contador > 3 y hora >= 18', E)).toBe(true)
    expect(ev('contador > 10 o hora >= 18', E)).toBe(true)
    expect(ev('no micSilenciado', E)).toBe(true)
  })

  it('ternario y funciones', () => {
    expect(ev('contador > 3 ? "sí" : "no"', E)).toBe('sí')
    expect(ev('mayus(modoDirecto)', E)).toBe('CHARLA')
    expect(ev('longitud("hola")', E)).toBe(4)
    expect(ev('contiene(modoDirecto, "arl")', E)).toBe(true)
  })

  it('errores claros sin eval', () => {
    expect(() => ev('desconocida + 1', E)).toThrow(/desconocida/)
    expect(() => ev('falsa(1)', E)).toThrow()
    expect(evb('desconocida', E)).toBe(false)
  })

  it('interpola {{vars}}', () => {
    expect(intp('Clips: {{contador}}', E)).toBe('Clips: 4')
    expect(intp('{{desconocida}}', E)).toBe('⚠')
  })

  it('detecta variables usadas', () => {
    expect(usedVarNames('{"cond":"contador > 3"}', ['contador', 'otro'])).toEqual(['contador'])
    expect(usedVarNames('{"t":"sin nada"}', ['contador'])).toEqual([])
  })
})
