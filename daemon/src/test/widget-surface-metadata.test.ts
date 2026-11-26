import { describe, expect, test } from 'bun:test'
import { AudioMixerPlugin } from '../plugins/audio-mixer.plugin'
import { GoveePlugin } from '../plugins/govee.plugin'
import { HomeAssistantPlugin } from '../plugins/homeassistant.plugin'
import { HueExtraPlugin } from '../plugins/hue-extra.plugin'
import { MultimediaPlugin } from '../plugins/multimedia.plugin'

const context = { log: () => {} } as any
const actionFor = (plugin: any, id: string) => plugin.getManifest().actions.find((action: any) => action.id === id)
const surface = (component: string) => ({ surface: 'control', component, freeModeOnly: true })

describe('first-party widget surface metadata', () => {
    test('audio mixer exposes only mic mute and output switch as audio controls', () => {
        const plugin = new AudioMixerPlugin(context)
        expect(plugin.getManifest().version).toBe('1.1.1')
        expect(actionFor(plugin, 'mic-mute')).toMatchObject(surface('audio-control'))
        expect(actionFor(plugin, 'output-switch')).toMatchObject(surface('audio-control'))
        expect(actionFor(plugin, 'volume-control')).toMatchObject(surface('volume-range'))
        expect(actionFor(plugin, 'app-volume')).not.toHaveProperty('surface')
    })

    test('multimedia action is rendered by the media transport surface', () => {
        const plugin = new MultimediaPlugin(context)
        expect(plugin.getManifest().version).toBe('1.1.1')
        expect(actionFor(plugin, 'multimedia')).toMatchObject(surface('media-transport'))
    })

    test('Home Assistant surfaces entity and supported light, cover, climate, and sensor aliases', () => {
        const plugin = new HomeAssistantPlugin(context)
        expect(plugin.getManifest().version).toBe('2.1.1')
        for (const id of ['entity', 'light', 'switch', 'cover-control', 'climate-set', 'sensor-value', 'get-state']) {
            expect(actionFor(plugin, id)).toMatchObject(surface('smart-home'))
        }
        expect(actionFor(plugin, 'scene')).not.toHaveProperty('surface')
        expect(actionFor(plugin, 'entity-list')).not.toHaveProperty('surface')
    })

    test('Hue and Govee light actions use the smart-home surface', () => {
        const hue = new HueExtraPlugin(context)
        const govee = new GoveePlugin(context)
        expect(hue.getManifest().version).toBe('1.0.1')
        expect(govee.getManifest().version).toBe('1.0.1')
        for (const plugin of [hue, govee]) {
            for (const id of ['toggle', 'brightness', 'color', 'scene']) {
                expect(actionFor(plugin, id)).toMatchObject(surface('smart-home'))
            }
        }
    })
})
