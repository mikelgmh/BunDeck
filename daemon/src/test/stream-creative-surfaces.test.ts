import { describe, expect, it } from 'bun:test'
import { ObsPlugin } from '../plugins/obs.plugin'
import { TwitchPlugin } from '../plugins/twitch.plugin'
import { YoutubePlugin } from '../plugins/youtube.plugin'
import { ShadowplayPlugin } from '../plugins/shadowplay.plugin'
import { PremierePlugin } from '../plugins/premiere.plugin'
import { DavinciPlugin } from '../plugins/davinci.plugin'
import { PhotoshopPlugin } from '../plugins/photoshop.plugin'
import { BlenderPlugin } from '../plugins/blender.plugin'

const context = { log: () => {} }

describe('stream and creative control surfaces', () => {
    it('declares one first-party control surface for each streaming integration', () => {
        const cases = [
            [new ObsPlugin(context), 'status', 'stream-studio'],
            [new TwitchPlugin(context), 'viewer-count', 'stream-studio'],
            [new YoutubePlugin(context), 'viewer-count', 'stream-studio'],
            [new ShadowplayPlugin(context), 'check-status', 'stream-studio'],
        ] as const

        for (const [plugin, actionId, component] of cases) {
            const manifest = plugin.getManifest()
            const surfaces = manifest.actions.filter((action: any) => action.surface === 'control')
            expect(surfaces).toHaveLength(1)
            expect(surfaces[0]).toMatchObject({ id: actionId, surface: 'control', component })
        }
    })

    it('declares one creative-tools surface for each creative application', () => {
        const cases = [
            [new PremierePlugin(context), 'transport'],
            [new DavinciPlugin(context), 'transport'],
            [new PhotoshopPlugin(context), 'brush-size'],
            [new BlenderPlugin(context), 'viewport'],
        ] as const

        for (const [plugin, actionId] of cases) {
            const manifest = plugin.getManifest()
            const surfaces = manifest.actions.filter((action: any) => action.surface === 'control')
            expect(surfaces).toHaveLength(1)
            expect(surfaces[0]).toMatchObject({ id: actionId, surface: 'control', component: 'creative-tools' })
        }
    })
})
