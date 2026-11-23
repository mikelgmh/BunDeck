/**
 * Native Spotify Plugin
 * Controla Spotify vía Web API: reproducción, Me gusta, aleatorio y playlists.
 * El plugin `multimedia` cubre el control a nivel de SO; este plugin cubre
 * la sección "Spotify" del panel usando la API oficial con OAuth.
 */

import { CONTRACT_API_VERSION, CONTRACT_ENGINE } from './contract'

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

const SPOTIFY_API_BASE = 'https://api.spotify.com/v1'
const SPOTIFY_WEB_PLAYER_URL = 'https://open.spotify.com'
const SPOTIFY_TOKEN_URL = 'https://open.spotify.com/get_access_token?reason=transport&productType=web_player'
const REQUEST_TIMEOUT_MS = 15000

/** Margen de seguridad antes de considerar el token caducado (60s). */
export const SPOTIFY_EXPIRY_SKEW_MS = 60_000

export interface SpotifyTokenCapture {
  accessToken: string
  expiresIn?: number
  tokenType?: string
  /** Campos extra que devuelva el web player: se guardan tal cual. */
  [k: string]: unknown
}

export interface SpotifyStoredToken {
  token: string
  tokenType: string
  tokenObtainedAt: string
  tokenExpiresAt: string
  tokenExpiresIn: string
}

/**
 * Valida el payload capturado del web player y lo normaliza a ajustes.
 * Función pura (sin contexto) para poder testearla sin instanciar nada.
 * Lanza si falta accessToken o tiene forma inválida.
 */
export function normalizeSpotifyTokenCapture(payload: any, nowMs: number = Date.now()): SpotifyStoredToken {
  const accessToken = payload?.accessToken ?? payload?.access_token ?? payload?.token
  if (typeof accessToken !== 'string' || accessToken.trim().length < 10) {
    throw new Error('Token de Spotify inválido: falta accessToken')
  }
  const expiresInRaw = Number(payload?.expiresIn ?? payload?.expires_in ?? 3600)
  const expiresIn = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? Math.floor(expiresInRaw) : 3600
  const obtainedAt = nowMs
  // Guardamos todo: tipo, expiración absoluta y relativa.
  return {
    token: accessToken,
    tokenType: typeof payload?.tokenType === 'string' ? payload.tokenType : 'Bearer',
    tokenObtainedAt: String(obtainedAt),
    tokenExpiresAt: String(obtainedAt + expiresIn * 1000),
    tokenExpiresIn: String(expiresIn),
  }
}

/** ¿El token guardado está caducado (con margen de seguridad)? */
export function isSpotifyStoredTokenExpired(values: Record<string, any>, nowMs: number = Date.now()): boolean {
  const exp = Number(values?.tokenExpiresAt)
  if (!Number.isFinite(exp) || exp <= 0) return false // sin metadata: no bloquear, el API dirá 401
  return nowMs + SPOTIFY_EXPIRY_SKEW_MS >= exp
}

const NO_DEVICE_MESSAGE =
    'No hay ningún dispositivo Spotify activo (404). Abre Spotify en algún dispositivo e inténtalo de nuevo.'
const AUTH_ERROR_MESSAGE = 'token inválido o sin permisos (revisa OAuth)'

export class SpotifyPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        return {
            id: 'spotify',
            name: 'Spotify',
            version: '1.2.0',
            description: 'Controla la reproducción de Spotify: reproducir/pausar, Me gusta, aleatorio y playlists',
            author: 'BunDeck',
            apiVersion: CONTRACT_API_VERSION,
            engine: CONTRACT_ENGINE,
            category: 'integrations',
            permissions: ['http', 'network'],
            // OAuth sin Client ID propio: la app de escritorio abre el Web Player
            // oficial en una ventana Electrobun y extrae el token de sesión.
            // El dialog de ajustes muestra "Conectar con Spotify" cuando oauth está presente.
            oauth: {
                provider: 'spotify',
                method: 'web-player-extraction',
                loginUrl: SPOTIFY_WEB_PLAYER_URL,
                tokenUrl: SPOTIFY_TOKEN_URL,
                notes: 'Sin Client ID: usa tu sesión del Web Player oficial. El token se extrae en local y se guarda en los ajustes.'
            },
            settingsSchema: {
                type: 'object',
                properties: {
                    token: {
                        type: 'string',
                        title: 'Token OAuth',
                        description: 'Token OAuth de Spotify (scopes: user-modify-playback-state, user-read-playback-state, user-library-modify). Se rellena solo con "Conectar con Spotify" o pégalo a mano.',
                        ui: { component: 'input', type: 'password', placeholder: 'Usa "Conectar con Spotify" o pega tu token' }
                    },
                    tokenType: {
                        type: 'string',
                        title: 'Tipo de token',
                        description: 'Tipo de token devuelto por el Web Player (normalmente Bearer). Se guarda automáticamente.',
                        ui: { component: 'hidden' }
                    },
                    tokenObtainedAt: {
                        type: 'string',
                        title: 'Obtenido el (ms)',
                        description: 'Timestamp de captura. Se guarda automáticamente.',
                        ui: { component: 'hidden' }
                    },
                    tokenExpiresAt: {
                        type: 'string',
                        title: 'Caduca el (ms)',
                        description: 'Timestamp de caducidad. Se guarda automáticamente.',
                        ui: { component: 'hidden' }
                    },
                    tokenExpiresIn: {
                        type: 'string',
                        title: 'Expira en (s)',
                        description: 'Segundos de validez. Se guarda automáticamente.',
                        ui: { component: 'hidden' }
                    }
                },
                required: ['token']
            },
            instructions: 'Para conectar con Spotify (sin Client ID):\n\n1. Abre los ajustes del plugin (menú ⋯) y pulsa "Conectar con Spotify".\n2. Se abre el Web Player oficial: inicia sesión si hace falta.\n3. BunDeck extrae el token de tu sesión en local y lo guarda aquí (no sale de tu equipo).\n4. Mientras la app siga abierta, el token se renueva solo en segundo plano (la sesión del Web Player reacuña cada ~1h). Solo tendrás que repetir el paso 1 si cierras sesión en Spotify.\n\nNota: un <iframe> incrustado no funciona (Spotify lo bloquea con X-Frame-Options: deny); por eso se usa una ventana propia.',
            actions: [
                {
                    id: 'playback',
                    name: 'Reproducir / Pausar / Siguiente / Anterior',
                    description: 'Controla la reproducción de Spotify (play, pause, next, previous)',
                    icon: 'Play',
                    timeoutMs: REQUEST_TIMEOUT_MS,
                    states: [
                        { value: 'playing', label: 'Sonando', icon: 'Pause' },
                        { value: 'paused', label: 'En pausa', icon: 'Play' },
                        { value: 'stopped', label: 'Detenido', icon: 'Square' }
                    ],
                    schema: {
                        type: 'object',
                        properties: {
                            token: {
                                type: 'string',
                                title: 'Token OAuth',
                                description:
                                    'Token OAuth de Spotify con scopes de control de reproducción (user-modify-playback-state, user-read-playback-state)',
                                ui: {
                                    component: 'input',
                                    type: 'password',
                                    placeholder: 'Pega aquí tu token OAuth de Spotify'
                                }
                            },
                            action: {
                                type: 'string',
                                title: 'Acción de reproducción',
                                enum: ['play', 'pause', 'next', 'previous'],
                                description: 'Acción de reproducción a ejecutar',
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'play', label: 'Reproducir' },
                                        { value: 'pause', label: 'Pausar' },
                                        { value: 'next', label: 'Siguiente' },
                                        { value: 'previous', label: 'Anterior' }
                                    ]
                                }
                            },
                            deviceId: {
                                type: 'string',
                                title: 'ID de dispositivo',
                                description:
                                    'ID del dispositivo Spotify objetivo (opcional; si se omite se usa el dispositivo activo)',
                                ui: {
                                    component: 'input',
                                    type: 'text',
                                    placeholder: 'ID de dispositivo (opcional)'
                                }
                            }
                        },
                        required: ['action']
                    }
                },
                {
                    id: 'like',
                    name: 'Me gusta',
                    description: 'Guarda la pista actual (o una indicada) en "Tus Me gusta" de Spotify',
                    icon: 'Heart',
                    schema: {
                        type: 'object',
                        properties: {
                            token: {
                                type: 'string',
                                title: 'Token OAuth',
                                description:
                                    'Token OAuth de Spotify con scope user-library-modify (y user-read-playback-state si no indicas pista)',
                                ui: {
                                    component: 'input',
                                    type: 'password',
                                    placeholder: 'Pega aquí tu token OAuth de Spotify'
                                }
                            },
                            trackId: {
                                type: 'string',
                                title: 'ID de pista',
                                description:
                                    'ID de la pista a guardar (opcional; si se omite se usa la pista que está sonando)',
                                ui: {
                                    component: 'input',
                                    type: 'text',
                                    placeholder: 'ID de pista (opcional, usa la actual si se omite)'
                                }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'shuffle',
                    name: 'Aleatorio',
                    description: 'Activa o desactiva el modo aleatorio de Spotify',
                    icon: 'Shuffle',
                    schema: {
                        type: 'object',
                        properties: {
                            token: {
                                type: 'string',
                                title: 'Token OAuth',
                                description:
                                    'Token OAuth de Spotify con scope de control de reproducción (user-modify-playback-state)',
                                ui: {
                                    component: 'input',
                                    type: 'password',
                                    placeholder: 'Pega aquí tu token OAuth de Spotify'
                                }
                            },
                            state: {
                                type: 'boolean',
                                title: 'Aleatorio',
                                description: 'true para activar el modo aleatorio, false para desactivarlo',
                                ui: {
                                    component: 'toggle',
                                    labelOn: 'Activado',
                                    labelOff: 'Desactivado'
                                }
                            },
                            deviceId: {
                                type: 'string',
                                title: 'ID de dispositivo',
                                description:
                                    'ID del dispositivo Spotify objetivo (opcional; si se omite se usa el dispositivo activo)',
                                ui: {
                                    component: 'input',
                                    type: 'text',
                                    placeholder: 'ID de dispositivo (opcional)'
                                }
                            }
                        },
                        required: ['state']
                    }
                },
                {
                    id: 'playlist',
                    name: 'Abrir lista',
                    description: 'Reproduce una playlist de Spotify (por ID o URI de contexto)',
                    icon: 'ListMusic',
                    schema: {
                        type: 'object',
                        properties: {
                            token: {
                                type: 'string',
                                title: 'Token OAuth',
                                description:
                                    'Token OAuth de Spotify con scope de control de reproducción (user-modify-playback-state)',
                                ui: {
                                    component: 'input',
                                    type: 'password',
                                    placeholder: 'Pega aquí tu token OAuth de Spotify'
                                }
                            },
                            playlistId: {
                                type: 'string',
                                title: 'ID de playlist',
                                description: 'ID de la playlist a reproducir (uno entre ID o URI de contexto es requerido)',
                                ui: {
                                    component: 'input',
                                    type: 'text',
                                    placeholder: 'Ej: 37i9dQZF1DXcBWIGoYBM5M'
                                }
                            },
                            contextUri: {
                                type: 'string',
                                title: 'URI de contexto',
                                description:
                                    'URI de contexto Spotify (p. ej. spotify:playlist:<id>). Uno entre ID o URI es requerido.',
                                ui: {
                                    component: 'input',
                                    type: 'text',
                                    placeholder: 'Ej: spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'
                                }
                            },
                            deviceId: {
                                type: 'string',
                                title: 'ID de dispositivo',
                                description:
                                    'ID del dispositivo Spotify objetivo (opcional; si se omite se usa el dispositivo activo)',
                                ui: {
                                    component: 'input',
                                    type: 'text',
                                    placeholder: 'ID de dispositivo (opcional)'
                                }
                            }
                        },
                        required: [],
                        anyOf: [{ required: ['playlistId'] }, { required: ['contextUri'] }]
                    }
                },
                {
                    id: 'now-playing',
                    name: 'Lo que suena',
                    description: 'Pista actual e is_playing para iconos dinámicos (states: playing/paused/stopped)',
                    icon: 'Music',
                    dynamic: true,
                    pollMs: 10000,
                    timeoutMs: REQUEST_TIMEOUT_MS,
                    states: [
                        { value: 'playing', label: 'Sonando', icon: 'Pause' },
                        { value: 'paused', label: 'En pausa', icon: 'Play' },
                        { value: 'stopped', label: 'Detenido', icon: 'Square' }
                    ],
                    schema: {
                        type: 'object',
                        properties: {
                            token: {
                                type: 'string',
                                title: 'Token OAuth',
                                description: 'Si se omite usa el de los ajustes',
                                ui: { component: 'input', type: 'password', placeholder: 'Usa el de ajustes' }
                            }
                        },
                        required: []
                    }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('playback', this.executePlayback.bind(this))
        handlers.set('like', this.executeLike.bind(this))
        handlers.set('shuffle', this.executeShuffle.bind(this))
        handlers.set('playlist', this.executePlaylist.bind(this))
        handlers.set('now-playing', this.executeNowPlaying.bind(this))
        return handlers
    }

    private requireToken(params: any): string {
        // El parámetro tiene prioridad; si falta, se usa el ajuste del plugin.
        // El token explícito por parámetro no caduca desde nuestro punto de
        // vista (lo acaba de pegar el usuario): el chequeo de caducidad solo
        // aplica al token guardado de la captura automática.
        const fromParams = params?.token
        if (typeof fromParams === 'string' && fromParams.trim().length > 0) return fromParams
        try {
            const fromSettings = this.context.getSetting?.('token')
            if (typeof fromSettings === 'string' && fromSettings.trim().length > 0) {
                if (this.isStoredTokenExpired()) {
                    // Avisa al host Electrobun (poll de login-request) para que
                    // reacuñe en silencio con las cookies del Web Player.
                    this.signalRefreshNeeded()
                    throw new Error('Token de Spotify caducado: renovando en segundo plano, reintenta en unos segundos (o pulsa "Volver a conectar" en los ajustes del plugin)')
                }
                return fromSettings
            }
        } catch (e) {
            if (e instanceof Error && e.message.includes('caducado')) throw e
            /* sin ajustes: cae al error de falta de token */
        }
        throw new Error('Falta el token OAuth: ponlo en los ajustes del plugin (⋯) o en el parámetro "token"')
    }

    /**
     * ¿El token guardado es de captura automática y está caducado?
     * Los tokens pegados a mano (sin metadata tokenExpiresAt) no se chequean:
     * si fallan, el 401 del API lo dirá.
     */
    private isStoredTokenExpired(nowMs: number = Date.now()): boolean {
        try {
            const exp = this.context.getSetting?.('tokenExpiresAt')
            if (typeof exp !== 'string' || exp.trim().length === 0) return false
            return isSpotifyStoredTokenExpired({ tokenExpiresAt: exp }, nowMs)
        } catch {
            return false
        }
    }

    /** ¿El token guardado viene de la captura automática (tiene metadata)? */
    private hasAutoTokenMetadata(): boolean {
        try {
            const exp = this.context.getSetting?.('tokenExpiresAt')
            return typeof exp === 'string' && exp.trim().length > 0
        } catch {
            return false
        }
    }

    /** Marca auto-refresh para que el host reacuñe el token en silencio.
     * Usa clave PROPIA (no loginRequestedAt): las señales de fondo nunca
     * abren ventanas visibles; solo el click explícito en "Conectar" lo hace.
     * Throttle: no insistir si ya se señaló hace poco. */
    private signalRefreshNeeded(): void {
        try {
            const prev = Number(this.context.getSetting?.('autoRefreshRequestedAt'))
            if (Number.isFinite(prev) && prev > 0 && Date.now() - prev < 5 * 60_000) return
            this.context.setSetting?.('autoRefreshRequestedAt', String(Date.now()))
        } catch { /* best-effort */ }
    }

    private buildUrl(path: string, query?: Record<string, string | undefined>): string {
        const qs = Object.entries(query ?? {})
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
            .join('&')
        return `${SPOTIFY_API_BASE}${path}${qs ? `?${qs}` : ''}`
    }

    /**
     * Llamada real con el token. Se separa del logueo para no exponer el secreto:
     * los logs solo contienen método, URL y estado, nunca el token.
     */
    private async authorizedFetch(
        token: string,
        label: string,
        path: string,
        options: { method: string; query?: Record<string, string | undefined>; body?: unknown }
    ): Promise<{ status: number; body: any }> {
        const url = this.buildUrl(path, options.query)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
            this.context.log('info', `Spotify ${label}: ${options.method} ${url}`)
            const response = await fetch(url, {
                method: options.method,
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
                signal: controller.signal
            })
            return await this.handleResponse(label, url, response)
        } catch (error: any) {
            if (error?.name === 'AbortError') {
                this.context.log('error', `Spotify ${label}: tiempo de espera agotado (15s)`, { path })
                throw new Error(`La petición a Spotify tardó demasiado (timeout de 15s): ${label}`)
            }
            if (error?.message === AUTH_ERROR_MESSAGE || error?.message?.includes('dispositivo Spotify activo') || error?.message?.includes('renovando en segundo plano')) {
                throw error
            }
            this.context.log('error', `Spotify ${label}: error de red`, { path })
            throw error
        } finally {
            clearTimeout(timer)
        }
    }

    private async handleResponse(label: string, url: string, response: Response): Promise<{ status: number; body: any }> {
        if (response.status === 401 || response.status === 403) {
            this.context.log('error', `Spotify ${label}: ${response.status} (autenticación)`, { url })
            // Token automático caducado/revocado: pedir renovación silenciosa
            // al host en vez del error genérico. Los manuales mantienen el
            // mensaje clásico (el host no puede reacuñarlos sin sesión).
            if (this.hasAutoTokenMetadata()) {
                this.signalRefreshNeeded()
                throw new Error('Token de Spotify no válido o caducado: renovando en segundo plano, reintenta en unos segundos')
            }
            throw new Error(AUTH_ERROR_MESSAGE)
        }
        if (response.status === 404) {
            this.context.log('error', `Spotify ${label}: 404 sin dispositivo activo`, { url })
            throw new Error(NO_DEVICE_MESSAGE)
        }
        if (!response.ok) {
            const text = await response.text().catch(() => '')
            this.context.log('error', `Spotify ${label}: error ${response.status}`, { url })
            throw new Error(`Error de la API de Spotify (${response.status}): ${text || response.statusText || label}`)
        }
        if (response.status === 204) {
            this.context.log('info', `Spotify ${label}: éxito (204 sin contenido)`, { url })
            return { status: 204, body: null }
        }
        const text = await response.text()
        let body: any = null
        if (text) {
            try {
                body = JSON.parse(text)
            } catch {
                body = text
            }
        }
        this.context.log('info', `Spotify ${label}: éxito (${response.status})`, { url })
        return { status: response.status, body }
    }

    private async executePlayback(params: any, _context: any): Promise<any> {
        const token = this.requireToken(params)
        const action = params?.action
        if (!['play', 'pause', 'next', 'previous'].includes(action)) {
            throw new Error('El parámetro "action" debe ser uno de: play, pause, next, previous')
        }
        const deviceId = typeof params?.deviceId === 'string' && params.deviceId ? params.deviceId : undefined
        const query = deviceId ? { device_id: deviceId } : undefined

        let path: string
        let method: string
        let body: unknown = undefined
        switch (action) {
            case 'play':
                method = 'PUT'
                path = '/me/player/play'
                body = {}
                break
            case 'pause':
                method = 'PUT'
                path = '/me/player/pause'
                break
            case 'next':
                method = 'POST'
                path = '/me/player/next'
                break
            case 'previous':
                method = 'POST'
                path = '/me/player/previous'
                break
            default:
                throw new Error(`Acción de reproducción desconocida: ${action}`)
        }

        const { status } = await this.authorizedFetch(token, `reproducción (${action})`, path, { method, query, body })
        return { action, executed: true, status }
    }

    private async executeLike(params: any, _context: any): Promise<any> {
        const token = this.requireToken(params)
        let trackId = typeof params?.trackId === 'string' && params.trackId ? params.trackId : undefined

        if (!trackId) {
            const { body } = await this.authorizedFetch(token, 'pista actual', '/me/player/currently-playing', {
                method: 'GET'
            })
            trackId = body?.item?.id
            if (!trackId) {
                throw new Error('No hay ninguna pista sonando en Spotify (pon música primero o indica el ID de pista)')
            }
        }

        const { status } = await this.authorizedFetch(token, 'Me gusta', '/me/library', {
            method: 'PUT',
            query: { ids: trackId }
        })
        return { trackId, saved: true, status }
    }

    private async executeShuffle(params: any, _context: any): Promise<any> {
        const token = this.requireToken(params)
        if (typeof params?.state !== 'boolean') {
            throw new Error('El parámetro "state" es requerido y debe ser booleano (true/false)')
        }
        const deviceId = typeof params?.deviceId === 'string' && params.deviceId ? params.deviceId : undefined
        const { status } = await this.authorizedFetch(token, 'aleatorio', '/me/player/shuffle', {
            method: 'PUT',
            query: { state: String(params.state), ...(deviceId ? { device_id: deviceId } : {}) }
        })
        return { state: params.state, executed: true, status }
    }

    private async executePlaylist(params: any, _context: any): Promise<any> {
        const token = this.requireToken(params)
        const playlistId = typeof params?.playlistId === 'string' && params.playlistId ? params.playlistId : undefined
        let contextUri = typeof params?.contextUri === 'string' && params.contextUri ? params.contextUri : undefined
        if (!contextUri && playlistId) {
            contextUri = playlistId.startsWith('spotify:') ? playlistId : `spotify:playlist:${playlistId}`
        }
        if (!contextUri) {
            throw new Error('Debes indicar "playlistId" o "contextUri" (uno de los dos es requerido)')
        }
        const deviceId = typeof params?.deviceId === 'string' && params.deviceId ? params.deviceId : undefined
        const { status } = await this.authorizedFetch(token, 'abrir lista', '/me/player/play', {
            method: 'PUT',
            query: deviceId ? { device_id: deviceId } : undefined,
            body: { context_uri: contextUri }
        })
        return { contextUri, executed: true, status }
    }

    /**
     * Lo que suena (GET /me/player): pista actual + `state` discreto para
     * iconos dinámicos del botón (playing/paused/stopped). No modifica nada.
     */
    private async executeNowPlaying(params: any, _context: any): Promise<any> {
        const token = this.requireToken(params)
        const { status, body } = await this.authorizedFetch(token, 'lo que suena', '/me/player', { method: 'GET' })
        if (status === 204 || !body) {
            return { state: 'stopped', isPlaying: false, track: null, status }
        }
        const track = body?.item
        const name = typeof track?.name === 'string' ? track.name : null
        const artists = Array.isArray(track?.artists) ? track.artists.map((a: any) => a?.name).filter(Boolean).join(', ') : null
        const isPlaying = body?.is_playing === true
        return {
            state: isPlaying ? 'playing' : (name ? 'paused' : 'stopped'),
            isPlaying,
            track: name ? { name, artists, id: track?.id ?? null } : null,
            device: body?.device?.name ?? null,
            status,
        }
    }

    public dispose(): void {
        // Sin recursos que liberar
    }
}
