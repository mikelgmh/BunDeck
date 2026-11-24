/**
 * useRemoteRtc — WebRTC P2P para modo túnel (/t/<token>/).
 *
 * Intenta conexión directa con el daemon (DataChannel `libredeck-rpc`).
 * Señalización por el WS tuneleado existente (`rtc-offer/rtc-answer/rtc-ice`
 * como mensajes `type:` dentro del puente `ws-msg`).
 * Si P2P falla (8s) → fallback silencioso al transporte relay (HTTP+WS).
 */
import { ref } from 'vue'
import { getTunnelToken, tunnelWsUrl } from './useTunnel'

export type RtcStatus = 'idle' | 'signaling' | 'connected' | 'fallback'

const STUN_URLS = ['stun:stun.l.google.com:19302']

interface PendingApi {
  resolve: (r: Response) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function b64encodeText(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
}

function b64decodeText(b64: string): string {
  return decodeURIComponent(escape(atob(b64)))
}

export function useRemoteRtc() {
  const status = ref<RtcStatus>('idle')
  const detail = ref<string>('')
  let pc: RTCPeerConnection | null = null
  let dc: RTCDataChannel | null = null
  let signalWs: WebSocket | null = null
  let sessionToken = ''
  const pending = new Map<string, PendingApi>()
  const eventListeners = new Set<(raw: string) => void>()
  let helloOk = false

  function onEvent(cb: (raw: string) => void): () => void {
    eventListeners.add(cb)
    return () => eventListeners.delete(cb)
  }

  function cleanupSignal() {
    try {
      signalWs?.close()
    } catch {
      /* noop */
    }
    signalWs = null
  }

  async function connect(): Promise<boolean> {
    const tok = getTunnelToken()
    if (!tok || pc) return false
    if (!/^[0-9a-fA-F]{32,}$/.test(tok)) return false
    sessionToken = tok
    status.value = 'signaling'
    detail.value = 'signaling'
    try {
      const ok = await signalingHandshake(tok)
      if (!ok) throw new Error('handshake failed')
      const opened = await waitDcOpen(8000)
      if (!opened) throw new Error('dc timeout')
      const welcomed = await dcHello(5000)
      if (!welcomed) throw new Error('hello rejected')
      status.value = 'connected'
      detail.value = 'p2p'
      // Suscribe eventos principales por el DataChannel (además del WS existente).
      dcSubscribe(['profiles', 'pages', 'buttons', 'plugins', 'devices', 'remote', 'settings'])
      return true
    } catch (e) {
      detail.value = e instanceof Error ? e.message.slice(0, 80) : 'failed'
      status.value = 'fallback'
      closePeer()
      // Deja el WS de señalización cerrado; el transporte relay sigue intacto.
      cleanupSignal()
      return false
    }
  }

  function signalingHandshake(tok: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const url = tunnelWsUrl(tok)
        const ws = new WebSocket(url)
        signalWs = ws
        let done = false
        const finish = (v: boolean) => {
          if (!done) {
            done = true
            resolve(v)
          }
        }
        const to = setTimeout(() => finish(false), 10000)
        ws.onopen = async () => {
          try {
            pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_URLS }] })
            dc = pc.createDataChannel('libredeck-rpc', { ordered: true })
            wireDc()
            pc.onicecandidate = (ev) => {
              if (ev.candidate) {
                try {
                  ws.send(JSON.stringify({ type: 'rtc-ice', payload: { candidate: ev.candidate } }))
                } catch {
                  /* noop */
                }
              }
            }
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            ws.send(JSON.stringify({ type: 'rtc-offer', payload: { sdp: offer.sdp } }))
          } catch {
            clearTimeout(to)
            finish(false)
          }
        }
        ws.onmessage = async (ev) => {
          try {
            const msg = JSON.parse(String(ev.data)) as { type?: string; payload?: { sdp?: string; candidate?: RTCIceCandidateInit; error?: string } }
            if (msg.type === 'rtc-answer' && msg.payload?.sdp && pc) {
              await pc.setRemoteDescription({ type: 'answer', sdp: msg.payload.sdp } as RTCSessionDescriptionInit)
              clearTimeout(to)
              finish(true)
            } else if (msg.type === 'rtc-answer' && msg.payload?.error) {
              clearTimeout(to)
              finish(false)
            } else if (msg.type === 'rtc-ice' && msg.payload?.candidate && pc) {
              try {
                await pc.addIceCandidate(msg.payload.candidate)
              } catch {
                /* noop */
              }
            }
          } catch {
            /* mensajes del protocolo WS normal: ignorar en socket de señalización */
          }
        }
        ws.onerror = () => {
          clearTimeout(to)
          finish(false)
        }
        ws.onclose = () => {
          if (!done) {
            clearTimeout(to)
            finish(false)
          }
        }
      } catch {
        resolve(false)
      }
    })
  }

  function wireDc() {
    if (!dc) return
    dc.onmessage = (ev) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : String(ev.data)
        const msg = JSON.parse(raw) as { t?: string; id?: string; status?: number; headers?: Record<string, string>; bodyB64?: string; data?: string }
        if (msg.t === 'api-res' && typeof msg.id === 'string') {
          const p = pending.get(msg.id)
          if (p) {
            pending.delete(msg.id)
            clearTimeout(p.timer)
            const body = msg.bodyB64 ? Uint8Array.from(atob(msg.bodyB64), (c) => c.charCodeAt(0)) : new Uint8Array()
            const headers = new Headers(msg.headers ?? {})
            p.resolve(new Response(body as BodyInit, { status: msg.status ?? 200, headers }))
          }
          return
        }
        if (msg.t === 'event' && typeof msg.data === 'string') {
          for (const cb of [...eventListeners]) {
            try {
              cb(msg.data)
            } catch {
              /* noop */
            }
          }
          return
        }
        // welcome/pong/subbed: ignorar (o log futuro)
      } catch {
        /* noop */
      }
    }
  }

  function waitDcOpen(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!dc) return resolve(false)
      if (dc.readyState === 'open') return resolve(true)
      const to = setTimeout(() => resolve(dc?.readyState === 'open'), timeoutMs)
      dc.onopen = () => {
        clearTimeout(to)
        wireDc()
        resolve(true)
      }
    })
  }

  function dcSend(obj: unknown): boolean {
    try {
      if (dc && dc.readyState === 'open') {
        dc.send(JSON.stringify(obj))
        return true
      }
    } catch {
      /* noop */
    }
    return false
  }

  function dcHello(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const handler = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data)) as { t?: string }
          if (msg.t === 'welcome') {
            helloOk = true
            dc?.removeEventListener('message', handler as EventListener)
            clearTimeout(to)
            resolve(true)
          } else if (msg.t === 'bye') {
            dc?.removeEventListener('message', handler as EventListener)
            clearTimeout(to)
            resolve(false)
          }
        } catch {
          /* noop */
        }
      }
      const to = setTimeout(() => {
        try {
          dc?.removeEventListener('message', handler as EventListener)
        } catch {
          /* noop */
        }
        resolve(helloOk)
      }, timeoutMs)
      try {
        dc?.addEventListener('message', handler as EventListener)
      } catch {
        /* noop */
      }
      if (!dcSend({ t: 'hello', sessionToken })) {
        clearTimeout(to)
        resolve(false)
      }
    })
  }

  function dcSubscribe(topics: string[]): void {
    dcSend({ t: 'sub', topics })
  }

  /** API por DataChannel si P2P está conectado; si no, null para que el caller haga fetch. */
  function rtcFetch(path: string, init?: RequestInit): Promise<Response | null> {
    if (status.value !== 'connected' || !dc || dc.readyState !== 'open' || !helloOk) {
      return Promise.resolve(null)
    }
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    try {
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v
      })
    } catch {
      /* noop */
    }
    // Body → base64 (límite 5MB como el túnel HTTP).
    const readBody = async (): Promise<string | null> => {
      const b = init?.body
      if (!b || method === 'GET' || method === 'HEAD') return null
      if (typeof b === 'string') return b64encodeText(b)
      if (b instanceof Uint8Array) {
        let s = ''
        for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
        return btoa(s)
      }
      return null
    }
    return (async () => {
      const bodyB64 = await readBody()
      const id = `rtc-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
      return new Promise<Response | null>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          resolve(null) // timeout → fallback a fetch
        }, 8000)
        pending.set(id, {
          resolve: (r) => {
            clearTimeout(timer)
            resolve(r)
          },
          reject: () => {
            clearTimeout(timer)
            resolve(null)
          },
          timer,
        })
        const ok = dcSend({ t: 'api-req', id, method, path, headers, bodyB64 })
        if (!ok) {
          clearTimeout(timer)
          pending.delete(id)
          resolve(null)
        }
      })
    })()
  }

  function closePeer() {
    for (const [, p] of [...pending]) {
      try {
        clearTimeout(p.timer)
      } catch {
        /* noop */
      }
    }
    pending.clear()
    try {
      dc?.close()
    } catch {
      /* noop */
    }
    try {
      pc?.close()
    } catch {
      /* noop */
    }
    dc = null
    pc = null
    helloOk = false
  }

  function disconnect() {
    closePeer()
    cleanupSignal()
    status.value = 'idle'
  }

  return { status, detail, connect, disconnect, rtcFetch, onEvent, dcSubscribe }
}

/** Singleton compartido para que apiRequest pueda usar P2P sin prop drilling. */
let singleton: ReturnType<typeof useRemoteRtc> | null = null

export function getRtcSingleton(): ReturnType<typeof useRemoteRtc> {
  if (!singleton) singleton = useRemoteRtc()
  return singleton
}

/** Intento P2P para un endpoint /api/v1/... si RTC está conectado; null si no. */
export async function rtcFetchIfConnected(endpoint: string, options: RequestInit = {}): Promise<Response | null> {
  try {
    const rtc = getRtcSingleton()
    if (rtc.status.value !== 'connected') return null
    // endpoint viene como `/profiles` etc. desde apiRequest; asegura `/api/v1` fuera.
    // useStreamDeck llama con endpoint relativo; aquí recibimos path completo.
    const path = endpoint.startsWith('/api/') ? endpoint : `/api/v1${endpoint.startsWith('/') ? '' : '/'}${endpoint}`
    return await rtc.rtcFetch(path, options)
  } catch {
    return null
  }
}

export function decodeTunnelBody(b64: string): string {
  try {
    return b64decodeText(b64)
  } catch {
    return ''
  }
}
