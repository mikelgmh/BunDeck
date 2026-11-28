//! `bundeck-spotify-auth` — ventana de login de Spotify controlada por la app.
//!
//! Uso: `bundeck-spotify-auth [--api-port 3001] [--timeout-secs 600]`
//!
//! Abre el Web Player oficial en una webview propia, inyecta el sniffer
//! multi-estrategia (`spotify_auth::build_sniffer_js`) y publica el token por
//! IPC → `token-capture` del daemon. Diagnóstico en consola de la ventana
//! (prefijo `[bundeck-spotify-auth]`), overlay de estado y fichero
//! `logs/spotify-auth.log` del data dir. Códigos de salida:
//! - `0`: token capturado y guardado (la ventana se cierra sola).
//! - `1`: el usuario cerró la ventana (el pending caduca solo por TTL).
//! - `2`: timeout sin token (el daemon limpia el pending por TTL).
//! - `3`: no se pudo crear la ventana/webview.

mod spotify_auth;

use spotify_auth::{
    EXIT_OK, EXIT_SETUP_FAILED, EXIT_TIMEOUT, EXIT_USER_CLOSED, PostThrottle,
    SPOTIFY_WEB_PLAYER_URL, append_auth_log, build_sniffer_js, ipc_keys, now_ms, parse_ipc_log,
    parse_ipc_token, post_token_capture, resolve_api_port, resolve_timeout_secs,
};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};
use tao::{
    dpi::LogicalSize,
    event::{Event, StartCause, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

/// Vista recortada y sin secretos de un IPC para el log: claves + longitud.
/// Si trae pinta de token, la longitud delata; el valor jamás se registra.
fn clip_ipc(body: &str) -> String {
    let keys = ipc_keys(body);
    format!("claves={keys:?} len={}", body.len())
}
fn js_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let api_port = resolve_api_port(&args);
    let timeout_secs = resolve_timeout_secs(&args);

    append_auth_log(&format!(
        "helper iniciado (api-port={api_port} timeout={timeout_secs}s)"
    ));

    // Watchdog: sin token en N segundos, salir para no colgar el login.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(timeout_secs));
        append_auth_log(&format!("timeout sin token ({timeout_secs}s)"));
        eprintln!("[spotify-auth] timeout sin token ({timeout_secs}s)");
        std::process::exit(EXIT_TIMEOUT);
    });

    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("Conectar con Spotify — BunDeck")
        .with_inner_size(LogicalSize::new(1024.0, 760.0))
        .build(&event_loop)
        .unwrap_or_else(|e| {
            append_auth_log(&format!("no se pudo crear la ventana: {e}"));
            eprintln!("[spotify-auth] no se pudo crear la ventana: {e}");
            std::process::exit(EXIT_SETUP_FAILED);
        });

    // Canal IPC→bucle: el handler (posiblemente en otro hilo) pide
    // actualizar el overlay; el bucle lo aplica con evaluate_script.
    let (overlay_tx, overlay_rx) = mpsc::channel::<String>();
    let throttle = Arc::new(Mutex::new(PostThrottle::new()));

    let webview = WebViewBuilder::new()
        .with_url(SPOTIFY_WEB_PLAYER_URL)
        .with_initialization_script(&build_sniffer_js())
        .with_ipc_handler(move |req| {
            let body = req.body();
            // Diagnóstico del sniffer (nunca trae credenciales).
            if let Some((kind, detail)) = parse_ipc_log(body) {
                append_auth_log(&format!("sniffer: {kind} {detail}"));
                if kind == "token-found" {
                    eprintln!("[spotify-auth] token detectado ({detail})");
                }
                return;
            }
            let token = match parse_ipc_token(body) {
                Some(t) => t,
                None => {
                    // Antes esto solo iba a stderr (invisible: el launcher
                    // lanza el helper con stderr a null). Ahora queda en el
                    // log con las claves (nunca valores) para diagnosticar
                    // rechazos de formato.
                    append_auth_log(&format!(
                        "ipc sin token válido (ignorado), claves: {:?}, cuerpo: {}",
                        ipc_keys(body),
                        clip_ipc(body),
                    ));
                    let _ = overlay_tx.send(
                        "Respuesta del sniffer sin token válido: revisa logs/spotify-auth.log.".to_string(),
                    );
                    return;
                }
            };
            // Freno: el mismo token, una vez cada 10 s como mucho.
            let attempt = throttle
                .lock()
                .map(|mut th| th.should_try(&token.access_token, now_ms()))
                .unwrap_or(true);
            if !attempt {
                return;
            }
            let masked = format!(
                "{}…({}) vía {}",
                token.access_token.chars().take(4).collect::<String>(),
                token.access_token.len(),
                token.source.as_deref().unwrap_or("?"),
            );
            match post_token_capture(api_port, &token) {
                Ok(_) => {
                    append_auth_log(&format!("token guardado ({masked}), cerrando (exit 0)"));
                    eprintln!("[spotify-auth] token guardado, cerrando");
                    // Éxito = salir SIEMPRE: el sniffer ya mostró "cerrando".
                    std::process::exit(EXIT_OK);
                }
                Err(e) => {
                    append_auth_log(&format!("token-capture falló ({masked}): {e}"));
                    eprintln!("[spotify-auth] token-capture falló: {e} (reintento con backoff)");
                    let _ = overlay_tx.send(format!(
                        "Error guardando token (daemon): {e}. Reintentando…"
                    ));
                }
            }
        })
        .build(&window)
        .unwrap_or_else(|e| {
            append_auth_log(&format!("no se pudo crear la webview: {e}"));
            eprintln!("[spotify-auth] no se pudo crear la webview: {e}");
            std::process::exit(EXIT_SETUP_FAILED);
        });

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(500));
        match event {
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) => {
                // Aplica los mensajes de overlay pendientes (fallos de POST).
                for msg in overlay_rx.try_iter() {
                    let script = format!(
                        "try{{var el=document.getElementById('__ld-spotify-status');if(el)el.textContent='BunDeck Spotify: {m}';}}catch(e){{}}",
                        m = js_string(&msg),
                    );
                    if let Err(e) = webview.evaluate_script(&script) {
                        eprintln!("[spotify-auth] overlay no actualizable: {e}");
                    }
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                append_auth_log("ventana cerrada por el usuario");
                eprintln!("[spotify-auth] ventana cerrada por el usuario");
                std::process::exit(EXIT_USER_CLOSED);
            }
            _ => {}
        }
    });
}
