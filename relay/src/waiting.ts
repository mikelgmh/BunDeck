/**
 * SALA DE ESPERA del navegador: `GET /ui/<urlCode>` (+ `GET /ui/<urlCode>/status`).
 *
 * Pública, sin auth. HTML inline sin dependencias. ES según Accept-Language (fallback EN).
 *
 * Contrato con el agente del túnel (sesiones del navegador):
 *   `GET /ui/<urlCode>/status` → `{ status: 'pending'|'approved'|'denied'|'expired',
 *                                   sessionToken?: string }`
 *   - `approved` incluye `sessionToken`; la página redirige a `/t/<token>/`.
 *   - Sin red de túnel / código desconocido, el status se lee como `expired`
 *     (la página muestra "enlace caducado o inválido").
 *
 * Cómo se integra (elegir UNA opción; no editar este fichero):
 *
 *   Opción A (recomendada, compone con el agente del túnel aunque también toque
 *   relay.ts): envolver la instancia del RelayServer. El wrapper delega primero a
 *   la sala de espera y, si no es una ruta `/ui/…`, llama al handler original
 *   (que puede ser a su vez el wrapper del túnel). El orden de envoltura no
 *   importa mientras cada capa devuelva `null` cuando no gestiona la petición.
 *
 *     import { registerUiRoutes } from './waiting';
 *     import { getUiStatus } from './tunnel'; // lo que exponga el agente del túnel
 *     registerUiRoutes(relay, { getUiStatus });
 *
 *   Opción B (manual, una línea en `RelayServer.handleFetch`, antes del resto):
 *
 *     import { handleUiFetch } from './waiting';
 *     const r = await handleUiFetch(req, { getUiStatus });
 *     if (r) return r;
 *
 * Delegación del status:
 *   - Si se inyecta `getUiStatus(code)`, se usa tal cual. El valor puede ser
 *     `{status, sessionToken?}` o `null/undefined` (= código desconocido → 404).
 *   - Si NO se inyecta, se intenta un import dinámico del módulo del túnel
 *     (ver TUNNEL_MODULES / TUNNEL_GETTERS abajo) dentro de try/catch. Si no
 *     existe o no expone ningún getter conocido, la ruta de status devuelve
 *     `404 { error: 'unknown-code', status: 'expired' }` y la página muestra
 *     "caducado o inválido" (no rompe: la sala sigue sirviendo HTML).
 *   - Si el agente del túnel ya registra `GET /ui/:code/status` por su cuenta
 *     con otro nombre de ruta, pasa `{ pageOnly: true }`: este módulo solo sirve
 *     la página y deja el status al otro handler. La página construye la URL de
 *     poll a partir de `location.pathname + '/status'`; si la ruta real difiere,
 *     ajusta `statusSuffix` (p. ej. `{ statusSuffix: '/state' }`) y documenta la
 *     desviación AQUÍ del contrato. Desviación actual: ninguna (se usa `/status`).
 *
 * La página tolera a propósito varias formas del endpoint de status para no
 * romper según lo implemente el túnel: `200 {status}`, `404` o `410` se leen
 * como `expired`; solo `200` con `status:'approved'` + `sessionToken` redirige.
 */

import { pickLang } from './landing';
import type { LanHints } from './tunnel';

export type { LanHints };

export type WaitingLang = 'es' | 'en';
export type UiStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface UiStatusResult {
  status: UiStatus;
  sessionToken?: string;
  /** Nuevo flujo split-token: sid público + ticket de un solo uso (canje por cookie). */
  sid?: string;
  ticket?: string;
  /** Invite LAN post-aprobación (solo en el primer poll aprobado; nunca pre-aprobación). */
  lan?: { code: string; ips: string[]; port: number; apiPort: number; fp: string };
}

/** Getter de estado que debe exponer el módulo del túnel (o inyectarse). */
export type GetUiStatus = (
  code: string,
) => UiStatusResult | null | undefined | Promise<UiStatusResult | null | undefined>;

/** Códigos cortos de URL: solo estos caracteres llegan al HTML (el resto → 404). */
export const UI_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Intervalo de poll del navegador contra el endpoint de status. */
export const UI_POLL_MS = 3000;
/** Timeout total del navegador (el relay expira a los 120s; margen de 10s). */
export const UI_TIMEOUT_MS = 130_000;
/** Sufijo de la URL de status respecto a la página (`/ui/<code>` + esto). */
export const UI_STATUS_SUFFIX = '/status';

const UI_STATUSES: readonly UiStatus[] = ['pending', 'approved', 'denied', 'expired'];

/** Módulos del túnel que se prueban con import dinámico (si `getUiStatus` no se inyecta). */
const TUNNEL_MODULES = ['./tunnel.js', './tunnel', './ui.js', './ui'];
/** Nombres de export que se aceptan como getter de estado en esos módulos. */
const TUNNEL_GETTERS = [
  'getUiStatus',
  'getBrowserUiStatus',
  'uiStatusByCode',
  'getUiSessionStatus',
  'lookupUiSession',
];

let cachedTunnelGetter: GetUiStatus | null | undefined;

function isUiStatus(s: unknown): s is UiStatus {
  return typeof s === 'string' && (UI_STATUSES as readonly string[]).includes(s);
}

function sanitizeUiResult(v: unknown): UiStatusResult | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as { status?: unknown; sessionToken?: unknown; sid?: unknown; ticket?: unknown; lan?: unknown };
  if (!isUiStatus(r.status)) return null;
  if (r.status === 'approved') {
    // Invite LAN post-aprobación (opcional): se valida duro antes de exponerlo
    // al JS de la página (que solo lo usa tras aprobar).
    let lan: UiStatusResult['lan'];
    if (r.lan && typeof r.lan === 'object') {
      const l = r.lan as Record<string, unknown>;
      if (
        typeof l.code === 'string' && l.code !== '' &&
        Array.isArray(l.ips) && l.ips.length > 0 &&
        typeof l.port === 'number'
      ) {
        const ips = (l.ips as unknown[]).filter((ip): ip is string => typeof ip === 'string').slice(0, 4);
        if (ips.length > 0) {
          lan = {
            code: l.code,
            ips,
            port: l.port,
            apiPort: typeof l.apiPort === 'number' ? l.apiPort : l.port,
            fp: typeof l.fp === 'string' ? l.fp : '',
          };
        }
      }
    }
    if (typeof r.sessionToken === 'string') return { status: r.status, sessionToken: r.sessionToken, ...(lan ? { lan } : {}) };
    if (typeof r.sid === 'string') {
      const base = typeof r.ticket === 'string'
        ? { status: r.status, sid: r.sid, ticket: r.ticket } as UiStatusResult
        : { status: r.status, sid: r.sid } as UiStatusResult;
      return lan ? { ...base, lan } : base;
    }
    // Aprobado sin token ni sid (segundo poll legacy / restore sid sin ticket):
    // sigue siendo aprobado válido; propaga lan si la trae (una sola vez la
    // genera el túnel, aquí solo se reenvía).
    if (lan) return { status: r.status, lan };
    return null;
  }
  return { status: r.status };
}

/** Intento best-effort de localizar el getter del túnel. Nunca lanza. */
async function resolveTunnelGetter(): Promise<GetUiStatus | null> {
  if (cachedTunnelGetter !== undefined) return cachedTunnelGetter;
  for (const mod of TUNNEL_MODULES) {
    try {
      const ns = (await import(mod)) as Record<string, unknown>;
      for (const name of TUNNEL_GETTERS) {
        const fn = ns[name];
        if (typeof fn === 'function') {
          cachedTunnelGetter = fn as GetUiStatus;
          return cachedTunnelGetter;
        }
      }
    } catch {
      /* módulo aún no creado por el otro agente: se ignora */
    }
  }
  cachedTunnelGetter = null;
  return null;
}

/** Solo para tests: olvida el getter cacheado del import dinámico. */
export function __resetTunnelGetterCache(): void {
  cachedTunnelGetter = undefined;
}

export function isValidUrlCode(code: string): boolean {
  return UI_CODE_RE.test(code);
}

/** Pura y testeable: ¿se agotó el timeout total de espera? */
export function waitingTimedOut(startedAtMs: number, nowMs: number, timeoutMs = UI_TIMEOUT_MS): boolean {
  return nowMs - startedAtMs >= timeoutMs;
}

export function wantsJson(req: Request): boolean {
  return (req.headers.get('accept') ?? '').includes('application/json');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface WaitingTexts {
  lang: WaitingLang;
  title: string;
  pendingTitle: string;
  pendingBody: string;
  pendingTransport: string;
  codeLabel: string;
  cancel: string;
  cancelledTitle: string;
  cancelledBody: string;
  approvedTitle: string;
  approvedBody: string;
  connectingBody: string;
  goNow: string;
  tokenWarning: string;
  deniedTitle: string;
  deniedBody: string;
  expiredTitle: string;
  expiredBody: string;
  privacy: string;
  noCredentials: string;
  lanChecking: string;
  lanDirectTitle: string;
  lanDirectOpen: string;
}

const STR: Record<WaitingLang, WaitingTexts> = {
  es: {
    lang: 'es',
    title: 'Sala de espera — BunDeck Relay',
    pendingTitle: 'Esperando aprobación en el equipo anfitrión',
    pendingBody: 'Deja esta pestaña abierta mientras el anfitrión aprueba el acceso. La solicitud caduca en 2 minutos.',
    pendingTransport: 'Al aprobar, se intentará primero una conexión directa P2P cifrada; si la red lo bloquea, se usará el relay.',
    codeLabel: 'Tu código',
    cancel: 'Cancelar',
    cancelledTitle: 'Espera cancelada',
    cancelledBody: 'Has detenido la espera. Puedes cerrar esta pestaña o pedir un código nuevo.',
    approvedTitle: 'Acceso aprobado. Redirigiendo…',
    approvedBody: 'El anfitrión ha aprobado tu acceso. Te llevamos a tu sesión.',
    connectingBody: 'Estableciendo conexión segura… probando conexión directa P2P.',
    goNow: 'Entrar ahora',
    tokenWarning:
      'Aviso: tu sesión quedará guardada en este navegador (cookie). No compartas el enlace ni el equipo.',
    deniedTitle: 'Acceso denegado',
    deniedBody: 'El anfitrión ha denegado el acceso. Pide un código nuevo e inténtalo de nuevo.',
    expiredTitle: 'Enlace caducado o inválido',
    expiredBody:
      'El enlace ya no está disponible: puede haber caducado, haberse usado o haberse revocado. Pide un QR nuevo al anfitrión.',
    privacy:
      'El equipo anfitrión debe aprobar tu acceso. Tu navegador intentará primero una conexión directa P2P (WebRTC) cifrada; si la red no lo permite usará el relay (el operador del relay puede ver el tráfico, protegido con TLS entre tu navegador y el relay).',
    noCredentials: 'Esta página nunca te pedirá usuario ni contraseña.',
    lanChecking: 'Comprobando si estás en la misma red local…',
    lanDirectTitle: 'Estás en la misma red: abre la versión directa',
    lanDirectOpen: 'Abrir versión directa',
  },
  en: {
    lang: 'en',
    title: 'Waiting room — BunDeck Relay',
    pendingTitle: 'Waiting for approval on the host machine',
    pendingBody: 'Keep this tab open while the host approves access. The request expires after 2 minutes.',
    pendingTransport: 'On approval, it will first try an encrypted direct P2P connection; if the network blocks it, it will use the relay.',
    codeLabel: 'Your code',
    cancel: 'Cancel',
    cancelledTitle: 'Wait cancelled',
    cancelledBody: 'You stopped waiting. You can close this tab or ask for a new code.',
    approvedTitle: 'Access approved. Redirecting…',
    approvedBody: 'The host approved your access. Taking you to your session.',
    connectingBody: 'Establishing secure connection… trying direct P2P connection.',
    goNow: 'Enter now',
    tokenWarning:
      'Note: your session will be stored in this browser (cookie). Do not share the link or device.',
    deniedTitle: 'Access denied',
    deniedBody: 'The host denied access. Ask for a new code and try again.',
    expiredTitle: 'Expired or invalid link',
    expiredBody: 'This link is no longer available. It may have expired, been used, or been revoked. Ask the host for a new QR code.',
    privacy:
      'The host machine must approve your access. Your browser will first try a direct encrypted P2P (WebRTC) connection; if the network does not allow it, it will use the relay (the relay operator can see the traffic, protected with TLS between your browser and the relay).',
    noCredentials: 'This page will never ask for your username or password.',
    lanChecking: 'Checking whether you are on the same local network…',
    lanDirectTitle: 'On the same network: open the direct version',
    lanDirectOpen: 'Open direct version',
  },
};

export function waitingLang(req: Request): WaitingLang {
  return pickLang(req) === 'en' ? 'en' : 'es';
}

/**
 * Renderiza la sala de espera. `urlCode` debe venir ya validado con
 * `isValidUrlCode` (aun así se escapa). La página inicial NUNCA incluye el
 * `sessionToken` ni el invite LAN: solo llegan por `GET …/status` tras aprobar.
 *
 * `lan` (opcional, del daemon vía `ui-publish`): hints de ALCANZABILIDAD sin
 * código `{ips, port, apiPort, fp}`. Se inyectan como JSON escapado (`</` →
 * `<\/`) en un `<script type="application/json">` + un bloque JS best-effort
 * que corre en paralelo al poll: muestra `wait-lan-check` mientras prueba
 * `GET http://<ip>:<apiPort>/config` (público, PNA-friendly, timeout
 * 1500 ms) y guarda el resultado en `sessionStorage['libredeck:lanProbe']`
 * (`{urlCode,tried,ips,ok,ip?,ms,ts}`) para el frontend. NUNCA redirige ni
 * usa invites pre-aprobación (no hay `code` en el HTML inicial).
 * Tras aprobar, el poll de `status` puede traer `data.lan:{code,…}` UNA vez:
 * si el probe guardado dice `ok:true` para ESTE urlCode (fresco <10 min) se
 * redirige a la URL directa LAN; si no, se muestra el bloque manual
 * post-aprobación (`wait-lan-direct`) junto al "Entrar ahora" existente.
 * Cualquier fallo se silencia: sigue el poll relay.
 */
export function renderWaitingPage(urlCode: string, lang: WaitingLang, lan?: LanHints | null): string {
  const t = STR[lang];
  const code = esc(urlCode);
  const lanOk =
    !!lan &&
    typeof lan === 'object' &&
    Array.isArray((lan as LanHints).ips) &&
    (lan as LanHints).ips.length > 0 &&
    typeof (lan as LanHints).port === 'number';
  // SIN `code`: el HTML inicial nunca contiene un invite utilizable. Solo
  // alcanzabilidad (ips/port/apiPort/fp) para el probe pre-aprobación.
  const lanJson = lanOk
    ? JSON.stringify({
        ips: (lan as LanHints).ips,
        port: (lan as LanHints).port,
        apiPort: (lan as LanHints).apiPort,
        fp: (lan as LanHints).fp,
      }).replace(/<\//g, '<\\/')
    : '';
  const lanHintHtml = lanOk
    ? `<p class="hint" id="wait-lan-check">${esc(t.lanChecking)}</p>`
    : '';
  // Probe SOLO de alcanzabilidad pre-aprobación: verifica `/config` y guarda
  // `libredeck:lanProbe`, sin redirect ni invite (no hay `code` aquí). La
  // redirección a la LAN ocurre SOLO post-aprobación en el poll de `status`
  // (cuando `data.lan.code` ya existe y el Denegar sigue intacto).
  const lanScript = lanOk
    ? `<script id="lan-hints" type="application/json">${lanJson}</script>
<script>
(function(){
try{
var el=document.getElementById('lan-hints');
if(!el)return;
var lan=null;
try{lan=JSON.parse(el.textContent||'null');}catch(e){return;}
if(!lan||!lan.ips||!lan.ips.length||!lan.port)return;
var segs=location.pathname.split('/').filter(function(p){return !!p;});
var urlCode=segs.length?segs[segs.length-1]:'';
if(!urlCode)return;
var PROBE_KEY='libredeck:lanProbe';
var startMs=Date.now();
var validIps=[];
for(var v=0;v<lan.ips.length;v++){var cip=lan.ips[v];if(typeof cip==='string'&&/^[0-9.]+$/.test(cip))validIps.push(cip);}
var portNum=(typeof lan.port==='number'&&lan.port>=1&&lan.port<=65535)?lan.port:0;
var verifyPort=(typeof lan.apiPort==='number'&&lan.apiPort>=1&&lan.apiPort<=65535)?lan.apiPort:portNum;
function storeProbe(ok,ip){
try{
var payload={urlCode:urlCode,tried:true,ips:lan.ips.slice(),ok:!!ok,ms:(Date.now()-startMs),ts:Date.now()};
if(ip)payload.ip=ip;
sessionStorage.setItem(PROBE_KEY,JSON.stringify(payload));
}catch(e){}
}
function hideCheck(){var c=document.getElementById('wait-lan-check');if(c)c.hidden=true;}
function finishFail(){hideCheck();storeProbe(false,null);}
if(!portNum||!validIps.length){finishFail();return;}
var remaining=validIps.length;
var doneOk=false;
function markOk(ip){if(doneOk)return;doneOk=true;hideCheck();storeProbe(true,ip);}
function oneDone(){remaining--;if(remaining<=0&&!doneOk){finishFail();}}
function checkLan(ip,single){
var done=false;
function fin(){if(done)return;done=true;oneDone();}
var ctl=null;
try{ctl=new AbortController();}catch(e){ctl=null;}
var to=setTimeout(function(){try{if(ctl)ctl.abort();}catch(e){}},1500);
var opt={cache:'no-store',mode:'cors'};
if(ctl)opt.signal=ctl.signal;
fetch('http://'+ip+':'+verifyPort+'/config',opt).then(function(res){
clearTimeout(to);
if(doneOk){fin();return;}
if(!res||!res.ok){fin();return;}
return res.json().then(function(data){
if(doneOk){fin();return;}
if(!data||typeof data!=='object'){fin();return;}
var fp=(typeof data.fp==='string'&&data.fp)?data.fp:null;
if(fp){if(lan.fp&&fp===lan.fp){markOk(ip);fin();return;}fin();return;}
if(single&&(data.frontendPort||data.apiPort||data.wsPort)){markOk(ip);fin();return;}
fin();
}).catch(function(){fin();});
}).catch(function(){clearTimeout(to);fin();});
}
var singleLan=lan.ips.length===1;
for(var i=0;i<validIps.length;i++){
checkLan(validIps[i],portNum,singleLan);
}
}catch(e){}
})();
</script>`
    : '';
  return `<!doctype html>
<html lang="${t.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(t.title)}</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;line-height:1.55;background:#0f172a;color:#e2e8f0}
@media(prefers-color-scheme:light){body{background:#f1f5f9;color:#0f172a}}
.wrap{max-width:560px;margin:0 auto;padding:48px 20px 64px;text-align:center}
.card{background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.25);border-radius:14px;padding:28px 24px;margin:20px 0}
.spinner{width:44px;height:44px;margin:6px auto 16px;border-radius:50%;border:4px solid rgba(148,163,184,.3);border-top-color:#22c55e;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:22px;margin:8px 0}
p{margin:8px 0}
.code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:26px;letter-spacing:2px;background:rgba(148,163,184,.18);border-radius:10px;padding:10px 18px;display:inline-block;margin:12px 0;word-break:break-all}
button{cursor:pointer;border:0;border-radius:10px;padding:10px 22px;font-weight:700;background:#334155;color:#e2e8f0;margin-top:10px}
button:active{transform:scale(.97)}
a.abtn{display:inline-block;text-decoration:none;border:0;border-radius:10px;padding:10px 22px;font-weight:700;background:#334155;color:#e2e8f0;margin-top:10px}
a.abtn:active{transform:scale(.97)}
.btnrow{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.warn{font-size:13px;color:#fbbf24}
.privacy{font-size:12.5px;opacity:.7;margin-top:20px}
[hidden]{display:none!important}
</style>
</head>
<body data-state="pending">
<div class="wrap">
<div class="card" id="st-pending">
<div class="spinner" role="status" aria-label="loading"></div>
<h1>${esc(t.pendingTitle)}</h1>
<p>${esc(t.pendingBody)}</p>
<p class="hint">${esc(t.pendingTransport)}</p>
${lanHintHtml}<div><span class="code" id="wait-code">${code}</span></div>
<div><button id="wait-cancel" type="button">${esc(t.cancel)}</button></div>
</div>
<div class="card" id="st-approved" hidden>
<div class="spinner" role="status" aria-label="loading"></div>
<h1>${esc(t.approvedTitle)}</h1>
<p>${esc(t.approvedBody)}</p>
<p class="hint" id="wait-connecting">${esc(t.connectingBody)}</p>
<div><button id="wait-go" type="button">${esc(t.goNow)}</button></div>
<p class="hint" id="wait-lan-direct" hidden><span>${esc(t.lanDirectTitle)}</span><br><a class="abtn" id="wait-lan-direct-link" href="#">${esc(t.lanDirectOpen)}</a></p>
<p class="warn">${esc(t.tokenWarning)}</p>
</div>
<div class="card" id="st-denied" hidden>
<h1>${esc(t.deniedTitle)}</h1>
<p>${esc(t.deniedBody)}</p>
</div>
<div class="card" id="st-expired" hidden>
<h1>${esc(t.expiredTitle)}</h1>
<p>${esc(t.expiredBody)}</p>
</div>
<div class="card" id="st-cancelled" hidden>
<h1>${esc(t.cancelledTitle)}</h1>
<p>${esc(t.cancelledBody)}</p>
</div>
<p class="privacy">${esc(t.privacy)}<br>${esc(t.noCredentials)}</p>
</div>
<script>
(function(){
var POLL_MS=${UI_POLL_MS},TIMEOUT_MS=${UI_TIMEOUT_MS};
var STATUS_URL=location.pathname.replace(/\\/+$/,'')+'${UI_STATUS_SUFFIX}';
var body=document.body,timer=null,deadline=null,done=false,goTimer=null,goUrl='';
function show(s){body.setAttribute('data-state',s);['pending','approved','denied','expired','cancelled'].forEach(function(k){var el=document.getElementById('st-'+k);if(el)el.hidden=(k!==s);});}
function go(){ if(!goUrl) return; var u=goUrl; goUrl=''; try{ location.replace(u); }catch(e){} }
function cleanup(){done=true;if(timer){clearInterval(timer);timer=null;}if(deadline){clearTimeout(deadline);deadline=null;}if(goTimer){clearTimeout(goTimer);goTimer=null;}}
function expired(){if(done)return;cleanup();show('expired');}
function poll(){
if(done)return;
fetch(STATUS_URL,{headers:{'Accept':'application/json'},credentials:'same-origin'}).then(function(res){
if(done)return;
if(res.status===404||res.status===410){expired();return;}
if(!res.ok){return;}
return res.json().then(function(data){
if(done||!data)return;
if(data.status==='approved'&&(typeof data.sessionToken==='string'&&data.sessionToken||typeof data.sid==='string'&&data.sid&&typeof data.ticket==='string'&&data.ticket)){
cleanup();show('approved');
var kq='';
try{
var sp=new URLSearchParams(location.search||'');
var keep=new URLSearchParams();
['kiosk','mode'].forEach(function(k){var v=sp.get(k);if(v!==null&&v!=='')keep.set(k,v);});
var qs=keep.toString();
kq=(qs?'?'+qs:'')+(location.hash||'');
}catch(e){kq=(location.search||'')+(location.hash||'');}
if(typeof data.sid==='string'&&data.sid&&typeof data.ticket==='string'&&data.ticket){
var sep=kq.indexOf('#');var hash='';var q=kq;if(sep>=0){hash=kq.slice(sep);q=kq.slice(0,sep);}
var join=q?(q.indexOf('?')>=0?'&':'?'):'';var tq='ticket='+encodeURIComponent(data.ticket);
goUrl='/s/'+encodeURIComponent(data.sid)+'/claim'+(q?q+join+tq:'?'+tq)+hash;
}else{
goUrl='/t/'+encodeURIComponent(data.sessionToken)+'/'+kq;
}
try{
var lan=data.lan;
if(lan&&typeof lan.code==='string'&&lan.code&&Array.isArray(lan.ips)&&lan.ips.length&&typeof lan.port==='number'){
var segs2=location.pathname.split('/').filter(function(p){return !!p;});
var code2=segs2.length?segs2[segs2.length-1]:'';
var probeRaw=null;
try{probeRaw=sessionStorage.getItem('libredeck:lanProbe');}catch(e){}
var probe=null;
try{probe=probeRaw?JSON.parse(probeRaw):null;}catch(e){probe=null;}
var fresh=probe&&probe.ok===true&&probe.urlCode===code2&&typeof probe.ts==='number'&&(Date.now()-probe.ts)<10*60*1000;
var lanIp=null;
if(fresh&&typeof probe.ip==='string'&&lan.ips.indexOf(probe.ip)>=0){lanIp=probe.ip;}
else if(fresh&&typeof probe.ip==='string'&&/^[0-9.]+$/.test(probe.ip)){lanIp=probe.ip;}
if(!lanIp){
for(var li=0;li<lan.ips.length;li++){var cip2=lan.ips[li];if(typeof cip2==='string'&&/^[0-9.]+$/.test(cip2)){lanIp=cip2;break;}
}
}
if(lanIp){
var lanUrl='http://'+lanIp+':'+lan.port+'/?invite='+encodeURIComponent(lan.code)+'&kiosk=1&relayFallback='+encodeURIComponent(code2);
var link=document.getElementById('wait-lan-direct-link');
if(link){try{link.setAttribute('href',lanUrl);}catch(e){}}
var box=document.getElementById('wait-lan-direct');
if(box){box.hidden=false;}
if(fresh){goUrl=lanUrl;}
}
}
}catch(e){}
goTimer=setTimeout(go,2000);
}else if(data.status==='denied'){cleanup();show('denied');}
else if(data.status==='expired'){expired();}
}).catch(function(){});
}).catch(function(){});
}
var cancel=document.getElementById('wait-cancel');
if(cancel)cancel.addEventListener('click',function(){cleanup();show('cancelled');});
var goBtn=document.getElementById('wait-go');
if(goBtn)goBtn.addEventListener('click',function(){if(goTimer){clearTimeout(goTimer);goTimer=null;}go();});
window.addEventListener('pagehide',cleanup);
window.addEventListener('beforeunload',cleanup);
deadline=setTimeout(expired,TIMEOUT_MS);
poll();
timer=setInterval(poll,POLL_MS);
})();
</script>
${lanScript}</body>
</html>`;
}

/** Variante estática (sin poll) para códigos inválidos/desconocidos: no hace eco del código. */
export function renderGonePage(lang: WaitingLang): string {
  const t = STR[lang];
  return `<!doctype html>
<html lang="${t.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(t.title)}</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}.wrap{max-width:560px;margin:0 auto;padding:48px 20px;text-align:center}h1{font-size:22px}</style>
</head>
<body data-state="expired">
<div class="wrap"><h1>${esc(t.expiredTitle)}</h1><p>${esc(t.expiredBody)}</p></div>
</body>
</html>`;
}

/** Alias público de la página de enlace caducado/inválido (la usa relay.ts). */
export const renderUiGonePage = renderGonePage;

/** Motivos por los que un `/t/<token>/` no se puede servir. */
export type TunnelGoneReason = 'invalid-token' | 'expired' | 'daemon-offline';

/** ¿Es una navegación de página (mostrar HTML) en vez de API/XHR/WS? */
export function wantsHtmlPage(req: Request): boolean {
  const accept = req.headers.get('accept') ?? '';
  if (!accept.includes('text/html')) return false;
  // XHR/fetch que acepta html explícitamente sigue recibiendo JSON.
  if ((req.headers.get('sec-fetch-mode') ?? '') === 'cors') return false;
  if ((req.headers.get('x-requested-with') ?? '').toLowerCase() === 'xmlhttprequest') return false;
  return true;
}

const TUNNEL_GONE: Record<TunnelGoneReason, Record<WaitingLang, { title: string; body: string; scanAgain: string }>> = {
  'invalid-token': {
    es: {
      title: 'Sesión no válida',
      body: 'Esta sesión ya no existe en el relay: probablemente el equipo anfitrión se reinició o el relay se redesplegó antes de que el equipo re-anunciara sus sesiones. Recarga en unos segundos y, si persiste, pide un QR nuevo al anfitrión.',
      scanAgain: 'Escanear un QR nuevo',
    },
    en: {
      title: 'Invalid session',
      body: 'This session no longer exists on the relay: the host machine probably restarted, or the relay was redeployed before the host re-announced its sessions. Reload in a few seconds and, if it persists, ask the host for a new QR code.',
      scanAgain: 'Scan a new QR',
    },
  },
  expired: {
    es: {
      title: 'Sesión caducada',
      body: 'Esta sesión expiró (duración máxima 24 h). Pide un QR nuevo al anfitrión para volver a entrar.',
      scanAgain: 'Escanear un QR nuevo',
    },
    en: {
      title: 'Session expired',
      body: 'This session has expired (max lifetime 24 h). Ask the host for a new QR code to get back in.',
      scanAgain: 'Scan a new QR',
    },
  },
  'daemon-offline': {
    es: {
      title: 'Equipo sin conexión',
      body: 'El equipo anfitrión está sin conexión o reiniciándose. Espera unos segundos y recarga: la sesión se restaura sola al reconectar. Si persiste, pide un QR nuevo al anfitrión.',
      scanAgain: 'Escanear un QR nuevo',
    },
    en: {
      title: 'Host offline',
      body: 'The host machine is offline or restarting. Wait a few seconds and reload: the session restores itself on reconnect. If it persists, ask the host for a new QR code.',
      scanAgain: 'Scan a new QR',
    },
  },
};

/**
 * Página estática para `/t/<token>/` con sesión muerta o daemon caído.
 * Sustituye al JSON crudo (`{"error":"invalid-token"}`) cuando un navegador
 * recarga la página: explica qué pasó y qué hacer. Nunca incluye secretos.
 */
export function renderTunnelGonePage(reason: TunnelGoneReason, lang: WaitingLang): string {
  const t = TUNNEL_GONE[reason] ?? TUNNEL_GONE['invalid-token'];
  const s = t[lang] ?? t.es;
  // Auto-reintento solo para daemon-offline (sesión conocida pero daemon
  // reconectando, o token desconocido en ventana de gracia): poll con
  // backoff al mismo path (JSON) y recarga sola al volver 200. Un 401
  // expired/invalid-token detiene el poll (pedir QR nuevo). Con
  // invalid-token/expired no hay poll: la sesión no va a resucitar.
  const retryScript =
    reason === 'daemon-offline'
      ? `<script>
(function(){
try{
var attempts=0;
var maxAttempts=20;
var stopped=false;
var note=document.getElementById('tunnel-retry-note');
function waitMs(n){var arr=[2000,3000,5000,8000,13000,20000];return arr[Math.min(n,arr.length-1)];}
function tick(){
if(stopped)return;
attempts++;
fetch(location.pathname+location.search,{headers:{'Accept':'application/json'},credentials:'same-origin',cache:'no-store'}).then(function(res){
if(res.status===200){location.reload();return;}
return res.json().catch(function(){return {};}).then(function(body){
var err=body&&typeof body.error==='string'?body.error:'';
if(res.status===401&&(err==='expired'||err==='invalid-token')){stopped=true;if(note)note.hidden=true;return;}
if(attempts>=maxAttempts){stopped=true;if(note)note.hidden=true;return;}
setTimeout(tick,waitMs(attempts));
});
}).catch(function(){
if(attempts>=maxAttempts){stopped=true;if(note)note.hidden=true;return;}
setTimeout(tick,waitMs(attempts));
});
}
setTimeout(tick,2000);
window.addEventListener('pagehide',function(){stopped=true;});
}catch(e){}
})();
</script>`
      : '';
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(s.title)} — BunDeck Relay</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;line-height:1.55;background:#0f172a;color:#e2e8f0}
@media(prefers-color-scheme:light){body{background:#f1f5f9;color:#0f172a}}
.wrap{max-width:560px;margin:0 auto;padding:48px 20px 64px;text-align:center}
.card{background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.25);border-radius:14px;padding:28px 24px;margin:20px 0}
h1{font-size:22px;margin:8px 0}
p{margin:8px 0}
button{cursor:pointer;border:0;border-radius:10px;padding:10px 22px;font-weight:700;background:#334155;color:#e2e8f0;margin-top:10px}
a.btn{display:inline-block;text-decoration:none;cursor:pointer;border:0;border-radius:10px;padding:10px 22px;font-weight:700;background:#334155;color:#e2e8f0;margin-top:10px}
.retry{font-size:13px;opacity:.8}
</style>
</head>
<body data-tunnel-gone="${esc(reason)}">
<div class="wrap"><div class="card">
<h1>${esc(reason === 'daemon-offline' ? '📡' : '🔒')} ${esc(s.title)}</h1>
<p>${esc(s.body)}</p>
${reason === 'daemon-offline' ? `<p class="retry" id="tunnel-retry-note" data-cy="tunnel-retrying">${esc(lang === 'en' ? 'Retrying automatically… the page reloads when the host is back.' : 'Reintentando automáticamente… la página se recarga cuando vuelva el equipo.')}</p>` : ''}
<div><a class="btn" href="/#escanear-qr">${esc(s.scanAgain)}</a></div>
</div></div>
${retryScript}
</body>
</html>`;
}

export interface UiRouteOptions {
  /** Fuente de verdad del estado (el módulo del túnel). Si se omite, import dinámico. */
  getUiStatus?: GetUiStatus;
  /** Hints LAN del fast-path (si el servidor es el RelayServer real, el
   *  `setUiPageHandler` de index.ts los resuelve vía `tunnel.getLanHints`;
   *  este accesorio cubre el `handleUiFetch` standalone). Best-effort. */
  getLanHints?: (code: string) => LanHints | null | undefined;
  /** Solo sirve la página; deja `…/status` al handler del túnel. */
  pageOnly?: boolean;
  /** Permite adaptar el poll si el túnel usa otra ruta (desviación documentada: ninguna). */
  statusSuffix?: string;
}

function noStore(headers: Record<string, string> = {}): Record<string, string> {
  return { 'cache-control': 'no-store', ...headers };
}

/**
 * Gestiona `GET /ui/<code>` y `GET /ui/<code>/status`.
 * Devuelve `Response` si la petición es una ruta UI, `null` si no lo es
 * (para componer wrappers sin romper al otro agente).
 */
export async function handleUiFetch(req: Request, opts: UiRouteOptions = {}): Promise<Response | null> {
  let path: string;
  try {
    path = new URL(req.url).pathname;
  } catch {
    return null;
  }
  if (!path.startsWith('/ui/')) return null;

  const suffix = opts.statusSuffix ?? UI_STATUS_SUFFIX;
  const wantsStatus = path.length > 4 && path.endsWith(suffix) && path !== `/ui${suffix}`;
  let raw = wantsStatus ? path.slice(4, -suffix.length) : path.slice(4);
  raw = raw.replace(/^\/+|\/+$/g, '');
  // Solo un segmento: `/ui/a/b` no es una ruta UI válida → 404, no delegar.
  if (raw === '' || raw.includes('/')) {
    if (wantsJson(req)) {
      return Response.json({ error: 'not-found' }, { status: 404, headers: noStore() });
    }
    return new Response(renderGonePage(waitingLang(req)), {
      status: 404,
      headers: noStore({ 'content-type': 'text/html; charset=utf-8' }),
    });
  }

  let code: string;
  try {
    code = decodeURIComponent(raw);
  } catch {
    code = '';
  }
  if (!isValidUrlCode(code)) {
    if (wantsStatus) {
      return Response.json({ error: 'invalid-code' }, { status: 400, headers: noStore() });
    }
    if (wantsJson(req)) {
      return Response.json({ error: 'invalid-code' }, { status: 404, headers: noStore() });
    }
    return new Response(renderGonePage(waitingLang(req)), {
      status: 404,
      headers: noStore({ 'content-type': 'text/html; charset=utf-8' }),
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: noStore() });
  }

  if (!wantsStatus) {
    if (wantsJson(req)) {
      return Response.json({ page: 'ui-waiting', urlCode: code }, { headers: noStore() });
    }
    let lan: LanHints | undefined;
    try {
      const h = opts.getLanHints?.(code);
      if (h && typeof h === 'object') lan = h;
    } catch {
      lan = undefined;
    }
    const html = renderWaitingPage(code, waitingLang(req), lan);
    if (req.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: noStore({ 'content-type': 'text/html; charset=utf-8' }),
      });
    }
    return new Response(html, {
      status: 200,
      headers: noStore({ 'content-type': 'text/html; charset=utf-8' }),
    });
  }

  // Ruta de status: si no tenemos fuente, ceder al handler del túnel (si existe).
  if (opts.pageOnly) return null;
  let getter: GetUiStatus | null | undefined = opts.getUiStatus;
  if (!getter) getter = await resolveTunnelGetter();
  if (!getter) {
    return Response.json({ error: 'unknown-code', status: 'expired' }, { status: 404, headers: noStore() });
  }
  let result: UiStatusResult | null | undefined;
  try {
    result = sanitizeUiResult(await getter(code));
  } catch {
    return Response.json({ error: 'status-error', status: 'expired' }, { status: 502, headers: noStore() });
  }
  if (!result) {
    return Response.json({ error: 'unknown-code', status: 'expired' }, { status: 404, headers: noStore() });
  }
  return Response.json(result, { headers: noStore() });
}

export type RegisterUiResult =
  | { mode: 'wrapped'; handleUiFetch: typeof handleUiFetch }
  | { mode: 'routes'; handleUiFetch: typeof handleUiFetch }
  | { mode: 'manual'; handleUiFetch: typeof handleUiFetch };

const WRAPPED = Symbol.for('libredeck.relay.uiRoutesWrapped');

/**
 * Monta `GET /ui/:code` (+ status) sobre `target` sin romper al agente del túnel:
 * - Instancia de RelayServer (duck-type: `handleFetch` propio o en prototipo):
 *   envuelve `handleFetch` para probar primero `handleUiFetch` y delegar al
 *   original cuando devuelve `null`. Idempotente y componible en cualquier orden
 *   con el wrapper del túnel. Devuelve `{ mode: 'wrapped' }`.
 * - Router estilo Express/Hono (duck-type: método `.get(path, handler)`):
 *   registra `/ui/:code` y `/ui/:code/status`. Devuelve `{ mode: 'routes' }`.
 * - Cualquier otra cosa: devuelve `{ mode: 'manual', handleUiFetch }` para que el
 *   integrador llame a `handleUiFetch(req, opts)` desde `relay.ts`.
 */
export function registerUiRoutes(target: unknown, opts: UiRouteOptions = {}): RegisterUiResult {
  const t = target as Record<string | symbol, unknown> | null | undefined;
  if (t && (t as { [WRAPPED]?: boolean })[WRAPPED]) {
    return { mode: 'wrapped', handleUiFetch };
  }

  const proto = t ? (Object.getPrototypeOf(t) as Record<string, unknown> | null) : null;
  const hasHandleFetch =
    !!t &&
    (typeof (t as { handleFetch?: unknown }).handleFetch === 'function' ||
      (!!proto && typeof (proto as { handleFetch?: unknown }).handleFetch === 'function'));

  if (t && hasHandleFetch) {
    // RelayServer: handleFetch es privado en TS pero existe en runtime.
    const anyT = t as unknown as {
      handleFetch: (req: Request, server: unknown) => Response | undefined | Promise<Response | undefined | null> | null;
    };
    const orig = anyT.handleFetch.bind(t);
    const wrapped = async function (
      this: unknown,
      req: Request,
      server: unknown,
    ): Promise<Response | undefined> {
      const ui = await handleUiFetch(req, opts);
      if (ui) return ui;
      return (await orig(req, server)) ?? undefined;
    };
    (t as Record<string | symbol, unknown>).handleFetch = wrapped;
    Object.defineProperty(t, WRAPPED, { value: true, enumerable: false, configurable: true });
    void proto;
    return { mode: 'wrapped', handleUiFetch };
  }

  const get = (t as { get?: unknown } | null | undefined)?.get;
  if (t && typeof get === 'function') {
    const router = t as {
      get: (path: string, handler: (req: Request) => Promise<Response | null>) => void;
    };
    const adapt = (extractCode: (req: Request) => string | null) => {
      return async (req: Request): Promise<Response | null> => {
        const forced = extractCode(req);
        if (forced === null) return handleUiFetch(req, opts);
        const url = new URL(req.url);
        const isStatus = url.pathname.endsWith(opts.statusSuffix ?? UI_STATUS_SUFFIX);
        const rebuilt = new URL(req.url);
        rebuilt.pathname = isStatus ? `/ui/${forced}${opts.statusSuffix ?? UI_STATUS_SUFFIX}` : `/ui/${forced}`;
        return handleUiFetch(new Request(rebuilt.toString(), req), opts);
      };
    };
    const fromParams = (req: Request): string | null => {
      const params = (req as unknown as { params?: { code?: unknown } }).params;
      return typeof params?.code === 'string' ? params.code : null;
    };
    router.get('/ui/:code', adapt(fromParams));
    router.get('/ui/:code/status', adapt(fromParams));
    return { mode: 'routes', handleUiFetch };
  }

  return { mode: 'manual', handleUiFetch };
}
