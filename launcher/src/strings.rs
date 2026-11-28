//! Textos visibles del launcher en inglés (por defecto) y español.
//!
//! Idioma efectivo: ① `ui.language` del daemon si la API responde →
//! ② fichero local junto a `launcher-update.log` → ③ locale del SO.
//! Los logs internos quedan en inglés/español fijos según cada módulo
//! (no se duplican): aquí solo viven textos visibles para el usuario.

use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    Es,
}

impl Lang {
    pub fn code(self) -> &'static str {
        match self {
            Lang::En => "en",
            Lang::Es => "es",
        }
    }

    /// Normaliza un tag (`es-ES`, `es_ES.UTF-8`, `EN`, …) al idioma
    /// soportado, o `None` si no lo está (→ inglés por defecto).
    pub fn from_code(raw: &str) -> Option<Lang> {
        let no_encoding = raw.split('.').next().unwrap_or(raw);
        let base = no_encoding
            .split(['-', '_'])
            .next()
            .unwrap_or(no_encoding)
            .trim()
            .to_lowercase();
        match base.as_str() {
            "en" => Some(Lang::En),
            "es" => Some(Lang::Es),
            _ => None,
        }
    }
}

/// Idiomas soportados por el launcher (inglés por defecto y fallback).
pub const SUPPORTED: &[&str] = &["en", "es"];

/// Locale del sistema operativo, con whitelist (no soportado → inglés).
pub fn detect() -> Lang {
    #[cfg(windows)]
    if let Some(code) = os_locale_code_windows() {
        if let Some(lang) = Lang::from_code(&code) {
            return lang;
        }
    }
    for key in ["LC_ALL", "LANG", "LANGUAGE"] {
        if let Ok(val) = std::env::var(key) {
            let first = val.split(':').next().unwrap_or(&val);
            if let Some(lang) = Lang::from_code(first) {
                return lang;
            }
        }
    }
    Lang::En
}

#[cfg(windows)]
fn os_locale_code_windows() -> Option<String> {
    use windows::Win32::Globalization::GetUserDefaultLocaleName;
    // LOCALE_NAME_MAX_LENGTH = 85.
    let mut buf = [0u16; 85];
    let len = unsafe { GetUserDefaultLocaleName(&mut buf) };
    if len <= 1 {
        return None;
    }
    String::from_utf16(&buf[..(len as usize - 1)]).ok()
}

fn api_port() -> u16 {
    std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(3001)
}

/// `ui.language` guardado en el daemon (best-effort, timeout corto).
fn daemon_language() -> Option<Lang> {
    let url = format!(
        "http://127.0.0.1:{}/api/v1/settings?key=ui.language",
        api_port()
    );
    let agent: ureq::Agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_millis(900))
        .timeout_read(std::time::Duration::from_millis(900))
        .timeout_write(std::time::Duration::from_millis(900))
        .build();
    let body = agent.get(&url).call().ok()?;
    let v: serde_json::Value = body.into_json().ok()?;
    Lang::from_code(v.get("value")?.as_str()?)
}

/// Directorio de datos (espejo mínimo de `updater::user_data_dir` para no
/// acoplar este módulo, que también compila en `bundeck-updater`).
fn data_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("BUNDECK_DATA_DIR").or_else(|_| std::env::var("LIBREDECK_DATA_DIR")) {
        if !dir.trim().is_empty() {
            return std::path::PathBuf::from(dir);
        }
    }
    #[cfg(windows)]
    if let Some(base) = std::env::var_os("APPDATA")
        .or_else(|| std::env::var_os("LOCALAPPDATA"))
    {
        return std::path::PathBuf::from(base).join("BunDeck").join("data");
    }
    #[cfg(not(windows))]
    if let Some(home) = std::env::var_os("HOME") {
        return std::path::PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("bundeck");
    }
    std::path::PathBuf::from(".")
}

fn lang_file() -> std::path::PathBuf {
    data_dir().join("launcher-lang")
}

fn file_language() -> Option<Lang> {
    let raw = std::fs::read_to_string(lang_file()).ok()?;
    Lang::from_code(raw.trim())
}

fn persist_lang_file(lang: Lang) {
    let path = lang_file();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, lang.code());
}

static OVERRIDE: OnceLock<Lang> = OnceLock::new();
static RESOLVED: OnceLock<Lang> = OnceLock::new();
/// Idioma fijado en caliente desde la pestaña Ajustes (gana al resuelto
/// pero no al `OVERRIDE` de tests). Se persiste en `launcher-lang`.
static RUNTIME: std::sync::RwLock<Option<Lang>> = std::sync::RwLock::new(None);

/// Fija el idioma a mano (tests). No toca disco ni red.
pub fn set_override(lang: Lang) {
    let _ = OVERRIDE.set(lang);
}

/// Fija el idioma en caliente (pestaña Ajustes del launcher): se aplica al
/// momento y se persiste para el próximo arranque.
pub fn set_runtime(lang: Lang) {
    if let Ok(mut slot) = RUNTIME.write() {
        *slot = Some(lang);
    }
    persist_lang_file(lang);
}

/// Idioma efectivo, resuelto una vez: override (tests) → runtime (ajustes)
/// → daemon → fichero local → SO.
pub fn effective() -> Lang {
    if let Some(lang) = OVERRIDE.get() {
        return *lang;
    }
    if let Some(lang) = RUNTIME.read().ok().and_then(|slot| *slot) {
        return lang;
    }
    *RESOLVED.get_or_init(|| {
        if let Some(lang) = daemon_language() {
            persist_lang_file(lang);
            return lang;
        }
        if let Some(lang) = file_language() {
            return lang;
        }
        detect()
    })
}

/// Texto en el idioma efectivo (inglés si falta la clave).
pub fn get(key: &str) -> &'static str {
    get_in(effective(), key)
}

/// Texto en un idioma explícito (sin E/S: apto para tests).
pub fn get_in(lang: Lang, key: &str) -> &'static str {
    match (lang, key) {
        // Bandeja del sistema.
        (Lang::En, "tray.open_panel") => "Open panel",
        (Lang::Es, "tray.open_panel") => "Abrir panel",
        (Lang::En, "tray.open_web") => "Open in browser",
        (Lang::Es, "tray.open_web") => "Abrir en la web",
        (Lang::En, "tray.quit") => "Quit",
        (Lang::Es, "tray.quit") => "Salir",
        (_, "tray.tip") => "BunDeck",
        // Estado de servicios.
        (Lang::En, "state.ok") => "online",
        (Lang::Es, "state.ok") => "en línea",
        (Lang::En, "state.starting") => "starting…",
        (Lang::Es, "state.starting") => "arrancando…",
        (Lang::En, "state.down") => "stopped",
        (Lang::Es, "state.down") => "detenido",
        (Lang::En, "state.checking") => "checking…",
        (Lang::Es, "state.checking") => "consultando…",
        // Panel.
        (Lang::En, "common.unknown") => "unknown",
        (Lang::Es, "common.unknown") => "desconocida",
        (Lang::En, "ui.subtitle") => "Control panel",
        (Lang::Es, "ui.subtitle") => "Panel de control",
        (Lang::En, "ui.window_title") => "BunDeck — Control panel",
        (Lang::Es, "ui.window_title") => "BunDeck — Panel de control",
        (Lang::En, "tab.status") => "Status",
        (Lang::Es, "tab.status") => "Estado",
        (Lang::En, "tab.log") => "Log",
        (Lang::Es, "tab.log") => "Registro",
        (Lang::En, "tab.settings") => "Settings",
        (Lang::Es, "tab.settings") => "Ajustes",
        (Lang::En, "sec.settings") => "SETTINGS",
        (Lang::Es, "sec.settings") => "AJUSTES",
        (Lang::En, "set.language") => "Language",
        (Lang::Es, "set.language") => "Idioma",
        (Lang::En, "set.language_hint") => "Interface language. Applies immediately.",
        (Lang::Es, "set.language_hint") => "Idioma de la interfaz. Se aplica al momento.",
        (Lang::En, "set.opt_en") => "English",
        (Lang::Es, "set.opt_en") => "Inglés",
        (Lang::En, "set.opt_es") => "Spanish",
        (Lang::Es, "set.opt_es") => "Español",
        (Lang::En, "set.autostart") => "Start with the system",
        (Lang::Es, "set.autostart") => "Iniciar con el sistema",
        (Lang::En, "set.autostart_hint") => "Open BunDeck when you turn on your computer.",
        (Lang::Es, "set.autostart_hint") => "Abre BunDeck al encender el ordenador.",
        (Lang::En, "set.start_minimized") => "Start minimized",
        (Lang::Es, "set.start_minimized") => "Iniciar minimizado",
        (Lang::En, "set.start_minimized_hint") => {
            "When starting automatically, keep only the tray icon (no window)."
        }
        (Lang::Es, "set.start_minimized_hint") => {
            "En el arranque automático, dejar solo el icono del tray (sin ventana)."
        }
        (Lang::En, "set.on") => "On",
        (Lang::Es, "set.on") => "Activado",
        (Lang::En, "set.off") => "Off",
        (Lang::Es, "set.off") => "Desactivado",
        (Lang::En, "set.saved") => "Setting saved.",
        (Lang::Es, "set.saved") => "Ajuste guardado.",
        (Lang::En, "set.save_failed") => "Could not save the setting.",
        (Lang::Es, "set.save_failed") => "No se pudo guardar el ajuste.",
        (Lang::En, "set.offline") => "Daemon offline: showing the locally stored value.",
        (Lang::Es, "set.offline") => "Daemon sin conexión: se muestra el valor guardado localmente.",
        (Lang::En, "sec.services") => "SERVICES",
        (Lang::Es, "sec.services") => "SERVICIOS",
        (_, "sec.daemon") => "DAEMON",
        (_, "svc.api") => "API",
        (_, "svc.ws") => "WebSocket",
        (_, "svc.frontend") => "Frontend",
        (Lang::En, "sec.updates") => "UPDATES",
        (Lang::Es, "sec.updates") => "ACTUALIZACIÓN",
        (Lang::En, "sec.open") => "OPEN",
        (Lang::Es, "sec.open") => "ABRIR",
        (Lang::En, "btn.start") => "Start",
        (Lang::Es, "btn.start") => "Iniciar",
        (Lang::En, "btn.stop") => "Stop",
        (Lang::Es, "btn.stop") => "Detener",
        (Lang::En, "btn.restart") => "Restart",
        (Lang::Es, "btn.restart") => "Reiniciar",
        (Lang::En, "btn.restart_launcher") => "Restart launcher",
        (Lang::Es, "btn.restart_launcher") => "Reiniciar launcher",
        (Lang::En, "btn.dashboard") => "Web panel",
        (Lang::Es, "btn.dashboard") => "Panel web",
        (Lang::En, "btn.hide_tray") => "Hide to tray",
        (Lang::Es, "btn.hide_tray") => "Ocultar al tray",
        (Lang::En, "btn.clear") => "Clear",
        (Lang::Es, "btn.clear") => "Limpiar",
        (Lang::En, "btn.quit") => "Quit",
        (Lang::Es, "btn.quit") => "Salir",
        (Lang::En, "btn.reopen_spotify") => "Reopen Spotify",
        (Lang::Es, "btn.reopen_spotify") => "Reabrir Spotify",
        (Lang::En, "btn.dismiss") => "Dismiss",
        (Lang::Es, "btn.dismiss") => "Descartar",
        (Lang::En, "update.installed") => "Installed {installed} · Latest {latest}",
        (Lang::Es, "update.installed") => "Instalada {installed} · Última {latest}",
        (Lang::En, "update.applied_restart") => {
            "Update applied; restart the launcher to load the changes."
        }
        (Lang::Es, "update.applied_restart") => {
            "Actualización aplicada; reinicia el launcher para cargar los cambios."
        }
        (Lang::En, "update.applying") => {
            "Applying the update; the panel will reopen when done."
        }
        (Lang::Es, "update.applying") => {
            "Aplicando la actualización; el panel volverá a abrirse al terminar."
        }
        (Lang::En, "update.downloaded") => "v{version} downloaded and verified; installing…",
        (Lang::Es, "update.downloaded") => "v{version} descargada y verificada; iniciando instalación…",
        (Lang::En, "update.downloading_bg") => "Downloading the update in the background…",
        (Lang::Es, "update.downloading_bg") => "Descargando la actualización en segundo plano…",
        (Lang::En, "update.checking_auto") => "Checking for updates automatically…",
        (Lang::Es, "update.checking_auto") => "Comprobando actualizaciones automáticamente…",
        (Lang::En, "update.new_detected") => "New version detected; automatic download in progress.",
        (Lang::Es, "update.new_detected") => "Nueva versión detectada; descarga automática en curso.",
        (Lang::En, "update.auto") => "Updates are checked automatically.",
        (Lang::Es, "update.auto") => "Las actualizaciones se buscan automáticamente.",
        (Lang::En, "update.log_section") => "LOG · POLL #{n}",
        (Lang::Es, "update.log_section") => "REGISTRO · SONDEO #{n}",
        (Lang::En, "dash.still_starting") => "Services still starting: leaving the window open.",
        (Lang::Es, "dash.still_starting") => "Servicios aún arrancando: dejo la ventana abierta.",
        (Lang::En, "panel.url") => "Panel: {url}",
        (Lang::Es, "panel.url") => "Panel: {url}",
        (Lang::En, "spotify.notice") => {
            "Spotify needs connection: the login window was opened on this computer; sign in and access will complete on its own."
        }
        (Lang::Es, "spotify.notice") => {
            "Spotify necesita conexión: se abrió la ventana de login en este equipo; inicia sesión y el acceso se completará solo."
        }
        // Diálogos de instancia única (Win32).
        (Lang::En, "dlg.check_fail") => "Could not check whether BunDeck is already open:\n\n{error}",
        (Lang::Es, "dlg.check_fail") => "No se pudo comprobar si BunDeck ya está abierto:\n\n{error}",
        (Lang::En, "dlg.already_open") => "BunDeck is already open",
        (Lang::Es, "dlg.already_open") => "BunDeck ya está abierto",
        (_, "dlg.app_title") => "BunDeck",
        (Lang::En, "dlg.meta_unreadable") => {
            "BunDeck is already open, but its data could not be read. Wait a few seconds and try again."
        }
        (Lang::Es, "dlg.meta_unreadable") => {
            "Ya hay otra instancia de BunDeck abierta, pero no pude leer sus datos. Espera unos segundos e inténtalo de nuevo."
        }
        (Lang::En, "dlg.meta_stale") => {
            "BunDeck seemed open but its process no longer exists. If it persists, wait a few seconds and try again."
        }
        (Lang::Es, "dlg.meta_stale") => {
            "BunDeck parecía abierto pero su proceso ya no existe. Si persiste, espera unos segundos e inténtalo de nuevo."
        }
        (Lang::En, "dlg.not_launcher") => {
            "BunDeck is already open, but the process could not be confirmed as the panel. It will not be closed for safety; close it from the tray (Quit) and try again."
        }
        (Lang::Es, "dlg.not_launcher") => {
            "Ya hay BunDeck abierto, pero no pude confirmar que el proceso sea el panel. No lo cerraré por seguridad; ciérralo desde el tray (Salir) e inténtalo de nuevo."
        }
        (Lang::En, "dlg.replace_ask") => {
            "BunDeck is already open in {mode} mode (PID {pid}).\n\nDo you want to close it and start this instance?\nNo: cancel; the previous instance keeps running."
        }
        (Lang::Es, "dlg.replace_ask") => {
            "Ya hay BunDeck abierto en modo {mode} (PID {pid}).\n\n¿Quieres cerrarlo y arrancar esta instancia?\nNo: cancelar; la instancia anterior seguirá ejecutándose."
        }
        (Lang::En, "dlg.could_not_close") => {
            "Could not close the previous instance. BunDeck will stay open in its place."
        }
        (Lang::Es, "dlg.could_not_close") => {
            "No se pudo cerrar la instancia anterior. BunDeck seguirá abierto en su lugar."
        }
        (Lang::En, "dlg.lock_timeout") => {
            "The previous instance did not release control in time. A second copy was not started."
        }
        (Lang::Es, "dlg.lock_timeout") => {
            "La instancia anterior no liberó el control a tiempo. No se inició una segunda copia."
        }
        // Servidor ya activo (prepare_existing_server).
        (Lang::En, "dlg.server_active_port") => " on :{port}",
        (Lang::Es, "dlg.server_active_port") => " en :{port}",
        (Lang::En, "dlg.server_active") => {
            "There is already an active BunDeck service{port} (v{version}, {mode}).\n\nYes: close it and start a new one.\nNo: keep it and open the panel with that server."
        }
        (Lang::Es, "dlg.server_active") => {
            "Ya hay un servicio BunDeck activo{port} (v{version}, {mode}).\n\nSí: cerrarlo y arrancar uno nuevo.\nNo: conservarlo y abrir el panel con ese servidor."
        }
        (Lang::En, "dlg.server_dev_mode") => "development (Astro on :4321)",
        (Lang::Es, "dlg.server_dev_mode") => "desarrollo (Astro en :4321)",
        (Lang::En, "dlg.server_prod_mode") => "production / BunDeck server",
        (Lang::Es, "dlg.server_prod_mode") => "producción / servidor BunDeck",
        (Lang::En, "dlg.server_keep") => {
            "The active server rejected the shutdown order. It will be kept and BunDeck will not start a duplicate copy."
        }        (Lang::Es, "dlg.server_keep") => {
            "El servidor activo no aceptó la orden de cierre. Se conservará y BunDeck no iniciará una copia duplicada."
        }
        (Lang::En, "dlg.server_still_up") => {
            "The BunDeck server is still responding. The panel will open connected to the existing server."
        }
        (Lang::Es, "dlg.server_still_up") => {
            "El servidor BunDeck sigue respondiendo. Se abrirá el panel conectado al servidor existente."
        }
        (Lang::En, "dlg.server_unavailable") => "API unavailable",
        (Lang::Es, "dlg.server_unavailable") => "API no disponible",
        (Lang::En, "dlg.dev_no_astro") => {
            "The daemon stopped, but the Astro process on :4321 could not be identified. It will not be closed; the panel remains available."
        }
        (Lang::Es, "dlg.dev_no_astro") => {
            "Se detuvo el daemon, pero no pude identificar el proceso de Astro en :4321. No lo cerraré; el panel seguirá disponible."
        }
        (Lang::En, "dlg.dev_not_bundeck") => {
            "There is a process listening on :4321, but it could not be confirmed as BunDeck/Astro. It will not be closed; the panel remains available."
        }
        (Lang::Es, "dlg.dev_not_bundeck") => {
            "Hay un proceso escuchando en :4321, pero no pude confirmar que sea BunDeck/Astro. No lo cerraré; el panel seguirá disponible."
        }
        (Lang::En, "dlg.dev_no_close") => {
            "The daemon stopped, but the development server on :4321 could not be closed. The panel remains available and will use whichever services respond."
        }
        (Lang::Es, "dlg.dev_no_close") => {
            "Se detuvo el daemon, pero no se pudo cerrar el servidor de desarrollo en :4321. El panel seguirá disponible y usará los servicios que respondan."
        }
        _ => "",
    }
}

/// Plantilla con `{nombre}` sustituidos por pares clave/valor.
pub fn format_in(lang: Lang, key: &str, args: &[(&str, &str)]) -> String {
    let mut out = get_in(lang, key).to_string();
    for (name, value) in args {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}

/// `format_in` con el idioma efectivo.
pub fn format(key: &str, args: &[(&str, &str)]) -> String {
    format_in(effective(), key, args)
}

/// Texto localizado como UTF-16 nul-terminado para Win32 (sin `w!`).
#[cfg(windows)]
pub fn wide(key: &str) -> Vec<u16> {
    get(key).encode_utf16().chain([0]).collect()
}

/// Plantilla localizada como UTF-16 nul-terminado para Win32.
#[cfg(windows)]
pub fn wide_format(key: &str, args: &[(&str, &str)]) -> Vec<u16> {
    format(key, args).encode_utf16().chain([0]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Paridad de claves: toda clave existe en ambos idiomas y sin
    /// huecos de traducción (vacío = falta traducir).
    #[test]
    fn key_parity_across_languages() {
        let keys = [
            "tray.open_panel",
            "tray.open_web",
            "tray.quit",
            "tray.tip",
            "state.ok",
            "state.starting",
            "state.down",
            "state.checking",
            "common.unknown",
            "ui.subtitle",
            "ui.window_title",
            "tab.status",
            "tab.log",
            "tab.settings",
            "sec.settings",
            "set.language",
            "set.language_hint",
            "set.opt_en",
            "set.opt_es",
            "set.autostart",
            "set.autostart_hint",
            "set.start_minimized",
            "set.start_minimized_hint",
            "set.on",
            "set.off",
            "set.saved",
            "set.save_failed",
            "set.offline",
            "sec.services",
            "sec.daemon",
            "svc.api",
            "svc.ws",
            "svc.frontend",
            "sec.updates",
            "sec.open",
            "btn.start",
            "btn.stop",
            "btn.restart",
            "btn.restart_launcher",
            "btn.dashboard",
            "btn.hide_tray",
            "btn.clear",
            "btn.quit",
            "btn.reopen_spotify",
            "btn.dismiss",
            "update.installed",
            "update.applied_restart",
            "update.applying",
            "update.downloaded",
            "update.downloading_bg",
            "update.checking_auto",
            "update.new_detected",
            "update.auto",
            "update.log_section",
            "dash.still_starting",
            "panel.url",
            "spotify.notice",
            "dlg.check_fail",
            "dlg.already_open",
            "dlg.app_title",
            "dlg.meta_unreadable",
            "dlg.meta_stale",
            "dlg.not_launcher",
            "dlg.replace_ask",
            "dlg.could_not_close",
            "dlg.lock_timeout",
            "dlg.server_active_port",
            "dlg.server_active",
            "dlg.server_dev_mode",
            "dlg.server_prod_mode",
            "dlg.server_keep",
            "dlg.server_still_up",
            "dlg.server_unavailable",
            "dlg.dev_no_astro",
            "dlg.dev_not_bundeck",
            "dlg.dev_no_close",
        ];
        for key in keys {
            let en = get_in(Lang::En, key);
            let es = get_in(Lang::Es, key);
            assert!(!en.is_empty(), "missing EN for {key}");
            assert!(!es.is_empty(), "missing ES for {key}");
        }
        // Clave desconocida → vacío en ambos (fallback inglés del llamador).
        assert_eq!(get_in(Lang::En, "nope.missing"), "");
        assert_eq!(get_in(Lang::Es, "nope.missing"), "");
    }

    /// Whitelist de detección: soportado se usa, el resto cae a inglés.
    #[test]
    fn lang_from_code_whitelist() {
        assert_eq!(Lang::from_code("en"), Some(Lang::En));
        assert_eq!(Lang::from_code("es"), Some(Lang::Es));
        assert_eq!(Lang::from_code("es-ES"), Some(Lang::Es));
        assert_eq!(Lang::from_code("es_ES.UTF-8"), Some(Lang::Es));
        assert_eq!(Lang::from_code("EN"), Some(Lang::En));
        assert_eq!(Lang::from_code("fr"), None);
        assert_eq!(Lang::from_code("de-DE"), None);
        assert_eq!(Lang::from_code(""), None);
        // detect() nunca devuelve un idioma fuera de la whitelist.
        assert!(SUPPORTED.contains(&detect().code()));
    }

    #[test]
    fn format_replaces_placeholders() {
        let s = format_in(Lang::En, "update.installed", &[("installed", "v1"), ("latest", "v2")]);
        assert_eq!(s, "Installed v1 · Latest v2");
        let s = format_in(
            Lang::Es,
            "dlg.replace_ask",
            &[("mode", "prod"), ("pid", "123")],
        );
        assert!(s.contains("modo prod (PID 123)"));
    }
}
