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

/** Huella de clave pública: 8 grupos de 4 hex separados por `:` (daemon remote/crypto.ts). */
export function isValidFingerprint(fp: string): boolean {
  return /^[0-9a-f]{4}(:[0-9a-f]{4}){7}$/i.test(String(fp ?? '').trim())
}

/** Contenido del QR de emparejamiento: `GET /api/v1/remote/qr` → campo `qr`. */
export interface RemoteQrPayload {
  v: number
  relay: string
  code: string
  dev: string
  pub: string
  fp: string
  exp: number
}

export interface RemoteQrData {
  code: string
  fingerprint: string
  deviceId: string
  publicKey: string
  expiresAt: number
  relayUrl: string
  qr: string
}

export type QrParseError = 'malformed' | 'version' | 'fields' | 'fingerprint' | 'expired'

export type QrParseResult = { ok: true; payload: RemoteQrPayload } | { ok: false; error: QrParseError }

/**
 * Valida el contenido escaneado/pegado de un QR de emparejamiento.
 * No lanza: devuelve `{ ok, payload | error }` para mapear a i18n en el panel.
 */
export function parseRemoteQr(text: string, now: number = Date.now()): QrParseResult {
  let obj: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(String(text ?? ''))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'malformed' }
    obj = parsed as Record<string, unknown>
  } catch {
    return { ok: false, error: 'malformed' }
  }
  if (obj.v !== 1) return { ok: false, error: 'version' }
  const payload = obj as unknown as RemoteQrPayload
  if (
    typeof payload.relay !== 'string' ||
    !isValidPairCode(String(payload.code ?? '')) ||
    typeof payload.dev !== 'string' ||
    !payload.dev ||
    typeof payload.pub !== 'string' ||
    !payload.pub ||
    typeof payload.exp !== 'number' ||
    !Number.isFinite(payload.exp)
  ) {
    return { ok: false, error: 'fields' }
  }
  if (!isValidFingerprint(String(payload.fp ?? ''))) return { ok: false, error: 'fingerprint' }
  if (payload.exp <= now) return { ok: false, error: 'expired' }
  return { ok: true, payload }
}

/**
 * Heurística móvil: UA móvil/tablet, o puntero grueso + táctil (iPad en modo escritorio).
 * Acepta overrides para tests (jsdom no tiene matchMedia ni touch reales).
 */
export function isMobileLike(
  input: { userAgent?: string; coarsePointer?: boolean; touchPoints?: number } = {}
): boolean {
  const ua =
    input.userAgent ?? (typeof navigator !== 'undefined' ? String(navigator.userAgent ?? '') : '')
  const coarse =
    input.coarsePointer ??
    (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches
      : false)
  const touch =
    input.touchPoints ??
    (typeof navigator !== 'undefined' ? Number((navigator as any)?.maxTouchPoints ?? 0) : 0)
  if (/android|iphone|ipad|ipod|mobile|tablet/i.test(ua)) return true
  return coarse && touch > 0
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
  const qr = ref<RemoteQrData | null>(null)
  const qrDataUrl = ref('')
  const qrUnsupported = ref(false)
  const qrError = ref('')

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

  /**
   * Pide `GET /remote/qr` (cada llamada genera un código nuevo en el daemon) y
   * renderiza el string `qr` a data-URL PNG con `qrcode` (dynamic import: el
   * encoder solo se carga cuando el usuario abre la sección QR).
   * Si el daemon aún no expone el endpoint (404) marca `qrUnsupported` para que
   * el panel muestre el aviso de actualización en vez de la sección QR.
   */
  const fetchQr = async () => {
    qrError.value = ''
    await syncConfig()
    let res: Response
    try {
      res = await fetch(`${apiBase()}/remote/qr`)
    } catch (e) {
      qrError.value = e instanceof Error ? e.message : String(e)
      throw e
    }
    if (res.status === 404) {
      qrUnsupported.value = true
      qr.value = null
      qrDataUrl.value = ''
      throw new Error('qr-unsupported')
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try {
        const j = await res.json()
        detail = String((j as any)?.error ?? detail)
      } catch {
        /* noop */
      }
      qrError.value = detail
      throw new Error(detail)
    }
    const data = await res.json()
    qr.value = {
      code: data.code,
      fingerprint: data.fingerprint,
      deviceId: data.deviceId,
      publicKey: data.publicKey,
      expiresAt: data.expiresAt,
      relayUrl: String(data.relayUrl ?? data.relay ?? ''),
      qr: String(data.qr ?? '')
    }
    const { default: QRCode } = await import('qrcode')
    qrDataUrl.value = await QRCode.toDataURL(qr.value.qr, { width: 280, margin: 2 })
    return qr.value
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
    qr,
    qrDataUrl,
    qrUnsupported,
    qrError,
    apiBase,
    refresh,
    loadStatus,
    loadDevices,
    genCode,
    fetchQr,
    acceptCode,
    revoke,
    savePolicy,
    rotate,
    connectWs,
    disconnectWs,
    pushEvent
  }
}
