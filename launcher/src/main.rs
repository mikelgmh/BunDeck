//! BunDeck launcher — ventanita de estado (Rust + GPUI).
//!
//! Sin rastro de terminal en release (`windows_subsystem = "windows"`;
//! en dev se conserva la consola para los logs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! - Al abrir: intenta que el daemon esté corriendo (espejo de
//!   `spawnDaemon()` en `src/bun/index.ts`), luego sondea cada 2s:
//!   API :3001 (/health), WS :3003 (TCP), Frontend :3002 o :4321 (HEAD /).
//! - Botones: Abrir panel (navegador), Reintentar sondeo, Salir.
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
//!   respondiendo. Solo "Salir" (de la ventana o del menú del tray)
//!   termina el proceso. El menú del tray ofrece Abrir panel (esta
//!   ventana GPUI), Abrir en la web (navegador), Abrir en Electrobun
//!   (ventana nativa del host) y Salir.

mod monitor;
mod theme;
mod tray;
pub mod updater;

use gpui::{
    div, img, prelude::*, px, relative, size, App, Application, Bounds, Context, FontWeight,
    SharedString, WindowBounds, WindowOptions,
};
#[cfg(windows)]
use gpui::{AnyWindowHandle, MouseButton, Window, WindowKind};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
#[cfg(windows)]
use std::time::Instant;
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
    IsZoomed, SendMessageW, ShowWindowAsync, HTCAPTION, ICON_BIG, ICON_SMALL, SW_MAXIMIZE,
    SW_RESTORE, WM_NCLBUTTONDOWN, WM_SETICON,
};

/// Canal hacia el bucle de eventos del tray (Windows): "Salir" pasa por
/// aquí para limpiar el icono antes de terminar el proceso.
#[cfg(windows)]
static TRAY_TX: std::sync::OnceLock<std::sync::mpsc::Sender<TrayEvent>> =
    std::sync::OnceLock::new();

/// Pestañas del panel: estado/acciones y registro a pantalla completa.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tab {
    Status,
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
    /// PNG del logo para la cabecera (None = cuadrado ámbar de reserva).
    logo: Option<PathBuf>,
    /// Hay host Electrobun (ventana nativa disponible).
    host: bool,
    /// Último clic en la barra de título (doble clic = maximizar/restaurar).
    #[cfg(windows)]
    last_chrome_click: Option<Instant>,
}

impl LauncherView {
    fn new(cx: &mut Context<Self>) -> Self {
        let mut log = vec!["Launcher iniciado.".to_string()];
        // Intento de arranque del daemon (no bloquea la UI).
        let (boot, spawned) = monitor::ensure_daemon_spawned();
        log.extend(boot);
        // Si acabamos de spawnearlo y aún no responde, el primer sondeo
        // muestra "arrancando", no "detenido".
        let snapshot = monitor::snapshot(spawned);
        log.push(format!(
            "Sondeo inicial: API {} · WS {} · Front {}",
            snapshot.api.detail, snapshot.ws.detail, snapshot.frontend.detail
        ));
        let installed = monitor::installed_version();
        if let Some(v) = &installed {
            log.push(format!("Daemon instalado: v{v}."));
        }
        // Red con timeout corto; si no hay internet, se reintenta con "Buscar".
        let latest = monitor::latest_release();
        match &latest {
            Some(r) => log.push(format!("Última release: {} ({})", r.tag, r.url)),
            None => log.push("No se pudo consultar la última release (¿sin internet?).".to_string()),
        }
        let pending_start =
            spawned && snapshot.api.state != State::Ok;
        if pending_start {
            log.push("Daemon arrancando: esperando a que la API responda…".to_string());
        }
        let mut view = Self {
            snapshot,
            log,
            polls: 1,
            tab: Tab::Status,
            installed,
            latest,
            update_check: None,
            update_progress: Arc::new(Mutex::new(updater::UpdateProgress::default())),
            update_busy: false,
            update_applying: false,
            last_applied: None,
            launcher_pending_restart: false,
            pending_start,
            logo: monitor::logo_path(),
            host: monitor::host_alive(),
            #[cfg(windows)]
            last_chrome_click: None,
        };
        view.start_polling(cx);
        view
    }

    fn start_polling(&mut self, cx: &mut Context<Self>) {
        // El futuro posee todo (AsyncApp + WeakEntity): nada prestado cruza
        // el `.await`, que era lo que rechazaba el borrow checker con
        // `Context::spawn`/`AsyncApp::spawn`. Se programa en el executor de
        // foreground (hilo principal, no exige Send).
        let mut async_cx = cx.to_async();
        let foreground = async_cx.foreground_executor().clone();
        let this = cx.weak_entity();
        foreground
            .spawn(async move {
                loop {
                    async_cx
                        .background_executor()
                        .timer(Duration::from_secs(2))
                        .await;
                    // Arranque pendiente (botón Iniciar/Reiniciar): reintenta
                    // hasta que la API responda. Rápido, no espera al boot.
                    let want_start =
                        this.update(&mut async_cx, |view, _| view.pending_start).unwrap_or(false);
                    let mut boot = Vec::new();
                    if want_start {
                        let (lines, _) = monitor::ensure_daemon_spawned();
                        boot = lines;
                    }
                    // Solo con arranque pendiente lo caído se pinta
                    // "arrancando": tras Detener (sin pendiente) es "detenido".
                    let snap = monitor::snapshot(want_start);
                    // Si la vista se cerró, `update` falla: terminamos el
                    // bucle en vez de girar para siempre.
                    if this
                        .update(&mut async_cx, |view, cx| {
                            view.polls += 1;
                            view.snapshot = snap;
                            view.host = monitor::host_alive();
                            if view.snapshot.api.state == State::Ok {
                                view.pending_start = false;
                            }
                            view.log.extend(boot);
                            // El hilo de descarga escribe en update_progress;
                            // el sondeo lo vuelca al registro y libera busy.
                            let mut finished_msg: Option<String> = None;
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
                                        finished_msg = Some(format!("Update falló: {e}"));
                                    }
                                }
                                if let Some(msg) = finished_msg {
                                    view.update_busy = false;
                                    view.log.push(msg);
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
                                        view.installed = monitor::installed_version();
                                        view.last_applied = Some(v);
                                        if changed {
                                            view.launcher_pending_restart = true;
                                            view.log.push(
                                                "El launcher también cambió: reinicia para completar."
                                                    .to_string(),
                                            );
                                        } else {
                                            view.update_check = None;
                                        }
                                        *view.update_progress.lock().unwrap() =
                                            updater::UpdateProgress::default();
                                    } else if let Some(e) = apply_err {
                                        view.log
                                            .push(format!("No se pudo aplicar: {e}"));
                                        *view.update_progress.lock().unwrap() =
                                            updater::UpdateProgress::default();
                                    }
                                }
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
            self.log.push("Arranque solicitado: reintentando hasta que la API responda…".to_string());
        }
        self.truncate_log();
    }

    /// Botón Detener: orden de apagado al daemon (muere en ~2s).
    fn stop_daemon(&mut self) {
        self.pending_start = false;
        if monitor::shutdown_daemon() {
            self.log.push("Apagado solicitado (el daemon muere en ~2s).".to_string());
        } else {
            self.log.push("No se pudo pedir el apagado: ¿ya está detenido?".to_string());
        }
        self.truncate_log();
    }

    /// Botón Reiniciar: apaga y marca arranque pendiente.
    fn restart_daemon(&mut self) {
        self.pending_start = true;
        if monitor::shutdown_daemon() {
            self.log.push("Reinicio solicitado: apagando y volviendo a arrancar…".to_string());
        } else {
            self.log.push("No respondía al apagado: intentando arranque directo…".to_string());
        }
        self.truncate_log();
    }

    /// Botón Buscar: re-consulta instalada + manifiesto de update.
    /// Usa el manifiesto versionado; si no existe (release antigua),
    /// recurre a la API de GitHub para al menos informar.
    fn check_updates(&mut self) {
        self.installed = monitor::installed_version();
        let current = self.installed.clone().unwrap_or_else(|| "dev".to_string());
        match updater::check_for_update(&current) {
            Ok(Some(check)) => {
                self.log.push(format!(
                    "Nueva versión: instalada v{} → {} (bundle {}, {:.1} MB).",
                    check.current,
                    check.latest,
                    check.asset.bundle,
                    check.asset.size as f64 / 1_048_576.0
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
                    *self.update_progress.lock().unwrap() = updater::UpdateProgress::default();
                }
                self.update_check = Some(check);
            }
            Ok(None) => {
                self.log.push(format!("Estás al día (v{current})."));
                self.update_check = None;
                self.latest = Some(LatestRelease {
                    tag: format!("v{current}"),
                    url: format!(
                        "https://github.com/{}/releases/latest",
                        updater::GITHUB_REPO
                    ),
                });
            }
            Err(e) => {
                // Fallback informativo a latest_release clásico.
                self.latest = monitor::latest_release();
                match (&self.installed, &self.latest) {
                    (Some(i), Some(l)) if monitor::is_newer(i, &l.tag) => {
                        self.log.push(format!(
                            "Manifiesto inaccesible ({e}); última release conocida: instalada v{i}, {}. Descarga manual desde {}",
                            l.tag, l.url
                        ))
                    }
                    (Some(i), Some(_)) => self.log.push(format!("Estás al día (v{i}).")),
                    _ => self.log.push(format!("No se pudo completar el chequeo: {e}")),
                }
            }
        }
        self.truncate_log();
    }

    /// ¿Hay actualización pendiente de aplicar?
    fn update_available(&self) -> bool {
        if self.launcher_pending_restart {
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

    /// Botón Actualizar: flujo gestionado (descarga en 2º plano con
    /// progreso) y aplicación con backup + rollback. Si el launcher
    /// también cambió, tras aplicar se ofrece reiniciar vía helper
    /// `libredeck-updater` (reemplaza el exe tras salir: handoff).
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
                self.log.push("Buscando actualización primero…".to_string());
                self.check_updates();
                match self.update_check.clone() {
                    Some(c) => c,
                    None => {
                        self.log.push("Sin actualización disponible.".to_string());
                        self.truncate_log();
                        return false;
                    }
                }
            }
        };
        // 4) Descarga en hilo de fondo (progreso vía Arc<Mutex>).
        self.update_busy = true;
        *self.update_progress.lock().unwrap() = updater::UpdateProgress {
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
        false
    }

    /// Aplica una versión ya staged en un hilo de fondo: backup +
    /// shutdown + activar + health-check + rollback. El sondeo recoge el
    /// resultado y, si el launcher cambió, ofrece reiniciar vía helper.
    fn finish_apply(&mut self, ver: &str) {
        self.update_applying = true;
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

    /// Reinicia el launcher para completar su self-update vía helper
    /// (reemplaza el exe tras salir). Devuelve true: hay que cerrar.
    fn restart_for_self_update(&mut self) -> bool {
        let Some(ver) = self.last_applied.clone() else {
            return false;
        };
        match updater::handoff_self_update(&ver) {
            Ok(()) => {
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
                self.launcher_pending_restart = false;
                false
            }
        }
    }

    /// Botón Ventana Electrobun: pide al host que abra su dashboard.
    /// Sin host no hay ventana nativa: lo explica y sugiere Abrir panel.
    /// Devuelve true si hay que cerrar la ventanita (handoff completado).
    fn open_electrobun(&mut self) -> bool {
        if !self.host {
            self.log.push(
                "Sin host Electrobun: la ventana nativa solo existe con `electrobun dev`. Usa Abrir panel."
                    .to_string(),
            );
            self.truncate_log();
            return false;
        }
        if let Some(body) = monitor::host_post("open-window") {
            let opened = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("opened")?.as_bool())
                .unwrap_or(false);
            if opened {
                self.log.push("Ventana Electrobun abierta.".to_string());
            } else {
                self.log.push("El host ya tenía su ventana abierta.".to_string());
            }
            self.truncate_log();
            return true;
        }
        self.log.push("El host no respondió. Usa Abrir panel.".to_string());
        self.truncate_log();
        false
    }

    fn dot_color(state: State) -> gpui::Rgba {
        match state {
            State::Ok => theme::ok(),
            State::Starting => theme::warn(),
            State::Down => theme::danger(),
        }
    }
}

/// Etiqueta de sección en mayúsculas apagadas (estilo XAMPP por bloques).
fn section_label(text: &str) -> impl IntoElement {
    div()
        .text_xs()
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(theme::secondary_text())
        .child(text.to_string())
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
            None => "desconocida".to_string(),
        };
        let latest_label = match &self.latest {
            Some(r) => r.tag.clone(),
            None => "—".to_string(),
        };
        let update_available = self.update_available();
        let api_up = self.snapshot.api.state == State::Ok;
        let host_up = self.host;
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
        let update_applying = self.update_applying;
        let launcher_pending_restart = self.launcher_pending_restart;
        let update_btn_label = if launcher_pending_restart {
            "Reiniciar launcher"
        } else if update_applying {
            "Aplicando…"
        } else if staged_ver.is_some() {
            "Aplicar ahora"
        } else if update_busy {
            "Descargando…"
        } else {
            "Descargar"
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
                    .flex()
                    .flex_col()
                    .gap_3()
                    .p_4()
                    .size_full()
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
                                            .child("Panel de control".to_string()),
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
                            .child("Estado".to_string()),
                    )
                    .child(
                        div()
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
                            .child("Registro".to_string()),
                    ),
            )
            .child(if tab == Tab::Status {
                section_label("SERVICIOS").into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Status {
                service_row("API", &self.snapshot.api).into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Status {
                service_row("WebSocket", &self.snapshot.ws).into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Status {
                service_row("Frontend", &self.snapshot.frontend).into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Status {
                section_label("DAEMON").into_any_element()
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
                            .child("Iniciar".to_string()),
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
                            .child("Detener".to_string()),
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
                            .child("Reiniciar".to_string()),
                    )
                    .into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Status {
                section_label("ACTUALIZACIÓN").into_any_element()
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
                            .child(format!("Instalada {installed_label} · Última {latest_label}")),
                    )
                    .child(if update_available {
                        div()
                            .text_xs()
                            .text_color(theme::secondary_text())
                            .child(if launcher_pending_restart {
                                "Launcher actualizado: reinicia para completar.".to_string()
                            } else if staged_ver.is_some() {
                                "Descarga verificada: lista para aplicar.".to_string()
                            } else {
                                "Hay una versión nueva lista para descargar.".to_string()
                            })
                            .into_any_element()
                    } else {
                        div()
                            .text_xs()
                            .text_color(theme::muted_text())
                            .child("Pulsa Buscar para comprobar si hay novedades.".to_string())
                            .into_any_element()
                    })
                    // Etapa / progreso de la actualización en curso.
                    .child(if update_busy || update_err.is_some() || staged_ver.is_some() || !update_stage.is_empty() {
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme::secondary_text())
                                    .child(if update_err.is_some() {
                                        update_err.clone().unwrap_or_default()
                                    } else if staged_ver.is_some() {
                                        format!("Lista: v{} — pulsa Aplicar ahora.", staged_ver.clone().unwrap_or_default())
                                    } else if update_stage.is_empty() {
                                        "".to_string()
                                    } else {
                                        update_stage.clone()
                                    }),
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
                        div()
                            .flex()
                            .flex_row()
                            .gap_2()
                            .child(
                                div()
                                    .id("check-update")
                                    .text_sm()
                                    .px_3()
                                    .py_2()
                                    .rounded_lg()
                                    .bg(theme::ground())
                                    .border_1()
                                    .border_color(theme::line())
                                    .text_color(theme::primary_text())
                                    .cursor_pointer()
                                    .hover(|s| s.border_color(theme::secondary_text()))
                                    .on_click(cx.listener(|view, _, _, cx| {
                                        view.check_updates();
                                        cx.notify();
                                    }))
                                    .child("Buscar".to_string()),
                            )
                            .child(if update_available {
                                div()
                                    .id("apply-update")
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
                                            cx.quit();
                                        } else {
                                            cx.notify();
                                        }
                                    }))
                                    .child(update_btn_label.to_string())
                                    .into_any_element()
                            } else {
                                div()
                                    .flex_1()
                                    .text_center()
                                    .text_sm()
                                    .px_3()
                                    .py_2()
                                    .rounded_lg()
                                    .text_color(theme::muted_text())
                                    .child("Estás al día".to_string())
                                    .into_any_element()
                            }),
                    )
                    .into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Status {
                section_label("ABRIR").into_any_element()
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
                            .id("open-dashboard")
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
                            .on_click(cx.listener(|view, _, window, cx| {
                                if view.open_dashboard() {
                                    if view.ready_to_close() {
                                        // Se cierra la ventana, el tray sigue vivo.
                                        window.remove_window();
                                    } else {
                                        view.log.push(
                                            "Servicios aún arrancando: dejo la ventana abierta."
                                                .to_string(),
                                        );
                                        view.truncate_log();
                                        cx.notify();
                                    }
                                } else {
                                    cx.notify();
                                }
                            }))
                            .child("Panel web".to_string()),
                    )
                    .child(
                        div()
                            .id("open-electrobun")
                            .flex_1()
                            .text_center()
                            .text_sm()
                            .px_3()
                            .py_2()
                            .rounded_lg()
                            .bg(theme::surface())
                            .border_1()
                            .border_color(theme::line())
                            .text_color(if host_up {
                                theme::primary_text()
                            } else {
                                theme::muted_text()
                            })
                            .cursor_pointer()
                            .hover(|s| s.border_color(theme::secondary_text()))
                            .on_click(cx.listener(|view, _, _, cx| {
                                if view.open_electrobun() {
                                    cx.quit();
                                } else {
                                    cx.notify();
                                }
                            }))
                            .child("Ventana Electrobun".to_string()),
                    )
                    .into_any_element()
            } else {
                div().hidden().into_any_element()
            })
            .child(if tab == Tab::Log {
                div()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(section_label(&format!(
                        "REGISTRO · SONDEO #{}",
                        self.polls
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
                    .on_click(|_, _, cx: &mut App| {
                        quit_app(cx);
                    })
                    .child("Salir".to_string())
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
                            .child("Limpiar".to_string()),
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
                            .child("Salir".to_string()),
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
                    .child(format!("Panel: {dashboard_url}")),
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
            size(px(420.0), px(720.0)),
            cx,
        ))),
        titlebar: Some(gpui::TitlebarOptions {
            title: Some("BunDeck — Panel de control".into()),
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
            let url = monitor::snapshot(false).dashboard_url.clone();
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
        TrayEvent::OpenElectrobun => {
            // Como el botón "Ventana Electrobun": handoff al host; sin
            // host, se abre el panel web como alternativa.
            let opened = monitor::host_post("open-window")
                .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
                .and_then(|v| v.get("opened")?.as_bool())
                .unwrap_or(false);
            if !opened {
                let url = monitor::snapshot(false).dashboard_url.clone();
                if open::that(&url).is_err() {
                    eprintln!("[launcher] sin host Electrobun y no se pudo abrir ({url})");
                }
            }
        }
        TrayEvent::Quit => {
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

/// Sin tray: salir directamente.
#[cfg(not(windows))]
fn quit_app(cx: &mut App) {
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
#[cfg(windows)]
fn is_maximized(window: &mut Window) -> bool {
    hwnd_of(window)
        .map(|hwnd| unsafe { IsZoomed(hwnd).0 != 0 })
        .unwrap_or(false)
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

fn main() {
    Application::new().run(|cx: &mut App| {
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
            // Primera ventana visible.
            show_launcher(cx, &state);
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
            let bounds = Bounds::centered(None, size(px(420.0), px(720.0)), cx);
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: Some(gpui::TitlebarOptions {
                        title: Some("BunDeck — Panel de control".into()),
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
