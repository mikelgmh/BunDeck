/** Landing pública del relay (GET /). Sin dependencias, CSS/JS inline. */

export type LandingLang = 'es' | 'en';

export function pickLang(req: Request): LandingLang {
  const raw = (req.headers.get('accept-language') ?? '').trim().toLowerCase();
  if (!raw) return 'es';
  // Respeta orden/q: mira el primer tag con q > 0.
  for (const part of raw.split(',')) {
    const [tag, ...params] = part.trim().split(';');
    const t = tag.trim();
    if (!t) continue;
    const q = params.find((p) => p.trim().startsWith('q='));
    if (q && Number(q.slice(2).trim()) === 0) continue;
    if (t === 'en' || t.startsWith('en-')) return 'en';
    if (t === 'es' || t.startsWith('es-')) return 'es';
    // Cualquier otro idioma: si es la primera preferencia y no es es/en,
    // cae al default ES solo si no hay un 'en' después con peso.
    if (t && !t.startsWith('*')) return t.startsWith('en') ? 'en' : 'es';
  }
  return 'es';
}

/** Host público para mostrar la URL: RELAY_DOMAIN gana; si no, el Host del request. */
export function publicHostname(req: Request, domain = ''): string {
  const d = domain.trim().replace(/\/+$/, '');
  if (d) return d.replace(/^wss?:\/\//, '').split('/')[0];
  const fwd = (req.headers.get('x-forwarded-host') ?? '').split(',')[0].trim();
  if (fwd) return fwd.split('/')[0];
  try {
    return new URL(req.url).host;
  } catch {
    return 'localhost';
  }
}

/** URL wss:// lista para pegar como RELAY_URL (autodetecta host del request). */
export function relayWsUrl(req: Request, domain = ''): string {
  return `wss://${publicHostname(req, domain)}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface LandingData {
  version: string;
  online: number;
  devices: number;
  wsUrl: string;
  lang: LandingLang;
}

const STR = {
  es: {
    lang: 'es',
    badge: 'en línea',
    subtitle: 'Relay E2E de BunDeck: conecta tu mando y tu equipo aunque no estén en la misma red.',
    whatTitle: '¿Qué es esto?',
    what: 'Este servidor es un <strong>router opaco de extremo a extremo</strong>: reenvía mensajes cifrados entre tus dispositivos por <code>deviceId</code> <strong>sin leer ni guardar tus comandos</strong>. Si el destino está offline, responde error y descarta el mensaje (sin cola).',
    stepsTitle: 'Cómo conectar (2 min)',
    s1t: '1 · En BunDeck abre Ajustes → Acceso remoto',
    s1b: 'Activa el acceso remoto en el equipo que hace de anfitrión.',
    s2t: '2 · Pega la URL y el token de este servidor',
    s2b: 'Copia la URL de abajo como <code>RELAY_URL</code> y pega el <code>RELAY_TOKEN</code> de tu servidor (el anfitrión y el mando deben usar el mismo token).',
    s3t: '3 · Genera el código y acéptalo en el otro equipo',
    s3b: 'El anfitrión genera un código de 6 dígitos (<code>POST /pair</code>) y el otro equipo lo introduce para emparejar. Caduca en 5 minutos y es de un solo uso.',
    copy: 'Copiar URL',
    copied: '¡Copiada!',
    urlLabel: 'Tu URL de relay (RELAY_URL)',
    tokenHint: 'El RELAY_TOKEN te lo da quien administre este servidor. Nunca se muestra aquí.',
    statusTitle: 'Estado',
    online: 'dispositivos conectados ahora',
    known: 'dispositivos conocidos',
    version: 'versión',
    docs: 'Ver documentación del relay',
    api: '¿Eres un cliente? <code>Accept: application/json</code> en <code>/</code> devuelve <code>{service, version, online}</code>. Salud: <code>/health</code>.',
    footer: 'BunDeck Relay · E2E opaco · Tus comandos nunca se ven aquí',
  },
  en: {
    lang: 'en',
    badge: 'online',
    subtitle: 'BunDeck E2E relay: connect your controller and your rig even when they are not on the same network.',
    whatTitle: 'What is this?',
    what: 'This server is an <strong>opaque end-to-end router</strong>: it forwards encrypted messages between your devices by <code>deviceId</code> <strong>without reading or storing your commands</strong>. If the destination is offline it answers with an error and drops the message (no queue).',
    stepsTitle: 'How to connect (2 min)',
    s1t: '1 · In BunDeck open Settings → Remote access',
    s1b: 'Enable remote access on the host machine.',
    s2t: '2 · Paste this server URL and token',
    s2b: 'Copy the URL below as <code>RELAY_URL</code> and paste your server <code>RELAY_TOKEN</code> (host and controller must share the same token).',
    s3t: '3 · Generate the code and accept it on the other device',
    s3b: 'The host generates a 6-digit code (<code>POST /pair</code>) and the other device enters it to pair. It expires in 5 minutes and is single-use.',
    copy: 'Copy URL',
    copied: 'Copied!',
    urlLabel: 'Your relay URL (RELAY_URL)',
    tokenHint: 'The RELAY_TOKEN is provided by whoever runs this server. It is never shown here.',
    statusTitle: 'Status',
    online: 'devices connected right now',
    known: 'known devices',
    version: 'version',
    docs: 'Read the relay docs',
    api: 'Are you a client? <code>Accept: application/json</code> on <code>/</code> returns <code>{service, version, online}</code>. Health: <code>/health</code>.',
    footer: 'BunDeck Relay · opaque E2E · Your commands are never visible here',
  },
} as const;

export function renderLanding(d: LandingData): string {
  const t = STR[d.lang];
  const ws = esc(d.wsUrl);
  return `<!doctype html>
<html lang="${t.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BunDeck Relay — ${d.lang === 'es' ? 'cómo conectar' : 'how to connect'}</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;line-height:1.55;background:#0f172a;color:#e2e8f0}
@media(prefers-color-scheme:light){body{background:#f1f5f9;color:#0f172a}}
.wrap{max-width:720px;margin:0 auto;padding:32px 20px 64px}
.badge{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;background:#052e16;color:#86efac;border:1px solid #166534;border-radius:999px;padding:4px 14px}
.dot{width:9px;height:9px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e}
h1{font-size:32px;margin:16px 0 4px}
.sub{opacity:.8;margin:0 0 24px}
.card{background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.25);border-radius:14px;padding:18px 20px;margin:16px 0}
.card h2{font-size:17px;margin:0 0 8px}
ol{margin:8px 0;padding-left:22px}
li{margin:12px 0}
code{background:rgba(148,163,184,.18);padding:2px 7px;border-radius:6px;font-size:13.5px;word-break:break-all}
.urlbox{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.urlbox code{flex:1;min-width:220px;font-size:15px;padding:10px 12px}
button{cursor:pointer;border:0;border-radius:10px;padding:10px 18px;font-weight:700;background:#22c55e;color:#052e16}
button:active{transform:scale(.97)}
.hint{font-size:13px;opacity:.75;margin-top:8px}
.stats{display:flex;gap:22px;flex-wrap:wrap;font-size:14px}
.stats b{font-size:22px;display:block}
a{color:#4ade80}
.foot{margin-top:28px;font-size:12.5px;opacity:.6;text-align:center}
</style>
</head>
<body>
<div class="wrap">
<span class="badge"><span class="dot"></span>${t.badge} · v${esc(d.version)}</span>
<h1>BunDeck Relay</h1>
<p class="sub">${t.subtitle}</p>
<div class="card"><h2>${t.whatTitle}</h2><p>${t.what}</p></div>
<div class="card"><h2>${t.stepsTitle}</h2>
<ol>
<li><strong>${t.s1t}</strong><br>${t.s1b}</li>
<li><strong>${t.s2t}</strong><br>${t.s2b}
<div class="urlbox"><code id="relay-url">${ws}</code><button id="copy-btn" type="button">${t.copy}</button></div>
<div class="hint">${t.urlLabel} · ${t.tokenHint}</div></li>
<li><strong>${t.s3t}</strong><br>${t.s3b}</li>
</ol>
</div>
<div class="card"><h2>${t.statusTitle}</h2>
<div class="stats">
<div><b>${d.online}</b>${t.online}</div>
<div><b>${d.devices}</b>${t.known}</div>
<div><b>v${esc(d.version)}</b>${t.version}</div>
</div></div>
<p><a href="https://github.com/mikelgranero/libredeck/tree/master/relay">${t.docs} →</a></p>
<p style="font-size:13px;opacity:.7">${t.api}</p>
<p class="foot">${t.footer}</p>
</div>
<script>
(function(){var b=document.getElementById('copy-btn'),u=document.getElementById('relay-url');if(!b||!u)return;var done='${t.copied}';b.addEventListener('click',function(){var txt=u.textContent||'';function ok(){var o=b.textContent;b.textContent=done;setTimeout(function(){b.textContent=o;},1500);}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(ok,ok);}else{var ta=document.createElement('textarea');ta.value=txt;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');}catch(e){}document.body.removeChild(ta);ok();}});})();
</script>
</body>
</html>`;
}
