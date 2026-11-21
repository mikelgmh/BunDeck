// Detección de iOS / Safari en iOS.
//
// En iOS todos los navegadores usan WebKit, pero la Fullscreen API solo está
// disponible en Safari (y ni siquiera ahí en iPhone: `requestFullscreen` no
// existe). Por eso avisamos cuando el usuario entra desde iOS con un
// navegador que no sea Safari.

/** Tokens de navegadores de terceros en iOS (todos basados en WebKit). */
const NON_SAFARI_IOS_TOKENS = [
  'crios', // Chrome en iOS
  'fxios', // Firefox en iOS
  'edgios', // Edge en iOS
  'opios', // Opera en iOS
  'opt/', // Opera Touch en iOS
  'brave', // Brave en iOS (cuando incluye el token)
  'yabrowser', // Yandex en iOS
  'whale', // Naver Whale en iOS
  'line/', // LINE in-app
  'fbav', // Facebook in-app
  'fban/', // Facebook in-app (variante)
  'instagram', // Instagram in-app
  'twitter' // X/Twitter in-app
]

/**
 * ¿El UA corresponde a un dispositivo iOS/iPadOS?
 * Incluye el caso de iPadOS 13+ que se identifica como "Macintosh".
 */
export function isIosDevice(
  userAgent: string,
  platform = '',
  maxTouchPoints = 0
): boolean {
  const ua = userAgent.toLowerCase()
  if (/iphone|ipad|ipod/.test(ua)) return true
  // iPadOS 13+: UA de escritorio ("Macintosh") pero con pantalla táctil.
  if (/macintosh/.test(ua) && platform === 'MacIntel' && maxTouchPoints > 1) {
    return true
  }
  return false
}

/** ¿El UA es Safari (descarta Chrome/Firefox/Edge/etc. en iOS)? */
export function isSafariBrowser(userAgent: string): boolean {
  const ua = userAgent.toLowerCase()
  if (!ua.includes('safari')) return false
  // Safari real no incluye ninguno de estos tokens; los navegadores de
  // terceros en iOS sí (todos añaden su token además de "Safari").
  if (NON_SAFARI_IOS_TOKENS.some((token) => ua.includes(token))) return false
  // Chrome/Firefox/Edge de escritorio también incluyen "Safari" en el UA.
  if (ua.includes('chrome') || ua.includes('chromium')) return false
  if (ua.includes('firefox')) return false
  if (ua.includes('edg/') || ua.includes('edg')) return false
  if (ua.includes('opr/') || ua.includes('opera')) return false
  // Safari genuino envía el token "Version/".
  return ua.includes('version/')
}

/**
 * ¿Hay que mostrar el aviso? Versión pura (testeable) que recibe el UA.
 */
export function shouldShowIosWarningForUserAgent(
  userAgent: string,
  platform = '',
  maxTouchPoints = 0
): boolean {
  return (
    isIosDevice(userAgent, platform, maxTouchPoints) &&
    !isSafariBrowser(userAgent)
  )
}

/** ¿Hay que mostrar el aviso? Lee el navegador actual. */
export function shouldShowIosFullscreenWarning(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false
  }
  return shouldShowIosWarningForUserAgent(
    navigator.userAgent,
    navigator.platform,
    navigator.maxTouchPoints
  )
}
