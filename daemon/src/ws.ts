import { v4 as uuidv4 } from 'uuid';
import { streamDeckDriver } from './hw-driver/streamdeck-driver';
import { windowWatcher } from './window-watcher';
import { DatabaseService } from './db';
import { parseLayoutMode, resolvePageSize, isHardwareDeviceId } from './devices';
import { getEventBus, BUS_WS_FORWARD, busWsTopic, type EventBus } from './events/bus';
import { resolveNavTargets, normalizeDeviceKind, type NavTargets } from './sessions';

export interface WebSocketMessage {
  type: string;
  payload?: any;
  id?: string;
}

export interface WebSocketClient {
  id: string;
  ws: any; // Bun WebSocket
  subscriptions: Set<string>;
  /** Identificador estable del dispositivo (sobrevive reconexiones). */
  deviceId: string;
  /** kind: 'browser' | 'hardware' | 'relay' | 'cli' | ... */
  kind: string;
  name: string | null;
  /** Vista propia de la sesión (independiente por dispositivo). */
  profileId: string | null;
  pageId: string | null;
  connectedAt: number;
  lastSeen: number;
  /** 'ws' | 'tunnel' */
  source: string;
}

export interface SessionView {
  clientId?: string;
  clientIds?: string[];
  deviceId: string;
  kind: string;
  name: string | null;
  profileId: string | null;
  pageId: string | null;
  startupProfileId: string | null;
  subscriptions: string[];
  connectedAt: number;
  lastSeen: number;
  source: string;
  connected: boolean;
}

export class WebSocketManager {
  private server: any;
  private clients: Map<string, WebSocketClient> = new Map();
  private db: DatabaseService;
  private port: number;

  constructor(port: number) {
    this.port = port;
    this.db = new DatabaseService();
    this.setupWebSocket();
  }

  private setupWebSocket() {
    this.server = Bun.serve({
      port: this.port,
      fetch: (req, server) => {
        // Upgrade the request to a WebSocket
        if (server.upgrade(req)) {
          return; // do not return a Response
        }
        return new Response('WebSocket server', { status: 200 });
      },
      websocket: {
        message: (ws: any, message: string) => {
          try {
            const clientData = this.getClientByWs(ws);
            if (clientData) {
              clientData.lastSeen = Date.now();
              const parsedMessage: WebSocketMessage = JSON.parse(message);
              this.handleClientMessage(clientData.id, parsedMessage);
            }
          } catch (error) {
            console.error('Invalid WebSocket message:', error);
            ws.send(JSON.stringify({
              type: 'error',
              payload: { message: 'Invalid message format' }
            }));
          }
        },
        open: (ws: any) => {
          const clientId = uuidv4();
          const client: WebSocketClient = {
            id: clientId,
            ws,
            subscriptions: new Set(),
            // deviceId provisional: el cliente lo fija con `hello`
            // (o se queda el clientId si nunca se identifica).
            deviceId: clientId,
            kind: 'unknown',
            name: null,
            profileId: this.currentGlobalProfileId(),
            pageId: this.currentGlobalPageId(),
            connectedAt: Date.now(),
            lastSeen: Date.now(),
            source: 'ws',
          };

          this.clients.set(clientId, client);

          // Aviso interno para flujos (canal client-connected del bus);
          // el 'connected' de abajo sigue siendo el handshake del socket.
          try { getEventBus().emit('client-connected', { clientId }); } catch { /* noop */ }

          // Enviar mensaje de bienvenida (incluye la vista inicial)
          ws.send(JSON.stringify({
            type: 'connected',
            payload: {
              clientId,
              deviceId: client.deviceId,
              profileId: client.profileId,
              pageId: client.pageId,
              timestamp: Date.now(),
            }
          }));
        },
        close: (ws: any) => {
          const clientData = this.getClientByWs(ws);
          if (clientData) {
            this.clients.delete(clientData.id);
          }
        }
      }
    });

  }

  private getClientByWs(ws: any): WebSocketClient | null {
    for (const client of this.clients.values()) {
      if (client.ws === ws) {
        return client;
      }
    }
    return null;
  }

  private currentGlobalProfileId(): string | null {
    try {
      const v = this.db.getSetting('current.profile_id');
      return v && v !== 'null' && v !== '' ? v : null;
    } catch { return null; }
  }

  private currentGlobalPageId(): string | null {
    try {
      const v = this.db.getSetting('current.page_id');
      return v && v !== 'null' && v !== '' ? v : null;
    } catch { return null; }
  }

  /** Primera página no-carpeta del perfil (fallback de vista inicial). */
  private firstPageOfProfile(profileId: string): string | null {
    try {
      const pages = this.db.getPagesByProfile(profileId);
      const page = pages.find((p) => p.is_folder === 0) || pages[0];
      return page ? page.id : null;
    } catch { return null; }
  }

  private handleClientMessage(clientId: string, message: WebSocketMessage) {
    const client = this.clients.get(clientId);
    if (!client) return;

    switch (message.type) {
      case 'hello':
      case 'register':
      case 'identify':
        this.handleHello(clientId, message.payload ?? {});
        break;

      case 'session.get':
        this.sendToClient(clientId, {
          type: 'session.state',
          payload: this.sessionPayloadFor(client),
        });
        break;

      case 'subscribe':
        this.handleSubscription(clientId, message.payload?.topics || []);
        break;

      case 'unsubscribe':
        this.handleUnsubscription(clientId, message.payload?.topics || []);
        break;

      case 'flow.cancel': {
        const { runId } = message.payload ?? {};
        let cancelled = false;
        try {
          cancelled = !!(globalThis as any).__libredeckRunner?.cancelFlow?.(runId);
        } catch { /* mejor esfuerzo */ }
        this.sendToClient(clientId, {
          type: 'flow.cancelled',
          payload: { runId, cancelled },
        });
        break;
      }

      case 'button.press':
        this.handleButtonPress(clientId, message.payload);
        break;

      case 'variable.set':
        void this.handleVariableSet(clientId, message.payload);
        break;

      case 'page.select': {
        const { pageId } = message.payload ?? {};
        if (!pageId || typeof pageId !== 'string') {
          this.sendToClient(clientId, { type: 'error', payload: { message: 'pageId required' } });
          break;
        }
        const targets = resolveNavTargets(message.payload, client.deviceId);
        const res = this.navigatePageTo({ pageId, originDeviceId: client.deviceId, targets });
        if (!res.ok) {
          this.sendToClient(clientId, { type: 'error', payload: { message: res.error } });
        }
        break;
      }

      case 'profile.select': {
        const { profileId } = message.payload ?? {};
        if (!profileId || typeof profileId !== 'string') {
          this.sendToClient(clientId, { type: 'error', payload: { message: 'profileId required' } });
          break;
        }
        const targets = resolveNavTargets(message.payload, client.deviceId);
        const res = this.navigateProfileTo({ profileId, originDeviceId: client.deviceId, targets });
        if (!res.ok) {
          this.sendToClient(clientId, { type: 'error', payload: { message: res.error } });
        }
        break;
      }

      default:
        this.sendToClient(clientId, {
          type: 'error',
          payload: { message: `Unknown message type: ${message.type}` }
        });
    }
  }

  /**
   * Registro/identificación de sesión (`hello`).
   * Fija el `deviceId` estable, restaura la vista persistida (reconexión) o
   * aplica el `startupProfileId` asignado; responde con `session.state`.
   */
  private handleHello(clientId: string, payload: any): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const rawId = typeof payload?.deviceId === 'string' && payload.deviceId.length > 0
      ? payload.deviceId
      : (typeof payload?.device_id === 'string' && payload.device_id.length > 0 ? payload.device_id : null);
    const deviceId = rawId || client.deviceId;
    const kind = normalizeDeviceKind(payload?.kind ?? client.kind);
    const name = typeof payload?.name === 'string' && payload.name.length > 0 ? payload.name : client.name;

    client.deviceId = deviceId;
    client.kind = kind;
    client.name = name;
    client.lastSeen = Date.now();

    // Persistir identidad (crea la fila si no existe)
    const persisted = this.db.upsertDeviceSession({ device_id: deviceId, name, kind });

    // Vista: explícita en hello > persistida > startup asignado > global actual
    let profileId: string | null =
      (typeof payload?.profileId === 'string' && payload.profileId) ? payload.profileId :
      (typeof payload?.profile_id === 'string' && payload.profile_id) ? payload.profile_id :
      persisted.profile_id;
    let pageId: string | null =
      (typeof payload?.pageId === 'string' && payload.pageId) ? payload.pageId :
      (typeof payload?.page_id === 'string' && payload.page_id) ? payload.page_id :
      persisted.page_id;

    const startup = typeof payload?.startupProfileId === 'string' && payload.startupProfileId
      ? payload.startupProfileId
      : persisted.startup_profile_id;
    if (payload?.startupProfileId !== undefined) {
      this.db.upsertDeviceSession({ device_id: deviceId, startup_profile_id: payload.startupProfileId || null });
    }

    if (!profileId && startup) profileId = startup;
    // Validar que el perfil/página existen; si no, caer al global
    if (profileId && !this.db.getProfile(profileId)) profileId = null;
    if (profileId && pageId) {
      const page = this.db.getPage(pageId);
      if (!page || page.profile_id !== profileId) {
        pageId = this.firstPageOfProfile(profileId);
      }
    }
    if (profileId && !pageId) {
      pageId = this.firstPageOfProfile(profileId) ?? this.currentGlobalPageId();
    }
    if (!profileId) {
      profileId = this.currentGlobalProfileId();
      if (profileId && !pageId) pageId = this.firstPageOfProfile(profileId);
      if (!pageId) pageId = this.currentGlobalPageId();
    }

    client.profileId = profileId;
    client.pageId = pageId;
    this.db.upsertDeviceSession({ device_id: deviceId, name, kind, profile_id: profileId, page_id: pageId });

    this.sendToClient(clientId, {
      type: 'session.state',
      payload: this.sessionPayloadFor(client),
    });
  }

  private sessionPayloadFor(client: WebSocketClient): any {
    const persisted = this.db.getDeviceSession(client.deviceId);
    return {
      clientId: client.id,
      deviceId: client.deviceId,
      kind: client.kind,
      name: client.name,
      profileId: client.profileId,
      pageId: client.pageId,
      startupProfileId: persisted?.startup_profile_id ?? null,
    };
  }

  /** deviceIds conectados de un dispositivo. */
  private clientsOfDevice(deviceId: string): WebSocketClient[] {
    return [...this.clients.values()].filter((c) => c.deviceId === deviceId);
  }

  /**
   * ¿Debe el HW físico ignorar esta página? Un Stream Deck solo admite
   * cuadrícula con su tamaño exacto. Sin HW conectado (sin geometría
   * detectada) no se puede saber: no se bloquea.
   * Devuelve el motivo o null si puede mostrarse.
   */
  private hwBlockReason(page: { id?: string; profile_id?: string; data: any; grid_cols?: number | null; grid_rows?: number | null } | null): string | null {
    if (!page) return null;
    let grid: { cols: number; rows: number } | null = null;
    try {
      grid = streamDeckDriver.getGridGeometry();
    } catch { grid = null; }
    if (!grid) return null;
    if (parseLayoutMode(page.data) !== 'classic') {
      return 'está en modo libre y un Stream Deck solo admite cuadrícula';
    }
    // El tamaño de la página hereda del perfil si no lo fija ella.
    let profileData: any = undefined;
    try {
      if (page.profile_id) profileData = this.db.getProfile(page.profile_id)?.data;
    } catch { /* mejor esfuerzo */ }
    const size = resolvePageSize(
      { grid_cols: page.grid_cols ?? null, grid_rows: page.grid_rows ?? null },
      profileData,
    );
    if (size.cols !== grid.cols || size.rows !== grid.rows) {
      return `es de ${size.cols}×${size.rows} y el Stream Deck es de ${grid.cols}×${grid.rows}`;
    }
    return null;
  }

  /** Repintado HW con guarda de compatibilidad (no rompe la navegación). */
  private repaintHw(pageId: string, pageName?: string): void {
    const page = this.db.getPage(pageId);
    const reason = this.hwBlockReason(page);
    if (reason) {
      console.warn(`🚫 HW repaint bloqueado: la página «${page?.name ?? pageId}» ${reason}`);
      this.broadcast('page.blocked', { pageId, reason, pageName: pageName ?? page?.name ?? null }, 'pages');
      return;
    }
    streamDeckDriver.scheduleUpdateFromPage(pageId);
  }

  /**
   * Navegación dirigida a página. Por defecto solo el dispositivo que ejecuta;
   * `targets` acepta `{kind:'devices',ids}` o `{kind:'all'}` (broadcast).
   * Mantiene compat: emite `page.navigate` y actualiza `current.page_id`
   * global cuando el origen navega él mismo o hay broadcast.
   */
  public navigatePageTo(opts: {
    pageId: string;
    pageName?: string;
    originDeviceId?: string | null;
    targets?: NavTargets;
    context?: any;
  }): { ok: boolean; error?: string; deliveredTo?: string[]; profileId?: string } {
    const page = this.db.getPage(opts.pageId);
    if (!page) return { ok: false, error: `Page not found: ${opts.pageId}` };
    const origin = opts.originDeviceId ?? null;
    const targets = opts.targets ?? (origin ? { kind: 'self' as const } : { kind: 'all' as const });
    // Sin origen conocido (REST) + sin destino explícito = broadcast (compat).
    // Con destino explícito se respeta aunque no haya origen.
    const expanded: string[] | 'all' =
      targets.kind === 'all' ? 'all'
      : targets.kind === 'devices' ? (targets.ids.length > 0 ? targets.ids : 'all')
      : origin ? [origin] : 'all';

    const deviceIds: string[] = expanded === 'all'
      ? [...new Set([...this.clients.values()].map((c) => c.deviceId))]
      : expanded;

    const delivered: string[] = [];
    for (const deviceId of deviceIds) {
      this.db.upsertDeviceSession({ device_id: deviceId, profile_id: page.profile_id, page_id: page.id });
      const conns = this.clientsOfDevice(deviceId);
      for (const conn of conns) {
        conn.profileId = page.profile_id;
        conn.pageId = page.id;
        conn.lastSeen = Date.now();
        // Dirigido: entrega directa (es un comando, no un broadcast
        // temático). En 'all' se respeta la suscripción a 'pages' (compat).
        const subscribed = conn.subscriptions.has('pages');
        if (expanded !== 'all' || subscribed || (origin && conn.deviceId === origin)) {
          this.sendToClient(conn.id, {
            type: 'page.navigate',
            payload: {
              pageId: page.id,
              pageName: opts.pageName,
              profileId: page.profile_id,
              targetDeviceId: deviceId,
              originDeviceId: origin,
              context: opts.context,
            },
            id: uuidv4(),
          });
          if (!delivered.includes(deviceId)) delivered.push(deviceId);
        }
      }
      // Sin conexión activa pero sesión persistida: queda guardada para la
      // reconexión (el HW la lee al repintar).
      if (this.clientsOfDevice(deviceId).length === 0 && this.db.getDeviceSession(deviceId)) {
        if (!delivered.includes(deviceId)) delivered.push(deviceId);
      }
    }

    // Compat global: el origen navegando él mismo o un broadcast actualizan
    // los settings `current.*` que leen integraciones antiguas y el driver.
    if (!origin || expanded === 'all' || (Array.isArray(expanded) && expanded.includes(origin))) {
      this.db.setCurrentPage(page.id);
    }

    // Repintar HW solo si un dispositivo hardware es objetivo.
    const hwTargeted = deviceIds.some((id) =>
      this.clientsOfDevice(id).some((c) => c.kind === 'hardware') ||
        id === (streamDeckDriver as any)?.getDeviceId?.() ||
        id.startsWith('streamdeck') || id.startsWith('hw:') || id.startsWith('hardware:'),
    );
    if (hwTargeted || expanded === 'all') {
      this.repaintHw(page.id, opts.pageName);
    }

    return { ok: true, deliveredTo: delivered, profileId: page.profile_id };
  }

  /**
   * Navegación dirigida a perfil. Emite `profile.navigate` (compat) y
   * actualiza `current.profile_id` global + windowWatcher cuando el origen
   * navega él mismo o hay broadcast.
   */
  public navigateProfileTo(opts: {
    profileId: string;
    originDeviceId?: string | null;
    targets?: NavTargets;
    context?: any;
  }): { ok: boolean; error?: string; deliveredTo?: string[]; pageId?: string | null } {
    const profile = this.db.getProfile(opts.profileId);
    if (!profile) return { ok: false, error: `Profile not found: ${opts.profileId}` };
    const origin = opts.originDeviceId ?? null;
    const targets = opts.targets ?? (origin ? { kind: 'self' as const } : { kind: 'all' as const });
    // Sin origen conocido (REST) + sin destino explícito = broadcast (compat).
    // Con destino explícito se respeta aunque no haya origen.
    const expanded: string[] | 'all' =
      targets.kind === 'all' ? 'all'
      : targets.kind === 'devices' ? (targets.ids.length > 0 ? targets.ids : 'all')
      : origin ? [origin] : 'all';

    const deviceIds: string[] = expanded === 'all'
      ? [...new Set([...this.clients.values()].map((c) => c.deviceId))]
      : expanded;

    // Página inicial del perfil para los objetivos (primera no-carpeta)
    const firstPage = this.firstPageOfProfile(profile.id);

    const delivered: string[] = [];
    for (const deviceId of deviceIds) {
      this.db.upsertDeviceSession({ device_id: deviceId, profile_id: profile.id, page_id: firstPage });
      const conns = this.clientsOfDevice(deviceId);
      for (const conn of conns) {
        conn.profileId = profile.id;
        if (firstPage) conn.pageId = firstPage;
        conn.lastSeen = Date.now();
        const subscribed = conn.subscriptions.has('profiles');
        if (expanded !== 'all' || subscribed || (origin && conn.deviceId === origin)) {
          this.sendToClient(conn.id, {
            type: 'profile.navigate',
            payload: {
              profileId: profile.id,
              pageId: firstPage ?? undefined,
              targetDeviceId: deviceId,
              originDeviceId: origin,
              context: opts.context,
            },
            id: uuidv4(),
          });
          if (!delivered.includes(deviceId)) delivered.push(deviceId);
        }
      }
      if (this.clientsOfDevice(deviceId).length === 0 && this.db.getDeviceSession(deviceId)) {
        if (!delivered.includes(deviceId)) delivered.push(deviceId);
      }
    }

    if (!origin || expanded === 'all' || (Array.isArray(expanded) && expanded.includes(origin))) {
      this.db.setCurrentProfile(profile.id);
      windowWatcher.setCurrentProfile(profile.id);
    }

    const hwTargeted = deviceIds.some((id) =>
      this.clientsOfDevice(id).some((c) => c.kind === 'hardware') ||
        id === (streamDeckDriver as any)?.getDeviceId?.() ||
        id.startsWith('streamdeck') || id.startsWith('hw:') || id.startsWith('hardware:'),
    );
    if ((hwTargeted || expanded === 'all') && firstPage) {
      this.repaintHw(firstPage);
    }

    return { ok: true, deliveredTo: delivered, pageId: firstPage };
  }

  /** Vista actual de un dispositivo (memoria; si no, persistida). */
  public getSessionView(deviceId: string): { profileId: string | null; pageId: string | null } | null {
    const conns = this.clientsOfDevice(deviceId);
    if (conns.length > 0) {
      return { profileId: conns[0].profileId, pageId: conns[0].pageId };
    }
    const persisted = this.db.getDeviceSession(deviceId);
    if (!persisted) return null;
    return { profileId: persisted.profile_id, pageId: persisted.page_id };
  }

  /**
   * Fija la vista de un dispositivo y (por defecto) se la notifica con
   * `page.navigate`/`profile.navigate` dirigidos.
   */
  public setSessionView(
    deviceId: string,
    view: { profileId?: string | null; pageId?: string | null; startupProfileId?: string | null; name?: string; kind?: string },
    opts?: { notify?: boolean },
  ): { ok: boolean; error?: string } {
    if (view.profileId !== undefined && view.profileId !== null && !this.db.getProfile(view.profileId)) {
      return { ok: false, error: `Profile not found: ${view.profileId}` };
    }
    if (view.pageId !== undefined && view.pageId !== null && !this.db.getPage(view.pageId)) {
      return { ok: false, error: `Page not found: ${view.pageId}` };
    }
    // El HW físico no puede mostrar páginas en modo libre ni de otro tamaño:
    // se rechaza aquí para que la sesión no quede en una página imposible.
    if (view.pageId !== undefined && view.pageId !== null && isHardwareDeviceId(deviceId)) {
      const reason = this.hwBlockReason(this.db.getPage(view.pageId));
      if (reason) {
        const name = this.db.getPage(view.pageId)?.name ?? view.pageId;
        return { ok: false, error: `La página «${name}» ${reason}` };
      }
    }
    this.db.upsertDeviceSession({
      device_id: deviceId,
      profile_id: view.profileId !== undefined ? view.profileId : undefined,
      page_id: view.pageId !== undefined ? view.pageId : undefined,
      startup_profile_id: view.startupProfileId !== undefined ? view.startupProfileId : undefined,
      name: view.name,
      kind: view.kind ? normalizeDeviceKind(view.kind) : undefined,
    });
    const conns = this.clientsOfDevice(deviceId);
    for (const conn of conns) {
      if (view.profileId !== undefined) conn.profileId = view.profileId;
      if (view.pageId !== undefined) conn.pageId = view.pageId;
    }
    if (opts?.notify !== false) {
      if (view.pageId !== undefined && view.pageId !== null) {
        this.navigatePageTo({ pageId: view.pageId, targets: { kind: 'devices', ids: [deviceId] } });
      } else if (view.profileId !== undefined && view.profileId !== null) {
        this.navigateProfileTo({ profileId: view.profileId, targets: { kind: 'devices', ids: [deviceId] } });
      }
    }
    return { ok: true };
  }

  /** Lista clientes conectados + su vista actual (para GET /sessions). */
  public getSessions(): SessionView[] {
    const persisted = new Map(this.db.listDeviceSessions().map((s) => [s.device_id, s]));
    const views: SessionView[] = [];
    for (const client of this.clients.values()) {
      const p = persisted.get(client.deviceId);
      views.push({
        clientId: client.id,
        deviceId: client.deviceId,
        kind: client.kind,
        name: client.name,
        profileId: client.profileId,
        pageId: client.pageId,
        startupProfileId: p?.startup_profile_id ?? null,
        subscriptions: Array.from(client.subscriptions),
        connectedAt: client.connectedAt,
        lastSeen: client.lastSeen,
        source: client.source,
        connected: true,
      });
      persisted.delete(client.deviceId);
    }
    // Sesiones persistidas sin conexión (p. ej. HW apagado): también se listan
    for (const s of persisted.values()) {
      views.push({
        deviceId: s.device_id,
        kind: s.kind ?? 'unknown',
        name: s.name,
        profileId: s.profile_id,
        pageId: s.page_id,
        startupProfileId: s.startup_profile_id,
        subscriptions: [],
        connectedAt: s.updated_at,
        lastSeen: s.updated_at,
        source: 'persisted',
        connected: false,
      });
    }
    return views;
  }

  private handleSubscription(clientId: string, topics: string[]) {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Sin console.log por suscripción (ruta caliente: cada reconexión del
    // panel spameaba el log). Solo se conserva el error ante formato inválido.
    topics.forEach(topic => {
      client.subscriptions.add(topic);
    });

    this.sendToClient(clientId, {
      type: 'subscribed',
      payload: { topics, subscriptions: Array.from(client.subscriptions) }
    });
  }

  private handleUnsubscription(clientId: string, topics: string[]) {
    const client = this.clients.get(clientId);
    if (!client) return;

    topics.forEach(topic => {
      client.subscriptions.delete(topic);
    });

    this.sendToClient(clientId, {
      type: 'unsubscribed',
      payload: { topics, subscriptions: Array.from(client.subscriptions) }
    });
  }

  private async handleButtonPress(clientId: string, payload: any) {
    const client = this.clients.get(clientId);
    const { buttonId, pageId, profileId, pressType = 'short' } = payload;

    // Ruta caliente: un addLog por pulsación (INSERT + broadcast log.created
    // a todos los suscritos a 'logs') convertía cada press en tormenta IO/WS.
    // Solo se registra si se pide explícito (diagnóstico); errores se loguean siempre.
    if (process.env.LIBREDECK_LOG_PRESSES === '1') {
      this.db.addLog({
        level: 'info',
        message: `Button pressed: ${buttonId}`,
        meta: { clientId, deviceId: client?.deviceId, pageId, profileId, pressType },
        ts: Date.now()
      });
    }

    // Emitir evento a clientes suscritos
    this.broadcast('button.pressed', {
      buttonId,
      pageId,
      profileId,
      pressType,
      timestamp: Date.now(),
      clientId,
      deviceId: client?.deviceId,
    });
  }

  // Métodos públicos para enviar eventos desde otras partes del daemon
  public sendToClient(clientId: string, message: WebSocketMessage): boolean {
    const client = this.clients.get(clientId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      client.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error(`Failed to send message to client ${clientId}:`, error);
      return false;
    }
  }

  /** Envía a todos los WS conectados de un dispositivo (o false si offline). */
  public sendToDevice(deviceId: string, message: WebSocketMessage): boolean {
    const conns = this.clientsOfDevice(deviceId);
    if (conns.length === 0) return false;
    let ok = false;
    for (const conn of conns) {
      if (this.sendToClient(conn.id, message)) ok = true;
    }
    return ok;
  }

  public broadcast(eventType: string, payload: any, topic?: string): void {
    const message: WebSocketMessage = {
      type: eventType,
      payload,
      id: uuidv4()
    };

    this.clients.forEach((client, clientId) => {
      // Si hay un topic específico, solo enviar a clientes suscritos
      if (topic && !client.subscriptions.has(topic)) {
        return;
      }

      this.sendToClient(clientId, message);
    });
  }

  public broadcastProfileUpdate(profileId: string, profile: any): void {
    this.broadcast('profile.updated', { profileId, profile }, 'profiles');
  }

  public broadcastPageCreated(pageId: string, page: any): void {
    this.broadcast('page.created', { pageId, page }, 'pages');
  }

  public broadcastPageUpdate(pageId: string, page: any): void {
    this.broadcast('page.updated', { pageId, page }, 'pages');
  }

  public broadcastPageDeleted(pageId: string): void {
    this.broadcast('page.deleted', { pageId }, 'pages');
  }

  public broadcastButtonUpdate(buttonId: string, button: any, mutationId?: string): void {
    // pageId+mutationId+timestamp siempre: el cliente filtra ecos sin
    // cambiar el protocolo (solo campos aditivos).
    const pageId = (button as any)?.page_id ?? (button as any)?.pageId ?? null;
    if (this.dropExactDuplicate(`button.updated:${buttonId}`, { buttonId, pageId, button, mutationId })) return;
    this.broadcast('button.updated', { buttonId, button, pageId, mutationId, timestamp: Date.now() }, 'buttons');
  }

  public broadcastButtonDeleted(buttonId: string, mutationId?: string, pageId?: string | null): void {
    if (this.dropExactDuplicate(`button.deleted:${buttonId}`, { buttonId, pageId: pageId ?? null, mutationId })) return;
    this.broadcast('button.deleted', { buttonId, pageId: pageId ?? null, mutationId, timestamp: Date.now() }, 'buttons');
  }

  public broadcastButtonsReordered(pageId: string, buttons: any, mutationId?: string, pageVersion?: number): void {
    if (this.dropExactDuplicate(`buttons.reordered:${pageId}`, { pageId, buttons, mutationId })) return;
    this.broadcast('buttons.reordered', { pageId, buttons, mutationId, pageVersion: pageVersion ?? Date.now(), timestamp: Date.now() }, 'buttons');
  }

  /**
   * Coalescencia de ráfagas (Fase C+D): si el MISMO payload se repite en
   * <250ms (ecos button.updated/created/deleted/reordered), se descarta el
   * duplicado. Nunca retrasa la primera entrega; solo poda duplicados
   * exactos. Ventana acotada y mapa con tope para no crecer sin límite.
   */
  private lastBroadcast = new Map<string, { json: string; at: number }>();
  private static readonly DEDUPE_WINDOW_MS = 250;
  private static readonly DEDUPE_MAX_KEYS = 500;

  private dropExactDuplicate(key: string, payload: unknown): boolean {
    try {
      const json = JSON.stringify(payload);
      const now = Date.now();
      const prev = this.lastBroadcast.get(key);
      if (prev && now - prev.at < WebSocketManager.DEDUPE_WINDOW_MS && prev.json === json) {
        return true;
      }
      if (this.lastBroadcast.size >= WebSocketManager.DEDUPE_MAX_KEYS) this.lastBroadcast.clear();
      this.lastBroadcast.set(key, { json, at: now });
      return false;
    } catch {
      return false; // ante cualquier duda, emitir
    }
  }

  public broadcastActionStarted(actionId: string, context: any): void {
    this.broadcast('action.started', { actionId, context, timestamp: Date.now() });
  }

  public broadcastActionFinished(actionId: string, result: any): void {
    this.broadcast('action.finished', { actionId, result, timestamp: Date.now() });
  }

  public broadcastActionError(actionId: string, error: any): void {
    this.broadcast('action.error', { actionId, error, timestamp: Date.now() });
  }

  // ---- Motor de flujos ----

  public broadcastPluginInstalled(pluginId: string, plugin: any): void {
    this.broadcast('plugin.installed', { pluginId }, 'plugins');
  }

  public broadcastPluginEnabled(pluginId: string, enabled: boolean): void {
    this.broadcast('plugin.enabled', { pluginId, enabled }, 'plugins');
  }

  public broadcastPluginUninstalled(pluginId: string): void {
    this.broadcast('plugin.uninstalled', { pluginId }, 'plugins');
  }

  public broadcastPluginStatus(pluginId: string, status: string, error?: string | null): void {
    this.broadcast('plugin.status', { pluginId, status, error: error ?? null }, 'plugins');
  }

  public broadcastPluginSettings(pluginId: string): void {
    this.broadcast('plugin.settings', { pluginId }, 'plugins');
  }

  public broadcastLog(entry: { level: string; message: string; meta?: any; ts: number }): void {
    this.broadcast('log.created', entry, 'logs');
  }

  /** Progreso de backup/restore (topic `backups`): started → progress* → done|error. */
  public broadcastBackupProgress(stage: string, done: number, total: number, message?: string): void {
    this.broadcast('backup.progress', { stage, done, total, message: message ?? '', timestamp: Date.now() }, 'backups');
  }

  /** Eventos del módulo remoto E2E (topic `remote`): paired/received/executed. */
  public broadcastRemote(event: 'remote.paired' | 'remote.received' | 'remote.executed', payload: any): void {
    this.broadcast(event, payload, 'remote');
  }

  // ---- Servicio daemon de variables + bus interno de eventos ----

  /** Notifica un cambio de variable (topic `variables`). */
  public broadcastVariableChanged(payload: any): void {
    this.broadcast('variable.changed', payload, 'variables');
  }

  public broadcastVariableDeleted(payload: any): void {
    this.broadcast('variable.deleted', payload, 'variables');
  }

  /** Eventos genéricos del bus interno (topic `events`). */
  public broadcastBusEvent(event: string, payload: any): void {
    this.broadcast(event, payload, 'events');
  }

  private busUnsub: (() => void) | null = null;

  /**
   * Puentea el bus interno al WS (idempotente): variable-changed →
   * `variable.changed` (topic `variables`); integration/timer/calendar/
   * media/flow.executed → `event.*` (topic `events`).
   */
  public attachEventBus(bus?: EventBus): void {
    if (this.busUnsub) return;
    const b = bus ?? getEventBus();
    const offs: Array<() => void> = [];
    for (const [type, wsEvent] of Object.entries(BUS_WS_FORWARD)) {
      offs.push(b.on(type, (p) => this.broadcast(wsEvent, p, busWsTopic(type))));
    }
    this.busUnsub = () => { offs.forEach((o) => o()); this.busUnsub = null; };
  }

  /** `variable.set` desde un cliente: { name, value?, expr?, toggle?, scope?, scopeId? }. */
  private async handleVariableSet(clientId: string, payload: any): Promise<void> {
    try {
      const { getVariableStore } = await import('./variables/store');
      const store = getVariableStore();
      const name = String(payload?.name ?? '');
      if (!name) throw new Error('name requerido');
      const addr = { scope: payload?.scope, scopeId: payload?.scopeId, source: `ws:${clientId}` };
      let def;
      if (payload?.toggle) {
        def = await store.toggle(name, addr);
      } else if (payload?.expr !== undefined) {
        const value = store.evalExpr(String(payload.expr), addr.scope, addr.scopeId);
        def = await store.set(name, value, addr);
      } else {
        def = await store.set(name, payload?.value, addr);
      }
      this.sendToClient(clientId, { type: 'variable.set.result', payload: { variable: def } });
    } catch (error) {
      this.sendToClient(clientId, {
        type: 'error',
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  // ---- Puente del túnel remoto (remote/tunnel.ts) ----
  //
  // El relay expone la web/API local a través de `TunnelClient`: cada
  // `ws-open` del relay se registra aquí como un cliente local más (con un
  // `ws` falso cuyo `send` reenvía al relay como `ws-msg`). Así recibe los
  // mismos broadcasts y suscripciones que un navegador local, sin duplicar
  // la lógica de `handleClientMessage`/`broadcast`.

  /** Registra un cliente virtual del túnel. Devuelve el clientId local. */
  public createTunnelClient(tunnelId: string, send: (text: string) => void): string {
    const clientId = `tunnel:${tunnelId}`;
    const fakeWs: any = {
      readyState: 1, // WebSocket.OPEN
      send: (text: string) => { try { send(String(text)); } catch { /* noop */ } },
      close: () => { this.clients.delete(clientId); },
    };
    this.clients.set(clientId, {
      id: clientId,
      ws: fakeWs,
      subscriptions: new Set(),
      deviceId: clientId,
      kind: 'relay',
      name: null,
      profileId: this.currentGlobalProfileId(),
      pageId: this.currentGlobalPageId(),
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      source: 'tunnel',
    });
    return clientId;
  }

  /** Elimina el cliente virtual del túnel. */
  public removeTunnelClient(tunnelId: string): void {
    this.clients.delete(`tunnel:${tunnelId}`);
  }

  /** Trata un mensaje del túnel como si lo hubiera enviado un cliente local. */
  public handleTunnelMessage(tunnelId: string, text: string): void {
    const clientId = `tunnel:${tunnelId}`;
    const client = this.clients.get(clientId);
    if (!client) return;
    client.lastSeen = Date.now();
    try {
      const parsed: WebSocketMessage = JSON.parse(text);
      this.handleClientMessage(clientId, parsed);
    } catch {
      try {
        client.ws.send(JSON.stringify({
          type: 'error',
          payload: { message: 'Invalid message format' },
        }));
      } catch { /* noop */ }
    }
  }

  public getConnectedClients(): number {
    return this.clients.size;
  }

  public getClientSubscriptions(clientId: string): string[] {
    const client = this.clients.get(clientId);
    return client ? Array.from(client.subscriptions) : [];
  }

  public close(): void {
    this.clients.forEach((client) => {
      client.ws.close();
    });
    this.clients.clear();
    if (this.server) {
      this.server.stop();
    }
  }
}
