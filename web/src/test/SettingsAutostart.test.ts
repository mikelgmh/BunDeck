import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  AUTOSTART_KEY,
  parseAutostartSetting,
  formatAutostartSetting,
  loadAutostart,
  saveAutostart,
} from '../composables/useAutostart'

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
