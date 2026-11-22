import { ref } from 'vue'
import { getTunnelToken, tunnelApiBase } from './useTunnel'

export type AutoTarget = 'app' | 'title' | 'both'
export type AutoOp = 'contains' | 'exact' | 'starts' | 'regex'

export interface AutoRule {
  id: string
  enabled: boolean
  profileId: string
  target: AutoTarget
  op: AutoOp
  value: string
  titleOp: AutoOp
  titleValue: string
}

export interface AutoConfig {
  enabled: boolean
  defaultProfileId: string | null
  rules: AutoRule[]
}

export interface SimWindow {
  hwnd?: string
  title: string
  processName: string
  executablePath: string
  name: string
  icon?: string
}

const FALLBACK_WINS: SimWindow[] = [
  { hwnd: 'w1', title: 'OBS 31.0.2 - Perfil: Directo - Escenas: Charla', processName: 'obs64.exe', executablePath: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe', name: 'OBS Studio' },
  { hwnd: 'w2', title: 'Podcast_Ep42.prproj - Adobe Premiere Pro 2026', processName: 'Adobe Premiere Pro.exe', executablePath: 'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2026\\Adobe Premiere Pro.exe', name: 'Adobe Premiere Pro' },
  { hwnd: 'w3', title: 'BunDeck — Visual Studio Code', processName: 'Code.exe', executablePath: 'C:\\Users\\user\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', name: 'Visual Studio Code' },
  { hwnd: 'w4', title: 'Panel de control - Twitch - Google Chrome', processName: 'chrome.exe', executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', name: 'Google Chrome' },
  { hwnd: 'w5', title: 'Lofi Beats to Code To · Spotify Premium', processName: 'Spotify.exe', executablePath: 'C:\\Users\\user\\AppData\\Roaming\\Spotify\\Spotify.exe', name: 'Spotify' },
  { hwnd: 'w6', title: 'Explorador de archivos', processName: 'explorer.exe', executablePath: 'C:\\Windows\\explorer.exe', name: 'Escritorio de Windows' }
]

export function newAutoRule(profileId: string): AutoRule {
  return {
    id: `ar_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    enabled: true,
    profileId,
    target: 'app',
    op: 'contains',
    value: '',
    titleOp: 'contains',
    titleValue: ''
  }
}

export function matchStr(text: string | null | undefined, pattern: string | null | undefined, op: AutoOp = 'contains'): boolean {
  if (!pattern) return false
  const a = String(text ?? '')
  const b = String(pattern)
  if (op === 'exact') return a.toLowerCase() === b.toLowerCase()
  if (op === 'starts') return a.toLowerCase().startsWith(b.toLowerCase())
  if (op === 'regex') {
    try {
      return new RegExp(b, 'i').test(a)
    } catch {
      return false
    }
  }
  return a.toLowerCase().includes(b.toLowerCase())
}

export function evalAutoRule(rule: AutoRule, win: SimWindow): boolean {
  if (!rule.enabled) return false
  if (rule.target === 'app') {
    return matchStr(win.processName, rule.value, rule.op) || matchStr(win.executablePath, rule.value, rule.op) || matchStr(win.name, rule.value, rule.op)
  }
  if (rule.target === 'title') {
    return matchStr(win.title, rule.value, rule.op)
  }
  const appOk = matchStr(win.processName, rule.value, rule.op) || matchStr(win.executablePath, rule.value, rule.op) || matchStr(win.name, rule.value, rule.op)
  return appOk && matchStr(win.title, rule.titleValue, rule.titleOp)
}

export function resolveProfileForWin(
  rules: AutoRule[],
  win: SimWindow,
  validProfile: (id: string) => boolean,
  defaultProfileId: string | null
): { profileId: string; rule: AutoRule | null; fallback: boolean } | null {
  const hit = rules.find((r) => r.enabled && validProfile(r.profileId) && evalAutoRule(r, win))
  if (hit) return { profileId: hit.profileId, rule: hit, fallback: false }
  if (defaultProfileId && validProfile(defaultProfileId)) return { profileId: defaultProfileId, rule: null, fallback: true }
  return null
}

function looksLikeRegex(s: string): boolean {
  return /[.*+?^${}()|[\]\\]/.test(s)
}

/** Migra reglas legacy {executablePath,processName,windowTitleFilter} al formato nuevo. */
export function migrateLegacyRules(raw: any[]): AutoRule[] {
  return (raw ?? []).map((r: any, i: number) => {
    if (r && (r.target || r.value !== undefined)) {
      return {
        id: String(r.id ?? `ar_migrated_${i}`),
        enabled: r.enabled !== false,
        profileId: String(r.profileId ?? r.prof ?? ''),
        target: (r.target === 'title' || r.target === 'both' ? r.target : 'app') as AutoTarget,
        op: (['contains', 'exact', 'starts', 'regex'].includes(r.op) ? r.op : 'contains') as AutoOp,
        value: String(r.value ?? r.val ?? ''),
        titleOp: (['contains', 'exact', 'starts', 'regex'].includes(r.titleOp ?? r.tOp) ? (r.titleOp ?? r.tOp) : 'contains') as AutoOp,
        titleValue: String(r.titleValue ?? r.tVal ?? '')
      } as AutoRule
    }
    const exec = String(r?.executablePath ?? '').trim()
    const proc = String(r?.processName ?? '').trim()
    const title = String(r?.windowTitleFilter ?? '').trim()
    const hasApp = !!(exec || proc)
    const target: AutoTarget = hasApp && title ? 'both' : title ? 'title' : 'app'
    const base = (proc || exec.split(/[\\/]/).pop() || exec).trim()
    return {
      id: String(r?.id ?? `ar_migrated_${i}`),
      enabled: r?.enabled !== false,
      profileId: String(r?.profileId ?? ''),
      target,
      op: 'contains',
      value: target === 'title' ? title : base,
      titleOp: looksLikeRegex(title) ? 'regex' : 'contains',
      titleValue: title
    } as AutoRule
  })
}

export function loadAutoConfigRaw(): { enabled: boolean; defaultProfileId: string | null; rules: any[] } | null {
  return null
}

const apiBase = () => {
  if (typeof window !== 'undefined') {
    const tunnelToken = getTunnelToken()
    if (tunnelToken) return tunnelApiBase(tunnelToken)
    return `http://${window.location.hostname}:3001/api/v1`
  }
  return 'http://localhost:3001/api/v1'
}

export function useAutoProfile() {
  const config = ref<AutoConfig>({ enabled: false, defaultProfileId: null, rules: [] })
  const loading = ref(false)
  const windows = ref<SimWindow[]>([...FALLBACK_WINS])
  const activeWindow = ref<SimWindow | null>(null)

  const normalizeWin = (w: any): SimWindow => ({
    hwnd: String(w?.hwnd ?? w?.id ?? ''),
    title: String(w?.title ?? ''),
    processName: String(w?.processName ?? w?.app ?? w?.process ?? ''),
    executablePath: String(w?.executablePath ?? w?.path ?? String(w?.processName ?? '')),
    name: String(w?.name ?? w?.processName ?? w?.app ?? ''),
    icon: w?.icon
  })

  const loadConfiguration = async () => {
    loading.value = true
    try {
      const res = await fetch(`${apiBase()}/settings?key=autoProfileSwitch`)
      if (res.ok) {
        const data = await res.json()
        if (data?.value) {
          const cfg = JSON.parse(data.value)
          config.value = {
            enabled: !!cfg.enabled,
            defaultProfileId: cfg.defaultProfileId ?? (typeof cfg.defProf === 'string' ? cfg.defProf : null),
            rules: migrateLegacyRules(cfg.rules ?? [])
          }
          return config.value
        }
      }
    } catch (e) {
      console.error('Failed to load auto-profile configuration:', e)
    } finally {
      loading.value = false
    }
    return config.value
  }

  const persist = async () => {
    const payload = {
      enabled: config.value.enabled,
      defaultProfileId: config.value.defaultProfileId,
      rules: config.value.rules
    }
    try {
      await fetch(`${apiBase()}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'autoProfileSwitch', value: JSON.stringify(payload) })
      })
    } catch (e) {
      console.error('Failed to save auto-profile configuration:', e)
    }
    // Sincroniza el watcher del daemon (arrancar / actualizar / parar)
    try {
      if (config.value.enabled) {
        const st = await fetch(`${apiBase()}/windows/watcher`)
        const isActive = st.ok ? (await st.json())?.isActive : false
        await fetch(`${apiBase()}/windows/watcher`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: isActive ? 'update' : 'start',
            rules: config.value.rules,
            defaultProfileId: config.value.defaultProfileId
          })
        })
        // Si estaba parado y hay reglas, el daemon necesita 'start'; si ya estaba
        // activo basta 'update'. Hacemos start si update no lo activó: el endpoint
        // start es idempotente salvo por el listener (ya protegido en el daemon).
        if (!isActive && config.value.rules.length > 0) {
          await fetch(`${apiBase()}/windows/watcher`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'start', rules: config.value.rules, defaultProfileId: config.value.defaultProfileId })
          }).catch(() => {})
        }
      } else {
        await fetch(`${apiBase()}/windows/watcher`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stop' })
        }).catch(() => {})
      }
    } catch (e) {
      console.error('Failed to sync window watcher:', e)
    }
  }

  const refreshWindows = async () => {
    try {
      const [listRes, activeRes] = await Promise.allSettled([
        fetch(`${apiBase()}/windows/list`).then((r) => (r.ok ? r.json() : null)),
        fetch(`${apiBase()}/windows/active`).then((r) => (r.ok ? r.json() : null))
      ])
      const list = listRes.status === 'fulfilled' && Array.isArray(listRes.value) && listRes.value.length ? listRes.value.map(normalizeWin) : [...FALLBACK_WINS]
      // La lista real trae processName/title/executablePath; name = processName
      windows.value = list.map((w) => ({ ...w, name: w.name || w.processName }))
      const act = activeRes.status === 'fulfilled' && activeRes.value && !activeRes.value.error ? normalizeWin(activeRes.value) : null
      activeWindow.value = act
      // Si la ventana activa real no está en la lista, la anteponemos
      if (act && !windows.value.some((w) => w.hwnd === act.hwnd && act.hwnd)) {
        windows.value = [{ ...act, name: act.name || act.processName }, ...windows.value]
      }
    } catch {
      windows.value = [...FALLBACK_WINS]
    }
    return windows.value
  }

  return {
    config,
    loading,
    windows,
    activeWindow,
    fallbackWindows: FALLBACK_WINS,
    loadConfiguration,
    persist,
    refreshWindows,
    matchStr,
    evalAutoRule,
    resolveProfileForWin
  }
}
