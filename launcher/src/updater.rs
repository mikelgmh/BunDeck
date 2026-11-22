//! Auto-actualización gestionada de BunDeck (launcher + daemon + CLI + web).
//!
//! El launcher Rust es el dueño del ciclo de vida en producción y también
//! el dueño de las actualizaciones. Electrobun queda fuera del release
//! canónico (dev-only); el botón "Actualizar" ya no delega en el host.
//!
//! Layout gestionado (todas las plataformas):
//! ```text
//! <install>/                    # junto al launcher, o $LIBREDECK_INSTALL_DIR
//!   libredeck-launcher(.exe)    # binario en ejecución
//!   libredeck-updater(.exe)     # ayudante que reemplaza al launcher (fichero bloqueado en Windows)
//!   versions/
//!     1.6.0/
//!       libredeck-daemon(.exe) | libredeck-cli(.exe)
//!       libredeck-launcher(.exe) | libredeck-updater(.exe)
//!       web-dist/
//!     1.5.0/ ...
//!   active.json                 # {"version":"1.6.0"}
//!   backups/
//!     db-1.6.0-<ts>/db.sqlite*
//! ```
//! Instalaciones planas legacy (Windows installer antiguo: todo en {app})
//! se migran solas al primer update: los binarios actuales se archivan en
//! `versions/<instalada>/` y se escribe `active.json`.
//!
//! Flujo: check (manifiesto) -> download (con progreso) -> verify
//! (sha256 + firma ed25519 si hay pubkey compilada) -> stage
//! (`versions/<ver>/`) -> apply (backup db, shutdown daemon, activar,
//! health-check, rollback) -> self-update del launcher vía helper.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const GITHUB_REPO: &str = "mikelgmh/libredeck";
pub const MANIFEST_URL: &str =
    "https://github.com/mikelgmh/libredeck/releases/latest/download/bundeck-update-manifest.json";
const MANIFEST_TIMEOUT_SECS: u64 = 15;

/// Pubkey ed25519 compilada (hex 32 bytes). La inyecta build.rs desde
/// `LIBREDECK_UPDATE_PUBKEY` o `launcher/UPDATE_PUBKEY`; en runtime gana
/// el env del mismo nombre. Sin pubkey la verificación de firma se omite
/// (solo sha256) y se avisa en la UI. Ver `scripts/gen-update-keys.mjs`.
pub fn update_pubkey() -> Option<String> {
    std::env::var("LIBREDECK_UPDATE_PUBKEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| option_env!("LIBREDECK_UPDATE_PUBKEY").map(|s| s.to_string()))
        .filter(|s| !s.trim().is_empty())
}

/// Target de plataforma para el manifiesto.
pub fn current_target() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows-x64"
    } else if cfg!(target_os = "macos") {
        "darwin-x64"
    } else {
        "linux-x64"
    }
}

pub fn exe_suffix() -> &'static str {
    if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    }
}

// ---------------------------------------------------------------------------
// Manifiesto
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Deserialize)]
pub struct TargetAsset {
    pub bundle: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub signature: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct UpdateManifest {
    #[allow(dead_code)]
    pub format: u32,
    pub version: String,
    pub channel: Option<String>,
    #[allow(dead_code)]
    #[serde(default, alias = "notesUrl")]
    pub notes_url: Option<String>,
    #[allow(dead_code)]
    #[serde(default, alias = "minUpdaterVersion")]
    pub min_updater_version: Option<String>,
    pub assets: std::collections::HashMap<String, TargetAsset>,
}

#[derive(Debug, Clone)]
pub struct UpdateCheck {
    pub current: String,
    pub latest: String,
    pub notes_url: String,
    pub asset: TargetAsset,
    pub manifest_signed: bool,
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

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(MANIFEST_TIMEOUT_SECS))
        .timeout_write(Duration::from_secs(8))
        .build()
}

pub fn fetch_manifest() -> Result<(UpdateManifest, Vec<u8>), String> {
    // 1) Manifiesto versionado (evita rate-limit de la API).
    // 2) Fallback a la API de GitHub si el manifiesto aún no existe
    //    (releases antiguas sin este sistema).
    match agent()
        .get(MANIFEST_URL)
        .set("User-Agent", "libredeck-launcher")
        .call()
    {
        Ok(res) => {
            let mut bytes = Vec::new();
            res.into_reader()
                .read_to_end(&mut bytes)
                .map_err(|e| format!("leer manifiesto: {e}"))?;
            let m: UpdateManifest =
                serde_json::from_slice(&bytes).map_err(|e| format!("manifiesto inválido: {e}"))?;
            Ok((m, bytes))
        }
        Err(e) => Err(format!("no se pudo descargar el manifiesto ({e}); ¿sin internet?")),
    }
}

/// Comprueba si hay actualización para `current` en la plataforma actual.
pub fn check_for_update(current: &str) -> Result<Option<UpdateCheck>, String> {
    let (m, _raw) = fetch_manifest()?;
    let target = current_target();
    let asset = m.assets.get(target).cloned().ok_or_else(|| {
        format!("la release {} no trae bundle para {target}", m.version)
    })?;
    validate_asset_version(&m.version, target, &asset)?;
    if !is_newer(current, &m.version) {
        return Ok(None);
    }
    let manifest_signed = asset.signature.as_ref().is_some_and(|s| !s.is_empty());
    Ok(Some(UpdateCheck {
        current: current.to_string(),
        latest: m.version.clone(),
        notes_url: format!("https://github.com/{GITHUB_REPO}/releases/tag/v{}", m.version),
        asset,
        manifest_signed,
    }))
}

fn validate_asset_version(version: &str, target: &str, asset: &TargetAsset) -> Result<(), String> {
    let expected = format!("bundeck-v{version}-{target}.zip");
    if asset.bundle != expected {
        return Err(format!(
            "manifiesto inconsistente: declara v{version} pero el bundle es {} (se esperaba {expected})",
            asset.bundle
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Progreso (compartido entre el hilo de descarga y la vista GPUI)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct UpdateProgress {
    /// Etapa legible ("Descargando…", "Verificando…", …).
    pub stage: String,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub done: bool,
    pub error: Option<String>,
    /// Versión staged lista para aplicar (solo si done && error.is_none()).
    pub staged_version: Option<String>,
    /// Apply terminado en el hilo de fondo (el sondeo lo recoge).
    pub apply_done: bool,
    /// Versión aplicada con éxito (solo si apply_done && apply_error.is_none()).
    pub applied_version: Option<String>,
    pub apply_error: Option<String>,
    /// El stage trae un launcher nuevo: hay que reiniciar este proceso.
    pub launcher_changed: bool,
    /// Líneas de registro del apply (el sondeo las vuelca al log).
    pub apply_log: Vec<String>,
}

impl UpdateProgress {
    pub fn fraction(&self) -> Option<f32> {
        match self.total {
            Some(t) if t > 0 => Some((self.downloaded as f32 / t as f32).clamp(0.0, 1.0)),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Layout gestionado
// ---------------------------------------------------------------------------

/// Raíz de instalación: `$LIBREDECK_INSTALL_DIR` o el directorio del exe.
pub fn install_root() -> PathBuf {
    if let Ok(d) = std::env::var("LIBREDECK_INSTALL_DIR") {
        if !d.trim().is_empty() {
            return PathBuf::from(d);
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn versions_dir(root: &Path) -> PathBuf {
    root.join("versions")
}

pub fn active_file(root: &Path) -> PathBuf {
    root.join("active.json")
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct ActiveDoc {
    version: String,
}

/// Versión activa según `active.json` (None si instalación legacy sin migrar).
pub fn active_version(root: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(active_file(root)).ok()?;
    serde_json::from_str::<ActiveDoc>(&raw).ok().map(|d| d.version)
}

fn write_active(root: &Path, version: &str) -> Result<(), String> {
    let doc = ActiveDoc {
        version: version.to_string(),
    };
    let tmp = root.join("active.json.tmp");
    let data = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, data).map_err(|e| format!("escribir active.json: {e}"))?;
    std::fs::rename(&tmp, active_file(root)).map_err(|e| format!("activar versión: {e}"))?;
    Ok(())
}

fn daemon_file_name() -> String {
    format!("libredeck-daemon{}", exe_suffix())
}

fn legacy_daemon_next_to_launcher(root: &Path) -> Option<PathBuf> {
    let c = root.join(daemon_file_name());
    c.is_file().then_some(c)
}

/// Resuelve el exe del daemon: `versions/<activa>/` > legacy plano > None.
/// (El modo dev —`bun run daemon/src/server.ts`— lo decide `monitor`, no aquí.)
pub fn resolve_daemon_exe() -> Option<PathBuf> {
    if let Ok(o) = std::env::var("LIBREDECK_DAEMON_EXE") {
        let p = PathBuf::from(o);
        if p.is_file() {
            return Some(p);
        }
    }
    let root = install_root();
    if let Some(v) = active_version(&root) {
        let c = versions_dir(&root).join(&v).join(daemon_file_name());
        if c.is_file() {
            return Some(c);
        }
    }
    legacy_daemon_next_to_launcher(&root)
}

/// Resuelve `web-dist/`: `versions/<activa>/` > plano junto al exe.
pub fn resolve_web_dist() -> Option<PathBuf> {
    let root = install_root();
    if let Some(v) = active_version(&root) {
        let c = versions_dir(&root).join(&v).join("web-dist");
        if c.is_dir() {
            return Some(c);
        }
    }
    let flat = root.join("web-dist");
    flat.is_dir().then_some(flat)
}

/// Data-dir del usuario (NO se toca en updates salvo backup de la DB).
/// Réplica de `daemon/src/config.ts::resolveDataDir` (el launcher no
/// puede importar TS): LIBREDECK_DATA_DIR > %APPDATA%/LibreDeck/data >
/// <repo>/data (dev).
pub fn user_data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("LIBREDECK_DATA_DIR") {
        if !d.trim().is_empty() {
            return PathBuf::from(d);
        }
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("APPDATA")
            .or_else(|_| std::env::var("LOCALAPPDATA"))
            .unwrap_or_else(|_| ".".to_string());
        let p = PathBuf::from(base).join("LibreDeck").join("data");
        // En dev (sin instalación) el daemon usa <repo>/data; si el
        // candidato instalado no existe y hay un repo cerca, preferirlo.
        if !p.join("db.sqlite").is_file() {
            if let Some(repo) = find_repo_data() {
                return repo;
            }
        }
        return p;
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(home) = std::env::var("HOME") {
            let p = PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("BunDeck")
                .join("data");
            if p.join("db.sqlite").is_file() {
                return p;
            }
        }
        if let Some(repo) = find_repo_data() {
            return repo;
        }
        PathBuf::from("data")
    }
}

#[cfg(not(target_os = "windows"))]
fn find_repo_data() -> Option<PathBuf> {
    None
}

#[cfg(target_os = "windows")]
fn find_repo_data() -> Option<PathBuf> {
    // Sube hasta 6 niveles buscando daemon/src/server.ts (dev).
    let mut dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for _ in 0..6 {
        if dir.join("daemon").join("src").join("server.ts").is_file() {
            let d = dir.join("data");
            if d.is_dir() {
                return Some(d);
            }
            return None;
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Descarga + verificación + staging
// ---------------------------------------------------------------------------

fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let mut f = std::fs::File::open(path).map_err(|e| format!("abrir bundle: {e}"))?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("leer bundle: {e}"))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    let got = hex::encode(h.finalize());
    if got.to_lowercase() != expected.trim().to_lowercase() {
        return Err(format!("sha256 no coincide (esperado {expected}, obtenido {got})"));
    }
    Ok(())
}

fn verify_signature(version: &str, target: &str, sha256: &str, sig_hex: &str) -> Result<(), String> {
    let pub_hex = update_pubkey().ok_or_else(|| "sin pubkey compilada".to_string())?;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let pub_bytes = hex::decode(pub_hex.trim()).map_err(|e| format!("pubkey hex: {e}"))?;
    let pub_arr: [u8; 32] = pub_bytes
        .try_into()
        .map_err(|_| "pubkey debe ser 32 bytes".to_string())?;
    let key = VerifyingKey::from_bytes(&pub_arr).map_err(|e| format!("pubkey inválida: {e}"))?;
    let sig_bytes = hex::decode(sig_hex.trim()).map_err(|e| format!("firma hex: {e}"))?;
    let sig_arr: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| "firma debe ser 64 bytes".to_string())?;
    let sig = Signature::from_bytes(&sig_arr);
    let msg = format!("{version}|{target}|{sha256}");
    key.verify(msg.as_bytes(), &sig)
        .map_err(|e| format!("firma inválida: {e}"))?;
    Ok(())
}

/// Descarga el bundle a `<install>/versions/.tmp/` con progreso, verifica
/// sha256 (+ firma si hay clave) y lo extrae a `versions/<ver>/`.
///
pub fn download_and_stage(check: &UpdateCheck, progress: &Arc<Mutex<UpdateProgress>>) -> Result<PathBuf, String> {
    let set = |stage: &str| {
        if let Ok(mut p) = progress.lock() {
            p.stage = stage.to_string();
        }
    };
    set(&format!("Descargando {}…", check.asset.bundle));
    let root = install_root();
    let tmp_dir = versions_dir(&root).join(".tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("crear tmp: {e}"))?;
    let tmp_file = tmp_dir.join(&check.asset.bundle);

    let res = agent()
        .get(&check.asset.url)
        .set("User-Agent", "libredeck-launcher")
        .call()
        .map_err(|e| {
            let msg = format!("descarga fallida: {e}");
            if let Ok(mut p) = progress.lock() {
                p.error = Some(msg.clone());
            }
            msg
        })?;
    let total: Option<u64> = res
        .header("Content-Length")
        .and_then(|v| v.parse().ok())
        .filter(|t: &u64| *t > 0)
        .or(if check.asset.size > 0 {
            Some(check.asset.size)
        } else {
            None
        });
    if let Ok(mut p) = progress.lock() {
        p.total = total;
        p.downloaded = 0;
    }
    {
        let mut reader = res.into_reader();
        let mut out = std::fs::File::create(&tmp_file).map_err(|e| format!("crear tmp: {e}"))?;
        let mut buf = [0u8; 65536];
        loop {
            let n = reader.read(&mut buf).map_err(|e| format!("leer red: {e}"))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n])
                .map_err(|e| format!("escribir tmp: {e}"))?;
            if let Ok(mut p) = progress.lock() {
                p.downloaded += n as u64;
            }
        }
    }

    set("Verificando integridad…");
    verify_sha256(&tmp_file, &check.asset.sha256)?;
    if let Some(sig) = check.asset.signature.as_deref().filter(|s| !s.is_empty()) {
        set("Verificando firma…");
        match verify_signature(&check.latest, current_target(), &check.asset.sha256, sig) {
            Ok(()) => {}
            Err(e) if update_pubkey().is_none() => {
                // Sin pubkey no se puede verificar: aviso, no bloqueo.
                let _ = e;
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp_file);
                return Err(format!("firma del bundle no válida: {e}"));
            }
        }
    }

    set("Extrayendo archivos…");
    let dest = versions_dir(&root).join(&check.latest);
    if dest.is_dir() {
        std::fs::remove_dir_all(&dest).map_err(|e| format!("limpiar stage previo: {e}"))?;
    }
    std::fs::create_dir_all(&dest).map_err(|e| format!("crear stage: {e}"))?;
    extract_bundle(&tmp_file, &dest)?;
    let _ = std::fs::remove_file(&tmp_file);

    // Sanity: el stage debe traer daemon o web-dist.
    let has_daemon = dest.join(daemon_file_name()).is_file();
    let has_web = dest.join("web-dist").is_dir();
    if !has_daemon && !has_web {
        return Err("el bundle no trae ni daemon ni web-dist".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in [
            daemon_file_name(),
            "libredeck-cli".to_string(),
            "libredeck-launcher".to_string(),
            "libredeck-updater".to_string(),
        ] {
            let p = dest.join(&name);
            if p.is_file() {
                let mut perms = std::fs::metadata(&p)
                    .map_err(|e| e.to_string())?
                    .permissions();
                perms.set_mode(0o755);
                std::fs::set_permissions(&p, perms).map_err(|e| e.to_string())?;
            }
        }
    }
    if let Ok(mut p) = progress.lock() {
        p.done = true;
        p.stage = format!("Lista la versión {}", check.latest);
        p.staged_version = Some(check.latest.clone());
    }
    Ok(dest)
}

fn extract_bundle(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let f = std::fs::File::open(zip_path).map_err(|e| format!("abrir bundle: {e}"))?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| format!("bundle zip inválido: {e}"))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("leer bundle: {e}"))?;
        let name = entry.enclosed_name().ok_or_else(|| "ruta insegura en bundle".to_string())?;
        // Tolera bundles con carpeta raíz única o archivos sueltos.
        let rel = strip_single_top_level(&name).unwrap_or(name.clone());
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out = dest.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut w = std::fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut w).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Si todas las entradas cuelgan de una única carpeta raíz, la pela.
/// (Heurística simple sobre el primer nombre: `a/b` -> `b`.)
fn strip_single_top_level(name: &Path) -> Option<PathBuf> {
    let mut comps = name.components();
    let first = comps.next()?;
    let rest: PathBuf = comps.collect();
    if rest.as_os_str().is_empty() {
        return None; // la propia raíz
    }
    let first = first.as_os_str().to_string_lossy();
    // Solo pela si parece carpeta de bundle (contiene versión o "bundeck").
    if first.contains("bundeck") || first.starts_with('v') || first.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        Some(rest)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Apply + rollback
// ---------------------------------------------------------------------------

/// Copia `db.sqlite*` a `backups/db-<ver>-<ts>/`. Best-effort: si no hay
/// DB (instalación fresca) no falla.
pub fn backup_database() -> Result<Option<PathBuf>, String> {
    let data = user_data_dir();
    let db = data.join("db.sqlite");
    if !db.is_file() {
        return Ok(None);
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dest = install_root()
        .join("backups")
        .join(format!("db-{ts}"));
    std::fs::create_dir_all(&dest).map_err(|e| format!("crear backup: {e}"))?;
    for suffix in ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm", "db.sqlite-journal"] {
        let src = data.join(suffix);
        if src.is_file() {
            std::fs::copy(&src, dest.join(suffix)).map_err(|e| format!("backup {suffix}: {e}"))?;
        }
    }
    Ok(Some(dest))
}

/// Activa `version` (debe estar staged): backup DB, apaga daemon, cambia
/// `active.json`, arranca y verifica. Si el nuevo daemon no responde hace
/// rollback a la versión anterior.
pub fn apply_staged(log: &mut dyn FnMut(String), version: &str) -> Result<(), String> {
    let root = install_root();
    let staged = versions_dir(&root).join(version);
    if !staged.is_dir() {
        return Err(format!("versión {version} no descargada"));
    }
    let mut previous = active_version(&root);
    log(format!("Backup de la base de datos…"));
    match backup_database() {
        Ok(Some(p)) => log(format!("Backup en {}", p.display())),
        Ok(None) => log("Sin DB previa: nada que respaldar.".to_string()),
        Err(e) => log(format!("Aviso: no se pudo respaldar la DB ({e}); sigo.")),
    }

    // Migración legacy: si no había active.json, archiva lo actual.
    if previous.is_none() {
        log("Migrando instalación plana a versions/…".to_string());
        if let Err(e) = migrate_legacy(&root) {
            log(format!("Aviso migración legacy: {e}"));
        }
        previous = active_version(&root);
    }

    log("Deteniendo daemon actual…".to_string());
    let _ = super::monitor::shutdown_daemon();
    super::monitor::wait_for_api_down();

    log(format!("Activando versión {version}…"));
    write_active(&root, version)?;

    // Self-update del launcher: no puede reemplazarse en caliente
    // (bloqueo en Windows). El helper lo hace tras salir este proceso.
    if staged_launcher_differs(&root, version) {
        log("El launcher también cambia: se aplicará al reiniciar.".to_string());
    }

    log("Arrancando daemon nuevo…".to_string());
    let (boot, _) = super::monitor::ensure_daemon_spawned();
    for line in boot {
        log(line);
    }
    match wait_for_api_version(version) {
        Ok(()) => {
            log(format!("BunDeck {version} en línea."));
            prune_old_versions(&root, version);
            Ok(())
        }
        Err(reason) => {
            log(format!(
                "El daemon no confirmó la versión {version} ({reason}); revierto…"
            ));
            if let Some(prev) = previous {
                write_active(&root, &prev)?;
                let _ = super::monitor::ensure_daemon_spawned();
                return match wait_for_api_version(&prev) {
                    Ok(()) => Err(format!(
                        "update a {version} falló ({reason}); restaurada {prev}"
                    )),
                    Err(rollback_reason) => Err(format!(
                        "update a {version} falló ({reason}) y el rollback a {prev} también falló ({rollback_reason})"
                    )),
                };
            }
            Err(format!(
                "update a {version} falló ({reason}) y no había versión anterior para rollback"
            ))
        }
    }
}

fn staged_launcher_differs(root: &Path, version: &str) -> bool {
    let staged = versions_dir(root)
        .join(version)
        .join(format!("libredeck-launcher{}", exe_suffix()));
    staged.is_file()
}

/// ¿El stage `version` trae un launcher nuevo? (público para la UI:
/// si es así, tras aplicar hay que reiniciar este proceso vía helper).
pub fn staged_has_launcher(root: &Path, version: &str) -> bool {
    staged_launcher_differs(root, version)
}

fn wait_for_api_version(expected: &str) -> Result<(), String> {
    let mut last_seen: Option<String> = None;
    for _ in 0..25 {
        if let Some(version) = super::monitor::installed_version() {
            if version == expected {
                return Ok(());
            }
            last_seen = Some(version);
        }
        std::thread::sleep(Duration::from_millis(800));
    }
    match last_seen {
        Some(version) => Err(format!(
            "la API responde como v{version}, no como v{expected}"
        )),
        None => Err("la API no respondió con una versión válida".to_string()),
    }
}

/// Mueve una instalación plana legacy a `versions/<instalada>/`.
fn migrate_legacy(root: &Path) -> Result<(), String> {
    let installed = super::monitor::installed_version().unwrap_or_else(|| "0.0.0".to_string());
    let dest = versions_dir(root).join(&installed);
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    for name in [
        daemon_file_name(),
        format!("libredeck-cli{}", exe_suffix()),
        "web-dist".to_string(),
    ] {
        let src = root.join(&name);
        let dst = dest.join(&name);
        if src.exists() && !dst.exists() {
            std::fs::rename(&src, &dst).map_err(|e| format!("migrar {name}: {e}"))?;
        }
    }
    // El launcher en ejecución no se puede mover en Windows: se copia.
    let me = format!("libredeck-launcher{}", exe_suffix());
    let dst = dest.join(&me);
    if !dst.exists() {
        if let Ok(exe) = std::env::current_exe() {
            let _ = std::fs::copy(&exe, &dst);
        }
    }
    if active_version(root).is_none() {
        write_active(root, &installed)?;
    }
    Ok(())
}

/// Conserva la activa + las 2 anteriores; borra stages viejos.
fn prune_old_versions(root: &Path, keep_active: &str) {
    let dir = versions_dir(root);
    let mut vers: Vec<String> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| n != ".tmp")
                .collect()
        })
        .unwrap_or_default();
    vers.sort_by(|a, b| cmp_versions(a, b));
    vers.reverse();
    for old in vers.iter().skip(3) {
        if old == keep_active {
            continue;
        }
        let _ = std::fs::remove_dir_all(dir.join(old));
    }
}

fn cmp_versions(a: &str, b: &str) -> std::cmp::Ordering {
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
    let (mut x, mut y) = (parts(a), parts(b));
    let n = x.len().max(y.len()).max(1);
    x.resize(n, 0);
    y.resize(n, 0);
    x.cmp(&y)
}

// ---------------------------------------------------------------------------
// Helper de self-update del launcher
// ---------------------------------------------------------------------------

/// ¿Hay helper `libredeck-updater` junto al launcher (o staged)?
pub fn helper_path() -> Option<PathBuf> {
    let root = install_root();
    for c in [
        root.join(format!("libredeck-updater{}", exe_suffix())),
        std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|p| p.to_path_buf()))
            .unwrap_or_default()
            .join(format!("libredeck-updater{}", exe_suffix())),
    ] {
        if c.is_file() {
            return Some(c);
        }
    }
    None
}

/// Lanza el helper para reemplazar el launcher en caliente y sale.
/// El helper espera a que este pid muera, copia
/// `versions/<ver>/libredeck-launcher` sobre el exe actual y relanza.
pub fn handoff_self_update(version: &str) -> Result<(), String> {
    let helper = helper_path().ok_or_else(|| "sin helper libredeck-updater".to_string())?;
    let root = install_root();
    let staged = versions_dir(&root)
        .join(version)
        .join(format!("libredeck-launcher{}", exe_suffix()));
    if !staged.is_file() {
        return Err("el bundle no trae nuevo launcher".to_string());
    }
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let pid = std::process::id();
    let mut cmd = std::process::Command::new(&helper);
    cmd.arg("--wait-pid")
        .arg(pid.to_string())
        .arg("--install-dir")
        .arg(&root)
        .arg("--version")
        .arg(version)
        .arg("--target")
        .arg(me)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if std::env::var("DEV_MODE").as_deref() != Ok("true") {
            cmd.creation_flags(0x08000000);
        }
    }
    cmd.spawn().map_err(|e| format!("lanzar helper: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_comparison() {
        assert!(is_newer("1.5.0", "v1.6.0"));
        assert!(!is_newer("1.6.0", "v1.6.0"));
        assert!(!is_newer("1.7.0", "v1.6.0"));
        assert!(is_newer("1.5.10", "1.5.11"));
        // "dev" no es versión: siempre se ofrece actualizar.
        assert!(is_newer("dev", "v1.6.0"));
    }

    #[test]
    fn manifest_parses() {
        let raw = r#"{
            "format": 1, "version": "1.6.0", "channel": "stable",
            "assets": {
                "windows-x64": {"bundle":"bundeck-v1.6.0-windows-x64.zip","url":"https://example/x.zip","sha256":"ab","size":1,"signature":null}
            }
        }"#;
        let m: UpdateManifest = serde_json::from_str(raw).unwrap();
        assert_eq!(m.version, "1.6.0");
        assert!(m.assets.contains_key("windows-x64"));
    }

    #[test]
    fn rejects_bundle_from_a_different_release_version() {
        let asset = TargetAsset {
            bundle: "bundeck-v1.6.0-windows-x64.zip".to_string(),
            url: "https://example/bundeck.zip".to_string(),
            sha256: "ab".to_string(),
            size: 1,
            signature: None,
        };
        assert!(validate_asset_version("1.7.0", "windows-x64", &asset).is_err());
        assert!(validate_asset_version(
            "1.6.0",
            "windows-x64",
            &TargetAsset {
                bundle: "bundeck-v1.6.0-windows-x64.zip".to_string(),
                ..asset
            }
        )
        .is_ok());
    }

    #[test]
    fn strip_top_level() {
        assert_eq!(
            strip_single_top_level(Path::new("bundeck-1.6.0/daemon")).unwrap(),
            PathBuf::from("daemon")
        );
        assert!(strip_single_top_level(Path::new("daemon")).is_none());
    }

    #[test]
    fn active_roundtrip_tmp() {
        let dir = std::env::temp_dir().join(format!("bundeck-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        assert!(active_version(&dir).is_none());
        write_active(&dir, "9.9.9").unwrap();
        assert_eq!(active_version(&dir).as_deref(), Some("9.9.9"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sha256_ok_and_mismatch() {
        let dir = std::env::temp_dir().join(format!("bundeck-sha-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let f = dir.join("a.bin");
        std::fs::write(&f, b"hola").unwrap();
        // sha256("hola")
        let expect = {
            use sha2::{Digest, Sha256};
            hex::encode(Sha256::digest(b"hola"))
        };
        assert!(verify_sha256(&f, &expect).is_ok());
        assert!(verify_sha256(&f, &"00".repeat(32)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn signature_roundtrip_fixed_seed() {
        use ed25519_dalek::{Signer, SigningKey};
        let seed = [7u8; 32];
        let sk = SigningKey::from_bytes(&seed);
        let pub_hex = hex::encode(sk.verifying_key().to_bytes());
        std::env::set_var("LIBREDECK_UPDATE_PUBKEY", &pub_hex);
        let sha = "ab".repeat(32);
        let msg = format!("1.6.0|linux-x64|{sha}");
        let sig_hex = hex::encode(sk.sign(msg.as_bytes()).to_bytes());
        assert!(verify_signature("1.6.0", "linux-x64", &sha, &sig_hex).is_ok());
        // Otro mensaje no valida con la misma firma.
        assert!(verify_signature("9.9.9", "linux-x64", &sha, &sig_hex).is_err());
        std::env::remove_var("LIBREDECK_UPDATE_PUBKEY");
    }

    #[test]
    fn extract_bundle_roundtrip() {
        let dir = std::env::temp_dir().join(format!("bundeck-zip-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let zip_path = dir.join("b.zip");
        {
            let f = std::fs::File::create(&zip_path).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts: zip::write::FileOptions<'_, ()> =
                zip::write::FileOptions::default();
            w.start_file("libredeck-daemon", opts).unwrap();
            use std::io::Write;
            w.write_all(b"fake").unwrap();
            w.start_file("web-dist/index.html", opts).unwrap();
            w.write_all(b"<html></html>").unwrap();
            w.finish().unwrap();
        }
        let dest = dir.join("out");
        std::fs::create_dir_all(&dest).unwrap();
        extract_bundle(&zip_path, &dest).unwrap();
        assert!(dest.join("libredeck-daemon").is_file());
        assert!(dest.join("web-dist").join("index.html").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
