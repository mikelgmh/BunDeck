//! Login de Spotify en una ventana controlada por la app.
//!
//! Helper `bundeck-spotify-auth` (ver `spotify_auth_bin.rs`): abre el Web
//! Player oficial de Spotify en una webview propia (WebView2 en Windows,
//! WKWebView en macOS, WebKitGTK en Linux), inyecta el sniffer que acuña el
//! token de sesión (`token-capture` del daemon) y se cierra solo al conseguirlo.
//! Si ya hay sesión, el player carga directo y el token se extrae igual.
//!
//! Sustituye al `open::that` (navegador del sistema) como vía principal: el
//! navegador del sistema no puede ejecutar el sniffer y el login nunca se
//! completaba solo. Solo funciones puras + POST al daemon (testeables sin
//! ventana); el bucle tao/wry vive en el binario.

/// Web Player oficial de Spotify.
pub const SPOTIFY_WEB_PLAYER_URL: &str = "https://open.spotify.com";
/// Endpoint del propio Web Player que reacuña el access token con las cookies.
pub const SPOTIFY_TOKEN_PATH: &str = "/get_access_token?reason=transport&productType=web_player";

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
}

/// Sniffer inyectado como `initialization_script` (corre en cada navegación,
/// también tras el redirect login → player). Acuña al instante y cada 5 s;
/// publica por IPC SOLO cuando el token cambia.
pub fn build_sniffer_js() -> String {
    // NOTA: no usar `fetch(capture)` aquí: el POST al daemon lo hace el
    // binario Rust por IPC (evita CORS y permite cerrar la ventana al éxito).
    format!(
        r#"(function(){{if(window.__ldSpotifySniff)return;window.__ldSpotifySniff=true;var TOKEN_URL={token_url};var last="";function mint(){{try{{if(location.hostname!=="open.spotify.com")return;fetch(TOKEN_URL,{{credentials:"include"}}).then(function(r){{if(!r.ok)return null;return r.json().catch(function(){{return null;}});}}).then(function(t){{if(!t||!t.accessToken||t.accessToken===last)return;last=t.accessToken;try{{window.ipc.postMessage(JSON.stringify({{accessToken:t.accessToken,expiresIn:t.expiresIn||t.expires_in||3600,tokenType:t.tokenType||"Bearer"}}));}}catch(e){{}}}}).catch(function(){{}});}}catch(e){{}}}}mint();setInterval(mint,5000);}})();"#,
        token_url = serde_json::to_string(SPOTIFY_TOKEN_PATH).unwrap_or_else(|_| format!("\"{SPOTIFY_TOKEN_PATH}\"")),
    )
}

/// Parsea el mensaje IPC del sniffer. `None` si no trae access token válido.
pub fn parse_ipc_token(body: &str) -> Option<SpotifyToken> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let access_token = v
        .get("accessToken")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim();
    if access_token.len() < 10 {
        return None;
    }
    let expires_in = v
        .get("expiresIn")
        .and_then(|x| x.as_u64())
        .filter(|&n| n > 0)
        .unwrap_or(3600);
    let token_type = v
        .get("tokenType")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Bearer");
    Some(SpotifyToken {
        access_token: access_token.to_string(),
        expires_in,
        token_type: token_type.to_string(),
    })
}

/// Publica el token en el daemon (`token-capture` lo valida, guarda y limpia
/// el `login-request` pendiente). Ok con el cuerpo del daemon.
pub fn post_token_capture(api_port: u16, token: &SpotifyToken) -> Result<String, String> {
    let url = capture_url(api_port);
    let body = serde_json::json!({
        "accessToken": token.access_token,
        "expiresIn": token.expires_in,
        "tokenType": token.token_type,
    });
    let resp = ureq::post(&url)
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| format!("POST {url}: {e}"))?;
    let text = resp.into_string().map_err(|e| format!("leer respuesta: {e}"))?;
    if !text.contains("\"success\":true") {
        return Err(format!("token-capture rechazado: {text}"));
    }
    Ok(text)
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

/// Timeout de la ventana: `--timeout-secs N`, si no 600 s.
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

    #[test]
    fn urls_apuntan_a_loopback_y_capture() {
        assert_eq!(daemon_base(3001), "http://127.0.0.1:3001");
        assert!(capture_url(3001).ends_with("/api/v1/plugins/spotify/token-capture"));
    }

    #[test]
    fn sniffer_solo_open_y_con_guardia_ipc() {
        let js = build_sniffer_js();
        assert!(js.contains("__ldSpotifySniff"));
        assert!(js.contains("get_access_token"));
        assert!(js.contains("window.ipc.postMessage"));
        assert!(js.contains("open.spotify.com"));
        assert!(!js.contains("http://127.0.0.1"));
    }

    #[test]
    fn parse_ipc_token_valido_y_rechazos() {
        let t = parse_ipc_token(r#"{"accessToken":"tok-1234567890","expiresIn":3600,"tokenType":"Bearer"}"#).unwrap();
        assert_eq!(t.access_token, "tok-1234567890");
        assert_eq!(t.expires_in, 3600);
        // Sin expiresIn: 3600 por defecto.
        let t = parse_ipc_token(r#"{"accessToken":"tok-1234567890"}"#).unwrap();
        assert_eq!((t.expires_in, t.token_type.as_str()), (3600, "Bearer"));
        // Rechazos.
        assert!(parse_ipc_token(r#"{}"#).is_none());
        assert!(parse_ipc_token(r#"{"accessToken":"corto"}"#).is_none());
        assert!(parse_ipc_token("no-json").is_none());
    }

    #[test]
    fn resolve_api_port_respeta_flag_y_env() {
        assert_eq!(resolve_api_port(&["--api-port".into(), "4001".into()]), 4001);
        assert_eq!(resolve_api_port(&[]), 3001);
        assert_eq!(resolve_timeout_secs(&["--timeout-secs".into(), "60".into()]), 60);
        assert_eq!(resolve_timeout_secs(&[]), 600);
    }
}
