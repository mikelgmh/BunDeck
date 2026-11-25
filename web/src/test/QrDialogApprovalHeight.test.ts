import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// REGRESIÓN BUG1: la modal de aprobación remota ocupaba toda la pantalla.
// Causa: con `position:fixed; top:0; bottom:0` (fijas, las pone el UA de
// `dialog:modal`) + `height:auto`, la caja abspos se estira al alto
// disponible. El fix es `height: fit-content` (igual que sus hermanas
// `bd-qr`/`bd-ios`), así la modal es compacta.
// jsdom no hace layout, así que el tripwire es el CSS declarado; la medida
// real de píxeles vive en el spec Playwright `qr-approval-dialog.spec.ts`.
const cssPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'bundeck.css')

function ruleFor(selector: string): string {
  const css = readFileSync(cssPath, 'utf8')
  const re = new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 's')
  const match = css.match(re)
  if (!match) throw new Error(`regla no encontrada: ${selector}`)
  return match[1]
}

describe('QrDialog aprobación: altura compacta (BUG1)', () => {
  it('bd-remote-approval usa height: fit-content (no auto)', () => {
    const body = ruleFor(String.raw`\.bundeck dialog\.bd-dlg\.bd-remote-approval`)
    expect(body).toMatch(/height\s*:\s*fit-content/)
    expect(body).not.toMatch(/height\s*:\s*auto/)
  })

  it('sus hermanas siguen compactas (bd-qr, bd-ios)', () => {
    for (const variant of ['bd-qr', 'bd-ios']) {
      const body = ruleFor(String.raw`\.bundeck dialog\.bd-dlg\.${variant}`)
      expect(body).toMatch(/height\s*:\s*fit-content/)
    }
  })
})
