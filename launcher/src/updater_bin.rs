//! bundeck-updater — ayudante de self-update del launcher.
//!
//! Un proceso no puede reemplazarse a sí mismo en caliente (bloqueo de
//! fichero en Windows). Flujo:
//!   launcher descarga + verifica + stagea `versions/<ver>/`
//!   launcher hace `handoff_self_update(ver)` y sale
//!   helper espera al pid, copia `versions/<ver>/bundeck-launcher[.exe]`
//!   sobre el exe objetivo, relanza el launcher y sale.
//!
//! Uso:
//!   bundeck-updater --wait-pid <pid> --install-dir <dir>
//!                     --version <ver> --target <exe-actual>

use std::path::PathBuf;
use std::time::Duration;

fn arg(name: &str) -> Option<String> {
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        if a == name {
            return it.next();
        }
        if let Some(v) = a.strip_prefix(&format!("{name}=")) {
            return Some(v.to_string());
        }
    }
    None
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    // Sin dependencias: tasklist filtrado por PID.
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .map(|o| {
            let s = String::from_utf8_lossy(&o.stdout);
            s.contains(&pid.to_string())
        })
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn pid_alive(pid: u32) -> bool {
    // kill -0: existe y tenemos permiso.
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn main() {
    let pid: u32 = arg("--wait-pid").and_then(|s| s.parse().ok()).unwrap_or(0);
    let root = arg("--install-dir").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    let version = arg("--version").unwrap_or_default();
    let target = arg("--target").map(PathBuf::from);
    if pid == 0 || version.is_empty() {
        eprintln!("[updater] args: --wait-pid <pid> --install-dir <dir> --version <ver> [--target <exe>]");
        std::process::exit(2);
    }
    let exe_suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
    let staged = root
        .join("versions")
        .join(&version)
        .join(format!("bundeck-launcher{exe_suffix}"));
    let dest = target.unwrap_or_else(|| root.join(format!("bundeck-launcher{exe_suffix}")));

    // Espera a que el launcher salga (máx ~30s).
    for _ in 0..150 {
        if !pid_alive(pid) {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    // Copia con reintentos (Windows libera el bloqueo con retardo).
    let mut last_err = String::new();
    for attempt in 0..20 {
        // Backup del anterior una sola vez.
        if attempt == 0 && dest.is_file() {
            let bak = dest.with_extension(format!("bak{exe_suffix}"));
            let _ = std::fs::remove_file(&bak);
            let _ = std::fs::copy(&dest, &bak);
        }
        match std::fs::copy(&staged, &dest) {
            Ok(_) => {
                // Relanza el launcher (no bloquea).
                let _ = std::process::Command::new(&dest)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn();
                return;
            }
            Err(e) => {
                last_err = e.to_string();
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }
    eprintln!("[updater] no se pudo reemplazar el launcher: {last_err}");
    std::process::exit(1);
}
