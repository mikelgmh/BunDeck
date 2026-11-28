//! `bundeck-spotify-auth` — ventana de login de Spotify controlada por la app.
//!
//! Uso: `bundeck-spotify-auth [--api-port 3001] [--timeout-secs 600]`
//!
//! Abre el Web Player oficial en una webview propia, inyecta el sniffer
//! (`spotify_auth::build_sniffer_js`) y publica el token por IPC →
//! `token-capture` del daemon. Códigos de salida:
//! - `0`: token capturado y guardado (la ventana se cierra sola).
//! - `1`: el usuario cerró la ventana (el pending caduca solo por TTL).
//! - `2`: timeout sin token (el daemon limpia el pending por TTL).

mod spotify_auth;

use spotify_auth::{
    SPOTIFY_WEB_PLAYER_URL, build_sniffer_js, parse_ipc_token, post_token_capture,
    resolve_api_port, resolve_timeout_secs,
};
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let api_port = resolve_api_port(&args);
    let timeout_secs = resolve_timeout_secs(&args);

    // Watchdog: sin token en N segundos, salir para no colgar el login.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(timeout_secs));
        eprintln!("[spotify-auth] timeout sin token ({timeout_secs}s)");
        std::process::exit(2);
    });

    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("Conectar con Spotify — BunDeck")
        .with_inner_size(LogicalSize::new(1024.0, 760.0))
        .build(&event_loop)
        .unwrap_or_else(|e| {
            eprintln!("[spotify-auth] no se pudo crear la ventana: {e}");
            std::process::exit(3);
        });

    let _webview = WebViewBuilder::new()
        .with_url(SPOTIFY_WEB_PLAYER_URL)
        .with_initialization_script(&build_sniffer_js())
        .with_ipc_handler(move |req| {
            let body = req.body();
            match parse_ipc_token(body) {
                Some(token) => match post_token_capture(api_port, &token) {
                    Ok(_) => {
                        eprintln!("[spotify-auth] token guardado, cerrando");
                        std::process::exit(0);
                    }
                    Err(e) => eprintln!("[spotify-auth] token-capture falló: {e} (reintento)"),
                },
                None => eprintln!("[spotify-auth] IPC sin token válido (ignorado)"),
            }
        })
        .build(&window)
        .unwrap_or_else(|e| {
            eprintln!("[spotify-auth] no se pudo crear la webview: {e}");
            std::process::exit(3);
        });

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            eprintln!("[spotify-auth] ventana cerrada por el usuario");
            std::process::exit(1);
        }
    });
}
