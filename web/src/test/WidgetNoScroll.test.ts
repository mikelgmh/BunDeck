import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/**
 * PROHIBIDO el scroll dentro de los botones del modo libre: ningún widget
 * puede mostrar scrollbar en ningún tamaño. Los contenidos múltiples rotan
 * con AutoCarousel/paginación, los textos largos con Marquee y el resto se
 * recorta con ellipsis (nunca `overflow: auto/scroll`).
 */
const WIDGETS = [
  'components/bundeck/VolumeRange.vue',
  'components/bundeck/widgets/AudioMixerControl.vue',
  'components/bundeck/widgets/MediaTransportControl.vue',
  'components/bundeck/widgets/SmartHomeControl.vue',
  'components/bundeck/widgets/SpotifyPlayerControl.vue',
  'components/bundeck/widgets/VoicePanelControl.vue',
  'components/bundeck/widgets/SoundboardControl.vue',
  'components/bundeck/widgets/StreamStudioControl.vue',
  'components/bundeck/widgets/CreativeToolsControl.vue',
  'components/bundeck/widgets/CalendarAgenda.vue',
  'components/bundeck/widgets/PomodoroControl.vue',
  'components/bundeck/widgets/StatusCards.vue',
  'components/bundeck/widgets/WorkflowControl.vue',
]

function styleBlocks(source: string): string[] {
  const out: string[] = []
  const re = /<style[^>]*>([\s\S]*?)<\/style>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) out.push(match[1])
  return out
}

describe('widgets sin scroll (modo libre)', () => {
  it('cubre los 13 widgets del modo libre', () => {
    expect(WIDGETS).toHaveLength(13)
    for (const file of WIDGETS) {
      expect(() => readFileSync(join(root, file), 'utf8')).not.toThrow()
    }
  })

  for (const file of WIDGETS) {
    it(`${file}: sin overflow auto/scroll ni scrollbars`, () => {
      const source = readFileSync(join(root, file), 'utf8')
      const styles = styleBlocks(source)
      expect(styles.length).toBeGreaterThan(0)
      const css = styles.join('\n')
      // `overflow`, `overflow-x`, `overflow-y` (pero no `text-overflow` ni
      // `overflow-wrap`, que recortan sin abrir scroll).
      const declarations = [...css.matchAll(/(?<![-\w])overflow(?:-x|-y)?\s*:\s*([^;{}]+)/g)]
      for (const [, value] of declarations) {
        const v = value.toLowerCase()
        expect(
          v,
          `${file}: overflow prohibido ("${value.trim()}"): debe rotar con carrusel o recortar`,
        ).not.toMatch(/auto|scroll/)
      }
      // `scrollbar-width` solo se admite como blindaje (`none`).
      for (const [, value] of css.matchAll(/scrollbar-width\s*:\s*([^;{}]+)/g)) {
        expect(value.replace(/!important/g, '').trim().toLowerCase()).toBe('none')
      }
    })
  }
})
