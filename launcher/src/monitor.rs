//! Sondeo del daemon: misma fuente de verdad que el front y el host.
//! - API:    GET http://localhost:<API_PORT>/health  (daemon/src/server.ts)
//! - Config: GET http://localhost:<API_PORT>/config  -> { wsPort, apiPort, frontendPort }
//! - WS:     TCP connect a 127.0.0.1:<WS_PORT> (Bun.serve en daemon/src/ws.ts)
//! - Front:  HEAD http://localhost:<FRONT_PORT>/  (o :4321 en dev con Astro)
//!
//! Puertos por defecto (daemon/src/config.ts): API 3001, WS 3003, Frontend 3002.

use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

/// Mientras el apply del update está activo, el hilo monitor no debe spawnear
/// daemons por su cuenta: competiría con el cambio de `active.json`
/// (carrera viejo/nuevo). Lo activa `finish_apply`, lo libera el propio apply.
pub static UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Ok,
    Starting,
    Down,
}

impl State {
    pub fn label(self) -> &'static str {
        match self {
            State::Ok => crate::strings::get("state.ok"),
            State::Starting => crate::strings::get("state.starting"),
            State::Down => crate::strings::get("state.down"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ServiceSnapshot {
    pub state: State,
    pub detail: String,
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub api: ServiceSnapshot,
    pub ws: ServiceSnapshot,
    pub frontend: ServiceSnapshot,
    pub dashboard_url: String,
}

impl Snapshot {
    /// Estado inmediato sin I/O para pintar la ventana mientras se sondea
    /// el daemon en segundo plano.
    pub fn initial() -> Self {
        let checking = crate::strings::get("state.checking").to_string();
        Self {
            api: ServiceSnapshot {
                state: State::Starting,
                detail: checking.clone(),
            },
            ws: ServiceSnapshot {
                state: State::Starting,
                detail: checking.clone(),
            },
            frontend: ServiceSnapshot {
                state: State::Starting,
                detail: checking,
            },
            dashboard_url: format!("http://localhost:{}", frontend_port()),
        }
    }
}

fn env_port(name: &str, fallback: u16) -> u16 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(fallback)
}

pub fn api_port() -> u16 {
    env_port("PORT", 3001)
}
pub fn ws_port() -> u16 {
    env_port("WS_PORT", 3003)
}
pub fn frontend_port() -> u16 {
    env_port("FRONTEND_PORT", 3002)
}

fn http_ok_with_agent(agent: &ureq::Agent, url: &str) -> Option<String> {
    match agent.get(url).call() {
        Ok(res) => res.into_string().ok(),
        Err(_) => None,
    }
}

fn check_api(port: u16) -> ServiceSnapshot {
    let url = format!("http://127.0.0.1:{port}/health");
    let agent: ureq::Agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(900))
        .timeout_read(Duration::from_millis(900))
        .timeout_write(Duration::from_millis(900))
        .build();
    check_api_with_agent(port, &url, &agent)
}

fn check_api_with_agent(port: u16, url: &str, agent: &ureq::Agent) -> ServiceSnapshot {
    match http_ok_with_agent(agent, url) {
        // El título ya no lleva el puerto; aquí tampoco: solo ":puerto".
        // (La versión se muestra en la sección ACTUALIZACIÓN.)
        Some(_) => ServiceSnapshot {
            state: State::Ok,
            detail: format!(":{port}"),
        },
        None => ServiceSnapshot {
            state: State::Down,
            detail: format!(":{port}"),
        },
    }
}

fn check_ws(port: u16) -> ServiceSnapshot {
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    match TcpStream::connect_timeout(&addr, Duration::from_millis(600)) {
        Ok(_) => ServiceSnapshot {
            state: State::Ok,
            detail: format!(":{port}"),
        },
        Err(_) => ServiceSnapshot {
            state: State::Down,
            detail: format!(":{port}"),
        },
    }
}

/// Comprueba el frontend. Devuelve el estado y si sirve Astro en :4321
/// (para que el panel apunte ahí en vez de al puerto embebido).
fn check_frontend(port: u16) -> (ServiceSnapshot, bool) {
    // Astro sirve :4321 en dev; en prod el daemon sirve :FRONTEND_PORT.
    // Se prueban ambos siempre (auto-detección): el launcher abierto vía
    // `bun run dev` puede no heredar DEV_MODE=true y si no, ignoraría
    // a Astro aunque esté en línea.
    let mut candidates = vec![port];
    if port != 4321 {
        candidates.insert(0, 4321);
    }
    let agent: ureq::Agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(800))
        .timeout_read(Duration::from_millis(800))
        .timeout_write(Duration::from_millis(800))
        .build();
    for p in candidates {
        let url = format!("http://127.0.0.1:{p}/");
        if agent.head(&url).call().is_ok() || agent.get(&url).call().is_ok() {
            return (
                ServiceSnapshot {
                    state: State::Ok,
                    detail: format!(":{p}"),
                },
                p == 4321,
            );
        }
    }
    (
        ServiceSnapshot {
            state: State::Down,
            detail: format!(":{port}"),
        },
        false,
    )
}

/// Un sondeo completo. Barato (<3s peor caso) para llamar cada 2s desde la UI.
///
/// `expect_running` distingue "arrancando" de "detenido": solo cuando la UI
/// espera el daemon en marcha (tras Iniciar/Reiniciar o un arranque recién
/// spawneado) los servicios caídos se muestran como `Starting`. Tras una
/// parada voluntaria (`expect_running = false`) todo lo caído es `Down`.
pub fn snapshot(expect_running: bool) -> Snapshot {
    let api = api_port();
    let ws = ws_port();
    let front = frontend_port();

    let mut api_snap = check_api(api);
    // Sin expectativa de arranque, lo caído es caído (no "arrancando").
    // Con ella, el boot a medias (~10s) se muestra en ámbar, no en rojo.
    if expect_running && api_snap.state == State::Down {
        api_snap.state = State::Starting;
    }
    let mut ws_snap = check_ws(ws);
    let (mut front_snap, front_is_astro) = check_frontend(front);
    if expect_running {
        if ws_snap.state == State::Down {
            ws_snap.state = State::Starting;
        }
        if front_snap.state == State::Down {
            front_snap.state = State::Starting;
        }
    }

    let dashboard_url = if front_is_astro {
        "http://localhost:4321".to_string()
    } else {
        format!("http://localhost:{front}")
    };

    Snapshot {
        api: api_snap,
        ws: ws_snap,
        frontend: front_snap,
        dashboard_url,
    }
}

/// No se usa: el estado "arrancando" lo decide la UI (`expect_running` en
/// `snapshot`), no una heurística de proceso. Se eliminó el stub
/// `daemon_process_alive()` (siempre-true) que pintaba "arrancando" también
/// tras una parada voluntaria.

/// Sin consola en Windows salvo en dev: con `CREATE_NO_WINDOW` el hijo
/// (bun o el daemon compilado) no abre ninguna terminal. En dev
/// (`DEV_MODE=true`) se conserva para ver los logs.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
fn hide_console(cmd: &mut std::process::Command) {
    if std::env::var("DEV_MODE").as_deref() != Ok("true") {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Intenta arrancar el daemon.
/// DUEÑO DEL CICLO DE VIDA: en instalado/producción este launcher es el
/// único que spawnea el daemon (el host Electrobun no spawnea en prod: ver
/// shouldHostManageDaemon en `src/bun/index.ts`). Marca al hijo con
/// BUNDECK_MANAGED=1 para que nadie lo duplique (el icono de bandeja
/// lo pone este launcher: `tray.rs`; el daemon no tiene tray propio).
/// Orden: 1) dev (`bun run daemon/src/server.ts`, espejo de `spawnDaemon()`
/// en `src/bun/index.ts`); 2) instalado (`bundeck-daemon(.exe)` junto al
/// launcher, como lo deja installer.iss en {app}).
/// No bloquea: devuelve inmediatamente tras lanzar el hijo detached.
/// Devuelve líneas de registro para la UI y si se intentó un arranque
/// (para que la UI marque "arrancando" en vez de "detenido" durante el boot).
pub fn ensure_daemon_spawned() -> (Vec<String>, bool) {
    let mut log = Vec::new();
    if check_api(api_port()).state == State::Ok {
        log.push("Daemon ya en línea, no se spawnea.".to_string());
        return (log, false);
    }
    if let Some(root) = find_project_root() {
        let entry = root.join("daemon").join("src").join("server.ts");
        if entry.exists() {
            let bun = host_bun();
            log.push(format!(
                "Arrancando daemon: {} run {} (cwd {})",
                bun,
                entry.display(),
                root.display()
            ));
            let mut cmd = std::process::Command::new(&bun);
            cmd.arg("run")
                .arg(&entry)
                .current_dir(&root)
                .env("DEV_MODE", std::env::var("DEV_MODE").unwrap_or("false".into()))
                // Gestionado por el launcher: sin supervisión ajena.
                .env("BUNDECK_MANAGED", "1")
                // El panel lo abre el launcher ("Panel web"); el daemon no
                // debe abrir pestañas solo (y menos una por cada apply).
                .env("BUNDECK_NO_AUTO_OPEN", "1")
                // Panel LAN/QR en dev: opt-in explícito (daemon por defecto loopback).
                .env("BUNDECK_BIND_LAN", "1")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            #[cfg(windows)]
            hide_console(&mut cmd);
            match cmd.spawn()
            {
                Ok(child) => {
                    log.push(format!("Daemon spawneado (pid {}).", child.id()));
                    return (log, true);
                }
                Err(e) => {
                    log.push(format!("No se pudo spawnear el daemon con {bun}: {e}"));
                    return (log, false);
                }
            }
        }
    }
    if let Some(exe) = find_installed_daemon() {
        log.push(format!("Arrancando daemon instalado: {}", exe.display()));
        let mut cmd = std::process::Command::new(&exe);
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            // Gestionado por el launcher: sin supervisión ajena.
            .env("BUNDECK_MANAGED", "1")
            // Sin auto-open del daemon (lo abre el launcher a petición).
            .env("BUNDECK_NO_AUTO_OPEN", "1")
            // Instalado con panel LAN: opt-in explícito (daemon por defecto loopback).
            .env("BUNDECK_BIND_LAN", "1");
        #[cfg(windows)]
        hide_console(&mut cmd);
        match cmd.spawn()
        {
            Ok(child) => {
                log.push(format!("Daemon spawneado (pid {}).", child.id()));
                return (log, true);
            }
            Err(e) => {
                log.push(format!("No se pudo arrancar {}: {e}", exe.display()));
                return (log, false);
            }
        }
    }
    log.push("Sin daemon a la vista: ni fuentes (daemon/src/server.ts) ni bundeck-daemon junto al launcher.".to_string());
    (log, false)
}

/// Pide un checkpoint WAL antes de hacer el backup. Best-effort.
pub fn prepare_update() -> bool {
    let url = format!(
        "http://127.0.0.1:{}/api/v1/admin/prepare-update",
        api_port()
    );
    let agent: ureq::Agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(1500))
        .timeout_read(Duration::from_millis(1500))
        .timeout_write(Duration::from_millis(1500))
        .build();
    post_ok_with_agent(&agent, &url)
}

/// Pide al daemon que se apague (POST /api/v1/admin/shutdown: responde al
/// instante y el proceso muere en ~2s). true si el daemon aceptó la orden.
pub fn shutdown_daemon() -> bool {
    let url = format!("http://127.0.0.1:{}/api/v1/admin/shutdown", api_port());
    let agent: ureq::Agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(1500))
        .timeout_read(Duration::from_millis(1500))
        .timeout_write(Duration::from_millis(1500))
        .build();
    post_ok_with_agent(&agent, &url)
}

fn post_ok_with_agent(agent: &ureq::Agent, url: &str) -> bool {
    agent.post(url).call().is_ok()
}

/// Espera a que termine el daemon tras aceptar el apagado.
/// Timeout amplio (20s): el apagado del daemon es diferido 2s y con
/// keep-alives del frontend embebido el cierre puede tardar.
pub fn wait_for_api_down() {
    wait_for_api_down_secs(20);
}

fn wait_for_api_down_secs(secs: u64) {
    let url = format!("http://127.0.0.1:{}/health", api_port());
    let agent: ureq::Agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(500))
        .timeout_read(Duration::from_millis(500))
        .timeout_write(Duration::from_millis(500))
        .build();
    let tries = secs.saturating_mul(10).max(10);
    for _ in 0..tries {
        if agent.get(&url).call().is_err() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// ¿Sigue algo del stack levantado (API, WS o frontend embebido/Astro)?
/// Un solo snapshot (no tres): las tres sondas ya van dentro.
pub fn stack_down() -> bool {
    let snap = snapshot(false);
    snap.api.state == State::Down
        && snap.ws.state == State::Down
        && snap.frontend.state == State::Down
}

/// Espera a que TODO el stack caiga (no solo /health): el apply no debe
/// cambiar `active.json` con el frontend embebido aún sirviendo.
pub fn wait_for_stack_down() {
    for _ in 0..200 {
        if stack_down() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Versión instalada según el daemon (GET /api/v1/version -> {version}).
pub fn installed_version() -> Option<String> {
    let url = format!("http://127.0.0.1:{}/api/v1/version", api_port());
    let agent: ureq::Agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(1500))
        .timeout_read(Duration::from_millis(1500))
        .timeout_write(Duration::from_millis(1500))
        .build();
    installed_version_with_agent(&agent, &url)
}

fn installed_version_with_agent(agent: &ureq::Agent, url: &str) -> Option<String> {
    let body = agent.get(url).call().ok()?;
    let v: serde_json::Value = body.into_json().ok()?;
    v.get("version")?.as_str().map(|s| s.to_string())
}

/// Última release publicada en GitHub. Requiere internet; timeout corto.
#[derive(Debug, Clone, Default)]
pub struct LatestRelease {
    /// Tag tal cual lo publica GitHub ("v1.6.0").
    pub tag: String,
    /// URL de la página de la release para descarga manual.
    pub url: String,
}

pub fn latest_release() -> Option<LatestRelease> {
    let agent: ureq::Agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(3500))
        .timeout_read(Duration::from_millis(3500))
        .timeout_write(Duration::from_millis(3500))
        .build();
    // La API de GitHub exige User-Agent.
    let res = agent
        .get("https://api.github.com/repos/mikelgmh/BunDeck/releases/latest")
        .set("User-Agent", "bundeck-launcher")
        .set("Accept", "application/vnd.github+json")
        .call()
        .ok()?;
    let v: serde_json::Value = res.into_json().ok()?;
    Some(LatestRelease {
        tag: v.get("tag_name")?.as_str()?.to_string(),
        url: v
            .get("html_url")?
            .as_str()
            .unwrap_or("https://github.com/mikelgmh/BunDeck/releases/latest")
            .to_string(),
    })
}

/// Compara "1.5.0" con "v1.6.0": true si el tag es más nuevo.
pub fn is_newer(installed: &str, latest_tag: &str) -> bool {
    fn parts(s: &str) -> Vec<u64> {
        s.trim()
            .trim_start_matches(|c| c == 'v' || c == 'V')
            .split('.')
            .map(|p| {
                p.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .collect()
    }
    let (mut a, mut b) = (parts(installed), parts(latest_tag));
    let n = a.len().max(b.len()).max(1);
    a.resize(n, 0);
    b.resize(n, 0);
    a < b
}

/// Logo a todo color para la cabecera del panel (PNG de bundeck).
/// Gestionado: `versions/<activa>/web-dist`; instalado plano: `<exe>/web-dist`;
/// dev: `<root>/web/public` o `<root>/web/dist`.
/// Se prefiere el grande (`apple-touch-icon.png`) para que no se vea
/// borroso en pantallas HiDPI. None si no se encuentra.
pub fn logo_path() -> Option<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if let Some(managed) = super::updater::resolve_web_dist() {
        dirs.push(managed);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.join("web-dist"));
        }
    }
    if let Some(root) = find_project_root() {
        dirs.push(root.join("web/public"));
        dirs.push(root.join("web/dist"));
    }
    for dir in dirs {
        for name in ["apple-touch-icon.png", "favicon-32.png"] {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}
/// Puerto del servidorcito de control del host Electrobun
/// (rutas __launcher/* en `src/bun/launcher-server.ts`). 127.0.0.1 solo.
pub fn host_port() -> u16 {
    env_port("HOST_PORT", 3031)
}

fn host_url(path: &str) -> String {
    format!("http://127.0.0.1:{}/__launcher/{path}", host_port())
}

/// ¿Hay host Electrobun escuchando? (GET /__launcher/ping, sin efectos).
/// Solo se usa para NO duplicar su flujo dev de Spotify: con host vivo el
/// host abre su propia ventana y el launcher no abre el navegador.
pub fn host_alive() -> bool {
    let agent: ureq::Agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(1000))
        .timeout_read(Duration::from_millis(1000))
        .timeout_write(Duration::from_millis(1000))
        .build();
    agent
        .get(&host_url("ping"))
        .call()
        .ok()
        .and_then(|r| r.into_string().ok())
        .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
        .and_then(|v| v.get("ok")?.as_bool())
        .unwrap_or(false)
}

/// login-request de Spotify pendiente (apertura bajo demanda desde cualquier
/// dispositivo, incluido remoto por túnel): GET
/// /api/v1/plugins/spotify/login-request. Devuelve el `requestedAt` si hay
/// petición pendiente. Best-effort: None ante cualquier fallo.
pub fn spotify_login_pending() -> Option<String> {
    let url = format!(
        "http://127.0.0.1:{}/api/v1/plugins/spotify/login-request",
        api_port()
    );
    let agent: ureq::Agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(1000))
        .timeout_read(Duration::from_millis(1500))
        .timeout_write(Duration::from_millis(1000))
        .build();
    let body = agent.get(&url).call().ok()?;
    let v: serde_json::Value = body.into_json().ok()?;
    if v.get("pending")?.as_bool() != Some(true) {
        return None;
    }
    let requested_at = v.get("requestedAt")?.as_str()?;
    if requested_at.is_empty() {
        None
    } else {
        Some(requested_at.to_string())
    }
}

/// Descarta el login-request de Spotify (DELETE .../login-request).
/// Best-effort para el botón Descartar del aviso del panel.
pub fn spotify_dismiss_login() -> bool {
    let url = format!(
        "http://127.0.0.1:{}/api/v1/plugins/spotify/login-request",
        api_port()
    );
    let agent: ureq::Agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(1500))
        .timeout_read(Duration::from_millis(1500))
        .timeout_write(Duration::from_millis(1500))
        .build();
    agent.delete(&url).call().is_ok()
}

/// Daemon compilado: `versions/<activa>/` (gestionado) o plano junto al
/// launcher (legacy, layout de installer.iss: todo en {app}).
fn find_installed_daemon() -> Option<std::path::PathBuf> {
    if let Some(exe) = super::updater::resolve_daemon_exe() {
        return Some(exe);
    }
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for name in ["bundeck-daemon.exe", "bundeck-daemon", "libredeck-daemon.exe", "libredeck-daemon"] {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn host_bun() -> String {
    for candidate in [
        r"C:\Users\mikel\.bun\bin\bun.exe",
        &std::env::var("BUN_PATH").unwrap_or_default(),
        "bun",
    ] {
        if !candidate.is_empty() {
            if candidate == "bun" {
                return candidate.to_string();
            }
            if std::path::Path::new(candidate).exists() {
                return candidate.to_string();
            }
        }
    }
    "bun".to_string()
}

fn find_project_root() -> Option<std::path::PathBuf> {
    let mut dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for _ in 0..6 {
        if dir.join("daemon").join("src").join("server.ts").exists()
            || dir.join("electrobun.config.ts").exists()
        {
            return Some(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    // Fallback dev: cwd
    let cwd = std::env::current_dir().ok()?;
    if cwd.join("daemon").join("src").join("server.ts").exists() {
        return Some(cwd);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread::JoinHandle;

    fn test_agent(timeout: Duration) -> ureq::Agent {
        ureq::AgentBuilder::new()
            .timeout_connect(timeout)
            .timeout_read(timeout)
            .timeout_write(timeout)
            .build()
    }

    fn fake_daemon(
        request_count: usize,
        delay: Duration,
    ) -> (String, JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
        let address = listener.local_addr().expect("read listener address");
        let worker = std::thread::spawn(move || {
            let mut requests = Vec::with_capacity(request_count);
            for _ in 0..request_count {
                let (mut stream, _) = listener.accept().expect("accept local request");
                let mut bytes = [0; 2048];
                let read = stream.read(&mut bytes).expect("read local request");
                let request = String::from_utf8_lossy(&bytes[..read]).into_owned();
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/")
                    .to_string();
                requests.push(request);

                if !delay.is_zero() {
                    std::thread::sleep(delay);
                }
                let (status, body) = match path.as_str() {
                    "/health" => ("200 OK", r#"{"status":"ok"}"#),
                    "/api/v1/version" => ("200 OK", r#"{"version":"2.3.4"}"#),
                    "/api/v1/admin/prepare-update" | "/api/v1/admin/shutdown" => {
                        ("200 OK", r#"{"ok":true}"#)
                    }
                    "/unavailable" => ("503 Service Unavailable", "unavailable"),
                    "/malformed-version" => ("200 OK", r#"{"version":42}"#),
                    _ => ("404 Not Found", "not found"),
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
            requests
        });
        (format!("http://{address}"), worker)
    }

    #[test]
    fn local_daemon_routes_probe_health_version_and_admin_actions() {
        let (base_url, worker) = fake_daemon(4, Duration::ZERO);
        let agent = test_agent(Duration::from_secs(1));

        let health = check_api_with_agent(
            4567,
            &format!("{base_url}/health"),
            &agent,
        );
        assert_eq!(health.state, State::Ok);
        assert_eq!(health.detail, ":4567");
        assert_eq!(
            installed_version_with_agent(&agent, &format!("{base_url}/api/v1/version")),
            Some("2.3.4".to_string())
        );
        assert!(post_ok_with_agent(
            &agent,
            &format!("{base_url}/api/v1/admin/prepare-update")
        ));
        assert!(post_ok_with_agent(
            &agent,
            &format!("{base_url}/api/v1/admin/shutdown")
        ));

        let requests = worker.join().expect("fake daemon completed");
        assert!(requests[0].starts_with("GET /health "));
        assert!(requests[1].starts_with("GET /api/v1/version "));
        assert!(requests[2].starts_with("POST /api/v1/admin/prepare-update "));
        assert!(requests[3].starts_with("POST /api/v1/admin/shutdown "));
    }

    #[test]
    fn probes_report_unavailable_and_reject_malformed_version_data() {
        let (base_url, unavailable_worker) = fake_daemon(1, Duration::ZERO);
        let agent = test_agent(Duration::from_secs(1));
        let unavailable = check_api_with_agent(
            4568,
            &format!("{base_url}/unavailable"),
            &agent,
        );
        assert_eq!(unavailable.state, State::Down);
        assert_eq!(unavailable.detail, ":4568");
        unavailable_worker.join().expect("fake daemon completed");

        let (base_url, malformed_worker) = fake_daemon(1, Duration::ZERO);
        assert_eq!(
            installed_version_with_agent(&agent, &format!("{base_url}/malformed-version")),
            None
        );
        malformed_worker.join().expect("fake daemon completed");
    }

    #[test]
    fn health_probe_respects_http_read_timeout() {
        let (base_url, worker) = fake_daemon(1, Duration::from_millis(200));
        let agent = test_agent(Duration::from_millis(40));
        let probe = check_api_with_agent(4569, &format!("{base_url}/health"), &agent);

        assert_eq!(probe.state, State::Down);
        assert_eq!(probe.detail, ":4569");
        worker.join().expect("fake daemon completed");
    }

    /// El flag del apply nace apagado: el monitor solo pausa spawns mientras
    /// un apply real lo levanta (ver finish_apply en main.rs).
    #[test]
    fn update_flag_is_off_by_default() {
        use std::sync::atomic::Ordering;
        assert!(!UPDATE_IN_PROGRESS.load(Ordering::SeqCst));
    }

    fn pick_free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .expect("bind ephemeral port")
            .local_addr()
            .expect("read ephemeral port")
            .port()
    }

    struct PortEnvGuard {
        saved: Vec<(&'static str, Option<String>)>,
    }

    /// Los tests que tocan PORT/WS_PORT/FRONTEND_PORT comparten el env del
    /// proceso y corren en hilos paralelos: sin este candado se pisan los
    /// puertos y `stack_down` ve el stack del otro test (caído).
    static PORT_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock_port_env() -> std::sync::MutexGuard<'static, ()> {
        PORT_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    impl PortEnvGuard {
        fn set(api: u16, ws: u16, front: u16) -> Self {
            let saved = ["PORT", "WS_PORT", "FRONTEND_PORT"]
                .iter()
                .map(|k| (*k, std::env::var(k).ok()))
                .collect();
            // Estos tests son los únicos que tocan estos envs y restauran
            // al salir (aun con panic, vía Drop).
            std::env::set_var("PORT", api.to_string());
            std::env::set_var("WS_PORT", ws.to_string());
            std::env::set_var("FRONTEND_PORT", front.to_string());
            Self { saved }
        }
    }

    impl Drop for PortEnvGuard {
        fn drop(&mut self) {
            for (key, value) in self.saved.drain(..) {
                match value {
                    Some(v) => std::env::set_var(key, v),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    /// La sonda de frontend siempre prueba :4321 primero (Astro dev). Si hay
    /// un dev-stack levantado, estos tests se saltan: no pueden aislarse.
    fn dev_frontend_busy() -> bool {
        let addr: SocketAddr = "127.0.0.1:4321".parse().expect("loopback 4321");
        TcpStream::connect_timeout(&addr, Duration::from_millis(100)).is_ok()
    }

    /// Espera a que los 3 puertos acepten conexiones (los hilos del stack
    /// falso bindean de forma asíncrona: sin esto el primer snapshot puede
    /// sondear antes del bind y ver "caído" — flake visto en Windows CI).
    /// Manda un GET mínimo para no atascar al servidor falso en su
    /// read-timeout de 500ms.
    fn wait_for_ports(api: u16, ws: u16, front: u16) {
        use std::io::{Read, Write};
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        for port in [api, ws, front] {
            while std::time::Instant::now() < deadline {
                let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
                match TcpStream::connect_timeout(&addr, Duration::from_millis(100)) {
                    Ok(mut stream) => {
                        let _ = stream
                            .set_read_timeout(Some(Duration::from_millis(500)));
                        let _ = stream.write_all(b"GET /health HTTP/1.0\r\n\r\n");
                        let mut buf = [0u8; 64];
                        let _ = stream.read(&mut buf);
                        break;
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(20)),
                }
            }
        }
    }

    /// Sirve "stack levantado" en los 3 puertos durante `serve_for`: HTTP 200
    /// mínimo en API y frontend, TCP abierto en WS. Al expirar, los hilos
    /// sueltan los listeners y el stack cae solo (sin señalización).
    fn serve_fake_stack(
        api: u16,
        ws: u16,
        front: u16,
        serve_for: Duration,
    ) -> Vec<std::thread::JoinHandle<()>> {
        fn serve(port: u16, http: bool, serve_for: Duration) -> std::thread::JoinHandle<()> {
            std::thread::spawn(move || {
                let listener = std::net::TcpListener::bind(("127.0.0.1", port))
                    .expect("bind fake stack port");
                listener
                    .set_nonblocking(true)
                    .expect("nonblocking fake listener");
                let deadline = std::time::Instant::now() + serve_for;
                while std::time::Instant::now() < deadline {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let _ = stream.set_nonblocking(false);
                            if http {
                                use std::io::{Read, Write};
                                let mut stream = stream;
                                // Leer hasta fin de cabeceras: responder tras
                                // una sola lectura corta la petición a medias
                                // y el cliente ve RST (fallo visto en Windows).
                                let _ = stream.set_read_timeout(Some(
                                    Duration::from_millis(1500),
                                ));
                                let mut buf = Vec::new();
                                let mut chunk = [0u8; 1024];
                                loop {
                                    match stream.read(&mut chunk) {
                                        Ok(0) => break,
                                        Ok(n) => {
                                            buf.extend_from_slice(&chunk[..n]);
                                            if buf.windows(4).any(|w| w == b"\r\n\r\n")
                                                || buf.len() >= 8192
                                            {
                                                break;
                                            }
                                        }
                                        Err(_) => break,
                                    }
                                }
                                let _ = stream.write_all(
                                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                                );
                            }
                            // WS: basta con aceptar; el connect ya es Ok.
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(20));
                        }
                        Err(_) => break,
                    }
                }
                // Al salir se suelta el listener: el puerto queda caído.
            })
        }
        vec![
            serve(api, true, serve_for),
            serve(ws, false, serve_for),
            serve(front, true, serve_for),
        ]
    }

    #[test]
    fn stack_down_when_nothing_listens() {
        if dev_frontend_busy() {
            eprintln!("skip: hay dev-stack en :4321");
            return;
        }
        let _lock = lock_port_env();
        let _env = PortEnvGuard::set(pick_free_port(), pick_free_port(), pick_free_port());
        assert!(stack_down());
    }

    #[test]
    fn stack_down_transitions_from_up_to_down() {
        if dev_frontend_busy() {
            eprintln!("skip: hay dev-stack en :4321");
            return;
        }
        let _lock = lock_port_env();
        let (api, ws, front) = (pick_free_port(), pick_free_port(), pick_free_port());
        let _env = PortEnvGuard::set(api, ws, front);
        let workers = serve_fake_stack(api, ws, front, Duration::from_secs(3));
        // Los hilos bindean de forma asíncrona: esperar a que acepten antes
        // de afirmar que el stack está levantado (flake en Windows CI).
        wait_for_ports(api, ws, front);
        // El stack falso responde: no está caído.
        assert!(!stack_down());
        // Al expirar el serveo los puertos caen: wait_for_stack_down vuelve
        // solo (y rápido tras la caída, no tras 20s de timeout).
        let start = std::time::Instant::now();
        wait_for_stack_down();
        assert!(start.elapsed() < Duration::from_secs(20));
        assert!(stack_down());
        for w in workers {
            w.join().expect("fake stack thread finished");
        }
    }
}
