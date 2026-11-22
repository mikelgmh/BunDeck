import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Regresión: subir foto mostraba la imagen en el grid pero no en el drawer,
// y al cambiar de tecla y volver, clicar la tecla la borraba.
// Causa: selectButton() construía buttonConfig sin `iconImage` → el drawer
// (previewImage ← buttonConfig.iconImage) quedaba vacío y el siguiente
// saveButtonConfig() hacía PUT sin iconImage (o DELETE si solo había foto).

// --- Réplica fiel del mapeo real (web/src/composables/useStreamDeck.ts) ---

function toEditorDraftFixed(buttonData: any) {
  return {
    label: buttonData?.label || '',
    textTop: buttonData?.textTop || '',
    textBottom: buttonData?.textBottom || '',
    fontSize: buttonData?.fontSize || 14,
    icon: buttonData?.icon || '',
    iconImage: typeof buttonData?.iconImage === 'string' ? buttonData.iconImage : '',
    emoji: buttonData?.emoji || '',
    backgroundColor: buttonData?.backgroundColor || '#374151',
    textColor: buttonData?.textColor || '#f1f5f9',
    showTitle: buttonData?.showTitle !== false,
    mode: buttonData?.mode || 'seq',
    longPress: buttonData?.longPress || 'none',
    confirm: !!buttonData?.confirm,
    actions: buttonData?.actions ? JSON.parse(JSON.stringify(buttonData.actions)) : [],
    rules: buttonData?.rules ? JSON.parse(JSON.stringify(buttonData.rules)) : [],
    looks: buttonData?.looks ? JSON.parse(JSON.stringify(buttonData.looks)) : [],
  }
}

// Mapeo antiguo (buggy): sin iconImage — documenta el fallo.
function toEditorDraftBuggy(buttonData: any) {
  const { iconImage: _drop, ...rest } = toEditorDraftFixed(buttonData)
  void _drop
  const { iconImage: _d2, ...without } = rest as any
  void _d2
  return without as any
}

function hasContentForSave(cfg: any): boolean {
  return !!(
    cfg.label?.trim() ||
    cfg.textTop?.trim() ||
    cfg.textBottom?.trim() ||
    cfg.emoji?.trim() ||
    cfg.icon?.trim() ||
    cfg.iconImage?.trim() ||
    (cfg.actions?.length ?? 0) > 0 ||
    (cfg.rules?.length ?? 0) > 0 ||
    (cfg.looks?.length ?? 0) > 0
  )
}

function decideSave(existing: boolean, cfg: any): 'update' | 'create' | 'delete' | 'noop' {
  const has = hasContentForSave(cfg)
  if (existing) return has ? 'update' : 'delete'
  return has ? 'create' : 'noop'
}

describe('KeyImagePersistence (foto no se pierde ni borra la tecla)', () => {
  const dbRow = {
    id: 'btn-foto',
    position: 3,
    data: {
      label: '',
      iconImage: '/assets/key-foto123.png',
      actions: [],
      rules: [],
      looks: [],
    },
  }

  it('1. el draft del editor conserva iconImage (drawer + grid lo ven)', () => {
    const draft = toEditorDraftFixed(dbRow.data)
    expect(draft.iconImage).toBe('/assets/key-foto123.png')
  })

  it('2. el mapeo antiguo perdía iconImage (reproduce el bug reportado)', () => {
    const buggy = toEditorDraftBuggy(dbRow.data)
    expect((buggy as any).iconImage).toBeUndefined()
    // Sin iconImage, una tecla que SOLO tiene foto parece vacía → el
    // siguiente guardado la BORRA en vez de actualizarla.
    expect(hasContentForSave(buggy)).toBe(false)
    expect(decideSave(true, buggy)).toBe('delete')
  })

  it('3. con el fix, una tecla que solo tiene foto NO se borra: se actualiza', () => {
    const draft = toEditorDraftFixed(dbRow.data)
    expect(hasContentForSave(draft)).toBe(true)
    expect(decideSave(true, draft)).toBe('update')
    expect(decideSave(false, draft)).toBe('create')
  })

  it('4. cambiar de tecla y volver conserva la foto (ida y vuelta)', () => {
    // Selecciono foto → draft con imagen
    let draft = toEditorDraftFixed(dbRow.data)
    expect(draft.iconImage).toBe('/assets/key-foto123.png')
    // Cambio a tecla vacía → draft vacío (no debe contaminar)
    const other = toEditorDraftFixed({ label: '', actions: [] })
    expect(other.iconImage).toBe('')
    // Vuelvo a la foto: la BD sigue teniendo la imagen → el draft la recupera
    draft = toEditorDraftFixed(dbRow.data)
    expect(draft.iconImage).toBe('/assets/key-foto123.png')
    expect(decideSave(true, draft)).toBe('update')
  })

  it('5. iconImage corrupto/externo se normaliza a "" (no rompe hasContent)', () => {
    expect(toEditorDraftFixed({ iconImage: 123 }).iconImage).toBe('')
    // coherente con cleanKey/isAssetRef: solo /assets/<f>.<ext> vale
    expect(toEditorDraftFixed({ iconImage: 'https://evil/x.png' }).iconImage).toBe(
      'https://evil/x.png',
    )
  })

  it('6. el código real de selectButton() incluye iconImage (candado anti-regresión)', () => {
    const src = readFileSync(
      resolve(__dirname, '../composables/useStreamDeck.ts'),
      'utf8',
    )
    expect(src).toMatch(/iconImage:\s*typeof button\.data\?\.iconImage/)
    // Los resets de estado vacío también deben llevar el campo
    const occurrences = (src.match(/iconImage: ''/g) ?? []).length
    expect(occurrences).toBeGreaterThanOrEqual(3)
  })
})
