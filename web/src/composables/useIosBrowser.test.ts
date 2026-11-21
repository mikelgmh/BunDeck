import { describe, it, expect } from 'vitest'
import {
  isIosDevice,
  isSafariBrowser,
  shouldShowIosWarningForUserAgent
} from './useIosBrowser'

const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
const CHROME_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.0.0 Mobile/15E148 Safari/604.1'
const FIREFOX_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/123.0 Mobile/15E148 Safari/605.1.15'
const EDGE_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/121.0.0.0 Mobile/15E148 Safari/605.1.15'
const SAFARI_IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
const CHROME_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'

describe('useIosBrowser', () => {
  it('detecta dispositivos iOS', () => {
    expect(isIosDevice(SAFARI_IPHONE)).toBe(true)
    expect(isIosDevice(SAFARI_IPAD)).toBe(true)
    expect(isIosDevice(CHROME_DESKTOP)).toBe(false)
  })

  it('detecta iPadOS 13+ (UA Macintosh + táctil)', () => {
    const macUA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
    expect(isIosDevice(macUA, 'MacIntel', 5)).toBe(true)
    expect(isIosDevice(macUA, 'MacIntel', 0)).toBe(false)
  })

  it('distingue Safari del resto de navegadores en iOS', () => {
    expect(isSafariBrowser(SAFARI_IPHONE)).toBe(true)
    expect(isSafariBrowser(SAFARI_IPAD)).toBe(true)
    expect(isSafariBrowser(CHROME_IOS)).toBe(false)
    expect(isSafariBrowser(FIREFOX_IOS)).toBe(false)
    expect(isSafariBrowser(EDGE_IOS)).toBe(false)
  })

  it('solo avisa en iOS con navegador no-Safari', () => {
    expect(shouldShowIosWarningForUserAgent(SAFARI_IPHONE)).toBe(false)
    expect(shouldShowIosWarningForUserAgent(CHROME_IOS)).toBe(true)
    expect(shouldShowIosWarningForUserAgent(FIREFOX_IOS)).toBe(true)
    expect(shouldShowIosWarningForUserAgent(EDGE_IOS)).toBe(true)
    expect(shouldShowIosWarningForUserAgent(CHROME_DESKTOP)).toBe(false)
  })
})
