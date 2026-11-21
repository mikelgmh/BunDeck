/**
 * discord.plugin.test.ts — tests del plugin nativo Discord.
 * Sin enviar atajos reales: solo manifest, validación de parámetros
 * y errores amigables sin configuración.
 */
import { describe, it, expect } from 'bun:test'
import { DiscordPlugin, sendHotkey } from '../plugins/discord.plugin'

const noopCtx = { log: (_l: string, _m: string, _meta?: any) => {}, getSetting: (_k: string) => null }
const plugin = new DiscordPlugin(noopCtx as any)

describe('DiscordPlugin manifest', () => {
    it('expone un manifest válido en español', () => {
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('discord')
        expect(manifest.name).toBe('Discord')
        expect(manifest.version).toBe('1.0.0')
        expect(manifest.author).toBe('BunDeck')
        expect(manifest.settingsSchema).toBeDefined()
        const ids = manifest.actions.map((a: any) => a.id).sort()
        expect(ids).toEqual(['open-channel', 'push-to-talk', 'toggle-deafen', 'toggle-mute'])
        for (const action of manifest.actions) {
            expect(action.schema?.type).toBe('object')
            for (const [key, prop] of Object.entries<any>(action.schema.properties)) {
                expect(prop.title, `${action.id}.${key} debe tener title`).toBeDefined()
            }
        }
    })

    it('registra los 4 handlers', () => {
        const handlers = plugin.getActionHandlers()
        expect([...handlers.keys()].sort()).toEqual(['open-channel', 'push-to-talk', 'toggle-deafen', 'toggle-mute'])
    })
})

describe('DiscordPlugin validación (sin tocar el sistema)', () => {
    it('sendHotkey rechaza atajos vacíos', async () => {
        await expect(sendHotkey('')).rejects.toThrow(/vacío/)
    })

    it('sendHotkey rechaza atajos sin tecla principal', async () => {
        await expect(sendHotkey('ctrl+shift+')).rejects.toThrow(/tecla principal|vacío/)
    })

    it('push-to-talk sin hotkey pide configurarlo', async () => {
        const handler = plugin.getActionHandlers().get('push-to-talk')!
        await expect(handler({}, {})).rejects.toThrow(/Pulsar para hablar/)
    })

    it('open-channel exige url', async () => {
        const handler = plugin.getActionHandlers().get('open-channel')!
        await expect(handler({}, {})).rejects.toThrow(/url/)
    })

    it('open-channel rechaza URLs que no son de Discord', async () => {
        const handler = plugin.getActionHandlers().get('open-channel')!
        await expect(handler({ url: 'https://example.com/abc' }, {})).rejects.toThrow(/no válida/)
    })
})
