/**
 * Native Plugins Index
 * Exports all native plugins that come bundled with BunDeck
 */

import { MultimediaPlugin } from './multimedia.plugin'
import { ShellPlugin } from './shell.plugin'
import { HttpPlugin } from './http.plugin'
import { UtilityPlugin } from './utility.plugin'
import { HotkeyPlugin } from './hotkey.plugin'
import { TypeTextPlugin } from './type-text.plugin'
import { OpenAppPlugin } from './open-app.plugin'
import { PagePlugin } from './page.plugin'
import { BrowserPlugin } from './browser.plugin'
import { PCVitalsPlugin } from './pc-vitals.plugin'
import { ObsPlugin } from './obs.plugin'
import { HomeAssistantPlugin } from './homeassistant.plugin'
import { SpotifyPlugin } from './spotify.plugin'
import { AudioMixerPlugin } from './audio-mixer.plugin'
import { WindowManagerPlugin } from './window-manager.plugin'
import { MeetingsPlugin } from './meetings.plugin'
import { SlackPlugin } from './slack.plugin'
import { CalendarPlugin } from './calendar.plugin'
import { TimerPlugin } from './timer.plugin'
import { ClipboardPlugin } from './clipboard.plugin'
import { MultiactionPlugin } from './multiaction.plugin'
import { ProfileAutoPlugin } from './profile-auto.plugin'
import { DiscordPlugin } from './discord.plugin'
import { TwitchPlugin } from './twitch.plugin'
import { YoutubePlugin } from './youtube.plugin'
import { SoundboardPlugin } from './soundboard.plugin'
import { VoicemodPlugin } from './voicemod.plugin'
import { VoicemeeterPlugin } from './voicemeeter.plugin'
import { ShadowplayPlugin } from './shadowplay.plugin'
import { WebcamPlugin } from './webcam.plugin'
import { PhotoshopPlugin } from './photoshop.plugin'
import { PremierePlugin } from './premiere.plugin'
import { DavinciPlugin } from './davinci.plugin'
import { BlenderPlugin } from './blender.plugin'
import { MidiOscPlugin } from './midi-osc.plugin'
import { SteamPlugin } from './steam.plugin'
import { MinecraftPlugin } from './minecraft.plugin'
import { HueExtraPlugin } from './hue-extra.plugin'
import { GoveePlugin } from './govee.plugin'

export interface NativePlugin {
    getManifest(): any
    getActionHandlers(): Map<string, any>
    dispose(): void
}

/**
 * Get all native plugins
 */
export function getNativePlugins(): NativePlugin[] {
    return [
        // Plugins are loaded by ActionRunner
    ]
}

/**
 * Manifiestos de los plugins nativos sin instanciar el ActionRunner
 * (útil como fallback cuando la DB aún no tiene el registro).
 */
export function getNativeManifests(): any[] {
  const noop: any = { log: () => {}, getSetting: () => null, setSetting: () => {}, deleteSetting: () => {} };
  return [
    new MultimediaPlugin(noop),
    new ShellPlugin(noop),
    new HttpPlugin(noop),
    new UtilityPlugin(noop),
    new HotkeyPlugin(noop),
    new TypeTextPlugin(noop),
    new OpenAppPlugin(noop),
    new PagePlugin(noop),
    new BrowserPlugin(noop),
    new PCVitalsPlugin(noop),
    new ObsPlugin(noop),
    new HomeAssistantPlugin(noop),
    new SpotifyPlugin(noop),
    new AudioMixerPlugin(noop),
    new WindowManagerPlugin(noop),
    new MeetingsPlugin(noop),
    new SlackPlugin(noop),
    new CalendarPlugin(noop),
    new TimerPlugin(noop),
    new ClipboardPlugin(noop),
    new MultiactionPlugin(noop),
    new ProfileAutoPlugin(noop),
    new DiscordPlugin(noop),
    new TwitchPlugin(noop),
    new YoutubePlugin(noop),
    new SoundboardPlugin(noop),
    new VoicemodPlugin(noop),
    new VoicemeeterPlugin(noop),
    new ShadowplayPlugin(noop),
    new WebcamPlugin(noop),
    new PhotoshopPlugin(noop),
    new PremierePlugin(noop),
    new DavinciPlugin(noop),
    new BlenderPlugin(noop),
    new MidiOscPlugin(noop),
    new SteamPlugin(noop),
    new MinecraftPlugin(noop),
    new HueExtraPlugin(noop),
    new GoveePlugin(noop),
  ].map((p) => {
    try { return p.getManifest(); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Create a native plugin instance with context
 */
export function createNativePlugin(pluginClass: any, context: any): NativePlugin {
    return new pluginClass(context)
}

// Export plugin classes
export {
    MultimediaPlugin,
    ShellPlugin,
    HttpPlugin,
    UtilityPlugin,
    HotkeyPlugin,
    TypeTextPlugin,
    OpenAppPlugin,
    PagePlugin,
    BrowserPlugin,
    PCVitalsPlugin,
    ObsPlugin,
    HomeAssistantPlugin,
    SpotifyPlugin,
    AudioMixerPlugin,
    WindowManagerPlugin,
    MeetingsPlugin,
    SlackPlugin,
    CalendarPlugin,
    TimerPlugin,
    ClipboardPlugin,
    MultiactionPlugin,
    ProfileAutoPlugin,
    DiscordPlugin,
    TwitchPlugin,
    YoutubePlugin,
    SoundboardPlugin,
    VoicemodPlugin,
    VoicemeeterPlugin,
    ShadowplayPlugin,
    WebcamPlugin,
    PhotoshopPlugin,
    PremierePlugin,
    DavinciPlugin,
    BlenderPlugin,
    MidiOscPlugin,
    SteamPlugin,
    MinecraftPlugin,
    HueExtraPlugin,
    GoveePlugin
}