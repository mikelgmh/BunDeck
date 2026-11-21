//! Sondeo del daemon: misma fuente de verdad que el front y el host.
//! - API:    GET http://localhost:<API_PORT>/health  (daemon/src/server.ts)
//! - Config: GET http://localhost:<API_PORT>/config  -> { wsPort, apiPort, frontendPort }
//! - WS:     TCP connect a 127.0.0.1:<WS_PORT> (Bun.serve en daemon/src/ws.ts)
//! - Front:  HEAD http://localhost:<FRONT_PORT>/  (o :4321 en dev con Astro)
//!
//! Puertos por defecto (daemon/src/config.ts): API 3001, WS 3003, Frontend 3002.

use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Ok,
    Starting,
    Down,
}

impl State {
    pub fn label(self) -> &'static str {
        match self {
            State::Ok => "en línea",
            State::Starting => "arrancando…",
            State::Down => "detenido",
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

fn http_ok(url: &str, timeout: Duration) -> Option<String> {
    let agent: ureq::Agent = ureq::AgentBuilder::new()
        .timeout_connect(timeout)
        .timeout_read(timeout)
        .timeout_write(timeout)
        .build();
    match agent.get(url).call() {
        Ok(res) => res.into_string().ok(),
        Err(_) => None,
    }
}

fn check_api(port: u16) -> ServiceSnapshot {
    let url = format!("http://127.0.0.1:{port}/health");
    match http_ok(&url, Duration::from_millis(900)) {
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
    // En dev Astro sirve :4321; en prod el daemon sirve :FRONTEND_PORT.
    // Si DEV_MODE=true se prueba 4321 primero.
    let dev = std::env::var("DEV_MODE").as_deref() == Ok("true");
    let mut candidates = vec![port];
    if dev && port != 4321 {
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
pub fn snapshot() -> Snapshot {
    let api = api_port();
    let ws = ws_port();
    let front = frontend_port();

    let api_snap = check_api(api);
    // Si la API no responde, WS y front probablemente tampoco: no los
    // marcamos "down" definitivo sino "starting" si el daemon se está
    // levantando (evita parpadeo rojo durante los ~10s de boot).
    let starting_hint = api_snap.state == State::Down && daemon_process_alive();
    let mut ws_snap = check_ws(ws);
    let (mut front_snap, front_is_astro) = check_frontend(front);
    if starting_hint {
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

/// Heurística barata: ¿hay un proceso bun sirviendo? Se usa solo para
/// distinguir "arrancando" de "detenido" en la UI.
fn daemon_process_alive() -> bool {
    // Mejor esfuerzo multiplataforma sin dependencias: intentarlo por nombre
    // de proceso es frágil; devolvemos true si API_PORT responde en el
    // próximo sondeo de todas formas. Por ahora: si no hay API, asumimos
    // arranque en curso durante los primeros N sondeos (la vista cuenta).
    // Se deja como gancho para una futura supervisión real del hijo.
    true
}

/// Intenta arrancar el daemon.
/// Orden: 1) dev (`bun run daemon/src/server.ts`, espejo de `spawnDaemon()`
/// en `src/bun/index.ts`); 2) instalado (`libredeck-daemon(.exe)` junto al
/// launcher, como lo deja installer.iss en {app}).
/// No bloquea: devuelve inmediatamente tras lanzar el hijo detached.
/// Devuelve líneas de registro para la UI.
pub fn ensure_daemon_spawned() -> Vec<String> {
    let mut log = Vec::new();
    if check_api(api_port()).state == State::Ok {
        log.push("Daemon ya en línea, no se spawnea.".to_string());
        return log;
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
            match std::process::Command::new(&bun)
                .arg("run")
                .arg(&entry)
                .current_dir(&root)
                .env("DEV_MODE", std::env::var("DEV_MODE").unwrap_or("false".into()))
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
            {
                Ok(child) => log.push(format!("Daemon spawneado (pid {}).", child.id())),
                Err(e) => log.push(format!("No se pudo spawnear el daemon con {bun}: {e}")),
            }
            return log;
        }
    }
    if let Some(exe) = find_installed_daemon() {
        log.push(format!("Arrancando daemon instalado: {}", exe.display()));
        match std::process::Command::new(&exe)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(child) => log.push(format!("Daemon spawneado (pid {}).", child.id())),
            Err(e) => log.push(format!("No se pudo arrancar {}: {e}", exe.display())),
        }
        return log;
    }
    log.push("Sin daemon a la vista: ni fuentes (daemon/src/server.ts) ni libredeck-daemon junto al launcher.".to_string());
    log
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
    agent.post(&url).call().is_ok()
}

/// Versión instalada según el daemon (GET /api/v1/version -> {version}).
pub fn installed_version() -> Option<String> {
    let url = format!("http://127.0.0.1:{}/api/v1/version", api_port());
    let agent: ureq::Agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(1500))
        .timeout_read(Duration::from_millis(1500))
        .timeout_write(Duration::from_millis(1500))
        .build();
    let body = agent.get(&url).call().ok()?;
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
        .get("https://api.github.com/repos/mikelgmh/libredeck/releases/latest")
        .set("User-Agent", "libredeck-launcher")
        .set("Accept", "application/vnd.github+json")
        .call()
        .ok()?;
    let v: serde_json::Value = res.into_json().ok()?;
    Some(LatestRelease {
        tag: v.get("tag_name")?.as_str()?.to_string(),
        url: v
            .get("html_url")?
            .as_str()
            .unwrap_or("https://github.com/mikelgmh/libredeck/releases/latest")
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
/// Instalado: `<exe>/web-dist`; dev: `<root>/web/public` o `<root>/web/dist`.
/// Se prefiere el grande (`apple-touch-icon.png`) para que no se vea
/// borroso en pantallas HiDPI. None si no se encuentra.
pub fn logo_path() -> Option<std::path::PathBuf> {
    let mut dirs = Vec::new();
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

fn host_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(1500))
        .timeout_read(Duration::from_secs(25))
        .timeout_write(Duration::from_millis(1500))
        .build()
}

/// POST contra el host. Devuelve el cuerpo si responde (sea cual sea).
pub fn host_post(path: &str) -> Option<String> {
    host_agent().post(&host_url(path)).call().ok()?.into_string().ok()
}

/// Daemon compilado junto al launcher (layout de installer.iss: todo en {app}).
fn find_installed_daemon() -> Option<std::path::PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for name in ["libredeck-daemon.exe", "libredeck-daemon"] {
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
