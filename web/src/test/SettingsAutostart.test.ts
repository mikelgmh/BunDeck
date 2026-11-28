import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  AUTOSTART_KEY,
  parseAutostartSetting,
  formatAutostartSetting,
  loadAutostart,
  saveAutostart,
} from '../composables/useAutostart'
import {
  START_MINIMIZED_KEY,
  parseStartMinimizedSetting,
  formatStartMinimizedSetting,
  loadStartMinimized,
  saveStartMinimized,
} from '../composables/useStartMinimized'

describe('useAutostart: parseo', () => {
  it('acepta booleanos, números y las formas del daemon', () => {
    expect(parseAutostartSetting(true)).toBe(true)
    expect(parseAutostartSetting(false)).toBe(false)
    expect(parseAutostartSetting('true')).toBe(true)
    expect(parseAutostartSetting('false')).toBe(false)
    expect(parseAutostartSetting('1')).toBe(true)
    expect(parseAutostartSetting('0')).toBe(false)
    expect(parseAutostartSetting(1)).toBe(true)
  })

  it('todo lo demás es false (nunca arrancar por defecto)', () => {
    expect(parseAutostartSetting(null)).toBe(false)
    expect(parseAutostartSetting(undefined)).toBe(false)
    expect(parseAutostartSetting('')).toBe(false)
    expect(parseAutostartSetting('basura')).toBe(false)
  })

  it('format produce "true"/"false"', () => {
    expect(formatAutostartSetting(true)).toBe('true')
    expect(formatAutostartSetting(false)).toBe('false')
  })
})

describe('useAutostart: fetch settings (mock)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('loadAutostart pide GET settings?key=system.autostart', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ key: AUTOSTART_KEY, value: 'true' }),
    })
    await expect(loadAutostart('http://localhost:3001/api/v1')).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3001/api/v1/settings?key=${AUTOSTART_KEY}`
    )
  })

  it('loadAutostart propaga el error HTTP (el diálogo muestra el estado)', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 })
    await expect(loadAutostart('http://localhost:3001/api/v1')).rejects.toThrow('HTTP 500')
  })

  it('saveAutostart hace POST con key/value normalizados', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    await saveAutostart('http://localhost:3001/api/v1', true)
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3001/api/v1/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: AUTOSTART_KEY, value: 'true' }),
    })
  })

  it('saveAutostart propaga el error del daemon', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    })
    await expect(saveAutostart('http://localhost:3001/api/v1', false)).rejects.toThrow('boom')
  })
})

describe('useStartMinimized: parseo (default ON)', () => {
  it('ausente o ilegible → true (no robar la ventana)', () => {
    expect(parseStartMinimizedSetting(null)).toBe(true)
    expect(parseStartMinimizedSetting(undefined)).toBe(true)
    expect(parseStartMinimizedSetting('')).toBe(true)
    expect(parseStartMinimizedSetting('basura')).toBe(true)
    expect(parseStartMinimizedSetting({})).toBe(true)
    expect(parseStartMinimizedSetting('false')).toBe(false)
    expect(parseStartMinimizedSetting('0')).toBe(false)
    expect(parseStartMinimizedSetting('off')).toBe(false)
    expect(parseStartMinimizedSetting('disabled')).toBe(false)
  })

  it('acepta booleanos, números y las formas del daemon', () => {
    expect(parseStartMinimizedSetting(true)).toBe(true)
    expect(parseStartMinimizedSetting(false)).toBe(false)
    expect(parseStartMinimizedSetting('true')).toBe(true)
    expect(parseStartMinimizedSetting('false')).toBe(false)
    expect(parseStartMinimizedSetting('1')).toBe(true)
    expect(parseStartMinimizedSetting('0')).toBe(false)
    expect(parseStartMinimizedSetting(0)).toBe(false)
  })

  it('format produce "true"/"false"', () => {
    expect(formatStartMinimizedSetting(true)).toBe('true')
    expect(formatStartMinimizedSetting(false)).toBe('false')
  })
})

describe('useStartMinimized: fetch settings (mock)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('loadStartMinimized pide GET settings?key=system.start_minimized', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ key: START_MINIMIZED_KEY, value: 'true' }),
    })
    await expect(loadStartMinimized('http://localhost:3001/api/v1')).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3001/api/v1/settings?key=${START_MINIMIZED_KEY}`
    )
  })

  it('valor ausente en el daemon → default ON', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ key: START_MINIMIZED_KEY, value: null }),
    })
    await expect(loadStartMinimized('http://localhost:3001/api/v1')).resolves.toBe(true)
  })

  it('saveStartMinimized hace POST con key/value normalizados', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    await saveStartMinimized('http://localhost:3001/api/v1', false)
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3001/api/v1/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: START_MINIMIZED_KEY, value: 'false' }),
    })
  })
})
