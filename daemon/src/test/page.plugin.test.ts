import { describe, it, expect } from 'bun:test'
import { PagePlugin } from '../plugins/page.plugin'

function makePlugin() {
    const logs: Array<{ level: string; message: string; meta?: any }> = []
    const plugin = new PagePlugin({
        log: (level: string, message: string, meta?: any) => {
            logs.push({ level, message, meta })
        }
    })
    return { plugin, logs }
}

describe('PagePlugin', () => {
    it('expone un manifest válido con la acción page', () => {
        const { plugin } = makePlugin()
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('page')
        expect(manifest.version).toBe('1.0.1')
        expect(manifest.actions).toHaveLength(1)
        expect(manifest.actions[0].id).toBe('page')
        expect(manifest.actions[0].schema.required).toEqual(['pageId'])
        expect(manifest.actions[0].schema.properties.pageId.title).toBeString()
        expect(JSON.parse(JSON.stringify(manifest.actions[0].schema))).toEqual(manifest.actions[0].schema)
    })

    it('registra el handler page', () => {
        const { plugin } = makePlugin()
        expect(plugin.getActionHandlers().has('page')).toBe(true)
    })

    it('navega a la página y devuelve el resultado de navegación', async () => {
        const { plugin, logs } = makePlugin()
        const res = await plugin.getActionHandlers().get('page')!({ pageId: 'p1', pageName: 'Principal' }, { timestamp: 1 })
        expect(res).toMatchObject({ pageId: 'p1', pageName: 'Principal', action: 'navigate_to_page', navigated: true })
        expect(logs.some((l) => l.message.includes('p1') || l.message.includes('Principal'))).toBe(true)
    })

    it('exige pageId', async () => {
        const { plugin } = makePlugin()
        await expect(plugin.getActionHandlers().get('page')!({}, {})).rejects.toThrow(/Page ID is required/)
    })

    it('dispose no falla', () => {
        const { plugin } = makePlugin()
        expect(() => plugin.dispose()).not.toThrow()
    })
})
