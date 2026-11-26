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
 *    12+ chars, `exp` epochMs) → `{v:1, kind:'ui-published', urlCode}`.
 *    Extensión fast-path LAN (backward-compatible, opcional): el daemon puede
 *    adjuntar `lan?: { ips, port, apiPort, fp, dev }` (SOLO alcanzabilidad,
 *    SIN código/invite). El relay lo sanitiza duro y lo expone vía
 *    `getLanHints(urlCode)` para que la waiting page pruebe alcanzabilidad
 *    pre-aprobación (sin redirect ni invite). Sin `lan` todo sigue igual.
 *    El invite LAN viaja SOLO en `ui-bind` (`lan.code`) y se entrega UNA vez
 *    vía `status` post-aprobación (nunca en HTML público).
 *  - relay→daemon `{v:1, kind:'ui-request', reqId, urlCode, ua, ip}` (solo en
 *    la primera visita a `GET /ui/<urlCode>`).
 *  - daemon→relay `{v:1, kind:'ui-decision', reqId, allow}` →
 *    `{v:1, kind:'ui-decision-ack', reqId, allow}`. Sin decisión en 120 s
 *    (defecto) el poll pasa a `denied`.
 *  - daemon→relay `{v:1, kind:'ui-bind', urlCode, sessionToken, exp}`
 *    (sessionToken hex 32+ chars generado por el daemon) →
 *    `{v:1, kind:'ui-bound', urlCode}`. Extensión LAN post-aprobación
 *    (opcional): `lan?: { code, ips, port, apiPort, fp, dev }` con el invite
 *    LAN (`code` base64url 16-80). Se guarda SOLO en el binding legacy y
 *    `status` lo devuelve UNA vez (`{lan:{code,ips,port,apiPort,fp}}`) en la
 *    rama aprobada (sid o legacy, la que dispare primero), marcando
 *    `lanConsumed`. Polls siguientes ya no lo exponen.
 *  - daemon→relay `{v:1, kind:'ui-rebind', sessionToken, exp}` (sin código:
 *    el daemon re-anuncia sus sesiones vigentes al (re)conectar para que un
 *    reinicio o micro-corte no invalide los `/t/<token>/` existentes) →
 *    `{v:1, kind:'ui-rebound', sessionToken}`.
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
 *    `bad-code`, `bad-exp`, `bad-token`, `bad-lan`, `bad-decision`, `unknown-code`,
 *    `unknown-request`, `unknown-token`, `stale-request`, `expired`,
 *    `unknown-kind`, `rate-limited`).
 *
 *  HTTP navegador→relay (público, sin RELAY_TOKEN; con rate-limit):
 *  - `GET /ui/<urlCode>` → página de espera (la sirve el handler registrado
 *    con `setUiPageHandler()`; sin handler → 404 `{error:'ui-page-missing'}`).
 *    La primera visita dispara `ui-request` al daemon.
 *  - `GET /ui/<urlCode>/status` → 200
 *    `{status:'pending'|'approved'|'denied'|'expired', sessionToken?}`.
 *    El token solo se entrega en el PRIMER poll tras aprobar. Si el bind
 *    trajo `lan`, el primer poll aprobado incluye además
 *    `lan:{code,ips,port,apiPort,fp}` UNA sola vez.
 *  - Todo bajo `/t/<sessionToken>/<path>` (HTTP) y WS en `/t/<tok>/ws`.
 *    Token desconocido → 401 `{error:'invalid-token'}`; caducado → 401
 *    `{error:'expired'}`. Daemon offline → 502; sin respuesta → 504.
 *    En respuestas `text/html` se inyecta `<base href="/t/<tok>/">` tras el
 *    primer `<head…>` y se reescriben las absolutas de mismo origen en
 *    `href`/`src`/`srcset`/`action`/`poster`/`component-url`/`renderer-url`/
 *    `before-hydration-url` a `/t/<tok>/…` (best-effort, islands de Astro).
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
/** Longitud mínima del SID público (`/s/<sid>/`, 16 bytes hex = 128 bits). */
export const MIN_SID_LEN = 16;
/** TTL de los tickets de claim de un solo uso (canje cookie). */
export const CLAIM_TICKET_TTL_MS = 5 * 60_000;
/** Nombre de la cookie de sesión del túnel (valor = secreto, Path=/s/<sid>/). */
export const TUNNEL_SESSION_COOKIE = 'bundeck_s';
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
  /** Token UI de la sesión (`/t/<token>/`). Para fallar solo sus peticiones al revocar. */
  token?: string;
  resolve: (r: HttpResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CodeEntry {
  deviceId: string;
  exp: number;
  /** Hints LAN de alcanzabilidad (SIN código pre-aprobación); null = sin hints. */
  lan?: LanHints | null;
}

/**
 * Hints de LAN.
 * - `ui-publish`: SOLO alcanzabilidad `{ips, port, apiPort, fp, dev}` SIN
 *   `code` (el invite NUNCA viaja pre-aprobación).
 * - `ui-bind`: CON invite `{code, ips, port, apiPort, fp, dev?}` (`code`
 *   base64url 16-80). Fuente única del invite post-aprobación.
 * `code` es opcional en el tipo para cubrir ambas fases; `sanitizeLanHints`
 * lo exige solo con `requireCode:true`.
 */
export interface LanHints {
  /** Código de invitación LAN (solo fase bind/status; ausente en publish). */
  code?: string;
  /** IPv4 RFC1918 candidatas (≤4, ya filtradas). */
  ips: string[];
  /** Puerto del frontend LAN (sirve `/config` público). */
  port: number;
  /** Puerto de la API LAN. */
  apiPort: number;
  /** Fingerprint del daemon (identidad, compara con `/config.fp`). */
  fp: string;
  /** Nombre del dispositivo (informativo). */
  dev: string;
}

/** Invite LAN tal como lo devuelve `status` post-aprobación (sin `dev`). */
export interface LanDirect {
  code: string;
  ips: string[];
  port: number;
  apiPort: number;
  fp: string;
}

const LAN_CODE_RE = /^[A-Za-z0-9_-]{16,80}$/;

/** ¿IPv4 RFC1918 (`10/8`, `172.16/12`, `192.168/16`)? */
function isRfc1918Ipv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const n = [m[1], m[2], m[3], m[4]].map(Number);
  for (const o of n) if (!Number.isInteger(o) || o < 0 || o > 255) return false;
  const [a, b] = n;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  return false;
}

function isPort(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535;
}

/**
 * Sanitiza los hints LAN.
 * - `requireCode:false` (publish): acepta `code` AUSENTE; solo exige
 *   ips+puertos válidos. Si trae `code` válido se conserva (compat daemon
 *   viejo), si trae `code` inválido se ignora (no tumba el publish).
 *   `fp`/`dev` opcionales (defecto `''`).
 * - `requireCode:true` (bind): exige `code` base64url 16-80 ADEMÁS de
 *   ips+puertos válidos; si falta o es inválido devuelve null (el caller
 *   responde `bad-lan`).
 * En ambos casos ips no-RFC1918 se descartan (≤4) y puertos fuera de rango
 * invalidan todo. Nunca lanza; null = sin lan (publish) o `bad-lan` (bind).
 */
export function sanitizeLanHints(input: unknown, requireCode = false): LanHints | null {
  if (!input || typeof input !== 'object') return null;
  const l = input as Record<string, unknown>;
  // Código: obligatorio solo en bind. En publish se tolera ausente (nuevo
  // diseño) o válido (compat daemon viejo); si viene inválido se ignora.
  let code: string | undefined;
  if (typeof l.code === 'string' && LAN_CODE_RE.test(l.code)) {
    code = l.code;
  } else if (requireCode) {
    return null;
  } else if (l.code !== undefined) {
    // Publish con code inválido: se ignora, no invalida los hints.
    code = undefined;
  }
  if (!Array.isArray(l.ips)) return null;
  const ips = l.ips
    .filter((ip): ip is string => typeof ip === 'string' && isRfc1918Ipv4(ip))
    .slice(0, 4);
  if (ips.length === 0) return null;
  if (!isPort(l.port) || !isPort(l.apiPort)) return null;
  const fp = typeof l.fp === 'string' && l.fp.length <= 128 ? l.fp : '';
  const dev = typeof l.dev === 'string' && l.dev.length <= 128 ? l.dev : '';
  return { ...(code !== undefined ? { code } : {}), ips, port: l.port, apiPort: l.apiPort, fp, dev };
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
  turn?: TurnCreds | null;
  /**
   * Invite LAN post-aprobación (viene de `ui-bind`, validado con
   * `requireCode:true`). Fuente ÚNICA del invite: el binding sid NUNCA lo
   * guarda. Se entrega UNA vez vía `status` y muere con el binding
   * (`dropCode`/`prune`/`unbind` borran el binding entero, sin huérfanos).
   */
  lan?: LanHints | null;
  /** `true` tras exponer `lan` una vez en `status` (independiente de `consumed`). */
  lanConsumed?: boolean;
}

interface SessionEntry {
  deviceId: string;
  exp: number;
  urlCode: string;
  turn?: TurnCreds | null;
}

/** Fila de sesión tuneleada tal como la persiste el relay (SQLite). */
export interface PersistedTunnelSession {
  token: string;
  deviceId: string;
  exp: number;
  urlCode: string;
  turnJson: string | null;
  /** Hash sha256 del secreto (`/s/<sid>/`); null en sesiones legacy `/t/*`. */
  secretHash?: string | null;
}

/**
 * Adaptador de persistencia de sesiones del túnel (opcional). Sin él, el
 * estado vive solo en memoria y un reinicio del relay invalida todos los
 * `/t/<token>/` (401 `invalid-token`) hasta que cada daemon reconecte y
 * re-emita sus `ui-rebind`. Con él, las sesiones sobreviven al reinicio.
 */
export interface TunnelSessionPersist {
  saveSession(session: PersistedTunnelSession): void;
  deleteSession(token: string): void;
  deleteDeviceSessions(deviceId: string): void;
  loadSessions(): PersistedTunnelSession[];
  pruneExpired(now: number): void;
}

/** Credenciales TURN efímeras para WebRTC (las genera el daemon, el relay solo las pasa). */
export interface TurnCreds {
  urls: string[];
  username: string;
  credential: string;
  ttl?: number;
}

export interface TunnelStateOptions {
  now?: () => number;
  /** Sin decisión del daemon en este tiempo, el status pasa a `denied`. */
  uiRequestTimeoutMs?: number;
  genId?: (prefix: string) => string;
  /** Persistencia opcional de sesiones (supervivencia a reinicios del relay). */
  persist?: TunnelSessionPersist | null;
}

/** TTL máximo aceptado al restaurar/enlazar una sesión (24 h + margen). */
export const MAX_TUNNEL_SESSION_TTL_MS = 24 * 60 * 60 * 1000 + 10 * 60 * 1000;

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

/** Inyecta `<base href="/t/<tok>/">` tras el primer `<head…>` (best-effort). */
export function injectBase(html: string, token: string): string {
  return injectBaseForPrefix(html, `/t/${token}`);
}

/** Variante genérica: inyecta `<base href="<prefix>/">` y reescribe assets a ese prefijo. */
export function injectBaseForPrefix(html: string, prefix: string): string {
  let out = html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<base href="${prefix}/">`);
  // Reescribe URLs absolutas de assets al prefijo del túnel: sin esto el
  // navegador pediría `/…` en la raíz del relay (401) en vez de
  // `/t/<tok>/…` (proxy al daemon) y la app aprobada quedaría sin
  // estilos ni JS. Cubre `href`/`src`/`action` clásicos, `srcset` (lista
  // `url 1x, url 2x`), `poster` y los atributos de islands de Astro
  // (`component-url`, `renderer-url`, `before-hydration-url`), que son los
  // que cargan los bundles `/_astro/…` del frontend compilado.
  // No toca `//…` (protocol-relative), `http:`, `data:`, `#…` ni rutas ya
  // prefijadas (`/t/…`, `/ui/…`).
  const ATTRS = 'href|src|srcset|action|poster|component-url|renderer-url|before-hydration-url';
  out = out.replace(
    new RegExp(`((?:${ATTRS})\\s*=\\s*["'])([^"']*)(["'])`, 'gi'),
    (_m, pre: string, val: string, post: string) => pre + rewriteAssetUrls(val, prefix) + post,
  );
  return out;
}

/** Prefija `/t/<tok>` a cada URL absoluta de mismo origen dentro de un valor de atributo. */
function rewriteAssetUrls(val: string, prefix: string): string {
  return val.replace(/(^|[\s,])\/(?!\/|t\/|s\/|ui\/)/g, `$1${prefix}/`);
}

export function isHexToken(s: unknown, min = MIN_TOKEN_LEN): s is string {
  return typeof s === 'string' && s.length >= min && /^[0-9a-fA-F]+$/.test(s);
}

/** ¿SID público válido (`/s/<sid>/`)? Hex de 16+ chars, distinto de legacy solo por longitud/ruta. */
export function isValidSid(s: unknown): s is string {
  return typeof s === 'string' && s.length >= MIN_SID_LEN && s.length <= 64 && /^[0-9a-fA-F]+$/.test(s);
}

/** ¿Secreto de sesión válido? Hex de 32+ chars (256 bits en el daemon nuevo). */
export function isValidSecret(s: unknown): s is string {
  return typeof s === 'string' && s.length >= MIN_TOKEN_LEN && /^[0-9a-fA-F]+$/.test(s);
}

/** sha256 hex del secreto (lo persistido; el secreto plano solo vive en memoria/ticket). */
export function hashSecret(secret: string): string {
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Comparación timing-safe de hashes hex (evita early-exit). */
export function sameHash(a: string, b: string): boolean {
  try {
    const { timingSafeEqual } = require('node:crypto') as typeof import('node:crypto');
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  } catch {
    return a === b;
  }
}

/** Genera un ticket de claim de un solo uso (64 hex). */
export function randomTicket(): string {
  const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
  return randomBytes(32).toString('hex');
}

/** Parsea la cabecera `Cookie` en un mapa (sin dependencias). */
export function parseCookies(header: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k || out.has(k)) continue;
    try {
      out.set(k, decodeURIComponent(v));
    } catch {
      out.set(k, v);
    }
  }
  return out;
}

/** Valida credenciales TURN del daemon: urls + username + credential, límites duros. */
function sanitizeTurnCreds(input: unknown): TurnCreds | null {
  if (!input || typeof input !== 'object') return null;
  const t = input as Record<string, unknown>;
  if (!Array.isArray(t.urls)) return null;
  const urls = t.urls.filter((u): u is string => typeof u === 'string' && u.length > 0 && u.length <= 256).slice(0, 8);
  if (urls.length === 0) return null;
  if (typeof t.username !== 'string' || t.username.length === 0 || t.username.length > 128) return null;
  if (typeof t.credential !== 'string' || t.credential.length === 0 || t.credential.length > 256) return null;
  const ttl = typeof t.ttl === 'number' && Number.isFinite(t.ttl) ? Math.min(Math.max(Math.floor(t.ttl), 60), 86400) : undefined;
  return { urls, username: t.username, credential: t.credential, ...(ttl !== undefined ? { ttl } : {}) };
}

export type TunnelStatus = 'pending' | 'approved' | 'denied' | 'expired';

export class TunnelState {
  readonly httpPending = new Map<string, HttpPending>();
  readonly sessions = new Map<string, SessionEntry>();
  /** Sesiones split-token (`/s/<sid>/`, secreto en cookie HttpOnly). */
  readonly sidSessions = new Map<string, SessionEntry & { secretHash: string }>();
  /** Tickets de claim de un solo uso: ticket -> {sid, secret, exp}. */
  readonly tickets = new Map<string, { sid: string; secret: string; exp: number }>();
  readonly devices = new Map<string, TunnelSocket>();
  /**
   * Última actividad vista por deviceId (register, ping o pong del
   * keepalive). El `pong` del daemon refresca este registro para que el
   * barrido periódico no lo considere muerto: sin tráfico, el socket
   * ocioso lo cortaría el LB y caería todo el registro (sesiones,
   * publicaciones y puentes).
   */
  private readonly deviceSeen = new Map<string, number>();
  private readonly wsDevices = new Map<TunnelSocket, Set<string>>();
  private readonly codes = new Map<string, CodeEntry>();
  private readonly pending = new Map<string, PendingReq>();
  private readonly pendingByCode = new Map<string, string>();
  private readonly bindings = new Map<string, CodeBinding>();
  /** Bindings split-token: urlCode -> {sid, secretHash, exp, consumed, turn}. */
  private readonly sidBindings = new Map<string, { sid: string; secretHash: string; exp: number; consumed: boolean; turn?: TurnCreds | null }>();
  /** Secretos planos temporales (solo memoria) para emitir tickets de claim. Se limpian al caer la sesión. */
  private readonly pendingSidSecrets = new Map<string, string>();
  /** URL-codes approved once; they cannot start another approval flow. */
  private readonly usedCodes = new Map<string, number>();
  private readonly bridges = new Map<string, { browser: TunnelSocket; deviceId: string; token: string }>();
  private readonly now: () => number;
  private readonly uiTimeout: number;
  private readonly genId: (prefix: string) => string;
  private readonly persist: TunnelSessionPersist | null;

  constructor(opts: TunnelStateOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.uiTimeout = opts.uiRequestTimeoutMs ?? UI_REQUEST_TIMEOUT_MS;
    this.persist = opts.persist ?? null;
    this.genId =
      opts.genId ??
      ((p) => `${p}-${this.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`);
  }

  /** Persistencia (si hay): restaura sesiones vigentes tras un reinicio. */
  restorePersistedSessions(): number {
    if (!this.persist) return 0;
    let rows: PersistedTunnelSession[] = [];
    try {
      rows = this.persist.loadSessions();
    } catch {
      return 0;
    }
    const now = this.now();
    let n = 0;
    for (const r of rows) {
      if (typeof r?.token !== 'string' || !isHexToken(r.token, 16)) continue;
      if (typeof r?.deviceId !== 'string' || !r.deviceId) continue;
      // `exp = 0` = perenne: nunca caduca, se restaura siempre.
      if (typeof r?.exp !== 'number' || !Number.isFinite(r.exp) || (r.exp !== 0 && r.exp <= now)) continue;
      let turn: TurnCreds | null = null;
      if (typeof r?.turnJson === 'string' && r.turnJson) {
        try {
          turn = sanitizeTurnCreds(JSON.parse(r.turnJson));
        } catch {
          turn = null;
        }
      }
      const secretHash = typeof (r as { secretHash?: unknown }).secretHash === 'string' ? (r as { secretHash: string }).secretHash : null;
      if (secretHash && /^[0-9a-f]{64}$/.test(secretHash) && isValidSid(r.token)) {
        this.sidSessions.set(r.token, {
          deviceId: r.deviceId,
          exp: r.exp,
          urlCode: typeof r?.urlCode === 'string' ? r.urlCode : '',
          turn,
          secretHash,
        });
        n += 1;
        continue;
      }
      if (!isHexToken(r.token)) continue;
      this.sessions.set(r.token, {
        deviceId: r.deviceId,
        exp: r.exp,
        urlCode: typeof r?.urlCode === 'string' ? r.urlCode : '',
        turn,
      });
      n += 1;
    }
    return n;
  }

  nextId(prefix: string): string {
    return this.genId(prefix);
  }

  /** deviceId registrado en un socket de daemon (para `ui-rebind`). */
  socketDeviceId(ws: TunnelSocket): string | undefined {
    return this.socketDevice(ws);
  }

  /**
   * Marca actividad de un deviceId (keepalive ping/pong). Refresca el
   * registro para que el sweep no lo purgue por idle.
   */
  noteDeviceActivity(deviceId: string): void {
    if (typeof deviceId !== 'string' || deviceId === '') return;
    if (!this.devices.has(deviceId)) return;
    this.deviceSeen.set(deviceId, this.now());
  }

  /** Última actividad registrada de un deviceId (0 = nunca visto). */
  lastDeviceSeen(deviceId: string): number {
    return this.deviceSeen.get(deviceId) ?? 0;
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
    this.deviceSeen.set(deviceId, this.now());
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

  publish(ws: TunnelSocket, urlCode: unknown, exp: unknown, lan?: unknown): { deviceId: string } | { error: string } {
    const deviceId = this.socketDevice(ws);
    if (!deviceId) return { error: 'not-registered' };
    if (typeof urlCode !== 'string' || urlCode.length < MIN_URL_CODE_LEN) return { error: 'bad-code' };
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return { error: 'bad-exp' };
    // Republicar reinicia el flujo y revoca sesiones/puentes de ese código.
    this.dropCode(urlCode);
    // Publish SIN código: solo alcanzabilidad (requireCode:false). Nunca falla
    // por lan inválido (tolerante); el invite viaja solo en bind.
    this.codes.set(urlCode, { deviceId, exp, lan: sanitizeLanHints(lan, false) });
    return { deviceId };
  }

  /** Hints LAN de alcanzabilidad (SIN código); null si no hay. */
  getLanHints(urlCode: string): LanHints | null {
    if (typeof urlCode !== 'string' || urlCode === '') return null;
    return this.codes.get(urlCode)?.lan ?? null;
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
    if (b && s && (s.exp === 0 || s.exp > now)) {
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

  bind(urlCode: unknown, sessionToken: unknown, exp: unknown, turn?: unknown, lan?: unknown): 'ok' | string {
    if (!isHexToken(sessionToken)) return 'bad-token';
    // `exp = 0` = sesión perenne (nunca caduca): se acepta sin tope TTL.
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp < 0) return 'bad-exp';
    if (typeof urlCode !== 'string') return 'unknown-code';
    const entry = this.codes.get(urlCode);
    if (!entry) return 'unknown-code';
    if (entry.exp <= this.now()) {
      this.dropCode(urlCode);
      return 'expired';
    }
    const turnCreds = sanitizeTurnCreds(turn);
    // Invite LAN post-aprobación: solo en el binding legacy (el sid NUNCA lo
    // guarda; fuente única = legacy). Ausente = sin LAN (compat). Presente
    // pero inválido = `bad-lan` (el daemon debe reintentar sin lan o válido).
    let lanHints: LanHints | null = null;
    if (lan !== undefined && lan !== null) {
      lanHints = sanitizeLanHints(lan, true);
      if (!lanHints) return 'bad-lan';
    }
    const prev = this.bindings.get(urlCode);
    if (prev && prev.sessionToken !== sessionToken) this.dropSession(prev.sessionToken);
    // NOTA: no se toca sidBindings aquí: legacy `/t/*` y split-token `/s/*`
    // coexisten para el mismo urlCode (compat transición).
    this.sessions.set(sessionToken as string, { deviceId: entry.deviceId, exp: exp as number, urlCode, turn: turnCreds });
    this.bindings.set(urlCode, {
      sessionToken: sessionToken as string,
      exp: exp as number,
      consumed: false,
      turn: turnCreds,
      lan: lanHints,
      lanConsumed: false,
    });
    this.persistSession(sessionToken as string);
    this.usedCodes.set(urlCode, entry.exp);
    const pendingId = this.pendingByCode.get(urlCode);
    if (pendingId) {
      this.pendingByCode.delete(urlCode);
      this.pending.delete(pendingId);
    }
    return 'ok';
  }

  /**
   * Enlaza una sesión split-token (`/s/<sid>/` + cookie HttpOnly).
   * El `sid` es público (va en la URL), el `secret` nunca viaja en URL tras
   * el claim: se entrega vía ticket de un solo uso y luego cookie.
   */
  bindSid(urlCode: unknown, sid: unknown, secret: unknown, exp: unknown, turn?: unknown): 'ok' | string {
    if (!isValidSid(sid)) return 'bad-sid';
    if (!isValidSecret(secret)) return 'bad-secret';
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp < 0) return 'bad-exp';
    if (typeof urlCode !== 'string') return 'unknown-code';
    const entry = this.codes.get(urlCode);
    if (!entry) return 'unknown-code';
    if (entry.exp <= this.now()) {
      this.dropCode(urlCode);
      return 'expired';
    }
    const turnCreds = sanitizeTurnCreds(turn);
    const prev = this.sidBindings.get(urlCode);
    if (prev && prev.sid !== sid) this.dropSidSession(prev.sid);
    // NOTA: no se toca bindings legacy aquí: `/s/*` y `/t/*` coexisten (compat).
    const secretHash = hashSecret(secret as string);
    this.sidSessions.set(sid as string, { deviceId: entry.deviceId, exp: exp as number, urlCode: urlCode as string, turn: turnCreds, secretHash });
    this.sidBindings.set(urlCode as string, { sid: sid as string, secretHash, exp: exp as number, consumed: false, turn: turnCreds });
    this.pendingSidSecrets.set(sid as string, secret as string);
    this.persistSidSession(sid as string);
    this.usedCodes.set(urlCode as string, entry.exp);
    const pendingId = this.pendingByCode.get(urlCode as string);
    if (pendingId) {
      this.pendingByCode.delete(urlCode as string);
      this.pending.delete(pendingId);
    }
    return 'ok';
  }

  /**
   * Restaura una sesión del daemon sin necesitar el código original (ya
   * consumido o perdido). Lo usa el daemon al (re)conectar para re-anunciar
   * sus sesiones vigentes de settings (`resyncUiState`): así un reinicio del
   * daemon o un micro-corte ya no invalida los `/t/<token>/` existentes.
   * Solo acepta tokens hex + expiración futura acotada (24 h + margen), o
   * `exp = 0` (perenne: sin caducidad ni tope).
   */
  rebind(deviceId: unknown, sessionToken: unknown, exp: unknown): 'ok' | string {
    if (typeof deviceId !== 'string' || deviceId === '') return 'not-registered';
    if (!isHexToken(sessionToken)) return 'bad-token';
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp < 0) return 'bad-exp';
    const now = this.now();
    if (exp === 0) {
      this.sessions.set(sessionToken as string, { deviceId, exp: 0, urlCode: '', turn: null });
      this.persistSession(sessionToken as string);
      return 'ok';
    }
    if (exp <= now) return 'expired';
    if (exp - now > MAX_TUNNEL_SESSION_TTL_MS) return 'bad-exp';
    this.sessions.set(sessionToken as string, { deviceId, exp, urlCode: '', turn: null });
    this.persistSession(sessionToken as string);
    return 'ok';
  }

  /** Re-anuncia una sesión split-token (daemon al reconectar). Acepta sid+secret o sid solo si ya existe. */
  rebindSid(deviceId: unknown, sid: unknown, secret: unknown, exp: unknown): 'ok' | string {
    if (typeof deviceId !== 'string' || deviceId === '') return 'not-registered';
    if (!isValidSid(sid)) return 'bad-sid';
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp < 0) return 'bad-exp';
    const now = this.now();
    if (exp !== 0) {
      if (exp <= now) return 'expired';
      if (exp - now > MAX_TUNNEL_SESSION_TTL_MS) return 'bad-exp';
    }
    const existing = this.sidSessions.get(sid as string);
    let secretHash: string | null = null;
    if (isValidSecret(secret)) secretHash = hashSecret(secret as string);
    else if (existing) secretHash = existing.secretHash;
    else return 'bad-secret';
    this.sidSessions.set(sid as string, {
      deviceId,
      exp: exp as number,
      urlCode: existing?.urlCode ?? '',
      turn: existing?.turn ?? null,
      secretHash: secretHash as string,
    });
    if (isValidSecret(secret)) this.pendingSidSecrets.set(sid as string, secret as string);
    this.persistSidSession(sid as string);
    return 'ok';
  }

  /** Emite un ticket de claim de un solo uso para `sid` (lo devuelve `status` y lo canjea `/s/<sid>/claim`). */
  issueTicket(sid: string, secret: string): string {
    const ticket = randomTicket();
    this.tickets.set(ticket, { sid, secret, exp: this.now() + CLAIM_TICKET_TTL_MS });
    return ticket;
  }

  /** Canjea `ticket` por el secreto (una sola vez). Devuelve el secreto o null. */
  claimTicket(sid: string, ticket: string): string | null {
    const e = this.tickets.get(ticket);
    if (!e || e.sid !== sid) return null;
    this.tickets.delete(ticket);
    if (e.exp <= this.now()) return null;
    const sess = this.sidSessions.get(sid);
    if (!sess) return null;
    if (sess.exp !== 0 && sess.exp <= this.now()) {
      this.dropSidSession(sid);
      return null;
    }
    // El ticket entrega el secreto plano guardado al emitir; valida contra el hash vigente.
    if (!sameHash(hashSecret(e.secret), sess.secretHash)) return null;
    return e.secret;
  }

  /** ¿La cookie presentada autoriza `sid`? */
  validateSid(sid: string, secretFromCookie: string | null | undefined): boolean {
    if (!isValidSid(sid) || !isValidSecret(secretFromCookie)) return false;
    const sess = this.sidSessions.get(sid);
    if (!sess) return false;
    if (sess.exp !== 0 && sess.exp <= this.now()) {
      this.expireSidSession(sid);
      return false;
    }
    return sameHash(hashSecret(secretFromCookie as string), sess.secretHash);
  }

  /** Caducidad perezosa de sesión split-token. */
  expireSidSession(sid: string): void {
    const s = this.sidSessions.get(sid);
    if (s && s.exp !== 0 && s.exp <= this.now()) this.dropSidSession(sid);
  }

  private persistSession(token: string): void {
    if (!this.persist) return;
    try {
      const s = this.sessions.get(token);
      if (!s) return;
      this.persist.saveSession({
        token,
        deviceId: s.deviceId,
        exp: s.exp,
        urlCode: s.urlCode,
        turnJson: s.turn ? JSON.stringify(s.turn) : null,
      });
    } catch {
      /* persistencia best-effort: la memoria sigue mandando */
    }
  }

  private persistSidSession(sid: string): void {
    if (!this.persist) return;
    try {
      const s = this.sidSessions.get(sid);
      if (!s) return;
      this.persist.saveSession({
        token: sid,
        deviceId: s.deviceId,
        exp: s.exp,
        urlCode: s.urlCode,
        turnJson: s.turn ? JSON.stringify(s.turn) : null,
        secretHash: s.secretHash,
      });
    } catch {
      /* persistencia best-effort: la memoria sigue mandando */
    }
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
   * Acepta tanto token legacy `/t/*` como sid `/s/*`.
   */
  unbind(sessionToken: unknown): boolean {
    if (typeof sessionToken !== 'string') return false;
    const sess = this.sessions.get(sessionToken);
    if (sess) {
      if (sess.urlCode) this.dropCode(sess.urlCode);
      else this.dropSession(sessionToken);
      return true;
    }
    const sidSess = this.sidSessions.get(sessionToken);
    if (sidSess) {
      if (sidSess.urlCode) this.dropCode(sidSess.urlCode);
      else this.dropSidSession(sessionToken);
      return true;
    }
    return false;
  }

  /** Revoca una sesión split-token por sid (canal daemon autenticado). Revoca también el legacy del mismo código. */
  unbindSid(sid: unknown): boolean {
    if (typeof sid !== 'string' || !this.sidSessions.has(sid)) return false;
    const sess = this.sidSessions.get(sid);
    if (sess?.urlCode) this.dropCode(sess.urlCode);
    else this.dropSidSession(sid);
    return true;
  }

  status(urlCode: string): { status: TunnelStatus; sessionToken?: string; sid?: string; ticket?: string; turn?: TurnCreds | null; rtc?: boolean; lan?: LanDirect } {
    const now = this.now();
    const sb = this.sidBindings.get(urlCode);
    const bLegacy = this.bindings.get(urlCode);
    // Compat: si hay binding sid Y legacy (daemon nuevo en relay nuevo),
    // se devuelven ambos para que clientes viejos (`/t/*`) y nuevos (`/s/*`) funcionen.
    const legacyToken = (() => {
      if (!bLegacy) return undefined;
      const ls = this.sessions.get(bLegacy.sessionToken);
      if (ls && (ls.exp === 0 || ls.exp > now)) return bLegacy.sessionToken;
      return undefined;
    })();
    // Invite LAN post-aprobación: fuente ÚNICA = binding legacy. Se entrega
    // UNA vez (lanConsumed) en la rama aprobada que dispare primero,
    // independiente de los flags de sessionToken/ticket. Sin binding legacy
    // o ya consumido: no se expone (flujo actual intacto).
    const takeLanOnce = (): LanDirect | undefined => {
      const bl = this.bindings.get(urlCode);
      if (!bl?.lan || bl.lanConsumed) return undefined;
      const lan = bl.lan;
      if (!lan || typeof lan.code !== 'string' || !lan.code) return undefined;
      if (!Array.isArray(lan.ips) || lan.ips.length === 0) return undefined;
      if (typeof lan.port !== 'number') return undefined;
      bl.lanConsumed = true;
      return {
        code: lan.code,
        ips: [...lan.ips],
        port: lan.port,
        apiPort: lan.apiPort,
        fp: typeof lan.fp === 'string' ? lan.fp : '',
      };
    };
    if (sb) {
      const s = this.sidSessions.get(sb.sid);
      if (s && (s.exp === 0 || s.exp > now)) {
        // Split-token: cada poll emite un ticket fresco de un solo uso.
        // El secreto nunca viaja en la URL final: se canjea por cookie en `/s/<sid>/claim`.
        const pendingSecret = this.pendingSidSecrets.get(sb.sid);
        if (pendingSecret && sameHash(hashSecret(pendingSecret), s.secretHash)) {
          const ticket = this.issueTicket(sb.sid, pendingSecret);
          sb.consumed = true;
          // Si hay legacy, se consume también para no re-exponerlo en polls siguientes
          // (el primer poll lo entrega una vez, como antes).
          let legacyOnce: string | undefined;
          if (legacyToken && bLegacy && !bLegacy.consumed) {
            bLegacy.consumed = true;
            legacyOnce = legacyToken;
          } else if (legacyToken && bLegacy?.consumed) {
            // polls siguientes: no re-exponer legacy
            legacyOnce = undefined;
          }
          const lanOnce = takeLanOnce();
          return {
            status: 'approved',
            sid: sb.sid,
            ticket,
            ...(legacyOnce ? { sessionToken: legacyOnce } : {}),
            ...(sb.turn ? { turn: sb.turn, rtc: true } : {}),
            ...(lanOnce ? { lan: lanOnce } : {}),
          };
        }
        // Sin secreto plano (p. ej. restore tras reinicio sin rebind):
        // aprobado sin ticket. Las cookies existentes siguen valiendo.
        // El invite LAN sigue entregándose una vez si existe.
        const lanOnce = takeLanOnce();
        return { status: 'approved', sid: sb.sid, ...(legacyToken ? {} : {}), ...(lanOnce ? { lan: lanOnce } : {}) };
      }
      this.sidBindings.delete(urlCode);
      this.pendingSidSecrets.delete(sb.sid);
    }
    const b = this.bindings.get(urlCode);
    if (b) {
      const s = this.sessions.get(b.sessionToken);
      if (s && (s.exp === 0 || s.exp > now)) {
        if (!b.consumed) {
          b.consumed = true;
          const lanOnce = takeLanOnce();
          return { status: 'approved', sessionToken: b.sessionToken, ...(b.turn ? { turn: b.turn, rtc: true } : {}), ...(lanOnce ? { lan: lanOnce } : {}) };
        }
        // Token ya entregado: aprobado sin re-exponer. El lan tampoco se
        // re-expone (takeLanOnce ya marcó consumido en el primer poll).
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

  /** Caducidad perezosa de sesión (acceso a `/t/*` con token expirado). `exp = 0` = perenne: nunca se purga. */
  expireSession(token: string): void {
    const s = this.sessions.get(token);
    if (s && s.exp !== 0 && s.exp <= this.now()) this.dropSession(token);
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
    const sess = this.sessions.get(token);
    this.sessions.delete(token);
    try {
      this.persist?.deleteSession(token);
    } catch {
      /* best-effort */
    }
    for (const [code, b] of [...this.bindings]) {
      if (b.sessionToken === token) this.bindings.delete(code);
    }
    // Tráfico en vuelo de ESTA sesión: 401 inmediato (no espera al timeout
    // de 30 s del daemon ni deja que una respuesta tardía cuele).
    for (const [id, e] of [...this.httpPending]) {
      if (e.token !== undefined && e.token !== token) continue;
      // Sin token registrado (versiones viejas): solo falla si es del mismo
      // daemon y ya no le quedan sesiones (evita tumbar otras sesiones).
      if (e.token === undefined && sess) {
        let remaining = false;
        for (const s of this.sessions.values()) {
          if (s.deviceId === e.deviceId) { remaining = true; break; }
        }
        if (remaining) continue;
      }
      clearTimeout(e.timer);
      this.httpPending.delete(id);
      try {
        e.resolve({
          status: 401,
          headers: { 'content-type': 'application/json' },
          bodyB64: b64({ error: 'invalid-token' }),
        });
      } catch {
        /* noop */
      }
    }
    // Avisa al daemon para que cierre su lado del puente (si no, su
    // TunnelClient conserva el bridge y el peer RTC asociado).
    try {
      const sock = sess ? this.devices.get(sess.deviceId) : undefined;
      if (sock) {
        for (const [id, br] of [...this.bridges]) {
          if (br.token !== token) continue;
          try {
            sock.send(JSON.stringify({ v: 1, kind: 'ws-close', id }));
          } catch {
            /* daemon caído: se limpia al cerrar el socket */
          }
        }
      }
    } catch {
      /* best-effort */
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

  private dropSidSession(sid: string): void {
    const sess = this.sidSessions.get(sid);
    this.sidSessions.delete(sid);
    this.pendingSidSecrets.delete(sid);
    try {
      this.persist?.deleteSession(sid);
    } catch {
      /* best-effort */
    }
    for (const [code, b] of [...this.sidBindings]) {
      if (b.sid === sid) {
        this.sidBindings.delete(code);
        this.pendingSidSecrets.delete(sid);
      }
    }
    for (const [ticket, t] of [...this.tickets]) {
      if (t.sid === sid) this.tickets.delete(ticket);
    }
    for (const [id, e] of [...this.httpPending]) {
      if (e.token !== undefined && e.token !== sid) continue;
      if (e.token === undefined && sess) {
        let remaining = false;
        for (const s of this.sidSessions.values()) {
          if (s.deviceId === e.deviceId) { remaining = true; break; }
        }
        if (remaining) continue;
      }
      // Solo falla el tráfico de ESTA sid (no el legacy del mismo daemon salvo que no queden sesiones).
      if (e.token === undefined && sess) {
        let legacyRemaining = false;
        for (const s of this.sessions.values()) {
          if (s.deviceId === e.deviceId) { legacyRemaining = true; break; }
        }
        if (legacyRemaining) continue;
      }
      clearTimeout(e.timer);
      this.httpPending.delete(id);
      try {
        e.resolve({
          status: 401,
          headers: { 'content-type': 'application/json' },
          bodyB64: b64({ error: 'invalid-token' }),
        });
      } catch {
        /* noop */
      }
    }
    try {
      const sock = sess ? this.devices.get(sess.deviceId) : undefined;
      if (sock) {
        for (const [id, br] of [...this.bridges]) {
          if (br.token !== sid) continue;
          try {
            sock.send(JSON.stringify({ v: 1, kind: 'ws-close', id }));
          } catch {
            /* daemon caído: se limpia al cerrar el socket */
          }
        }
      }
    } catch {
      /* best-effort */
    }
    for (const [id, br] of [...this.bridges]) {
      if (br.token === sid) {
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
    // Los bindings se borran enteros: el `lan` (y `lanConsumed`) muere con
    // ellos, sin huérfanos. Vale para dropCode/prune/unbind (todos borran bindings).
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
    const sb = this.sidBindings.get(urlCode);
    if (sb) {
      this.sidBindings.delete(urlCode);
      this.dropSidSession(sb.sid);
    }
    // Sesiones huérfanas que apunten a este código.
    for (const [tok, s] of [...this.sessions]) {
      if (s.urlCode === urlCode) this.dropSession(tok);
    }
    for (const [sid, s] of [...this.sidSessions]) {
      if (s.urlCode === urlCode) this.dropSidSession(sid);
    }
  }

  private removeDevice(deviceId: string): void {
    this.devices.delete(deviceId);
    this.deviceSeen.delete(deviceId);
    for (const set of this.wsDevices.values()) set.delete(deviceId);
    for (const [code, e] of [...this.codes]) {
      if (e.deviceId === deviceId) this.dropCode(code);
    }
    for (const [tok, s] of [...this.sessions]) {
      if (s.deviceId === deviceId) this.dropSession(tok);
    }
    for (const [sid, s] of [...this.sidSessions]) {
      if (s.deviceId === deviceId) this.dropSidSession(sid);
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
      const sidBinding = this.sidBindings.get(code);
      const sidSession = sidBinding ? this.sidSessions.get(sidBinding.sid) : undefined;
      if ((session && (session.exp === 0 || session.exp > now)) || (sidSession && (sidSession.exp === 0 || sidSession.exp > now))) {
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
      if (s.exp !== 0 && s.exp <= now) this.dropSession(tok);
    }
    for (const [sid, s] of [...this.sidSessions]) {
      if (s.exp !== 0 && s.exp <= now) this.dropSidSession(sid);
    }
    for (const [ticket, t] of [...this.tickets]) {
      if (t.exp <= now) this.tickets.delete(ticket);
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
    this.sidBindings.clear();
    this.sidSessions.clear();
    this.tickets.clear();
    this.pendingSidSecrets.clear();
    this.usedCodes.clear();
    this.sessions.clear();
    this.devices.clear();
    this.wsDevices.clear();
  }
}
