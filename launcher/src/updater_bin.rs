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

fn log(root: &std::path::Path, message: &str) {
    use std::io::Write;
    let path = root.join("launcher-update.log");
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or_default();
        let _ = writeln!(file, "{now} [updater] {message}");
    }
}

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
    // Esperar por handle del proceso, no por texto de tasklist: el matching
    // por subcadena daba falsos positivos/negativos y alargaba o acortaba mal
    // la espera, relanzando el panel sobre el mutex aún ocupado.
    unsafe extern "system" {
        fn OpenProcess(desired_access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn GetExitCodeProcess(process: *mut std::ffi::c_void, exit_code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    if pid == 0 {
        return false;
    }
    unsafe {
        let handle = OpenProcess(
            SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        );
        if handle.is_null() {
            // Sin handle: o murió, o es de otro usuario (se considera vivo
            // para no pisarlo).
            return tasklist_contains_pid(pid);
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code as *mut u32);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE
    }
}

#[cfg(windows)]
fn tasklist_contains_pid(pid: u32) -> bool {
    // Fallback cuando OpenProcess falla por permisos: CSV evita el matching
    // por subcadena ("123" dentro de "1123").
    let needle = format!("\"{pid}\"");
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .map(|o| csv_contains_pid(&String::from_utf8_lossy(&o.stdout), pid, &needle))
        .unwrap_or(true)
}

/// ¿Menciona la salida CSV de tasklist a este PID exacto (entre comillas)?
/// Función pura para poder testearla sin spawnear procesos.
#[cfg(windows)]
fn csv_contains_pid(output: &str, _pid: u32, needle: &str) -> bool {
    output.lines().any(|line| {
        // Cada fila CSV cita los campos: "Image Name","PID",...
        line.split("\",\"").any(|field| {
            let field = field.trim_matches('"');
            field == needle.trim_matches('"')
        })
    })
}

#[cfg(test)]
mod tests {
    /// El matching ingenuo por subcadena confundía PID 123 con 1123 y
    /// alargaba/acortaba la espera del helper, relanzando el panel sobre el
    /// mutex aún ocupado ("ya hay instancia" tras actualizar).
    #[cfg(windows)]
    #[test]
    fn csv_matching_avoids_pid_substrings() {
        let row_123 = "\"bundeck-launcher.exe\",\"123\",\"Console\",\"1\",\"10.000 K\"";
        let row_1123 = "\"other.exe\",\"1123\",\"Console\",\"1\",\"10.000 K\"";
        assert!(super::csv_contains_pid(row_123, 123, "\"123\""));
        assert!(!super::csv_contains_pid(row_1123, 123, "\"123\""));
        assert!(!super::csv_contains_pid("", 123, "\"123\""));
        let both = format!("{row_1123}\n{row_123}");
        assert!(super::csv_contains_pid(&both, 123, "\"123\""));
    }
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

/// Espera a que el mutex de instancia única quede libre antes de relanzar.
/// Mismo nombre que en instance.rs: Local\BunDeck.Launcher.SingleInstance.
fn wait_for_single_instance_free() {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        unsafe extern "system" {
            fn CreateMutexW(
                attrs: *const std::ffi::c_void,
                owner: i32,
                name: *const u16,
            ) -> *mut std::ffi::c_void;
            fn GetLastError() -> u32;
            fn ReleaseMutex(mutex: *mut std::ffi::c_void) -> i32;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        const ERROR_ALREADY_EXISTS: u32 = 183;
        let name: Vec<u16> = std::ffi::OsStr::new(r"Local\BunDeck.Launcher.SingleInstance")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        for _ in 0..50 {
            unsafe {
                let handle = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
                if handle.is_null() {
                    return;
                }
                let owned = GetLastError() != ERROR_ALREADY_EXISTS;
                // Si lo creamos nosotros, soltarlo al instante: solo sondeo.
                if owned {
                    ReleaseMutex(handle);
                }
                CloseHandle(handle);
                if owned {
                    return;
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    #[cfg(not(windows))]
    {
        std::thread::sleep(Duration::from_secs(1));
    }
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
    log(&root, &format!("Esperando al launcher PID {pid} para instalar {version}."));

    // Espera a que el launcher salga (máx ~30s).
    for _ in 0..150 {
        if !pid_alive(pid) {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    if pid_alive(pid) {
        log(&root, &format!("El launcher PID {pid} sigue activo; no se reemplazará."));
        return;
    }
    // El mutex de instancia única se libera al morir el proceso, pero con un
    // pequeño retardo. Sin esta espera, el panel relanzado veía el mutex
    // ocupado y mostraba "ya hay instancia" sobre sí mismo.
    wait_for_single_instance_free();
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
                log(&root, "Launcher actualizado; intentando relanzar el panel.");
                // Relanza el launcher (no bloquea). Si el nuevo binario no se
                // puede iniciar, restaura el anterior y lo vuelve a abrir.
                match std::process::Command::new(&dest)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                {
                    Ok(_) => return,
                    Err(error) => {
                        log(&root, &format!("No se pudo arrancar el launcher nuevo: {error}"));
                        let backup = dest.with_extension(format!("bak{exe_suffix}"));
                        match std::fs::copy(&backup, &dest) {
                            Ok(_) => {
                                log(&root, "Launcher anterior restaurado; relanzándolo.");
                                let _ = std::process::Command::new(&dest)
                                    .stdin(std::process::Stdio::null())
                                    .stdout(std::process::Stdio::null())
                                    .stderr(std::process::Stdio::null())
                                    .spawn();
                            }
                            Err(restore_error) => log(
                                &root,
                                &format!("No se pudo restaurar el launcher anterior: {restore_error}"),
                            ),
                        }
                        return;
                    }
                }
            }
            Err(e) => {
                last_err = e.to_string();
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }
    log(
        &root,
        &format!("No se pudo reemplazar el launcher: {last_err}"),
    );
    let backup = dest.with_extension(format!("bak{exe_suffix}"));
    if backup.is_file() {
        match std::fs::copy(&backup, &dest) {
            Ok(_) => {
                log(&root, "Se restauró el launcher anterior tras fallar el reemplazo.");
                let _ = std::process::Command::new(&dest)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn();
            }
            Err(error) => log(
                &root,
                &format!("Falló la restauración del launcher anterior: {error}"),
            ),
        }
    }
    eprintln!("[updater] no se pudo reemplazar el launcher: {last_err}");
    std::process::exit(1);
}
