/**
 * Login de Spotify sin Client ID (extracción local vía Web Player).
 *
 * Cómo aguanta la sesión más de ~1h sin re-login:
 * el Web Player NO vive del access token (caduca en ~1h), sino de las
 * cookies de sesión (sp_dc/sp_key). Con esas cookies, el endpoint
 * `get_access_token` reacuña un token fresco cuando se le pide, sin
 * interacción. Este módulo mantiene una ventana OCULTA con la sesión y
 * un sniffer que re-publica el token al daemon cada vez que cambia
 * (cada 60s). Solo si las cookies mueren se muestra la ventana al usuario.
 *
 * Por qué no un <iframe> en el dialog: accounts.spotify.com/open.spotify.com
 * envían `X-Frame-Options: deny` (+ CSP `frame-ancestors 'none'`), así que
 * cualquier iframe/webview incrustado queda en blanco y, aunque cargara,
 * SOP impediría leer el token cross-origin. Por eso se usa una
 * BrowserWindow Electrobun de primer nivel con el Web Player oficial.
 *
 * Este módulo separa helpers puros (testeables sin Electrobun) de la
 * parte que toca `BrowserWindow` (solo se ejecuta en el host real).
 */
import { Session } from 'electrobun/bun';

export const SPOTIFY_WEB_PLAYER_URL = 'https://open.spotify.com';
export const SPOTIFY_TOKEN_PATH = '/get_access_token?reason=transport&productType=web_player';

/** Margen: renovar cuando falten 5 min para caducar. */
export const SPOTIFY_REFRESH_SKEW_MS = 5 * 60_000;
/** Gracia silenciosa: intentar oculto antes de mostrar la ventana al usuario. */
export const SPOTIFY_SILENT_GRACE_MS = 25_000;
/** Si el minter oculto no consigue token en 60s, las cookies están muertas. */
export const SPOTIFY_MINTER_STALE_MS = 60_000;
/** Ventana abierta sin éxito tanto tiempo = abandonada: cerrar y limpiar. */
export const SPOTIFY_WINDOW_MAX_AGE_MS = 10 * 60_000;
/** Una petición de login más vieja que esto se considera abandonada. */
export const SPOTIFY_LOGIN_TTL_MS = 15 * 60_000;
/** Tras cerrar el usuario la ventana, no auto-reabrir por esta señal. */
export const SPOTIFY_RESIGNAL_COOLDOWN_MS = 5 * 60_000;

/** Daemon base (inyectable en tests). */
export function daemonBase(apiPort: number): string {
  return `http://127.0.0.1:${apiPort}`;
}

export interface SpotifySessionCookie {
  name: string;
  value: string;
  domain?: string;
}

/**
 * VÍA PRINCIPAL (robusta): lee las cookies de sesión del Web Player desde
 * la sesión por defecto de Electrobun (misma que usa la ventana de login).
 * No depende de inyección JS ni de timers en la página: funciona aunque la
 * ventana esté cerrada, oculta o con la inyección rota.
 * `sessionImpl` solo existe para tests ({ cookies: { get(filter) } }).
 */
export function readSpotifySessionCookies(sessionImpl?: {
  cookies: { get: (filter: any) => any[] };
}): SpotifySessionCookie[] {
  try {
    const session = sessionImpl ?? Session.defaultSession;
    const cookies = session?.cookies?.get?.({ domain: 'open.spotify.com' });
    if (!Array.isArray(cookies)) return [];
    return cookies.filter(
      (c: any) => c && typeof c?.name === 'string' && typeof c?.value === 'string',
    );
  } catch {
    return [];
  }
}

/** ¿Hay sesión viva? sp_dc es la cookie de sesión del Web Player. */
export function hasSpotifySession(cookies: SpotifySessionCookie[]): boolean {
  return cookies.some((c) => c.name === 'sp_dc' && c.value.length > 10);
}

export interface MintedSpotifyToken {
  accessToken: string;
  expiresIn: number;
  tokenType: string;
}

/**
 * Reacuña un token con las cookies de sesión (llamada servidor-a-servidor
 * desde el host: sin CORS, sin webview, sin interacción).
 */
export async function mintSpotifyTokenViaCookies(
  fetchFn: typeof fetch,
  cookies: SpotifySessionCookie[],
): Promise<MintedSpotifyToken | null> {
  const header = cookies
    .filter((c) => c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  if (!header) return null;
  try {
    const res = await fetchFn(
      `https://open.spotify.com${SPOTIFY_TOKEN_PATH}`,
      {
        headers: {
          Cookie: header,
          Referer: 'https://open.spotify.com/',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        },
      } as any,
    );
    if (!res?.ok) return null;
    const t = (await (res as any).json().catch(() => null)) as any;
    if (!t?.accessToken || typeof t.accessToken !== 'string') return null;
    const exp = Number(t.expiresIn ?? t.expires_in ?? 3600);
    return {
      accessToken: t.accessToken,
      expiresIn: Number.isFinite(exp) && exp > 0 ? Math.floor(exp) : 3600,
      tokenType: typeof t.tokenType === 'string' ? t.tokenType : 'Bearer',
    };
  } catch {
    return null;
  }
}

/** Publica un token en el daemon (reutiliza token-capture). */
export async function postSpotifyTokenCapture(
  fetchFn: typeof fetch,
  apiPort: number,
  token: MintedSpotifyToken,
): Promise<boolean> {
  try {
    const res = await fetchFn(`${daemonBase(apiPort)}/api/v1/plugins/spotify/token-capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessToken: token.accessToken,
        expiresIn: token.expiresIn,
        tokenType: token.tokenType,
      }),
    } as any);
    return !!res?.ok;
  } catch {
    return false;
  }
}

/**
 * Script inyectado en la ventana del Web Player. Corre en el origen
 * https://open.spotify.com, así que el fetch lleva las cookies de sesión.
 * Acuña al instante y luego cada 10s; POSTea al daemon SOLO cuando el
 * token cambia (evita escrituras y broadcasts constantes). No cierra la
 * ventana: debe seguir viva para renovar. Expone `__ldSpotifyNow()` para
 * forzar una acuñación a demanda desde el host.
 * En accounts.spotify.com (pantalla de login) no hace nada: espera al
 * redirect a open.spotify.com (el host reinyecta tras navegar).
 */
export function buildSpotifySnifferScript(apiPort: number): string {
  const captureUrl = `${daemonBase(apiPort)}/api/v1/plugins/spotify/token-capture`;
  return `(function(){if(window.__ldSpotifySniff)return;window.__ldSpotifySniff=true;var CAPTURE=${JSON.stringify(captureUrl)};var TOKEN_URL=${JSON.stringify(SPOTIFY_TOKEN_PATH)};var last="";function mint(){try{if(location.hostname!=='open.spotify.com')return;fetch(TOKEN_URL,{credentials:'include'}).then(function(r){if(!r.ok)return null;return r.json().catch(function(){return null;});}).then(function(t){if(!t||!t.accessToken||t.accessToken===last)return;last=t.accessToken;var exp=t.expiresIn||t.expires_in||3600;fetch(CAPTURE,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessToken:t.accessToken,expiresIn:exp,tokenType:t.tokenType||'Bearer'})}).catch(function(){});}).catch(function(){});}catch(e){}}window.__ldSpotifyNow=mint;mint();setInterval(mint,10000);})();`;
}

export interface LoginStatusResponse {
  pluginId: string;
  pending: boolean;
  requestedAt: string | null;
  configured: boolean;
  missing: string[];
}

export interface SettingsBundleResponse {
  configured?: boolean;
  values?: Record<string, any>;
}

/** Lee el estado de login pendiente del daemon (el host lo pollea). */
export async function fetchSpotifyLoginStatus(
  fetchFn: typeof fetch,
  apiPort: number,
): Promise<LoginStatusResponse | null> {
  try {
    const res = await fetchFn(
      `${daemonBase(apiPort)}/api/v1/plugins/spotify/login-request`,
    );
    if (!res.ok) return null;
    return (await res.json()) as LoginStatusResponse;
  } catch {
    return null;
  }
}

/** Lee el bundle de ajustes (configured + tokenExpiresAt) del daemon. */
export async function fetchSpotifySettingsBundle(
  fetchFn: typeof fetch,
  apiPort: number,
): Promise<SettingsBundleResponse | null> {
  try {
    const res = await fetchFn(
      `${daemonBase(apiPort)}/api/v1/plugins/spotify/settings`,
    );
    if (!res.ok) return null;
    return (await res.json()) as SettingsBundleResponse;
  } catch {
    return null;
  }
}

/** Lee un ajuste genérico del daemon (p. ej. loginDismissedAt). */export async function fetchSpotifyDaemonSetting(
  fetchFn: typeof fetch,
  apiPort: number,
  key: string,
): Promise<string | null> {
  try {
    const res = await fetchFn(
      `${daemonBase(apiPort)}/api/v1/settings?key=${encodeURIComponent(key)}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    return typeof data?.value === 'string' ? data.value : null;
  } catch {
    return null;
  }
}

/** Escribe un ajuste genérico del daemon (best-effort). */
export async function setSpotifyDaemonSetting(
  fetchFn: typeof fetch,
  apiPort: number,
  key: string,
  value: string,
): Promise<void> {
  try {
    await fetchFn(`${daemonBase(apiPort)}/api/v1/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    } as any);
  } catch {
    /* best-effort */
  }
}

/** Limpia la petición pendiente (best-effort). */
export async function clearSpotifyLoginRequest(
  fetchFn: typeof fetch,
  apiPort: number,
): Promise<void> {
  try {
    await fetchFn(`${daemonBase(apiPort)}/api/v1/plugins/spotify/login-request`, {
      method: 'DELETE',
    } as any);
  } catch {
    /* best-effort */
  }
}

export type SpotifyWindowAction = 'none' | 'open-hidden' | 'open-visible' | 'show' | 'close';

export interface SpotifyWindowState {
  /** ¿Token guardado válido? */
  configured: boolean;
  /** Ms epoch de caducidad o null si se desconoce (token manual). */
  expiresAtMs: number | null;
  /** ¿Hay petición de login pendiente? */
  pending: boolean;
  /** ¿Hay ventana del Web Player abierta? */
  winOpen: boolean;
  /** ¿Está oculta? */
  winHidden: boolean;
  /** Antigüedad de la ventana abierta (ms). */
  winAgeMs: number;
  nowMs: number;
}

/**
 * Decisión pura del ciclo de vida de la ventana (testeable sin Electrobun):
 * - Primer connect (sin token + petición del usuario): ventana VISIBLE de
 *   entrada — el usuario espera ver algo y quizá deba loguearse.
 * - Renovación en segundo plano (token que caduca): minter OCULTO.
 *   Si las cookies viven, el sniffer reacuña solo y nadie ve nada.
 * - Mostrar solo si lo oculto no resuelve (cookies muertas → login manual).
 * - Cerrar al quedar todo fresco (ahorra una webview).
 */
export function decideSpotifyWindowAction(s: SpotifyWindowState): {
  action: SpotifyWindowAction;
  reason: string;
} {
  if (!s.configured) {
    if (!s.pending) return { action: 'none', reason: 'sin token y sin petición: espera al usuario' };
    if (!s.winOpen) return { action: 'open-visible', reason: 'primer connect: ventana visible de entrada' };
    if (s.winHidden && s.winAgeMs > SPOTIFY_SILENT_GRACE_MS) {
      return { action: 'show', reason: 'lo oculto no bastó: login manual necesario' };
    }
    return { action: 'none', reason: 'ventana ya abierta, dando margen silencioso' };
  }
  // Configurado.
  const expiring =
    s.expiresAtMs !== null &&
    Number.isFinite(s.expiresAtMs) &&
    s.nowMs + SPOTIFY_REFRESH_SKEW_MS >= (s.expiresAtMs as number);
  if (expiring) {
    // La renovación silenciosa la hace el tick vía cookies ANTES de decidir.
    // Si seguimos aquí es que no hay sesión legible: NO abrir ventanas
    // desde segundo plano (sorprenderían al usuario y no resolverían nada).
    // El usuario reconecta explícitamente cuando una acción falle.
    return { action: 'none', reason: 'sin sesión legible: espera al usuario' };
  }
  if (s.winOpen) return { action: 'close', reason: 'token fresco: liberar la webview' };
  return { action: 'none', reason: 'todo fresco' };
}

export interface AuthWindowDeps {
  BrowserWindowCtor: any;
  apiPort: number;
  hidden?: boolean;
  onLog?: (msg: string) => void;
  /** Se llama cuando el usuario cierra la ventana (para no reabrirla). */
  onClose?: () => void;
}

/**
 * Abre la ventana de login del Web Player y le inyecta el sniffer.
 * Devuelve la ventana para que el llamador la gestione (o null si
 * Electrobun no está disponible, p. ej. en tests o navegador externo).
 */
export function openSpotifyLoginWindow(deps: AuthWindowDeps): any | null {
  const { BrowserWindowCtor, apiPort, hidden = false, onLog, onClose } = deps;
  try {
    if (typeof BrowserWindowCtor !== 'function') return null;
    const win = new BrowserWindowCtor({
      title: 'Conectar con Spotify — LibreDeck',
      url: SPOTIFY_WEB_PLAYER_URL,
      frame: { width: 1024, height: 760, x: 120, y: 80 },
      // Contenido remoto no confiable: sandbox si el host lo soporta.
      sandbox: true,
      ...(hidden ? { hidden: true } : {}),
    } as any);
    if (typeof onClose === 'function') {
      // Si el usuario cierra la ventana, NO reabrir: el tick lo sabrá
      // por onClose (limpia pending + marca dismissed).
      try {
        win?.on?.('close', onClose);
      } catch {
        /* sin eventos de ventana en esta versión */
      }
    }
    const inject = () => {
      try {
        win?.webview?.executeJavascript?.(buildSpotifySnifferScript(apiPort));
      } catch (e) {
        onLog?.(`[spotify-login] inject falló: ${String(e)}`);
      }
    };
    try {
      // Reinyectar en cada navegación (login -> open) porque el contexto se pierde.
      win?.webview?.on?.('did-navigate', inject);
      win?.webview?.on?.('did-commit-navigation', inject);
      win?.webview?.on?.('dom-ready', inject);
    } catch {
      /* eventos no disponibles en esta versión: seguimos con inyección inicial */
    }
    // La navegación login→web-player destruye los timers del sniffer, y los
    // eventos de navegación pueden no llegar: reinyectar por tiempo es el
    // camino fiable (el guard __ldSpotifySniff evita duplicados).
    for (const ms of [2500, 7000, 15000, 30000, 60000, 120000]) {
      setTimeout(inject, ms);
    }
    onLog?.(`[spotify-login] ventana del Web Player abierta${hidden ? ' (oculta)' : ''}`);
    return win;
  } catch (e) {
    onLog?.(`[spotify-login] no se pudo abrir ventana: ${String(e)}`);
    return null;
  }
}

/** Forzar una acuñación inmediata en una ventana ya abierta. */
export function pokeSpotifyMinter(win: any): void {
  try {
    win?.webview?.executeJavascript?.(
      'if(window.__ldSpotifyNow)window.__ldSpotifyNow();',
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Reinyecta el sniffer completo (idempotente por el guard interno).
 * Las navegaciones tardías (login con varios intentos, redirects) destruyen
 * los timers inyectados; el tick del host lo repone cada pocos segundos
 * mientras la ventana siga abierta.
 */
export function reinjectSpotifySniffer(win: any, apiPort: number): void {
  try {
    win?.webview?.executeJavascript?.(buildSpotifySnifferScript(apiPort));
  } catch {
    /* best-effort */
  }
}

let spotifyPollTimer: ReturnType<typeof setInterval> | null = null;
let spotifyAuthWin: any | null = null;
let spotifyWinOpenedAt = 0;
let spotifyWinHidden = false;
/** El usuario cerró la ventana a mano: no reabrir por señales viejas. */
let spotifyUserClosedAt = 0;
/** Último accessToken publicado al daemon (evita POSTs repetidos). */
let spotifyLastMinted = '';

function winAgeMs(): number {
  return spotifyWinOpenedAt > 0 ? Date.now() - spotifyWinOpenedAt : 0;
}

/**
 * Ventana abierta demasiado tiempo sin conseguir token (p. ej. el evento
 * `close` nunca llegó y la ref quedó stale, o la inyección falla): se
 * considera abandonada y se cierra. Evita el bloqueo eterno en `none`.
 */
export function shouldReapStaleWindow(
  winOpen: boolean,
  ageMs: number,
  configured: boolean,
): boolean {
  return winOpen && !configured && ageMs > SPOTIFY_WINDOW_MAX_AGE_MS;
}

function closeSpotifyWin(onLog?: (msg: string) => void): void {
  try {
    spotifyAuthWin?.close?.();
  } catch (e) {
    onLog?.(`[spotify-login] close falló: ${String(e)}`);
  }
  spotifyAuthWin = null;
  spotifyWinOpenedAt = 0;
  spotifyWinHidden = false;
}

/**
 * Bucle del host: mantiene el token fresco mientras la app siga abierta.
 *
 * Vía principal: cookies de sesión (servidor-a-servidor, sin ventanas).
 * La ventana del Web Player solo se abre cuando NO hay sesión y el usuario
 * la pidió explícitamente (click en "Conectar"). Las señales de fondo
 * (auto-refresh) JAMÁS abren ventanas visibles.
 *
 * - Sin token + petición del usuario + sesión viva → acuña en silencio.
 * - Sin token + petición + sin sesión → ventana visible para login.
 * - Token próximo a caducar + sesión → reacuña en silencio.
 * - Todo fresco → cerrar la webview para ahorrar recursos.
 * Idempotente y seguro de llamar varias veces.
 */
export function startSpotifyLoginPolling(opts: {
  fetchFn?: typeof fetch;
  apiPort: number;
  BrowserWindowCtor?: any;
  intervalMs?: number;
  onLog?: (msg: string) => void;
  /** Solo tests: inyecta la sesión ({ cookies: { get() } }). */
  sessionImpl?: { cookies: { get: (filter: any) => any[] } };
  /** Solo tests: ejecuta una iteración sin crear intervalo. */
  once?: boolean;
}): void {
  const {
    fetchFn = fetch,
    apiPort,
    BrowserWindowCtor,
    intervalMs = 5_000,
    onLog,
    sessionImpl,
    once = false,
  } = opts;
  const tick = async () => {
    try {
      const [bundle0, login, dismissedAt, autoReqAt] = await Promise.all([
        fetchSpotifySettingsBundle(fetchFn, apiPort),
        fetchSpotifyLoginStatus(fetchFn, apiPort),
        fetchSpotifyDaemonSetting(fetchFn, apiPort, 'plugin.spotify.loginDismissedAt'),
        fetchSpotifyDaemonSetting(fetchFn, apiPort, 'plugin.spotify.autoRefreshRequestedAt'),
      ]);
      const now = Date.now();
      let bundle = bundle0;
      let configured = bundle?.configured === true;
      let rawExp = Number(bundle?.values?.tokenExpiresAt);
      let expiresAtMs = Number.isFinite(rawExp) && rawExp > 0 ? rawExp : null;
      const requestedAt = Number(login?.requestedAt);
      const dismissedMs = Number(dismissedAt);
      const autoMs = Number(autoReqAt);
      const autoPending = Number.isFinite(autoMs) && now - autoMs < SPOTIFY_LOGIN_TTL_MS;
      // Petición EXPLÍCITA efectiva: existe, es reciente (TTL) y posterior
      // al último cierre manual (local o persistido). Cerrar la ventana la
      // cierra DEFINITIVAMENTE hasta el próximo click en "Conectar".
      const pendingFresh =
        login?.pending === true &&
        Number.isFinite(requestedAt) &&
        now - requestedAt < SPOTIFY_LOGIN_TTL_MS &&
        !(Number.isFinite(dismissedMs) && dismissedMs >= requestedAt) &&
        requestedAt > spotifyUserClosedAt;
      const pending = pendingFresh;

      if (login?.pending === true && !pending) {
        // Petición rancia o descartada por el usuario: limpiar para que no
        // reabra nada (ni tras reinicios del host en dev) y cerrar huérfanas.
        await clearSpotifyLoginRequest(fetchFn, apiPort);
        if (spotifyAuthWin) closeSpotifyWin(onLog);
        onLog?.('[spotify-login] tick: petición obsoleta/descartada, limpiada');
        return;
      }

      // Higiene: token fresco + petición colgada → limpiar sin ventanas.
      if (configured && pending && !expiringSoon(expiresAtMs, now) && !spotifyAuthWin) {
        await clearSpotifyLoginRequest(fetchFn, apiPort);
      }

      // Cierre manual del usuario: marca local + persistida, limpia pending.
      // Persiste en el daemon para sobrevivir a reinicios del host (dev).
      const handleUserClose = () => {
        spotifyUserClosedAt = Date.now();
        spotifyAuthWin = null;
        spotifyWinOpenedAt = 0;
        spotifyWinHidden = false;
        onLog?.('[spotify-login] ventana cerrada por el usuario: no se reabrirá sola');
        void clearSpotifyLoginRequest(fetchFn, apiPort);
        void setSpotifyDaemonSetting(
          fetchFn,
          apiPort,
          'plugin.spotify.loginDismissedAt',
          String(Date.now()),
        );
      };

      // VÍA PRINCIPAL: sesión viva → acuñar servidor-a-servidor, sin ventanas.
      // Cubre: primer connect con sesión previa, renovación por caducidad y
      // señales de fondo (401/expiry). Solo se publica si el token cambió.
      const cookies = readSpotifySessionCookies(sessionImpl);
      const sessionAlive = hasSpotifySession(cookies);
      const wantMint = !configured || expiringSoon(expiresAtMs, now) || autoPending;
      let mintedThisTick = false;
      if (wantMint && sessionAlive) {
        const token = await mintSpotifyTokenViaCookies(fetchFn, cookies);
        if (token && token.accessToken !== spotifyLastMinted) {
          const ok = await postSpotifyTokenCapture(fetchFn, apiPort, token);
          if (ok) {
            spotifyLastMinted = token.accessToken;
            mintedThisTick = true;
            // Refrescar estado: la captura ya limpió pendings en el daemon.
            const fresh = await fetchSpotifySettingsBundle(fetchFn, apiPort);
            if (fresh) {
              bundle = fresh;
              configured = bundle?.configured === true;
              rawExp = Number(bundle?.values?.tokenExpiresAt);
              expiresAtMs = Number.isFinite(rawExp) && rawExp > 0 ? rawExp : null;
            }
            onLog?.('[spotify-login] token reacuñado vía sesión, sin ventanas');
          }
        } else if (token) {
          // Mismo token: el daemon ya lo tiene; nada que hacer.
        }
      }

      // Anti-bloqueo: ventana abierta demasiado tiempo sin éxito (p. ej. el
      // evento close no llegó y la ref quedó stale) = abandonada.
      if (shouldReapStaleWindow(!!spotifyAuthWin, winAgeMs(), configured)) {
        onLog?.('[spotify-login] ventana huérfana: cerrando y limpiando');
        closeSpotifyWin(onLog);
        await clearSpotifyLoginRequest(fetchFn, apiPort);
        return;
      }

      const decision = decideSpotifyWindowAction({
        configured,
        expiresAtMs,
        pending,
        winOpen: !!spotifyAuthWin,
        winHidden: spotifyWinHidden,
        winAgeMs: winAgeMs(),
        nowMs: now,
      });

      if (!BrowserWindowCtor && decision.action !== 'none' && decision.action !== 'close') {
        return; // sin host (tests/navegador): el daemon guarda el pending
      }
      // Ventana abierta: reponer el sniffer por si una navegación tardía
      // mató su contexto (idempotente). Además, fuerza acuñación inmediata.
      if (spotifyAuthWin) {
        reinjectSpotifySniffer(spotifyAuthWin, apiPort);
        pokeSpotifyMinter(spotifyAuthWin);
      }
      switch (decision.action) {
        case 'open-visible':
          if (!spotifyAuthWin) {
            spotifyAuthWin = openSpotifyLoginWindow({
              BrowserWindowCtor,
              apiPort,
              hidden: false,
              onLog,
              onClose: handleUserClose,
            });
            spotifyWinOpenedAt = Date.now();
            spotifyWinHidden = false;
          } else if (spotifyWinHidden) {
            try {
              spotifyAuthWin?.show?.() ?? spotifyAuthWin?.activate?.();
            } catch {
              /* si no se puede mostrar, se mostrará en el próximo 'show' */
            }
            spotifyWinHidden = false;
          }
          pokeSpotifyMinter(spotifyAuthWin);
          break;
        case 'show':
          try {
            spotifyAuthWin?.show?.() ?? spotifyAuthWin?.activate?.();
          } catch {
            // Si no se puede mostrar, reabrir visible.
            closeSpotifyWin(onLog);
            spotifyAuthWin = openSpotifyLoginWindow({ BrowserWindowCtor, apiPort, onLog, onClose: handleUserClose });
            spotifyWinOpenedAt = Date.now();
            spotifyWinHidden = false;
          }
          spotifyWinHidden = false;
          break;
        case 'close':
          closeSpotifyWin(onLog);
          break;
        case 'none':
        default:
          // El minter oculto con token fresco pero ventana aún abierta por
          // una petición reciente: dejar que el próximo tick la cierre.
          break;
      }
      onLog?.(
        `[spotify-login] tick: ${decision.action} (${decision.reason}) sesion:${sessionAlive ? 'si' : 'no'}${mintedThisTick ? ' minted' : ''}`,
      );
    } catch (e) {
      onLog?.(`[spotify-login] tick falló: ${String(e)}`);
    }
  };
  if (once) {
    void tick();
    return;
  }
  if (spotifyPollTimer) return;
  spotifyPollTimer = setInterval(() => void tick(), intervalMs);
}

function expiringSoon(expiresAtMs: number | null, nowMs: number): boolean {
  return (
    expiresAtMs !== null &&
    Number.isFinite(expiresAtMs) &&
    nowMs + SPOTIFY_REFRESH_SKEW_MS >= (expiresAtMs as number)
  );
}

/** Solo tests: resetea el estado del módulo. */
export function __resetSpotifyLoginStateForTests(): void {
  if (spotifyPollTimer) {
    clearInterval(spotifyPollTimer);
    spotifyPollTimer = null;
  }
  spotifyAuthWin = null;
  spotifyWinOpenedAt = 0;
  spotifyWinHidden = false;
  spotifyUserClosedAt = 0;
  spotifyLastMinted = '';
}
