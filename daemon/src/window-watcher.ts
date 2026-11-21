import { EventEmitter } from 'events'

interface WindowInfo {
  hwnd: string
  title: string
  processId: number
  processName: string
  executablePath: string
}

interface AutoSwitchRule {
  id: string
  profileId: string
  // Formato legacy (compatibilidad): coincidencia exacta + filtro de título
  executablePath?: string
  processName?: string
  windowTitleFilter?: string
  // Formato nuevo (cambio condicional de perfiles): objetivo + operador
  target?: 'app' | 'title' | 'both'
  op?: 'contains' | 'exact' | 'starts' | 'regex'
  value?: string
  titleOp?: 'contains' | 'exact' | 'starts' | 'regex'
  titleValue?: string
  enabled: boolean
}

type AutoOp = 'contains' | 'exact' | 'starts' | 'regex'

function matchStr(text: string | null | undefined, pattern: string | null | undefined, op?: AutoOp): boolean {
  if (!pattern) return false
  const a = String(text ?? '')
  const b = String(pattern)
  const o = (op || 'contains') as AutoOp
  if (o === 'exact') return a.toLowerCase() === b.toLowerCase()
  if (o === 'starts') return a.toLowerCase().startsWith(b.toLowerCase())
  if (o === 'regex') {
    try {
      return new RegExp(b, 'i').test(a)
    } catch {
      return false
    }
  }
  return a.toLowerCase().includes(b.toLowerCase())
}

function evalNewRule(rule: AutoSwitchRule, window: WindowInfo): boolean {
  const target = rule.target || 'app'
  const op = (rule.op || 'contains') as AutoOp
  const val = rule.value ?? ''
  if (target === 'app') {
    return matchStr(window.processName, val, op) || matchStr(window.executablePath, val, op)
  }
  if (target === 'title') {
    return matchStr(window.title, val, op)
  }
  // both: app AND título
  const appOk = matchStr(window.processName, val, op) || matchStr(window.executablePath, val, op)
  return appOk && matchStr(window.title, rule.titleValue ?? '', (rule.titleOp || 'contains') as AutoOp)
}

class WindowWatcher extends EventEmitter {
  private activeWindow: WindowInfo | null = null
  private intervalId: NodeJS.Timeout | null = null
  private rules: AutoSwitchRule[] = []
  private isWatching = false
  private currentProfileId: string | null = null
  private defaultProfileId: string | null = null

  constructor() {
    super()
  }

  startWatching(rules: AutoSwitchRule[] = []) {
    if (this.isWatching) return

    this.rules = rules
    this.isWatching = true

    // Check every 500ms for window changes
    this.intervalId = setInterval(async () => {
      try {
        const currentWindow = await this.getActiveWindow()

        if (this.hasWindowChanged(currentWindow)) {
          this.activeWindow = currentWindow
          
          this.emit('window-changed', currentWindow)

          // Check if we need to switch profiles
          const matchingRule = this.findMatchingRule(currentWindow)
          
          if (matchingRule) {
            this.emit('profile-switch', matchingRule.profileId, currentWindow)
          } else {
            // No matching rule found, check if we should switch to default profile
            this.checkDefaultProfileSwitch(currentWindow)
          }
        }
      } catch (error) {
        console.error('Error in window watcher:', error)
      }
    }, 500)
  }

  stopWatching() {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.isWatching = false
    this.activeWindow = null
  }

  updateRules(rules: AutoSwitchRule[]) {
    this.rules = rules
  }

  setDefaultProfile(profileId: string | null) {
    this.defaultProfileId = profileId
  }

  setCurrentProfile(profileId: string) {
    this.currentProfileId = profileId
  }

  isActive(): boolean {
    return this.isWatching
  }

  private hasWindowChanged(newWindow: WindowInfo | null): boolean {
    if (!this.activeWindow && !newWindow) return false
    if (!this.activeWindow || !newWindow) return true

    return this.activeWindow.hwnd !== newWindow.hwnd ||
           this.activeWindow.title !== newWindow.title
  }

  private findMatchingRule(window: WindowInfo | null): AutoSwitchRule | null {
    if (!window) return null

    return this.rules.find(rule => {
      if (!rule.enabled) return false

      // Formato nuevo: target + operador (tiene prioridad si hay value)
      if (rule.target && (rule.value || rule.target === 'title' || rule.target === 'both')) {
        return evalNewRule(rule, window)
      }
      // Si trae campos nuevos aunque target falte, evaluarlos también
      if (rule.value !== undefined && (rule.target || rule.op)) {
        return evalNewRule({ ...rule, target: rule.target || 'app' }, window)
      }

      // Formato legacy: exacto en ejecutable/proceso + regex/subcadena en título
      // Check executable path
      if (rule.executablePath && window.executablePath !== rule.executablePath) {
        return false
      }

      // Check process name
      if (rule.processName && window.processName !== rule.processName) {
        return false
      }

      // Check window title filter (regex or substring)
      if (rule.windowTitleFilter) {
        try {
          // Try as regex first
          const regex = new RegExp(rule.windowTitleFilter, 'i')
          if (!regex.test(window.title)) {
            return false
          }
        } catch {
          // If not valid regex, use as substring
          if (!window.title.toLowerCase().includes(rule.windowTitleFilter.toLowerCase())) {
            return false
          }
        }
      }

      return true
    }) || null
  }

  private async checkDefaultProfileSwitch(window: WindowInfo | null): Promise<void> {
    // 1) Default explícito de la config (respaldo del modal de cambio automático)
    if (this.defaultProfileId) {
      if (this.defaultProfileId !== this.currentProfileId) {
        this.emit('profile-switch', this.defaultProfileId, window)
      }
      return
    }
    console.log('Checking for default profile switch...');
    try {
      // Get default profile from database — usa puerto centralizado
      const { API_PORT } = await import('./config');
      const response = await fetch(`http://localhost:${API_PORT}/api/v1/profiles`)
      if (response.ok) {
        const profiles = await response.json()
        const defaultProfile = profiles.find((p: any) => {
          let data = p.data
          if (typeof data === 'string') {
            try {
              data = JSON.parse(data)
            } catch {
              data = {}
            }
          }
          return data?.isDefault === true
        })
        
        if (defaultProfile && defaultProfile.id !== this.currentProfileId) {
          this.emit('profile-switch', defaultProfile.id, window)
        }
      }
    } catch (error) {
      // Ignore errors when checking default profile
    }
  }

  private async getActiveWindow(): Promise<WindowInfo | null> {
    try {
      const { API_PORT } = await import('./config');
      const response = await fetch(`http://localhost:${API_PORT}/api/v1/windows/active`)
      if (response.ok) {
        return await response.json()
      }
    } catch (error) {
      console.error('Failed to get active window:', error)
    }
    return null
  }
}

// Singleton instance
export const windowWatcher = new WindowWatcher()
export type { WindowInfo, AutoSwitchRule }