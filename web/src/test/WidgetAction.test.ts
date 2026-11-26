import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeWidgetAction } from '../composables/useWidgetAction'

describe('executeWidgetAction', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('ejecuta una acción por la API oficial con contexto de widget', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, result: { value: 42 } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await executeWidgetAction('http://localhost:3001', 'pc-vitals.uptime', {})

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/api/v1/actions/execute',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const request = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(request).toEqual({
      action: { type: 'pc-vitals.uptime', parameters: {} },
      context: { quiet: true, source: 'widget-control' },
    })
    expect(result).toEqual({ value: 42 })
  })

  it('propaga el error HTTP del daemon', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Servicio temporalmente no disponible',
    }))

    await expect(executeWidgetAction('', 'spotify.now-playing'))
      .rejects.toThrow('Servicio temporalmente no disponible')
  })

  it('convierte success:false del ActionRunner en error para el widget', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, error: 'Action is already running' }),
    }))

    await expect(executeWidgetAction('', 'pc-vitals.summary'))
      .rejects.toThrow('Action is already running')
  })
})
