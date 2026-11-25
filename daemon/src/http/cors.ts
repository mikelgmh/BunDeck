/**
 * CORS centralizado para los servidores HTTP del daemon (API + frontend embebido).
 *
 * Política:
 * - Si el `Origin` es local (localhost / 127.0.0.1 / ::1 / LAN 10/8, 172.16/12,
 *   192.168/16, en http o https) se hace eco del origen y se permite
 *   `Access-Control-Allow-Credentials: true`. Mantiene compatibilidad LAN
 *   (dev.sh, panel en móvil/QR).
 * - En cualquier otro caso se responde `Access-Control-Allow-Origin: *`
 *   SIN credentials (combinar `*` con `Allow-Credentials: true` viola la
 *   especificación Fetch y los navegadores lo rechazan).
 *
 * Además se responde siempre `Access-Control-Allow-Private-Network: true`:
 * la página de callback del relay (`https://relay.bundeck.app`, red pública)
 * hace fetch a `http://127.0.0.1:<apiPort>` (red privada) y Chrome
 * (Private Network Access) exige ese header en el preflight; sin él el
 * navegador bloquea la petición antes de llegar a la API.
 */

/** Hosts considerados locales (sin puerto). */
const LOCAL_HOST_RE =
  /^(localhost|127\.0\.0\.1|::1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+|192\.168\.\d+\.\d+)$/i;

/**
 * ¿El Origin es local? Acepta `null`/ausente como NO local
 * (el llamador decidirá la respuesta segura para esos casos).
 */
export function isLocalOrigin(origin: string | null): boolean {
  if (!origin || origin === 'null') return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return LOCAL_HOST_RE.test(url.hostname);
  } catch {
    return false;
  }
}

/** Cabeceras CORS para responder a `origin`. */
export function buildCorsHeaders(origin: string | null): Record<string, string> {
  const base = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-Lan-Invite',
    // Private Network Access: permite que una página pública (el callback
    // https del relay) llame a este daemon en loopback/LAN. Chrome exige
    // este header en el preflight para https→http://127.0.0.1.
    'Access-Control-Allow-Private-Network': 'true',
  };
  if (origin && isLocalOrigin(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      ...base,
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
    };
  }
  // Origen no local, ausente o `null`: abierto pero SIN credentials.
  return {
    'Access-Control-Allow-Origin': '*',
    ...base,
  };
}

/** ¿Es una petición preflight OPTIONS? */
export function isPreflight(req: Request): boolean {
  return req.method === 'OPTIONS';
}

/** Respuesta 204 para preflight con las cabeceras CORS adecuadas. */
export function preflightResponse(req: Request): Response {
  const origin = req.headers.get('origin');
  return new Response(null, { status: 204, headers: buildCorsHeaders(origin) });
}

/** Devuelve una copia de `res` con las cabeceras CORS añadidas. */
export function withCors(res: Response, origin: string | null): Response {
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(buildCorsHeaders(origin))) {
    headers.set(key, value);
  }
  return new Response(res.body, { status: res.status, headers });
}
