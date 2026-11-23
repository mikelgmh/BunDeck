import { ref, computed, nextTick } from 'vue'
import { getTunnelToken, tunnelApiBase, tunnelConfigUrl, tunnelWsUrl } from './useTunnel'
import { getOrCreateDeviceId, isNavigationForMe } from '../utils/sessionRouting'
import type { ActionType, ButtonData, ProfileData, PageData, ButtonEntity } from '../types/streamdeck'

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

  // Update intervals for dynamic buttons
  const updateIntervals = ref(new Map<number, number>())

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
    looks: []
  })

  // WebSocket
  let ws: WebSocket | null = null

  // Sesión propia del dispositivo: vista profile/page independiente por
  // browser (el daemon la persiste y la restaura al reconectar).
  const deviceId = ref(getOrCreateDeviceId())
  const clientId = ref<string | null>(null)
  const sessionStartupProfileId = ref<string | null>(null)
  // Clientes conectados y su vista actual (GET /sessions).
  const sessions = ref<any[]>([])

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
      // En modo dev, hacer fetch al daemon directamente (API 3001)
      const configUrl = tunnelToken
        ? tunnelConfigUrl(tunnelToken)
        : typeof window !== 'undefined' && window.location.port !== '3001'
          ? 'http://localhost:3001/config'
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
      return `${protocol}//${hostname}:${config.value.wsPort}`
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

  // Computed properties
  const getButtonData = computed(() => (position: number) => {
    const button = getButton(position)
    // If this is the selected button, always use current config for real-time updates
    if (selectedButton.value === position) {
      const config = {
        ...buttonConfig.value,
        // Force reactivity by accessing reactive values
        _forceUpdate: selectedButton.value
      }

      // Check for dynamic values even for selected button (any plugin with dynamic actions)
      const dynamicValue = dynamicButtonValues.value.get(position)
      if (dynamicValue && hasDynamicAction(button!)) {
        console.log(`📊 Applying dynamic value for selected button at position ${position}:`, dynamicValue)
        return {
          ...config,
          dynamicValue: dynamicValue.value !== undefined && dynamicValue.unit ?
            `${dynamicValue.value}${dynamicValue.unit}` :
            (dynamicValue.description || 'N/A'),
        }
      }

      return config
    }
    // Otherwise return saved data or empty object
    const savedData = button?.data || {
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
    }

    // Check for dynamic values (any plugin with dynamic actions)
    const dynamicValue = dynamicButtonValues.value.get(position)
    if (dynamicValue && hasDynamicAction(button!)) {
      console.log(`📊 Applying dynamic value for position ${position}:`, dynamicValue)
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
    const response = await fetch(`${API_BASE.value}${endpoint}`, {
      headers: { 'Content-Type': 'application/json', ...rest.headers },
      ...rest,
      signal: callerSignal ?? AbortSignal.timeout(30000)
    })

    if (!response.ok) {
      let detail = ''
      try {
        const txt = await response.text()
        try {
          const j = JSON.parse(txt)
          detail = String((j as any)?.error ?? txt)
        } catch { detail = txt }
      } catch {}
      throw new Error(detail || `API Error: ${response.status}`)
    }

    return response.json()
  }

  // WebSocket functions
  const connectWebSocket = () => {
    try {
      ws = new WebSocket(WS_URL.value)

      ws.onopen = () => {
        connectionStatus.value = 'bg-success'
        connectionText.value = 'Conectado'

        console.log('🔌 WebSocket connected, identifying session...', { deviceId: deviceId.value })
        // Sesión propia: el daemon restaura nuestra vista (reconexión) o
        // aplica el startup profile asignado, y responde `session.state`.
        ws?.send(JSON.stringify({
          type: 'hello',
          payload: { deviceId: deviceId.value, kind: 'browser', name: 'Navegador' }
        }))
        ws?.send(JSON.stringify({
          type: 'subscribe',
          payload: { topics: ['profiles', 'buttons', 'actions', 'plugins', 'pages'] }
        }))
      }

      ws.onclose = () => {
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
    } catch (error) {
      console.error('Failed to connect WebSocket:', error)
    }
  }

  const handleWebSocketMessage = async (message: any) => {
    switch (message.type) {
      case 'connected':
        console.log('🔗 WebSocket connected:', message.payload)
        if (message.payload?.clientId) clientId.value = message.payload.clientId
        break
      case 'session.state':
        console.log('🪪 Session state:', message.payload)
        if (message.payload?.clientId) clientId.value = message.payload.clientId
        if (message.payload?.deviceId) deviceId.value = message.payload.deviceId
        if ('startupProfileId' in (message.payload ?? {})) {
          sessionStartupProfileId.value = message.payload.startupProfileId
        }
        break
      case 'subscribed':
        console.log('✅ WebSocket subscribed to topics:', message.payload)
        break
      case 'profile.updated':
        loadProfiles()
        break
      case 'page.updated':
        // Reload pages when a page is updated (renamed) on another device
        if (selectedProfile.value) {
          const pages = await apiRequest(`/pages?profileId=${selectedProfile.value}`)
          currentPages.value = pages
        }
        break
      case 'page.created':
        // Reload pages when a page is created on another device
        if (selectedProfile.value) {
          const pages = await apiRequest(`/pages?profileId=${selectedProfile.value}`)
          currentPages.value = pages
        }
        break
      case 'page.deleted':
        // Reload pages when a page is deleted on another device
        if (selectedProfile.value) {
          const pages = await apiRequest(`/pages?profileId=${selectedProfile.value}`)
          currentPages.value = pages

          // If current page was deleted, select another one
          if (currentPage.value && !pages.find(p => p.id === currentPage.value?.id)) {
            const remainingPages = pages.filter(p => p.is_folder === 0)
            if (remainingPages.length > 0) {
              await selectPage(remainingPages[0].id)
            } else {
              currentPage.value = null
              currentButtons.value = []
              selectedButton.value = null
              selectedButtonId.value = null
            }
          }
        }
        break
      case 'button.created':
        if (isOwnEcho(message.payload)) {
          console.log('🔇 Ignoring own button.created echo (optimistic state already synced)')
          break
        }
        if (currentPage.value && !isSwapping.value) {
          console.log('🔌 Button created via WebSocket, reloading...')
          loadButtons()
        }
        break
      case 'button.updated':
        if (isOwnEcho(message.payload)) {
          console.log('🔇 Ignoring own button.updated echo (optimistic state already synced)')
          break
        }
        if (currentPage.value && !isSwapping.value) {
          console.log('🔌 Button updated via WebSocket, checking if should reload...')
          // Only reload if not currently swapping
          loadButtons()
        } else if (isSwapping.value) {
          console.log('🚫 Ignoring WebSocket button update during swap')
        }
        break
      case 'buttons.reordered': {
        // Reordenado atómico: si es el eco de nuestro propio swap (mutationId
        // pendiente) se ignora — el estado local optimista ya está al día y
        // recargar aquí es lo que hacía "rebotar" la tecla a su sitio viejo.
        // Si viene de otro cliente, recargar la página actual.
        if (isOwnEcho(message.payload)) {
          console.log('🔇 Ignoring own buttons.reordered echo (optimistic state already synced)')
          break
        }
        const reorderedPageId = (message.payload as any)?.pageId
        if (currentPage.value && reorderedPageId === currentPage.value.id && !isSwapping.value) {
          console.log('🔌 Buttons reordered via WebSocket, reloading...')
          loadButtons()
        } else if (isSwapping.value) {
          console.log('🚫 Ignoring WebSocket buttons reorder during swap (local state already synced)')
        }
        break
      }
      case 'button.deleted':
        if (isOwnEcho(message.payload)) {
          console.log('🔇 Ignoring own button.deleted echo (optimistic state already synced)')
          break
        }
        if (currentPage.value && !isSwapping.value) {
          loadButtons()
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
            await selectPage(message.payload.pageId)
            // Save remote page change to database settings for StreamDeck integration
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
            // Update StreamDeck after remote page change
            await updateStreamDeckButtons()
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
          // Save remote profile change to database settings for StreamDeck integration
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
        isRemoteProfileChange.value = false
        break
      case 'action.finished':
        // Remove executing state after action completes
        break
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
        loadPlugins()
        break
      }
      case 'plugin.installed':
      case 'plugin.uninstalled':
      case 'plugin.enabled':
      case 'plugin.settings':
        // Algo cambió en los plugins: recarga listas y acciones
        loadPlugins()
        break
      case 'device.created':
      case 'device.updated':
      case 'device.deleted':
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
    }
  }

  // Data loading functions
  const loadProfiles = async () => {
    // Load config first
    await loadConfig();

    try {
      profiles.value = await apiRequest('/profiles')

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
      let savedProfileId = null;
      try {
        const settingsResponse = await apiRequest('/settings?key=current.profile_id');
        savedProfileId = settingsResponse.value;
        console.log('📂 Loaded profile from database settings:', savedProfileId);
        
        // Handle the case where "null" was saved as a string
        if (savedProfileId === 'null' || savedProfileId === null || savedProfileId === '') {
          savedProfileId = null;
          console.log('⚠️ Invalid profile_id found in settings, ignoring...');
        }
      } catch (error) {
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
        
        // After loading profile and page, update StreamDeck if connected
        console.log('🔌 Profile loaded, checking if we need to update StreamDeck...');
        setTimeout(async () => {
          await updateStreamDeckButtons();
        }, 1000); // Small delay to ensure everything is loaded
      }

      // Load plugins
      await loadPlugins()
    } catch (error) {
      console.error('Failed to load profiles:', error)
    }
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
      currentProfile.value = await apiRequest(`/profiles/${selectedProfile.value}`)

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

      // Restore grid size from profile data
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

      const pages = await apiRequest(`/pages?profileId=${selectedProfile.value}`)
      currentPages.value = pages

      // Try to load saved page from database settings, fallback to first non-folder page
      let targetPage = null;
      try {
        const pageSettingsResponse = await apiRequest('/settings?key=current.page_id');
        const savedPageId = pageSettingsResponse.value;
        
        // Handle the case where invalid values were saved
        if (savedPageId && savedPageId !== 'null' && savedPageId !== null && savedPageId !== '') {
          targetPage = pages.find(p => p.id === savedPageId && p.is_folder === 0);
          console.log('📄 Loaded saved page from database settings:', savedPageId, targetPage ? 'found' : 'not found');
        } else {
          console.log('⚠️ Invalid or missing page_id in settings');
        }
      } catch (error) {
        console.log('⚠️ Could not load page from database settings');
      }

      // If no saved page or saved page not found, use first non-folder page
      if (!targetPage) {
        targetPage = pages.find(p => p.is_folder === 0) || pages[0];
        console.log('📄 Using fallback page:', targetPage?.name);
      }

      if (targetPage) {
        currentPage.value = targetPage
        await loadButtons()

        // Start dynamic updates for PC Vitals buttons
        await startDynamicUpdates()
      } else {
        // Create default page
        currentPage.value = await apiRequest('/pages', {
          method: 'POST',
          body: JSON.stringify({
            profile_id: selectedProfile.value,
            name: 'Página Principal',
            order_idx: 0,
            is_folder: 0,
            data: { gridCols: gridCols.value, gridRows: gridRows.value }
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

  // Button management functions
  const getButton = (position: number): ButtonEntity | undefined => {
    return currentButtons.value.find((btn) => btn.position === position)
  }

  const selectButton = async (position: number) => {
    // Stop dynamic updates for previously selected button if it doesn't have saved dynamic action
    if (selectedButton.value !== null && selectedButton.value !== position) {
      const prevButton = getButton(selectedButton.value)
      if (prevButton && !hasDynamicAction(prevButton)) {
        stopDynamicUpdateForButton(selectedButton.value)
      }
    }

    // Save current button before switching (only if there were actual changes)
    if (selectedButton.value !== null && selectedButton.value !== position) {
      const currentButton = getButton(selectedButton.value)
      if (currentButton) {
        // Only save if the button exists and has changes
        const hasChanges = JSON.stringify(currentButton.data) !== JSON.stringify(buttonConfig.value)
        if (hasChanges) {
          await saveButtonConfig()
        }
      } else {
        // For new buttons, only save if there's actual content
        const hasContent = buttonConfig.value.label?.trim() || buttonConfig.value.textTop?.trim() ||
          buttonConfig.value.textBottom?.trim() || buttonConfig.value.emoji?.trim() ||
          buttonConfig.value.icon?.trim() ||
          buttonConfig.value.iconImage?.trim() || (buttonConfig.value.actions?.length ?? 0) > 0 ||
          (buttonConfig.value.rules?.length ?? 0) > 0 || (buttonConfig.value.looks?.length ?? 0) > 0
        if (hasContent) {
          await saveButtonConfig()
        }
      }
    }

    const button = getButton(position)
    selectedButton.value = position
    selectedButtonId.value = button?.id ?? null
    console.log('Selected button at position:', position, 'Found button:', button)

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
        looks: button.data?.looks ? JSON.parse(JSON.stringify(button.data.looks)) : []
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

      buttonConfig.value = buttonData
    } else {
      buttonConfig.value = {
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
      }
    }

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

    try {
      for (const action of button.data.actions) {
        await apiRequest('/actions/execute', {
          method: 'POST',
          body: JSON.stringify({
            action,
            context: {
              buttonId: button.id,
              pageId: button.page_id,
              profileId: currentProfile.value?.id,
              position,
              // Origen de la acción: la navegación que provoque (page.action)
              // por defecto solo se aplica en este dispositivo.
              deviceId: deviceId.value
            }
          })
        })
      }
    } catch (error) {
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
          console.log('✅ Button deleted successfully')
        }
      } else if (hasContent) {
        // Create new button only if there's content
        console.log('➕ Creating new button at position', position, 'with data:', buttonConfig.value)
        const mutationId = trackMutation(newMutationId())
        const newButton = await apiRequest('/buttons', {
          method: 'POST',
          body: JSON.stringify({
            page_id: currentPage.value.id,
            position,
            data: buttonConfig.value,
            mutationId
          })
        })

        currentButtons.value.push(newButton)
        selectedButtonId.value = newButton.id
        bumpButtonsEpoch()
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
    buttonConfig.value = {
      ...buttonConfig.value,
      actions: [...buttonConfig.value.actions, newAction]
    }
    console.log('➕ Added action:', newAction, 'pluginId found:', newAction.pluginId)
  }

  const removeAction = (index: number) => {
    // Crear nuevo objeto para disparar reactividad
    buttonConfig.value = {
      ...buttonConfig.value,
      actions: buttonConfig.value.actions.filter((_, i) => i !== index)
    }
    console.log('🗑️ Removed action at index:', index)
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
    const updatedConfig = {
      ...buttonConfig.value,
      actions: newOrderedActions
    }

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
    buttonConfig.value = {
      ...buttonConfig.value,
      actions
    }
    console.log(`✏️ Updated action ${actionIndex} parameter ${paramKey}:`, value)
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
    // Find the plugin that has this action type
    let pluginId = null
    for (const plugin of plugins.value) {
      const [pid, pluginData] = plugin
      // For full action types like 'pc-vitals.monitor', check if the plugin ID matches the prefix
      if (type.includes('.')) {
        const [pluginPrefix, actionId] = type.split('.')
        if (pid === pluginPrefix && pluginData.actions && pluginData.actions.some((action: any) => action[0] === actionId)) {
          pluginId = pid
          break
        }
      } else {
        // For simple action types, check direct match
        if (pluginData.actions && pluginData.actions.some((action: any) => action[0] === type)) {
          pluginId = pid
          break
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

    // Save selected profile to database settings for StreamDeck integration
    try {
      await apiRequest('/settings', {
        method: 'POST',
        body: JSON.stringify({
          key: 'current.profile_id',
          value: profileId
        })
      })
      console.log('✅ Profile saved to database settings:', profileId)
    } catch (error) {
      console.error('❌ Failed to save profile to database settings:', error)
    }

    // Broadcast profile change to other devices (only for local changes)
    if (!isRemoteProfileChange.value) {
      ws?.send(JSON.stringify({
        type: 'profile.select',
        // Por defecto solo este dispositivo (el daemon no reemite a otros
        // salvo target 'all'/broadcast explícito).
        payload: { profileId, deviceId: deviceId.value }
      }))
    }

    // Force update StreamDeck after profile change
    await updateStreamDeckButtons()
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

    // Save current page's button config before switching
    if (selectedButton.value !== null && currentPage.value) {
      const currentButton = getButton(selectedButton.value)
      if (currentButton) {
        const hasChanges = JSON.stringify(currentButton.data) !== JSON.stringify(buttonConfig.value)
        if (hasChanges) {
          await saveButtonConfig()
        }
      }
    }

    currentPage.value = page
    selectedButton.value = null
    selectedButtonId.value = null
    buttonConfig.value = {
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
      looks: []
    }

    // Nueva época: invalida GETs en vuelo de la página anterior
    bumpButtonsEpoch()
    await loadButtons({ force: true })

    // Start dynamic updates for PC Vitals buttons (sin bloquear)
    void startDynamicUpdates()

    // Save current page to database settings for StreamDeck integration
    try {
      await apiRequest('/settings', {
        method: 'POST',
        body: JSON.stringify({
          key: 'current.page_id',
          value: pageId
        })
      })
      console.log('✅ Page saved to database settings:', pageId)
    } catch (error) {
      console.error('❌ Failed to save page to database settings:', error)
    }

    // Update StreamDeck buttons to reflect the current page
    console.log('📄 Page changed, calling updateStreamDeckButtons...');
    await updateStreamDeckButtons()

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
          data: { gridCols: gridCols.value, gridRows: gridRows.value }
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
          data: updates.data || page.data
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
      // If the page doesn't exist on the server (404), show warning but don't update locally
      if (error.message?.includes('404') || error.message?.includes('Not Found')) {
        console.warn('⚠️ Page not found on server, cannot update')
        return // Don't throw error for 404
      }

      console.error('❌ Failed to update page:', error)
      throw error
    }
  }

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

    // Save grid size to profile data only if changed
    if (changed && currentProfile.value) {
      try {
        // Create a simple data object with grid size
        const updatedData = {
          gridCols: gridCols.value,
          gridRows: gridRows.value
        }

        console.log('💾 Saving grid size:', updatedData)

        const response = await apiRequest(`/profiles/${currentProfile.value.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: currentProfile.value.name,
            data: updatedData
          })
        })

        console.log('✅ Grid size saved successfully:', response)

        // Update local profile data reference
        // Parse current data if it's a string
        let currentData = currentProfile.value.data
        if (typeof currentData === 'string') {
          try {
            currentData = JSON.parse(currentData)
          } catch (e) {
            currentData = {}
          }
        }

        // Update or initialize data object
        if (!currentData || typeof currentData !== 'object') {
          currentProfile.value.data = updatedData
        } else {
          currentProfile.value.data = {
            ...currentData,
            gridCols: gridCols.value,
            gridRows: gridRows.value
          }
        }

        console.log('📦 Updated local profile data:', currentProfile.value.data)

      } catch (error) {
        console.error('❌ Failed to save grid size:', error)
      }
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
    console.log('🔄 Swap event received:', event)

    // Get the new mapping after swap - onSwapEnd usa slotItemMap
    const newMap = event.slotItemMap?.asObject || event.newSlotItemMap?.asObject || event.map

    // Validate that newMap exists and is an object
    if (!newMap || typeof newMap !== 'object') {
      console.warn('❌ Invalid or missing map in swap event:', event)
      console.log('🔍 Event structure:', JSON.stringify(event, null, 2))
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

    console.log('📍 Current buttons before swap:', currentButtons.value.map(b => ({ id: b.id, position: b.position })))
    console.log('🗺️ New map:', newMap)

    // Find all buttons that need position updates
    const positionUpdates: Array<{ button: ButtonEntity, newPosition: number }> = []

    for (const button of currentButtons.value) {
      // Find which slot this button is now in
      const newSlot = Object.keys(newMap).find(slot =>
        newMap[slot] === `item-${button.id}`
      )

      if (newSlot) {
        const newPosition = parseInt(newSlot.replace('slot-', ''))

        if (!Number.isInteger(newPosition)) continue
        if (button.position !== newPosition) {
          positionUpdates.push({ button, newPosition })
        }
      }
    }

    console.log(`📦 Position updates to save: ${positionUpdates.length}`)

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
    console.log('✅ Swap applied locally (optimistic):', positionUpdates.map(u => ({ id: u.button.id, pos: u.newPosition })))
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
        console.log('✅ Swap persisted:', order)
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
      console.log('💾 Auto-saving button config...')
      saveButtonConfig()
    }, 800) // 800ms para dar tiempo a escribir pero sentir rapidez
  }

  // Cleanup function
  const cleanup = () => {
    ws?.close()
    if (saveTimeout.value) clearTimeout(saveTimeout.value)
    stopDynamicUpdates()
  }

  // Dynamic button functions (generic for any plugin)
  const hasDynamicAction = (button: ButtonEntity | null) => {
    // Check saved button data
    if (button?.data?.actions) {
      const hasAction = button.data.actions.some((action: any) => {
        // Check if this action type is marked as dynamic in any plugin
        for (const plugin of plugins.value) {
          const [pluginId, pluginData] = plugin
          if (pluginData.actions) {
            // If action.pluginId is null, infer it from action.type
            const actionPluginId = action.pluginId || action.type.split('.')[0]
            const found = pluginData.actions.some((pluginAction: any) => {
              const actionId = action.type.split('.')[1]
              return pluginAction[0] === actionId && pluginAction[1]?.dynamic === true && actionPluginId === pluginId
            })
            if (found) return true
          }
        }
        return false
      })
      return hasAction
    }

    // Check current button config (for selected/unsaved buttons)
    if (selectedButton.value !== null && buttonConfig.value.actions) {
      const hasAction = buttonConfig.value.actions.some((action: any) => {
        // Check if this action type is marked as dynamic in any plugin
        for (const plugin of plugins.value) {
          const [pluginId, pluginData] = plugin
          if (pluginData.actions) {
            // If action.pluginId is null, infer it from action.type
            const actionPluginId = action.pluginId || action.type.split('.')[0]
            const found = pluginData.actions.some((pluginAction: any) => {
              const actionId = action.type.split('.')[1]
              return pluginAction[0] === actionId && pluginAction[1]?.dynamic === true && actionPluginId === pluginId
            })
            if (found) return true
          }
        }
        return false
      })
      return hasAction
    }

    return false
  }

  const getDynamicAction = (button: ButtonEntity | null) => {
    // Check saved button data
    if (button?.data?.actions) {
      return button.data.actions.find((action: any) => {
        // Check if this action type is marked as dynamic in any plugin
        for (const plugin of plugins.value) {
          const [pluginId, pluginData] = plugin
          if (pluginData.actions && pluginData.actions.some((pluginAction: any) => {
            // If action.pluginId is null, infer it from action.type
            const actionPluginId = action.pluginId || action.type.split('.')[0]
            const actionId = action.type.split('.')[1]
            return pluginAction[0] === actionId && pluginAction[1]?.dynamic === true && actionPluginId === pluginId
          })) {
            return true
          }
        }
        return false
      })
    }

    // Check current button config (for selected/unsaved buttons)
    if (selectedButton.value !== null && buttonConfig.value.actions) {
      return buttonConfig.value.actions.find((action: any) => {
        // Check if this action type is marked as dynamic in any plugin
        for (const plugin of plugins.value) {
          const [pluginId, pluginData] = plugin
          if (pluginData.actions && pluginData.actions.some((pluginAction: any) => {
            // If action.pluginId is null, infer it from action.type
            const actionPluginId = action.pluginId || action.type.split('.')[0]
            const actionId = action.type.split('.')[1]
            return pluginAction[0] === actionId && pluginAction[1]?.dynamic === true && actionPluginId === pluginId
          })) {
            return true
          }
        }
        return false
      })
    }

    return null
  }

  const updateDynamicButtonValue = async (position: number, button: ButtonEntity) => {
    const dynamicAction = getDynamicAction(button)
    if (!dynamicAction) return

    try {
      console.log(`🔄 Updating dynamic action for button at position ${position}`)

      const response = await apiRequest('/actions/execute', {
        method: 'POST',
        body: JSON.stringify({
          action: dynamicAction,
          context: {
            buttonId: button.id,
            pageId: button.page_id,
            profileId: currentProfile.value?.id,
            position
          }
        })
      })

      if (response.result) {
        console.log(`✅ Dynamic action updated for position ${position}:`, response.result)
        dynamicButtonValues.value.set(position, response.result)
      } else {
        console.warn(`⚠️ No result in dynamic action response for position ${position}`)
      }
    } catch (error) {
      console.error(`❌ Failed to update dynamic button value for position ${position}:`, error)
    }
  }

  const startDynamicUpdates = async () => {
    // Wait for plugins to be loaded
    if (plugins.value.length === 0) {
      console.log('⏳ Waiting for plugins to load...')
      await loadPlugins()
    }

    // Clear existing intervals
    updateIntervals.value.forEach(interval => clearInterval(interval))
    updateIntervals.value.clear()

    console.log('🔄 Starting dynamic updates for buttons:', currentButtons.value.length)

    // Start new intervals for buttons with dynamic actions (only saved buttons)
    currentButtons.value.forEach((button: ButtonEntity) => {
      if (hasDynamicAction(button) && button.position !== selectedButton.value) {
        const dynamicAction = getDynamicAction(button)
        const updateInterval = dynamicAction?.parameters?.updateInterval || 1000

        console.log(`📊 Setting up dynamic monitoring for saved button at position ${button.position}:`, {
          actionType: dynamicAction?.type,
          updateInterval
        })

        const interval = setInterval(() => {
          updateDynamicButtonValue(button.position, button)
        }, updateInterval)

        updateIntervals.value.set(button.position, interval)

        // Initial update
        updateDynamicButtonValue(button.position, button)
      }
    })

    // Also handle the currently selected button if it has dynamic action
    if (selectedButton.value !== null) {
      const selectedBtn = getButton(selectedButton.value)
      if (hasDynamicAction(selectedBtn)) {
        const dynamicAction = getDynamicAction(selectedBtn)
        const updateInterval = dynamicAction?.parameters?.updateInterval || 1000

        console.log(`📊 Setting up dynamic monitoring for selected button at position ${selectedButton.value}:`, {
          actionType: dynamicAction?.type,
          updateInterval
        })

        const interval = setInterval(() => {
          updateDynamicButtonValue(selectedButton.value, selectedBtn!)
        }, updateInterval)

        updateIntervals.value.set(selectedButton.value, interval)

        // Initial update
        updateDynamicButtonValue(selectedButton.value, selectedBtn!)
      }
    }

    console.log(`✅ Dynamic updates started for ${updateIntervals.value.size} buttons`)
  }

  const stopDynamicUpdates = () => {
    updateIntervals.value.forEach(interval => clearInterval(interval))
    updateIntervals.value.clear()
    dynamicButtonValues.value.clear()
  }

  const stopDynamicUpdateForButton = (position: number) => {
    const interval = updateIntervals.value.get(position)
    if (interval) {
      clearInterval(interval)
      updateIntervals.value.delete(position)
      dynamicButtonValues.value.delete(position)
      console.log(`🛑 Stopped dynamic updates for button at position ${position}`)
    }
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

  const updateStreamDeckButtons = async () => {
    try {
      console.log('🎛️ updateStreamDeckButtons called - checking if StreamDeck is connected...');
      
      // Verificar si hay un StreamDeck conectado primero
      const statusResponse = await fetch(`${API_BASE.value}/devices/streamdeck/status`);
      const status = await statusResponse.json();
      
      if (!status.isConnected) {
        console.log('🎛️ StreamDeck not connected, skipping update');
        return;
      }
      
      console.log('🎛️ StreamDeck is connected, proceeding with update...');

      // Calcular qué posiciones tienen botones configurados
      const buttonStates = [];
      const totalButtons = gridCols.value * gridRows.value;

      console.log(`🎛️ Calculating button states for ${totalButtons} positions (${gridCols.value}x${gridRows.value})`);
      console.log(`📊 Current buttons in page:`, currentButtons.value.length);

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

          console.log(`Button ${i}: exists=${!!button}, hasContent=${hasContent}`, {
            label: button.data.label,
            textTop: button.data.textTop,
            textBottom: button.data.textBottom,
            emoji: button.data.emoji,
            icon: button.data.icon,
            actionsCount: button.data.actions?.length || 0
          });
        } else {
          console.log(`Button ${i}: no button data`);
        }

        buttonStates.push(hasContent);
      }

      console.log('🎛️ Final button states for StreamDeck:', buttonStates);

      // Enviar al daemon
      console.log('🎛️ Sending button states to daemon...');
      await apiRequest('/devices/streamdeck/update-buttons', {
        method: 'POST',
        body: JSON.stringify({ buttonStates, pageId: currentPage.value?.id })
      });

      console.log('✅ StreamDeck buttons updated successfully');
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
    saveTimeout
  }
}