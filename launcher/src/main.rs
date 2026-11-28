//! BunDeck launcher — ventanita de estado (Rust + GPUI).
//!
//! Sin rastro de terminal en release (`windows_subsystem = "windows"`;
//! en dev se conserva la consola para los logs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! - Al abrir: intenta que el daemon esté corriendo (espejo de
//!   `spawnDaemon()` en `src/bun/index.ts`), luego sondea cada 2s:
//!   API :3001 (/health), WS :3003 (TCP), Frontend :3002 o :4321 (HEAD /).
//! - Botones: Abrir panel (navegador), Iniciar/Detener/Reiniciar y ocultar
//!   la ventana al tray. "Salir" solo está en el menú del tray.
//!   Si Spotify pide login (POST /api/v1/plugins/spotify/login-request
//!   desde cualquier UI, incluida la remota por túnel), abre la ventana de
//!   login controlada por la app (`bundeck-spotify-auth`, webview con
//!   sniffer que captura el token solo) una vez y avisa en el panel hasta
//!   que se complete o se descarte (ver `monitor::spotify_login_pending`).
//! - Estilo: tokens de `theme.rs`, espejo manual del tema bundeck
//!   (`web/src/styles/bundeck.css`, dark + acento amarillo).
//! - Ventana sin marco nativo (`appears_transparent`): la barra de
//!   título es propia (arrastre, minimizar, maximizar/restaurar, cerrar),
//!   al estilo de `web/src/components/bundeck/TitleBar.vue`.
//!
//! - El icono de bandeja (system tray) es propiedad del launcher
//!   (ver `tray.rs`, solo Windows): al hacer clic se abre esta ventana.
//!   Cerrar la ventana NO cierra la app (ni la manda a ningún sitio
//!   distinto: la ventana simplemente se oculta): una ventana ancla
//!   invisible mantiene vivo el proceso para que el tray siga
//!   respondiendo. Solo "Salir" del menú del tray termina el proceso.
//!   El menú del tray ofrece Abrir panel (esta
//!   ventana GPUI), Abrir en la web (navegador) y Salir.

mod monitor;
mod autostart;
mod instance;
mod shortcuts;
mod strings;
mod theme;
mod tray;
pub mod updater;

use gpui::{
    div, img, prelude::*, px, relative, size, App, Application, Bounds, Context, FontWeight,
    SharedString, WindowBounds, WindowOptions,
};
use std::fs::OpenOptions;
use std::io::Write;
#[cfg(windows)]
use gpui::{AnyWindowHandle, MouseButton, Window, WindowKind};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
#[cfg(windows)]
use std::{cell::RefCell, rc::Rc};

use monitor::{LatestRelease, Snapshot, State};
#[cfg(windows)]
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
#[cfg(windows)]
use tray::{TrayCtl, TrayEvent};
#[cfg(windows)]
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
#[cfg(windows)]
use windows::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    IsZoomed, MessageBoxW, SendMessageW, ShowWindowAsync, HTCAPTION, ICON_BIG, ICON_SMALL,
    IDYES, MB_ICONQUESTION, MB_SETFOREGROUND, MB_YESNO, SW_MAXIMIZE, SW_RESTORE,
    WM_NCLBUTTONDOWN, WM_SETICON,
};

fn auto_updates_enabled() -> bool {
    std::env::var("DEV_MODE").as_deref() != Ok("true")
}

fn launcher_version() -> Option<String> {
    option_env!("BUNDECK_VERSION")
        .filter(|version| !version.trim().is_empty())
        .map(str::to_string)
}

/// Persist updater events: release builds have no console and the in-memory
/// UI log disappears when the launcher is replaced and restarted.
fn persist_update_log(message: &str) {
    let path = updater::user_data_dir().join("launcher-update.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or_default();
        let _ = writeln!(file, "{now} {message}");
    }
}

/// Use the older of the launcher and daemon versions so a partially updated
/// installation still receives the complete release bundle.
fn oldest_component_version(daemon: &str) -> String {
    match launcher_version() {
        Some(launcher) if updater::is_newer(&launcher, daemon) => launcher,
        _ => daemon.to_string(),
    }
}

// ---- Pestaña Ajustes: I/O contra el daemon (siempre en hilo de fondo) ----

/// Ajustes leídos del daemon; todo `None` = API caída (manda la caché).
struct RemoteSettings {
    lang: Option<String>,
    autostart: Option<bool>,
    start_minimized: Option<bool>,
}

fn settings_agent() -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_millis(1500)))
            .timeout_per_read(Some(Duration::from_millis(1500)))
            .timeout_per_write(Some(Duration::from_millis(1500)))
            .build(),
    )
}

fn get_daemon_setting(agent: &ureq::Agent, key: &str) -> Option<String> {
    let url = format!(
        "http://127.0.0.1:{}/api/v1/settings?key={key}",
        monitor::api_port()
    );
    let mut body = agent.get(&url).call().ok()?;
    let v: serde_json::Value = body.body_mut().read_json().ok()?;
    v.get("value")?.as_str().map(str::to_string)
}

fn fetch_remote_settings() -> RemoteSettings {
    let agent = settings_agent();
    let lang = get_daemon_setting(&agent, "ui.language")
        .and_then(|raw| strings::Lang::from_code(raw.trim()).map(|l| l.code().to_string()));
    let autostart =
        get_daemon_setting(&agent, autostart::AUTOSTART_KEY).map(|raw| autostart::parse_setting(&raw));
    let start_minimized = get_daemon_setting(&agent, autostart::START_MINIMIZED_KEY)
        .map(|raw| autostart::parse_start_minimized(&raw));
    RemoteSettings {
        lang,
        autostart,
        start_minimized,
    }
}

fn post_daemon_setting(key: &str, value: &str) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/api/v1/settings", monitor::api_port());
    let body = settings_agent()
        .post(&url)
        .header("Content-Type", "application/json")
        .send_json(serde_json::json!({ "key": key, "value": value }))
        .map_err(|e| e.to_string())?;
    if body.status().is_success() {
        Ok(())
    } else {
        Err(format!("HTTP {}", body.status().as_u16()))
    }
}

#[cfg(windows)]
fn acquire_single_instance(interactive: bool) -> Option<instance::InstanceLock> {
    let lock = match instance::InstanceLock::acquire() {
        Ok(lock) => lock,
        Err(error) => {
            if interactive {
                let text_wide = strings::wide_format("dlg.check_fail", &[("error", &error.to_string())]);
                let caption = strings::wide("dlg.app_title");
                unsafe {
                    let _ = MessageBoxW(
                        None,
                        windows::core::PCWSTR(text_wide.as_ptr()),
                        windows::core::PCWSTR(caption.as_ptr()),
                        windows::Win32::UI::WindowsAndMessaging::MB_ICONERROR
                            | MB_SETFOREGROUND,
                    );
                }
            } else {
                eprintln!("[launcher] no se pudo comprobar la instancia: {error}");
            }
            return None;
        }
    };
    if lock.is_owner() {
        return Some(lock);
    }

    let Some(existing) = lock.existing_instance().cloned() else {
        // Sin metadata legible no se puede matar nada con seguridad: el mutex
        // puede estar en manos de un arranque a medias (p. ej. el helper del
        // self-update acaba de relanzar). Espera breve y reintenta antes de
        // rendirse, sin taskkill a ciegas.
        persist_update_log("Lock ocupado sin metadata legible; esperando al dueño real.");
        drop(lock);
        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(200));
            match instance::InstanceLock::acquire() {
                Ok(next) if next.is_owner() => return Some(next),
                Ok(next) => drop(next),
                Err(_) => {}
            }
        }
        show_instance_message(strings::get("dlg.meta_unreadable"), false, interactive);
        return None;
    };
    // La metadata puede ser stale (PID muerto o reutilizado por otro
    // programa): nunca taskkill sin comprobar vida + que sea launcher.
    if !instance::is_process_alive(existing.pid) {
        persist_update_log(&format!(
            "Metadata stale: PID {} no vivo; esperando liberación del mutex.",
            existing.pid
        ));
        drop(lock);
        for _ in 0..30 {
            std::thread::sleep(Duration::from_millis(200));
            match instance::InstanceLock::acquire() {
                Ok(next) if next.is_owner() => return Some(next),
                Ok(next) => drop(next),
                Err(_) => {}
            }
        }
        show_instance_message(strings::get("dlg.meta_stale"), false, interactive);
        return None;
    }
    if existing.pid == std::process::id() || !is_launcher_process(existing.pid) {
        persist_update_log(&format!(
            "Rechazado reemplazar PID {}: no parece launcher BunDeck.",
            existing.pid
        ));
        show_instance_message(strings::get("dlg.not_launcher"), false, interactive);
        return None;
    }
    let question = strings::format(
        "dlg.replace_ask",
        &[
            ("mode", existing.mode.as_str()),
            ("pid", &existing.pid.to_string()),
        ],
    );
    if !show_instance_message(&question, true, interactive) {
        return None;
    }

    persist_update_log(&format!(
        "El usuario confirmó reemplazar la instancia PID {} ({})",
        existing.pid,
        existing.mode.as_str()
    ));
    // Best-effort: pedir al daemon que cierre limpio antes de terminar el
    // launcher. La confirmación explícita autoriza el fallback a taskkill.
    // OJO: sin /T a propósito — /T mataba también al daemon recién
    // actualizado (el Restart del update lo quiere conservar).
    let _ = monitor::shutdown_daemon();
    if !terminate_existing_instance(existing.pid, false) {
        show_instance_message(strings::get("dlg.could_not_close"), false, interactive);
        return None;
    }
    drop(lock);

    for _ in 0..60 {
        match instance::InstanceLock::acquire() {
            Ok(next) if next.is_owner() => return Some(next),
            Ok(next) => drop(next),
            Err(_) => {}
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    show_instance_message(strings::get("dlg.lock_timeout"), false, interactive);
    None
}

#[cfg(windows)]
fn show_instance_message(text: &str, ask_yes_no: bool, interactive: bool) -> bool {
    if !interactive {
        // Arranque minimizado: sin diálogos modales (log + salida silenciosa).
        eprintln!("[launcher] {text}");
        return false;
    }
    let text_wide: Vec<u16> = text.encode_utf16().chain([0]).collect();
    let caption_yes_no = strings::wide("dlg.already_open");
    let caption_info = strings::wide("dlg.app_title");
    let (style, caption) = if ask_yes_no {
        (
            MB_YESNO | MB_ICONQUESTION | MB_SETFOREGROUND,
            windows::core::PCWSTR(caption_yes_no.as_ptr()),
        )
    } else {
        (
            windows::Win32::UI::WindowsAndMessaging::MB_ICONWARNING | MB_SETFOREGROUND,
            windows::core::PCWSTR(caption_info.as_ptr()),
        )
    };
    let result = unsafe {
        MessageBoxW(
            None,
            windows::core::PCWSTR(text_wide.as_ptr()),
            caption,
            style,
        )
    };
    !ask_yes_no || result == IDYES
}

#[cfg(windows)]
fn terminate_existing_instance(pid: u32, kill_tree: bool) -> bool {
    use std::os::windows::process::CommandExt;
    // Sin /T por defecto: /T mataba el árbol del launcher viejo, incluido el
    // daemon recién actualizado que el flujo Restart quiere conservar.
    // Solo Astro-dev (huerfano a propósito) usa kill_tree = true.
    let mut args = vec!["/PID".to_string(), pid.to_string(), "/F".to_string()];
    if kill_tree {
        args.push("/T".to_string());
    }
    std::process::Command::new("taskkill")
        .args(&args)
        .creation_flags(0x08000000)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// ¿El PID parece el panel launcher (no un PID reutilizado)? Comprueba la
/// línea de comandos: debe mencionar bundeck-launcher / libredeck-launcher.
#[cfg(windows)]
fn is_launcher_process(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    let filter = format!("ProcessId = {pid}");
    let script = format!(
        "$p=Get-CimInstance Win32_Process -Filter '{filter}'; \
         if ($p -and $p.CommandLine -match '(?i)bundeck-launcher|libredeck-launcher') {{ 'yes' }}"
    );
    std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &script,
        ])
        .creation_flags(0x08000000)
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim() == "yes")
        .unwrap_or(false)
}

#[cfg(windows)]
fn prepare_existing_server(interactive: bool) {
    let snapshot = monitor::snapshot(false);
    let api_up = snapshot.api.state == State::Ok;
    let is_dev = snapshot.frontend.state == State::Ok && snapshot.frontend.detail == ":4321";
    if !api_up && !is_dev {
        return;
    }

    let version = monitor::installed_version()
        .unwrap_or_else(|| strings::get("dlg.server_unavailable").to_string());
    let mode = if is_dev {
        strings::get("dlg.server_dev_mode")
    } else {
        strings::get("dlg.server_prod_mode")
    };
    let port_suffix = if api_up {
        strings::format(
            "dlg.server_active_port",
            &[("port", &monitor::api_port().to_string())],
        )
    } else {
        String::new()
    };
    let question = strings::format(
        "dlg.server_active",
        &[
            ("port", &port_suffix),
            ("version", &version),
            ("mode", mode),
        ],
    );
    if !show_instance_message(&question, true, interactive) {
        return;
    }

    if api_up {
        if !monitor::shutdown_daemon() {
            show_instance_message(strings::get("dlg.server_keep"), false, interactive);
            return;
        }
        monitor::wait_for_api_down();
        if monitor::snapshot(false).api.state == State::Ok {
            show_instance_message(strings::get("dlg.server_still_up"), false, interactive);
            return;
        }
    }

    if is_dev {
        let Some(pid) = process_listening_on(4321) else {
            show_instance_message(strings::get("dlg.dev_no_astro"), false, interactive);
            return;
        };
        if !is_bundeck_dev_process(pid) {
            show_instance_message(strings::get("dlg.dev_not_bundeck"), false, interactive);
            return;
        }
        if pid != std::process::id() && !terminate_existing_instance(pid, true) {
            show_instance_message(strings::get("dlg.dev_no_close"), false, interactive);
            return;
        }
    }
}

#[cfg(windows)]
fn is_bundeck_dev_process(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    let filter = format!("ProcessId = {pid}");
    let script = format!(
        "$p=Get-CimInstance Win32_Process -Filter '{filter}'; \
         if ($p -and $p.CommandLine -match '(?i)astro|bundeck|libredeck|daemon[\\\\/]+src[\\\\/]+server') {{ 'yes' }}"
    );
    std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &script,
        ])
        .creation_flags(0x08000000)
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim() == "yes")
        .unwrap_or(false)
}

#[cfg(windows)]
fn process_listening_on(port: u16) -> Option<u32> {
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .creation_flags(0x08000000)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let suffix = format!(":{port}");
    text.lines().find_map(|line| {
        let columns: Vec<_> = line.split_whitespace().collect();
        if columns.len() < 5
            || !columns[0].eq_ignore_ascii_case("TCP")
            || !columns[1].ends_with(&suffix)
            || !columns[3].eq_ignore_ascii_case("LISTENING")
        {
            return None;
        }
        columns[4].parse().ok()
    })
}

#[cfg(not(windows))]
fn acquire_single_instance(_interactive: bool) -> Option<instance::InstanceLock> {
    match instance::InstanceLock::acquire() {
        Ok(lock) if lock.is_owner() => Some(lock),
        Ok(_) => {
            eprintln!("[launcher] BunDeck ya está abierto; no iniciar otra instancia.");
            None
        }
        Err(error) => {
            eprintln!("[launcher] no se pudo comprobar la instancia: {error}");
            None
        }
    }
}

/// Canal hacia el bucle de eventos del tray (Windows): "Salir" pasa por
/// aquí para limpiar el icono antes de terminar el proceso.
#[cfg(windows)]
static TRAY_TX: std::sync::OnceLock<std::sync::mpsc::Sender<TrayEvent>> =
    std::sync::OnceLock::new();

/// Pestañas del panel: estado/acciones, ajustes y registro a pantalla completa.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tab {
    Status,
    Settings,
    Log,
}

struct LauncherView {
    snapshot: Snapshot,
    log: Vec<String>,
    polls: u32,
    /// Pestaña visible.
    tab: Tab,
    /// Versión que reporta el daemon (None si no responde).
    installed: Option<String>,
    /// Última release en GitHub (None hasta el primer chequeo con red).
    latest: Option<LatestRelease>,
    /// Chequeo de update gestionado (manifiesto): versión + asset verificado.
    update_check: Option<updater::UpdateCheck>,
    /// Progreso de descarga/staging (lo escribe el hilo de fondo).
    update_progress: Arc<Mutex<updater::UpdateProgress>>,
    /// Hay descarga/staging en curso (no lanzar dos).
    update_busy: bool,
    /// Aplicando la versión staged en el hilo de fondo (bloquea doble clic).
    update_applying: bool,
    /// Versión aplicada en esta sesión (para el botón de reinicio).
    last_applied: Option<String>,
    /// El stage traía launcher nuevo: hay que reiniciar este proceso.
    launcher_pending_restart: bool,
    /// El usuario pidió arrancar: el bucle reintenta hasta que la API suba.
    pending_start: bool,
    /// Pestaña Ajustes: idioma (`ui.language`, se aplica al momento).
    settings_lang: String,
    /// Pestaña Ajustes: `system.autostart` (interruptor del SO).
    settings_autostart: bool,
    /// Pestaña Ajustes: `system.start_minimized` (default ON).
    settings_minimized: bool,
    /// La última lectura vino de la caché local (daemon caído).
    settings_offline: bool,
    /// Nota de la última escritura (guardado / error).
    settings_note: Option<String>,
    /// PNG del logo para la cabecera (None = cuadrado ámbar de reserva).
    logo: Option<PathBuf>,
    /// Aviso persistente de Spotify: `requestedAt` ya atendido (navegador
    /// abierto en este equipo) pendiente de completar o descartar.
    spotify_notice: Option<String>,
    /// Todo el I/O queda fuera del hilo de la interfaz.
    background_tx: Sender<BackgroundEvent>,
    background_rx: Receiver<BackgroundEvent>,
    monitor_tx: Sender<MonitorCommand>,
    update_checking: bool,
    auto_update_initialized: bool,
    next_auto_update_check: Instant,
    restart_after_update: bool,
    /// Handoff al helper ya lanzado (no relanzar en cada tick de 250ms).
    restart_requested: bool,
    /// Último clic en la barra de título (doble clic = maximizar/restaurar).
    #[cfg(windows)]
    last_chrome_click: Option<Instant>,
}

enum MonitorCommand {
    Start,
    Stop,
    Restart,
}

enum BackgroundEvent {
    Monitor {
        snapshot: Snapshot,
        installed: Option<String>,
        boot: Vec<String>,
        pending_start: bool,
    },
    /// Preferencias de la pestaña Ajustes (hilo de fondo; `None` = la API
    /// no respondió para esa clave y manda la caché local).
    SettingsLoaded {
        lang: Option<String>,
        autostart: Option<bool>,
        start_minimized: Option<bool>,
    },
    /// Resultado de guardar un ajuste desde la pestaña Ajustes.
    SettingsSaved {
        ok: bool,
        detail: String,
    },
    /// El sondeo abrió el navegador para un login-request de Spotify.
    SpotifyLogin { requested_at: String },
    /// El login-request dejó de estar pendiente (completado o descartado).
    SpotifyLoginDone,
    Latest(Option<LatestRelease>),
    Log(String),
    UpdateCheck {
        installed: Option<String>,
        result: Result<Option<updater::UpdateCheck>, String>,
        latest_fallback: Option<LatestRelease>,
    },
}

impl LauncherView {
    /// Build the view without starting monitor or update workers. This keeps
    /// headless UI tests deterministic and isolated from local services.
    #[cfg(test)]
    fn new_for_test() -> Self {
        // Tests de UI herméticos: español fijo para no depender del
        // idioma efectivo del entorno (daemon/fichero/SO).
        strings::set_override(strings::Lang::Es);
        let (background_tx, background_rx) = mpsc::channel();
        let (monitor_tx, _monitor_rx) = mpsc::channel();

        Self {
            snapshot: Snapshot::initial(),
            log: vec!["Launcher iniciado.".to_string()],
            polls: 1,
            tab: Tab::Status,
            installed: None,
            latest: None,
            update_check: None,
            update_progress: Arc::new(Mutex::new(updater::UpdateProgress::default())),
            update_busy: false,
            update_applying: false,
            update_checking: false,
            auto_update_initialized: false,
            next_auto_update_check: Instant::now() + Duration::from_secs(6 * 60 * 60),
            restart_after_update: false,
            restart_requested: false,
            last_applied: None,
            launcher_pending_restart: false,
            pending_start: false,
            settings_lang: strings::effective().code().to_string(),
            settings_autostart: false,
            settings_minimized: true,
            settings_offline: false,
            settings_note: None,
            logo: None,
            spotify_notice: None,
            background_tx,
            background_rx,
            monitor_tx,
            #[cfg(windows)]
            last_chrome_click: None,
        }
    }

    fn new(cx: &mut Context<Self>) -> Self {
        let (background_tx, background_rx) = mpsc::channel();
        let (monitor_tx, monitor_rx) = mpsc::channel();
        start_monitor_thread(monitor_rx, background_tx.clone());
        let update_progress = Arc::new(Mutex::new(updater::UpdateProgress::default()));
        let pending_version = updater::pending_update_version();
        if let Some(version) = pending_version.as_deref() {
            if let Ok(mut progress) = update_progress.lock() {
                progress.done = true;
                progress.stage = format!("Lista la versión {version}");
                progress.staged_version = Some(version.to_string());
            }
        }
        let mut view = Self {
            snapshot: Snapshot::initial(),
            log: vec!["Launcher iniciado.".to_string()],
            polls: 1,
            tab: Tab::Status,
            installed: None,
            latest: pending_version.as_ref().map(|version| LatestRelease {
                tag: format!("v{version}"),
                url: format!("https://github.com/{}/releases/tag/v{version}", updater::GITHUB_REPO),
            }),
            update_check: None,
            update_progress,
            update_busy: false,
            update_applying: false,
            update_checking: false,
            auto_update_initialized: false,
            next_auto_update_check: Instant::now(),
            restart_after_update: false,
            restart_requested: false,
            last_applied: None,
            launcher_pending_restart: false,
            pending_start: false,
            // Estado inicial desde la caché local: si el daemon está caído,
            // la pestaña Ajustes muestra lo último guardado (no vacíos).
            settings_lang: strings::effective().code().to_string(),
            settings_autostart: autostart::load_cached_startup()
                .map(|p| p.autostart)
                .unwrap_or(false),
            settings_minimized: autostart::load_cached_startup()
                .map(|p| p.start_minimized)
                .unwrap_or(true),
            settings_offline: false,
            settings_note: None,
            logo: monitor::logo_path(),
            spotify_notice: None,
            background_tx,
            background_rx,
            monitor_tx,
            #[cfg(windows)]
            last_chrome_click: None,
        };
        // La lectura de ajustes vive en un hilo de fondo (patrón
        // `check_updates`): nunca bloquea el hilo de la interfaz.
        let settings_tx = view.background_tx.clone();
        std::thread::spawn(move || {
            let loaded = fetch_remote_settings();
            let _ = settings_tx.send(BackgroundEvent::SettingsLoaded {
                lang: loaded.lang,
                autostart: loaded.autostart,
                start_minimized: loaded.start_minimized,
            });
        });
        view.start_polling(cx);
        view
    }

    fn start_polling(&mut self, cx: &mut Context<Self>) {
        // Este loop solo drena resultados; el sondeo de red vive en un worker.
        let mut async_cx = cx.to_async();
        let foreground = async_cx.foreground_executor().clone();
        let this = cx.weak_entity();
        foreground
            .spawn(async move {
                loop {
                    async_cx
                        .background_executor()
                        .timer(Duration::from_millis(250))
                        .await;
                    // Si la vista se cerró, `update` falla: terminamos el
                    // bucle en vez de girar para siempre.
                    if this
                        .update(&mut async_cx, |view, cx| {
                            view.consume_background_events();
                            // El hilo de descarga escribe en update_progress;
                            // el sondeo lo vuelca al registro y libera busy.
                            let mut finished_msg: Option<String> = None;
                            let mut download_failed = false;
                            if view.update_busy {
                                if let Ok(p) = view.update_progress.lock() {
                                    if p.done {
                                        finished_msg = Some(format!(
                                            "Descarga lista: {}",
                                            p.staged_version
                                                .as_ref()
                                                .map(|v| format!("v{v}"))
                                                .unwrap_or_default()
                                        ));
                                    } else if let Some(e) = p.error.clone() {
                                        download_failed = true;
                                        finished_msg = Some(format!("Update falló: {e}"));
                                    }
                                }
                                if let Some(msg) = finished_msg {
                                    view.update_busy = false;
                                    persist_update_log(&msg);
                                    view.log.push(msg);
                                    if download_failed {
                                        if let Some(error) = view
                                            .update_progress
                                            .lock()
                                            .ok()
                                            .and_then(|p| p.error.clone())
                                        {
                                            persist_update_log(&format!(
                                                "Falló la descarga de la actualización: {error}"
                                            ));
                                        }
                                        view.next_auto_update_check =
                                            Instant::now() + Duration::from_secs(15 * 60);
                                    }
                                }
                            }
                            // El hilo de apply termina igual: recoge resultado.
                            if view.update_applying {
                                let (done, applied, apply_err, changed, alog) =
                                    if let Ok(p) = view.update_progress.lock() {
                                        (
                                            p.apply_done,
                                            p.applied_version.clone(),
                                            p.apply_error.clone(),
                                            p.launcher_changed,
                                            p.apply_log.clone(),
                                        )
                                    } else {
                                        (false, None, None, false, Vec::new())
                                    };
                                if done {
                                    view.update_applying = false;
                                    view.log.extend(alog);
                                    if let Some(v) = applied {
                                        view.log.push(format!("BunDeck {v} activo."));
                                        view.installed = Some(v.clone());
                                        view.last_applied = Some(v);
                                        view.update_check = None;
                                        if changed {
                                            view.launcher_pending_restart = true;
                                            let message =
                                                "La actualización está activa; reiniciando el launcher."
                                                    .to_string();
                                            persist_update_log(&message);
                                            view.log.push(message);
                                            if view.restart_after_update {
                                                // Idempotente: marcar antes de lanzar el helper para
                                                // que el siguiente tick (250ms) no relance otro.
                                                view.restart_after_update = false;
                                                let should_quit = view.restart_for_self_update();
                                                if should_quit {
                                                    restart_app_for_update(cx);
                                                }
                                            }
                                        } else {
                                            view.restart_after_update = false;
                                        }
                                        *view
                                            .update_progress
                                            .lock()
                                            .unwrap_or_else(|poison| poison.into_inner()) =
                                            updater::UpdateProgress::default();
                                    } else if let Some(e) = apply_err {
                                        view.restart_after_update = false;
                                        view.log.push(format!("No se pudo aplicar: {e}"));
                                        persist_update_log(&format!(
                                            "No se pudo aplicar la actualización: {e}"
                                        ));
                                        *view
                                            .update_progress
                                            .lock()
                                            .unwrap_or_else(|poison| poison.into_inner()) =
                                            updater::UpdateProgress {
                                                stage: "No se pudo instalar la actualización."
                                                    .to_string(),
                                                error: Some(e),
                                                ..Default::default()
                                            };
                                    }
                                }
                            }
                            // Una descarga verificada se aplica sin exigir un
                            // reinicio manual. Si también cambió el launcher,
                            // el helper lo sustituye y relanza con el tray.
                            if !view.update_busy
                                && !view.update_applying
                                && !view.launcher_pending_restart
                            {
                                if let Some(ver) = view.update_staged_version() {
                                    let message = format!(
                                        "Descarga de BunDeck {ver} lista; aplicando actualización."
                                    );
                                    view.log.push(message.clone());
                                    persist_update_log(&message);
                                    view.restart_after_update = true;
                                    view.finish_apply(&ver);
                                }
                            }
                            if view.auto_update_initialized
                                && auto_updates_enabled()
                                && !view.update_checking
                                && !view.update_busy
                                && !view.update_applying
                                && Instant::now() >= view.next_auto_update_check
                            {
                                view.check_updates();
                            }
                            view.truncate_log();
                            cx.notify();
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .detach();
    }

    fn truncate_log(&mut self) {
        // El registro vive en su propia pestaña: se guarda historial amplio.
        const MAX: usize = 200;
        if self.log.len() > MAX {
            let overflow = self.log.len() - MAX;
            self.log.drain(..overflow);
        }
    }

    /// Últimas líneas para la pestaña de registro.
    fn recent_log(&self, n: usize) -> String {
        let start = self.log.len().saturating_sub(n);
        self.log[start..].join("\n")
    }

    /// Botón Limpiar de la pestaña de registro.
    fn clear_log(&mut self) {
        self.log.clear();
        self.log.push("Registro limpiado.".to_string());
    }

    fn consume_background_events(&mut self) {
        while let Ok(event) = self.background_rx.try_recv() {
            match event {
                BackgroundEvent::Monitor {
                    snapshot,
                    installed,
                    boot,
                    pending_start,
                } => {
                    self.polls += 1;
                    self.snapshot = snapshot;
                    let daemon_is_up = installed.is_some();
                    if let Some(version) = installed {
                        if self.installed.as_deref() != Some(version.as_str()) {
                            self.log.push(format!("Daemon instalado: v{version}."));
                        }
                        self.installed = Some(version);
                    }
                    self.pending_start = pending_start;
                    self.log.extend(boot);
                    if daemon_is_up && !self.auto_update_initialized {
                        self.auto_update_initialized = true;
                        if auto_updates_enabled() {
                            self.check_updates();
                        }
                    }
                }
                BackgroundEvent::Latest(latest) => {
                    match &latest {
                        Some(release) => self.log.push(format!(
                            "Última release: {} ({})",
                            release.tag, release.url
                        )),
                        None => self.log.push(
                            "No se pudo consultar la última release (¿sin internet?).".to_string(),
                        ),
                    }
                    self.latest = latest;
                }
                BackgroundEvent::Log(message) => self.log.push(message),
                BackgroundEvent::SpotifyLogin { requested_at } => {
                    // El sondeo ya abrió la ventana de login para este
                    // login-request: avisar en el panel hasta que se complete
                    // o el usuario lo descarte.
                    if self.spotify_notice.as_deref() != Some(requested_at.as_str()) {
                        self.spotify_notice = Some(requested_at);
                        self.log.push(
                            "Spotify necesita conexión: se abrió la ventana de login en este equipo; inicia sesión y el acceso se completará solo.".to_string(),
                        );
                    }
                }
                BackgroundEvent::SpotifyLoginDone => {
                    if self.spotify_notice.take().is_some() {
                        self.log.push("Spotify conectado (o petición descartada).".to_string());
                    }
                }
                BackgroundEvent::UpdateCheck {
                    installed,
                    result,
                    latest_fallback,
                } => self.finish_update_check(installed, result, latest_fallback),
                BackgroundEvent::SettingsLoaded {
                    lang,
                    autostart,
                    start_minimized,
                } => {
                    if lang.is_none() && autostart.is_none() && start_minimized.is_none() {
                        // API caída: se mantienen los valores de la caché
                        // local (estado inicial de `new`) y se avisa.
                        self.settings_offline = true;
                    } else {
                        self.settings_offline = false;
                        if let Some(code) = lang {
                            self.settings_lang = code;
                        }
                        if let Some(on) = autostart {
                            self.settings_autostart = on;
                        }
                        if let Some(min) = start_minimized {
                            self.settings_minimized = min;
                        }
                    }
                }
                BackgroundEvent::SettingsSaved { ok, detail } => {
                    self.settings_note = Some(detail);
                    if !ok {
                        self.settings_offline = true;
                    }
                }
            }
        }
        self.truncate_log();
    }

    /// Botón Descartar del aviso de Spotify: borra el login-request en el
    /// daemon (best-effort) y oculta el aviso; el sondeo lo confirma en el
    /// siguiente ciclo.
    fn dismiss_spotify(&mut self) {
        self.spotify_notice = None;
        std::thread::spawn(|| {
            monitor::spotify_dismiss_login();
        });
        self.log.push("Aviso de Spotify descartado.".to_string());
        self.truncate_log();
    }

    /// Botón Reabrir del aviso de Spotify (por si se cerró la ventana de login).
    fn reopen_spotify(&mut self) {
        self.log.push("Abriendo ventana de login de Spotify …".to_string());
        if !monitor::open_spotify_auth_window() {
            self.log.push("No se pudo abrir la ventana de login.".to_string());
        }
        self.truncate_log();
    }

    /// Abre el panel en el navegador. Devuelve true si se pudo lanzar.
    fn open_dashboard(&mut self) -> bool {
        let url = self.snapshot.dashboard_url.clone();
        self.log.push(format!("Abriendo {url} …"));
        if let Err(e) = open::that(&url) {
            self.log.push(format!("No se pudo abrir el navegador: {e}"));
            self.truncate_log();
            return false;
        }
        self.truncate_log();
        true
    }

    /// Todo en línea: al abrir el panel la ventanita ya no aporta nada.
    fn ready_to_close(&self) -> bool {
        self.snapshot.api.state == State::Ok && self.snapshot.frontend.state == State::Ok
    }

    /// Botón Iniciar: marca arranque pendiente (el bucle spawnea/reintenta).
    fn start_daemon(&mut self) {
        if self.snapshot.api.state == State::Ok {
            self.log.push("El daemon ya está en línea.".to_string());
        } else {
            self.pending_start = true;
            let _ = self.monitor_tx.send(MonitorCommand::Start);
            self.log.push("Arranque solicitado: reintentando hasta que la API responda…".to_string());
        }
        self.truncate_log();
    }

    /// Botón Detener: orden de apagado al daemon (muere en ~2s).
    fn stop_daemon(&mut self) {
        self.pending_start = false;
        let _ = self.monitor_tx.send(MonitorCommand::Stop);
        self.log.push("Solicitando el apagado del daemon…".to_string());
        self.truncate_log();
    }

    /// Botón Reiniciar: apaga y marca arranque pendiente.
    fn restart_daemon(&mut self) {
        self.pending_start = true;
        let _ = self.monitor_tx.send(MonitorCommand::Restart);
        self.log.push("Reinicio solicitado: apagando y volviendo a arrancar…".to_string());
        self.truncate_log();
    }

    // ---- Pestaña Ajustes (POST en hilo de fondo + persist local) ----

    /// Idioma: POST `ui.language` al daemon; al guardar, se aplica al
    /// momento y se persiste en `launcher-lang` (ver `strings.rs`).
    fn set_settings_language(&mut self, code: &str) {
        let Some(lang) = strings::Lang::from_code(code) else {
            return;
        };
        self.settings_lang = lang.code().to_string();
        self.settings_note = None;
        let tx = self.background_tx.clone();
        let code = lang.code().to_string();
        std::thread::spawn(move || {
            let res = post_daemon_setting("ui.language", &code);
            match res {
                Ok(()) => {
                    strings::set_runtime(lang);
                    let _ = tx.send(BackgroundEvent::SettingsSaved {
                        ok: true,
                        detail: strings::get_in(lang, "set.saved").to_string(),
                    });
                }
                Err(e) => {
                    let _ = tx.send(BackgroundEvent::SettingsSaved {
                        ok: false,
                        detail: format!("{} ({e})", strings::get_in(lang, "set.save_failed")),
                    });
                }
            }
        });
        self.truncate_log();
    }

    /// Autostart: POST `system.autostart` + caché local (fallback del
    /// sondeo cuando la API no responde).
    fn toggle_settings_autostart(&mut self) {
        let next = !self.settings_autostart;
        self.settings_autostart = next;
        self.settings_note = None;
        let tx = self.background_tx.clone();
        std::thread::spawn(move || {
            let mut prefs = autostart::load_cached_startup()
                .unwrap_or(autostart::StartupPrefs::new(false, true));
            prefs.autostart = next;
            let res = post_daemon_setting(
                autostart::AUTOSTART_KEY,
                if next { "true" } else { "false" },
            );
            // La caché se actualiza igual: es el fallback del sondeo y de
            // esta misma pestaña cuando el daemon está caído.
            autostart::save_cached_startup(prefs);
            let _ = tx.send(BackgroundEvent::SettingsSaved {
                ok: res.is_ok(),
                detail: match res {
                    Ok(()) => strings::get("set.saved").to_string(),
                    Err(e) => format!("{} ({e})", strings::get("set.save_failed")),
                },
            });
        });
        self.truncate_log();
    }

    /// Iniciar minimizado: POST `system.start_minimized` + caché local.
    fn toggle_settings_minimized(&mut self) {
        let next = !self.settings_minimized;
        self.settings_minimized = next;
        self.settings_note = None;
        let tx = self.background_tx.clone();
        std::thread::spawn(move || {
            let mut prefs = autostart::load_cached_startup()
                .unwrap_or(autostart::StartupPrefs::new(false, true));
            prefs.start_minimized = next;
            let res = post_daemon_setting(
                autostart::START_MINIMIZED_KEY,
                if next { "true" } else { "false" },
            );
            autostart::save_cached_startup(prefs);
            let _ = tx.send(BackgroundEvent::SettingsSaved {
                ok: res.is_ok(),
                detail: match res {
                    Ok(()) => strings::get("set.saved").to_string(),
                    Err(e) => format!("{} ({e})", strings::get("set.save_failed")),
                },
            });
        });
        self.truncate_log();
    }

    /// Revisa el manifiesto oficial; al encontrar algo nuevo, descarga
    /// automáticamente sin bloquear el hilo de la interfaz.
    fn check_updates(&mut self) {
        if self.update_checking {
            return;
        }
        self.next_auto_update_check = Instant::now() + Duration::from_secs(6 * 60 * 60);
        self.update_checking = true;
        self.update_check = None;
        self.log.push("Buscando actualizaciones…".to_string());
        persist_update_log("Buscando actualizaciones.");
        let tx = self.background_tx.clone();
        std::thread::spawn(move || {
            let installed = monitor::installed_version();
            let result = match installed.as_deref() {
                Some(daemon_version) => {
                    updater::check_for_update(&oldest_component_version(daemon_version))
                }
                None => Err("daemon no responde con una versión instalada".to_string()),
            };
            let latest_fallback = result
                .as_ref()
                .err()
                .and_then(|_| monitor::latest_release());
            let _ = tx.send(BackgroundEvent::UpdateCheck {
                installed,
                result,
                latest_fallback,
            });
        });
        self.truncate_log();
    }

    fn finish_update_check(
        &mut self,
        installed: Option<String>,
        result: Result<Option<updater::UpdateCheck>, String>,
        latest_fallback: Option<LatestRelease>,
    ) {
        self.update_checking = false;
        if installed.is_some() {
            self.installed = installed;
        }
        match result {
            Ok(Some(check)) => {
                self.log.push(format!(
                    "Nueva versión: instalada v{} → {} (bundle {}, {:.1} MB).",
                    check.current,
                    check.latest,
                    check.asset.bundle,
                    check.asset.size as f64 / 1_048_576.0
                ));
                persist_update_log(&format!(
                    "Actualización detectada: {} -> {} ({})",
                    check.current, check.latest, check.asset.bundle
                ));
                if !check.manifest_signed {
                    self.log.push(
                        "Aviso: bundle sin firma (solo sha256).".to_string(),
                    );
                }
                self.latest = Some(LatestRelease {
                    tag: format!("v{}", check.latest),
                    url: check.notes_url.clone(),
                });
                // Resetea progreso anterior al haber nueva versión.
                if self
                    .update_check
                    .as_ref()
                    .map(|c| c.latest != check.latest)
                    .unwrap_or(true)
                {
                    *self
                        .update_progress
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner()) =
                        updater::UpdateProgress::default();
                }
                self.update_check = Some(check);
            }
            Ok(None) => {
                let current = self.installed.as_deref().unwrap_or("dev");
                self.log.push(format!("Estás al día (v{current})."));
                persist_update_log(&format!("Componentes al día (v{current})."));
                self.update_check = None;
                if self.update_staged_version().is_none() {
                    *self
                        .update_progress
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner()) =
                        updater::UpdateProgress::default();
                }
                self.latest = Some(LatestRelease {
                    tag: format!("v{current}"),
                    url: format!(
                        "https://github.com/{}/releases/latest",
                        updater::GITHUB_REPO
                    ),
                });
            }
            Err(e) => {
                self.next_auto_update_check = Instant::now() + Duration::from_secs(15 * 60);
                // Fallback informativo a latest_release clásico.
                self.latest = latest_fallback;
                if self.update_staged_version().is_none() {
                    let mut progress = self
                        .update_progress
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    progress.stage = "No se pudo verificar la actualización.".to_string();
                    progress.error = Some(format!("No se pudo comprobar el manifiesto: {e}"));
                }
                match (&self.installed, &self.latest) {
                    (Some(i), Some(l)) if monitor::is_newer(i, &l.tag) => {
                        self.log.push(format!(
                            "Manifiesto inaccesible ({e}); última release conocida: instalada v{i}, {}. Descarga manual desde {}",
                            l.tag, l.url
                        ))
                    }
                    (Some(i), Some(l)) => self.log.push(format!(
                        "No se pudo validar el manifiesto ({e}); instalada v{i}, release publicada {}.",
                        l.tag
                    )),
                    _ => self.log.push(format!("No se pudo completar el chequeo: {e}")),
                }
                persist_update_log(&format!("Falló el chequeo de actualizaciones: {e}"));
            }
        }
        if let Some(check) = self.update_check.clone() {
            if updater::staged_update_is_complete(&updater::install_root(), &check.latest) {
                match updater::mark_staged_update_pending(
                    &updater::install_root(),
                    &check.latest,
                ) {
                    Ok(()) => {
                        *self
                            .update_progress
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner()) = updater::UpdateProgress {
                            done: true,
                            stage: format!("Lista la versión {}", check.latest),
                            staged_version: Some(check.latest),
                            ..Default::default()
                        };
                    }
                    Err(e) => {
                        let mut progress = self
                            .update_progress
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner());
                        progress.error = Some(e);
                    }
                }
            } else {
                self.start_download(check);
            }
        }
        self.truncate_log();
    }

    /// ¿Hay actualización pendiente de aplicar?
    fn update_available(&self) -> bool {
        if self.launcher_pending_restart {
            return true;
        }
        if self.update_staged_version().is_some() {
            return true;
        }
        if let Some(c) = &self.update_check {
            return updater::is_newer(&c.current, &c.latest);
        }
        match (&self.installed, &self.latest) {
            (Some(i), Some(l)) => monitor::is_newer(i, &l.tag),
            _ => false,
        }
    }

    /// ¿Ya está descargada y lista para aplicar?
    fn update_staged_version(&self) -> Option<String> {
        self.update_progress
            .lock()
            .ok()
            .and_then(|p| p.staged_version.clone().filter(|_| p.done && p.error.is_none()))
    }

    /// Acción de reinicio: activa la versión descargada con backup +
    /// rollback y luego cambia el launcher vía `bundeck-updater`.
    /// Devuelve true si hay que cerrar la ventanita.
    fn apply_update(&mut self) -> bool {
        // 0) Reinicio pendiente para completar el self-update del launcher.
        if self.launcher_pending_restart {
            return self.restart_for_self_update();
        }
        if self.update_applying {
            return false;
        }
        // 1) Si ya hay stage listo: aplicar ahora (en fondo).
        if let Some(ver) = self.update_staged_version() {
            self.restart_after_update = true;
            self.finish_apply(&ver);
            return false;
        }
        // 2) Si hay descarga en curso: no duplicar, solo informar.
        if self.update_busy {
            self.log.push("Descarga en curso: espera a que termine.".to_string());
            self.truncate_log();
            return false;
        }
        // 3) Sin chequeo previo: buscar primero.
        let check = match self.update_check.clone() {
            Some(c) => c,
            None => {
                self.check_updates();
                return false;
            }
        };
        self.start_download(check);
        false
    }

    fn start_download(&mut self, check: updater::UpdateCheck) {
        if self.update_busy || self.update_applying {
            return;
        }
        // 4) Descarga en hilo de fondo (progreso vía Arc<Mutex>).
        self.update_busy = true;
        *self
            .update_progress
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = updater::UpdateProgress {
            stage: format!("Descargando {}…", check.asset.bundle),
            ..Default::default()
        };
        self.log.push(format!(
            "Descargando BunDeck {} ({} MB)…",
            check.latest,
            check.asset.size as f64 / 1_048_576.0
        ));
        self.truncate_log();
        let progress = self.update_progress.clone();
        std::thread::spawn(move || {
            match updater::download_and_stage(&check, &progress) {
                Ok(_) => {}
                Err(e) => {
                    if let Ok(mut p) = progress.lock() {
                        p.error = Some(e);
                        p.stage = "Error en la descarga.".to_string();
                    }
                }
            }
        });
    }

    /// Aplica una versión ya staged en un hilo de fondo: backup +
    /// shutdown + activar + health-check + rollback. El sondeo recoge el
    /// resultado y, si el launcher cambió, ofrece reiniciar vía helper.
    fn finish_apply(&mut self, ver: &str) {
        self.update_applying = true;
        monitor::UPDATE_IN_PROGRESS.store(true, std::sync::atomic::Ordering::SeqCst);
        self.log.push(format!("Aplicando BunDeck {ver}…"));
        self.truncate_log();
        if let Ok(mut p) = self.update_progress.lock() {
            p.stage = format!("Aplicando BunDeck {ver}…");
            p.apply_done = false;
            p.applied_version = None;
            p.apply_error = None;
            p.apply_log.clear();
        }
        let progress = self.update_progress.clone();
        let ver = ver.to_string();
        std::thread::spawn(move || {
            let mut lines: Vec<String> = Vec::new();
            let res = updater::apply_staged(&mut |s| lines.push(s), &ver);
            // Se libera aquí: a partir de ahora el monitor puede volver a
            // spawnear con la active.json ya cambiada.
            monitor::UPDATE_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
            let root = updater::install_root();
            if let Ok(mut p) = progress.lock() {
                p.apply_log = lines;
                match res {
                    Ok(()) => {
                        p.apply_done = true;
                        p.applied_version = Some(ver.clone());
                        p.launcher_changed = updater::staged_has_launcher(&root, &ver);
                        p.stage = format!("BunDeck {ver} activo.");
                    }
                    Err(e) => {
                        p.apply_done = true;
                        p.apply_error = Some(e);
                        p.stage = "No se pudo aplicar.".to_string();
                    }
                }
            }
        });
    }

    /// Reinicia el launcher vía helper (reemplaza el exe tras salir).
    /// Devuelve true cuando el proceso debe cerrarse.
    fn restart_for_self_update(&mut self) -> bool {
        let Some(ver) = self.last_applied.clone() else {
            return false;
        };
        // Un solo handoff por versión aplicada: el helper ya está en camino.
        if self.restart_requested {
            return true;
        }
        match updater::handoff_self_update(&ver) {
            Ok(()) => {
                self.restart_requested = true;
                self.log
                    .push("El launcher se actualizará al salir.".to_string());
                self.truncate_log();
                true
            }
            Err(e) => {
                self.log.push(format!(
                    "No se pudo lanzar el actualizador del launcher ({e}). \
                     Descarga la release desde {}/releases/latest y reinstala.",
                    format!("https://github.com/{}", updater::GITHUB_REPO)
                ));
                self.truncate_log();
                false
            }
        }
    }

    fn dot_color(state: State) -> gpui::Rgba {
        match state {
            State::Ok => theme::ok(),
            State::Starting => theme::warn(),
            State::Down => theme::danger(),
        }
    }
}

fn start_monitor_thread(
    commands: Receiver<MonitorCommand>,
    events: Sender<BackgroundEvent>,
) {
    std::thread::spawn(move || {
        let mut initial = true;
        let mut pending_start = false;
        // `requestedAt` del login-request de Spotify ya atendido (navegador
        // abierto): en memoria para no reabrir en cada sondeo.
        let mut spotify_served: Option<String> = None;

        loop {
            // Durante el apply del update el único que spawnea es el propio
            // apply (usa active.json ya cambiada). El monitor solo observa.
            let updating = monitor::UPDATE_IN_PROGRESS.load(std::sync::atomic::Ordering::SeqCst);
            let boot = if (initial || pending_start) && !updating {
                let (lines, was_spawned) = monitor::ensure_daemon_spawned();
                if initial {
                    pending_start = was_spawned;
                }
                lines
            } else {
                Vec::new()
            };

            let snapshot = monitor::snapshot(pending_start);
            if snapshot.api.state == State::Ok {
                pending_start = false;
            }
            // Autostart del SO según `system.autostart` del daemon (solo
            // actúa cuando el valor cambió; en DEV_MODE solo registra).
            // Ver autostart.rs y daemon/src/system-autostart.ts.
            crate::autostart::sync_from_daemon();
            let installed = monitor::installed_version();
            if events
                .send(BackgroundEvent::Monitor {
                    snapshot: snapshot.clone(),
                    installed,
                    boot,
                    pending_start,
                })
                .is_err()
            {
                return;
            }
            // Apertura bajo demanda de Spotify: cualquier UI (incluida la
            // remota por túnel) crea el login-request con POST; el launcher,
            // que siempre corre en el host en prod, abre la ventana de login
            // controlada por la app (`bundeck-spotify-auth`, webview con
            // sniffer de tokens) UNA vez por `requestedAt` cuando no hay
            // host Electrobun vivo. Con host vivo no se hace nada: el flujo
            // dev automático (su propio poll + BrowserWindow) sigue mandando.
            // Si el helper no está disponible, se recurre al navegador del
            // sistema (sin sniffer: el token no se captura solo).
            if snapshot.api.state == State::Ok {
                match monitor::spotify_login_pending() {
                    Some(requested_at) => {
                        let already = spotify_served.as_deref() == Some(requested_at.as_str());
                        if !already && !monitor::host_alive() {
                            if monitor::open_spotify_auth_window() {
                                spotify_served = Some(requested_at.clone());
                                if events
                                    .send(BackgroundEvent::SpotifyLogin { requested_at })
                                    .is_err()
                                {
                                    return;
                                }
                            } else if events
                                .send(BackgroundEvent::Log(
                                    "Spotify necesita conexión pero no se pudo abrir la ventana de login en este equipo.".to_string(),
                                ))
                                .is_err()
                            {
                                return;
                            }
                        }
                    }
                    None => {
                        if spotify_served.take().is_some() {
                            if events.send(BackgroundEvent::SpotifyLoginDone).is_err() {
                                return;
                            }
                        }
                    }
                }
            }

            if initial {
                let latest = monitor::latest_release();
                if events.send(BackgroundEvent::Latest(latest)).is_err() {
                    return;
                }
                initial = false;
            }

            match commands.recv_timeout(Duration::from_secs(2)) {
                Ok(MonitorCommand::Start) => pending_start = true,
                Ok(MonitorCommand::Stop) => {
                    pending_start = false;
                    let message = if monitor::shutdown_daemon() {
                        "Apagado solicitado (el daemon se detendrá en breve)."
                    } else {
                        "No se pudo pedir el apagado: ¿ya está detenido?"
                    };
                    if events.send(BackgroundEvent::Log(message.to_string())).is_err() {
                        return;
                    }
                }
                Ok(MonitorCommand::Restart) => {
                    let stopped = monitor::shutdown_daemon();
                    if stopped {
                        monitor::wait_for_api_down();
                    }
                    pending_start = true;
                    let message = if stopped {
                        "Reinicio solicitado: apagando y volviendo a arrancar…"
                    } else {
                        "No respondía al apagado: intentando arranque directo…"
                    };
                    if events.send(BackgroundEvent::Log(message.to_string())).is_err() {
                        return;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    });
}

/// Etiqueta de sección en mayúsculas apagadas (estilo XAMPP por bloques).
fn section_label(text: &str) -> impl IntoElement {
    div()
        .text_xs()
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(theme::secondary_text())
        .child(text.to_string())
}

/// Fila de ajuste con interruptor (pestaña Ajustes): título + pista a la
/// izquierda, pastilla Activado/Desactivado a la derecha (toda la fila
/// alterna al hacer clic).
fn settings_switch_row(
    id: &'static str,
    title: &str,
    hint: &str,
    on: bool,
    on_toggle: impl Fn(&gpui::ClickEvent, &mut gpui::Window, &mut gpui::App) + 'static,
) -> impl IntoElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_3()
        .p_3()
        .rounded_xl()
        .bg(theme::surface())
        .border_1()
        .border_color(theme::line())
        .child(
            div()
                .flex()
                .flex_col()
                .flex_1()
                .gap_1()
                .child(
                    div()
                        .text_sm()
                        .text_color(theme::primary_text())
                        .child(title.to_string()),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme::muted_text())
                        .child(hint.to_string()),
                ),
        )
        .child(
            div()
                .debug_selector(move || id.to_string())
                .id(id)
                .text_center()
                .text_sm()
                .px_3()
                .py_2()
                .rounded_lg()
                .border_1()
                .border_color(if on {
                    theme::accent()
                } else {
                    theme::line()
                })
                .text_color(if on {
                    theme::primary_text()
                } else {
                    theme::muted_text()
                })
                .cursor_pointer()
                .hover(|s| s.border_color(theme::secondary_text()))
                .on_click(on_toggle)
                .child(
                    if on {
                        strings::get("set.on")
                    } else {
                        strings::get("set.off")
                    }
                    .to_string(),
                ),
        )
}

fn service_row(name: &str, snap: &monitor::ServiceSnapshot) -> impl IntoElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_3()
        .px_3()
        .py_2()
        .rounded_xl()
        .bg(theme::surface())
        .border_1()
        .border_color(theme::line())
        .child(
            div()
                .size(px(10.0))
                .rounded_full()
                .bg(LauncherView::dot_color(snap.state)),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .flex_1()
                .child(
                    div()
                        .text_sm()
                        .text_color(theme::primary_text())
                        .child(name.to_string()),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme::muted_text())
                        .child(snap.detail.clone()),
                ),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme::secondary_text())
                .child(snap.state.label().to_string()),
        )
}

impl Render for LauncherView {
    fn render(&mut self, window: &mut gpui::Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tab = self.tab;
        let dashboard_url: SharedString = self.snapshot.dashboard_url.clone().into();
        let log_text: SharedString = self.recent_log(30).into();
        let installed_label = match &self.installed {
            Some(v) => format!("v{v}"),
            None => strings::get("common.unknown").to_string(),
        };
        let latest_label = match &self.latest {
            Some(r) => r.tag.clone(),
            None => "—".to_string(),
        };
        let update_available = self.update_available();
        let api_up = self.snapshot.api.state == State::Ok;
        // Snapshot del progreso (lo escribe el hilo de fondo).
        let (update_stage, update_frac, update_err, staged_ver) = self
            .update_progress
            .lock()
            .map(|p| {
                (
                    p.stage.clone(),
                    p.fraction(),
                    p.error.clone(),
                    p.staged_version.clone().filter(|_| p.done && p.error.is_none()),
                )
            })
            .unwrap_or_default();
        let update_busy = self.update_busy;
        let update_checking = self.update_checking;
        let update_applying = self.update_applying;
        let launcher_pending_restart = self.launcher_pending_restart;
        let update_ready = launcher_pending_restart;
        let update_btn_label = if launcher_pending_restart {
            strings::get("btn.restart_launcher")
        } else {
            ""
        };
        #[cfg(windows)]
        let maximized = is_maximized(window);
        #[cfg(not(windows))]
        let maximized = false;

        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(theme::ground())
            .text_color(theme::primary_text())
            // Borde de ventana sin marco (invisible a pantalla completa).
            .border_1()
            .border_color(if maximized {
                theme::ground()
            } else {
                theme::line()
            })
            // Barra de título propia (Windows; en otros SO va oculta).
            .child(title_chrome(self, window, cx))
            .child(
                div()
                    .id("main-scroll")
                    .flex()
                    .flex_col()
                    .gap_3()
                    .p_4()
                    .w_full()
                    .flex_1()
                    .overflow_y_scroll()
                    .bg(theme::ground())
                    .text_color(theme::primary_text())
                    // Cabecera
                    .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap_3()
                            .child(if let Some(path) = self.logo.clone() {
                                img(path).size(px(28.0)).into_any_element()
                            } else {
                                div()
                                    .size(px(28.0))
                                    .rounded_lg()
                                    .bg(theme::accent())
                                    .into_any_element()
                            })
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap_1()
                                    .child(
                                        div()
                                            .text_lg()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(theme::primary_text())
                                            .child("BunDeck".to_string()),
                                    )
                                    .child(
                                        div()
                                            .text_sm()
                                            .text_color(theme::secondary_text())
                                            .child(strings::get("ui.subtitle").to_string()),
                                    ),
                            ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap_1()
                    .child(
                        div()
                            .debug_selector(|| "tab-status".to_string())
                            .id("tab-status")
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .px_3()
                            .py_2()
                            .border_b_2()
                            .border_color(if tab == Tab::Status {
                                theme::accent()
                            } else {
                                theme::transparent()
                            })
                            .text_color(if tab == Tab::Status {
                                theme::primary_text()
                            } else {
                                theme::muted_text()
                            })
                            .cursor_pointer()
                            .hover(|s| s.bg(theme::raised()))
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.tab = Tab::Status;
                                cx.notify();
                            }))
                            .child(strings::get("tab.status").to_string()),
                    )
                    .child(
                        div()
                            .debug_selector(|| "tab-log".to_string())
                            .id("tab-log")
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .px_3()
                            .py_2()
                            .border_b_2()
                            .border_color(if tab == Tab::Log {
                                theme::accent()
                            } else {
                                theme::transparent()
                            })
                            .text_color(if tab == Tab::Log {
                                theme::primary_text()
                            } else {
                                theme::muted_text()
                            })
                            .cursor_pointer()
                            .hover(|s| s.bg(theme::raised()))
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.tab = Tab::Log;
                                cx.notify();
                            }))
                            .child(strings::get("tab.log").to_string()),
                    )
                    .child(
                        div()
                            .debug_selector(|| "tab-settings".to_string())
                            .id("tab-settings")
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .px_3()
                            .py_2()
                            .border_b_2()
                            .border_color(if tab == Tab::Settings {
                                theme::accent()
                            } else {
                                theme::transparent()
                            })
                            .text_color(if tab == Tab::Settings {
                                theme::primary_text()
                            } else {
                                theme::muted_text()
                            })
                            .cursor_pointer()
                            .hover(|s| s.bg(theme::raised()))
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.tab = Tab::Settings;
                                cx.notify();
                            }))
                            .child(strings::get("tab.settings").to_string()),
                    ),
            )
            .child(if tab == Tab::Status {
                section_label(strings::get("sec.services")).into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Status {
                service_row(strings::get("svc.api"), &self.snapshot.api).into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Status {
                service_row(strings::get("svc.ws"), &self.snapshot.ws).into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Status {
                service_row(strings::get("svc.frontend"), &self.snapshot.frontend).into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Status {
                section_label(strings::get("sec.daemon")).into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Status {
                div()
                    .flex()
                    .flex_row()
                    .gap_2()
                    .child(
                        div()
                            .debug_selector(|| "daemon-start".to_string())
                            .id("daemon-start")
                            .flex_1()
                            .text_center()
                            .text_sm()
                            .px_3()
                            .py_2()
                            .rounded_lg()
                            .bg(theme::surface())
                            .border_1()
                            .border_color(theme::line())
                            .text_color(if api_up {
                                theme::muted_text()
                            } else {
                                theme::primary_text()
                            })
                            .cursor_pointer()
                            .hover(|s| s.border_color(theme::secondary_text()))
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.start_daemon();
                                cx.notify();
                            }))
                            .child(strings::get("btn.start").to_string()),
                    )
                    .child(
                        div()
                            .id("daemon-stop")
                            .flex_1()
                            .text_center()
                            .text_sm()
                            .px_3()
                            .py_2()
                            .rounded_lg()
                            .bg(theme::surface())
                            .border_1()
                            .border_color(theme::line())
                            .text_color(if api_up {
                                theme::danger()
                            } else {
                                theme::muted_text()
                            })
                            .cursor_pointer()
                            .hover(|s| s.border_color(theme::secondary_text()))
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.stop_daemon();
                                cx.notify();
                            }))
                            .child(strings::get("btn.stop").to_string()),
                    )
                    .child(
                        div()
                            .id("daemon-restart")
                            .flex_1()
                            .text_center()
                            .text_sm()
                            .px_3()
                            .py_2()
                            .rounded_lg()
                            .bg(theme::surface())
                            .border_1()
                            .border_color(theme::line())
                            .text_color(theme::primary_text())
                            .cursor_pointer()
                            .hover(|s| s.border_color(theme::secondary_text()))
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.restart_daemon();
                                cx.notify();
                            }))
                            .child(strings::get("btn.restart").to_string()),
                    )
                    .into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Status {
                section_label(strings::get("sec.updates")).into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Status {
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .p_3()
                    .rounded_xl()
                    .bg(theme::surface())
                    .border_1()
                    .border_color(theme::line())
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme::primary_text())
                            .child(strings::format(
                                "update.installed",
                                &[("installed", &installed_label), ("latest", &latest_label)],
                            )),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(if update_err.is_some() {
                                theme::danger()
                            } else {
                                theme::secondary_text()
                            })
                            .child(if launcher_pending_restart {
                                strings::get("update.applied_restart").to_string()
                            } else if update_applying {
                                strings::get("update.applying").to_string()
                            } else if let Some(version) = staged_ver.as_deref() {
                                strings::format("update.downloaded", &[("version", version)])
                            } else if update_busy {
                                strings::get("update.downloading_bg").to_string()
                            } else if update_checking {
                                strings::get("update.checking_auto").to_string()
                            } else if update_err.is_some() {
                                update_err.clone().unwrap_or_default()
                            } else if update_available {
                                strings::get("update.new_detected").to_string()
                            } else {
                                strings::get("update.auto").to_string()
                            })
                            .into_any_element(),
                    )
                    // Etapa / progreso de la actualización en curso.
                    .child(if update_busy {
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme::secondary_text())
                                    .child(update_stage.clone()),
                            )
                            .child(if let Some(f) = update_frac {
                                div()
                                    .h(px(6.0))
                                    .w_full()
                                    .rounded_full()
                                    .bg(theme::line())
                                    .child(
                                        div()
                                            .h(px(6.0))
                                            .rounded_full()
                                            .bg(theme::accent())
                                            .w(relative(f.clamp(0.0, 1.0)))
                                            .into_any_element(),
                                    )
                                    .into_any_element()
                            } else {
                                div().hidden().into_any_element()
                            })
                            .into_any_element()
                    } else {
                        div().hidden().into_any_element()
                    })
                    .child(
                        if update_ready {
                            div()
                                .debug_selector(|| "restart-update".to_string())
                                .id("restart-update")
                                .flex_1()
                                .text_center()
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .px_3()
                                .py_2()
                                .rounded_lg()
                                .bg(theme::primary_btn_bg())
                                .text_color(theme::primary_btn_text())
                                .cursor_pointer()
                                .hover(|s| s.bg(theme::primary_btn_hover()))
                                .on_click(cx.listener(|view, _, _, cx| {
                                    if view.apply_update() {
                                        quit_app(cx);
                                    } else {
                                        cx.notify();
                                    }
                                }))
                                .child(update_btn_label.to_string())
                                .into_any_element()
                        } else {
                            div().hidden().into_any_element()
                        }
                    )
                    .into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Status {
                if self.spotify_notice.is_none() {
                    div().hidden().into_any_element()
                } else {
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .p_3()
                        .rounded_xl()
                        .bg(theme::surface())
                        .border_1()
                        .border_color(theme::accent())
                        .child(
                            div()
                                .text_sm()
                                .text_color(theme::primary_text())
                                .child(strings::get("spotify.notice").to_string()),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .gap_2()
                                .child(
                                    div()
                                        .id("spotify-reopen")
                                        .flex_1()
                                        .text_center()
                                        .text_sm()
                                        .px_3()
                                        .py_2()
                                        .rounded_lg()
                                        .bg(theme::surface())
                                        .border_1()
                                        .border_color(theme::line())
                                        .text_color(theme::primary_text())
                                        .cursor_pointer()
                                        .hover(|s| s.border_color(theme::secondary_text()))
                                        .on_click(cx.listener(|view, _, _, cx| {
                                            view.reopen_spotify();
                                            cx.notify();
                                        }))
                                        .child(strings::get("btn.reopen_spotify").to_string()),
                                )
                                .child(
                                    div()
                                        .id("spotify-dismiss")
                                        .flex_1()
                                        .text_center()
                                        .text_sm()
                                        .px_3()
                                        .py_2()
                                        .rounded_lg()
                                        .bg(theme::surface())
                                        .border_1()
                                        .border_color(theme::line())
                                        .text_color(theme::muted_text())
                                        .cursor_pointer()
                                        .hover(|s| s.border_color(theme::secondary_text()))
                                        .on_click(cx.listener(|view, _, _, cx| {
                                            view.dismiss_spotify();
                                            cx.notify();
                                        }))
                                        .child(strings::get("btn.dismiss").to_string()),
                                )
                                .into_any_element(),
                        )
                        .into_any_element()
                }
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Status {
                section_label(strings::get("sec.open")).into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Status {
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(
                        div()
                            .id("open-dashboard")
                            .w_full()
                            .text_center()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .px_3()
                            .py_2()
                            .rounded_lg()
                            .bg(theme::primary_btn_bg())
                            .text_color(theme::primary_btn_text())
                            .cursor_pointer()
                            .hover(|s| s.bg(theme::primary_btn_hover()))
                            .on_click(cx.listener(|view, _, window, cx| {
                                if view.open_dashboard() {
                                    if view.ready_to_close() {
                                        // Se cierra la ventana, el tray sigue vivo.
                                        window.remove_window();
                                    } else {
                                        view.log.push(
                                            strings::get("dash.still_starting").to_string(),
                                        );
                                        view.truncate_log();
                                        cx.notify();
                                    }
                                } else {
                                    cx.notify();
                                }
                            }))
                            .child(strings::get("btn.dashboard").to_string()),
                    )
                    .into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Settings {
                section_label(strings::get("sec.settings")).into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Settings {
                let lang_es = self.settings_lang == "es";
                let lang_en = self.settings_lang == "en";
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .p_3()
                    .rounded_xl()
                    .bg(theme::surface())
                    .border_1()
                    .border_color(theme::line())
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme::primary_text())
                            .child(strings::get("set.language").to_string()),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme::muted_text())
                            .child(strings::get("set.language_hint").to_string()),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .gap_2()
                            .child(
                                div()
                                    .debug_selector(|| "set-lang-es".to_string())
                                    .id("set-lang-es")
                                    .flex_1()
                                    .text_center()
                                    .text_sm()
                                    .px_3()
                                    .py_2()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(if lang_es {
                                        theme::accent()
                                    } else {
                                        theme::line()
                                    })
                                    .text_color(if lang_es {
                                        theme::primary_text()
                                    } else {
                                        theme::muted_text()
                                    })
                                    .cursor_pointer()
                                    .hover(|s| s.border_color(theme::secondary_text()))
                                    .on_click(cx.listener(|view, _, _, cx| {
                                        view.set_settings_language("es");
                                        cx.notify();
                                    }))
                                    .child(strings::get("set.opt_es").to_string()),
                            )
                            .child(
                                div()
                                    .debug_selector(|| "set-lang-en".to_string())
                                    .id("set-lang-en")
                                    .flex_1()
                                    .text_center()
                                    .text_sm()
                                    .px_3()
                                    .py_2()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(if lang_en {
                                        theme::accent()
                                    } else {
                                        theme::line()
                                    })
                                    .text_color(if lang_en {
                                        theme::primary_text()
                                    } else {
                                        theme::muted_text()
                                    })
                                    .cursor_pointer()
                                    .hover(|s| s.border_color(theme::secondary_text()))
                                    .on_click(cx.listener(|view, _, _, cx| {
                                        view.set_settings_language("en");
                                        cx.notify();
                                    }))
                                    .child(strings::get("set.opt_en").to_string()),
                            )
                            .into_any_element(),
                    )
                    .into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Settings {
                settings_switch_row(
                    "set-autostart",
                    strings::get("set.autostart"),
                    strings::get("set.autostart_hint"),
                    self.settings_autostart,
                    cx.listener(|view, _, _, cx| {
                        view.toggle_settings_autostart();
                        cx.notify();
                    }),
                )
                .into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Settings {
                settings_switch_row(
                    "set-minimized",
                    strings::get("set.start_minimized"),
                    strings::get("set.start_minimized_hint"),
                    self.settings_minimized,
                    cx.listener(|view, _, _, cx| {
                        view.toggle_settings_minimized();
                        cx.notify();
                    }),
                )
                .into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Settings {
                let note = self.settings_note.clone().unwrap_or_default();
                let offline = self.settings_offline && self.settings_note.is_none();
                let text = if offline {
                    strings::get("set.offline").to_string()
                } else {
                    note
                };
                if text.is_empty() {
                    div().hidden().into_any_element()
                } else {
                    div()
                        .text_xs()
                        .text_color(theme::muted_text())
                        .child(text)
                        .into_any_element()
                }
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Log {
                div()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(section_label(&strings::format(
                        "update.log_section",
                        &[("n", &self.polls.to_string())],
                    )))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .p_3()
                            .rounded_xl()
                            .bg(theme::surface())
                            .border_1()
                            .border_color(theme::line())
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme::secondary_text())
                                    .child(log_text),
                            ),
                    )
                    .into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Status {
                div()
                    .id("quit")
                    .text_center()
                    .text_sm()
                    .px_3()
                    .py_2()
                    .rounded_lg()
                    .bg(theme::surface())
                    .border_1()
                    .border_color(theme::line())
                    .text_color(theme::secondary_text())
                    .cursor_pointer()
                    .hover(|s| s.border_color(theme::secondary_text()))
                    .on_click(cx.listener(|_, _, window, _| {
                        window.remove_window();
                    }))
                    .child(strings::get("btn.hide_tray").to_string())
                    .into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Log {
                div()
                    .flex()
                    .flex_row()
                    .gap_2()
                    .child(
                        div()
                            .debug_selector(|| "clear-log".to_string())
                            .id("clear-log")
                            .flex_1()
                            .text_center()
                            .text_sm()
                            .px_3()
                            .py_2()
                            .rounded_lg()
                            .bg(theme::surface())
                            .border_1()
                            .border_color(theme::line())
                            .text_color(theme::primary_text())
                            .cursor_pointer()
                            .hover(|s| s.border_color(theme::secondary_text()))
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.clear_log();
                                cx.notify();
                            }))
                            .child(strings::get("btn.clear").to_string()),
                    )
                    .child(
                        div()
                            .id("quit-log")
                            .text_sm()
                            .px_3()
                            .py_2()
                            .rounded_lg()
                            .bg(theme::surface())
                            .border_1()
                            .border_color(theme::line())
                            .text_color(theme::secondary_text())
                            .cursor_pointer()
                            .hover(|s| s.border_color(theme::secondary_text()))
                            .on_click(|_, _, cx: &mut App| {
                                quit_app(cx);
                            })
                            .child(strings::get("btn.quit").to_string()),
                    )
                    .into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(
                div()
                    .text_xs()
                    .text_center()
                    .text_color(theme::muted_text())
                    .child(strings::format("panel.url", &[("url", &dashboard_url)])),
            )
            )
    }
}

/// Estado vivo del launcher en Windows: ventana visible (si la hay) y
/// control del hilo del tray. Vive en un `Rc<RefCell>` compartido entre
/// el arranque y el bucle de eventos (todo en el hilo principal).
#[cfg(windows)]
struct LauncherState {
    window: Option<AnyWindowHandle>,
    tray: Option<TrayCtl>,
}

/// Ventana ancla invisible: con al menos una ventana abierta, cerrar la
/// visible no provoca `PostQuitMessage` y el tray sigue respondiendo.
#[cfg(windows)]
struct AnchorView;

#[cfg(windows)]
impl Render for AnchorView {
    fn render(&mut self, _window: &mut gpui::Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

#[cfg(windows)]
fn main_window_options(cx: &mut App) -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(440.0), px(860.0)),
            cx,
        ))),
        window_min_size: Some(size(px(400.0), px(600.0))),
        titlebar: Some(gpui::TitlebarOptions {
            title: Some(strings::get("ui.window_title").into()),
            // Sin marco nativo: la barra de título la dibuja la app
            // (ver `title_chrome`). El título sigue en la barra de tareas.
            appears_transparent: true,
            ..Default::default()
        }),
        ..Default::default()
    }
}

#[cfg(windows)]
fn open_launcher_window(cx: &mut App) -> gpui::Result<AnyWindowHandle> {
    let options = main_window_options(cx);
    Ok(cx.open_window(options, |_, cx| cx.new(LauncherView::new))?.into())
}

/// Clic en el tray (o "Abrir panel"): trae la ventana al frente si
/// existe, o la abre si se cerró.
#[cfg(windows)]
fn show_launcher(cx: &mut App, state: &Rc<RefCell<LauncherState>>) {
    let mut st = state.borrow_mut();
    if let Some(h) = st.window {
        if h
            .update(cx, |_, window, _| window.activate_window())
            .is_ok()
        {
            return;
        }
    }
    match open_launcher_window(cx) {
        Ok(h) => {
            // Icono nativo (barra de tareas / Alt-Tab): el marco es propio
            // (`appears_transparent`) y GPUI 0.2 no expone icono, así que
            // se pone a mano sobre el HWND (además del recurso del exe).
            let _ = h.update(cx, |_, window, _| apply_window_icon(window));
            st.window = Some(h);
        }
        Err(e) => eprintln!("[launcher] no se pudo abrir la ventana: {e:#}"),
    }
}

#[cfg(windows)]
fn handle_tray(cx: &mut App, state: &Rc<RefCell<LauncherState>>, ev: TrayEvent) {
    match ev {
        TrayEvent::ShowLauncher => show_launcher(cx, state),
        TrayEvent::OpenPanel => {
            let url = format!("http://localhost:{}", monitor::frontend_port());
            if open::that(&url).is_err() {
                eprintln!("[launcher] no se pudo abrir el navegador ({url})");
            } else {
                // Igual que "Panel web": se cierra la ventana, el tray sigue.
                let mut st = state.borrow_mut();
                if let Some(h) = st.window.take() {
                    let _ = h.update(cx, |_, window, _| window.remove_window());
                }
            }
        }
        TrayEvent::Quit => {
            // "Salir" apaga todo: pide al daemon que se detenga y verifica
            // en un hilo aparte que el stack caiga de verdad (antes el
            // frontal embebido parecía "quedarse levantado" porque nadie lo
            // comprobaba). La UI se cierra al instante; el log queda en
            // launcher-update.log.
            if monitor::shutdown_daemon() {
                eprintln!("[launcher] apagado del daemon solicitado.");
                persist_update_log("Apagado solicitado desde Salir.");
                std::thread::spawn(|| {
                    monitor::wait_for_stack_down();
                    if monitor::stack_down() {
                        persist_update_log("Stack detenido tras Salir.");
                    } else {
                        persist_update_log(
                            "AVISO: tras Salir, algún servicio sigue respondiendo.",
                        );
                    }
                });
            } else {
                persist_update_log("Salir sin daemon que apagar.");
            }
            if let Some(tray) = state.borrow_mut().tray.take() {
                tray.shutdown();
            }
            cx.quit();
        }
        TrayEvent::Restart => {
            if let Some(tray) = state.borrow_mut().tray.take() {
                tray.shutdown();
            }
            cx.quit();
        }
    }
}

/// Salir unificado: pasa por el tray (limpia el icono) si existe.
#[cfg(windows)]
fn quit_app(cx: &mut App) {
    if let Some(tx) = TRAY_TX.get() {
        if tx.send(TrayEvent::Quit).is_ok() {
            return;
        }
    }
    cx.quit();
}

#[cfg(windows)]
fn restart_app_for_update(cx: &mut App) {
    if let Some(tx) = TRAY_TX.get() {
        if tx.send(TrayEvent::Restart).is_ok() {
            return;
        }
    }
    cx.quit();
}

/// Sin tray: salir directamente (apagando antes el daemon si está en marcha).
#[cfg(not(windows))]
fn quit_app(cx: &mut App) {
    let _ = monitor::shutdown_daemon();
    cx.quit();
}

#[cfg(not(windows))]
fn restart_app_for_update(cx: &mut App) {
    cx.quit();
}

/// HWND nativo de una ventana GPUI (arrastre y maximizar propios).
/// GPUI 0.2 no implementa `start_window_move` en Windows: se hace a mano
/// con `ReleaseCapture + WM_NCLBUTTONDOWN/HTCAPTION`.
#[cfg(windows)]
fn hwnd_of(window: &mut Window) -> Option<HWND> {
    match window.window_handle() {
        Ok(h) => match h.as_raw() {
            RawWindowHandle::Win32(w) => Some(HWND(w.hwnd.get() as *mut _)),
            _ => None,
        },
        Err(_) => None,
    }
}

/// Icono nativo de la ventana (barra de tareas / Alt-Tab).
/// El exe ya lleva `icon.ico` incrustado (`build.rs` + `app.rc`), pero GPUI
/// crea su propia clase de ventana y no expone icono: se asigna además por
/// HWND con `WM_SETICON` para que aparezca aunque el marco visible sea el
/// propio (`appears_transparent`, sin marco nativo).
#[cfg(windows)]
fn load_window_icon(size: i32) -> Option<windows::Win32::UI::WindowsAndMessaging::HICON> {
    use windows::Win32::UI::WindowsAndMessaging::{
        LoadIconW, LoadImageW, IDI_APPLICATION, IMAGE_ICON, LR_LOADFROMFILE,
    };
    use windows::core::PCWSTR;
    unsafe {
        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("icon.ico"));
                let mut d = dir.to_path_buf();
                for _ in 0..3 {
                    if !d.pop() {
                        break;
                    }
                }
                candidates.push(d.join("icon.ico"));
            }
        }
        for c in candidates {
            if c.is_file() {
                let wide: Vec<u16> = c.to_string_lossy().encode_utf16().chain([0]).collect();
                if let Ok(h) = LoadImageW(
                    None,
                    PCWSTR(wide.as_ptr()),
                    IMAGE_ICON,
                    size,
                    size,
                    LR_LOADFROMFILE,
                ) {
                    if !h.0.is_null() {
                        return Some(windows::Win32::UI::WindowsAndMessaging::HICON(h.0));
                    }
                }
            }
        }
        LoadIconW(None, IDI_APPLICATION)
            .ok()
            .filter(|h| !h.0.is_null())
    }
}

/// Asigna el icono al HWND de la ventana GPUI (grande + pequeño).
#[cfg(windows)]
fn apply_window_icon(window: &mut Window) {
    if let Some(hwnd) = hwnd_of(window) {
        unsafe {
            // Un solo HICON de 32px sirve para ambos tamaños; Windows lo
            // escala para la vista pequeña si hace falta.
            if let Some(icon) = load_window_icon(32) {
                let lparam = LPARAM(icon.0 as isize);
                let _ = SendMessageW(
                    hwnd,
                    WM_SETICON,
                    Some(WPARAM(ICON_BIG as usize)),
                    Some(lparam),
                );
                let _ = SendMessageW(
                    hwnd,
                    WM_SETICON,
                    Some(WPARAM(ICON_SMALL as usize)),
                    Some(lparam),
                );
                // El HICON es Copy y queda asociado a la ventana; no hay
                // nada que liberar aquí (se pierde un handle por apertura,
                // despreciable frente al ciclo de vida de la ventana).
            }
        }
    }
}

/// Alterna maximizado/restaurado con la API nativa.
#[cfg(windows)]
fn toggle_maximize(window: &mut Window) {
    if let Some(hwnd) = hwnd_of(window) {
        unsafe {
            if IsZoomed(hwnd).0 != 0 {
                let _ = ShowWindowAsync(hwnd, SW_RESTORE);
            } else {
                let _ = ShowWindowAsync(hwnd, SW_MAXIMIZE);
            }
        }
    }
}

/// Inicia un arrastre de ventana desde la barra propia.
#[cfg(windows)]
fn begin_native_drag(window: &mut Window) {
    if let Some(hwnd) = hwnd_of(window) {
        unsafe {
            let _ = ReleaseCapture();
            let _ = SendMessageW(
                hwnd,
                WM_NCLBUTTONDOWN,
                Some(WPARAM(HTCAPTION as usize)),
                None,
            );
        }
    }
}

/// ¿Ventana maximizada? (para el icono de maximizar/restaurar).
#[cfg(all(windows, not(test)))]
fn is_maximized(window: &mut Window) -> bool {
    hwnd_of(window)
        .map(|hwnd| unsafe { IsZoomed(hwnd).0 != 0 })
        .unwrap_or(false)
}

/// Headless GPUI test windows do not expose an HWND.
#[cfg(all(windows, test))]
fn is_maximized(_window: &mut Window) -> bool {
    false
}

/// Glifos de la barra (12px, trazo 1.5), estilo TitleBar de bundeck.
#[cfg(windows)]
#[derive(Clone, Copy)]
enum ChromeGlyph {
    Minimize,
    Maximize,
    Restore,
    Close,
}

#[cfg(windows)]
fn chrome_glyph(kind: ChromeGlyph, color: gpui::Rgba) -> impl IntoElement {
    use gpui::{canvas, point, PathBuilder};
    canvas(
        move |bounds, _, _| bounds,
        move |bounds, _, window, _| {
            let ox = bounds.origin.x;
            let oy = bounds.origin.y;
            let p = |x: f32, y: f32| point(ox + px(x), oy + px(y));
            let mut b = PathBuilder::stroke(px(1.5));
            match kind {
                ChromeGlyph::Minimize => {
                    b.move_to(p(2.0, 6.0));
                    b.line_to(p(10.0, 6.0));
                }
                ChromeGlyph::Maximize => {
                    b.move_to(p(2.5, 2.5));
                    b.line_to(p(9.5, 2.5));
                    b.line_to(p(9.5, 9.5));
                    b.line_to(p(2.5, 9.5));
                    b.close();
                }
                ChromeGlyph::Restore => {
                    b.move_to(p(4.5, 1.5));
                    b.line_to(p(10.5, 1.5));
                    b.line_to(p(10.5, 7.5));
                    b.line_to(p(8.0, 7.5));
                    b.move_to(p(1.5, 4.5));
                    b.line_to(p(7.5, 4.5));
                    b.line_to(p(7.5, 10.5));
                    b.line_to(p(1.5, 10.5));
                    b.close();
                }
                ChromeGlyph::Close => {
                    b.move_to(p(2.5, 2.5));
                    b.line_to(p(9.5, 9.5));
                    b.move_to(p(9.5, 2.5));
                    b.line_to(p(2.5, 9.5));
                }
            }
            if let Ok(path) = b.build() {
                window.paint_path(path, color);
            }
        },
    )
    .size(px(12.0))
}

/// Botón de la barra (46x40 como `.bd-winbtn`). El `.id()` convierte el
/// `div` en stateful, que es lo que expone `on_click` encadenable.
#[cfg(windows)]
fn chrome_button(
    id: &'static str,
    glyph: ChromeGlyph,
    danger: bool,
    on_click: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
    div()
        .id(id)
        .w(px(46.0))
        .h(px(40.0))
        .flex()
        .items_center()
        .justify_center()
        .text_color(theme::secondary_text())
        .cursor_pointer()
        .hover(|s| {
            s.bg(if danger {
                theme::close_hover()
            } else {
                theme::raised()
            })
        })
        .on_click(move |_, window, cx| {
            on_click(window, cx);
            window.refresh();
        })
        .child(chrome_glyph(glyph, theme::secondary_text()))
}

/// Barra de título propia (40px, como `.bd-titlebar`): logo + nombre a la
/// izquierda (arrastrar mueve, doble clic maximiza), botones a la derecha.
#[cfg(windows)]
fn title_chrome(
    view: &mut LauncherView,
    window: &mut Window,
    cx: &mut Context<LauncherView>,
) -> impl IntoElement {
    let maximized = is_maximized(window);
    let logo = view.logo.clone();
    div()
        .h(px(40.0))
        .flex_shrink_0()
        .w_full()
        .flex()
        .flex_row()
        .bg(theme::ground())
        .border_b_1()
        .border_color(theme::line())
        .child(
            div()
                .flex_1()
                .h(px(40.0))
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .pl(px(12.0))
                .child(if let Some(path) = logo {
                    img(path).size(px(18.0)).into_any_element()
                } else {
                    div()
                        .size(px(18.0))
                        .rounded_md()
                        .bg(theme::accent())
                        .into_any_element()
                })
                .child(
                    div()
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme::muted_text())
                        .child("BunDeck".to_string()),
                )
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|view, _, window, cx| {
                        // Doble clic = maximizar/restaurar; si no, arrastre.
                        let now = Instant::now();
                        let dbl = matches!(view.last_chrome_click, Some(t) if now.duration_since(t) < Duration::from_millis(400));
                        view.last_chrome_click = Some(now);
                        if dbl {
                            toggle_maximize(window);
                        } else {
                            begin_native_drag(window);
                        }
                        cx.notify();
                    }),
                ),
        )
        .child(
            div().flex().flex_row().flex_none()
                .child(chrome_button("chrome-min", ChromeGlyph::Minimize, false, |window, _| {
                    window.minimize_window();
                }))
                .child(chrome_button(
                    "chrome-max",
                    if maximized {
                        ChromeGlyph::Restore
                    } else {
                        ChromeGlyph::Maximize
                    },
                    false,
                    |window, _| {
                        toggle_maximize(window);
                    },
                ))
                .child(chrome_button("chrome-close", ChromeGlyph::Close, true, |window, _| {
                    window.remove_window();
                })),
        )
}

/// PNG a todo color de la mascota (`apple-touch-icon.png` o
/// `favicon-32.png`). `img()` lo carga de disco tal cual, sin AssetSource.
#[cfg(not(windows))]
fn title_chrome(
    _view: &mut LauncherView,
    _window: &mut gpui::Window,
    _cx: &mut Context<LauncherView>,
) -> impl IntoElement {
    div().hidden()
}

fn pending_update_for_startup() -> Option<String> {
    let root = updater::install_root();
    let pending = updater::pending_update_version()?;
    let current = monitor::installed_version()
        .or_else(|| updater::active_version(&root))
        .unwrap_or_else(|| "0.0.0".to_string());

    if !updater::is_newer(&current, &pending) {
        updater::clear_pending_update(&root, &pending);
        return None;
    }

    // Si hay red y se publicó algo posterior mientras BunDeck estaba cerrado,
    // no aplicamos el stage viejo: la comprobación automática bajará el último.
    match updater::check_for_update(&current) {
        Ok(Some(latest)) if latest.latest != pending => {
            updater::clear_pending_update(&root, &pending);
            return None;
        }
        Ok(None) => {
            updater::clear_pending_update(&root, &pending);
            return None;
        }
        _ => {}
    }
    Some(pending)
}

/// ¿Arranque minimizado? El autostart del SO registra el exe con el flag
/// `--minimized` cuando `system.start_minimized` está activo: en ese modo
/// solo se ancla + tray (sin ventana visible, sin diálogos modales, sin
/// abrir el navegador en el camino de boot).
pub fn boot_minimized(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == autostart::MINIMIZED_FLAG)
}

fn main() {
    // Flag `--minimized` (lo pone el autostart del SO cuando
    // `system.start_minimized` está activo): sin ventana visible, sin
    // diálogos modales de instancia/servidor (log + salida silenciosa) y
    // sin abrir el navegador en el camino de boot.
    let minimized = boot_minimized(&std::env::args().collect::<Vec<_>>());
    let interactive = !minimized;
    // El mutex se mantiene durante toda la vida del launcher. Se comparte
    // entre instalaciones y DEV_MODE para impedir dos paneles/daemons a la vez.
    let Some(_instance_lock) = acquire_single_instance(interactive) else {
        if minimized {
            eprintln!("[launcher] otra instancia en marcha; salida silenciosa (minimized).");
        }
        return;
    };
    #[cfg(windows)]
    if interactive {
        prepare_existing_server(interactive);
    }
    // Atajos globales (hilo dedicado; no bloquea el arranque ni la UI).
    shortcuts::start_shortcuts();
    // Las actualizaciones se descargan y aplican con la app abierta. Si el
    // proceso se cerró antes de completar la activación, aplica el stage
    // pendiente antes de abrir la ventana o arrancar el daemon.
    if auto_updates_enabled() {
        if let Some(version) = pending_update_for_startup() {
            let mut lines = Vec::new();
            match updater::apply_staged(&mut |line| lines.push(line), &version) {
                Ok(()) if updater::staged_has_launcher(&updater::install_root(), &version) => {
                    if let Err(e) = updater::handoff_self_update(&version) {
                        eprintln!("[launcher] no se pudo actualizar el launcher: {e}");
                    } else {
                        return;
    }
}

                Ok(()) => {}
                Err(e) => {
                    eprintln!("[launcher] no se pudo aplicar la actualización pendiente: {e}")
                }
            }
        }
    }

    Application::new().run(move |cx: &mut App| {
        #[cfg(windows)]
        {
            let (rx, ctl) = tray::start_tray();
            let state = Rc::new(RefCell::new(LauncherState {
                window: None,
                tray: Some(ctl),
            }));
            // Ancla invisible: evita que cerrar la ventana salga de la app.
            let _anchor = cx
                .open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                            None,
                            size(px(1.0), px(1.0)),
                            cx,
                        ))),
                        titlebar: None,
                        focus: false,
                        show: false,
                        kind: WindowKind::PopUp,
                        is_movable: false,
                        is_resizable: false,
                        ..Default::default()
                    },
                    |_, cx| cx.new(|_| AnchorView),
                )
                .expect("no se pudo abrir la ventana ancla del launcher");
            // Primera ventana visible (salvo arranque minimizado: solo
            // ancla + tray, sin ventana ni navegador en el camino de boot).
            if interactive {
                show_launcher(cx, &state);
            } else {
                eprintln!("[launcher] arranque minimizado: solo tray.");
            }
            // Bucle de eventos del tray (~10 Hz) en el hilo principal.
            let pump = state.clone();
            cx.spawn(async move |async_cx| {
                loop {
                    async_cx
                        .background_executor()
                        .timer(Duration::from_millis(100))
                        .await;
                    let mut evs = Vec::new();
                    while let Ok(ev) = rx.try_recv() {
                        evs.push(ev);
                    }
                    if evs.is_empty() {
                        continue;
                    }
                    let pump = pump.clone();
                    if async_cx
                        .update(|cx| {
                            for ev in evs {
                                handle_tray(cx, &pump, ev);
                            }
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .detach();
        }
        #[cfg(not(windows))]
        {
            // En arranque minimizado la ventana nace oculta (el tray no
            // existe fuera de Windows: el proceso queda anclado sin mostrar).
            let bounds = Bounds::centered(None, size(px(440.0), px(860.0)), cx);
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    window_min_size: Some(size(px(400.0), px(600.0))),
                    show: !minimized,
                    titlebar: Some(gpui::TitlebarOptions {
                        title: Some(strings::get("ui.window_title").into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                |_, cx| cx.new(LauncherView::new),
            )
            .expect("no se pudo abrir la ventana del launcher");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{Modifiers, TestAppContext};

    #[gpui::test]
    fn renders_initial_state_and_updates_readiness(cx: &mut TestAppContext) {
        let (view, cx) = cx.add_window_view(|_, _| LauncherView::new_for_test());
        cx.refresh().expect("schedule initial render");
        cx.run_until_parked();

        assert!(cx.debug_bounds("tab-status").is_some());
        assert!(cx.debug_bounds("tab-log").is_some());
        assert!(cx.debug_bounds("daemon-start").is_some());

        view.update(cx, |view, cx| {
            assert!(!view.ready_to_close());
            view.snapshot.api.state = State::Ok;
            view.snapshot.frontend.state = State::Ok;
            view.launcher_pending_restart = true;
            cx.notify();
        });
        cx.refresh().expect("schedule updated render");
        cx.run_until_parked();

        view.update(cx, |view, _| {
            assert!(view.ready_to_close());
            assert!(view.update_available());
        });
        assert!(cx.debug_bounds("restart-update").is_some());

        view.update(cx, |view, cx| {
            view.launcher_pending_restart = false;
            assert!(!view.update_available());
            cx.notify();
        });
        cx.refresh().expect("schedule render after clearing update state");
        cx.run_until_parked();
    }

    #[gpui::test]
    fn clicking_log_tab_changes_rendered_content(cx: &mut TestAppContext) {
        let (view, cx) = cx.add_window_view(|_, _| LauncherView::new_for_test());
        cx.refresh().expect("schedule initial render");
        cx.run_until_parked();
        let tab_log = cx.debug_bounds("tab-log").expect("log tab is rendered");

        cx.simulate_click(tab_log.center(), Modifiers::none());
        cx.refresh().expect("schedule render after clicking log tab");
        cx.run_until_parked();

        view.update(cx, |view, _| assert_eq!(view.tab, Tab::Log));
        assert!(cx.debug_bounds("clear-log").is_some());
    }

    #[gpui::test]
    fn restart_handoff_is_single_shot(cx: &mut TestAppContext) {
        let (view, cx) = cx.add_window_view(|_, _| LauncherView::new_for_test());
        cx.run_until_parked();

        // Sin versión aplicada no hay nada que reiniciar y no se marca nada.
        view.update(cx, |view, _| {
            assert!(view.restart_for_self_update() == false);
            assert!(!view.restart_requested);
        });

        // Con versión aplicada pero sin helper disponible (en test no hay
        // staged real), el handoff falla y NO debe marcarse como pedido:
        // el siguiente tick puede reintentar en vez de cerrar el panel.
        view.update(cx, |view, _| {
            view.last_applied = Some("9.9.9-nope".to_string());
            assert!(view.restart_for_self_update() == false);
            assert!(!view.restart_requested);
            assert!(view.log.iter().any(|l| l.contains("actualizador del launcher")));
        });
    }

    #[test]
    fn minimized_flag_solo_con_arg_exact() {
        let bin = "bundeck-launcher".to_string();
        assert!(!boot_minimized(&[bin.clone()]));
        assert!(boot_minimized(&[
            bin.clone(),
            autostart::MINIMIZED_FLAG.to_string()
        ]));
        // Prefijos o asignaciones no valen: el SO registra el flag exacto.
        assert!(!boot_minimized(&[bin.clone(), "--minimized=yes".to_string()]));
        assert!(!boot_minimized(&[bin, "--Minimized".to_string()]));
    }

    #[gpui::test]
    fn settings_tab_muestra_toggles_y_alternan(cx: &mut TestAppContext) {
        let (view, cx) = cx.add_window_view(|_, _| LauncherView::new_for_test());
        cx.refresh().expect("schedule initial render");
        cx.run_until_parked();
        assert!(cx.debug_bounds("tab-settings").is_some());

        let tab = cx.debug_bounds("tab-settings").expect("settings tab");
        cx.simulate_click(tab.center(), Modifiers::none());
        cx.refresh().expect("render settings tab");
        cx.run_until_parked();

        view.update(cx, |view, _| assert_eq!(view.tab, Tab::Settings));
        assert!(cx.debug_bounds("set-autostart").is_some());
        assert!(cx.debug_bounds("set-minimized").is_some());
        assert!(cx.debug_bounds("set-lang-es").is_some());

        // El toggle es optimista: cambia al instante aunque el POST falle.
        let sw = cx.debug_bounds("set-autostart").expect("autostart switch");
        cx.simulate_click(sw.center(), Modifiers::none());
        cx.refresh().expect("render after toggle");
        cx.run_until_parked();
        view.update(cx, |view, _| assert!(view.settings_autostart));
    }

    #[gpui::test]
    fn settings_con_daemon_caido_usa_cache_local(cx: &mut TestAppContext) {
        // `new` arranca desde `launcher-startup.json` cuando la API no
        // responde: aquí se reproduce con un data dir temporal.
        let prev = std::env::var("BUNDECK_DATA_DIR").ok();
        let dir = std::env::temp_dir().join(format!(
            "ld-settings-cache-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::env::set_var("BUNDECK_DATA_DIR", &dir);
        autostart::save_cached_startup(autostart::StartupPrefs::new(true, false));
        assert_eq!(
            autostart::load_cached_startup(),
            Some(autostart::StartupPrefs::new(true, false))
        );

        let (view, cx) = cx.add_window_view(|_, _| LauncherView::new_for_test());
        cx.run_until_parked();
        // Estado inicial desde la caché (como hace `new` sin daemon).
        view.update(cx, |view, _| {
            if let Some(cached) = autostart::load_cached_startup() {
                view.settings_autostart = cached.autostart;
                view.settings_minimized = cached.start_minimized;
            }
        });
        // La API no responde a ninguna clave: se conserva la caché y se
        // marca offline (sin tocar el SO: el sondeo no hace nada sin prefs).
        view.update(cx, |view, cx| {
            let _ = view.background_tx.send(BackgroundEvent::SettingsLoaded {
                lang: None,
                autostart: None,
                start_minimized: None,
            });
            view.consume_background_events();
            cx.notify();
        });
        view.update(cx, |view, _| {
            assert!(view.settings_autostart);
            assert!(!view.settings_minimized);
            assert!(view.settings_offline);
        });

        match prev {
            Some(v) => std::env::set_var("BUNDECK_DATA_DIR", v),
            None => std::env::remove_var("BUNDECK_DATA_DIR"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
