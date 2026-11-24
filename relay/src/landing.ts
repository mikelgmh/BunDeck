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
    subtitle: 'Relay de BunDeck con WebRTC P2P: conexión directa cifrada entre tus dispositivos cuando la red lo permite, con el relay como señalización y alternativa.',
    whatTitle: '¿Qué es esto?',
    what: 'Este servidor cumple <strong>dos funciones</strong>: <strong>1) señalización WebRTC</strong>, para que tus dispositivos negocien una <strong>conexión directa P2P cifrada de extremo a extremo</strong> (ese tráfico <strong>no pasa por aquí</strong>); y <strong>2) relay de respaldo</strong>, que proxea la UI y la API por túnel cuando el P2P no es posible (NAT simétrico). En modo relay el operador sí puede ver el tráfico (protegido con TLS hasta aquí). El emparejamiento E2E por <code>deviceId</code> sigue siendo opaco: sin leer ni guardar tus comandos y sin cola.',
    transportTitle: '¿P2P o relay?',
    transport: 'Tu navegador <strong>intenta primero P2P</strong>. Si conecta, verás <strong>P2P</strong> en el remoto y en la lista de sesiones del anfitrión (el relay solo hizo de presentador). Si la red lo bloquea, verás <strong>Relay</strong> y todo seguirá funcionando por el túnel. El anfitrión aprueba el acceso <strong>antes</strong> de saber el transporte final, y siempre puede revocar la sesión.',
    stepsTitle: 'Cómo conectar (2 min)',
    s1t: '1 · En BunDeck abre Ajustes → Acceso remoto',
    s1b: 'Activa el acceso remoto en el equipo que hace de anfitrión.',
    s2t: '2 · Este relay es privado: exige token',
    s2b: 'Tu BunDeck lo usa con <code>RELAY_URL</code> + <code>RELAY_TOKEN</code> ya configurados. Sin token el WS y <code>POST /pair</code> responden <code>401</code>; la UI remota (<code>/ui</code>, <code>/t</code>) sigue pidiendo aprobación del anfitrión.',
    s3t: '3 · Genera el código y acéptalo en el otro equipo',
    s3b: 'El anfitrión genera un código de 6 dígitos (<code>POST /pair</code>) y el otro equipo lo introduce para emparejar. Caduca en 5 minutos y es de un solo uso.',
    copy: 'Copiar URL',
    copied: '¡Copiada!',
    urlLabel: 'Tu URL de relay (RELAY_URL)',
    tokenHint: 'Privado con token: solo tus equipos pueden usar la señalización y el túnel. El emparejamiento y el acceso remoto siguen exigiendo tu aprobación explícita.',
    statusTitle: 'Estado',
    online: 'dispositivos conectados ahora',
    known: 'dispositivos conocidos',
    version: 'versión',
    docs: 'Ver documentación del relay',
    api: '¿Eres un cliente? <code>Accept: application/json</code> en <code>/</code> devuelve <code>{service, version, online}</code>. Salud: <code>/health</code>.',
    scanTitle: 'Escanear un QR de BunDeck',
    scanSub: 'Apunta la cámara al QR que muestra tu BunDeck (emparejamiento o acceso remoto) y te diremos qué es y qué hacer con él. Funciona en el móvil y tras reverse proxy.',
    scanOpen: 'Escanear QR',
    scanClose: 'Detener cámara',
    scanAgain: 'Escanear otro',
    scanNoCam: 'Sin cámara o permiso denegado. Pega el contenido del QR abajo.',
    scanNoNative: 'No se pudo cargar el detector QR en este navegador: pega el contenido del QR abajo.',
    scanLoadingFallback: 'Cargando detector QR compatible…',
    scanPastePh: '…o pega aquí el texto del QR',
    scanValidate: 'Validar',
    scanCopy: 'Copiar',
    scanOpenUrl: 'Abrir enlace',
    scanResult: 'Resultado',
    scanPairHint: 'Código de 6 dígitos: introdúcelo en tu BunDeck en Ajustes → Acceso remoto → Aceptar código.',
    scanPairQrHint: 'QR de emparejamiento de BunDeck. Acepta el código en tu BunDeck (Ajustes → Acceso remoto).',
    scanRelayHint: 'URL de relay (wss): úsala como RELAY_URL en tu BunDeck.',
    scanUiHint: 'Enlace de acceso remoto: ábrelo en el móvil para pedir acceso y apruébalo en el equipo anfitrión.',
    scanTunnelHint: 'Enlace tuneleado: ábrelo para cargar la UI remota de BunDeck.',
    scanHttpHint: 'Enlace web incluido en el QR.',
    scanOtherHint: 'Texto sin formato reconocido: cópialo donde lo necesites.',
    scanExpired: 'Aviso: este QR ya caducó; genera uno nuevo.',
    scanJsqrNote: 'La cámara usa BarcodeDetector nativo cuando existe (Chrome/Edge). En otros navegadores como Safari se carga bajo demanda un detector compatible auto-hospedado (/vendor, cacheado); si falla la carga, usa el pegado manual.',
    scanKindPairQr: 'QR de emparejamiento',
    scanKindPairCode: 'Código de emparejamiento',
    scanKindRelayUrl: 'URL de relay',
    scanKindUiUrl: 'Acceso remoto (/ui/)',
    scanKindTunnelUrl: 'Enlace tuneleado (/t/)',
    scanKindHttpUrl: 'Enlace web',
    scanKindOther: 'Texto',
    footer: 'BunDeck Relay · WebRTC P2P + fallback por relay · El P2P no pasa por aquí',
  },
  en: {
    lang: 'en',
    badge: 'online',
    subtitle: 'BunDeck relay with WebRTC P2P: encrypted direct connection between your devices when the network allows it, with the relay as signaling and fallback.',
    whatTitle: 'What is this?',
    what: 'This server has <strong>two jobs</strong>: <strong>1) WebRTC signaling</strong>, so your devices can negotiate an <strong>encrypted end-to-end P2P connection</strong> (that traffic <strong>never goes through here</strong>); and <strong>2) fallback relay</strong>, proxying the UI and API over a tunnel when P2P is not possible (symmetric NAT). In relay mode the operator can see the traffic (TLS-protected up to here). E2E pairing by <code>deviceId</code> stays opaque: no reading or storing your commands, no queue.',
    transportTitle: 'P2P or relay?',
    transport: 'Your browser <strong>tries P2P first</strong>. If it connects you will see <strong>P2P</strong> on the remote and in the host sessions list (the relay only introduced them). If the network blocks it, you will see <strong>Relay</strong> and everything keeps working over the tunnel. The host approves access <strong>before</strong> knowing the final transport, and can always revoke the session.',
    stepsTitle: 'How to connect (2 min)',
    s1t: '1 · In BunDeck open Settings → Remote access',
    s1b: 'Enable remote access on the host machine.',
    s2t: '2 · This relay is private: token required',
    s2b: 'Your BunDeck uses it with <code>RELAY_URL</code> + <code>RELAY_TOKEN</code> already configured. Without a token the WS and <code>POST /pair</code> answer <code>401</code>; the remote UI (<code>/ui</code>, <code>/t</code>) still asks the host for approval.',
    s3t: '3 · Generate the code and accept it on the other device',
    s3b: 'The host generates a 6-digit code (<code>POST /pair</code>) and the other device enters it to pair. It expires in 5 minutes and is single-use.',
    copy: 'Copy URL',
    copied: 'Copied!',
    urlLabel: 'Your relay URL (RELAY_URL)',
    tokenHint: 'Private with token: only your devices can use signaling and the tunnel. Pairing and remote access still require your explicit approval.',
    statusTitle: 'Status',
    online: 'devices connected right now',
    known: 'known devices',
    version: 'version',
    docs: 'Read the relay docs',
    api: 'Are you a client? <code>Accept: application/json</code> on <code>/</code> returns <code>{service, version, online}</code>. Health: <code>/health</code>.',
    scanTitle: 'Scan a BunDeck QR',
    scanSub: 'Point the camera at the QR shown by your BunDeck (pairing or remote access) and we will tell you what it is and what to do with it. Works on mobile and behind a reverse proxy.',
    scanOpen: 'Scan QR',
    scanClose: 'Stop camera',
    scanAgain: 'Scan another',
    scanNoCam: 'No camera or permission denied. Paste the QR content below.',
    scanNoNative: 'Could not load the QR detector in this browser: paste the QR content below.',
    scanLoadingFallback: 'Loading compatible QR detector…',
    scanPastePh: '…or paste the QR text here',
    scanValidate: 'Validate',
    scanCopy: 'Copy',
    scanOpenUrl: 'Open link',
    scanResult: 'Result',
    scanPairHint: '6-digit code: enter it in your BunDeck under Settings → Remote access → Accept code.',
    scanPairQrHint: 'BunDeck pairing QR. Accept the code in your BunDeck (Settings → Remote access).',
    scanRelayHint: 'Relay URL (wss): use it as RELAY_URL in your BunDeck.',
    scanUiHint: 'Remote access link: open it on the phone to request access and approve it on the host machine.',
    scanTunnelHint: 'Tunnelled link: open it to load the remote BunDeck UI.',
    scanHttpHint: 'Web link contained in the QR.',
    scanOtherHint: 'Unrecognized plain text: copy it wherever you need it.',
    scanExpired: 'Warning: this QR already expired; generate a new one.',
    scanJsqrNote: 'The camera uses the native BarcodeDetector when available (Chrome/Edge). On other browsers like Safari a self-hosted compatible detector (/vendor, cached) loads on demand; if loading fails, use manual paste.',
    scanKindPairQr: 'Pairing QR',
    scanKindPairCode: 'Pairing code',
    scanKindRelayUrl: 'Relay URL',
    scanKindUiUrl: 'Remote access (/ui/)',
    scanKindTunnelUrl: 'Tunnelled link (/t/)',
    scanKindHttpUrl: 'Web link',
    scanKindOther: 'Text',
    footer: 'BunDeck Relay · WebRTC P2P + relay fallback · P2P never goes through here',
  },
} as const;

export function renderLanding(d: LandingData): string {
  const t = STR[d.lang];
  const ws = esc(d.wsUrl);
  // Cadenas para el JS del escáner (JSON = comillas seguras; se escapa `</`).
  const L = JSON.stringify({
    open: t.scanOpen,
    close: t.scanClose,
    again: t.scanAgain,
    noCam: t.scanNoCam,
    noNative: t.scanNoNative,
    loading: t.scanLoadingFallback,
    copy: t.scanCopy,
    copied: t.copied,
    kinds: {
      'pair-qr': t.scanKindPairQr,
      'pair-code': t.scanKindPairCode,
      'relay-url': t.scanKindRelayUrl,
      'ui-url': t.scanKindUiUrl,
      'tunnel-url': t.scanKindTunnelUrl,
      'http-url': t.scanKindHttpUrl,
      other: t.scanKindOther,
    },
    hints: {
      pairQr: t.scanPairQrHint,
      pairCode: t.scanPairHint,
      relayUrl: t.scanRelayHint,
      uiUrl: t.scanUiHint,
      tunnelUrl: t.scanTunnelHint,
      httpUrl: t.scanHttpHint,
      other: t.scanOtherHint,
    },
  }).replace(/<\//g, '<\\/');
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
a.abtn{display:inline-block;text-decoration:none;background:#22c55e;color:#052e16;border-radius:10px;padding:10px 18px;font-weight:700}
[hidden]{display:none!important}
#qrscan-video{width:100%;max-height:320px;border-radius:10px;background:#000;object-fit:cover;margin-top:10px}
#qrscan-paste{width:100%;box-sizing:border-box;border-radius:10px;padding:10px 12px;font:inherit;font-size:13.5px;background:rgba(148,163,184,.12);color:inherit;border:1px solid rgba(148,163,184,.25);margin-top:10px}
.btnrow{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.err{color:#f87171;font-size:13px}
.kind{display:inline-block;font-size:12.5px;font-weight:700;background:rgba(34,197,94,.15);border:1px solid #166534;border-radius:999px;padding:2px 10px}
.bigcode{font-size:30px;letter-spacing:8px;font-weight:800;margin:8px 0}
.resbox{margin-top:10px}
.resbox code{display:block}
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
<div class="card"><h2>${t.transportTitle}</h2><p>${t.transport}</p></div>
<div class="card"><h2>${t.stepsTitle}</h2>
<ol>
<li><strong>${t.s1t}</strong><br>${t.s1b}</li>
<li><strong>${t.s2t}</strong><br>${t.s2b}
<div class="urlbox"><code id="relay-url">${ws}</code><button id="copy-btn" type="button">${t.copy}</button></div>
<div class="hint">${t.urlLabel} · ${t.tokenHint}</div></li>
<li><strong>${t.s3t}</strong><br>${t.s3b}</li>
</ol>
</div>
<div class="card"><h2>${t.scanTitle}</h2>
<p>${t.scanSub}</p>
<button id="qrscan-open" type="button">${t.scanOpen}</button>
<div id="qrscan-panel" hidden>
<video id="qrscan-video" playsinline muted autoplay></video>
<canvas id="qrscan-canvas" hidden></canvas>
<p id="qrscan-err" class="err" role="alert" hidden></p>
<p id="qrscan-nonative" class="hint" hidden>${t.scanNoNative}</p>
<textarea id="qrscan-paste" rows="3" placeholder="${esc(t.scanPastePh)}"></textarea>
<div class="btnrow"><button id="qrscan-validate" type="button">${t.scanValidate}</button></div>
<div id="qrscan-result" class="resbox" hidden>
<p><strong>${t.scanResult}:</strong> <span id="qrscan-kind" class="kind"></span><span id="qrscan-expired" class="err" hidden> ${t.scanExpired}</span></p>
<code id="qrscan-text"></code>
<p id="qrscan-code" class="bigcode" hidden></p>
<p id="qrscan-hint" class="hint"></p>
<div class="btnrow"><button id="qrscan-copy" type="button">${t.scanCopy}</button><a id="qrscan-openurl" class="abtn" href="#" target="_blank" rel="noopener" hidden>${t.scanOpenUrl}</a></div>
</div>
</div>
<p class="hint">${t.scanJsqrNote}</p>
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
<script>
/* Escáner QR del lado cliente (misma estrategia que RemoteQrScan.vue de BunDeck):
   getUserMedia con facingMode environment + BarcodeDetector nativo (solo si
   declara qr_code) con loop cada 400ms sobre frames de <video> vía <canvas>,
   más pegado manual como fallback. Sin nativo (p. ej. Safari en iPad/iPhone,
   que no expone BarcodeDetector) se carga bajo demanda el detector compatible
   auto-hospedado vendor/jsqr-1.4.0.js (jsQR 1.4.0 UMD, MIT; cache immutable,
   solo se descarga si hace falta: la landing sigue siendo ligera con
   cache-control: no-store). Si la carga falla, se muestra aviso + pegado manual.
   Sin eval ni handlers inline (compatible con CSP estricta). */
(function(){
var openBtn=document.getElementById('qrscan-open'),panel=document.getElementById('qrscan-panel'),
video=document.getElementById('qrscan-video'),canvas=document.getElementById('qrscan-canvas'),
errEl=document.getElementById('qrscan-err'),nonative=document.getElementById('qrscan-nonative'),
paste=document.getElementById('qrscan-paste'),validateBtn=document.getElementById('qrscan-validate'),
result=document.getElementById('qrscan-result'),kindEl=document.getElementById('qrscan-kind'),
expiredEl=document.getElementById('qrscan-expired'),textEl=document.getElementById('qrscan-text'),
codeEl=document.getElementById('qrscan-code'),hintEl=document.getElementById('qrscan-hint'),
copyBtn=document.getElementById('qrscan-copy'),openUrl=document.getElementById('qrscan-openurl');
if(!openBtn||!panel||!video||!validateBtn||!copyBtn) return;
var L=${L};
var stream=null,timer=null,stopped=true,detector=null,jsqrFn=null,jsqrPromise=null;
function show(el,on){ if(el) el.hidden=!on; }
function setErr(m){ if(!errEl) return; if(m){ errEl.textContent=m; show(errEl,true); } else show(errEl,false); }
function trim(s){ return String(s==null?'':s).replace(/^\\s+|\\s+$/g,''); }
/* Carga bajo demanda del detector compatible (solo sin BarcodeDetector nativo).
   Relativa para funcionar tras reverse proxy; cache immutable en el servidor. */
function loadJsqr(){
  if(window.jsQR) return Promise.resolve(window.jsQR);
  if(jsqrPromise) return jsqrPromise;
  jsqrPromise=new Promise(function(res,rej){
    var s=document.createElement('script');
    s.src='vendor/jsqr-1.4.0.js'; s.async=true;
    s.addEventListener('load',function(){ if(window.jsQR) res(window.jsQR); else rej(new Error('no jsQR')); });
    s.addEventListener('error',function(){ rej(new Error('load')); });
    document.head.appendChild(s);
  });
  return jsqrPromise;
}
/* Espejo de classifyQrText (relay/src/qrscan.ts): misma clasificación sin dependencias. */
function classify(s){
  s=trim(s);
  if(!s) return {kind:'other',text:''};
  if(/^\\d{6}$/.test(s)) return {kind:'pair-code',text:s,code:s};
  if(s.charAt(0)==='{'){
    try{
      var o=JSON.parse(s);
      if(o&&typeof o==='object'&&!Array.isArray(o)){
        if(o.v===1&&/^\\d{6}$/.test(trim(o.code))&&typeof o.dev==='string'&&o.dev!==''&&typeof o.pub==='string'&&o.pub!==''){
          return {kind:'pair-qr',text:s,code:trim(o.code),relay:(typeof o.relay==='string'?o.relay:''),expired:(typeof o.exp==='number'?o.exp<=Date.now():false)};
        }
      }
    }catch(e){}
    return {kind:'other',text:s};
  }
  var u=null;
  try{ u=new URL(s); }catch(e){ u=null; }
  if(!u) return {kind:'other',text:s};
  var proto=String(u.protocol||'').toLowerCase();
  if(proto==='ws:'||proto==='wss:') return {kind:'relay-url',text:s,url:s};
  if(proto!=='http:'&&proto!=='https:') return {kind:'other',text:s};
  var parts=u.pathname.split('/').filter(function(p){return p!=='';});
  if(parts.length>=2&&parts[0]==='ui') return {kind:'ui-url',text:s,url:s,urlCode:parts[1]};
  if(parts.length>=1&&parts[0]==='t') return {kind:'tunnel-url',text:s,url:s};
  return {kind:'http-url',text:s,url:s};
}
function hintFor(c){
  if(c.kind==='pair-code') return L.hints.pairCode;
  if(c.kind==='pair-qr') return L.hints.pairQr;
  if(c.kind==='relay-url') return L.hints.relayUrl;
  if(c.kind==='ui-url') return L.hints.uiUrl;
  if(c.kind==='tunnel-url') return L.hints.tunnelUrl;
  if(c.kind==='http-url') return L.hints.httpUrl;
  return L.hints.other;
}
function render(c){
  if(kindEl) kindEl.textContent=(L.kinds[c.kind]||c.kind);
  if(textEl) textEl.textContent=c.text;
  show(expiredEl,!!c.expired);
  if(codeEl){ if(c.code){ codeEl.textContent=c.code; show(codeEl,true); } else show(codeEl,false); }
  if(hintEl) hintEl.textContent=hintFor(c);
  if(openUrl){ if(c.url&&/^https?:/i.test(c.url)){ openUrl.href=c.url; show(openUrl,true); } else show(openUrl,false); }
  copyBtn.textContent=L.copy;
  show(result,true);
}
function stopTracks(){ try{ if(stream){ stream.getTracks().forEach(function(tr){ try{ tr.stop(); }catch(e){} }); } }catch(e){} stream=null; }
function stopLoop(){ stopped=true; if(timer!==null){ clearTimeout(timer); timer=null; } }
function stopAll(){ stopLoop(); stopTracks(); detector=null; }
/* Auto-ir tras escanear: solo enlaces de acceso servidos por el propio relay
   (siempre https). El resto (pareo, códigos, texto) exige gesto explícito:
   emparejar es consentimiento y no se automatiza. */
function autoGoUrl(c){
  if(!c||c.expired||typeof c.url!=='string'||!c.url) return '';
  if(c.kind!=='ui-url'&&c.kind!=='tunnel-url'&&c.kind!=='http-url') return '';
  return /^https:\/\//i.test(c.url)?c.url:'';
}
function onDecoded(text){ stopAll(); openBtn.textContent=L.again; var c=classify(text); render(c); var go=autoGoUrl(c); if(go){ try{ location.assign(go); }catch(e){} } }
function loop(){ if(stopped) return; timer=setTimeout(function(){ tick(); },400); }
async function tick(){
  if(stopped) return;
  try{
    var w=video.videoWidth,h=video.videoHeight;
    if(w&&h&&canvas){
      // 640px basta para QR y alivia CPU en móviles (iPad).
      var MAX=640,sw=w,sh=h;
      if(w>MAX||h>MAX){ var k=Math.min(MAX/w,MAX/h); sw=Math.max(1,Math.round(w*k)); sh=Math.max(1,Math.round(h*k)); }
      if(canvas.width!==sw||canvas.height!==sh){ canvas.width=sw; canvas.height=sh; }
      var ctx=canvas.getContext('2d');
      if(ctx){
        ctx.drawImage(video,0,0,sw,sh);
        if(detector){
          var found=await detector.detect(canvas);
          var raw=found&&found[0]?found[0].rawValue:'';
          if(raw){ onDecoded(String(raw)); return; }
        } else if(jsqrFn){
          var out=null;
          try{ out=jsqrFn(ctx.getImageData(0,0,sw,sh).data,sw,sh); }catch(je){}
          if(out&&out.data){ onDecoded(String(out.data)); return; }
        }
      }
    }
  }catch(e){}
  loop();
}
async function start(){
  stopAll(); setErr(''); show(result,false); show(nonative,false);
  stopped=false; openBtn.textContent=L.close;
  var md=(typeof navigator!=='undefined'&&navigator.mediaDevices)?navigator.mediaDevices:null;
  if(!md||!md.getUserMedia){ setErr(L.noCam); stopped=true; return; }
  try{ stream=await md.getUserMedia({video:{facingMode:'environment'},audio:false}); }
  catch(e){ setErr(L.noCam); stopped=true; stream=null; return; }
  try{
    video.srcObject=stream; video.playsInline=true;
    var p=video.play(); if(p&&typeof p.catch==='function') p.catch(function(){});
  }catch(e){}
  var det=null;
  try{
    var BD=window.BarcodeDetector;
    if(typeof BD!=='undefined'){
      var ok=true;
      if(typeof BD.getSupportedFormats==='function'){
        try{ var f=await BD.getSupportedFormats(); if(Array.isArray(f)&&f.indexOf('qr_code')<0) ok=false; }catch(e2){ ok=true; }
      }
      if(ok){ try{ det=new BD({formats:['qr_code']}); }catch(e3){ det=null; } }
    }
  }catch(e4){ det=null; }
  detector=det;
  if(det){ show(nonative,false); loop(); return; }
  // Sin nativo (p. ej. Safari en iPad): detector compatible auto-hospedado bajo demanda.
  if(nonative){ nonative.textContent=L.loading; show(nonative,true); }
  try{
    var fn=await loadJsqr();
    if(stopped) return;
    jsqrFn=fn;
    show(nonative,false);
  }catch(le){
    if(stopped) return;
    if(nonative){ nonative.textContent=L.noNative; show(nonative,true); }
  }
  loop();
}
openBtn.addEventListener('click',function(){
  if(panel.hidden){ panel.hidden=false; start(); }
  else { stopAll(); panel.hidden=true; openBtn.textContent=L.open; }
});
validateBtn.addEventListener('click',function(){
  if(!paste) return;
  var v=trim(paste.value);
  if(v) onDecoded(v);
});
copyBtn.addEventListener('click',function(){
  var txt=(textEl&&textEl.textContent)||'';
  function ok(){ var o=copyBtn.textContent; copyBtn.textContent=L.copied; setTimeout(function(){ copyBtn.textContent=o; },1500); }
  if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(txt).then(ok,ok); }
  else{ var ta=document.createElement('textarea'); ta.value=txt; document.body.appendChild(ta); ta.select(); try{ document.execCommand('copy'); }catch(e){} document.body.removeChild(ta); ok(); }
});
})();
</script>
</body>
</html>`;
}
