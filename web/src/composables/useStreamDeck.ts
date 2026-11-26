import { ref, computed, nextTick } from 'vue'
import { getTunnelToken, tunnelApiBase, tunnelConfigUrl, tunnelWsUrl } from './useTunnel'
import { rtcFetchIfConnected, getRtcSingleton } from './useRemoteRtc'
import {
  parseLanInviteFromUrl, stripLanInviteFromUrl, parseRelayFallbackFromUrl,
  getStoredLanSession, setStoredLanSession, clearStoredLanSession,
  isLanDeniedError, LAN_DENIED_CODE,
} from '../utils/lanInvite'
import { ensurePressMirror, pressExtraCount } from './usePressActions'
import { resolvePageSize } from './useDevices'
import { CONTROL_COMPONENTS } from './useActionPresentation'
import {
  applyButtonDeleted as applyButtonDeletedPayload,
  applyButtonPayload,
  applyButtonsReordered,
  applyPageDeleted as applyPageDeletedPayload,
  applyPagePayload,
  buildExecuteManyBody,
  isBatchUnsupported,
  isDynamicDue,
  reloadDebounceMs,
} from '../utils/wsIncremental'
import { getOrCreateDeviceId, deviceDefaultName, isNavigationForMe, isBroadcastNav } from '../utils/sessionRouting'
import { setVarPushSender } from './useVars'
import type { ActionType, ButtonData, ProfileData, PageData, ButtonEntity } from '../types/streamdeck'

/** Icono Lucide por defecto para teclas recién creadas (nombre PascalCase,
 *  como los que guarda el inspector: 'Zap', 'Play'...). */
export const DEFAULT_KEY_ICON = 'Zap'

/**
 * Garantiza icono visual al CREAR una tecla: si no hay icon ni iconImage ni
 * emoji, pone el predeterminado. Solo para creación (no para updates: un
 * vaciado explícito con icon:'' debe conservarse).
 */
export function ensureDefaultIcon<T extends Record<string, any>>(data: T): T {
  const d: any = data && typeof data === 'object' ? { ...data } : {}
  const hasVisual =
    (typeof d.icon === 'string' && d.icon.trim().length > 0) ||
    (typeof d.iconImage === 'string' && d.iconImage.trim().length > 0) ||
    (typeof d.emoji === 'string' && d.emoji.trim().length > 0)
  if (!hasVisual) d.icon = DEFAULT_KEY_ICON
  return d as T
}

// Fallback compartido (congelado) para teclas vacías: evita reconstruir el
// objeto literal en cada llamada a getButtonData. Solo lectura.
const EMPTY_BUTTON_DATA = Object.freeze({
  label: '',
  textTop: '',
  textBottom: '',
  fontSize: 14,
  icon: '',
  iconImage: '',
  emoji: '',
  backgroundColor: '',
  textColor: '#e8e9eb',
  showTitle: true,
  mode: 'seq',
  longPress: 'none',
  confirm: false,
  actions: [],
  rules: [],
  looks: []
})

export function useStreamDeck() {
  // Connection State
  const connectionStatus = ref('bg-error')
  const connectionText = ref('Desconectado')

  // Data State
  const profiles = ref<ProfileData[]>([])
  const selectedProfile = ref('')
  const currentProfile = ref<ProfileData | null>(null)
  const currentPage = ref<PageData | null>(null)
  const currentPages = ref<PageData[]>([])
  const currentButtons = ref<ButtonEntity[]>([])
  const plugins = ref<any[]>([])
  // Gestor de plugins (detalle para instalar/activar/actualizar)
  const pluginsDetailed = ref<any[]>([])
  const marketplace = ref<any[]>([])
  const marketplaceRegistry = ref<string | null>(null)
  const pluginsLoading = ref(false)
  // Vuelo en curso de loadPlugins (dedupe entre arranque y dynamic polling).
  let pluginsInFlight: Promise<void> | null = null

  // Progreso de instalación en vivo (lo emite el daemon por WS)
  const installProgress = ref<{ key: string; stage: string; message: string } | null>(null)
  let installProgressTimer: ReturnType<typeof setTimeout> | null = null
  const clearInstallProgress = () => {
    installProgress.value = null
    if (installProgressTimer) {
      clearTimeout(installProgressTimer)
      installProgressTimer = null
    }
  }

  // Grid State
  const gridCols = ref(5)
  const gridRows = ref(3)
  const selectedButton = ref<number | null>(null)
  const executingButtons = ref<number[]>([])

  // Dynamic button values for real-time updates (any plugin with dynamic actions)
  const dynamicButtonValues = ref(new Map<number, any>())

  // Polling centralizado de botones dinámicos: un solo temporizador recorre
  // los botones dinámicos respetando su updateInterval individual, con
  // concurrencia limitada (evita N setInterval y ráfagas de N POST).
  const DYNAMIC_TICK_MS = 500
  const DYNAMIC_MAX_IN_FLIGHT = 4
  let dynamicTimer: ReturnType<typeof setInterval> | null = null
  let dynamicInFlight = 0
  const dynamicLastRun = new Map<number, number>()

  // Button Config
  const buttonConfig = ref<ButtonData>({
    label: '',
    textTop: '',
    textBottom: '',
    fontSize: 14,
    emoji: '',
    icon: '',
    iconImage: '',
    backgroundColor: '',
    textColor: '#e8e9eb',
    showTitle: true,
    mode: 'seq',
    longPress: 'none',
    confirm: false,
    actions: [],
    rules: [],
    looks: [],
    stateVar: ''
  })

  // Contador ligero de ediciones locales del borrador (autosave): cada
  // mutación local lo incrementa y la UI observa el contador en vez de
  // comparar JSON.stringify del config en cada tecla. Los sets
  // programáticos (selectButton/selectPage) no lo tocan.
  const buttonConfigVersion = ref(0)
  const bumpConfigVersion = () => {
    buttonConfigVersion.value += 1
  }

  // Snapshot del draft tras la última selección/guardado. El draft está
  // NORMALIZADO (todas las claves) mientras la BD puede guardar `{}` o
  // parciales: comparar contra la fila de BD siempre daba "dirty" y el
  // cambio de selección borraba teclas vacías intactas (o reescribía sin
  // motivo). El dirty-check real es contra este snapshot.
  let savedConfigJson = ''
  const snapshotButtonConfig = () => {
    try {
      savedConfigJson = JSON.stringify(buttonConfig.value)
    } catch {
      savedConfigJson = ''
    }
  }
  const isButtonConfigDirty = (): boolean => {
    try {
      return JSON.stringify(buttonConfig.value) !== savedConfigJson
    } catch {
      return false
    }
  }

  // WebSocket
  let ws: WebSocket | null = null
  // Reintento del `hello`: si el mensaje se pierde en el puente del túnel
  // (ws-msg huérfano en el daemon antes de crear el cliente virtual), el
  // cliente quedaría sin sesión y sin presencia hasta recargar la página.
  // Se reenvía hasta recibir `session.state` (máx. 3 intentos).
  let helloTimer: ReturnType<typeof setTimeout> | null = null
  let helloAttempts = 0
  let helloAcked = false

  // Sesión propia del dispositivo: vista profile/page independiente por
  // browser (el daemon la persiste y la restaura al reconectar).
  const deviceId = ref(getOrCreateDeviceId())
  /** Nombre propuesto por el dueño al aprobar (sesión UI remota). */
  const tunnelDeviceName = ref<string | null>(null)
  const lastHelloName = ref('')
  const clientId = ref<string | null>(null)
  const sessionStartupProfileId = ref<string | null>(null)
  // Clientes conectados y su vista actual (GET /sessions).
  const sessions = ref<any[]>([])

  // Invitación LAN (?invite= del QR/enlace): sesión portadora para el
  // daemon cuando NO somos localhost. `lanDenied` muestra la pantalla
  // "Sin permiso" (el anfitrión en localhost nunca la ve: está exento).
  const lanDenied = ref(false)
  const lanSession = ref<string | null>(getStoredLanSession())
  const lanRedeeming = ref(false)
  // Vía de escape al relay (`?relayFallback=<urlCode>`): solo se MUESTRA
  // (código + copiar) cuando el canje LAN falla; jamás redirige solo.
  const lanRelayFallback = ref<string | null>(null)

  // Túnel del relay (/t/<token>/…): si el relay responde invalid-token /
  // expired / daemon-offline, la sesión no vale (reinicio, caducidad 24 h o
  // daemon caído) y en vez de un grid vacío se muestra la tarjeta de
  // "Sesión no válida". Se limpia al primer API ok.
  type TunnelSessionInvalid = 'invalid-token' | 'expired' | 'daemon-offline' | null
  const tunnelSessionInvalid = ref<'invalid-token' | 'expired' | 'daemon-offline' | null>(null)
  const markTunnelGone = (detail: string, status: number): void => {
    if (!getTunnelToken()) return
    if (status !== 401 && status !== 502 && status !== 403) return
    const m = /invalid-token|daemon-offline|expired/.exec(detail)
    if (m) tunnelSessionInvalid.value = m[0] as NonNullable<TunnelSessionInvalid>
  }

  // Flag to prevent infinite loops when receiving page change broadcasts
  const isRemotePageChange = ref(false)

  // Flag to prevent infinite loops when receiving profile change broadcasts
  const isRemoteProfileChange = ref(false)

  // Get dynamic base URLs based on current host — puertos centralizados (API 3001, WS 3003, Frontend 3002, Astro 4321)
  // En modo túnel (/t/<token>/…) el móvil está fuera de la LAN: API y WS van
  // por el mismo origen bajo el prefijo del túnel (ver useTunnel).
  const config = ref({ wsPort: 3003, apiPort: 3001, frontendPort: 3002 });

  const loadConfig = async () => {
    try {
      const tunnelToken = getTunnelToken()
      // En modo dev, hacer fetch al daemon directamente (API 3001).
      // OJO LAN: usar el hostname actual, NUNCA 'localhost' literal —
      // desde una tablet/móvil 'localhost' es el propio dispositivo y el
      // fetch falla → la app arranca sin perfiles/páginas/acciones.
      const hostname = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
      const configUrl = tunnelToken
        ? tunnelConfigUrl(tunnelToken)
        : typeof window !== 'undefined' && window.location.port !== '3001'
          ? `${window.location.protocol}//${hostname}:3001/config`
          : '/config';
      const res = await fetch(configUrl);
      const data = await res.json();
      config.value = data;
      console.log('🔧 Loaded config:', config.value);
    } catch (e) {
      console.error('Failed to load config', e);
    }
  };

  const getApiBase = () => {
    if (typeof window !== 'undefined') {
      const tunnelToken = getTunnelToken()
      if (tunnelToken) return tunnelApiBase(tunnelToken)
      const protocol = window.location.protocol
      const hostname = window.location.hostname
      return `${protocol}//${hostname}:${config.value.apiPort}/api/v1`
    }
    return 'http://localhost:3001/api/v1'
  }

  const getWsUrl = () => {
    if (typeof window !== 'undefined') {
      const tunnelToken = getTunnelToken()
      if (tunnelToken) return tunnelWsUrl(tunnelToken)
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const hostname = window.location.hostname
      const base = `${protocol}//${hostname}:${config.value.wsPort}`
      // Invitado LAN: el upgrade también exige invitación; la cookie viaja
      // sola, pero el query cubre el caso sin cookies.
      if (lanSession.value) return `${base}?invite=${encodeURIComponent(lanSession.value)}`
      return base
    }
    return 'ws://localhost:3003'
  }

  const getFrontendUrl = () => {
    if (typeof window !== 'undefined') {
      return window.location.origin
    }
    return 'http://localhost:4321'
  };

  const API_BASE = computed(() => getApiBase())
  const WS_URL = computed(() => getWsUrl())
  const FRONTEND_URL = computed(() => getFrontendUrl())

  // Storage keys
  const STORAGE_KEYS = {
    SELECTED_PROFILE: 'libredeck_selected_profile'
  }

  // Auto-save state
  const saveTimeout = ref<NodeJS.Timeout | null>(null)
  const isChangingButton = ref(false)
  const isSaving = ref(false)
  const isSwapping = ref(false)

  // La tecla seleccionada se sigue por ID de botón, no solo por posición:
  // si el botón se mueve (drag & drop) y luego se edita, la edición debe ir
  // al botón que estamos editando (su id), no al que ocupaba esa posición.
  const selectedButtonId = ref<string | null>(null)

  // Ecos propios por WebSocket: cada mutación lleva un mutationId que el
  // daemon reenvía en el broadcast. Al recibir nuestro propio eco lo
  // ignoramos (el estado local optimista ya está al día) en vez de recargar
  // desde la BD y "rebotar" la tecla a su posición anterior.
  const pendingMutations = new Set<string>()
  const newMutationId = (): string =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const trackMutation = (id: string): string => {
    pendingMutations.add(id)
    // TTL por si el eco nunca llega (desconexión a mitad): no crecer sin cota.
    setTimeout(() => pendingMutations.delete(id), 10000)
    return id
  }
  const isOwnEcho = (payload: any): boolean => {
    const mid = payload?.mutationId
    if (typeof mid === 'string' && pendingMutations.has(mid)) {
      pendingMutations.delete(mid)
      return true
    }
    return false
  }

  // Guarda de swaps/reorders en curso (contador, no timeout arbitrario):
  // mientras haya persistencia de swaps encolada se ignoran los broadcasts
  // (llegan también los ecos tardíos, cubiertos además por mutationId).
  let swapDepth = 0
  const enterSwap = () => {
    swapDepth += 1
    isSwapping.value = true
  }
  const exitSwap = () => {
    swapDepth = Math.max(0, swapDepth - 1)
    if (swapDepth === 0) isSwapping.value = false
  }

  // Época de los botones (UI optimista): cada mutación local la incrementa.
  // loadButtons descarta respuestas que empezaron antes de la última mutación:
  // un GET viejo que resuelva tarde ya no puede "rebotar" el grid a sitios
  // anteriores. Todo sigue siendo asíncrono, nada bloquea.
  let buttonsEpoch = 0
  const bumpButtonsEpoch = () => {
    buttonsEpoch += 1
  }

  // Recargas WS con debounce + coalescencia: una ráfaga de N broadcasts
  // seguidos (p. ej. 5 button.updated) produce una sola recarga por kind.
  // No cambia el protocolo WS, solo agrupa el trabajo local.
  // En modo túnel todo comparte un único WS ordenado daemon↔relay: el
  // debounce sube a ~1 s para no sumar GETs completos a la cola.
  const reloadDebounceMsForMode = () => reloadDebounceMs(!!getTunnelToken())
  const reloadPending = new Set<'buttons' | 'plugins' | 'profiles' | 'pages'>()
  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  const flushReloads = () => {
    reloadTimer = null
    if (reloadPending.size === 0) return
    // Durante swaps la UI optimista manda: se descarta (como antes).
    if (isSwapping.value) {
      reloadPending.clear()
      return
    }
    const kinds = [...reloadPending]
    reloadPending.clear()
    // loadProfiles ya recarga perfil + páginas + botones + plugins: absorbe
    // al resto de kinds pendientes en esta ventana.
    if (kinds.includes('profiles')) {
      void loadProfiles()
      return
    }
    if (kinds.includes('plugins')) void loadPlugins()
    if (kinds.includes('pages')) void reloadPages()
    if (kinds.includes('buttons') && currentPage.value) void loadButtons()
  }
  const scheduleReload = (kind: 'buttons' | 'plugins' | 'profiles' | 'pages') => {
    if (isSwapping.value) return
    reloadPending.add(kind)
    if (reloadTimer) return
    reloadTimer = setTimeout(flushReloads, reloadDebounceMsForMode())
  }

  /**
   * Cancela una recarga pendiente de un kind: cuando el payload del evento
   * ya se aplicó en local, el GET programado sobra (era lo que hacía
   * refetchear tras cada pulsación/cambio de página por relay).
   */
  const cancelPendingReload = (kind: 'buttons' | 'plugins' | 'profiles' | 'pages') => {
    if (!reloadPending.has(kind)) return
    reloadPending.delete(kind)
    if (reloadPending.size === 0 && reloadTimer) {
      clearTimeout(reloadTimer)
      reloadTimer = null
    }
  }

  /**
   * Aplica `button.created/updated` con el objeto del evento (sin
   * `GET /buttons`). Devuelve true si quedó manejado.
   */
  const applyRemoteButton = (payload: any): boolean => {
    // Durante un swap la UI optimista manda (como hacía el debounce).
    if (isSwapping.value || !currentPage.value) return false
    const { list, handled } = applyButtonPayload(
      currentButtons.value,
      currentPage.value.id,
      payload,
    )
    if (!handled) return false
    currentButtons.value = list
    bumpButtonsEpoch()
    cancelPendingReload('buttons')
    // La selección sigue al botón por ID tras aplicar el remoto.
    if (selectedButtonId.value) {
      const sel = currentButtons.value.find((b) => b.id === selectedButtonId.value)
      selectedButton.value = sel ? sel.position : null
      if (!sel) selectedButtonId.value = null
    }
    return true
  }

  /** Aplica `button.deleted` con el id del evento (sin `GET /buttons`). */
  const applyRemoteButtonDeleted = (payload: any): boolean => {
    if (isSwapping.value || !currentPage.value) return false
    const { list, handled } = applyButtonDeletedPayload(
      currentButtons.value,
      currentPage.value.id,
      payload,
    )
    if (!handled) return false
    currentButtons.value = list
    bumpButtonsEpoch()
    cancelPendingReload('buttons')
    const deletedId =
      (typeof payload?.buttonId === 'string' && payload.buttonId) ||
      (typeof payload?.button?.id === 'string' && payload.button.id) ||
      null
    if (deletedId && selectedButtonId.value === deletedId) {
      selectedButtonId.value = null
      selectedButton.value = null
    }
    return true
  }

  /**
   * Aplica `page.created/updated` con el objeto del evento (sin
   * `GET /pages` completo). Sincroniza la página actual si es ella.
   */
  const applyRemotePage = (payload: any): boolean => {
    if (isSwapping.value) return false
    const { list, handled } = applyPagePayload(currentPages.value, payload)
    if (!handled) return false
    currentPages.value = list
    const page = payload?.page
    if (page && currentPage.value && page.id === currentPage.value.id) {
      currentPage.value = currentPages.value.find((p) => p.id === page.id) ?? currentPage.value
      applyGridForPage(currentPage.value, parseProfileData(currentProfile.value?.data))
    }
    cancelPendingReload('pages')
    return true
  }

  /** Aplica `page.deleted` sin refetchear (salvo que fuera la actual). */
  const applyRemotePageDeleted = (payload: any): boolean => {
    if (isSwapping.value) return false
    const pageId = typeof payload?.pageId === 'string' ? payload.pageId : null
    if (!pageId) return false
    const { list, removed } = applyPageDeletedPayload(currentPages.value, pageId)
    if (!removed) {
      // No la teníamos: nada que refetchear tampoco.
      cancelPendingReload('pages')
      return true
    }
    currentPages.value = list
    if (currentPage.value && currentPage.value.id === pageId) return false
    cancelPendingReload('pages')
    return true
  }

  // Computed properties
  const getButtonData = computed(() => (position: number) => {
    const button = getButton(position)
    // If this is the selected button, always use current config for real-time updates
    if (selectedButton.value === position) {
      // Check for dynamic values even for selected button (any plugin with dynamic actions)
      const dynamicValue = dynamicButtonValues.value.get(position)
      if (dynamicValue && hasDynamicAction(button)) {
        return {
          ...buttonConfig.value,
          dynamicValue: dynamicValue.value !== undefined && dynamicValue.unit ?
            `${dynamicValue.value}${dynamicValue.unit}` :
            (dynamicValue.description || 'N/A'),
        }
      }
      // Sin copia: el objeto reactivo ya actualiza la vista; crear un spread
      // por llamada invalidaba memoizaciones y re-renderizaba el grid.
      return buttonConfig.value
    }
    // Otherwise return saved data or shared empty fallback (no copies unless
    // a dynamic value must be merged in).
    const savedData = button?.data ?? EMPTY_BUTTON_DATA

    // Check for dynamic values (any plugin with dynamic actions)
    const dynamicValue = dynamicButtonValues.value.get(position)
    if (dynamicValue && hasDynamicAction(button)) {
      // For dynamic actions, show dynamic value instead of static label
      return {
        ...savedData,
        dynamicValue: dynamicValue.value !== undefined && dynamicValue.unit ?
          `${dynamicValue.value}${dynamicValue.unit}` :
          (dynamicValue.description || 'N/A'),
        // Keep other properties from saved data
      }
    } return savedData
  })

  const getButtonStyle = computed(() => (position: number) => {
    const data = getButtonData.value(position)
    if (!data) return {}

    return {
      backgroundColor: data.backgroundColor ?? '',
      color: data.textColor || '#e8e9eb'
    }
  })

  // Utility functions
  const saveSelectedProfile = (profileId: string) => {
    localStorage.setItem(STORAGE_KEYS.SELECTED_PROFILE, profileId)
  }

  const getSelectedProfile = (): string | null => {
    return localStorage.getItem(STORAGE_KEYS.SELECTED_PROFILE)
  }

  const apiRequest = async (endpoint: string, options: RequestInit = {}) => {
    // Timeout de seguridad: ningún fetch debe colgarse para siempre
    // (dejaría la UI bloqueada en estados de carga). 30 s es generoso.
    const { signal: callerSignal, ...rest } = options
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((rest.headers as Record<string, string>) ?? {}),
    }
    // Invitado LAN: el navegador ya envía la cookie `ld_lan`, pero el
    // header cubre clientes sin cookies y evita depender de ellas.
    if (!getTunnelToken() && lanSession.value && !headers['Authorization']) {
      headers['Authorization'] = `Bearer ${lanSession.value}`
    }
    // P2P WebRTC primero cuando estamos en túnel y el DataChannel está listo:
    // evita rate-limit del relay y baja latencia. Fallback a fetch si no.
    if (getTunnelToken()) {
      try {
        const rtcRes = await rtcFetchIfConnected(endpoint, { ...rest, headers })
        if (rtcRes) {
          if (!rtcRes.ok) {
            let detail = ''
            try {
              const txt = await rtcRes.text()
              try {
                const j = JSON.parse(txt)
                detail = String((j as any)?.error ?? (j as any)?.code ?? txt)
              } catch { detail = txt }
            } catch {}
            throw new Error(detail || `API Error: ${rtcRes.status}`)
          }
          return rtcRes.json()
        }
      } catch (e) {
        // Si el error viene de rtcFetchIfConnected con Response, ya lanzado arriba.
        // Si es error de transporte, cae al fetch clásico.
        if (e instanceof Error && e.message.startsWith('API Error:')) throw e
      }
    }
    const response = await fetch(`${API_BASE.value}${endpoint}`, {
      ...rest,
      headers,
      // Por el túnel (internet) las respuestas pesadas (plugins/acciones,
      // perfiles) superan 30 s de ida y vuelta relay↔daemon: presupuesto mayor.
      signal: callerSignal ?? AbortSignal.timeout(getTunnelToken() ? 60000 : 30000)
    })

    if (!response.ok) {
      let detail = ''
      try {
        const txt = await response.text()
        try {
          const j = JSON.parse(txt)
          detail = String((j as any)?.error ?? (j as any)?.code ?? txt)
          if ((j as any)?.code === LAN_DENIED_CODE && !getTunnelToken()) lanDenied.value = true
        } catch { detail = txt }
      } catch {}
      if ((response.status === 401 || response.status === 403) && isLanDeniedError(detail, response.status) && !getTunnelToken()) {
        lanDenied.value = true
      }
      if (getTunnelToken()) markTunnelGone(detail, response.status)
      throw new Error(detail || `API Error: ${response.status}`)
    }
    if (getTunnelToken() && tunnelSessionInvalid.value) tunnelSessionInvalid.value = null

    return response.json()
  }

  /**
   * Canjea `?invite=<código>` (QR/enlace) por una sesión LAN y la guarda.
   * El código es de un solo uso: al recargar ya consumido, el daemon
   * responde 401 pero la cookie `ld_lan` fijada mantiene el acceso.
   * Devuelve true si hay sesión utilizable (nueva o previa).
   */
  const redeemLanInviteFromUrl = async (search?: string): Promise<boolean> => {
    if (getTunnelToken()) return true
    // Capturar ANTES de limpiar la URL (el strip conserva relayFallback, pero
    // la lectura explícita deja claro que nunca depende del canje).
    lanRelayFallback.value = parseRelayFallbackFromUrl(search)
    const code = parseLanInviteFromUrl(search)
    if (code && !lanRedeeming.value) {
      lanRedeeming.value = true
      try {
        const res = await fetch(`${API_BASE.value}/remote/lan-redeem`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
          signal: AbortSignal.timeout(30000),
        })
        if (res.ok) {
          const data = await res.json().catch(() => ({}))
          const token = String((data as any)?.sessionToken ?? '')
          if (token) {
            lanSession.value = token
            setStoredLanSession(token)
          }
          lanDenied.value = false
        }
      } catch {
        /* sin sesión nueva: se sigue con la previa/cookie si la hay */
      } finally {
        lanRedeeming.value = false
        try {
          const clean = stripLanInviteFromUrl(window.location.href)
          if (clean !== window.location.href) window.history.replaceState(null, '', clean)
        } catch {
          /* sin history: el código ya no se reusa porque el canje lo consumió */
        }
      }
    }
    if (lanSession.value) return true
    // Sonda ligera: ¿nos deja pasar (cookie válida / localhost)?
    try {
      await apiRequest('/profiles')
      lanDenied.value = false
      return true
    } catch (e) {
      if (isLanDeniedError(e)) {
        lanDenied.value = true
        clearStoredLanSession()
        lanSession.value = null
        return false
      }
      // Otro error (daemon caído): no es denegación, no mostrar "Sin permiso".
      return true
    }
  }

  // WebSocket functions
  const clearHelloTimer = () => {
    if (helloTimer !== null) {
      clearTimeout(helloTimer)
      helloTimer = null
    }
  }
  // Push web → daemon de variables (`variable.set`): las ediciones locales
  // (rejilla del inspector, Ajustes) deben llegar al hardware y a las reglas
  // del daemon. Se registra una vez por instancia (en prod hay una sola).
  const sendVarPush = (message: unknown) => {
    if (!ws || ws.readyState !== 1) throw new Error('WS sin conexión')
    ws.send(JSON.stringify(message))
  }
  setVarPushSender(sendVarPush)
  /**
   * Hidratación inicial desde el daemon (GET /variables?scope=global):
   * al (re)conectar, el daemon es la fuente de la verdad (tipos y valores
   * que la web aún no conoce, p. ej. discordMuted tras pulsar). Sin esto,
   * las condiciones solo convergen con el próximo evento WS.
   */
  const hydrateVarsFromDaemon = async () => {
    try {
      const data = await apiRequest('/variables?scope=global')
      const list = Array.isArray((data as any)?.variables) ? (data as any).variables : []
      if (!list.length) return
      const { upsertRemoteVar } = await import('./useVars')
      for (const item of list) {
        const n = typeof item?.name === 'string' ? item.name : ''
        if (!n) continue
        upsertRemoteVar(n, item?.value, typeof item?.type === 'string' ? item.type : undefined)
      }
    } catch { /* daemon antiguo o caído: se converge por WS */ }
  }
  const sendHello = () => {
    if (!ws || ws.readyState !== 1) return false
    // Sesión propia: el daemon restaura nuestra vista (reconexión) o
    // aplica el startup profile asignado, y responde `session.state`.
    // Invitado LAN: la invitación viaja en `hello` (o ya en el query).
    // Nombre visible: el propuesto por el dueño al aprobar (túnel) o el
    // modelo + navegador ("iPad Safari") en vez del genérico.
    const helloName = tunnelDeviceName.value ?? deviceDefaultName()
    lastHelloName.value = helloName
    ws.send(JSON.stringify({
      type: 'hello',
      payload: {
        deviceId: deviceId.value,
        kind: 'browser',
        name: helloName,
        ...(lanSession.value ? { invite: lanSession.value } : {}),
        // UI remota (túnel): el token viaja en la URL (/t/...). Se
        // reenvía para vincular deviceId ↔ sesión (revocar = ocultar).
        ...(getTunnelToken() ? { sessionToken: getTunnelToken() } : {}),
      }
    }))
    ws.send(JSON.stringify({
      type: 'subscribe',
      payload: { topics: ['profiles', 'buttons', 'actions', 'plugins', 'pages', 'devices', 'remote', 'settings', 'shortcuts', 'logs', 'variables'] }
    }))
    return true
  }
  const scheduleHelloRetry = () => {
    clearHelloTimer()
    helloTimer = setTimeout(() => {
      helloTimer = null
      if (helloAcked || helloAttempts >= 3) return
      if (!ws || ws.readyState !== 1) return
      helloAttempts += 1
      console.warn(`🔁 Reintentando hello (${helloAttempts}/3): sin session.state aún`)
      if (sendHello()) scheduleHelloRetry()
    }, 4000)
  }
  // Nombre propuesto por el dueño al aprobar (solo ruta túnel): el daemon
  // lo guarda en la sesión y este cliente lo adopta como nombre visible.
  // Se pide en cada (re)conexión para converger aunque el dueño lo fije
  // tarde; si difiere del último hello enviado, se reenvía.
  const loadTunnelDeviceName = async () => {
    const token = getTunnelToken()
    if (!token) return
    try {
      const res = await fetch(
        `${tunnelApiBase(token)}/remote/ui-session/device-name?token=${encodeURIComponent(token)}`,
        { signal: AbortSignal.timeout(8000) }
      )
      if (!res.ok) return
      const data = await res.json().catch(() => null)
      const name = typeof data?.deviceName === 'string' && data.deviceName.trim() ? data.deviceName.trim().slice(0, 80) : null
      tunnelDeviceName.value = name
      if (name && ws && ws.readyState === 1 && name !== lastHelloName.value) sendHello()
    } catch { /* sin nombre propuesto: se queda el local */ }
  }
  const connectWebSocket = () => {
    try {
      clearHelloTimer()
      helloAcked = false
      helloAttempts = 0
      // En túnel, el nombre propuesto por el dueño llega en paralelo al
      // hello (y lo corrige con un segundo hello si hace falta).
      void loadTunnelDeviceName()
      ws = new WebSocket(WS_URL.value)

      ws.onopen = () => {
        connectionStatus.value = 'bg-success'
        connectionText.value = 'Conectado'

        console.log('🔌 WebSocket connected, identifying session...', { deviceId: deviceId.value })
        sendHello()
        scheduleHelloRetry()
      }

      ws.onclose = () => {
        clearHelloTimer()
        connectionStatus.value = 'bg-error'
        connectionText.value = 'Desconectado'
        setTimeout(connectWebSocket, 3000)
      }

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          handleWebSocketMessage(message)
        } catch (error) {
          console.error('Invalid WebSocket message:', error)
        }
      }

      // WebRTC P2P: los eventos que lleguen por DataChannel se procesan
      // con el mismo handler que los del WS (fallback intacto).
      try {
        if (getTunnelToken()) {
          const rtc = getRtcSingleton()
          rtc.onEvent((raw: string) => {
            try {
              handleWebSocketMessage(JSON.parse(raw))
            } catch {
              /* noop */
            }
          })
        }
      } catch {
        /* RTC opcional: nunca rompe el WS clásico */
      }
    } catch (error) {
      console.error('Failed to connect WebSocket:', error)
    }
  }

  // Errores de acción → toast de la app (antes se descartaban en silencio).
  // Se difunden por evento de ventana: el shell (BunDeckApp) los muestra y
  // los tests pueden espiarlos sin montar toasts.
  const notifyActionError = (message: string, extra?: Record<string, any>) => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('libredeck:action-error', {
      detail: { message, ...(extra ?? {}) }
    }))
  }

  const handleWebSocketMessage = async (message: any) => {
    switch (message.type) {
      case 'error':
        // Sin invitación el daemon deniega con LAN_INVITE_REQUIRED.
        if (message?.payload?.code === LAN_DENIED_CODE && !getTunnelToken()) {
          lanDenied.value = true
        }
        break
      case 'connected':
        console.log('🔗 WebSocket connected:', message.payload)
        if (message.payload?.clientId) clientId.value = message.payload.clientId
        if (message.payload?.lanAuthRequired && !getTunnelToken()) {
          // El socket queda en cuarentena hasta un `hello` con invitación.
          console.warn('🔒 WS en cuarentena: falta invitación LAN (?invite= del QR)')
        }
        break
      case 'session.state':
        console.log('🪪 Session state:', message.payload)
        // El `hello` llegó (carrera del túnel superada): no más reintentos.
        // Refrescar dispositivos: al (re)conectar puede haber presencia nueva.
        helloAcked = true
        clearHelloTimer()
        // Fuente de la verdad de variables: hidrata tipos+valores del daemon
        // (p. ej. discordMuted ya a true antes de abrir la página).
        void hydrateVarsFromDaemon()
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('libredeck:devices-changed'))
        }
        if (message.payload?.clientId) clientId.value = message.payload.clientId
        if (message.payload?.deviceId) deviceId.value = message.payload.deviceId
        if (message.payload?.lanSessionToken && typeof message.payload.lanSessionToken === 'string') {
          lanSession.value = message.payload.lanSessionToken
          setStoredLanSession(message.payload.lanSessionToken)
        }
        if (message.payload?.lanAuthed) lanDenied.value = false
        if ('startupProfileId' in (message.payload ?? {})) {
          sessionStartupProfileId.value = message.payload.startupProfileId
        }
        break
      case 'subscribed':
        console.log('✅ WebSocket subscribed to topics:', message.payload)
        break
      case 'profile.updated':
      case 'profile.created':
      case 'profile.deleted':
        scheduleReload('profiles')
        break
      case 'page.updated':
      case 'page.created':
        // El evento ya trae la página: se aplica en local sin
        // `GET /pages` (por relay, cada refetch suma a la cola del túnel).
        if (!applyRemotePage(message.payload)) scheduleReload('pages')
        break
      case 'page.deleted':
        // Sin refetch salvo que fuera la actual (reloadPages la reubica).
        if (!applyRemotePageDeleted(message.payload)) scheduleReload('pages')
        break
      case 'button.created':
        if (isOwnEcho(message.payload)) break
        // El evento ya trae el botón: se aplica en local sin
        // `GET /buttons` (pulsar por relay no debe refetchear).
        if (currentPage.value && !applyRemoteButton(message.payload)) {
          scheduleReload('buttons')
        }
        break
      case 'button.updated':
        if (isOwnEcho(message.payload)) break
        if (currentPage.value && !applyRemoteButton(message.payload)) {
          scheduleReload('buttons')
        }
        break
      case 'buttons.reordered': {
        // Reordenado atómico: si es el eco de nuestro propio swap (mutationId
        // pendiente) se ignora — el estado local optimista ya está al día y
        // recargar aquí es lo que hacía "rebotar" la tecla a su sitio viejo.
        // Si viene de otro cliente, se aplica la lista del evento (sin GET).
        if (isOwnEcho(message.payload)) break
        const reorderedPageId = (message.payload as any)?.pageId
        if (currentPage.value && !isSwapping.value && reorderedPageId === currentPage.value.id) {
          const { list, handled } = applyButtonsReordered(
            currentButtons.value,
            currentPage.value.id,
            message.payload,
          )
          if (handled) {
            currentButtons.value = list
            bumpButtonsEpoch()
            cancelPendingReload('buttons')
            break
          }
          scheduleReload('buttons')
        }
        break
      }
      case 'button.deleted':
        if (isOwnEcho(message.payload)) break
        if (currentPage.value && !applyRemoteButtonDeleted(message.payload)) {
          scheduleReload('buttons')
        }
        break
      case 'page.navigate':
        // Dirigida: solo aplica si es para este dispositivo; los broadcasts
        // antiguos (sin destino) aplican a todos (compat).
        if (!isNavigationForMe(message.payload, deviceId.value, clientId.value)) {
          console.log('🧭 Page navigation ignored (for another device):', message.payload)
          break
        }
        console.log('🧭 Page navigation requested:', message.payload)
        console.log('📥 Received page.navigate, calling selectPage with isRemotePageChange = true')
        isRemotePageChange.value = true
        try {
          if (message.payload.pageId) {
            // La asignación puede venir de otro perfil o de una página recién
            // creada que aún no está en currentPages (carrera page.created vs
            // page.navigate): cambiar de perfil y recargar antes de seleccionar.
            const wantProfile = typeof message.payload.profileId === 'string' ? message.payload.profileId : null
            if (wantProfile && wantProfile !== selectedProfile.value) {
              selectedProfile.value = wantProfile
              await loadProfile()
            }
            if (!currentPages.value.some((p) => p.id === message.payload.pageId)) {
              await reloadPages()
            }
            if (currentPages.value.some((p) => p.id === message.payload.pageId)) {
              await selectPage(message.payload.pageId)
            } else {
              console.warn('🧭 Page navigation: página desconocida tras recargar:', message.payload.pageId)
            }
            // Solo los broadcasts antiguos (sin destino) tocan el global
            // `current.*` que lee el HW físico: una navegación DIRIGIDA
            // (reparto de pantallas) nunca debe mover al anfitrión. El
            // daemon ya mantiene esa invariante en su lado; aquí no se
            // deshace con un POST directo.
            if (isBroadcastNav(message.payload)) {
              try {
                await apiRequest('/settings', {
                  method: 'POST',
                  body: JSON.stringify({
                    key: 'current.page_id',
                    value: message.payload.pageId
                  })
                })
                console.log('✅ Remote page change saved to database settings:', message.payload.pageId)
              } catch (error) {
                console.error('❌ Failed to save remote page change to database settings:', error)
              }
            }
            // OJO: no se empuja la vista al HW. El Stream Deck físico sigue su
            // propia sesión/asignación; solo cambia por acción o por el botón
            // "dispositivos". (selectPage tampoco repinta el HW.)
          }
          console.log('✅ Page navigation completed')
        } catch (error) {
          console.error('❌ Error during page navigation:', error)
        } finally {
          isRemotePageChange.value = false
        }
        break
      case 'profile.navigate':
        if (!isNavigationForMe(message.payload, deviceId.value, clientId.value)) {
          console.log('👤 Profile navigation ignored (for another device):', message.payload)
          break
        }
        console.log('👤 Profile navigation requested:', message.payload)
        isRemoteProfileChange.value = true
        if (message.payload.profileId) {
          selectedProfile.value = message.payload.profileId
          await loadProfile()
          // El daemon adjunta la primera página del perfil: abrirla si no es
          // la actual (loadProfile puede haber elegido la asignada/global).
          try {
            const wantPage = typeof message.payload.pageId === 'string' ? message.payload.pageId : null
            if (wantPage && wantPage !== currentPage.value?.id && currentPages.value.some((p) => p.id === wantPage)) {
              await selectPage(wantPage)
            }
          } catch { /* mejor esfuerzo: ya se cargó el perfil */ }
          // Como en page.navigate: solo el broadcast mueve el global.
          if (isBroadcastNav(message.payload)) {
            try {
              await apiRequest('/settings', {
                method: 'POST',
                body: JSON.stringify({
                  key: 'current.profile_id',
                  value: message.payload.profileId
                })
              })
              console.log('✅ Remote profile change saved to database settings:', message.payload.profileId)
            } catch (error) {
              console.error('❌ Failed to save remote profile change to database settings:', error)
            }
          }
        }
        isRemoteProfileChange.value = false
        break
      case 'action.finished':
        // Remove executing state after action completes
        break
      case 'action.error': {
        // Error de ejecución (daemon): toast visible (antes se descartaba).
        const p = (message.payload ?? {}) as any
        const err = p?.error
        const msg = typeof err === 'string' && err
          ? err
          : (err && typeof err.message === 'string' ? err.message : JSON.stringify(err ?? p))
        notifyActionError(`Error al ejecutar la acción: ${msg}`, { actionId: p?.actionId ?? null, error: err ?? null })
        break
      }
      case 'log.created': {
        // Actividad en vivo para el menú Registros (DiagnosticsPane escucha).
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('libredeck:log-created', { detail: message.payload }))
        }
        break
      }
      case 'variable.changed':
      case 'variable.deleted': {
        // Valores en vivo del daemon (las acciones publican su estado tras
        // ejecutar): se funden en el store local sin recargar la página.
        // El payload trae `type` (text|numeric|bool|color): sin él, un bool
        // llegaría como texto y `var == true` no matchearía nunca.
        try {
          const { upsertRemoteVar, removeVar, daemonTypeToLocal } = await import('./useVars')
          const p = (message.payload ?? {}) as any
          const name = String(p?.name ?? '')
          if (message.type === 'variable.deleted') {
            if (name) removeVar(name)
          } else if (name) {
            const mapped = daemonTypeToLocal(p?.type)
            upsertRemoteVar(name, p?.value, mapped)
          }
        } catch {
          /* best-effort */
        }
        break
      }
      case 'update.completed':
        console.log('🔄 Update completed:', message.payload);
        // Emit custom event for update completion
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('update-completed', {
            detail: message.payload
          }));
        }
        break
      case 'plugin.install-progress':
        installProgress.value = {
          key: String(message.payload?.key ?? ''),
          stage: String(message.payload?.stage ?? ''),
          message: String(message.payload?.message ?? '')
        }
        // Limpia el cartel unos segundos después de terminar (el error se queda hasta descartarlo)
        if (installProgressTimer) clearTimeout(installProgressTimer)
        if (['done'].includes(installProgress.value.stage)) {
          installProgressTimer = setTimeout(() => { installProgress.value = null }, 6000)
        }
        break
      case 'plugin.status': {
        // Red de seguridad: si el daemon emite error/éxito sin
        // install-progress (p. ej. enable fallido), reflejarlo en el cartel
        // para no quedarse colgado en "Arrancando…".
        const pid = String(message.payload?.pluginId ?? '')
        const st = String(message.payload?.status ?? '')
        if (pid && installProgress.value && installProgress.value.key === pid && !['done', 'error'].includes(installProgress.value.stage)) {
          if (st === 'error' || st === 'elgato-stopped') {
            installProgress.value = {
              key: pid,
              stage: 'error',
              message: String(message.payload?.error ?? message.payload?.status ?? 'Error al arrancar')
            }
          } else if (st === 'active') {
            installProgress.value = { key: pid, stage: 'done', message: 'Plugin activo' }
            if (installProgressTimer) clearTimeout(installProgressTimer)
            installProgressTimer = setTimeout(() => { installProgress.value = null }, 6000)
          }
        }
        // Con debounce como el resto de eventos de plugins (una ráfaga de
        // status seguidos producía N recargas completas en serie).
        scheduleReload('plugins')
        break
      }
      case 'plugin.installed':
      case 'plugin.uninstalled':
      case 'plugin.enabled':
      case 'plugin.settings':
        // Algo cambió en los plugins: recarga listas y acciones (con debounce).
        scheduleReload('plugins')
        break
      case 'device.created':
      case 'device.updated':
      case 'device.deleted':
      case 'device.online':
      case 'device.offline':
      case 'assignment.updated':
        // Dispositivos/asignaciones: otro cliente cambió algo → recargar
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('libredeck:devices-changed'))
        }
        break
      case 'page.blocked': {
        // El HW físico rechazó una navegación incompatible: avisar
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('libredeck:page-blocked', { detail: message.payload }))
        }
        break
      }
      case 'settings.changed': {
        // Apariencia compartida host ↔ remotos (ver useBunDeckUi):
        // otro cliente cambió el tema → aplicarlo en vivo.
        try {
          if ((message.payload as any)?.key === 'ui.appearance') {
            const { applyRemoteAppearance } = await import('./useBunDeckUi')
            applyRemoteAppearance((message.payload as any)?.value)
          }
        } catch {
          /* best-effort */
        }
        break
      }
      case 'shortcut.triggered': {
        // Atajo disparado en el daemon (launcher global u otro cliente):
        // las acciones de servidor ya las aplicó el daemon; aquí solo se
        // reenvían a la UI local (paneles/kiosco). El consumidor (Ajustes)
        // ignora ecos con executionId ya visto.
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('bundeck:shortcut', { detail: message.payload }))
        }
        break
      }
    }
  }

  // Data loading functions
  const loadProfiles = async () => {
    // Load config first
    await loadConfig();

    // Las acciones no dependen del perfil/página: se cargan en segundo plano
    // desde ya (antes eran el ÚLTIMO paso serie de la cascada). Con dedupe
    // interno no hay doble fetch aunque otro camino las pida a la vez.
    const pluginsPromise = loadPlugins().catch((e) => {
      console.error('Background plugins load failed:', e)
    })

    try {
      // Perfiles y perfil guardado son independientes: en paralelo.
      const [profilesRes, profileSettingRes] = await Promise.all([
        apiRequest('/profiles'),
        apiRequest('/settings?key=current.profile_id').catch((error) => {
          console.log('⚠️ Could not load profile from database settings:', error)
          return null
        }),
      ])
      profiles.value = profilesRes

      // Check if we have at least one profile
      if (profiles.value.length === 0) {
        console.error('No profiles found in database. Please run setup first.')
        return
      }

      // Ensure there's always a default profile
      const hasDefaultProfile = profiles.value.some(p => {
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

      if (!hasDefaultProfile && profiles.value.length > 0) {
        // Mark the first profile as default
        const firstProfile = profiles.value[0]
        let data = firstProfile.data
        if (typeof data === 'string') {
          try {
            data = JSON.parse(data)
          } catch {
            data = {}
          }
        }
        // Anti-corrupción (incidente 118 MB): si tras parsear sigue sin ser
        // un objeto plano (p. ej. string doblemente codificado), el spread
        // `{...data}` crearía claves numéricas y el payload explotaría.
        // En ese caso se parte de {} y se preserva isDefault.
        if (!data || typeof data !== 'object' || Array.isArray(data)) data = {}
        const updatedData = { ...data, isDefault: true }

        await apiRequest(`/profiles/${firstProfile.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: firstProfile.name,
            data: updatedData
          })
        })

        // Update local data
        firstProfile.data = updatedData
        console.log('Marked first profile as default:', firstProfile.id)
      }

      // Try to restore saved profile first from database settings, then localStorage
      let savedProfileId = profileSettingRes?.value ?? null;
      if (savedProfileId) {
        console.log('📂 Loaded profile from database settings:', savedProfileId);

        // Handle the case where "null" was saved as a string
        if (savedProfileId === 'null' || savedProfileId === null || savedProfileId === '') {
          savedProfileId = null;
          console.log('⚠️ Invalid profile_id found in settings, ignoring...');
        }
      } else {
        console.log('⚠️ Could not load profile from database settings, trying localStorage...');
        savedProfileId = getSelectedProfile();
        console.log('📂 Loaded profile from localStorage:', savedProfileId);
      }

      if (savedProfileId && profiles.value.find(p => p.id === savedProfileId)) {
        selectedProfile.value = savedProfileId
      } else if (profiles.value.length > 0) {
        // Fallback to first profile if no saved profile or saved profile doesn't exist
        selectedProfile.value = profiles.value[0].id
        saveSelectedProfile(profiles.value[0].id)
      }

      // Load the selected profile
      if (selectedProfile.value) {
        await loadProfile()

        // OJO: al arrancar NO se empuja la página del editor al HW. El driver
        // restaura su propia sesión (device_sessions) al conectar; el HW solo
        // cambia por acción o por el botón "dispositivos".
        console.log('🔌 Profile loaded (sin empujar vista al StreamDeck).')
      }
    } catch (error) {
      console.error('Failed to load profiles:', error)
    }

    // Las acciones ya vienen en vuelo desde el inicio; aquí solo se espera
    // su fin (no bloqueó el perfil/página/botones, que ya están visibles).
    await pluginsPromise
  }

  // El tamaño de grid es POR PÁGINA (`pages.grid_cols/grid_rows`; NULL =
  // hereda del perfil). El perfil solo aporta el default. Centraliza la
  // regla en resolvePageSize (espejo del daemon), igual que StageBoard.
  const parseProfileData = (d: any): Record<string, any> => {
    let cur: any = d
    if (typeof cur === 'string') {
      try {
        cur = JSON.parse(cur)
      } catch {
        return {}
      }
    }
    return cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}
  }
  const applyGridForPage = (page: any, profileData: any) => {
    const size = resolvePageSize(
      { grid_cols: page?.grid_cols ?? null, grid_rows: page?.grid_rows ?? null },
      profileData
    )
    gridCols.value = size.cols
    gridRows.value = size.rows
  }

  const loadProfile = async () => {
    if (!selectedProfile.value) {
      stopDynamicUpdates()
      currentProfile.value = null
      currentPage.value = null
      currentButtons.value = []
      selectedButton.value = null
      selectedButtonId.value = null
      return
    }

    // Save selected profile to localStorage
    saveSelectedProfile(selectedProfile.value)

    try {
      // Perfil, lista de páginas, página guardada y asignaciones son independientes: en paralelo.
      const [profile, pages, pageSettingRes, assignRes] = await Promise.all([
        apiRequest(`/profiles/${selectedProfile.value}`),
        apiRequest(`/pages?profileId=${selectedProfile.value}`),
        apiRequest('/settings?key=current.page_id').catch(() => null),
        apiRequest(`/profiles/${selectedProfile.value}/assignments`).catch(() => null),
      ])
      currentProfile.value = profile

      console.log('📂 Loaded profile:', currentProfile.value)
      console.log('📦 Profile data (raw):', currentProfile.value.data)

      // Parse data if it's a string
      let profileData = currentProfile.value.data
      if (typeof profileData === 'string') {
        try {
          profileData = JSON.parse(profileData)
          console.log('📦 Profile data (parsed):', profileData)
        } catch (e) {
          console.error('Failed to parse profile data:', e)
          profileData = {}
        }
      }

      // Restore grid size: la página manda (grid_cols/grid_rows propios);
      // el perfil solo es el default heredado (NULL = heredar).
      if (profileData?.gridCols) {
        gridCols.value = profileData.gridCols
        console.log('📐 Restored gridCols from profile:', gridCols.value)
      } else {
        console.log('⚠️ No gridCols found in profile data, using default:', gridCols.value)
      }

      if (profileData?.gridRows) {
        gridRows.value = profileData.gridRows
        console.log('📐 Restored gridRows from profile:', gridRows.value)
      } else {
        console.log('⚠️ No gridRows found in profile data, using default:', gridRows.value)
      }

      currentPages.value = pages

      // Try to load saved page from database settings, fallback to first non-folder page
      let targetPage = null;
      {
        // La pantalla asignada a este dispositivo manda sobre la global:
        // al abrir (kiosco incluido) cada pantalla muestra SU página.
        const mine = (assignRes as any)?.assignments?.[deviceId.value];
        if (mine) {
          const ap = pages.find(p => p.id === mine);
          if (ap) {
            targetPage = ap;
            console.log('📄 Loaded assigned page for this device:', mine);
          }
        }
      }
      if (!targetPage) {
        const savedPageId = (pageSettingRes as any)?.value;

        // Handle the case where invalid values were saved
        if (savedPageId && savedPageId !== 'null' && savedPageId !== null && savedPageId !== '') {
          targetPage = pages.find(p => p.id === savedPageId && p.is_folder === 0);
          console.log('📄 Loaded saved page from database settings:', savedPageId, targetPage ? 'found' : 'not found');
        } else {
          console.log('⚠️ Invalid or missing page_id in settings');
        }
      }

      // If no saved page or saved page not found, use first non-folder page
      if (!targetPage) {
        targetPage = pages.find(p => p.is_folder === 0) || pages[0];
        console.log('📄 Using fallback page:', targetPage?.name);
      }

      if (targetPage) {
        currentPage.value = targetPage
        applyGridForPage(targetPage, profileData)
        await loadButtons()

        // Start dynamic updates for PC Vitals buttons
        await startDynamicUpdates()
      } else {
        // Create default page (tamaño propio en columnas, no en data)
        currentPage.value = await apiRequest('/pages', {
          method: 'POST',
          body: JSON.stringify({
            profile_id: selectedProfile.value,
            name: 'Página Principal',
            order_idx: 0,
            is_folder: 0,
            grid_cols: gridCols.value,
            grid_rows: gridRows.value,
            data: {}
          })
        })
        currentPages.value = [currentPage.value]
        currentButtons.value = []
      }
    } catch (error) {
      console.error('Failed to load profile:', error)
    }
  }

  const loadPlugins = async () => {
    // Dedupe de cargas concurrentes: loadProfiles la lanza en segundo plano
    // y startDynamicUpdates la pide si el índice sigue vacío; sin esto habría
    // dos GET /plugins/actions + /plugins en vuelo a la vez.
    if (pluginsInFlight) {
      await pluginsInFlight
      return
    }
    pluginsInFlight = (async () => {
      try {
        pluginsLoading.value = true
        const pluginData = await apiRequest('/plugins/actions')
        plugins.value = pluginData
        console.log('🔌 Loaded plugins:', plugins.value)
        try {
          const mgr = await apiRequest('/plugins')
          pluginsDetailed.value = mgr.detailed ?? []
        } catch (e) {
          console.warn('Plugin manager detail unavailable:', e)
        }
      } catch (error) {
        console.error('Failed to load plugins:', error)
      } finally {
        pluginsLoading.value = false
      }
    })()
    try {
      await pluginsInFlight
    } finally {
      pluginsInFlight = null
    }
  }

  /** Activa/desactiva un plugin (el estado gobierna la carga en el daemon). */
  const setPluginEnabled = async (pluginId: string, enabled: boolean) => {
    await apiRequest(`/plugins/${encodeURIComponent(pluginId)}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled })
    })
    await loadPlugins()
  }

  const removePlugin = async (pluginId: string) => {
    await apiRequest(`/plugins/${encodeURIComponent(pluginId)}`, { method: 'DELETE' })
    await loadPlugins()
  }

  const reloadPlugin = async (pluginId: string) => {
    await apiRequest(`/plugins/${encodeURIComponent(pluginId)}/reload`, { method: 'POST' })
    await loadPlugins()
  }

  const rollbackPlugin = async (pluginId: string) => {
    await apiRequest(`/plugins/${encodeURIComponent(pluginId)}/rollback`, { method: 'POST' })
    await loadPlugins()
  }

  const updatePlugin = async (pluginId: string, source: any = {}) => {
    await apiRequest(`/plugins/${encodeURIComponent(pluginId)}/update`, {
      method: 'POST',
      body: JSON.stringify(source)
    })
    await loadPlugins()
  }

  const uploadPluginFile = async (file: File, force = false) => {
    const form = new FormData()
    form.append('file', file)
    if (force) form.append('force', 'true')
    const res = await fetch(`${API_BASE.value}/plugins/upload`, { method: 'POST', body: form })
    if (!res.ok) {
      const txt = await res.text()
      throw new Error(txt || `Upload failed: ${res.status}`)
    }
    await loadPlugins()
    return res.json()
  }

  const installPluginFromUrl = async (url: string, opts: any = {}) => {
    const res = await apiRequest('/plugins/install', {
      method: 'POST',
      body: JSON.stringify({ url, ...opts })
    })
    await loadPlugins()
    return res
  }

  const loadMarketplace = async () => {
    try {
      const data = await apiRequest('/marketplace')
      marketplace.value = data.plugins ?? []
      marketplaceRegistry.value = data.registryUrl ?? null
    } catch (e) {
      console.error('Failed to load marketplace:', e)
      marketplace.value = []
    }
  }

  // ---- Servidor MCP (el daemon ES el servidor): tokens de acceso ----
  const mcpTokens = ref<any[]>([])
  const mcpScopes = ref<Array<{ id: string; group: string }>>([])
  const loadMcpTokens = async () => {
    try {
      const data = await apiRequest('/mcp/tokens')
      mcpTokens.value = data.tokens ?? []
    } catch (e) {
      console.error('Failed to load MCP tokens:', e)
      mcpTokens.value = []
    }
  }
  const loadMcpScopes = async () => {
    try {
      const data = await apiRequest('/mcp/scopes')
      mcpScopes.value = data.scopes ?? []
    } catch (e) {
      console.error('Failed to load MCP scopes:', e)
      mcpScopes.value = []
    }
  }
  /** Crea un token; devuelve { token, secret }. El secreto solo se muestra una vez. */
  const createMcpToken = async (name: string, scopes?: string[]) => {
    const data = await apiRequest('/mcp/tokens', {
      method: 'POST',
      body: JSON.stringify({ name, ...(scopes !== undefined ? { scopes } : {}) })
    })
    await loadMcpTokens()
    return data as { token: any; secret: string }
  }
  /** Edita nombre y/o scopes de un token. */
  const updateMcpToken = async (id: string, patch: { name?: string; scopes?: string[] }) => {
    const data = await apiRequest(`/mcp/tokens/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch)
    })
    await loadMcpTokens()
    return data
  }
  const revokeMcpToken = async (id: string) => {
    await apiRequest(`/mcp/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await loadMcpTokens()
  }

  const loadButtons = async (opts?: { force?: boolean }) => {
    if (!currentPage.value) {
      console.log('⚠️ No current page selected, cannot load buttons')
      return
    }

    const pageId = currentPage.value.id
    const epoch = buttonsEpoch
    try {
      const buttons = await apiRequest(`/buttons?pageId=${pageId}`)
      if (!opts?.force && epoch !== buttonsEpoch) {
        // Respuesta stale: mientras volaba hubo mutaciones optimistas locales
        // más nuevas. Aplicarla rebotaría el grid → se descarta (no bloquea).
        console.log('🔄 Discarding stale buttons response (local optimistic state is newer)')
        return
      }
      // La página pudo cambiar mientras volaba la petición
      if (!currentPage.value || currentPage.value.id !== pageId) {
        console.log('🔄 Discarding buttons response (page changed meanwhile)')
        return
      }
      currentButtons.value = buttons
      console.log(`🔘 Loaded ${buttons.length} buttons for page ${currentPage.value.name}`)
      // La selección sigue al botón por ID tras recargar
      if (selectedButtonId.value) {
        const sel = currentButtons.value.find((b) => b.id === selectedButtonId.value)
        selectedButton.value = sel ? sel.position : null
        if (!sel) selectedButtonId.value = null
      }
    } catch (error) {
      console.error('Failed to load buttons:', error)
      currentButtons.value = []
    }
  }

  // Recarga la lista de páginas del perfil (para eventos WS con debounce).
  // Si la página actual desapareció (borrada en otro cliente), reubica a
  // otra página como hacía el handler inline de page.deleted.
  const reloadPages = async () => {
    if (!selectedProfile.value) return
    try {
      const pages = await apiRequest(`/pages?profileId=${selectedProfile.value}`)
      currentPages.value = pages
      // La página actual pudo cambiar de tamaño en otro cliente: refresca
      // su fila y el grid (selectPage ya aplica el tamaño al reubicar).
      if (currentPage.value) {
        const fresh = pages.find((p: PageData) => p.id === currentPage.value?.id)
        if (fresh) {
          currentPage.value = fresh
          applyGridForPage(fresh, parseProfileData(currentProfile.value?.data))
        }
      }
      if (currentPage.value && !pages.find((p: PageData) => p.id === currentPage.value?.id)) {
        const remainingPages = pages.filter((p: PageData) => p.is_folder === 0)
        if (remainingPages.length > 0) {
          await selectPage(remainingPages[0].id)
        } else {
          currentPage.value = null
          currentButtons.value = []
          selectedButton.value = null
          selectedButtonId.value = null
        }
      }
    } catch (error) {
      console.error('Failed to reload pages:', error)
    }
  }

  // Button management functions
  // La vista consulta varias propiedades por tecla en cada render. Indexar una
  // vez evita recorrer el array de botones desde cada helper del tablero.
  const buttonsByPosition = computed(() => {
    const index = new Map<number, ButtonEntity>()
    for (const button of currentButtons.value) index.set(button.position, button)
    return index
  })
  const getButton = (position: number): ButtonEntity | undefined =>
    buttonsByPosition.value.get(position)

  // Índice de TODAS las acciones por tipo completo `${pluginId}.${actionId}`.
  // Se reconstruye solo cuando plugins.value cambia (computed), no en cada
  // tick/selección/render. Las consultas dinámicas son O(1).
  const actionTypeIndex = computed(() => {
    const index = new Map<string, { pluginId: string; dynamic: boolean }>()
    for (const plugin of plugins.value) {
      const [pid, pluginData] = plugin as [string, any]
      const actions = pluginData?.actions
      if (!Array.isArray(actions)) continue
      for (const entry of actions) {
        const actionId = entry?.[0]
        if (typeof actionId !== 'string') continue
        const actionData = entry?.[1]
        const hasControlSurface = actionData?.surface === 'control' &&
          typeof actionData?.component === 'string' &&
          (CONTROL_COMPONENTS as readonly string[]).includes(actionData.component)
        index.set(`${pid}.${actionId}`, {
          pluginId: pid,
          // A custom control owns its refresh lifecycle; the generic dynamic
          // poller must not race its component against the same action.
          dynamic: actionData?.dynamic === true && !hasControlSurface
        })
      }
    }
    return index
  })

  // ¿Es dinámico este objeto de acción? O(1) vía índice.
  const isDynamicActionType = (action: any): boolean => {
    if (!action || typeof action.type !== 'string') return false
    const type: string = action.type
    if (type.includes('.')) return actionTypeIndex.value.get(type)?.dynamic === true
    // Tipo simple sin prefijo: resuelve con pluginId explícito si lo hay.
    if (action.pluginId && typeof action.pluginId === 'string') {
      return actionTypeIndex.value.get(`${action.pluginId}.${type}`)?.dynamic === true
    }
    // Sin pluginId ni prefijo (legacy): barrido solo sobre el índice, no
    // sobre plugins×acciones. El índice dinámico es pequeño.
    for (const [full, meta] of actionTypeIndex.value) {
      if (meta.dynamic && full.endsWith(`.${type}`)) return true
    }
    return false
  }

  // ¿Pertenece este botón al borrador en edición? Solo entonces el draft
  // (buttonConfig) cuenta para él. Antes el draft contaminaba a TODOS los
  // botones (bastaba con tener algo seleccionado).
  const isSelectedButton = (button: ButtonEntity | null | undefined): boolean =>
    !!button && (button.position === selectedButton.value ||
      (!!selectedButtonId.value && button.id === selectedButtonId.value))

  const selectButton = async (position: number) => {
    // Stop dynamic updates for previously selected button if it doesn't have saved dynamic action
    if (selectedButton.value !== null && selectedButton.value !== position) {
      const prevButton = getButton(selectedButton.value)
      if (prevButton && !hasDynamicAction(prevButton)) {
        stopDynamicUpdateForButton(selectedButton.value)
      }
    }

    // Save current button before switching (solo si el usuario editó el
    // draft desde la última selección/guardado; comparar contra la fila de
    // BD era inválido porque el draft está normalizado y la BD no).
    if (selectedButton.value !== null && selectedButton.value !== position) {
      const currentButton = getButton(selectedButton.value)
      if (currentButton) {
        if (isButtonConfigDirty()) {
          await saveButtonConfig()
        }
      } else {
        // For new buttons, only save if there's actual content
        const hasContent = buttonConfig.value.label?.trim() || buttonConfig.value.textTop?.trim() ||
          buttonConfig.value.textBottom?.trim() || buttonConfig.value.emoji?.trim() ||
          buttonConfig.value.icon?.trim() ||
          buttonConfig.value.iconImage?.trim() || (buttonConfig.value.actions?.length ?? 0) > 0 ||
          pressExtraCount(buttonConfig.value) > 0 ||
          (buttonConfig.value.rules?.length ?? 0) > 0 || (buttonConfig.value.looks?.length ?? 0) > 0
        if (hasContent) {
          await saveButtonConfig()
        }
      }
    }

    const button = getButton(position)
    selectedButton.value = position
    selectedButtonId.value = button?.id ?? null
    if (button) {
      let buttonData = {
        label: button.data?.label || '',
        textTop: button.data?.textTop || '',
        textBottom: button.data?.textBottom || '',
        fontSize: button.data?.fontSize || 14,
        icon: button.data?.icon || '',
        iconImage: typeof button.data?.iconImage === 'string' ? button.data.iconImage : '',
        emoji: button.data?.emoji || '',
        backgroundColor: typeof button.data?.backgroundColor === 'string' ? button.data.backgroundColor : '',
        textColor: button.data?.textColor || '#e8e9eb',
        showTitle: button.data?.showTitle !== false,
        mode: button.data?.mode || 'seq',
        longPress: button.data?.longPress || 'none',
        confirm: !!button.data?.confirm,
        actions: button.data?.actions ? JSON.parse(JSON.stringify(button.data.actions)) : [],
        rules: button.data?.rules ? JSON.parse(JSON.stringify(button.data.rules)) : [],
        looks: button.data?.looks ? JSON.parse(JSON.stringify(button.data.looks)) : [],
        stateVar: typeof button.data?.stateVar === 'string' ? button.data.stateVar : '',
        pressActions: button.data?.pressActions ? JSON.parse(JSON.stringify(button.data.pressActions)) : undefined
      }

      // Fix legacy PC Vitals actions that have pluginId: null
      if (buttonData.actions) {
        buttonData.actions = buttonData.actions.map((action: any) => {
          if (action.type === 'pc-vitals.monitor' && action.pluginId === null) {
            console.log('🔧 Fixing legacy PC Vitals action, setting pluginId to pc-vitals')
            return { ...action, pluginId: 'pc-vitals' }
          }
          return action
        })
      }

      buttonConfig.value = ensurePressMirror(buttonData)
    } else {
      buttonConfig.value = ensurePressMirror({
        label: '',
        textTop: '',
        textBottom: '',
        fontSize: 14,
        icon: '',
        iconImage: '',
        emoji: '',
        backgroundColor: '',
        textColor: '#e8e9eb',
        showTitle: true,
        mode: 'seq',
        longPress: 'none',
        confirm: false,
        actions: [],
        rules: [],
        looks: [],
        stateVar: ''
      })
    }
    // El draft recién cargado es el punto limpio: no hay cambios pendientes.
    snapshotButtonConfig()

    // Restart dynamic updates to include/exclude the newly selected button.
    // Sin bloquear: la selección debe ser instantánea aunque haya botones
    // dinámicos (cada uno dispara un /actions/execute). Todo asíncrono.
    void startDynamicUpdates()

    // NOTA: no repintar el HW aquí. Seleccionar una tecla no cambia su
    // contenido (el daemon ya repinta tras cada PUT/DELETE/reorder). Hacer
    // un repintado completo (15-32 teclas con render+USB) en cada clic era
    // lo que dejaba el StreamDeck "eterno" al moverse por el grid.
  }

  const executeButton = async (position: number) => {
    const button = getButton(position)
    if (!button?.data?.actions?.length) return

    executingButtons.value.push(position)

    // Un solo round-trip por botón (`POST /actions/execute-many`): por el
    // túnel cada `POST /actions/execute` en serie sumaba su ida y vuelta a
    // la cola ordenada del relay (trompicones). El daemon ejecuta en orden.
    const baseContext = {
      buttonId: button.id,
      pageId: button.page_id,
      profileId: currentProfile.value?.id,
      position,
      // Origen de la acción: la navegación que provoque (page.action)
      // por defecto solo se aplica en este dispositivo.
      deviceId: deviceId.value
    }
    try {
      const actions = button.data.actions
      if (actions.length === 1) {
        const res = await apiRequest('/actions/execute', {
          method: 'POST',
          body: JSON.stringify({ action: actions[0], context: baseContext })
        }) as any
        // El daemon responde 200 con success:false en fallos de acción
        // (no lanza): hay que mirar el cuerpo para avisar.
        if (res && res.success === false) {
          notifyActionError(`Error al ejecutar la acción: ${res.error ?? 'error desconocido'}`, { error: res.error ?? null })
        }
      } else {
        try {
          const res = await apiRequest(
            '/actions/execute-many',
            {
              method: 'POST',
              body: JSON.stringify(
                buildExecuteManyBody(actions.map((action: any) => ({ action, context: baseContext })))
              )
            }
          ) as any
          const failed = (res?.results ?? []).find((r: any) => r && r.success === false)
          if (failed) {
            notifyActionError(`Error al ejecutar la acción: ${failed.error ?? 'error desconocido'}`, { error: failed.error ?? null })
          }
        } catch (batchError) {
          // Compat con daemons sin batch: serie clásica.
          if (!isBatchUnsupported(batchError)) throw batchError
          for (const action of actions) {
            const res = await apiRequest('/actions/execute', {
              method: 'POST',
              body: JSON.stringify({ action, context: baseContext })
            }) as any
            if (res && res.success === false) {
              notifyActionError(`Error al ejecutar la acción: ${res.error ?? 'error desconocido'}`, { error: res.error ?? null })
              break
            }
          }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      // Evita el doble toast cuando ya se notificó el fallo (cuerpo 200):
      // aquí solo llegan errores de transporte/HTTP 500 (excepciones).
      if (!/^Error al ejecutar la acción: /.test(msg)) {
        notifyActionError(`Error al ejecutar la acción: ${msg}`, { error: msg })
      }
      console.error('Failed to execute button:', error)
    } finally {
      setTimeout(() => {
        const index = executingButtons.value.indexOf(position)
        if (index > -1) executingButtons.value.splice(index, 1)
      }, 500)
    }
  }

  const deleteButton = async (position: number) => {
    const button = getButton(position)
    if (!button) {
      console.log('No button to delete at position:', position)
      return
    }

    try {
      console.log('🗑️ Deleting button at position:', position, 'Button ID:', button.id)

      const mutationId = trackMutation(newMutationId())
      await apiRequest(`/buttons/${button.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ mutationId })
      })

      console.log('✅ Button deleted successfully')

      // If this was the selected button, deselect it
      if (selectedButtonId.value === button.id || selectedButton.value === position) {
        selectedButton.value = null
        selectedButtonId.value = null
      }

      // Sincronización local sin recargar: un loadButtons aquí pisaría
      // swaps optimistas en vuelo y haría "rebotar" el grid. El eco propio
      // por WS se ignora por mutationId; lo ajeno sí recarga.
      const index = currentButtons.value.findIndex(b => b.id === button.id)
      if (index > -1) {
        currentButtons.value.splice(index, 1)
      }
      bumpButtonsEpoch()
    } catch (error) {
      console.error('❌ Failed to delete button:', error)
      // Reconciliar con la BD si el borrado falló.
      await loadButtons({ force: true })
    }
  }

  // Resuelve el botón que se está editando POR ID, no por posición: si el
  // botón se movió (drag & drop) después de seleccionarlo, la edición debe
  // seguir al botón (su id), no quedarse en la posición vieja.
  const getEditingButton = (): ButtonEntity | undefined => {
    if (selectedButtonId.value) {
      const byId = currentButtons.value.find((b) => b.id === selectedButtonId.value)
      if (byId) return byId
    }
    return selectedButton.value !== null ? getButton(selectedButton.value) : undefined
  }

  // Button configuration functions
  const saveButtonConfig = async () => {
    // Si hay un autosave pendiente y guardamos ahora (p.ej. Vaciar),
    // cancelarlo: este guardado ya lleva la data más reciente.
    if (saveTimeout.value) {
      clearTimeout(saveTimeout.value)
      saveTimeout.value = null
    }
    // Si ya hay un guardado en vuelo, reprogramar en vez de perder el cambio.
    if (isSaving.value) {
      debouncedSave()
      return
    }
    if (selectedButton.value === null || !currentPage.value) {
      return
    }
    isSaving.value = true

    // Espejo actions[] <-> pressActions.click antes de persistir.
    buttonConfig.value = ensurePressMirror(buttonConfig.value)

    // Editar por ID: el botón seleccionado puede haberse movido de posición
    // (drag & drop) después de seleccionarlo. Resolver por id garantiza que
    // el PUT/DELETE va al botón que se está editando, no al ocupante actual
    // de la posición vieja.
    const position = selectedButton.value
    const existingButton = getEditingButton()

    // Only save if there's actual content to save
    const hasContent = buttonConfig.value.label?.trim() ||
      buttonConfig.value.textTop?.trim() ||
      buttonConfig.value.textBottom?.trim() ||
      buttonConfig.value.emoji?.trim() ||
      buttonConfig.value.icon?.trim() ||
      buttonConfig.value.iconImage?.trim() ||
      (buttonConfig.value.actions?.length ?? 0) > 0 ||
      pressExtraCount(buttonConfig.value) > 0 ||
      (buttonConfig.value.rules?.length ?? 0) > 0 ||
      (buttonConfig.value.looks?.length ?? 0) > 0

    console.log('💾 Saving button at position:', position, 'Existing:', !!existingButton, 'HasContent:', hasContent)

    try {
      if (existingButton) {
        if (hasContent) {
          // Update existing button
          console.log('📝 Updating button', existingButton.id, 'with data:', buttonConfig.value)
          const mutationId = trackMutation(newMutationId())
          await apiRequest(`/buttons/${existingButton.id}`, {
            method: 'PUT',
            body: JSON.stringify({ data: buttonConfig.value, mutationId })
          })

          // Update local data
          existingButton.data = { ...buttonConfig.value }
          bumpButtonsEpoch()
          snapshotButtonConfig()
          console.log('✅ Button updated successfully')

          // La selección sigue al botón por si se movió (drag & drop).
          selectedButtonId.value = existingButton.id
          selectedButton.value = existingButton.position

          // Force reactivity update
          await nextTick()
        } else {
          // Delete button if no content
          console.log('🗑️ Deleting button', existingButton.id, 'because no content')
          const mutationId = trackMutation(newMutationId())
          await apiRequest(`/buttons/${existingButton.id}`, {
            method: 'DELETE',
            body: JSON.stringify({ mutationId })
          })

          // Remove from local data
          const index = currentButtons.value.findIndex(b => b.id === existingButton.id)
          if (index > -1) {
            currentButtons.value.splice(index, 1)
          }
          bumpButtonsEpoch()
          selectedButtonId.value = null
          snapshotButtonConfig()
          console.log('✅ Button deleted successfully')
        }
      } else if (hasContent) {
        // Create new button only if there's content (con icono por defecto
        // si el usuario no eligió visual). El borrador se normaliza ANTES de
        // enviar: si no, el autosave posterior reenviaba el draft sin icono
        // y lo borraba de la BD recién creada.
        buttonConfig.value = ensureDefaultIcon(buttonConfig.value)
        console.log('➕ Creating new button at position', position, 'with data:', buttonConfig.value)
        const mutationId = trackMutation(newMutationId())
        const newButton = await apiRequest('/buttons', {
          method: 'POST',
          body: JSON.stringify({
            page_id: currentPage.value.id,
            position,
            data: ensureDefaultIcon(buttonConfig.value),
            mutationId
          })
        })

        currentButtons.value.push(newButton)
        selectedButtonId.value = newButton.id
        bumpButtonsEpoch()
        snapshotButtonConfig()
        console.log('✅ Button created:', newButton.id, 'Data:', newButton)
      } else {
        // No content and no existing button - nothing to do
        console.log('⏭️ No content to save for empty button at position:', position)
      }

      // Clear dynamic button values for this position to force refresh with new config
      dynamicButtonValues.value.delete(position)
      console.log('🧹 Cleared dynamic values for position', position, 'to force refresh')

      // Restart dynamic updates to include/exclude the newly saved button.
      // Sin bloquear: el guardado ya terminó desde el punto de vista de la UI.
      void startDynamicUpdates()
    } catch (error) {
      console.error('❌ Failed to save button:', error)
    } finally {
      isSaving.value = false
    }
  }

  // Action management functions
  const addAction = (type: string) => {
    const newAction = createAction(type)

    // Crear nuevo objeto para disparar reactividad
    buttonConfig.value = ensurePressMirror({
      ...buttonConfig.value,
      actions: [...buttonConfig.value.actions, newAction]
    })
    bumpConfigVersion()
  }

  const removeAction = (index: number) => {
    // Crear nuevo objeto para disparar reactividad
    buttonConfig.value = ensurePressMirror({
      ...buttonConfig.value,
      actions: buttonConfig.value.actions.filter((_, i) => i !== index)
    })
    bumpConfigVersion()
  }

  const reorderActions = async (newOrderedActions: any[]) => {
    // Bloquear recargas de WebSocket durante todo el proceso
    enterSwap()
    console.log('🔒 isSwapping = true, blocking WebSocket reloads')

    // NO actualizar buttonConfig local para evitar re-renders que rompan Swapy
    // En su lugar, guardar directamente en la BD
    console.log(`🔄 Reordering actions:`, newOrderedActions.map(a => a.type).join(' → '))

    // Guardar directamente con el nuevo orden (por ID, no por posición)
    const button = getEditingButton()
    if (!button || !currentPage.value) {
      exitSwap()
      return
    }
    const position = button.position

    // Crear el config actualizado con las acciones reordenadas
    const updatedConfig = ensurePressMirror({
      ...buttonConfig.value,
      actions: newOrderedActions
    })

    try {
      const mutationId = trackMutation(newMutationId())
      await apiRequest(`/buttons/${button.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          page_id: currentPage.value.id,
          position,
          data: updatedConfig,
          mutationId
        })
      })

      console.log('✅ Actions reordered and saved')

      // Sincronizar el borrador local con lo guardado (si no, el siguiente
      // autoguardado pisaría el nuevo orden con el viejo). El componente de
      // acciones ya muestra newOrderedActions, así que no hay re-render
      // disruptivo. El PUT posterior del autosave llevará lo mismo.
      buttonConfig.value = { ...updatedConfig }
      bumpConfigVersion()
      const localBtn = currentButtons.value.find((b) => b.id === button.id)
      if (localBtn) localBtn.data = { ...updatedConfig }
      bumpButtonsEpoch()

      // Esperar antes de desbloquear para que Swapy complete su animación
      setTimeout(() => {
        exitSwap()
        console.log('🔓 isSwapping = false, allowing WebSocket reloads')

        // Ahora sí, recargar desde la API para sincronizar (con guarda de
        // época: si mientras tanto hubo swaps optimistas más nuevos, se
        // descarta para no rebotar el grid).
        loadButtons()
      }, 300)
    } catch (error) {
      console.error('❌ Failed to save reordered actions:', error)
      exitSwap()
    }
  }

  const updateActionParameter = (actionIndex: number, paramKey: string, value: any) => {
    const actions = [...buttonConfig.value.actions]
    actions[actionIndex] = {
      ...actions[actionIndex],
      parameters: {
        ...actions[actionIndex].parameters,
        [paramKey]: value
      }
    }
    // Crear nuevo objeto para disparar reactividad
    buttonConfig.value = ensurePressMirror({
      ...buttonConfig.value,
      actions
    })
    bumpConfigVersion()
  }

  const getDefaultActionParameters = (type: string) => {
    switch (type) {
      case 'shell':
        return { command: '' }
      case 'http':
        return { url: '', method: 'GET' }
      case 'hotkey':
        return { keys: '' }
      case 'multimedia':
        return { action: 'playpause' }
      case 'page':
        return { pageId: '', pageName: '' }
      case 'open-url':
        return { url: '' }
      case 'pc-vitals.monitor':
        return { component: 'cpu', metric: 'usage', updateInterval: 1000 }
      case 'local.set-var':
        return { name: '', expr: '' }
      case 'local.toggle-var':
        return { name: '' }
      case 'local.toast':
        return { text: '' }
      default:
        return {}
    }
  }

  /** Construye un objeto de acción con parámetros por defecto (para teclas y reglas). */
  const createAction = (type: string) => {
    // Resolución O(1) vía índice (con fallback legacy si el plugin no lista
    // la acción pero el prefijo coincide con un plugin conocido).
    let pluginId: string | null = null
    if (type.includes('.')) {
      pluginId = actionTypeIndex.value.get(type)?.pluginId ?? null
      if (!pluginId) {
        const prefix = type.slice(0, type.indexOf('.'))
        if ((plugins.value as Array<[string, any]>).some(([pid]) => pid === prefix)) {
          pluginId = prefix
        }
      }
    } else {
      for (const [full, meta] of actionTypeIndex.value) {
        if (full.endsWith(`.${type}`)) {
          pluginId = meta.pluginId
          break
        }
      }
      if (!pluginId) {
        for (const plugin of plugins.value) {
          const [pid, pluginData] = plugin as [string, any]
          if (pluginData.actions && pluginData.actions.some((action: any) => action[0] === type)) {
            pluginId = pid
            break
          }
        }
      }
    }

    return {
      id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
      type,
      pluginId,
      parameters: getDefaultActionParameters(type)
    }
  }

  /** Ejecuta una sola acción remota (el motor de reglas la usa por acción). */
  const executeSingleAction = async (action: any, context: Record<string, any>) => {
    return apiRequest('/actions/execute', {
      method: 'POST',
      body: JSON.stringify({ action, context: { deviceId: deviceId.value, ...context } })
    })
  }

  // ---- Sesiones por dispositivo (vista profile/page propia por cliente) ----

  /** Lista clientes conectados y su vista actual (más sesiones persistidas). */
  const loadSessions = async () => {
    try {
      sessions.value = await apiRequest('/sessions')
    } catch (error) {
      console.error('Failed to load sessions:', error)
      sessions.value = []
    }
  }

  /**
   * Navegación dirigida a otro dispositivo (o broadcast con target 'all'):
   * fija su vista y le envía page/profile.navigate solo a él.
   */
  const navigateSession = async (
    targetDeviceId: string,
    view: { profileId?: string; pageId?: string }
  ) => {
    await apiRequest(`/sessions/${encodeURIComponent(targetDeviceId)}`, {
      method: 'PUT',
      body: JSON.stringify(view)
    })
    await loadSessions()
  }

  /** Perfil de arranque asignable: se aplica al registrarse/reconectar. */
  const setSessionStartupProfile = async (targetDeviceId: string, startupProfileId: string | null) => {
    await apiRequest(`/sessions/${encodeURIComponent(targetDeviceId)}`, {
      method: 'PUT',
      body: JSON.stringify({ startupProfileId })
    })
    await loadSessions()
  }

  // Profile management functions
  const selectProfile = async (profileId: string) => {
    // Stop existing dynamic updates
    stopDynamicUpdates()

    selectedProfile.value = profileId
    await loadProfile()

    // Save selected profile to localStorage
    saveSelectedProfile(selectedProfile.value)

    // Fuera del camino crítico: persistir el setting y repintar el HW no
    // deben retrasar el cambio de perfil visible (fire-and-forget).
    // OJO: si el cambio lo empujó otro dispositivo, no se toca el global.
    if (!isRemoteProfileChange.value) {
      void apiRequest('/settings', {
        method: 'POST',
        body: JSON.stringify({
          key: 'current.profile_id',
          value: profileId
        })
      }).then(() => {
        console.log('✅ Profile saved to database settings:', profileId)
      }).catch((error) => {
        console.error('❌ Failed to save profile to database settings:', error)
      })
    }

    // Broadcast profile change to other devices (only for local changes)
    if (!isRemoteProfileChange.value) {
      ws?.send(JSON.stringify({
        type: 'profile.select',
        // Cambio GLOBAL de perfil: se difunde a todas las pantallas y el
        // daemon resuelve por dispositivo (cada una abre SU página asignada
        // en el perfil nuevo, o la primera si no tiene). Sin esto, el
        // `current.profile_id` global avanzaba pero el resto de pantallas
        // se quedaba en el perfil viejo.
        payload: { profileId, target: 'all' }
      }))
    }

    // OJO: al cambiar de perfil SÍ se empuja la vista al resto de pantallas
    // (broadcast `profile.select` → el daemon reasigna por dispositivo y
    // repinta el HW físico a su página asignada). Solo la navegación de
    // PÁGINA dentro del editor (selectPage) sigue siendo local: el HW sigue
    // su propia sesión/asignación y solo cambia de página por acción,
    // por el botón "dispositivos" o por un cambio de perfil.
  }
  const createProfile = async (name: string) => {
    try {
      const newProfile = await apiRequest('/profiles', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          data: {} // New profiles are not default
        })
      })

      // Create default page for new profile
      await apiRequest('/pages', {
        method: 'POST',
        body: JSON.stringify({
          profile_id: newProfile.id,
          name: 'Página Principal',
          order_idx: 0,
          data: {}
        })
      })

      await loadProfiles()

      // Auto-select the new profile
      await selectProfile(newProfile.id)

      return newProfile
    } catch (error) {
      console.error('Failed to create profile:', error)
      throw error
    }
  }

  const updateProfile = async (profileId: string, updates: any) => {
    try {
      const profile = profiles.value.find(p => p.id === profileId)
      if (!profile) return

      const updatedProfile = await apiRequest(`/profiles/${profileId}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: updates.name || profile.name,
          data: updates.data || profile.data
        })
      })

      // Update local profile
      const index = profiles.value.findIndex(p => p.id === profileId)
      if (index > -1) {
        profiles.value[index] = updatedProfile
      }

      // If this is the current profile, update currentProfile
      if (currentProfile.value?.id === profileId) {
        currentProfile.value = updatedProfile
      }

      console.log('✅ Profile updated successfully')
    } catch (error) {
      console.error('❌ Failed to update profile:', error)
      throw error
    }
  }

  const deleteProfile = async (profileId: string) => {
    try {
      // Check if we're deleting the default profile
      const profileToDelete = profiles.value.find(p => p.id === profileId)
      let wasDefault = false
      if (profileToDelete) {
        let data = profileToDelete.data
        if (typeof data === 'string') {
          try {
            data = JSON.parse(data)
          } catch {
            data = {}
          }
        }
        wasDefault = data?.isDefault === true
      }

      await apiRequest(`/profiles/${profileId}`, {
        method: 'DELETE'
      })

      // Remove from local profiles
      const index = profiles.value.findIndex(p => p.id === profileId)
      if (index > -1) {
        profiles.value.splice(index, 1)
      }

      // If we deleted the default profile, mark another one as default
      if (wasDefault && profiles.value.length > 0) {
        const newDefaultProfile = profiles.value[0]
        let data = newDefaultProfile.data
        if (typeof data === 'string') {
          try {
            data = JSON.parse(data)
          } catch {
            data = {}
          }
        }
        // Anti-corrupción: ver comentario en loadProfiles (claves numéricas).
        if (!data || typeof data !== 'object' || Array.isArray(data)) data = {}
        const updatedData = { ...data, isDefault: true }

        await apiRequest(`/profiles/${newDefaultProfile.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: newDefaultProfile.name,
            data: updatedData
          })
        })

        // Update local data
        newDefaultProfile.data = updatedData
        console.log('Marked new default profile:', newDefaultProfile.id)
      }

      // If this was the selected profile, select another one
      if (selectedProfile.value === profileId) {
        if (profiles.value.length > 0) {
          await selectProfile(profiles.value[0].id)
        } else {
          selectedProfile.value = ''
          currentProfile.value = null
          currentPage.value = null
          currentButtons.value = []
        }
      }

      console.log('✅ Profile deleted successfully')
    } catch (error) {
      console.error('❌ Failed to delete profile:', error)
      throw error
    }
  }

  // Page management functions
  const selectPage = async (pageId: string) => {
    const page = currentPages.value.find(p => p.id === pageId)
    if (!page) {
      console.error('Page not found:', pageId)
      return
    }

    // Stop existing dynamic updates
    stopDynamicUpdates()

    // Save current page's button config before switching (ver comentario
    // en selectButton: el dirty-check es contra el snapshot, no la fila BD).
    if (selectedButton.value !== null && currentPage.value) {
      const currentButton = getButton(selectedButton.value)
      if (currentButton && isButtonConfigDirty()) {
        await saveButtonConfig()
      }
    }

    currentPage.value = page
    // El grid lo define la página (hereda del perfil si es NULL): al
    // cambiar de página se restaura su tamaño, no se conserva el anterior.
    applyGridForPage(page, parseProfileData(currentProfile.value?.data))
    selectedButton.value = null
    selectedButtonId.value = null
    buttonConfig.value = ensurePressMirror({
      label: '',
      textTop: '',
      textBottom: '',
      fontSize: 14,
      emoji: '',
      icon: '',
      iconImage: '',
      backgroundColor: '',
      textColor: '#e8e9eb',
      showTitle: true,
      mode: 'seq',
      longPress: 'none',
      confirm: false,
      actions: [],
      rules: [],
      looks: [],
      stateVar: ''
    })
    snapshotButtonConfig()

    // Nueva época: invalida GETs en vuelo de la página anterior
    bumpButtonsEpoch()
    await loadButtons({ force: true })

    // Start dynamic updates for PC Vitals buttons (sin bloquear)
    void startDynamicUpdates()

    // Persistir el setting y repintar el HW fuera del camino crítico: la
    // página ya está visible; esto no debe retrasar el cambio (fire-and-forget).
    // OJO: si la navegación la empujó otro dispositivo (asignación), no se
    // toca el global: cada pantalla sigue su propia vista.
    if (!isRemotePageChange.value) {
      void apiRequest('/settings', {
        method: 'POST',
        body: JSON.stringify({
          key: 'current.page_id',
          value: pageId
        })
      }).then(() => {
        console.log('✅ Page saved to database settings:', pageId)
      }).catch((error) => {
        console.error('❌ Failed to save page to database settings:', error)
      })
    }

    // OJO: navegar en el editor NO repinta el Stream Deck físico (ver nota en
    // updateStreamDeckButtons). El HW sigue su propia sesión/asignación.

    // Broadcast page change to other devices (only for local changes)
    if (!isRemotePageChange.value) {
      console.log('📤 Sending page.select message:', { pageId })
      ws?.send(JSON.stringify({
        type: 'page.select',
        // Por defecto solo este dispositivo (ver comentario en selectProfile).
        payload: { pageId, deviceId: deviceId.value }
      }))
    } else {
      console.log('🔕 Skipping page.select broadcast (remote change)')
    }
  }

  const createPage = async (name: string, isFolder: boolean = false) => {
    if (!selectedProfile.value) {
      throw new Error('No profile selected')
    }

    try {
      const newPage = await apiRequest('/pages', {
        method: 'POST',
        body: JSON.stringify({
          profile_id: selectedProfile.value,
          name: name.trim(),
          order_idx: currentPages.value.length,
          is_folder: isFolder ? 1 : 0,
          // Tamaño propio en columnas (hereda la vista actual); el daemon
          // ya no lo lee de `data`.
          grid_cols: gridCols.value,
          grid_rows: gridRows.value,
          data: {}
        })
      })

      currentPages.value.push(newPage)

      // If it's not a folder, switch to it after a small delay to allow broadcasts to propagate
      if (!isFolder) {
        setTimeout(() => {
          selectPage(newPage.id)
        }, 100)
      }

      return newPage
    } catch (error: any) {
      // Handle duplicate page name error
      if (error.message?.includes('409') || error.message?.includes('already exists')) {
        throw new Error(`Ya existe una página con el nombre "${name}" en este perfil`)
      }

      console.error('Failed to create page:', error)
      throw error
    }
  }

  const deletePage = async (pageId: string) => {
    try {
      await apiRequest(`/pages/${pageId}`, {
        method: 'DELETE'
      })

      // Remove from local pages
      const index = currentPages.value.findIndex(p => p.id === pageId)
      if (index > -1) {
        currentPages.value.splice(index, 1)
      }

      // If this was the current page, select another one
      if (currentPage.value?.id === pageId) {
        const remainingPages = currentPages.value.filter(p => p.is_folder === 0)
        if (remainingPages.length > 0) {
          await selectPage(remainingPages[0].id)
        } else {
          currentPage.value = null
          currentButtons.value = []
          selectedButton.value = null
          selectedButtonId.value = null
        }
      }

      console.log('✅ Page deleted successfully')
    } catch (error: any) {
      // If the page doesn't exist on the server (404), just remove it locally
      if (error.message?.includes('404') || error.message?.includes('Not Found')) {
        console.log('⚠️ Page not found on server, removing locally')

        // Remove from local pages anyway
        const index = currentPages.value.findIndex(p => p.id === pageId)
        if (index > -1) {
          currentPages.value.splice(index, 1)
        }

        // If this was the current page, select another one
        if (currentPage.value?.id === pageId) {
          const remainingPages = currentPages.value.filter(p => p.is_folder === 0)
          if (remainingPages.length > 0) {
            await selectPage(remainingPages[0].id)
          } else {
            currentPage.value = null
            currentButtons.value = []
            selectedButton.value = null
            selectedButtonId.value = null
          }
        }

        console.log('✅ Page removed locally (was not found on server)')
        return // Don't throw error for 404
      }

      console.error('❌ Failed to delete page:', error)
      throw error
    }
  }

  const normalizePageData = (d: any): Record<string, any> => {
    let cur: any = d
    for (let i = 0; i < 5 && typeof cur === 'string'; i++) {
      const t = cur.trim()
      if (!t) return {}
      try {
        cur = JSON.parse(t)
      } catch {
        return {}
      }
    }
    return cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}
  }

  const updatePage = async (pageId: string, updates: Partial<PageData>) => {
    try {
      const page = currentPages.value.find(p => p.id === pageId)
      if (!page) return

      const updatedPage = await apiRequest(`/pages/${pageId}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: updates.name || page.name,
          order_idx: updates.order_idx || page.order_idx,
          is_folder: updates.is_folder !== undefined ? updates.is_folder : page.is_folder,
          // Tamaño propio de la página (columnas reales, no `data`).
          ...(updates.grid_cols !== undefined ? { grid_cols: updates.grid_cols } : {}),
          ...(updates.grid_rows !== undefined ? { grid_rows: updates.grid_rows } : {}),
          // Normalizar: page.data llega como TEXT serializado del daemon;
          // reenviarlo tal cual sumaba una capa de JSON.stringify por guardado.
          data: updates.data !== undefined ? updates.data : normalizePageData((page as any).data)
        })
      })

      // Update local page
      const index = currentPages.value.findIndex(p => p.id === pageId)
      if (index > -1) {
        currentPages.value[index] = updatedPage
      }

      // If this is the current page, update currentPage
      if (currentPage.value?.id === pageId) {
        currentPage.value = updatedPage
      }

      console.log('✅ Page updated successfully')
    } catch (error: any) {
      // Nombre duplicado: mensaje legible (como en createPage).
      if (error.message?.includes('already exists')) {
        throw new Error(`Ya existe una página con el nombre "${updates.name || page.name}" en este perfil`)
      }
      // If the page doesn't exist on the server (404), show warning but don't update locally
      if (error.message?.includes('404') || error.message?.includes('Not Found')) {
        console.warn('⚠️ Page not found on server, cannot update')
        return // Don't throw error for 404
      }

      console.error('❌ Failed to update page:', error)
      throw error
    }
  }

  // Cola seriada de guardados de tamaño de rejilla: varios clics seguidos en
  // +/- disparaban PUTs concurrentes con el objeto completo y ganaba el más
  // lento (steppers, BD y F5 quedaban distintos). En cola, el último gana.

  // Cola seriada de guardados de tamaño de rejilla: varios clics seguidos en
  // +/- disparaban PUTs concurrentes con el objeto completo y ganaba el más
  // lento (steppers, BD y F5 quedaban distintos). En cola, el último gana.
  let gridSaveChain: Promise<void> = Promise.resolve()

  // Grid management functions
  const changeGridSize = async (deltaX: number, deltaY: number) => {
    let changed = false

    if (deltaX !== 0) {
      const newCols = gridCols.value + deltaX
      if (newCols >= 3 && newCols <= 8) {
        gridCols.value = newCols
        changed = true
      }
    }

    if (deltaY !== 0) {
      const newRows = gridRows.value + deltaY
      if (newRows >= 2 && newRows <= 6) {
        gridRows.value = newRows
        changed = true
      }
    }

    // Save grid size to the CURRENT PAGE (serializado: el cuerpo del PUT
    // se lee al enviar, no al pulsar, para no pisar clics en vuelo). El
    // perfil no se toca: su grid es solo el default heredado.
    if (changed && currentPage.value) {
      const pageId = currentPage.value.id
      const run = gridSaveChain.then(async () => {
        if (currentPage.value?.id !== pageId) return
        try {
          console.log('💾 Saving grid size:', { grid_cols: gridCols.value, grid_rows: gridRows.value })

          const updatedPage = await apiRequest(`/pages/${pageId}`, {
            method: 'PUT',
            body: JSON.stringify({
              grid_cols: gridCols.value,
              grid_rows: gridRows.value
            })
          })

          console.log('✅ Grid size saved successfully')

          // Refleja la fila del daemon (fuente de verdad del tamaño).
          const index = currentPages.value.findIndex(p => p.id === pageId)
          if (index > -1) {
            currentPages.value[index] = updatedPage
          }
          if (currentPage.value?.id === pageId) {
            currentPage.value = updatedPage
          }
        } catch (error) {
          console.error('❌ Failed to save grid size:', error)
        }
      })
      gridSaveChain = run.then(() => undefined, () => undefined)
      await run
    }
  }

  // Swap handling
  const notifySwapyResync = () => {
    // Avisa a los grids (StreamDeckGrid / StageBoard) para que re-vinculen
    // Swapy al DOM ya sincronizado con las nuevas posiciones.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('libredeck:swapy-resync'))
    }
  }

  // Cola seriada de persistencia de swaps: los drag & drop rápidos se
  // encolan en orden de inicio y se ejecutan de uno en uno. Sin esto, dos
  // swaps del mismo botón en vuelo podían llegar al daemon desordenados y el
  // último intent (el que ve el usuario) quedaba pisado por el anterior → al
  // recargar, la tecla "volvía" a su posición vieja.
  let swapChain: Promise<void> = Promise.resolve()

  const handleSwap = (event: any) => {
    // Get the new mapping after swap - onSwapEnd usa slotItemMap
    const newMap = event.slotItemMap?.asObject || event.newSlotItemMap?.asObject || event.map

    // Validate that newMap exists and is an object
    if (!newMap || typeof newMap !== 'object') {
      console.warn('❌ Invalid or missing map in swap event:', event)
      // El DOM de Swapy puede haber quedado movido visualmente: recargar
      // desde BD (fuente de verdad) y re-vincular Swapy. Sin bloquear.
      // force: venimos de un estado desconocido, la BD manda.
      void (async () => {
        await loadButtons({ force: true })
        await nextTick()
        notifySwapyResync()
      })()
      return
    }

    // Find all buttons that need position updates
    const positionUpdates: Array<{ button: ButtonEntity, newPosition: number }> = []
    const positionByItem = new Map<string, number>()
    for (const [slot, itemId] of Object.entries(newMap as Record<string, unknown>)) {
      if (typeof itemId !== 'string') continue
      const position = Number.parseInt(slot.replace(/^slot-/, ''), 10)
      if (Number.isInteger(position)) positionByItem.set(itemId, position)
    }

    for (const button of currentButtons.value) {
      const newPosition = positionByItem.get(`item-${button.id}`)
      if (newPosition === undefined || button.position === newPosition) continue
      positionUpdates.push({ button, newPosition })
    }

    if (positionUpdates.length === 0) {
      return
    }

    if (!currentPage.value) {
      console.error('❌ No current page, cannot save swap')
      void (async () => {
        await loadButtons({ force: true })
        await nextTick()
        notifySwapyResync()
      })()
      return
    }

    // Optimista inmediato: el grid y la selección se actualizan SIN esperar
    // a la red. Todo lo posterior es asíncrono y no bloquea la UI.
    for (const { button, newPosition } of positionUpdates) {
      button.position = newPosition
    }
    bumpButtonsEpoch()
    // La selección sigue al botón por ID si fue uno de los movidos.
    if (selectedButtonId.value) {
      const sel = currentButtons.value.find((b) => b.id === selectedButtonId.value)
      if (sel) selectedButton.value = sel.position
    }
    // Sin resync explícito aquí: el watcher de firma del grid en StageBoard
    // detecta el cambio de posiciones y re-vincula Swapy una sola vez.

    // Persistencia seriada en el daemon (transacción atómica por swap).
    // Si falla, la BD queda intacta y reconciliamos el estado local con ella.
    const pageId = currentPage.value.id
    const mutationId = trackMutation(newMutationId())
    const order = positionUpdates.map(({ button, newPosition }) => ({
      id: button.id,
      position: newPosition
    }))
    enterSwap()
    swapChain = swapChain
      .then(async () => {
        await apiRequest('/buttons/reorder', {
          method: 'POST',
          body: JSON.stringify({ page_id: pageId, order, mutationId })
        })
      })
      .catch(async (error) => {
        console.error('❌ Failed to save swap, reconciling with database:', error)
        await loadButtons({ force: true })
        // Tras reconciliar, la selección vuelve a seguir al botón si existe.
        if (selectedButtonId.value) {
          const sel = currentButtons.value.find((b) => b.id === selectedButtonId.value)
          selectedButton.value = sel ? sel.position : null
          if (!sel) selectedButtonId.value = null
        }
        await nextTick()
        notifySwapyResync()
      })
      .finally(() => {
        exitSwap()
      })
  }

  // Auto-save with debouncing.
  // FIX vaciado lento/colgado: antes se ponía isSaving=true al PROGRAMAR el
  // guardado y el watcher bloqueaba por isSaving. Dos mutaciones seguidas
  // (como las de onClearKey: onUpdateField + asignación) hacían:
  // 1ª programa timeout, 2ª hace clearTimeout + early-return por isSaving
  // → el guardado se cancelaba y nadie lo reprogramaba, isSaving quedaba
  // en true para siempre y el autosave moría. Ahora programar no marca
  // isSaving; lo gestiona saveButtonConfig durante la ejecución, y si llega
  // un cambio mientras se guarda se reprograma en vez de perderse.
  const debouncedSave = () => {
    if (saveTimeout.value) clearTimeout(saveTimeout.value)
    if (isChangingButton.value || isSwapping.value) return // Don't save while changing buttons or swapping

    saveTimeout.value = setTimeout(() => {
      saveTimeout.value = null
      saveButtonConfig()
    }, 800) // 800ms para dar tiempo a escribir pero sentir rapidez
  }

  // Cleanup function
  const cleanup = () => {
    ws?.close()
    if (saveTimeout.value) clearTimeout(saveTimeout.value)
    if (reloadTimer) {
      clearTimeout(reloadTimer)
      reloadTimer = null
    }
    reloadPending.clear()
    stopDynamicUpdates()
  }

  // Dynamic button functions (generic for any plugin). Todas las consultas
  // son O(1) vía actionTypeIndex; sin loops sobre plugins ni console.log.
  const savedActionsHaveDynamic = (actions: any): boolean =>
    Array.isArray(actions) && actions.some(isDynamicActionType)

  const hasDynamicAction = (button: ButtonEntity | null | undefined) => {
    // Check saved button data
    if (savedActionsHaveDynamic(button?.data?.actions)) return true
    // Check current button config, pero solo si el botón consultado es el
    // que se está editando (o no hay botón: pregunta por el borrador actual).
    if ((!button && selectedButton.value !== null) || isSelectedButton(button)) {
      return savedActionsHaveDynamic(buttonConfig.value.actions)
    }
    return false
  }

  const getDynamicAction = (button: ButtonEntity | null | undefined) => {
    // Check saved button data
    const saved = button?.data?.actions
    if (Array.isArray(saved)) {
      const found = saved.find(isDynamicActionType)
      if (found) return found
    }
    // Check current button config (solo para el botón en edición).
    if ((!button && selectedButton.value !== null) || isSelectedButton(button)) {
      const draft = buttonConfig.value.actions
      if (Array.isArray(draft)) return draft.find(isDynamicActionType) ?? null
    }
    return null
  }

  const updateDynamicButtonValue = async (position: number, button: ButtonEntity) => {
    const dynamicAction = getDynamicAction(button)
    if (!dynamicAction) return

    // Concurrencia limitada: el tick central ya la regula, pero el contador
    // también cubre llamadas directas sin saturar el daemon.
    if (dynamicInFlight >= DYNAMIC_MAX_IN_FLIGHT) return
    dynamicInFlight += 1
    try {
      const response = await apiRequest('/actions/execute', {
        method: 'POST',
        body: JSON.stringify({
          action: dynamicAction,
          context: {
            buttonId: button.id,
            pageId: button.page_id,
            profileId: currentProfile.value?.id,
            position,
            // Sondeo periódico (500 ms): sin logs en BD ni broadcasts WS.
            quiet: true
          }
        })
      })

      if (response.result) {
        dynamicButtonValues.value.set(position, response.result)
      }
    } catch {
      // Silencioso a propósito: el polling no debe spamear la consola en
      // cada tick si el daemon o el plugin fallan puntualmente.
    } finally {
      dynamicInFlight -= 1
    }
  }

  // Botones con polling activo ahora mismo (guardados con acción dinámica,
  // incluyendo el seleccionado si es dinámico). Sin botón guardado no hay
  // contexto de ejecución (buttonId/page_id), así que el borrador sin
  // guardar no se sondea hasta su primer saveButtonConfig.
  const dynamicTargets = (): Array<{ position: number; button: ButtonEntity }> => {
    const out: Array<{ position: number; button: ButtonEntity }> = []
    for (const button of currentButtons.value) {
      if (typeof button.position !== 'number') continue
      if (hasDynamicAction(button)) out.push({ position: button.position, button })
    }
    return out
  }

  // Un solo tick para todos los botones dinámicos: respeta el
  // updateInterval individual de cada acción (vía lastRun) y lo resuelve
  // en UN solo `POST /actions/execute-many` por tick de página (cada item
  // lleva su contexto) en vez de N POST en ráfaga. En modo túnel el
  // intervalo se multiplica ×4 y con la pestaña oculta se pausa (el
  // sondeo en segundo plano sumaba ráfagas a la cola del túnel).
  const dynamicTick = () => {
    if (typeof document !== 'undefined' && document.hidden) return
    const isTunnel = !!getTunnelToken()
    const now = Date.now()
    const due: Array<{ position: number; button: ButtonEntity; action: any }> = []
    for (const { position, button } of dynamicTargets()) {
      const dynamicAction = getDynamicAction(button)
      if (!dynamicAction) continue
      const base = Number(dynamicAction?.parameters?.updateInterval) || 1000
      const last = dynamicLastRun.get(position) ?? 0
      if (!isDynamicDue(now, last, base, isTunnel)) continue
      dynamicLastRun.set(position, now)
      due.push({ position, button, action: dynamicAction })
    }
    if (due.length > 0) void updateDynamicButtonsBatch(due)
  }

  // Lote de sondeo dinámico (1 round-trip por tick de página). Con daemon
  // viejo sin batch cae al sondeo clásico por botón.
  const updateDynamicButtonsBatch = async (
    due: Array<{ position: number; button: ButtonEntity; action: any }>
  ) => {
    if (due.length === 0 || dynamicInFlight >= DYNAMIC_MAX_IN_FLIGHT) return
    dynamicInFlight += 1
    let batched = false
    try {
      const res = await apiRequest('/actions/execute-many', {
        method: 'POST',
        body: JSON.stringify(
          buildExecuteManyBody(
            due.map(({ button, position, action }) => ({
              action,
              context: {
                buttonId: button.id,
                pageId: button.page_id,
                profileId: currentProfile.value?.id,
                position,
                // Sondeo periódico: sin logs en BD ni broadcasts WS.
                quiet: true
              }
            }))
          )
        )
      })
      const results = (res as any)?.results
      if (Array.isArray(results)) {
        results.forEach((r: any, i: number) => {
          if (r?.result) dynamicButtonValues.value.set(due[i].position, r.result)
        })
        batched = true
      }
    } catch (batchError) {
      // Daemon sin batch u otro fallo: si no es "endpoint desconocido" se
      // deja pasar en silencio (el polling no spamea) sin fallback.
      if (!isBatchUnsupported(batchError)) return
    } finally {
      dynamicInFlight -= 1
    }
    if (!batched) {
      for (const { position, button } of due) {
        if (dynamicInFlight >= DYNAMIC_MAX_IN_FLIGHT) break
        await updateDynamicButtonValue(position, button)
      }
    }
  }

  const stopDynamicTimer = () => {
    if (dynamicTimer) {
      clearInterval(dynamicTimer)
      dynamicTimer = null
    }
  }

  const startDynamicUpdates = async () => {
    // Wait for plugins to be loaded
    if (plugins.value.length === 0) {
      await loadPlugins()
    }

    stopDynamicTimer()
    dynamicLastRun.clear()

    // Primera pasada inmediata (escalonada por concurrencia); el resto lo
    // cubre el temporizador central.
    dynamicTick()
    if (dynamicTargets().length === 0) return
    if (!dynamicTimer) {
      dynamicTimer = setInterval(dynamicTick, DYNAMIC_TICK_MS)
    }
  }

  const stopDynamicUpdates = () => {
    stopDynamicTimer()
    dynamicLastRun.clear()
    dynamicButtonValues.value.clear()
  }

  const stopDynamicUpdateForButton = (position: number) => {
    dynamicLastRun.delete(position)
    dynamicButtonValues.value.delete(position)
  }

  const testStreamDeck = async () => {
    try {
      console.log('🧪 Testing StreamDeck colors...');
      await apiRequest('/devices/streamdeck/test', {
        method: 'POST'
      });
      console.log('✅ StreamDeck test completed');
    } catch (error) {
      console.error('❌ Failed to test StreamDeck:', error);
    }
  }

  /**
   * Repintado MANUAL del HW (sin llamadas automáticas desde navegación:
   * ni selectPage, ni selectProfile, ni page.navigate remoto lo invocan).
   * El Stream Deck físico sigue su propia sesión/asignación; esta función
   * solo existe para refresco explícito/depuración y el daemon decide qué
   * página mostrar (la sesión del HW manda sobre el pageId pedido).
   */
  const updateStreamDeckButtons = async () => {
    try {
      // Verificar si hay un StreamDeck conectado primero
      const statusResponse = await fetch(`${API_BASE.value}/devices/streamdeck/status`);
      const status = await statusResponse.json();

      if (!status.isConnected) {
        return;
      }

      // Calcular qué posiciones tienen botones configurados
      const buttonStates = [];
      const totalButtons = gridCols.value * gridRows.value;

      for (let i = 0; i < totalButtons; i++) {
        const button = getButton(i);
        let hasContent = false;

        if (button && button.data) {
          hasContent = !!(
            button.data.label?.trim() ||
            button.data.textTop?.trim() ||
            button.data.textBottom?.trim() ||
            button.data.emoji?.trim() ||
            button.data.icon ||
            (typeof button.data.iconImage === 'string' && button.data.iconImage.trim()) ||
            (button.data.actions && button.data.actions.length > 0) ||
            (button.data.rules && button.data.rules.length > 0) ||
            (button.data.looks && button.data.looks.length > 0)
          );
        }

        buttonStates.push(hasContent);
      }

      // Enviar al daemon
      await apiRequest('/devices/streamdeck/update-buttons', {
        method: 'POST',
        body: JSON.stringify({ buttonStates, pageId: currentPage.value?.id })
      });
    } catch (error) {
      console.error('❌ Failed to update StreamDeck buttons:', error);
    }
  }

  return {
    // State
    connectionStatus,
    connectionText,
    profiles,
    selectedProfile,
    currentProfile,
    currentPage,
    currentPages,
    currentButtons,
    plugins,
    gridCols,
    gridRows,
    selectedButton,
    selectedButtonId,
    getEditingButton,
    executingButtons,
    buttonConfig,
    buttonConfigVersion,
    bumpConfigVersion,

    // Computed
    getButtonData,
    getButtonStyle,

    // Functions
    connectWebSocket,
    loadProfiles,
    loadProfile,
    selectProfile,
    loadButtons,
    loadPlugins,
    getButton,
    selectButton,
    executeButton,
    deleteButton,
    saveButtonConfig,
    addAction,
    createAction,
    executeSingleAction,
    removeAction,
    reorderActions,
    updateActionParameter,
    createProfile,
    updateProfile,
    deleteProfile,
    selectPage,
    createPage,
    deletePage,
    updatePage,
    changeGridSize,
    handleSwap,
    debouncedSave,
    cleanup,
    updateStreamDeckButtons,
    testStreamDeck,

    // Dynamic button functions (generic for any plugin)
    hasDynamicAction,
    getDynamicAction,
    updateDynamicButtonValue,
    startDynamicUpdates,
    stopDynamicUpdates,
    stopDynamicUpdateForButton,

    // Sesiones por dispositivo (vista propia + control dirigido)
    deviceId,
    clientId,
    sessionStartupProfileId,
    sessions,
    loadSessions,
    navigateSession,
    setSessionStartupProfile,

    // Invitación LAN (QR/enlace): "Sin permiso" para directos sin invitar
    lanDenied,
    lanSession,
    lanRedeeming,
    redeemLanInviteFromUrl,
    // Escape al relay cuando el canje LAN falla (solo display, sin redirect)
    lanRelayFallback,

    // Túnel del relay: sesión muerta (reinicio/caducidad/daemon caído)
    tunnelSessionInvalid,

    // URLs
    API_BASE,
    WS_URL,
    FRONTEND_URL,

    // Plugin manager (instalación / marketplace / ciclo de vida)
    pluginsDetailed,
    marketplace,
    marketplaceRegistry,
    pluginsLoading,
    setPluginEnabled,
    removePlugin,
    reloadPlugin,
    rollbackPlugin,
    updatePlugin,
    uploadPluginFile,
    installPluginFromUrl,
    loadMarketplace,

    // Servidor MCP propio (tokens)
    mcpTokens,
    mcpScopes,
    loadMcpTokens,
    loadMcpScopes,
    createMcpToken,
    updateMcpToken,
    revokeMcpToken,

    // Progreso de instalación en vivo (WS)
    installProgress,
    clearInstallProgress,

    // Internal state for watchers
    isChangingButton,
    isSaving,
    isSwapping,
    saveTimeout,

    // Manejo de mensajes WS (expuesto para tests del toast de errores)
    handleWebSocketMessage
  }
}
