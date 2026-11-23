/**
 * Clasificador del contenido de los QR que muestra BunDeck.
 *
 * Sin dependencias y sin DOM: lógica pura testeable con `bun test`.
 * El JS inline de la landing (`landing.ts`) incluye un espejo compacto de
 * `classifyQrText`; si se cambian las reglas aquí, hay que actualizarlo allí.
 *
 * QRs que muestra BunDeck (verificado en `web/src`):
 * - Emparejamiento daemon-daemon: JSON `{"v":1,"relay","code","dev","pub","fp","exp"}`
 *   (`daemon/src/api/remote.ts` → `GET /api/v1/remote/qr`, parseado en
 *   `web/src/composables/useRemote.ts` → `parseRemoteQr`).
 * - Acceso remoto por túnel: URL `https://<relay>/ui/<urlCode>`
 *   (`daemon/src/api/remote.ts` → `POST /api/v1/remote/ui-code`).
 * - Misma red: URL `http(s)://<lan-ip>:<puerto>` (pestaña Local de `QrDialog.vue`).
 * - Código de 6 dígitos suelto (aceptar código manual).
 */

export type QrKind =
  | 'pair-qr'
  | 'pair-code'
  | 'relay-url'
  | 'ui-url'
  | 'tunnel-url'
  | 'http-url'
  | 'other';

export interface ClassifiedQr {
  kind: QrKind;
  /** Texto original recortado. */
  text: string;
  /** Código de 6 dígitos (pair-qr, pair-code). */
  code?: string;
  /** URL absoluta (relay-url, ui-url, tunnel-url, http-url). */
  url?: string;
  /** Código de la URL `/ui/<code>` (ui-url). */
  urlCode?: string;
  /** RELAY_URL declarada dentro del QR de emparejamiento (pair-qr). */
  relay?: string;
  /** true si el QR de emparejamiento trae `exp` vencido (pair-qr). */
  expired?: boolean;
}

/** El código de emparejamiento son 6 dígitos (lo genera el daemon). */
export function isPairCode(code: string): boolean {
  return /^\d{6}$/.test(String(code ?? '').trim());
}

/**
 * Clasifica el texto decodificado de un QR. No lanza nunca:
 * lo irreconocible (o vacío) es `{ kind: 'other' }`.
 */
export function classifyQrText(input: unknown, now: number = Date.now()): ClassifiedQr {
  const text = String(input ?? '').trim();
  if (!text) return { kind: 'other', text: '' };

  // 1 · Código suelto de 6 dígitos (aceptar código manual).
  if (isPairCode(text)) return { kind: 'pair-code', text, code: text };

  // 2 · QR de emparejamiento BunDeck: JSON con v/code/dev/pub.
  if (text.startsWith('{')) {
    try {
      const obj: unknown = JSON.parse(text);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const p = obj as Record<string, unknown>;
        if (
          p.v === 1 &&
          isPairCode(String(p.code ?? '')) &&
          typeof p.dev === 'string' &&
          p.dev !== '' &&
          typeof p.pub === 'string' &&
          p.pub !== ''
        ) {
          return {
            kind: 'pair-qr',
            text,
            code: String(p.code).trim(),
            relay: typeof p.relay === 'string' ? p.relay : '',
            expired: typeof p.exp === 'number' ? p.exp <= now : false,
          };
        }
      }
    } catch {
      /* no es JSON: sigue a detección de URL */
    }
    // Era `{…` pero no un QR de emparejamiento válido → otro texto.
    // (Si el JSON parseó a algo distinto, no puede ser URL; si no parseó,
    // tampoco: una URL nunca empieza por `{`.)
    return { kind: 'other', text };
  }

  // 3 · URLs: relay wss://, /ui/<code>, /t/<token>/…, u otra http(s).
  let url: URL | null = null;
  try {
    url = new URL(text);
  } catch {
    url = null;
  }
  if (!url) return { kind: 'other', text };
  const proto = (url.protocol || '').toLowerCase();
  if (proto === 'ws:' || proto === 'wss:') return { kind: 'relay-url', text, url: text };
  if (proto !== 'http:' && proto !== 'https:') return { kind: 'other', text };
  const parts = url.pathname.split('/').filter((p) => p !== '');
  if (parts.length >= 2 && parts[0] === 'ui') {
    return { kind: 'ui-url', text, url: text, urlCode: parts[1] };
  }
  if (parts.length >= 1 && parts[0] === 't') {
    return { kind: 'tunnel-url', text, url: text };
  }
  return { kind: 'http-url', text, url: text };
}
