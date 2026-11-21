import { ref, onMounted } from 'vue'

const BASE = 'http://127.0.0.1:3031'

async function req(path: string, init?: RequestInit, ms = 1200): Promise<any | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), ms)
    const res = await fetch(`${BASE}${path}`, { ...init, signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) return null
    return await res.json().catch(() => ({}))
  } catch {
    return null
  }
}

// Singleton: una sola barra en la app; se reintenta mientras no se detecte host.
const isElectrobun = ref(false)
const maximized = ref(false)

async function probe() {
  if (isElectrobun.value) return
  const st = await req('/__launcher/window-state', { method: 'GET' })
  if (st && typeof st.maximized === 'boolean') {
    isElectrobun.value = true
    maximized.value = st.maximized
  }
}

export function useWindowChrome() {
  onMounted(() => {
    void probe()
  })

  const minimize = async () => {
    await req('/__launcher/window-minimize', { method: 'POST' })
  }
  const toggleMaximize = async () => {
    const res = await req('/__launcher/window-toggle-maximize', { method: 'POST' })
    if (res && typeof res.maximized === 'boolean') maximized.value = res.maximized
  }
  const close = async () => {
    await req('/__launcher/window-close', { method: 'POST' })
  }

  return { isElectrobun, maximized, minimize, toggleMaximize, close }
}
