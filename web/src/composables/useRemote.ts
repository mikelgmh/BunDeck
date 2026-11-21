import { ref } from 'vue'

export interface RemoteDeviceView {
  deviceId: string
  name: string
  pubKeyPrefix: string
  allowedActions: string[]
  createdAt: number
  revoked: boolean
}

export interface RemoteStatusView {
  deviceId: string
  fingerprint: string
  publicKey: string
  relay: { url: string; status: string }
  pending: number
  trusted: number
  policy: string[]
}

export interface RemoteEvent {
  kind: string
  from?: string
  detail?: string
  ts: number
}

/** El código de emparejamiento son 6 dígitos (lo genera el daemon). */
export function isValidPairCode(code: string): boolean {
  return /^\d{6}$/.test(String(code ?? '').trim())
}

export function toggleInList(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item]
}

export function useRemote() {
  const apiPort = ref(3001)
  const apiBase = () =>
    typeof window !== 'undefined'
      ? `${window.location.protocol}//${window.location.hostname}:${apiPort.value}/api/v1`
      : 'http://localhost:3001/api/v1'

  const status = ref<RemoteStatusView | null>(null)
  const devices = ref<RemoteDeviceView[]>([])
  const pair = ref<{ code: string; fingerprint: string; expiresAt: number } | null>(null)
  const events = ref<RemoteEvent[]>([])
  const loading = ref(false)
  const error = ref('')

  let ws: WebSocket | null = null
  let wsPort = 3003

  const pushEvent = (kind: string, payload: any) => {
    events.value.unshift({
      kind,
      from: payload?.from ?? payload?.deviceId,
      detail: payload?.type ?? payload?.error ?? payload?.name ?? '',
      ts: Date.now()
    })
    events.value = events.value.slice(0, 30)
  }

  const syncConfig = async () => {
    try {
      const url =
        typeof window !== 'undefined' && window.location.port !== '3001'
          ? 'http://localhost:3001/config'
          : '/config'
      const res = await fetch(url)
      if (res.ok) {
        const cfg = await res.json()
        if (cfg.apiPort) apiPort.value = cfg.apiPort
        if (cfg.wsPort) wsPort = cfg.wsPort
      }
    } catch {
      /* puertos por defecto */
    }
  }

  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${apiBase()}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init
    })
    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try {
        const j = await res.json()
        detail = String((j as any)?.error ?? detail)
      } catch {
        /* noop */
      }
      throw new Error(detail)
    }
    return res.json()
  }

  const loadStatus = async () => {
    await syncConfig()
    status.value = await api('/remote/status')
  }

  const loadDevices = async () => {
    const data = await api('/remote/devices')
    devices.value = Array.isArray(data.devices) ? data.devices : []
  }

  const refresh = async () => {
    loading.value = true
    error.value = ''
    try {
      await loadStatus()
      await loadDevices()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  const genCode = async () => {
    error.value = ''
    const data = await api('/remote/pair-code', { method: 'POST', body: JSON.stringify({}) })
    pair.value = { code: data.code, fingerprint: data.fingerprint, expiresAt: data.expiresAt }
    return pair.value
  }

  const acceptCode = async (code: string, remoteDeviceId: string, remotePubKey: string, name: string) => {
    error.value = ''
    if (!isValidPairCode(code)) throw new Error('code: 6 dígitos')
    const data = await api('/remote/pair-accept', {
      method: 'POST',
      body: JSON.stringify({ code: code.trim(), remoteDeviceId, remotePubKey, name })
    })
    await loadDevices()
    return data
  }

  const revoke = async (deviceId: string) => {
    await api(`/remote/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' })
    await loadDevices()
  }

  const savePolicy = async (deviceId: string, allowedActions: string[]) => {
    await api('/remote/policy', {
      method: 'PUT',
      body: JSON.stringify({ deviceId, allowedActions })
    })
    await loadDevices()
  }

  const rotate = async () => {
    const data = await api('/remote/rotate', { method: 'POST' })
    pair.value = null
    await refresh()
    return data
  }

  /** Suscripción WS al topic `remote` (mismo patrón que useStreamDeck). */
  const connectWs = () => {
    try {
      if (typeof WebSocket === 'undefined') return
      const protocol =
        typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
      ws = new WebSocket(`${protocol}//${host}:${wsPort}`)
      ws.onopen = () => {
        ws?.send(JSON.stringify({ type: 'subscribe', payload: { topics: ['remote', 'logs'] } }))
      }
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String((ev as MessageEvent).data))
          if (typeof msg?.type === 'string' && msg.type.startsWith('remote.')) {
            pushEvent(msg.type, msg.payload ?? {})
          } else if (msg?.type === 'log.created' && (msg.payload as any)?.meta?.remote) {
            pushEvent('remote.log', {
              from: (msg.payload as any)?.meta?.from,
              type: (msg.payload as any)?.message
            })
          }
        } catch {
          /* mensaje no JSON: ignorar */
        }
      }
      ws.onclose = () => {
        ws = null
      }
    } catch {
      /* sin WS (tests): el panel sigue funcionando por REST */
    }
  }

  const disconnectWs = () => {
    try {
      ws?.close()
    } catch {
      /* noop */
    }
    ws = null
  }

  return {
    status,
    devices,
    pair,
    events,
    loading,
    error,
    apiBase,
    refresh,
    loadStatus,
    loadDevices,
    genCode,
    acceptCode,
    revoke,
    savePolicy,
    rotate,
    connectWs,
    disconnectWs,
    pushEvent
  }
}
