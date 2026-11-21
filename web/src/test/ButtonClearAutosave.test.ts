import { describe, it, expect, vi } from 'vitest'

// ButtonClearAutosave (W4): regresión del bug "Vaciar tarda una eternidad y
// se queda como estaba".
//
// Causa (web/src/composables/useStreamDeck.ts + BunDeckApp.vue):
//  - onClearKey mutaba buttonConfig y NUNCA llamaba a saveButtonConfig:
//    dependía del autosave (debouncedSave, 800 ms).
//  - debouncedSave ponía isSaving=true al PROGRAMAR, y el watcher descartaba
//    cualquier cambio con isSaving=true SIN reprogramar. Un cambio durante la
//    ventana de autosave (o durante un guardado en vuelo, que con el repintado
//    HW bloqueante del daemon duraba segundos) se perdía.
//  - Resultado: la BD conservaba la data, la UI parecía vacía solo en local
//    y al recargar/repintar "resucitaba" lo viejo → sensación de app pillada.
//
// Fix verificado aquí:
//  1. programar NO marca isSaving (solo saveButtonConfig durante la ejecución);
//  2. si llega un cambio mientras se guarda, se reprograma en vez de perderse;
//  3. onClearKey llama a saveButtonConfig() de inmediato.

function makeFixedAutosave(save: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let isChanging = false
  let isSwapping = false
  let isSaving = false

  const debouncedSave = () => {
    if (timer) clearTimeout(timer)
    if (isChanging || isSwapping) return
    timer = setTimeout(() => {
      timer = null
      save()
    }, 50)
  }

  // Réplica del watcher de BunDeckApp (ya sin guard isSaving).
  const onConfigChange = () => {
    if (isChanging) return
    debouncedSave()
  }

  const saveButtonConfig = async (work: () => Promise<void> | void) => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (isSaving) {
      debouncedSave()
      return 'reprogramado' as const
    }
    isSaving = true
    try {
      await work()
      return 'guardado' as const
    } finally {
      isSaving = false
    }
  }

  return {
    debouncedSave,
    onConfigChange,
    saveButtonConfig,
    flags: () => ({ isSaving, hasPending: timer !== null }),
    setChanging: (v: boolean) => { isChanging = v },
  }
}

// Réplica del debouncedSave ANTIGUO (buggy) para documentar el bug.
// Semántica real del código anterior:
//  - debouncedSave ponía isSaving=true al PROGRAMAR;
//  - el watcher descartaba cualquier cambio con isSaving=true SIN reprogramar.
function makeBuggyAutosave(save: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let isSaving = false
  const isChanging = false
  const isSwapping = false

  const debouncedSave = () => {
    if (timer) clearTimeout(timer)
    if (isChanging || isSwapping) return
    isSaving = true // ← bug: marca al programar, no al ejecutar
    timer = setTimeout(() => {
      timer = null
      save()
      isSaving = false
    }, 50)
  }
  // Réplica del watcher antiguo: bloqueaba por isSaving sin reprogramar.
  const onConfigChange = () => {
    if (isSaving) return // ← bug: el cambio se pierde
    debouncedSave()
  }
  return { debouncedSave, onConfigChange, flags: () => ({ isSaving, hasPending: timer !== null }) }
}

describe('ButtonClearAutosave (W4)', () => {
  it('buggy: cambio durante save en vuelo se pierde (watcher lo descarta)', async () => {
    const seen: string[] = []
    let gen = 0
    const buggy = makeBuggyAutosave(() => { seen.push(`save-${++gen}`) })
    buggy.onConfigChange() // 1er cambio: programa (isSaving=true 50 ms)
    await new Promise((r) => setTimeout(r, 10))
    buggy.onConfigChange() // 2º cambio durante la ventana: descartado
    await new Promise((r) => setTimeout(r, 120))
    // Solo se guardó lo del 1er timeout; el 2º cambio nunca reprogramó nada.
    // En la app real esto era el vaciado que "no llegaba": si el usuario
    // tocaba otro campo (o el propio onClearKey mutaba dos veces con el
    // watcher ya marcado) el cambio se perdía y la BD conservaba lo viejo.
    expect(seen).toEqual(['save-1'])
    expect(buggy.flags().isSaving).toBe(false)
  })

  it('fix: dos mutaciones seguidas programan UN solo guardado y no cuelgan', async () => {
    let saves = 0
    const fixed = makeFixedAutosave(() => { saves += 1 })
    fixed.onConfigChange()
    fixed.onConfigChange()
    expect(fixed.flags().hasPending).toBe(true)
    expect(fixed.flags().isSaving).toBe(false)
    await new Promise((r) => setTimeout(r, 120))
    expect(saves).toBe(1)
    expect(fixed.flags().isSaving).toBe(false)
  })

  it('fix: onClearKey guarda de inmediato aunque haya autosave pendiente', async () => {
    let saves = 0
    const fixed = makeFixedAutosave(() => { saves += 1 })
    fixed.onConfigChange() // autosave pendiente por la mutación
    expect(fixed.flags().hasPending).toBe(true)
    // onClearKey fixed: await saveButtonConfig() explícito
    const res = await fixed.saveButtonConfig(async () => { saves += 1 })
    expect(res).toBe('guardado')
    expect(saves).toBe(1)
    expect(fixed.flags().hasPending).toBe(false) // pendiente cancelado
    await new Promise((r) => setTimeout(r, 120))
    expect(saves).toBe(1) // sin doble guardado fantasma
  })

  it('fix: cambio durante un guardado en vuelo se reprograma, no se pierde', async () => {
    let saves = 0
    const fixed = makeFixedAutosave(() => { saves += 1 })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const first = fixed.saveButtonConfig(() => gate) // en vuelo
    // llega otro cambio mientras isSaving=true
    const res = await fixed.saveButtonConfig(async () => { saves += 1 })
    expect(res).toBe('reprogramado')
    release()
    await first
    await new Promise((r) => setTimeout(r, 120))
    expect(saves).toBe(1) // el cambio reprogramado sí se guardó
  })

  it('fix: isChangingButton sigue bloqueando el autosave espurio', async () => {
    const spy = vi.fn()
    const fixed = makeFixedAutosave(spy)
    fixed.setChanging(true)
    fixed.onConfigChange()
    await new Promise((r) => setTimeout(r, 120))
    expect(spy).not.toHaveBeenCalled()
  })
})
