//! Login de Spotify en una ventana controlada por la app.
//!
//! Helper `bundeck-spotify-auth` (ver `spotify_auth_bin.rs`): abre el Web
//! Player oficial de Spotify en una webview propia (WebView2 en Windows,
//! WKWebView en macOS, WebKitGTK en Linux), inyecta el sniffer que extrae el
//! token de sesión (`token-capture` del daemon) y se cierra solo al conseguirlo.
//! Si ya hay sesión, el player carga directo y el token se extrae igual.
//!
//! Por qué multi-estrategia y no un solo endpoint: Spotify cambia a menudo
//! dónde vive el token (endpoint `get_access_token`, `localStorage`, cabecera
//! `Authorization` de sus llamadas internas) y la cookie de sesión suele ser
//! httpOnly (invisible para JS pero usable vía `fetch credentials:include`).
//! Ninguna vía es fiable sola; el sniffer prueba todas en paralelo y publica
//! por IPC la primera que dé un token con buena pinta.
//!
//! Solo funciones puras + POST al daemon (testeables sin ventana); el bucle
//! tao/wry vive en el binario.

/// Web Player oficial de Spotify.
pub const SPOTIFY_WEB_PLAYER_URL: &str = "https://open.spotify.com";
/// Endpoint del propio Web Player que reacuña el access token con las cookies.
pub const SPOTIFY_TOKEN_PATH: &str = "/get_access_token?reason=transport&productType=web_player";

/// Prefijo de todos los `console.log` del sniffer (el usuario puede ver la
/// consola/devtools de la ventana del helper y pegar lo que vea).
pub const SNIFFER_LOG_TAG: &str = "[bundeck-spotify-auth]";

/// Códigos de salida del helper (ver `spotify_auth_bin.rs`).
pub const EXIT_OK: i32 = 0;
pub const EXIT_USER_CLOSED: i32 = 1;
pub const EXIT_TIMEOUT: i32 = 2;
pub const EXIT_SETUP_FAILED: i32 = 3;

/// Base del daemon en loopback (inyectable en tests vía los *_url).
pub fn daemon_base(api_port: u16) -> String {
    format!("http://127.0.0.1:{api_port}")
}

/// URL de captura de tokens del daemon.
pub fn capture_url(api_port: u16) -> String {
    format!("{}/api/v1/plugins/spotify/token-capture", daemon_base(api_port))
}

/// Token extraído del Web Player (vía `window.ipc.postMessage`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpotifyToken {
    pub access_token: String,
    pub expires_in: u64,
    pub token_type: String,
    /// Estrategia que lo encontró (`mint`, `fetch-req:…`, `storage:…`, …).
    /// Solo diagnóstico: NO se envía al daemon.
    pub source: Option<String>,
}

/// Sniffer multi-estrategia inyectado como `initialization_script`.
///
/// wry lo registra como script de documento-inicial: corre ANTES de que
/// carguen los scripts de la página (WebView2 `AddScriptToExecuteOnDocumentCreated`,
/// equivalente en WebKit/WKWebView), así los hooks de `fetch`/`XHR` se
/// instalan antes de que la app de Spotify haga su primera llamada. En cada
/// navegación de documento se re-ejecuta (guard anti-duplicados + re-hook
/// periódico por si una navegación SPA reemplaza `window.fetch`).
///
/// Estrategias, en paralelo:
/// - (a) `fetch`/`XMLHttpRequest` interceptados: husmean `Authorization:
///   Bearer …` en peticiones a `*.spotify.com` y escanean cuerpos JSON de
///   respuesta en busca de `accessToken`.
/// - (b) Barrido de `localStorage`/`sessionStorage`: claves con pinta de
///   token (`accessToken`, `*.accessToken`, JWT) y valores largos.
/// - (c) `get_access_token` del propio player con `credentials:include`
///   (usa las cookies httpOnly de sesión, invisibles para JS).
/// - (d) Presencia de cookies legibles: solo diagnóstico (log), nunca token.
///
/// Diagnóstico visible: `console.log` con el prefijo `[bundeck-spotify-auth]`
/// (estrategia instalada, nº de peticiones/Bearers vistos, storage con
/// sesión, errores) + overlay discreto en la ventana ("Esperando login…" →
/// "Token detectado, cerrando…") + mensajes `__log` por IPC que el binario
/// vuelca al fichero de log. NUNCA se registra el valor del token: solo
/// prefijo/longitud enmascarados.
pub fn build_sniffer_js() -> String {
    // NOTA: el POST al daemon lo hace el binario Rust por IPC (evita CORS y
    // permite cerrar la ventana al éxito). Sin `format!`: el JS viaja tal cual.
    r#"(function(){var TAG="[bundeck-spotify-auth]";function log(){try{var a=[TAG];for(var i=0;i<arguments.length;i++){a.push(arguments[i]);}console.log.apply(console,a);}catch(e){}}function logIpc(kind,detail){try{if(window.ipc&&window.ipc.postMessage){window.ipc.postMessage(JSON.stringify({__log:kind,detail:String(detail==null?"":detail).slice(0,200)}));}}catch(e){}}if(window.__ldSpotifySniffV2){log("sniffer ya instalado (re-navegacion)");return;}window.__ldSpotifySniffV2=true;if(!/(^|\.)spotify\.com$/.test(location.hostname)){if(location.hostname){log("host no-spotify ("+location.hostname+"): sniffer inactivo");}return;}log("init: instalando estrategias fetch/XHR/storage/mint en",location.hostname);var last="";var seenReq=0,seenBearer=0,mints=0,heartbeats=0;var inHook=false;function mask(t){t=String(t||"");return t.length>8?t.slice(0,4)+"...("+t.length+")":"(corto:"+t.length+")";}function overlay(msg){try{var el=document.getElementById("__ld-spotify-status");if(!el){el=document.createElement("div");el.id="__ld-spotify-status";el.setAttribute("style","position:fixed;left:12px;bottom:12px;z-index:2147483647;background:rgba(20,20,20,.88);color:#ffd75e;font:12px/1.4 system-ui,sans-serif;padding:8px 12px;border-radius:8px;pointer-events:none;max-width:70vw;");var root=document.documentElement||document.body;if(root){root.appendChild(el);}}el.textContent="BunDeck Spotify: "+msg;}catch(e){}}function shortHost(u){try{var m=String(u||"").match(/^https?:\/\/([^\/]+)/);return m?m[1]:"?";}catch(e){return "?";}}function scanTextForToken(s){try{s=String(s||"");var m=s.match(/"accessToken"\s*:\s*"([^"]{20,4000})"/)||s.match(/"access_token"\s*:\s*"([^"]{20,4000})"/);if(m){return m[1];}var j=s.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);if(j){return j[0];}}catch(e){}return null;}function report(token,source){try{if(typeof token!=="string"){return;}token=token.trim();if(token.length<20||token===last){return;}last=token;log("token visto via "+source+": "+mask(token));overlay("Token detectado ("+source+"), cerrando...");logIpc("token-found",source+" len="+token.length);try{window.ipc.postMessage(JSON.stringify({accessToken:token,source:String(source||"")}));log("ipc token enviado ("+source+", len="+token.length+")");}catch(e){log("ipc postMessage fallo: "+e);}}catch(e){}}function headerVal(headers,name){try{if(!headers){return null;}if(typeof headers.get==="function"){return headers.get(name);}if(typeof headers==="object"){for(var k in headers){if(k&&k.toLowerCase()===name&&headers[k]){return headers[k];}}}if(typeof headers==="string"&&headers.toLowerCase().indexOf(name+":")>=0){return headers;}}catch(e){}return null;}var origFetch=window.fetch;function isOwnUrl(u){return String(u||"").indexOf("get_access_token")>=0;}function hookedFetch(input,init){var url="";try{url=typeof input==="string"?input:((input&&input.url)||"");}catch(e){}if(inHook||isOwnUrl(url)){return origFetch.apply(this,arguments);}inHook=true;var p;try{p=origFetch.apply(this,arguments);}catch(e){inHook=false;log("fetch original lanzo: "+(e&&e.message||e));throw e;}inHook=false;seenReq++;try{var h=(init&&init.headers)||(input&&input.headers);var auth=headerVal(h,"authorization");if(auth&&/^bearer\s+/i.test(String(auth))){var tok=String(auth).replace(/^bearer\s+/i,"").trim();if(tok&&tok!==last&&tok.length>=20){seenBearer++;log("fetch Bearer NUEVO hacia "+shortHost(url)+" ("+mask(tok)+")");report(tok,"fetch-req:"+shortHost(url));}}}catch(e){}if(seenReq%200===1){log("fetch req="+seenReq+" bearers-nuevos="+seenBearer);}try{return p.then(function(res){try{var ru=(res&&res.url)||url||"";if(/spotify\.com/i.test(ru)&&res&&typeof res.clone==="function"){res.clone().text().then(function(t){var tok=scanTextForToken(t);if(tok){report(tok,"fetch-res:"+shortHost(ru));}}).catch(function(){});}}catch(e){}return res;});}catch(e){return p;}}function ensureFetchHook(){try{if(window.fetch!==hookedFetch){log("re-instalando hook fetch (la app lo reemplazo; se conserva fetch nativo)");window.fetch=hookedFetch;}}catch(e){log("ensureFetchHook fallo: "+e);}}try{window.fetch=hookedFetch;log("hook fetch instalado");}catch(e){log("hook fetch NO instalado: "+e);}try{var OrigXHR=window.XMLHttpRequest;if(OrigXHR){var origOpen=OrigXHR.prototype.open;var origSend=OrigXHR.prototype.send;OrigXHR.prototype.open=function(method,url){try{this.__ldUrl=String(url||"");}catch(e){}return origOpen.apply(this,arguments);};OrigXHR.prototype.send=function(body){var xhr=this;try{xhr.addEventListener("load",function(){try{var ru=xhr.__ldUrl||xhr.responseURL||"";var t=String(xhr.responseText||"");if(/spotify\.com/i.test(ru)&&ru.indexOf("get_access_token")<0&&t){var tok=scanTextForToken(t);if(tok){report(tok,"xhr-res:"+shortHost(ru));}}}catch(e){}});}catch(e){}return origSend.apply(this,arguments);};log("hook XHR instalado");}else{log("sin XMLHttpRequest en esta pagina");}}catch(e){log("hook XHR NO instalado: "+e);}function scanStorage(store,name){var total=0,cand=[];try{total=store.length;for(var i=0;i<store.length;i++){var k=null;try{k=store.key(i);}catch(e){continue;}if(k&&/access.?token|bearer|sp_?dc|auth/i.test(k)){cand.push(k);}}}catch(e){log("storage "+name+" ilegible: "+e);logIpc("storage-scan",name+" error="+e);return;}log("storage "+name+": "+total+" claves, "+cand.length+" candidatas ["+cand.slice(0,8).join(",")+"]");logIpc("storage-scan",name+" total="+total+" candidatas="+cand.length);for(var j=0;j<cand.length;j++){var v=null;try{v=store.getItem(cand[j]);}catch(e){continue;}if(!v){continue;}var tok=null;try{var o=JSON.parse(v);tok=(o&&(o.accessToken||o.access_token||o.token))||scanTextForToken(v);}catch(e){if(/access.?token|bearer/i.test(cand[j])&&v.length>=20&&v.length<5000){tok=v.trim();}else{tok=scanTextForToken(v);}}if(tok){report(tok,"storage:"+name+":"+cand[j]);}}}function diagCookies(){try{var ck="";try{ck=document.cookie||"";}catch(e){log("document.cookie ilegible: "+e);}var n=ck?ck.split(";").length:0;var hasDc=/(?:^|;\s*)sp_dc=/.test(ck);log("cookies legibles: "+n+" (sp_dc visible: "+(hasDc?"si":"no")+")");logIpc("cookies","count="+n+" sp_dc="+(hasDc?"si":"no"));}catch(e){log("diagCookies fallo: "+e);}}function mint(){try{if(location.hostname!=="open.spotify.com"){return;}mints++;fetch("/get_access_token?reason=transport&productType=web_player",{credentials:"include"}).then(function(r){if(!r.ok){if(mints%6===1){log("mint intento "+mints+": HTTP "+r.status);}return null;}return r.json().catch(function(){return null;});}).then(function(t){if(t&&t.accessToken){report(t.accessToken,"mint");}else if(mints%6===1){log("mint intento "+mints+": sin accessToken en respuesta");logIpc("mint-empty","intento="+mints);}}).catch(function(e){if(mints%6===1){log("mint intento "+mints+" fallo red: "+e);}});}catch(e){log("mint fallo: "+e);}}overlay("Esperando login...");diagCookies();mint();setInterval(function(){try{ensureFetchHook();var onPlayer=location.hostname==="open.spotify.com";if(onPlayer){try{scanStorage(window.localStorage,"local");}catch(e){log("localStorage fallo: "+e);}try{scanStorage(window.sessionStorage,"session");}catch(e){log("sessionStorage fallo: "+e);}mint();}heartbeats++;if(heartbeats%15===0){log("latido: req="+seenReq+" bearers="+seenBearer+" mints="+mints+" host="+location.hostname);logIpc("heartbeat","req="+seenReq+" bearers="+seenBearer+" mints="+mints+" host="+location.hostname);}}catch(e){log("tick fallo: "+e);}},4000);log("init ok: overlay + tick 4s armados");})();"#
    .to_string()
}

/// Mensaje IPC de diagnóstico (`{__log, detail}`). `None` si es un token.
pub fn parse_ipc_log(body: &str) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let kind = v.get("__log")?.as_str()?;
    let detail = v
        .get("detail")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    Some((kind.to_string(), detail))
}

/// Parsea el mensaje IPC del sniffer. Acepta `accessToken` o `token` (JWT u
/// opaco ≥20 chars), `expiresIn`/`expires_in` y `tokenType`/`token_type`;
/// ignora el campo extra `source`. `None` si no trae token válido.
pub fn parse_ipc_token(body: &str) -> Option<SpotifyToken> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    if v.get("__log").is_some() {
        return None;
    }
    let access_token = v
        .get("accessToken")
        .or_else(|| v.get("access_token"))
        .or_else(|| v.get("token"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim();
    if access_token.len() < 20 {
        return None;
    }
    let expires_in = v
        .get("expiresIn")
        .or_else(|| v.get("expires_in"))
        .and_then(|x| x.as_u64())
        .filter(|&n| n > 0)
        .unwrap_or(3600);
    let token_type = v
        .get("tokenType")
        .or_else(|| v.get("token_type"))
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Bearer");
    let source = v
        .get("source")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    Some(SpotifyToken {
        access_token: access_token.to_string(),
        expires_in,
        token_type: token_type.to_string(),
        source,
    })
}

/// Publica el token en el daemon (`token-capture` lo valida, guarda y limpia
/// el `login-request` pendiente). Ok con el cuerpo del daemon. `source` solo
/// va al log local, nunca al daemon.
///
/// Con timeouts explícitos: el `ureq::post` global no tiene ninguno y un
/// daemon colgado dejaría el handler IPC bloqueado para siempre (ventana que
/// no se cierra sin rastro). Aquí fallar es ruidoso: `Err` con el motivo.
pub fn post_token_capture(api_port: u16, token: &SpotifyToken) -> Result<String, String> {
    post_token_capture_to(&capture_url(api_port), token)
}

/// Variante inyectable (tests): POST a cualquier URL con timeouts.
pub fn post_token_capture_to(url: &str, token: &SpotifyToken) -> Result<String, String> {
    let body = serde_json::json!({
        "accessToken": token.access_token,
        "expiresIn": token.expires_in,
        "tokenType": token.token_type,
    });
    let agent: ureq::Agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(std::time::Duration::from_secs(8)))
            .timeout_per_read(Some(std::time::Duration::from_secs(10)))
            .timeout_per_write(Some(std::time::Duration::from_secs(8)))
            .build(),
    );
    let mut resp = agent
        .post(url)
        .header("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| format!("POST {url}: {e}"))?;
    let text = resp
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("leer respuesta: {e}"))?;
    // Éxito robusto: JSON con `success:true`, no substring (el daemon puede
    // reordenar claves o añadir envoltorios).
    let ok = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("success").and_then(|s| s.as_bool()))
        .unwrap_or(false);
    if !ok {
        return Err(format!("token-capture rechazado: {}", clip(&text, 200)));
    }
    Ok(text)
}

/// Recorta un texto para logs (nunca tokens: solo se usa con errores).
fn clip(s: &str, max: usize) -> String {
    let mut out: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        out.push('…');
    }
    out
}

/// Claves de primer nivel de un IPC (diagnóstico sin valores: nunca el token).
pub fn ipc_keys(body: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.as_object().map(|o| o.keys().cloned().collect()))
        .unwrap_or_default()
}

/// Fichero de diagnóstico del helper: `<user-data>/logs/spotify-auth.log`
/// (Windows `%APPDATA%/BunDeck/data`, macOS `~/Library/Application
/// Support/BunDeck/data`, resto `~/.local/share/bundeck/data`).
pub fn auth_log_path() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(|base| {
            std::path::PathBuf::from(base)
                .join("BunDeck")
                .join("data")
                .join("logs")
                .join("spotify-auth.log")
        })
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|base| {
            std::path::PathBuf::from(base)
                .join("Library")
                .join("Application Support")
                .join("BunDeck")
                .join("data")
                .join("logs")
                .join("spotify-auth.log")
        })
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_DATA_HOME").map(std::path::PathBuf::from).or_else(|| {
            std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local").join("share"))
        })?;
        Some(
            base.join("bundeck")
                .join("data")
                .join("logs")
                .join("spotify-auth.log"),
        )
    }
}

/// Añade una línea al log de diagnóstico (best-effort). El llamante NO debe
/// pasar nunca el valor del token: solo `source` y longitud.
pub fn append_auth_log(line: &str) -> bool {
    let path = match auth_log_path() {
        Some(p) => p,
        None => return false,
    };
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).append(true);
    match opts.open(&path).and_then(|mut f| {
        writeln!(f, "[{}] {line}", chrono_stamp())?;
        Ok::<(), std::io::Error>(())
    }) {
        Ok(()) => true,
        Err(_) => false,
    }
}

/// Timestamp simple sin dependencias (`chrono` no está en el crate).
fn chrono_stamp() -> String {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => format!("{}", d.as_secs()),
        Err(_) => "?".to_string(),
    }
}

/// Milisegundos desde epoch (para el throttle de POST).
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Freno de reintentos del POST: el MISMO token se intenta como mucho una
/// vez cada 10 s (el sniffer solo reporta cambios, pero recargas/rehydrates
/// pueden reenviarlo); un token DISTINTO siempre se intenta de inmediato.
/// Evita martillear al daemon si `token-capture` falla.
#[derive(Debug, Clone)]
pub struct PostThrottle {
    last_token: String,
    last_attempt_ms: u64,
}

impl PostThrottle {
    pub fn new() -> Self {
        Self {
            last_token: String::new(),
            last_attempt_ms: 0,
        }
    }

    pub fn should_try(&mut self, token: &str, now: u64) -> bool {
        if token != self.last_token || now.saturating_sub(self.last_attempt_ms) >= 10_000 {
            self.last_token = token.to_string();
            self.last_attempt_ms = now;
            true
        } else {
            false
        }
    }
}

impl Default for PostThrottle {
    fn default() -> Self {
        Self::new()
    }
}

/// Puerto del daemon: `--api-port N`, si no `PORT`, si no 3001.
pub fn resolve_api_port(args: &[String]) -> u16 {
    if let Some(i) = args.iter().position(|a| a == "--api-port") {
        if let Some(v) = args.get(i + 1).and_then(|s| s.parse::<u16>().ok()) {
            return v;
        }
    }
    std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(3001)
}

/// Timeout de la ventana: `--timeout-secs N` (forzado a 30–3600), si no 600 s.
pub fn resolve_timeout_secs(args: &[String]) -> u64 {
    if let Some(i) = args.iter().position(|a| a == "--timeout-secs") {
        if let Some(v) = args.get(i + 1).and_then(|s| s.parse::<u64>().ok()) {
            return v.clamp(30, 3600);
        }
    }
    600
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fin de cabeceras HTTP: índice del primer byte tras `\r\n\r\n`.
    fn find_headers_end(buf: &[u8]) -> Option<usize> {
        buf.windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|pos| pos + 4)
    }

    /// Content-Length de las cabeceras (0 si ausente/ilegible).
    fn content_length(headers: &[u8]) -> usize {
        let text = String::from_utf8_lossy(headers).to_lowercase();
        text.lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                (name.trim() == "content-length")
                    .then(|| value.trim().parse().unwrap_or(0))
            })
            .unwrap_or(0)
    }

    #[test]
    fn urls_apuntan_a_loopback_y_capture() {
        assert_eq!(daemon_base(3001), "http://127.0.0.1:3001");
        assert!(capture_url(3001).ends_with("/api/v1/plugins/spotify/token-capture"));
    }

    #[test]
    fn sniffer_trae_todas_las_estrategias_y_diagnostico() {
        let js = build_sniffer_js();
        // Guardia + init-script temprano (hooks antes de la app).
        assert!(js.contains("__ldSpotifySniffV2"));
        // (a) Interceptores fetch + XHR con Authorization Bearer.
        assert!(js.contains("window.fetch=hookedFetch"));
        assert!(js.contains("XMLHttpRequest"));
        assert!(js.contains("authorization"));
        assert!(js.contains("bearer"));
        // (b) Barrido de storage.
        assert!(js.contains("localStorage"));
        assert!(js.contains("sessionStorage"));
        assert!(js.contains("scanStorage"));
        // (c) Mint del player con cookies.
        assert!(js.contains("get_access_token"));
        assert!(js.contains("credentials"));
        // Diagnóstico: consola prefijada + overlay + latido por IPC.
        assert!(js.contains(SNIFFER_LOG_TAG));
        assert!(js.contains("console.log"));
        assert!(js.contains("__ld-spotify-status"));
        assert!(js.contains("Esperando login"));
        assert!(js.contains("heartbeat"));
        // Guardia de reentrancia: no intercepta sus propias peticiones
        // (`get_access_token` del mint) y no re-envuelve el fetch de la app.
        assert!(js.contains("inHook"));
        assert!(js.contains("isOwnUrl"));
        assert!(js.contains("no-spotify"));
        // Re-hook tras navegaciones SPA (conservando el fetch nativo).
        assert!(js.contains("ensureFetchHook"));
        assert!(js.contains("fetch nativo"));
        // Muestreo + Bearer→candidate (solo tokens nuevos, sin inundar).
        assert!(js.contains("Bearer NUEVO"));
        assert!(js.contains("fetch-req:"));
        assert!(js.contains("bearers-nuevos="));
        // Confirmación post-postMessage + silencio en iframes vacíos.
        assert!(js.contains("ipc token enviado"));
        assert!(js.contains("if(location.hostname)"));
        // IPC + sin URLs del daemon (el POST lo hace Rust).
        assert!(js.contains("window.ipc.postMessage"));
        assert!(!js.contains("http://127.0.0.1"));
        // Sin fugas obvias: el token solo viaja enmascarado a consola.
        assert!(js.contains("...("));
    }

    #[test]
    fn parse_ipc_token_multi_formato() {
        // Clásico del mint.
        let t = parse_ipc_token(r#"{"accessToken":"tok-1234567890abcdef","expiresIn":3600,"tokenType":"Bearer"}"#).unwrap();
        assert_eq!((t.expires_in, t.token_type.as_str()), (3600, "Bearer"));
        assert!(t.source.is_none());
        // snake_case + source de diagnóstico.
        let t = parse_ipc_token(r#"{"access_token":"tok-1234567890abcdef","expires_in":1800,"token_type":"Bearer","source":"storage:local:x"}"#).unwrap();
        assert_eq!((t.expires_in, t.source.as_deref()), (1800, Some("storage:local:x")));
        // JWT en campo `token`.
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dummy-signature-1234567890";
        let t = parse_ipc_token(&format!(r#"{{"token":"{jwt}"}}"#)).unwrap();
        assert_eq!(t.access_token, jwt);
        assert_eq!((t.expires_in, t.token_type.as_str()), (3600, "Bearer"));
        // Mensajes de log NO son tokens.
        assert!(parse_ipc_token(r#"{"__log":"heartbeat","detail":"req=3"}"#).is_none());
        // Rechazos: corto / vacío / no-json. Umbral: 19 chars fuera, 20 dentro.
        assert!(parse_ipc_token(r#"{"accessToken":"corto123"}"#).is_none());
        assert!(parse_ipc_token(r#"{"accessToken":"1234567890123456789"}"#).is_none());
        assert!(parse_ipc_token(r#"{"accessToken":"12345678901234567890"}"#).is_some());
        assert!(parse_ipc_token(r#"{}"#).is_none());
        assert!(parse_ipc_token("no-json").is_none());
    }

    #[test]
    fn parse_ipc_log_distinque_diagnostico() {
        let (kind, detail) = parse_ipc_log(r#"{"__log":"storage-scan","detail":"local total=12 candidatas=2"}"#).unwrap();
        assert_eq!((kind.as_str(), detail.as_str()), ("storage-scan", "local total=12 candidatas=2"));
        assert!(parse_ipc_log(r#"{"accessToken":"tok-1234567890abcdef"}"#).is_none());
        assert!(parse_ipc_log("no-json").is_none());
    }

    #[test]
    fn resolve_flags_y_exit_codes() {
        assert_eq!(resolve_api_port(&["--api-port".into(), "4001".into()]), 4001);
        assert_eq!(resolve_api_port(&[]), 3001);
        assert_eq!(resolve_timeout_secs(&["--timeout-secs".into(), "60".into()]), 60);
        assert_eq!(resolve_timeout_secs(&[]), 600);
        // Clamp 30–3600.
        assert_eq!(resolve_timeout_secs(&["--timeout-secs".into(), "5".into()]), 30);
        assert_eq!(resolve_timeout_secs(&["--timeout-secs".into(), "99999".into()]), 3600);
        // Códigos distintos y estables.
        assert_eq!((EXIT_OK, EXIT_USER_CLOSED, EXIT_TIMEOUT, EXIT_SETUP_FAILED), (0, 1, 2, 3));
    }

    #[test]
    fn ipc_keys_no_expone_valores() {
        let keys = ipc_keys(r#"{"accessToken":"tok-secreto-1234567890","source":"fetch-res:x"}"#);
        assert_eq!(keys, vec!["accessToken".to_string(), "source".to_string()]);
        assert!(ipc_keys("no-json").is_empty());
    }

    /// Camino completo fetch-res→IPC→parse→POST-OK con un cuerpo como el real
    /// de open.spotify.com (JSON con accessToken entre más campos).
    #[test]
    fn camino_fetch_res_a_post_ok_con_daemon_mock() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let port = listener.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
        let seen2 = seen.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .unwrap();
            // Lee hasta tener cabeceras + cuerpo completo (el POST puede
            // llegar en varios segmentos).
            let mut raw = Vec::new();
            let mut buf = vec![0u8; 4096];
            loop {
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&buf[..n]);
                let s = String::from_utf8_lossy(&raw).to_string();
                if let Some(hend) = s.find("\r\n\r\n") {
                    let len = s[..hend]
                        .lines()
                        .find_map(|l| {
                            l.strip_prefix("Content-Length:")
                                .or_else(|| l.strip_prefix("content-length:"))
                                .and_then(|v| v.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if raw.len() >= hend + 4 + len {
                        break;
                    }
                }
                if raw.len() > 65536 {
                    break;
                }
            }
            *seen2.lock().unwrap() = raw;
            let body = r#"{"success":true,"pluginId":"spotify","expiresAt":"123"}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(resp.as_bytes()).unwrap();
        });
        // Cuerpo realista: accessToken anidado entre otros campos + source.
        let token_value = "BQDp".to_string() + &"x".repeat(384);
        let ipc = format!(
            r#"{{"accessToken":"{token_value}","source":"fetch-res:open.spotify.com"}}"#
        );
        let token = parse_ipc_token(&ipc).expect("el token fetch-res debe parsear");
        assert_eq!(token.access_token.len(), 388);
        assert_eq!(token.source.as_deref(), Some("fetch-res:open.spotify.com"));
        let url = format!("http://127.0.0.1:{port}/api/v1/plugins/spotify/token-capture");
        let out = post_token_capture_to(&url, &token).expect("POST-OK contra el mock");
        assert!(out.contains("\"success\":true"));
        // El daemon recibió el POST con los 3 campos conocidos (sin source).
        let raw = String::from_utf8_lossy(&seen.lock().unwrap()).to_string();
        assert!(raw.starts_with("POST "));
        assert!(raw.contains(&token_value));
        assert!(raw.contains("\"expiresIn\""));
        assert!(!raw.contains("fetch-res"));
        server.join().unwrap();
    }

    #[test]
    fn post_rechazado_si_success_false() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .unwrap();
            // Leer petición completa (cabeceras + body según Content-Length):
            // una sola lectura puede traer solo las cabeceras y responder
            // antes de tiempo cortaría el body (RST en Windows loopback).
            let mut buf = vec![0u8; 8192];
            let mut got = 0;
            let mut body_len = 0usize;
            let mut headers_done = false;
            while got < buf.len() {
                match stream.read(&mut buf[got..]) {
                    Ok(0) => break,
                    Ok(n) => {
                        got += n;
                        if !headers_done {
                            if let Some(pos) = find_headers_end(&buf[..got]) {
                                headers_done = true;
                                body_len = content_length(&buf[..pos]);
                            }
                        }
                        if headers_done {
                            if let Some(pos) = find_headers_end(&buf[..got]) {
                                if got - pos >= body_len {
                                    break;
                                }
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            let body = r#"{"error":"token inválido"}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(resp.as_bytes()).unwrap();
        });
        let token = SpotifyToken {
            access_token: "tok-1234567890abcdef".to_string(),
            expires_in: 3600,
            token_type: "Bearer".to_string(),
            source: None,
        };
        let url = format!("http://127.0.0.1:{port}/api/v1/plugins/spotify/token-capture");
        let err = post_token_capture_to(&url, &token).expect_err("success:false debe fallar");
        assert!(err.contains("rechazado"));
        server.join().unwrap();
    }

    #[test]
    fn post_throttle_frena_reintentos_del_mismo_token() {
        let mut th = PostThrottle::new();
        assert!(th.should_try("tok-abc", 0));
        // Mismo token al instante: no.
        assert!(!th.should_try("tok-abc", 1_000));
        assert!(!th.should_try("tok-abc", 9_999));
        // Mismo token tras 10 s: sí (backoff).
        assert!(th.should_try("tok-abc", 10_000));
        // Token distinto: siempre sí, y resetea el freno.
        assert!(th.should_try("tok-xyz", 10_001));
        assert!(!th.should_try("tok-xyz", 11_000));
    }

    #[test]
    fn auth_log_path_apunta_al_data_dir() {
        let p = auth_log_path().expect("debería resolverse con HOME/APPDATA");
        assert!(p.ends_with("spotify-auth.log"));
        assert!(p.to_string_lossy().contains("logs"));
    }
}
