/**
 * Native Plugins Index
 * Exports all native plugins that come bundled with LibreDeck
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
    SpotifyPlugin
}