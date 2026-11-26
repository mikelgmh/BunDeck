import { afterEach, describe, expect, it } from 'bun:test'
import { DiscordPlugin } from '../plugins/discord.plugin'
import { MeetingsPlugin } from '../plugins/meetings.plugin'
import { SoundboardPlugin } from '../plugins/soundboard.plugin'
import { SpotifyPlugin } from '../plugins/spotify.plugin'
import { VoicemeeterPlugin } from '../plugins/voicemeeter.plugin'
import { VoicemodPlugin } from '../plugins/voicemod.plugin'

const context = { log: () => {}, getSetting: () => null }
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('media and voice control surfaces', () => {
  it('declares the requested safe component ids on plugin actions', () => {
    const manifests = [
      new SpotifyPlugin(context).getManifest(),
      new DiscordPlugin(context).getManifest(),
      new MeetingsPlugin(context).getManifest(),
      new VoicemodPlugin(context).getManifest(),
      new VoicemeeterPlugin(context).getManifest(),
      new SoundboardPlugin(context).getManifest(),
    ]
    const action = (pluginId: string, actionId: string) =>
      manifests.find((manifest) => manifest.id === pluginId)?.actions.find((entry: any) => entry.id === actionId)

    expect(action('spotify', 'now-playing')).toMatchObject({ surface: 'control', component: 'spotify-player' })
    for (const [pluginId, actionId] of [
      ['discord', 'toggle-mute'], ['discord', 'status'],
      ['meetings', 'control'], ['voicemod', 'get-status'],
      ['voicemeeter', 'strip-mute'], ['voicemeeter', 'bus-mute'],
    ]) {
      expect(action(pluginId, actionId)).toMatchObject({ surface: 'control', component: 'voice-panel' })
    }
    expect(action('soundboard', 'play')).toMatchObject({ surface: 'control', component: 'soundboard' })
  })

  it('returns Spotify album art when the Web API provides it', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      is_playing: true,
      item: {
        id: 'track-1',
        name: 'Evening',
        artists: [{ name: 'BunDeck' }],
        album: { images: [{ url: 'https://images.example.test/cover.jpg' }] },
      },
      device: { name: 'Living room' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch

    const plugin = new SpotifyPlugin(context)
    const result = await plugin.getActionHandlers().get('now-playing')!({ token: 'spotify-test-token' }, {})
    expect(result).toMatchObject({
      state: 'playing',
      isPlaying: true,
      track: {
        id: 'track-1',
        name: 'Evening',
        artists: 'BunDeck',
        albumArtUrl: 'https://images.example.test/cover.jpg',
      },
      device: 'Living room',
    })
  })
})
