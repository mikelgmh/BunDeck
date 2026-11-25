/**
 * Discord OAuth vía relay: callback https + proxy code→token.
 *
 * Discord NO acepta esquemas personalizados (bundeck://…) en la lista de
 * redirects del portal: solo http/https. El patrón válido es el
 * "intermediary server redirect":
 *
 * 1. En el portal de Discord se registra la https de este relay
 *    (`GET /api/discord/callback`) como redirect de la app.
 * 2. Tras el "Authorize", Discord redirige al navegador a esa https con
 *    `?code=…&state=…`.
 * 3. Esta página intenta `POST http://127.0.0.1:<apiPort>/api/v1/plugins/discord/token-capture`
 *    con `{ code }` (el navegador SÍ alcanza loopback aunque la página venga
 *    de https). El daemon canjea el code vía este mismo relay
 *    (`POST /api/discord/rpc-token`), que custodia el client_secret en env.
 * 4. Si el POST al daemon falla (daemon cerrado, puerto distinto…), la
 *    página muestra el code grande con botón de copiar para pegado manual
 *    (token-capture también acepta `{code}`).
 *
 * El callback NO necesita secreto: solo reenvía el code al daemon local.
 * El canje real (con secret) ocurre únicamente en `POST /api/discord/rpc-token`,
 * que lee `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` del env del relay y
 * JAMÁS los expone al cliente.
 */

export const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
export const DISCORD_CALLBACK_PATH = '/api/discord/callback';
export const DISCORD_RPC_TOKEN_PATH = '/api/discord/rpc-token';

/** URL https del callback para registrar en el portal: dominio público o Host del request. */
export function relayCallbackUrl(req: Request, publicHost = ''): string {
  const d = publicHost.trim().replace(/\/+$/, '');
  const host = d
    ? d.replace(/^wss?:\/\//, '').split('/')[0]
    : (req.headers.get('x-forwarded-host') ?? '').split(',')[0].trim().split('/')[0] ||
      (() => {
        try {
          return new URL(req.url).host;
        } catch {
          return 'localhost';
        }
      })();
  return `https://${host}${DISCORD_CALLBACK_PATH}`;
}

export type DiscordCallbackLang = 'es' | 'en';

const CB_STR = {
  es: {
    title: 'Conectando Discord con LibreDeck',
    working: 'Enviando el código a tu LibreDeck local…',
    ok: '¡Listo! Discord quedó conectado en tu LibreDeck. Ya puedes cerrar esta pestaña.',
    failTitle: 'No se pudo entregar el código automáticamente',
    failBody:
      'Tu LibreDeck local no respondió (¿está abierto? ¿el puerto API es otro?). Copia el código y pégalo con la acción discord.connect o en token-capture:',
    copy: 'Copiar código',
    copied: '¡Copiado!',
    manualHint: 'En LibreDeck: acción discord.connect con { "code": "<pega-aquí>" }.',
    daemonLabel: 'Puerto API del daemon (api_port)',
    retry: 'Reintentar',
    noCodeTitle: 'Sin código de autorización',
    noCodeBody:
      'Esta página recibe el ?code=… que envía Discord tras autorizar. Si llegaste a mano, repite el flujo: Autorizar con Discord en tu LibreDeck.',
  },
  en: {
    title: 'Connecting Discord to LibreDeck',
    working: 'Sending the code to your local LibreDeck…',
    ok: 'Done! Discord is now connected in your LibreDeck. You can close this tab.',
    failTitle: 'Could not deliver the code automatically',
    failBody:
      'Your local LibreDeck did not answer (is it running? is the API port different?). Copy the code and paste it with the discord.connect action or into token-capture:',
    copy: 'Copy code',
    copied: 'Copied!',
    manualHint: 'In LibreDeck: discord.connect action with { "code": "<paste-here>" }.',
    daemonLabel: 'Daemon API port (api_port)',
    retry: 'Retry',
    noCodeTitle: 'No authorization code',
    noCodeBody:
      'This page receives the ?code=… sent by Discord after authorizing. If you got here manually, repeat the flow: Authorize with Discord in your LibreDeck.',
  },
} as const;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Página mínima del callback. `defaultApiPort` se inyecta desde el servidor
 * (puerto API del daemon, 3001); el query `?api_port=` lo overridea.
 */
export function renderDiscordCallbackPage(opts: { lang?: DiscordCallbackLang; defaultApiPort?: number } = {}): string {
  const lang = opts.lang === 'en' ? 'en' : 'es';
  const t = CB_STR[lang];
  const port = Number.isInteger(opts.defaultApiPort) && (opts.defaultApiPort as number) > 0 ? opts.defaultApiPort : 3001;
  const L = JSON.stringify(t).replace(/<\//g, '<\\/');
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.title)}</title>
<style>
body{margin:0;background:#eeeeec;color:#202020;font-family:Arial,Helvetica,sans-serif;line-height:1.55}
.wrap{width:min(640px,calc(100% - 40px));margin:0 auto;padding:48px 0}
.card{background:#e5e5e3;border-radius:14px;padding:28px}
h1{margin:0 0 12px;font-size:28px;letter-spacing:-1px}
p{margin:0 0 12px;font-size:14px;color:#4a4a48}
#status{font-size:15px}
.bigcode{font-size:26px;letter-spacing:4px;font-weight:800;background:#fff;border:1px solid #d6d6d3;border-radius:8px;padding:14px;word-break:break-all}
.row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center}
button{cursor:pointer;border:1px solid #3b3b3a;border-radius:7px;padding:10px 16px;font-weight:700;font-size:13px;background:#3b3b3a;color:#fff}
input{border:1px solid #d6d6d3;border-radius:7px;padding:10px 12px;font:inherit;font-size:13px;width:110px;background:#fff;color:#202020}
.ok{color:#2f7a3d;font-weight:700}
.err{color:#b3261e;font-weight:700}
.hint{font-size:12px;color:#626262}
[hidden]{display:none!important}
</style>
</head>
<body>
<div class="wrap"><div class="card">
<h1>${esc(t.title)}</h1>
<p id="status" role="status">${esc(t.working)}</p>
<div id="manual" hidden>
<p><strong>${esc(t.failTitle)}</strong></p>
<p>${esc(t.failBody)}</p>
<code class="bigcode" id="code"></code>
<div class="row"><button id="copy" type="button">${esc(t.copy)}</button></div>
<p class="hint">${esc(t.manualHint)}</p>
</div>
<div class="row"><label for="apiport">${esc(t.daemonLabel)}</label><input id="apiport" inputmode="numeric" value="${port}"><button id="retry" type="button" hidden>${esc(t.retry)}</button></div>
</div></div>
<script>
(function(){
var L=${L};
var q=new URLSearchParams(location.search);
var code=q.get('code')||'';
var err=q.get('error')||'';
var status=document.getElementById('status'),manual=document.getElementById('manual'),
codeEl=document.getElementById('code'),copy=document.getElementById('copy'),
apiport=document.getElementById('apiport'),retry=document.getElementById('retry');
var qp=q.get('api_port'); if(qp&&/^\\d+$/.test(qp)) apiport.value=qp;
function showManual(msg){
  status.innerHTML=''; status.className='err'; status.textContent=msg||L.failTitle;
  if(code){ codeEl.textContent=code; manual.hidden=false; }
  retry.hidden=false;
}
function ok(){
  status.className='ok'; status.textContent=L.ok;
  manual.hidden=true; retry.hidden=true;
}
async function deliver(){
  manual.hidden=true; retry.hidden=true;
  status.className=''; status.textContent=L.working;
  var port=/^\\d+$/.test(apiport.value||'')?apiport.value.trim():'3001';
  var paths=['/api/v1/plugins/discord/token-capture','/api/plugins/discord/token-capture'];
  var lastErr='';
  for(var i=0;i<paths.length;i++){
    try{
      var r=await fetch('http://127.0.0.1:'+port+paths[i],{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({code:code})
      });
      if(r.ok){ ok(); return; }
      lastErr='HTTP '+r.status+' en '+paths[i];
    }catch(e){ lastErr=String((e&&e.message)||e); }
  }
  showManual(L.failTitle+' ('+lastErr+')');
}
copy.addEventListener('click',function(){
  var txt=codeEl.textContent||'';
  function done(){var o=copy.textContent;copy.textContent=L.copied;setTimeout(function(){copy.textContent=o;},1500);}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(done,done);}
  else{var ta=document.createElement('textarea');ta.value=txt;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');}catch(e){}document.body.removeChild(ta);done();}
});
retry.addEventListener('click',deliver);
if(err){ showManual('Discord: '+err); }
else if(!code){ status.className='err'; status.textContent=L.noCodeTitle+'. '+L.noCodeBody; retry.hidden=true; }
else{ deliver(); }
})();
</script>
</body>
</html>`;
}

export interface DiscordProxyEnv {
  clientId?: string;
  clientSecret?: string;
  fetchFn?: typeof fetch;
}

function proxyCorsHeaders(): Record<string, string> {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}

/** Preflight CORS para el proxy (el daemon lo llama server-side, pero se deja abierto). */
export function discordProxyPreflight(): Response {
  return new Response(null, { status: 204, headers: proxyCorsHeaders() });
}

/**
 * `POST /api/discord/rpc-token`: custodia del client_secret.
 *
 * - `{ code, redirect_uri }` → `grant_type=authorization_code`.
 * - `{ grant_type: 'refresh_token', refresh_token }` → renovación.
 *
 * Propaga los errores de Discord tal cual (mismo status + `error` /
 * `error_description`) para que el daemon los muestre. El secret NUNCA sale
 * en las respuestas.
 */
export async function handleDiscordRpcToken(req: Request, env: DiscordProxyEnv): Promise<Response> {
  const headers = { 'Content-Type': 'application/json', ...proxyCorsHeaders() };
  const clientSecret = (env.clientSecret ?? '').trim();
  const clientId = (env.clientId ?? '').trim();
  if (!clientSecret || !clientId) {
    return new Response(
      JSON.stringify({ error: 'discord-not-configured', error_description: 'Relay sin DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET (ver docs/discord-app-setup.md).' }),
      { status: 500, headers },
    );
  }
  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_request', error_description: 'Body JSON requerido.' }), { status: 400, headers });
  }
  const grant = typeof body?.grant_type === 'string' ? body.grant_type : 'authorization_code';
  const params: Record<string, string> = { client_id: clientId, client_secret: clientSecret };
  if (grant === 'refresh_token') {
    const refreshToken = String(body?.refresh_token ?? '').trim();
    if (!refreshToken) {
      return new Response(JSON.stringify({ error: 'invalid_request', error_description: 'Falta refresh_token.' }), { status: 400, headers });
    }
    params.grant_type = 'refresh_token';
    params.refresh_token = refreshToken;
  } else if (grant === 'authorization_code') {
    const code = String(body?.code ?? '').trim();
    const redirectUri = String(body?.redirect_uri ?? body?.redirectUri ?? '').trim();
    if (!code || !redirectUri) {
      return new Response(JSON.stringify({ error: 'invalid_request', error_description: 'Faltan code y redirect_uri (debe ser EXACTO al registrado en Discord).' }), {
        status: 400,
        headers,
      });
    }
    params.grant_type = 'authorization_code';
    params.code = code;
    params.redirect_uri = redirectUri;
  } else {
    return new Response(JSON.stringify({ error: 'unsupported_grant_type', error_description: `grant_type no soportado: ${grant}` }), { status: 400, headers });
  }
  let res: Response;
  try {
    res = await (env.fetchFn ?? fetch)(DISCORD_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'relay-error', error_description: `No se pudo contactar con discord.com: ${e instanceof Error ? e.message : String(e)}` }), {
      status: 502,
      headers,
    });
  }
  const data = await res.json().catch(() => ({}));
  if (typeof data === 'object' && data !== null) {
    delete (data as any).client_secret;
    delete (data as any).clientSecret;
  }
  return new Response(JSON.stringify(data), { status: res.status, headers });
}
