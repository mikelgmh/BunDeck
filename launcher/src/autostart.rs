//! Autostart real del sistema, gobernado por los settings del daemon.
//!
//! FLUJO (ver `daemon/src/system-autostart.ts`):
//! la web guarda `system.autostart` ('true'/'false') y
//! `system.start_minimized` ('true'/'false', default ON) vía POST
//! `/api/v1/settings`; este launcher los lee en su sondeo (cada 2s, mismo
//! ritmo que `snapshot()`) y aplica el mecanismo del SO:
//! - Windows: valor `LibreDeck` en `HKCU\...\Run` (el tray es de este
//!   launcher — `tray.rs` — y siempre está activo, sin toggle).
//! - Linux: `~/.config/autostart/libredeck.desktop`.
//! - macOS: `~/Library/LaunchAgents/com.libredeck.launcher.plist`.
//!
//! Cuando `start_minimized` es true, el ejecutable se registra con el flag
//! `--minimized`: el arranque automático no roba la ventana (solo ancla +
//! tray). Se mantiene Run (y NO Task Scheduler): Run respeta el flag y no
//! pide elevación; el Scheduler exigiría tarea logon + salvedades UAC.
//!
//! En dev (`DEV_MODE=true`) NO se toca el sistema: solo se registra lo que
//! se haría. Funciona igual en dev e instalado porque el objetivo es el
//! propio ejecutable (`std::env::current_exe()`).

use std::time::Duration;

/// Clave canónica en la tabla `settings` del daemon.
pub const AUTOSTART_KEY: &str = "system.autostart";
/// Iniciar minimizado (solo tray) cuando arranca por autostart.
pub const START_MINIMIZED_KEY: &str = "system.start_minimized";
/// Nombre del valor/fichero en el SO.
pub const APP_NAME: &str = "LibreDeck";
/// Flag que el launcher entiende al arrancar (ver `main.rs`).
pub const MINIMIZED_FLAG: &str = "--minimized";
/// Caché local de las preferencias (fallback cuando la API no responde).
pub const STARTUP_CACHE_FILE: &str = "launcher-startup.json";

/// Preferencias de arranque leídas del daemon (o de la caché local).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartupPrefs {
    pub autostart: bool,
    pub start_minimized: bool,
}

impl StartupPrefs {
    pub fn new(autostart: bool, start_minimized: bool) -> Self {
        Self {
            autostart,
            start_minimized,
        }
    }
}

/// Último valor aplicado en esta sesión: evita reescribir el registro / los
/// ficheros en cada sondeo (el sondeo corre cada 2s).
static LAST_APPLIED: std::sync::Mutex<Option<StartupPrefs>> = std::sync::Mutex::new(None);

/// En dev no se toca el autostart del sistema (solo log).
pub fn dev_mode() -> bool {
    std::env::var("DEV_MODE").as_deref() == Ok("true")
}

/// Parseo tolerante: la web guarda `JSON.stringify(bool)` ("true"/"false");
/// semillas antiguas o ediciones a mano pueden usar "1"/"0".
pub fn parse_setting(raw: &str) -> bool {
    let v = raw.trim().to_lowercase();
    // Aceptar JSON primero ("true", "1", "false", "0").
    if let Ok(b) = v.parse::<bool>() {
        return b;
    }
    if let Ok(n) = v.parse::<i64>() {
        return n != 0;
    }
    matches!(v.as_str(), "1" | "on" | "yes" | "enabled")
}

/// Parseo fail-open para `system.start_minimized`: ausente o ilegible →
/// true (el arranque automático no debe robar la ventana). Solo las formas
/// explícitas de apagado dan false.
pub fn parse_start_minimized(raw: &str) -> bool {
    let v = raw.trim().to_lowercase();
    if v.is_empty() {
        return true;
    }
    if let Ok(b) = v.parse::<bool>() {
        return b;
    }
    if let Ok(n) = v.parse::<i64>() {
        return n != 0;
    }
    !matches!(v.as_str(), "false" | "0" | "no" | "off" | "disabled")
}

fn read_raw_setting(key: &str) -> Option<String> {
    let url = format!(
        "http://127.0.0.1:{}/api/v1/settings?key={key}",
        super::monitor::api_port()
    );
    let agent: ureq::Agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_millis(1200)))
            .timeout_per_read(Some(Duration::from_millis(1200)))
            .timeout_per_write(Some(Duration::from_millis(1200)))
            .build(),
    );
    let mut body = agent.get(&url).call().ok()?;
    let v: serde_json::Value = body.body_mut().read_json().ok()?;
    let raw = v.get("value")?.as_str()?;
    Some(raw.to_string())
}

/// Lee `system.autostart` del daemon. `None` = daemon caído o sin setting
/// (en ese caso no se toca nada del SO).
pub fn read_setting() -> Option<bool> {
    read_raw_setting(AUTOSTART_KEY).map(|raw| parse_setting(&raw))
}

/// Lee `system.start_minimized` del daemon (`None` si no responde).
/// Fail-open: ausente o ilegible en el daemon → true.
pub fn read_start_minimized() -> Option<bool> {
    read_raw_setting(START_MINIMIZED_KEY).map(|raw| parse_start_minimized(&raw))
}

/// Ruta de la caché local de preferencias (junto a `launcher-update.log`).
pub fn startup_cache_path() -> std::path::PathBuf {
    super::updater::user_data_dir().join(STARTUP_CACHE_FILE)
}

/// Lee la caché local (`None` si no existe o es ilegible).
pub fn load_cached_startup() -> Option<StartupPrefs> {
    load_cached_startup_at(&startup_cache_path())
}

fn load_cached_startup_at(path: &std::path::Path) -> Option<StartupPrefs> {
    let raw = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let autostart = match v.get("autostart") {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => parse_setting(s),
        Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
        _ => return None,
    };
    // `start_minimized` ausente en cachés viejas → default ON.
    let start_minimized = match v.get("start_minimized") {
        None => true,
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => parse_start_minimized(s),
        Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
        _ => true,
    };
    Some(StartupPrefs::new(autostart, start_minimized))
}

/// Persiste las preferencias en la caché local (best-effort).
pub fn save_cached_startup(prefs: StartupPrefs) {
    save_cached_startup_at(&startup_cache_path(), prefs);
}

fn save_cached_startup_at(path: &std::path::Path, prefs: StartupPrefs) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let body = serde_json::json!({
        "autostart": prefs.autostart,
        "start_minimized": prefs.start_minimized,
    });
    let _ = std::fs::write(path, body.to_string());
}

/// Lee las preferencias: API del daemon y, si no responde, la caché local.
/// Cuando la API responde, la caché se actualiza. `None` = ni API ni caché.
pub fn read_startup() -> Option<StartupPrefs> {
    match (read_setting(), read_start_minimized()) {
        (Some(autostart), Some(start_minimized)) => {
            let prefs = StartupPrefs::new(autostart, start_minimized);
            save_cached_startup(prefs);
            Some(prefs)
        }
        (Some(autostart), None) => {
            // `start_minimized` ausente en el daemon (DB anterior a la
            // semilla): default ON sin machacar nada.
            let cached_minimized = load_cached_startup().map(|p| p.start_minimized).unwrap_or(true);
            let prefs = StartupPrefs::new(autostart, cached_minimized);
            save_cached_startup(prefs);
            Some(prefs)
        }
        (None, _) => load_cached_startup(),
    }
}

/// ¿El autostart está registrado en el SO? (lectura real, sin efectos).
pub fn is_enabled() -> bool {
    #[cfg(windows)]
    {
        is_enabled_windows()
    }
    #[cfg(target_os = "linux")]
    {
        linux_enabled_at(&default_linux_file())
    }
    #[cfg(target_os = "macos")]
    {
        macos_enabled_at(&default_macos_file())
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        false
    }
}

/// Punto de entrada del sondeo: lee los settings y, solo si cambiaron desde
/// la última aplicación, los lleva al SO. Nunca lanza pánico.
pub fn sync_from_daemon() {
    let Some(prefs) = read_startup() else {
        return;
    };
    let changed = match LAST_APPLIED.lock() {
        Ok(mut last) => {
            if *last == Some(prefs) {
                return;
            }
            *last = Some(prefs);
            true
        }
        Err(_) => true,
    };
    if !changed {
        return;
    }
    if dev_mode() {
        eprintln!(
            "[autostart] DEV_MODE: no se toca el sistema (se aplicaría autostart={} start_minimized={})",
            prefs.autostart, prefs.start_minimized
        );
        return;
    }
    if let Err(e) = apply(prefs.autostart, prefs.start_minimized) {
        eprintln!(
            "[autostart] no se pudo aplicar autostart={} start_minimized={}: {e}",
            prefs.autostart, prefs.start_minimized
        );
        // Reintentar en el próximo sondeo.
        if let Ok(mut last) = LAST_APPLIED.lock() {
            *last = None;
        }
    }
}

/// Aplica el autostart del SO. El ejecutable registrado es este launcher
/// (que a su vez spawnea/gestiona el daemon); con `start_minimized` se
/// añade el flag `--minimized` para que el arranque no robe la ventana.
pub fn apply(enabled: bool, start_minimized: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    #[cfg(windows)]
    {
        apply_windows(enabled, &exe, start_minimized)
    }
    #[cfg(target_os = "linux")]
    {
        apply_linux(enabled, &exe, start_minimized)
    }
    #[cfg(target_os = "macos")]
    {
        apply_macos(enabled, &exe, start_minimized)
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = (enabled, start_minimized, exe);
        Err("SO no soportado para autostart".to_string())
    }
}

// ---- Windows: HKCU\Software\Microsoft\Windows\CurrentVersion\Run ----
// (Subclave Run por usuario: no pide admin. Se mantiene Run frente a Task
// Scheduler: Run respeta el flag `--minimized` y no exige tarea logon ni
// salvedades UAC.)

/// Comando `reg` para aplicar el autostart (puro: apto para tests).
#[cfg(windows)]
fn windows_reg_command(
    enabled: bool,
    exe: &std::path::Path,
    start_minimized: bool,
) -> (String, Vec<String>) {
    let mut value = format!("\"{}\"", exe.to_string_lossy());
    if enabled && start_minimized {
        value.push_str(&format!(" {MINIMIZED_FLAG}"));
    }
    if enabled {
        (
            "reg".to_string(),
            vec![
                "add".to_string(),
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run".to_string(),
                "/v".to_string(),
                APP_NAME.to_string(),
                "/t".to_string(),
                "REG_SZ".to_string(),
                "/d".to_string(),
                value,
                "/f".to_string(),
            ],
        )
    } else {
        (
            "reg".to_string(),
            vec![
                "delete".to_string(),
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run".to_string(),
                "/v".to_string(),
                APP_NAME.to_string(),
                "/f".to_string(),
            ],
        )
    }
}

#[cfg(windows)]
fn is_enabled_windows() -> bool {
    std::process::Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            APP_NAME,
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn apply_windows(
    enabled: bool,
    exe: &std::path::Path,
    start_minimized: bool,
) -> Result<(), String> {
    // `reg.exe` evita una dependencia nueva (winreg) para dos operaciones.
    let (prog, args) = windows_reg_command(enabled, exe, start_minimized);
    let st = std::process::Command::new(prog)
        .args(&args)
        .output()
        .map_err(|e| format!("reg: {e}"))?;
    if enabled {
        if st.status.success() {
            Ok(())
        } else {
            Err(format!("reg add salió con {}", st.status))
        }
    } else if st.status.success() || st.status.code() == Some(1) {
        // Borrar lo inexistente (código 1) también vale como "apagado".
        Ok(())
    } else {
        Err(format!("reg delete salió con {}", st.status))
    }
}

// ---- Linux: XDG autostart ----

/// Contenido del `.desktop` XDG para arrancar este launcher al entrar.
pub fn linux_desktop_contents(exe: &std::path::Path, start_minimized: bool) -> String {
    let exec = if start_minimized {
        format!("\"{}\" {MINIMIZED_FLAG}", exe.to_string_lossy())
    } else {
        format!("\"{}\"", exe.to_string_lossy())
    };
    format!(
        "[Desktop Entry]\nType=Application\nName={APP_NAME}\nExec={exec}\nX-GNOME-Autostart-enabled=true\n"
    )
}

#[cfg(target_os = "linux")]
fn default_linux_file() -> std::path::PathBuf {
    autostart_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("libredeck.desktop")
}

#[cfg(target_os = "linux")]
fn autostart_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .map(|h| std::path::PathBuf::from(h).join(".config").join("autostart"))
}

fn linux_enabled_at(file: &std::path::Path) -> bool {
    file.is_file()
}

#[cfg(target_os = "linux")]
fn apply_linux(enabled: bool, exe: &std::path::Path, start_minimized: bool) -> Result<(), String> {
    let dir = autostart_dir().ok_or("sin $HOME".to_string())?;
    write_linux_desktop(&dir.join("libredeck.desktop"), enabled, exe, start_minimized)
}

fn write_linux_desktop(
    file: &std::path::Path,
    enabled: bool,
    exe: &std::path::Path,
    start_minimized: bool,
) -> Result<(), String> {
    if enabled {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("mkdir autostart: {e}"))?;
        }
        std::fs::write(file, linux_desktop_contents(exe, start_minimized))
            .map_err(|e| format!("write {}: {e}", file.display()))?;
    } else if file.exists() {
        std::fs::remove_file(file).map_err(|e| format!("rm {}: {e}", file.display()))?;
    }
    Ok(())
}

// ---- macOS: LaunchAgents ----

/// Contenido del plist de LaunchAgents (arranca al login del usuario).
pub fn macos_plist_contents(exe: &std::path::Path, start_minimized: bool) -> String {
    let extra = if start_minimized {
        format!("\n\t\t<string>{MINIMIZED_FLAG}</string>")
    } else {
        String::new()
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
         \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n\
         \t<key>Label</key>\n\t<string>com.libredeck.launcher</string>\n\
         \t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>{}</string>{extra}\n\t</array>\n\
         \t<key>RunAtLoad</key>\n\t<true/>\n</dict>\n</plist>\n",
        exe.to_string_lossy()
    )
}

#[cfg(target_os = "macos")]
fn default_macos_file() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .map(|h| {
            std::path::PathBuf::from(h)
                .join("Library")
                .join("LaunchAgents")
                .join("com.libredeck.launcher.plist")
        })
        .unwrap_or_else(|| std::path::PathBuf::from("com.libredeck.launcher.plist"))
}

fn macos_enabled_at(file: &std::path::Path) -> bool {
    file.is_file()
}

#[cfg(target_os = "macos")]
fn apply_macos(enabled: bool, exe: &std::path::Path, start_minimized: bool) -> Result<(), String> {
    write_macos_plist(&default_macos_file(), enabled, exe, start_minimized)
}

fn write_macos_plist(
    file: &std::path::Path,
    enabled: bool,
    exe: &std::path::Path,
    start_minimized: bool,
) -> Result<(), String> {
    if enabled {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("mkdir LaunchAgents: {e}"))?;
        }
        std::fs::write(file, macos_plist_contents(exe, start_minimized))
            .map_err(|e| format!("write {}: {e}", file.display()))?;
    } else if file.exists() {
        std::fs::remove_file(file).map_err(|e| format!("rm {}: {e}", file.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_acepta_formas_de_la_web_y_semillas() {
        assert!(parse_setting("true"));
        assert!(parse_setting("1"));
        assert!(parse_setting("  TRUE "));
        assert!(!parse_setting("false"));
        assert!(!parse_setting("0"));
        assert!(!parse_setting(""));
        assert!(!parse_setting("maybe"));
    }

    #[test]
    fn parse_start_minimized_es_fail_open() {
        // Ausente o ilegible → true (el arranque no roba la ventana).
        assert!(parse_start_minimized(""));
        assert!(parse_start_minimized("basura"));
        assert!(parse_start_minimized("true"));
        assert!(parse_start_minimized("1"));
        assert!(parse_start_minimized("  TRUE "));
        // Solo el veto explícito apaga.
        assert!(!parse_start_minimized("false"));
        assert!(!parse_start_minimized("0"));
        assert!(!parse_start_minimized("off"));
        assert!(!parse_start_minimized("no"));
        assert!(!parse_start_minimized("disabled"));
    }

    #[test]
    fn desktop_xdg_contiene_exec_y_nombre() {
        let c = linux_desktop_contents(std::path::Path::new("/opt/bundeck/launcher"), false);
        assert!(c.contains("[Desktop Entry]"));
        assert!(c.contains("/opt/bundeck/launcher"));
        assert!(c.contains("LibreDeck"));
        assert!(!c.contains(MINIMIZED_FLAG));
    }

    #[test]
    fn desktop_xdg_minimizado_anade_flag() {
        let c = linux_desktop_contents(std::path::Path::new("/opt/bundeck/launcher"), true);
        assert!(c.contains(&format!("{MINIMIZED_FLAG}")));
        assert!(c.contains("Exec=\"/opt/bundeck/launcher\" --minimized"));
    }

    #[test]
    fn plist_macos_arranca_al_login() {
        let c = macos_plist_contents(std::path::Path::new("/Applications/BunDeck.app/launcher"), false);
        assert!(c.contains("com.libredeck.launcher"));
        assert!(c.contains("RunAtLoad"));
        assert!(c.contains("/Applications/BunDeck.app/launcher"));
        assert!(!c.contains(MINIMIZED_FLAG));
    }

    #[test]
    fn plist_macos_minimizado_anade_flag() {
        let c = macos_plist_contents(std::path::Path::new("/Applications/BunDeck.app/launcher"), true);
        assert!(c.contains(&format!("<string>{MINIMIZED_FLAG}</string>")));
    }

    #[test]
    fn dev_mode_respeta_la_env() {
        // Guardar/restaurar para no contaminar otros tests (mismo proceso).
        let prev = std::env::var("DEV_MODE").ok();
        std::env::set_var("DEV_MODE", "true");
        assert!(dev_mode());
        std::env::set_var("DEV_MODE", "false");
        assert!(!dev_mode());
        match prev {
            Some(v) => std::env::set_var("DEV_MODE", v),
            None => std::env::remove_var("DEV_MODE"),
        }
    }

    #[test]
    fn startup_cache_roundtrip_con_dir_temporal() {
        let dir = std::env::temp_dir().join(format!(
            "ld-startup-cache-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let path = dir.join(STARTUP_CACHE_FILE);
        save_cached_startup_at(&path, StartupPrefs::new(true, true));
        assert_eq!(
            load_cached_startup_at(&path),
            Some(StartupPrefs::new(true, true))
        );
        save_cached_startup_at(&path, StartupPrefs::new(false, false));
        assert_eq!(
            load_cached_startup_at(&path),
            Some(StartupPrefs::new(false, false))
        );
        // Caché vieja sin `start_minimized` → default ON.
        std::fs::write(&path, r#"{"autostart":true}"#).unwrap();
        assert_eq!(
            load_cached_startup_at(&path),
            Some(StartupPrefs::new(true, true))
        );
        // Caché corrupta → None (no se toca el SO).
        std::fs::write(&path, "no-json").unwrap();
        assert_eq!(load_cached_startup_at(&path), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn linux_desktop_write_con_exe_falso_en_dir_temporal() {
        let dir = std::env::temp_dir().join(format!(
            "ld-linux-autostart-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let file = dir.join("libredeck.desktop");
        let exe = std::path::Path::new("/fake/dir/launcher-test");
        assert!(!linux_enabled_at(&file));
        write_linux_desktop(&file, true, exe, true).unwrap();
        assert!(linux_enabled_at(&file));
        let c = std::fs::read_to_string(&file).unwrap();
        assert!(c.contains(MINIMIZED_FLAG));
        write_linux_desktop(&file, false, exe, true).unwrap();
        assert!(!linux_enabled_at(&file));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn macos_plist_write_con_exe_falso_en_dir_temporal() {
        let dir = std::env::temp_dir().join(format!(
            "ld-macos-autostart-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let file = dir.join("com.libredeck.launcher.plist");
        let exe = std::path::Path::new("/fake/BunDeck.app/launcher-test");
        assert!(!macos_enabled_at(&file));
        write_macos_plist(&file, true, exe, false).unwrap();
        assert!(macos_enabled_at(&file));
        let c = std::fs::read_to_string(&file).unwrap();
        assert!(!c.contains(MINIMIZED_FLAG));
        write_macos_plist(&file, false, exe, false).unwrap();
        assert!(!macos_enabled_at(&file));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_registro_lleva_flag_minimized() {
        let exe = std::path::Path::new(r"C:\fake\dir\bundeck-launcher.exe");
        let (prog, args) = windows_reg_command(true, exe, true);
        assert_eq!(prog, "reg");
        let joined = args.join(" ");
        assert!(joined.contains(MINIMIZED_FLAG));
        assert!(joined.contains("bundeck-launcher.exe"));
        let (_, args_plain) = windows_reg_command(true, exe, false);
        assert!(!args_plain.join(" ").contains(MINIMIZED_FLAG));
        let (_, args_off) = windows_reg_command(false, exe, true);
        assert!(args_off.contains(&"delete".to_string()));
        assert!(!args_off.join(" ").contains(MINIMIZED_FLAG));
    }

    #[cfg(windows)]
    #[test]
    fn is_enabled_no_lanza_panico() {
        // Lectura real del registro (solo query): no debe fallar nunca.
        let _ = is_enabled();
    }

    #[cfg(not(windows))]
    #[test]
    fn is_enabled_no_lanza_panico() {
        let _ = is_enabled();
    }
}
