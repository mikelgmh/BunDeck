//! Autostart real del sistema, gobernado por el setting del daemon.
//!
//! FLUJO (ver `daemon/src/system-autostart.ts`):
//! la web guarda `system.autostart` ('true'/'false') vía POST
//! `/api/v1/settings`; este launcher lo lee en su sondeo (cada 2s, mismo
//! ritmo que `snapshot()`) y aplica el mecanismo del SO:
//! - Windows: valor `LibreDeck` en `HKCU\...\Run` (el tray es de este
//!   launcher — `tray.rs` — y siempre está activo, sin toggle).
//! - Linux: `~/.config/autostart/libredeck.desktop`.
//! - macOS: `~/Library/LaunchAgents/com.libredeck.launcher.plist`.
//!
//! En dev (`DEV_MODE=true`) NO se toca el sistema: solo se registra lo que
//! se haría. Funciona igual en dev e instalado porque el objetivo es el
//! propio ejecutable (`std::env::current_exe()`).

use std::time::Duration;

/// Clave canónica en la tabla `settings` del daemon.
pub const AUTOSTART_KEY: &str = "system.autostart";
/// Nombre del valor/fichero en el SO.
pub const APP_NAME: &str = "LibreDeck";

/// Último valor aplicado en esta sesión: evita reescribir el registro / los
/// ficheros en cada sondeo (el sondeo corre cada 2s).
static LAST_APPLIED: std::sync::Mutex<Option<bool>> = std::sync::Mutex::new(None);

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

/// Lee `system.autostart` del daemon. `None` = daemon caído o sin setting
/// (en ese caso no se toca nada del SO).
pub fn read_setting() -> Option<bool> {
    let url = format!(
        "http://127.0.0.1:{}/api/v1/settings?key={AUTOSTART_KEY}",
        super::monitor::api_port()
    );
    let agent: ureq::Agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(1200))
        .timeout_read(Duration::from_millis(1200))
        .timeout_write(Duration::from_millis(1200))
        .build();
    let body = agent.get(&url).call().ok()?;
    let v: serde_json::Value = body.into_json().ok()?;
    let raw = v.get("value")?.as_str()?;
    Some(parse_setting(raw))
}

/// Punto de entrada del sondeo: lee el setting y, solo si cambió desde la
/// última aplicación, lo lleva al SO. Nunca lanza pánico.
pub fn sync_from_daemon() {
    let Some(enabled) = read_setting() else {
        return;
    };
    let changed = match LAST_APPLIED.lock() {
        Ok(mut last) => {
            if *last == Some(enabled) {
                return;
            }
            *last = Some(enabled);
            true
        }
        Err(_) => true,
    };
    if !changed {
        return;
    }
    if dev_mode() {
        eprintln!("[autostart] DEV_MODE: no se toca el sistema (se aplicaría enabled={enabled})");
        return;
    }
    if let Err(e) = apply(enabled) {
        eprintln!("[autostart] no se pudo aplicar enabled={enabled}: {e}");
        // Reintentar en el próximo sondeo.
        if let Ok(mut last) = LAST_APPLIED.lock() {
            *last = None;
        }
    }
}

/// Aplica el autostart del SO. El ejecutable registrado es este launcher
/// (que a su vez spawnea/gestiona el daemon).
pub fn apply(enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    #[cfg(windows)]
    {
        apply_windows(enabled, &exe)
    }
    #[cfg(target_os = "linux")]
    {
        apply_linux(enabled, &exe)
    }
    #[cfg(target_os = "macos")]
    {
        apply_macos(enabled, &exe)
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = (enabled, exe);
        Err("SO no soportado para autostart".to_string())
    }
}

// ---- Windows: HKCU\Software\Microsoft\Windows\CurrentVersion\Run ----
// (Subclave Run por usuario: no pide admin.)

#[cfg(windows)]
fn apply_windows(enabled: bool, exe: &std::path::Path) -> Result<(), String> {
    // `reg.exe` evita una dependencia nueva (winreg) para dos operaciones.
    let exe_s = exe.to_string_lossy();
    if enabled {
        let st = std::process::Command::new("reg")
            .args(["add", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v", APP_NAME, "/t", "REG_SZ", "/d", &format!("\"{exe_s}\""),
                "/f"])
            .output()
            .map_err(|e| format!("reg add: {e}"))?;
        if st.status.success() {
            Ok(())
        } else {
            Err(format!("reg add salió con {}", st.status))
        }
    } else {
        let st = std::process::Command::new("reg")
            .args(["delete", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v", APP_NAME, "/f"])
            .output()
            .map_err(|e| format!("reg delete: {e}"))?;
        // Borrar lo inexistente (código 1) también vale como "apagado".
        if st.status.success() || st.status.code() == Some(1) {
            Ok(())
        } else {
            Err(format!("reg delete salió con {}", st.status))
        }
    }
}

// ---- Linux: XDG autostart ----

/// Contenido del `.desktop` XDG para arrancar este launcher al entrar.
#[allow(dead_code)] // Solo se usa en el build de Linux.
pub fn linux_desktop_contents(exe: &std::path::Path) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName={APP_NAME}\nExec=\"{}\"\nX-GNOME-Autostart-enabled=true\n",
        exe.to_string_lossy()
    )
}

#[cfg(target_os = "linux")]
fn autostart_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .map(|h| std::path::PathBuf::from(h).join(".config").join("autostart"))
}

#[cfg(target_os = "linux")]
fn apply_linux(enabled: bool, exe: &std::path::Path) -> Result<(), String> {
    let dir = autostart_dir().ok_or("sin $HOME".to_string())?;
    let file = dir.join("libredeck.desktop");
    if enabled {
        std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir autostart: {e}"))?;
        std::fs::write(&file, linux_desktop_contents(exe))
            .map_err(|e| format!("write {}: {e}", file.display()))?;
    } else if file.exists() {
        std::fs::remove_file(&file).map_err(|e| format!("rm {}: {e}", file.display()))?;
    }
    Ok(())
}

// ---- macOS: LaunchAgents ----

/// Contenido del plist de LaunchAgents (arranca al login del usuario).
#[allow(dead_code)] // Solo se usa en el build de macOS.
pub fn macos_plist_contents(exe: &std::path::Path) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
         \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n\
         \t<key>Label</key>\n\t<string>com.libredeck.launcher</string>\n\
         \t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>{}</string>\n\t</array>\n\
         \t<key>RunAtLoad</key>\n\t<true/>\n</dict>\n</plist>\n",
        exe.to_string_lossy()
    )
}

#[cfg(target_os = "macos")]
fn apply_macos(enabled: bool, exe: &std::path::Path) -> Result<(), String> {
    let home = std::env::var_os("HOME").ok_or("sin $HOME".to_string())?;
    let file = std::path::PathBuf::from(home)
        .join("Library")
        .join("LaunchAgents")
        .join("com.libredeck.launcher.plist");
    if enabled {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("mkdir LaunchAgents: {e}"))?;
        }
        std::fs::write(&file, macos_plist_contents(exe))
            .map_err(|e| format!("write {}: {e}", file.display()))?;
    } else if file.exists() {
        std::fs::remove_file(&file).map_err(|e| format!("rm {}: {e}", file.display()))?;
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
    fn desktop_xdg_contiene_exec_y_nombre() {
        let c = linux_desktop_contents(std::path::Path::new("/opt/bundeck/launcher"));
        assert!(c.contains("[Desktop Entry]"));
        assert!(c.contains("/opt/bundeck/launcher"));
        assert!(c.contains("LibreDeck"));
    }

    #[test]
    fn plist_macos_arranca_al_login() {
        let c = macos_plist_contents(std::path::Path::new("/Applications/BunDeck.app/launcher"));
        assert!(c.contains("com.libredeck.launcher"));
        assert!(c.contains("RunAtLoad"));
        assert!(c.contains("/Applications/BunDeck.app/launcher"));
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
}
