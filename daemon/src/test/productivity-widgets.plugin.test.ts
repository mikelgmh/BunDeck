import { describe, expect, it } from 'bun:test'
import { CalendarPlugin } from '../plugins/calendar.plugin'
import { TimerPlugin } from '../plugins/timer.plugin'
import { PCVitalsPlugin } from '../plugins/pc-vitals.plugin'
import { WeatherPlugin } from '../plugins/weather.plugin'
import { EmailPlugin } from '../plugins/email.plugin'
import { SlackPlugin } from '../plugins/slack.plugin'
import { MinecraftPlugin } from '../plugins/minecraft.plugin'
import { SteamPlugin } from '../plugins/steam.plugin'
import { WebcamPlugin } from '../plugins/webcam.plugin'

const ctx = { log: () => {}, getSetting: () => null }
const manifests = [
    new CalendarPlugin(ctx as any).getManifest(),
    new TimerPlugin(ctx as any).getManifest(),
    new PCVitalsPlugin(ctx as any).getManifest(),
    new WeatherPlugin(ctx as any).getManifest(),
    new EmailPlugin(ctx as any).getManifest(),
    new SlackPlugin(ctx as any).getManifest(),
    new MinecraftPlugin(ctx as any).getManifest(),
    new SteamPlugin(ctx as any).getManifest(),
    new WebcamPlugin(ctx as any).getManifest(),
]

describe('productivity/status widget action metadata', () => {
    it('assigns the calendar agenda and timer controls to their intended surfaces', () => {
        const calendar = manifests.find((manifest) => manifest.id === 'calendar')
        expect(calendar.actions.find((action: any) => action.id === 'next-event')).toMatchObject({
            surface: 'control', component: 'calendar-agenda', freeModeOnly: true, pollMs: 60000,
        })
        const timer = manifests.find((manifest) => manifest.id === 'timer')
        for (const id of ['status', 'start', 'stop']) {
            expect(timer.actions.find((action: any) => action.id === id)).toMatchObject({
                surface: 'control', component: 'pomodoro', freeModeOnly: true,
            })
        }
    })

    it('exposes supported read-only and explicit-action cards without changing action IDs', () => {
        const expected: Record<string, string[]> = {
            'pc-vitals': ['summary', 'monitor', 'fan-speed', 'disk-usage', 'net-speed', 'uptime', 'process-top'],
            weather: ['now', 'forecast'],
            email: ['unread', 'open-inbox'],
            slack: ['unread-count', 'open-channel'],
            minecraft: ['server-status', 'query-latency'],
            steam: ['presence', 'server-status'],
            webcam: ['snapshot'],
        }
        for (const [pluginId, ids] of Object.entries(expected)) {
            const manifest = manifests.find((item) => item.id === pluginId)!
            for (const id of ids) {
                expect(manifest.actions.find((action: any) => action.id === id)).toMatchObject({
                    surface: 'control', component: 'status-cards', freeModeOnly: true,
                })
            }
        }
    })
})
