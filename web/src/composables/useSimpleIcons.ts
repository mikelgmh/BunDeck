import { defineComponent, h, type Component } from 'vue'
import {
  siYoutube,
  siTwitch,
  siGithub,
  siSpotify,
  siDiscord,
  siSteam,
  siKick,
  siX,
  siInstagram,
  siFacebook,
  siTiktok,
  siGoogle,
  siGooglechrome,
  siGmail,
  siFirefox,
  siNetflix,
  siReddit,
  siTelegram,
  siWhatsapp,
  siApple,
  siAndroid,
  siGitlab,
  siDocker,
  siFigma,
  siNotion,
  siZoom,
  siPatreon,
  siPaypal,
  siObsstudio,
  siElgato,
  siPlaystation,
  siEpicgames,
  siVlcmediaplayer,
  siWinamp,
} from 'simple-icons'

/**
 * Marcas de Simple Icons (simpleicons.org, CC0) para la pestaña «Marcas»
 * del selector de iconos. El valor guardado es `si:<slug>` (p. ej.
 * `si:youtube`), que resuelven tanto la web (este módulo + useDynamicIcon)
 * como el Stream Deck físico (daemon/src/hw-driver/streamdeck-driver.ts).
 *
 * Lucide trae los genéricos por defecto; las marcas eliminadas de Lucide
 * (YouTube/Twitch/GitHub…) viven aquí con su logo real.
 */

export interface SimpleIconMark {
  /** Valor guardado en `button.data.icon` (`si:<slug>`). */
  name: string
  /** Nombre legible para buscar en el diálogo. */
  title: string
  /** Ruta SVG (glifo sólido 24×24). */
  path: string
}

const MARKS: SimpleIconMark[] = [
  { name: 'si:youtube', title: 'YouTube', path: siYoutube.path },
  { name: 'si:twitch', title: 'Twitch', path: siTwitch.path },
  { name: 'si:github', title: 'GitHub', path: siGithub.path },
  { name: 'si:spotify', title: 'Spotify', path: siSpotify.path },
  { name: 'si:discord', title: 'Discord', path: siDiscord.path },
  { name: 'si:steam', title: 'Steam', path: siSteam.path },
  { name: 'si:kick', title: 'Kick', path: siKick.path },
  { name: 'si:x', title: 'X', path: siX.path },
  { name: 'si:instagram', title: 'Instagram', path: siInstagram.path },
  { name: 'si:facebook', title: 'Facebook', path: siFacebook.path },
  { name: 'si:tiktok', title: 'TikTok', path: siTiktok.path },
  { name: 'si:google', title: 'Google', path: siGoogle.path },
  { name: 'si:googlechrome', title: 'Google Chrome', path: siGooglechrome.path },
  { name: 'si:gmail', title: 'Gmail', path: siGmail.path },
  { name: 'si:firefox', title: 'Firefox', path: siFirefox.path },
  { name: 'si:netflix', title: 'Netflix', path: siNetflix.path },
  { name: 'si:reddit', title: 'Reddit', path: siReddit.path },
  { name: 'si:telegram', title: 'Telegram', path: siTelegram.path },
  { name: 'si:whatsapp', title: 'WhatsApp', path: siWhatsapp.path },
  { name: 'si:apple', title: 'Apple', path: siApple.path },
  { name: 'si:android', title: 'Android', path: siAndroid.path },
  { name: 'si:gitlab', title: 'GitLab', path: siGitlab.path },
  { name: 'si:docker', title: 'Docker', path: siDocker.path },
  { name: 'si:figma', title: 'Figma', path: siFigma.path },
  { name: 'si:notion', title: 'Notion', path: siNotion.path },
  { name: 'si:zoom', title: 'Zoom', path: siZoom.path },
  { name: 'si:patreon', title: 'Patreon', path: siPatreon.path },
  { name: 'si:paypal', title: 'PayPal', path: siPaypal.path },
  { name: 'si:obsstudio', title: 'OBS Studio', path: siObsstudio.path },
  { name: 'si:elgato', title: 'Elgato', path: siElgato.path },
  { name: 'si:playstation', title: 'PlayStation', path: siPlaystation.path },
  { name: 'si:epicgames', title: 'Epic Games', path: siEpicgames.path },
  { name: 'si:vlcmediaplayer', title: 'VLC media player', path: siVlcmediaplayer.path },
  { name: 'si:winamp', title: 'Winamp', path: siWinamp.path },
].sort((a, b) => a.title.localeCompare(b.title, 'es'))

/** Catálogo ordenado para la pestaña «Marcas» del diálogo. */
export const SIMPLE_ICON_LIST: SimpleIconMark[] = MARKS

const byName = new Map<string, SimpleIconMark>(MARKS.map((m) => [m.name, m]))
const compCache = new Map<string, Component>()

/** `true` si el nombre es una marca (`si:<slug>`) del catálogo. */
export function isSimpleIconName(name: unknown): name is string {
  return typeof name === 'string' && /^si:[a-z0-9]+$/.test(name) && byName.has(name)
}

/**
 * Componente Vue del glifo (tintado con `currentColor`, como Lucide vía
 * `textColor`). Acepta `size` como los iconos Lucide; el resto de attrs
 * (`stroke-width`, `aria-hidden`…) caen al `<svg>` y no molestan.
 */
export function simpleIcon(name: unknown): Component | null {
  if (!isSimpleIconName(name)) return null
  let c = compCache.get(name)
  if (!c) {
    const mark = byName.get(name)!
    c = defineComponent({
      name: `SimpleIcon${mark.title.replace(/[^A-Za-z0-9]/g, '')}`,
      props: { size: { type: [Number, String], default: 24 } },
      setup(props) {
        return () =>
          h(
            'svg',
            {
              xmlns: 'http://www.w3.org/2000/svg',
              viewBox: '0 0 24 24',
              width: props.size,
              height: props.size,
              fill: 'currentColor',
              'aria-hidden': 'true',
            },
            [h('path', { d: mark.path })],
          )
      },
    })
    compCache.set(name, c)
  }
  return c
}
