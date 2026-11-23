import { defineAsyncComponent, type Component } from 'vue'

/**
 * Iconos Lucide por nombre dinámico (el nombre viene de datos: tecla, plugin...).
 *
 * Un `import * as LucideIcons from 'lucide-vue-next'` en un componente del
 * bundle inicial impide el tree-shaking y arrastra la librería entera
 * (~700KB) al chunk de arranque. Este helper resuelve cada icono con un
 * `import()` diferido (chunk `lucide-vue-next` separado, compartido por todos
 * los consumidores) y cachea el componente resultante.
 *
 * Los iconos estáticos del template siguen con imports nombrados, que sí
 * se podan en el build.
 */
const cache = new Map<string, Component>()

export function dynamicIcon(name: unknown): Component | null {
  if (typeof name !== 'string' || !name || !/^[A-Za-z][A-Za-z0-9]*$/.test(name)) return null
  let c = cache.get(name)
  if (!c) {
    c = defineAsyncComponent(() =>
      import('lucide-vue-next').then((m: Record<string, any>) => m[name] ?? m['Settings'])
    )
    cache.set(name, c)
  }
  return c
}

/** Solo para tests: vacía la caché de iconos resueltos. */
export function clearDynamicIconCache(): void {
  cache.clear()
}
