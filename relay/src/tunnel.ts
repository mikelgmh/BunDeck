/**
 * Túnel inverso del relay (estilo ngrok): expone la web del daemon en
 * internet a través del relay, con aprobación explícita en el daemon.
 *
 * CONTRATO (fijo; daemon y navegador programan contra él):
 *
 *  WS relay↔daemon (mismo socket WS autenticado con RELAY_TOKEN, mensajes
 *  `v:1` + `kind`; el relay responde acks `{v:1, kind, ...}` que el daemon
 *  puede ignorar):
 *  - daemon→relay `{v:1, kind:'tunnel-register', deviceId}` →
 *    `{v:1, kind:'tunnel-registered', deviceId}`.
 *  - daemon→relay `{v:1, kind:'ui-publish', urlCode, exp}` (urlCode string
 *    12+ chars, exp epochMs) → `{v:1, kind:'ui-published', urlCode}`.
 *  - relay→daemon `{v:1, kind:'ui-request', reqId, urlCode, ua, ip}` (solo en
 *    la primera visita a `GET /ui/<urlCode>`).
 *  - daemon→relay `{v:1, kind:'ui-decision', reqId, allow}` →
 *    `{v:1, kind:'ui-decision-ack', reqId, allow}`. Sin decisión en 120 s
 *    (defecto) el poll pasa a `denied`.
 *  - daemon→relay `{v:1, kind:'ui-bind', urlCode, sessionToken, exp}`
 *    (sessionToken hex 32+ chars generado por el daemon) →
 *    `{v:1, kind:'ui-bound', urlCode}`.
 *  - daemon→relay `{v:1, kind:'ui-unbind', sessionToken}` → elimina el token
 *    Y su publicación (polls → `expired`, peticiones → 401).
 *  - relay→daemon `{v:1, kind:'http-req', id, method, path, headers, bodyB64}`
 *    y daemon→relay `{v:1, kind:'http-res', id, status, headers, bodyB64}`
 *    (timeout 30 s por defecto → 504).
 *  - WS tuneleado: navegador abre WS a `/t/<tok>/ws`; relay→daemon
 *    `{v:1, kind:'ws-open', id}` y bidireccional
 *    `{v:1, kind:'ws-msg', id, dataB64, isBinary}` en ambos sentidos;
 *    `{v:1, kind:'ws-close', id}` en ambos sentidos (daemon→relay aceptado
 *    como extensión para que el daemon pueda cerrar un puente).
 *  - Errores: `{v:1, kind:'error', error, detail?}` (`not-registered`,
 *    `bad-code`, `bad-exp`, `bad-token`, `bad-decision`, `unknown-code`,
 *    `unknown-request`, `unknown-token`, `stale-request`, `expired`,
 *    `unknown-kind`, `rate-limited`).
 *
 *  HTTP navegador→relay (público, sin RELAY_TOKEN; con rate-limit):
 *  - `GET /ui/<urlCode>` → página de espera (la sirve el handler registrado
 *    con `setUiPageHandler()`; sin handler → 404 `{error:'ui-page-missing'}`).
 *    La primera visita dispara `ui-request` al daemon.
 *  - `GET /ui/<urlCode>/status` → 200
 *    `{status:'pending'|'approved'|'denied'|'expired', sessionToken?}`.
 *    El token solo se entrega en el PRIMER poll tras aprobar.
 *  - Todo bajo `/t/<sessionToken>/<path>` (HTTP) y WS en `/t/<tok>/ws`.
 *    Token desconocido → 401 `{error:'invalid-token'}`; caducado → 401
 *    `{error:'expired'}`. Daemon offline → 502; sin respuesta → 504.
 *    En respuestas `text/html` se inyecta `<base href="/t/<tok>/">` tras el
 *    primer `<head…>` y se reescriben `href="/…"`, `src="/…"`,
 *    `action="/…"` a `/t/<tok>/…` (best-effort).
 *
 *  DESVIACIONES/EXTENSIONES respecto al contrato (justificadas):
 *  - Todos los mensajes relay↔daemon llevan `v:1` también en los que el
 *    contrato lo omite (normalización; el daemon solo necesita `kind`).
 *  - Acks (`tunnel-registered`, `ui-published`, `ui-decision-ack`,
 *    `ui-bound`, `ui-unbound`) y errores `{kind:'error'}`: no están en el
 *    contrato pero son necesarios para depurar; el daemon puede ignorarlos.
 *  - `ui-bind`/`ui-unbind`/`ui-publish` los acepta cualquier socket de
 *    daemon registrado (mismo RELAY_TOKEN compartido); el rigor por
 *    dispositivo no aporta con secreto compartido.
 *  - Republicar un `urlCode` reinicia su flujo y revoca sesiones/puentes
 *    anteriores de ese código (rotación limpia).
 *  - `ui-unbind` borra también la publicación del código (el contrato exige
 *    que los polls pasen a `expired`, y eso solo es posible sin publicación).
 *  - `ws-close` daemon→relay (extensión simétrica) para cierre iniciado por
 *    el daemon. Timeouts configurables (`uiRequestTimeoutMs` 120 s,
 *    `httpTimeoutMs` 30 s por defecto) para poder testearlos.
 *  - Rate-limit: mismas ventana/límite globales, claves `ui:<ip>` y `t:<ip>`
 *    separadas (documentado, no una ventana aparte).
 *  - Cuerpos HTTP > 5 MB → 413 (el WS no transporta streaming).
 *  - `GET /ui/<code>` de un código caducado → 404 `{error:'expired'}`;
 *    código jamás publicado → 404 `{error:'unknown-code'}`.
 */

export const UI_REQUEST_TIMEOUT_MS = 120_000;
export const HTTP_TIMEOUT_MS = 30_000;
export const MIN_URL_CODE_LEN = 12;
export const MIN_TOKEN_LEN = 32;
/** Cuerpo máximo aceptado en el proxy HTTP (el WS no hace streaming). */
export const MAX_TUNNEL_BODY_BYTES = 5 * 1024 * 1024;

/** Página de espera de `GET /ui/<urlCode>`; la implementa `waiting.ts`. */
export type UiPageHandler = (urlCode: string, req: Request) => Response | Promise<Response>;

let uiPageHandler: UiPageHandler | null = null;

/** Registra (o retira con `null`) la página de espera del túnel. */
export function setUiPageHandler(fn: UiPageHandler | null): void {
  uiPageHandler = fn;
}

export function getUiPageHandler(): UiPageHandler | null {
  return uiPageHandler;
}

/** Socket mínimo que el túnel necesita (vale `ServerWebSocket` de Bun). */
export interface TunnelSocket {
  send(data: string | Uint8Array | Buffer | ArrayBuffer): unknown;
  close(code?: number, reason?: string): unknown;
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  bodyB64: string | null;
}

interface HttpPending {
  deviceId: string;
  resolve: (r: HttpResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CodeEntry {
  deviceId: string;
  exp: number;
}

interface PendingReq {
  urlCode: string;
  deviceId: string;
  createdAt: number;
  state: 'pending' | 'denied';
  sent: boolean;
  ua: string;
  ip: string;
}

interface CodeBinding {
  sessionToken: string;
  exp: number;
  consumed: boolean;
}

interface SessionEntry {
  deviceId: string;
  exp: number;
  urlCode: string;
}

export interface TunnelStateOptions {
  now?: () => number;
  /** Sin decisión del daemon en este tiempo, el status pasa a `denied`. */
  uiRequestTimeoutMs?: number;
  genId?: (prefix: string) => string;
}

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

/** Inyecta `<base href="/t/<tok>/">` tras el primer `<head…>` (best-effort). */
export function injectBase(html: string, token: string): string {
  const prefix = `/t/${token}`;
  let out = html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<base href="${prefix}/">`);
  // Reescribe URLs absolutas de assets (`href="/…"`, `src="/…"`,
  // `action="/…"`) al prefijo del túnel: sin esto el navegador pediría
  // `/…` en la raíz del relay (404) en vez de `/t/<tok>/…` (proxy al daemon).
  // No toca `//…` (protocol-relative), `http:`, `data:`, `#…` ni rutas ya
  // prefijadas (`/t/…`, `/ui/…`).
  out = out.replace(
    /((?:href|src|action)\s*=\s*["'])\/(?!\/|t\/|ui\/)/gi,
    (_m, attr) => `${attr}${prefix}/`,
  );
  return out;
}

export function isHexToken(s: unknown, min = MIN_TOKEN_LEN): s is string {
  return typeof s === 'string' && s.length >= min && /^[0-9a-fA-F]+$/.test(s);
}

export type TunnelStatus = 'pending' | 'approved' | 'denied' | 'expired';

export class TunnelState {
  readonly httpPending = new Map<string, HttpPending>();
  readonly sessions = new Map<string, SessionEntry>();
  readonly devices = new Map<string, TunnelSocket>();
  private readonly wsDevices = new Map<TunnelSocket, Set<string>>();
  private readonly codes = new Map<string, CodeEntry>();
  private readonly pending = new Map<string, PendingReq>();
  private readonly pendingByCode = new Map<string, string>();
  private readonly bindings = new Map<string, CodeBinding>();
  /** URL-codes approved once; they cannot start another approval flow. */
  private readonly usedCodes = new Map<string, number>();
  private readonly bridges = new Map<string, { browser: TunnelSocket; deviceId: string; token: string }>();
  private readonly now: () => number;
  private readonly uiTimeout: number;
  private readonly genId: (prefix: string) => string;

  constructor(opts: TunnelStateOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.uiTimeout = opts.uiRequestTimeoutMs ?? UI_REQUEST_TIMEOUT_MS;
    this.genId =
      opts.genId ??
      ((p) => `${p}-${this.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`);
  }

  nextId(prefix: string): string {
    return this.genId(prefix);
  }

  // ---- registro de daemons ----

  registerDevice(ws: TunnelSocket, deviceId: string): void {
    const prev = this.devices.get(deviceId);
    if (prev && prev !== ws) {
      const set = this.wsDevices.get(prev);
      if (set) {
        set.delete(deviceId);
        if (set.size === 0) this.wsDevices.delete(prev);
      }
    }
    this.devices.set(deviceId, ws);
    let set = this.wsDevices.get(ws);
    if (!set) {
      set = new Set();
      this.wsDevices.set(ws, set);
    }
    set.add(deviceId);
  }

  private socketDevice(ws: TunnelSocket): string | undefined {
    const set = this.wsDevices.get(ws);
    if (!set || set.size === 0) return undefined;
    let last = '';
    for (const d of set) last = d;
    return last;
  }

  // ---- publicación de códigos ----

  publish(ws: TunnelSocket, urlCode: unknown, exp: unknown): { deviceId: string } | { error: string } {
    const deviceId = this.socketDevice(ws);
    if (!deviceId) return { error: 'not-registered' };
    if (typeof urlCode !== 'string' || urlCode.length < MIN_URL_CODE_LEN) return { error: 'bad-code' };
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return { error: 'bad-exp' };
    // Republicar reinicia el flujo y revoca sesiones/puentes de ese código.
    this.dropCode(urlCode);
    this.codes.set(urlCode, { deviceId, exp });
    return { deviceId };
  }

  // ---- flujo de aprobación ----

  ensureRequest(
    urlCode: string,
    meta: { ua: string; ip: string },
  ):
    | { error: 'unknown-code' | 'expired' }
    | {
        reqId: string;
        deviceId: string;
        created: boolean;
        state: 'pending' | 'denied' | 'bound';
        ua: string;
        ip: string;
       } {
    const now = this.now();
    const b = this.bindings.get(urlCode);
    const s = b ? this.sessions.get(b.sessionToken) : undefined;
    if (b && s && s.exp > now) {
      return { reqId: '', deviceId: s.deviceId, created: false, state: 'bound', ua: meta.ua, ip: meta.ip };
    }
    if (b) this.bindings.delete(urlCode);
    const usedUntil = this.usedCodes.get(urlCode);
    if (usedUntil !== undefined) {
      if (usedUntil > now) return { error: 'expired' };
      this.usedCodes.delete(urlCode);
    }
    const entry = this.codes.get(urlCode);
    if (!entry) return { error: 'unknown-code' };
    if (entry.exp <= now) {
      this.dropCode(urlCode);
      return { error: 'expired' };
    }
    const existingId = this.pendingByCode.get(urlCode);
    if (existingId) {
      const req = this.pending.get(existingId);
      if (req) {
        if (this.timedOut(req, now)) req.state = 'denied';
        return {
          reqId: existingId,
          deviceId: req.deviceId,
          created: false,
          state: req.state,
          ua: req.ua,
          ip: req.ip,
        };
      }
      this.pendingByCode.delete(urlCode);
    }
    const reqId = this.nextId('req');
    this.pending.set(reqId, {
      urlCode,
      deviceId: entry.deviceId,
      createdAt: now,
      state: 'pending',
      sent: false,
      ua: meta.ua,
      ip: meta.ip,
    });
    this.pendingByCode.set(urlCode, reqId);
    return { reqId, deviceId: entry.deviceId, created: true, state: 'pending', ua: meta.ua, ip: meta.ip };
  }

  markSent(reqId: string): void {
    const req = this.pending.get(reqId);
    if (req) req.sent = true;
  }

  /** Peticiones creadas mientras el daemon estaba offline (para reenviar al registrarse). */
  takeUnsent(deviceId: string): Array<{ reqId: string; urlCode: string; ua: string; ip: string }> {
    const out: Array<{ reqId: string; urlCode: string; ua: string; ip: string }> = [];
    for (const [reqId, req] of this.pending) {
      if (req.deviceId === deviceId && req.state === 'pending' && !req.sent) {
        req.sent = true;
        out.push({ reqId, urlCode: req.urlCode, ua: req.ua, ip: req.ip });
      }
    }
    return out;
  }

  decide(reqId: unknown, allow: unknown): 'ok' | 'unknown-request' | 'stale-request' | 'bad-decision' {
    if (typeof reqId !== 'string' || typeof allow !== 'boolean') return 'bad-decision';
    const req = this.pending.get(reqId);
    if (!req) return 'unknown-request';
    if (req.state !== 'pending' || this.timedOut(req, this.now())) {
      req.state = 'denied';
      return 'stale-request';
    }
    if (!allow) req.state = 'denied';
    return 'ok';
  }

  bind(urlCode: unknown, sessionToken: unknown, exp: unknown): 'ok' | string {
    if (!isHexToken(sessionToken)) return 'bad-token';
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return 'bad-exp';
    if (typeof urlCode !== 'string') return 'unknown-code';
    const entry = this.codes.get(urlCode);
    if (!entry) return 'unknown-code';
    if (entry.exp <= this.now()) {
      this.dropCode(urlCode);
      return 'expired';
    }
    const prev = this.bindings.get(urlCode);
    if (prev && prev.sessionToken !== sessionToken) this.dropSession(prev.sessionToken);
    this.sessions.set(sessionToken, { deviceId: entry.deviceId, exp, urlCode });
    this.bindings.set(urlCode, { sessionToken, exp, consumed: false });
    this.usedCodes.set(urlCode, entry.exp);
    const pendingId = this.pendingByCode.get(urlCode);
    if (pendingId) {
      this.pendingByCode.delete(urlCode);
      this.pending.delete(pendingId);
    }
    return 'ok';
  }

  /**
   * Da de baja un código publicado sin sesión (revocar código vigente).
   * Los polls pasan a `expired`.
   */
  unpublish(urlCode: unknown): boolean {
    if (typeof urlCode !== 'string' || urlCode === '') return false;
    if (!this.codes.has(urlCode)) return false;
    this.dropCode(urlCode);
    return true;
  }

  /**
   * Revoca el token Y su publicación: los polls del código pasan a
   * `expired` y las peticiones tuneleadas a 401 (exigido por contrato).
   */
  unbind(sessionToken: unknown): boolean {
    if (typeof sessionToken !== 'string') return false;
    const sess = this.sessions.get(sessionToken);
    if (!sess) return false;
    if (sess.urlCode) this.dropCode(sess.urlCode);
    else this.dropSession(sessionToken);
    return true;
  }

  status(urlCode: string): { status: TunnelStatus; sessionToken?: string } {
    const now = this.now();
    const b = this.bindings.get(urlCode);
    if (b) {
      const s = this.sessions.get(b.sessionToken);
      if (s && s.exp > now) {
        if (!b.consumed) {
          b.consumed = true;
          return { status: 'approved', sessionToken: b.sessionToken };
        }
        return { status: 'approved' };
      }
      this.bindings.delete(urlCode);
    }
    const usedUntil = this.usedCodes.get(urlCode);
    if (usedUntil !== undefined) {
      if (usedUntil > now) return { status: 'expired' };
      this.usedCodes.delete(urlCode);
    }
    const entry = this.codes.get(urlCode);
    if (!entry) return { status: 'expired' };
    if (entry.exp <= now) {
      this.dropCode(urlCode);
      return { status: 'expired' };
    }
    const reqId = this.pendingByCode.get(urlCode);
    if (reqId) {
      const req = this.pending.get(reqId);
      if (req) {
        if (req.state === 'denied' || this.timedOut(req, now)) {
          req.state = 'denied';
          return { status: 'denied' };
        }
        return { status: 'pending' };
      }
      this.pendingByCode.delete(urlCode);
    }
    return { status: 'pending' };
  }

  // ---- HTTP tuneleado ----

  takeHttp(id: string): HttpPending | undefined {
    const e = this.httpPending.get(id);
    if (e) {
      clearTimeout(e.timer);
      this.httpPending.delete(id);
    }
    return e;
  }

  /** Caducidad perezosa de sesión (acceso a `/t/*` con token expirado). */
  expireSession(token: string): void {
    const s = this.sessions.get(token);
    if (s && s.exp <= this.now()) this.dropSession(token);
  }

  // ---- puentes WS ----

  addBridge(id: string, browser: TunnelSocket, deviceId: string, token: string): void {
    this.bridges.set(id, { browser, deviceId, token });
  }

  getBridge(id: string): { browser: TunnelSocket; deviceId: string; token: string } | undefined {
    return this.bridges.get(id);
  }

  removeBridge(id: string): { browser: TunnelSocket; deviceId: string; token: string } | undefined {
    const e = this.bridges.get(id);
    if (e) this.bridges.delete(id);
    return e;
  }

  // ---- limpieza ----

  private timedOut(req: PendingReq, now: number): boolean {
    return now - req.createdAt >= this.uiTimeout;
  }

  private dropSession(token: string): void {
    this.sessions.delete(token);
    for (const [code, b] of [...this.bindings]) {
      if (b.sessionToken === token) this.bindings.delete(code);
    }
    for (const [id, br] of [...this.bridges]) {
      if (br.token === token) {
        this.bridges.delete(id);
        try {
          br.browser.close(1008, 'session expired');
        } catch {
          /* noop */
        }
      }
    }
  }

  private dropCode(urlCode: string): void {
    this.codes.delete(urlCode);
    this.usedCodes.delete(urlCode);
    const reqId = this.pendingByCode.get(urlCode);
    if (reqId) {
      this.pendingByCode.delete(urlCode);
      this.pending.delete(reqId);
    }
    const b = this.bindings.get(urlCode);
    if (b) {
      this.bindings.delete(urlCode);
      this.dropSession(b.sessionToken);
    }
    // Sesiones huérfanas que apunten a este código.
    for (const [tok, s] of [...this.sessions]) {
      if (s.urlCode === urlCode) this.dropSession(tok);
    }
  }

  private removeDevice(deviceId: string): void {
    this.devices.delete(deviceId);
    for (const set of this.wsDevices.values()) set.delete(deviceId);
    for (const [code, e] of [...this.codes]) {
      if (e.deviceId === deviceId) this.dropCode(code);
    }
    for (const [tok, s] of [...this.sessions]) {
      if (s.deviceId === deviceId) this.dropSession(tok);
    }
    for (const [reqId, req] of [...this.pending]) {
      if (req.deviceId === deviceId) {
        this.pending.delete(reqId);
        if (this.pendingByCode.get(req.urlCode) === reqId) this.pendingByCode.delete(req.urlCode);
      }
    }
    for (const [id, e] of [...this.httpPending]) {
      if (e.deviceId === deviceId) {
        clearTimeout(e.timer);
        this.httpPending.delete(id);
        try {
          e.resolve({
            status: 502,
            headers: { 'content-type': 'application/json' },
            bodyB64: b64({ error: 'daemon-offline' }),
          });
        } catch {
          /* noop */
        }
      }
    }
    for (const [id, br] of [...this.bridges]) {
      if (br.deviceId === deviceId) {
        this.bridges.delete(id);
        try {
          br.browser.close(1013, 'daemon offline');
        } catch {
          /* noop */
        }
      }
    }
  }

  /** Al caer un socket de daemon: se borran sus publicaciones y sesiones. */
  removeSocket(ws: TunnelSocket): void {
    const devs = this.wsDevices.get(ws);
    if (devs) {
      for (const d of [...devs]) this.removeDevice(d);
      this.wsDevices.delete(ws);
    }
    // Seguridad: puentes cuyo navegador era este socket.
    for (const [id, br] of [...this.bridges]) {
      if (br.browser === ws) this.bridges.delete(id);
    }
  }

  /** Limpieza periódica de expirados (la llama el intervalo de index.ts). */
  prune(): void {
    const now = this.now();
    for (const [code, e] of [...this.codes]) {
      if (e.exp > now) continue;
      const binding = this.bindings.get(code);
      const session = binding ? this.sessions.get(binding.sessionToken) : undefined;
      if (session && session.exp > now) {
        // Expira el QR, no la sesión que ya fue aprobada con él.
        this.codes.delete(code);
        const pendingId = this.pendingByCode.get(code);
        if (pendingId) {
          this.pendingByCode.delete(code);
          this.pending.delete(pendingId);
        }
      } else {
        this.dropCode(code);
      }
    }
    for (const [code, exp] of [...this.usedCodes]) if (exp <= now) this.usedCodes.delete(code);
    for (const [tok, s] of [...this.sessions]) {
      if (s.exp <= now) this.dropSession(tok);
    }
    for (const req of this.pending.values()) {
      if (req.state === 'pending' && this.timedOut(req, now)) req.state = 'denied';
    }
  }

  shutdown(): void {
    for (const [, e] of [...this.httpPending]) {
      clearTimeout(e.timer);
      try {
        e.resolve({
          status: 503,
          headers: { 'content-type': 'application/json' },
          bodyB64: b64({ error: 'relay-stopping' }),
        });
      } catch {
        /* noop */
      }
    }
    this.httpPending.clear();
    for (const [, br] of [...this.bridges]) {
      try {
        br.browser.close(1001, 'relay stopping');
      } catch {
        /* noop */
      }
    }
    this.bridges.clear();
    this.codes.clear();
    this.pending.clear();
    this.pendingByCode.clear();
    this.bindings.clear();
    this.usedCodes.clear();
    this.sessions.clear();
    this.devices.clear();
    this.wsDevices.clear();
  }
}
