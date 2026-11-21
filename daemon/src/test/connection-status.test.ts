import { describe, it, expect } from 'bun:test'
import { getRequiredSettings, getPluginConfiguredStatus } from '../plugins/connection-status'

describe('connection-status (genérico, a prueba de futuro)', () => {
    it('sin settingsSchema no requiere configuración', () => {
        const st = getPluginConfiguredStatus({ id: 'page', actions: [] }, {})
        expect(st).toEqual({ configured: true, missing: [], requiresConfiguration: false })
    })

    it('extrae required de settingsSchema y de ui.settingsSchema (legacy)', () => {
        expect(getRequiredSettings({ settingsSchema: { required: ['token'] } })).toEqual(['token'])
        expect(getRequiredSettings({ ui: { settingsSchema: { required: ['a', 'b'] } } })).toEqual(['a', 'b'])
        expect(getRequiredSettings({})).toEqual([])
        expect(getRequiredSettings(null)).toEqual([])
    })

    it('spotify sin token → no configurado, missing=[token]', () => {
        const manifest = { id: 'spotify', settingsSchema: { required: ['token'] } }
        const st = getPluginConfiguredStatus(manifest, {})
        expect(st.configured).toBe(false)
        expect(st.missing).toEqual(['token'])
        expect(st.requiresConfiguration).toBe(true)
    })

    it('spotify con token → configurado', () => {
        const manifest = { id: 'spotify', settingsSchema: { required: ['token'] } }
        expect(getPluginConfiguredStatus(manifest, { token: 'abc' }).configured).toBe(true)
    })

    it('valores vacíos o en blanco cuentan como missing', () => {
        const manifest = { settingsSchema: { required: ['token', 'baseUrl'] } }
        const st = getPluginConfiguredStatus(manifest, { token: '  ', baseUrl: 'http://x' })
        expect(st.configured).toBe(false)
        expect(st.missing).toEqual(['token'])
    })

    it('override explícito requiresConfiguration:false desactiva el gating', () => {
        const manifest = { settingsSchema: { required: ['token'] }, requiresConfiguration: false }
        expect(getPluginConfiguredStatus(manifest, {}).configured).toBe(true)
    })

    it('homeassistant requiere baseUrl+token', () => {
        const manifest = { settingsSchema: { required: ['baseUrl', 'token'] } }
        expect(getPluginConfiguredStatus(manifest, { baseUrl: 'http://x:8123' }).missing).toEqual(['token'])
        expect(getPluginConfiguredStatus(manifest, { baseUrl: 'http://x:8123', token: 't' }).configured).toBe(true)
    })
})
