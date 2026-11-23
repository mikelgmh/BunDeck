import { createPinia } from 'pinia'
import { markRaw } from 'vue'

// Crear instancia de Pinia
const pinia = createPinia()

// Log de mutaciones solo bajo demanda: localStorage `libredeck:debug = 1`.
// Antes se logueaba cada mutación en DEV, spameando la consola en cada tick.
if (import.meta.env.DEV) {
  let debug = false
  try {
    debug = typeof localStorage !== 'undefined' && localStorage.getItem('libredeck:debug') === '1'
  } catch {
    debug = false
  }
  if (debug) {
    pinia.use(({ store }) => {
      store.$subscribe((mutation, state) => {
        console.log('📦 Store updated:', store.$id, mutation, state)
      })
    })
  }
}

export default pinia
