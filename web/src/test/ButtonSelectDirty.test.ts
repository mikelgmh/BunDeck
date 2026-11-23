import { describe, it, expect } from 'vitest'

// Réplica fiel de la decisión de guardado en selectButton/selectPage
// (web/src/composables/useStreamDeck.ts).
//
// Bug: el dirty-check comparaba la FILA DE BD contra el draft NORMALIZADO.
// Una tecla guardada con `data: {}` se normaliza al seleccionar a un draft
// con todas las claves (`{label:'',...,actions:[]}`), así que el siguiente
// cambio de selección siempre veía "changes" y llamaba a saveButtonConfig,
// que ante un draft sin contenido BORRA la tecla intacta (p. ej. el 2º
// "Añadir tecla" en Libre borraba la 1ª).
// Fix: dirty = draft actual vs SNAPSHOT tomado al seleccionar/guardar.

const EMPTY_DRAFT = {
  label: '',
  textTop: '',
  textBottom: '',
  fontSize: 14,
  icon: '',
  iconImage: '',
  emoji: '',
  backgroundColor: '',
  textColor: '#e8e9eb',
  showTitle: true,
  mode: 'seq',
  longPress: 'none',
  confirm: false,
  actions: [],
  rules: [],
  looks: [],
}

const clone = (o: any) => JSON.parse(JSON.stringify(o))

/** Normalización que hace selectButton al cargar una tecla. */
function normalizeRow(rowData: any): any {
  return {
    label: rowData?.label || '',
    textTop: rowData?.textTop || '',
    textBottom: rowData?.textBottom || '',
    fontSize: rowData?.fontSize || 14,
    icon: rowData?.icon || '',
    iconImage: typeof rowData?.iconImage === 'string' ? rowData.iconImage : '',
    emoji: rowData?.emoji || '',
    backgroundColor: typeof rowData?.backgroundColor === 'string' ? rowData.backgroundColor : '',
    textColor: rowData?.textColor || '#e8e9eb',
    showTitle: rowData?.showTitle !== false,
    mode: rowData?.mode || 'seq',
    longPress: rowData?.longPress || 'none',
    confirm: !!rowData?.confirm,
    actions: rowData?.actions ? clone(rowData.actions) : [],
    rules: rowData?.rules ? clone(rowData.rules) : [],
    looks: rowData?.looks ? clone(rowData.looks) : [],
  }
}

/** Lógica ANTIGUA (buggy): compara fila BD contra draft. */
function oldShouldSave(rowData: any, draft: any): boolean {
  return JSON.stringify(rowData) !== JSON.stringify(draft)
}

/** Lógica NUEVA: compara draft contra snapshot de selección/guardado. */
function makeDraftTracker() {
  let savedJson = ''
  return {
    snapshot(draft: any) {
      savedJson = JSON.stringify(draft)
    },
    shouldSave(draft: any): boolean {
      return JSON.stringify(draft) !== savedJson
    },
  }
}

describe('dirty-check al cambiar de selección (no borrar teclas intactas)', () => {
  it('repro bug: tecla vacía intacta NO dispara guardado (antes sí → DELETE)', () => {
    const rowData = {} // guardada con data {}
    const draft = normalizeRow(rowData)
    expect(oldShouldSave(rowData, draft)).toBe(true) // el bug: siempre dirty

    const tracker = makeDraftTracker()
    tracker.snapshot(draft) // selectButton hace snapshot al cargar
    expect(tracker.shouldSave(clone(draft))).toBe(false) // intacta → no save
  })

  it('edición real del usuario SÍ dispara guardado', () => {
    const tracker = makeDraftTracker()
    tracker.snapshot(clone(EMPTY_DRAFT))
    const edited = { ...clone(EMPTY_DRAFT), label: 'Hola' }
    expect(tracker.shouldSave(edited)).toBe(true)
  })

  it('tras guardar, el mismo draft ya no está dirty', () => {
    const tracker = makeDraftTracker()
    tracker.snapshot(clone(EMPTY_DRAFT))
    const edited = { ...clone(EMPTY_DRAFT), label: 'Hola' }
    expect(tracker.shouldSave(edited)).toBe(true)
    tracker.snapshot(edited) // saveButtonConfig hace snapshot al persistir
    expect(tracker.shouldSave(clone(edited))).toBe(false)
  })

  it('vaciar una tecla con contenido sigue borrándola (comportamiento deseado)', () => {
    const rowData = { label: 'Con titulo', actions: [] }
    const draft = normalizeRow(rowData)
    const tracker = makeDraftTracker()
    tracker.snapshot(draft)
    // El usuario borra el título en el inspector:
    const cleared = { ...clone(draft), label: '' }
    expect(tracker.shouldSave(cleared)).toBe(true)
    const hasContent =
      cleared.label?.trim() ||
      (cleared.actions?.length ?? 0) > 0
    expect(!!hasContent).toBe(false) // → saveButtonConfig la borra: correcto
  })

  it('doble "Añadir tecla": la primera sobrevive (escenario e2e deck-layouts)', () => {
    const tracker = makeDraftTracker()
    // Primer add: botón {} + select → snapshot del draft vacío.
    const draft1 = normalizeRow({})
    tracker.snapshot(draft1)
    // Segundo add: al cambiar de selección el draft sigue intacto → no save.
    expect(tracker.shouldSave(clone(draft1))).toBe(false)
    // El 2º botón se crea y se selecciona: snapshot del nuevo draft vacío.
    tracker.snapshot(normalizeRow({}))
    expect(tracker.shouldSave(clone(EMPTY_DRAFT))).toBe(false)
  })
})
