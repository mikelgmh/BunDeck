//! Auto-actualización gestionada de BunDeck (launcher + daemon + CLI + web).
//!
//! El launcher Rust es el dueño del ciclo de vida en producción y también
//! el dueño de las actualizaciones. Electrobun queda fuera del release
//! canónico (dev-only); el botón "Actualizar" ya no delega en el host.
//!
//! Layout gestionado (todas las plataformas):
//! ```text
//! <install>/                    # junto al launcher, o $BUNDECK_INSTALL_DIR
//!   bundeck-launcher(.exe)    # binario en ejecución
//!   bundeck-updater(.exe)     # ayudante que reemplaza al launcher (fichero bloqueado en Windows)
//!   versions/
//!     1.6.0/
//!       bundeck-daemon(.exe) | bundeck-cli(.exe)
//!       bundeck-launcher(.exe) | bundeck-updater(.exe)
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

pub const GITHUB_REPO: &str = "mikelgmh/BunDeck";
pub const MANIFEST_URL: &str =
    "https://github.com/mikelgmh/BunDeck/releases/latest/download/bundeck-update-manifest.json";
const MANIFEST_TIMEOUT_SECS: u64 = 15;

/// Pubkey ed25519 compilada (hex 32 bytes). La inyecta build.rs desde
/// `BUNDECK_UPDATE_PUBKEY` o `launcher/UPDATE_PUBKEY`; en runtime gana
/// el env del mismo nombre. Sin pubkey la verificación de firma se omite
/// (solo sha256) y se avisa en la UI. Ver `scripts/gen-update-keys.mjs`.
pub fn update_pubkey() -> Option<String> {
    std::env::var("BUNDECK_UPDATE_PUBKEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("LIBREDECK_UPDATE_PUBKEY").ok().filter(|s| !s.trim().is_empty()))
        .or_else(|| option_env!("BUNDECK_UPDATE_PUBKEY").map(|s| s.to_string()))
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
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(8)))
            .timeout_per_read(Some(Duration::from_secs(MANIFEST_TIMEOUT_SECS)))
            .timeout_per_write(Some(Duration::from_secs(8)))
            .build(),
    )
}

pub fn fetch_manifest() -> Result<(UpdateManifest, Vec<u8>), String> {
    // 1) Manifiesto versionado (evita rate-limit de la API).
    // 2) Fallback a la API de GitHub si el manifiesto aún no existe
    //    (releases antiguas sin este sistema).
    match agent()
        .get(MANIFEST_URL)
        .header("User-Agent", "bundeck-launcher")
        .call()
    {
        Ok(res) => {
            let mut res = res;
            let mut bytes = Vec::new();
            res.body_mut()
                .as_reader()
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

/// Raíz de instalación: `$BUNDECK_INSTALL_DIR` (o `LIBREDECK_INSTALL_DIR` deprecated) o el directorio del exe.
pub fn install_root() -> PathBuf {
    if let Ok(d) = std::env::var("BUNDECK_INSTALL_DIR").or_else(|_| std::env::var("LIBREDECK_INSTALL_DIR")) {
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

const PENDING_UPDATE_FILE: &str = "pending-update.json";

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct PendingUpdateDoc {
    version: String,
}

/// Versión activa según `active.json` (None si instalación legacy sin migrar).
pub fn active_version(root: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(active_file(root)).ok()?;
    serde_json::from_str::<ActiveDoc>(&raw).ok().map(|d| d.version)
}

fn pending_update_path(root: &Path) -> PathBuf {
    root.join(PENDING_UPDATE_FILE)
}

fn valid_version_name(version: &str) -> bool {
    !version.is_empty()
        && !version.starts_with('.')
        && !version.ends_with('.')
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

pub fn staged_update_is_complete(root: &Path, version: &str) -> bool {
    if !valid_version_name(version) {
        return false;
    }
    let stage = versions_dir(root).join(version);
    [
        daemon_file_name(),
        format!("bundeck-cli{}", exe_suffix()),
        format!("bundeck-launcher{}", exe_suffix()),
        format!("bundeck-updater{}", exe_suffix()),
    ]
    .iter()
    .all(|name| stage.join(name).is_file())
        && stage.join("web-dist").join("index.html").is_file()
}

fn pending_update_version_at(root: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(pending_update_path(root)).ok()?;
    let pending = serde_json::from_str::<PendingUpdateDoc>(&raw).ok()?;
    staged_update_is_complete(root, &pending.version).then_some(pending.version)
}

/// Actualización íntegra descargada, pendiente de instalar al reiniciar.
pub fn pending_update_version() -> Option<String> {
    pending_update_version_at(&install_root())
}

fn write_pending_update(root: &Path, version: &str) -> Result<(), String> {
    if !valid_version_name(version) {
        return Err("versión inválida para actualización pendiente".to_string());
    }
    let tmp = root.join("pending-update.json.tmp");
    let dest = pending_update_path(root);
    let contents = serde_json::to_vec(&PendingUpdateDoc {
        version: version.to_string(),
    })
    .map_err(|e| e.to_string())?;
    std::fs::write(&tmp, contents).map_err(|e| format!("guardar actualización pendiente: {e}"))?;
    if dest.exists() {
        let previous = std::fs::read_to_string(&dest)
            .ok()
            .and_then(|raw| serde_json::from_str::<PendingUpdateDoc>(&raw).ok());
        if let Some(previous) = previous {
            if previous.version != version
                && valid_version_name(&previous.version)
                && active_version(root).as_deref() != Some(previous.version.as_str())
            {
                let _ = std::fs::remove_dir_all(versions_dir(root).join(previous.version));
            }
        }
        std::fs::remove_file(&dest)
            .map_err(|e| format!("reemplazar actualización pendiente: {e}"))?;
    }
    std::fs::rename(&tmp, &dest).map_err(|e| format!("guardar actualización pendiente: {e}"))
}

pub fn mark_staged_update_pending(root: &Path, version: &str) -> Result<(), String> {
    if !staged_update_is_complete(root, version) {
        return Err(format!("el stage de BunDeck {version} está incompleto"));
    }
    write_pending_update(root, version)
}

pub fn clear_pending_update(root: &Path, version: &str) {
    if !valid_version_name(version) {
        return;
    }
    let pending = std::fs::read_to_string(pending_update_path(root))
        .ok()
        .and_then(|raw| serde_json::from_str::<PendingUpdateDoc>(&raw).ok());
    if pending.as_ref().is_some_and(|p| p.version == version) {
        let _ = std::fs::remove_file(pending_update_path(root));
        if active_version(root).as_deref() != Some(version) {
            let _ = std::fs::remove_dir_all(versions_dir(root).join(version));
        }
    }
}

fn write_active(root: &Path, version: &str) -> Result<(), String> {
    let doc = ActiveDoc {
        version: version.to_string(),
    };
    let tmp = root.join("active.json.tmp");
    let data = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, data).map_err(|e| friendly_fs_error(root, "activar versión", e))?;
    std::fs::rename(&tmp, active_file(root)).map_err(|e| friendly_fs_error(root, "activar versión", e))?;
    Ok(())
}

/// Error de E/S con una pista accionable si la instalación se encuentra en
/// una carpeta protegida. El instalador oficial usa una ruta por usuario.
fn friendly_fs_error(root: &Path, ctx: &str, e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(5) {
        return format!(
            "{ctx}: sin permiso de escritura en {}. Instala BunDeck en la carpeta recomendada \
             del perfil de usuario para actualizar sin permisos de administrador",
            root.display()
        );
    }
    format!("{ctx}: {e}")
}

fn daemon_file_name() -> String {
    format!("bundeck-daemon{}", exe_suffix())
}

fn legacy_daemon_next_to_launcher(root: &Path) -> Option<PathBuf> {
    let c = root.join(daemon_file_name());
    if c.is_file() {
        return Some(c);
    }
    // compat: instalaciones antiguas con nombre libredeck-*
    let old = root.join(daemon_file_name().replacen("bundeck-", "libredeck-", 1));
    old.is_file().then_some(old)
}

/// Resuelve el exe del daemon: `versions/<activa>/` > legacy plano > None.
/// (El modo dev —`bun run daemon/src/server.ts`— lo decide `monitor`, no aquí.)
pub fn resolve_daemon_exe() -> Option<PathBuf> {
    if let Ok(o) = std::env::var("BUNDECK_DAEMON_EXE").or_else(|_| std::env::var("LIBREDECK_DAEMON_EXE")) {
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
/// puede importar TS): BUNDECK_DATA_DIR (o LIBREDECK_DATA_DIR) > %APPDATA%/BunDeck/data (con fallback LibreDeck) >
/// <repo>/data (dev).
pub fn user_data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("BUNDECK_DATA_DIR").or_else(|_| std::env::var("LIBREDECK_DATA_DIR")) {
        if !d.trim().is_empty() {
            return PathBuf::from(d);
        }
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("APPDATA")
            .or_else(|_| std::env::var("LOCALAPPDATA"))
            .unwrap_or_else(|_| ".".to_string());
        let p = PathBuf::from(base.clone()).join("BunDeck").join("data");
        let legacy = PathBuf::from(base).join("LibreDeck").join("data");
        // Migración: si BunDeck/ no existe pero LibreDeck/ sí, usar el antiguo.
        let candidate = if !p.join("db.sqlite").is_file() && legacy.join("db.sqlite").is_file() {
            legacy
        } else {
            p
        };
        // En dev (sin instalación) el daemon usa <repo>/data; si el
        // candidato instalado no existe y hay un repo cerca, preferirlo.
        if !candidate.join("db.sqlite").is_file() {
            if let Some(repo) = find_repo_data() {
                return repo;
            }
        }
        return candidate;
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
    verify_signature_with_pubkey(version, target, sha256, sig_hex, &pub_hex)
}

fn verify_signature_with_pubkey(
    version: &str,
    target: &str,
    sha256: &str,
    sig_hex: &str,
    pub_hex: &str,
) -> Result<(), String> {
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

/// Descarga el bundle a un temporal de usuario, verifica integridad y extrae
/// la versión en el directorio de instalación, que es escribible porque el
/// instalador usa un destino por usuario.
pub fn download_and_stage(check: &UpdateCheck, progress: &Arc<Mutex<UpdateProgress>>) -> Result<PathBuf, String> {
    download_and_stage_at(check, progress, &install_root())
}

fn download_and_stage_at(
    check: &UpdateCheck,
    progress: &Arc<Mutex<UpdateProgress>>,
    root: &Path,
) -> Result<PathBuf, String> {
    update_progress(progress, |p| {
        p.stage = format!("Descargando {}...", check.asset.bundle);
        p.downloaded = 0;
        p.total = None;
        p.done = false;
        p.error = None;
        p.staged_version = None;
    });

    if !valid_version_name(&check.latest) {
        let error = "version invalida para actualizar".to_string();
        record_download_failure(progress, &error);
        return Err(error);
    }

    // Nombre unico por version + proceso para evitar colisiones entre reintentos.
    let tmp_file = std::env::temp_dir().join(format!(
        "bundeck-{}-{}-{}.zip",
        check.latest,
        current_target(),
        std::process::id()
    ));

    let result = (|| {
        let mut res = agent()
            .get(&check.asset.url)
            .header("User-Agent", "bundeck-launcher")
            .call()
            .map_err(|e| format!("descarga fallida: {e}"))?;
        let total: Option<u64> = res
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .filter(|t: &u64| *t > 0)
            .or(if check.asset.size > 0 {
                Some(check.asset.size)
            } else {
                None
            });
        update_progress(progress, |p| {
            p.total = total;
            p.downloaded = 0;
        });

        let mut reader = res.body_mut().as_reader();
        let mut out = std::fs::File::create(&tmp_file).map_err(|e| {
            format!("crear temporal en {}: {e}", std::env::temp_dir().display())
        })?;
        let mut buf = [0u8; 65536];
        loop {
            let n = reader.read(&mut buf).map_err(|e| format!("leer red: {e}"))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n])
                .map_err(|e| format!("escribir temporal: {e}"))?;
            update_progress(progress, |p| p.downloaded += n as u64);
        }
        drop(out);

        set_download_stage(progress, "Verificando integridad...");
        verify_sha256(&tmp_file, &check.asset.sha256)?;
        if let Some(sig) = check.asset.signature.as_deref().filter(|s| !s.is_empty()) {
            set_download_stage(progress, "Verificando firma...");
            match verify_signature(&check.latest, current_target(), &check.asset.sha256, sig) {
                Ok(()) => {}
                Err(_e) if update_pubkey().is_none() => {
                    // Without a configured public key, signature verification is unavailable.
                }
                Err(e) => return Err(format!("firma del bundle no valida: {e}")),
            }
        }

        set_download_stage(progress, "Extrayendo archivos...");
        let dest = versions_dir(root).join(&check.latest);
        clear_pending_update(root, &check.latest);
        if dest.is_dir() {
            std::fs::remove_dir_all(&dest)
                .map_err(|e| friendly_fs_error(root, "limpiar stage previo", e))?;
        }
        std::fs::create_dir_all(&dest)
            .map_err(|e| friendly_fs_error(root, "crear stage", e))?;
        extract_bundle(&tmp_file, &dest)?;

        let has_daemon = dest.join(daemon_file_name()).is_file();
        let has_web = dest.join("web-dist").is_dir();
        if !has_daemon && !has_web {
            return Err("el bundle no trae ni daemon ni web-dist".to_string());
        }
        set_executable_permissions(&dest)?;
        mark_staged_update_pending(root, &check.latest)?;
        Ok(dest)
    })();

    // Best-effort cleanup on every exit, including network and staging failures.
    let _ = std::fs::remove_file(&tmp_file);
    match &result {
        Ok(_) => update_progress(progress, |p| {
            p.done = true;
            p.error = None;
            p.stage = format!("Lista la version {}", check.latest);
            p.staged_version = Some(check.latest.clone());
        }),
        Err(error) => record_download_failure(progress, error),
    }
    result
}

fn update_progress(
    progress: &Arc<Mutex<UpdateProgress>>,
    update: impl FnOnce(&mut UpdateProgress),
) {
    let mut progress = match progress.lock() {
        Ok(progress) => progress,
        Err(poisoned) => poisoned.into_inner(),
    };
    update(&mut progress);
}

fn set_download_stage(progress: &Arc<Mutex<UpdateProgress>>, stage: &str) {
    update_progress(progress, |p| p.stage = stage.to_string());
}

fn record_download_failure(progress: &Arc<Mutex<UpdateProgress>>, error: &str) {
    update_progress(progress, |p| {
        p.done = false;
        p.error = Some(error.to_string());
        p.stage = format!("Fallo de actualizacion: {error}");
        p.staged_version = None;
    });
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

fn set_executable_permissions(stage: &Path) -> Result<(), String> {
    #[cfg(not(unix))]
    let _ = stage;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in [
            daemon_file_name(),
            "bundeck-cli".to_string(),
            "bundeck-launcher".to_string(),
            "bundeck-updater".to_string(),
        ] {
            let path = stage.join(name);
            if path.is_file() {
                let mut permissions = std::fs::metadata(&path)
                    .map_err(|e| e.to_string())?
                    .permissions();
                permissions.set_mode(0o755);
                std::fs::set_permissions(path, permissions).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// Copia `db.sqlite*` a la carpeta de datos del usuario para que el backup
/// sobreviva a una desinstalación y no requiera permisos especiales.
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
    let dest = data
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
    if !valid_version_name(version) {
        return Err("versión inválida para aplicar actualización".to_string());
    }
    let root = install_root();
    let staged = versions_dir(&root).join(version);
    if !staged.is_dir() {
        return Err(format!("versión {version} no descargada"));
    }
    let mut previous = active_version(&root);
    super::monitor::prepare_update();
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
    // Orden estricto: no se toca active.json hasta que TODO el stack
    // (API + WS + frontend embebido) esté caído. Antes solo se esperaba
    // /health 4s y el frontal podía seguir sirviendo el bundle viejo.
    super::monitor::wait_for_stack_down();
    if !super::monitor::stack_down() {
        log("Aviso: algún servicio sigue respondiendo; sigo de todos modos.".to_string());
    } else {
        log("Stack detenido (API + WS + frontend caídos).".to_string());
    }

    log(format!("Activando versión {version}…"));

    // Self-update del launcher: no puede reemplazarse en caliente
    // (bloqueo en Windows). El helper lo hace tras salir este proceso.
    if staged_launcher_differs(&root, version) {
        log("El launcher también cambia: se aplicará al reiniciar.".to_string());
    }

    let mut launch_and_wait = |expected: &str, emit: &mut dyn FnMut(String)| {
        let (boot, _) = super::monitor::ensure_daemon_spawned();
        for line in boot {
            emit(line);
        }
        wait_for_api_version(expected)
    };
    activate_staged_and_verify(&root, version, previous.as_deref(), log, &mut launch_and_wait)
}

fn activate_staged_and_verify(
    root: &Path,
    version: &str,
    previous: Option<&str>,
    log: &mut dyn FnMut(String),
    launch_and_wait: &mut dyn FnMut(&str, &mut dyn FnMut(String)) -> Result<(), String>,
) -> Result<(), String> {
    log("Arrancando daemon nuevo…".to_string());
    write_active(root, version)?;
    match launch_and_wait(version, log) {
        Ok(()) => {
            log(format!("BunDeck {version} en línea."));
            prune_old_versions(root, version);
            clear_pending_update(root, version);
            Ok(())
        }
        Err(reason) => {
            log(format!(
                "El daemon no confirmó la versión {version} ({reason}); revierto…"
            ));
            if let Some(prev) = previous {
                write_active(root, prev)?;
                clear_pending_update(root, version);
                return match launch_and_wait(prev, log) {
                    Ok(()) => Err(format!(
                        "update a {version} falló ({reason}); restaurada {prev}"
                    )),
                    Err(rollback_reason) => Err(format!(
                        "update a {version} falló ({reason}) y el rollback a {prev} también falló ({rollback_reason})"
                    )),
                };
            }
            clear_pending_update(root, version);
            Err(format!(
                "update a {version} falló ({reason}) y no había versión anterior para rollback"
            ))
        }
    }
}

fn staged_launcher_differs(root: &Path, version: &str) -> bool {
    let staged = versions_dir(root)
        .join(version)
        .join(format!("bundeck-launcher{}", exe_suffix()));
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
        format!("bundeck-cli{}", exe_suffix()),
        "web-dist".to_string(),
    ] {
        let src = root.join(&name);
        let dst = dest.join(&name);
        if src.exists() && !dst.exists() {
            std::fs::rename(&src, &dst).map_err(|e| format!("migrar {name}: {e}"))?;
        }
    }
    // El launcher en ejecución no se puede mover en Windows: se copia.
    let me = format!("bundeck-launcher{}", exe_suffix());
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

/// ¿Hay helper `bundeck-updater` junto al launcher (o staged)?
pub fn helper_path() -> Option<PathBuf> {
    let root = install_root();
    for c in [
        root.join(format!("bundeck-updater{}", exe_suffix())),
        std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|p| p.to_path_buf()))
            .unwrap_or_default()
            .join(format!("bundeck-updater{}", exe_suffix())),
    ] {
        if c.is_file() {
            return Some(c);
        }
    }
    None
}

/// Lanza el helper para reemplazar el launcher en caliente y sale.
/// El helper espera a que este pid muera, copia
/// `versions/<ver>/bundeck-launcher` sobre el exe actual y relanza.
pub fn handoff_self_update(version: &str) -> Result<(), String> {
    let helper = helper_path().ok_or_else(|| "sin helper bundeck-updater".to_string())?;
    let root = install_root();
    let staged = versions_dir(&root)
        .join(version)
        .join(format!("bundeck-launcher{}", exe_suffix()));
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

    fn test_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "bundeck-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    struct BenchmarkTempDir(PathBuf);

    impl BenchmarkTempDir {
        fn new(label: &str) -> Self {
            Self(test_dir(label))
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for BenchmarkTempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn create_complete_stage(root: &Path, version: &str) -> PathBuf {
        let stage = versions_dir(root).join(version);
        std::fs::create_dir_all(stage.join("web-dist")).unwrap();
        for name in [
            daemon_file_name(),
            format!("bundeck-cli{}", exe_suffix()),
            format!("bundeck-launcher{}", exe_suffix()),
            format!("bundeck-updater{}", exe_suffix()),
        ] {
            std::fs::write(stage.join(name), b"test").unwrap();
        }
        std::fs::write(stage.join("web-dist").join("index.html"), b"<html/>").unwrap();
        stage
    }

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
    fn pending_update_is_persisted_only_for_a_complete_stage() {
        let dir = std::env::temp_dir().join(format!(
            "bundeck-pending-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let stage = versions_dir(&dir).join("9.9.9");
        std::fs::create_dir_all(stage.join("web-dist")).unwrap();
        for file in [
            daemon_file_name(),
            format!("bundeck-cli{}", exe_suffix()),
            format!("bundeck-launcher{}", exe_suffix()),
            format!("bundeck-updater{}", exe_suffix()),
        ] {
            std::fs::write(stage.join(file), b"test").unwrap();
        }
        std::fs::write(stage.join("web-dist").join("index.html"), b"<html/>").unwrap();

        assert!(mark_staged_update_pending(&dir, "9.9.9").is_ok());
        assert_eq!(pending_update_version_at(&dir).as_deref(), Some("9.9.9"));
        clear_pending_update(&dir, "9.9.9");
        assert!(pending_update_version_at(&dir).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pending_update_rejects_path_like_versions() {
        assert!(!valid_version_name("../1.2.3"));
        assert!(!valid_version_name("1..3"));
        assert!(valid_version_name("1.2.3"));
    }

    #[test]
    fn stage_validation_requires_every_runtime_component() {
        let dir = test_dir("stage-validation");
        let stage = create_complete_stage(&dir, "2.3.4");
        assert!(staged_update_is_complete(&dir, "2.3.4"));

        let missing_cli = stage.join(format!("bundeck-cli{}", exe_suffix()));
        std::fs::remove_file(&missing_cli).unwrap();
        assert!(!staged_update_is_complete(&dir, "2.3.4"));
        std::fs::write(&missing_cli, b"test").unwrap();

        std::fs::remove_file(stage.join("web-dist").join("index.html")).unwrap();
        assert!(!staged_update_is_complete(&dir, "2.3.4"));
        assert!(!staged_update_is_complete(&dir, "../2.3.4"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pending_cleanup_only_removes_matching_inactive_stage() {
        let dir = test_dir("pending-cleanup");
        let active_stage = create_complete_stage(&dir, "1.0.0");
        let pending_stage = create_complete_stage(&dir, "2.0.0");
        write_active(&dir, "1.0.0").unwrap();
        write_pending_update(&dir, "2.0.0").unwrap();

        clear_pending_update(&dir, "1.0.0");
        assert_eq!(pending_update_version_at(&dir).as_deref(), Some("2.0.0"));
        assert!(pending_stage.exists());

        clear_pending_update(&dir, "2.0.0");
        assert!(!pending_update_path(&dir).exists());
        assert!(active_stage.is_dir());
        assert!(!pending_stage.exists());
        assert_eq!(active_version(&dir).as_deref(), Some("1.0.0"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pending_cleanup_rejects_path_like_marker_versions() {
        let dir = test_dir("pending-path-safety");
        let outside_stage = dir.join("victim");
        std::fs::create_dir_all(&outside_stage).unwrap();
        std::fs::write(outside_stage.join("keep.txt"), b"keep").unwrap();
        std::fs::write(
            pending_update_path(&dir),
            serde_json::to_vec(&PendingUpdateDoc {
                version: "../victim".to_string(),
            })
            .unwrap(),
        )
        .unwrap();

        clear_pending_update(&dir, "../victim");

        assert!(outside_stage.join("keep.txt").is_file());
        assert!(pending_update_path(&dir).is_file());
        assert!(pending_update_version_at(&dir).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bundle_extraction_rejects_parent_traversal() {
        let dir = test_dir("zip-path-safety");
        let zip_path = dir.join("unsafe.zip");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let options: zip::write::FileOptions<'_, '_, ()> =
                zip::write::FileOptions::default();
            writer.start_file("../escaped.txt", options).unwrap();
            writer.write_all(b"outside").unwrap();
            writer.finish().unwrap();
        }
        let dest = dir.join("stage");
        std::fs::create_dir_all(&dest).unwrap();

        let error = extract_bundle(&zip_path, &dest).unwrap_err();

        assert!(error.contains("ruta insegura"));
        assert!(!dir.join("escaped.txt").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn apply_staged_rejects_path_like_version_before_touching_install() {
        let mut log = Vec::new();
        let result = apply_staged(&mut |line| log.push(line), "../outside");

        assert!(result.unwrap_err().contains("inválida"));
        assert!(log.is_empty());
    }

    #[test]
    fn failed_health_check_restores_previous_active_stage() {
        let root = BenchmarkTempDir::new("apply-rollback");
        create_complete_stage(root.path(), "1.0.0");
        let failed_stage = create_complete_stage(root.path(), "2.0.0");
        write_active(root.path(), "1.0.0").unwrap();
        mark_staged_update_pending(root.path(), "2.0.0").unwrap();

        let mut attempts = Vec::new();
        let mut log = Vec::new();
        let mut launch_and_wait = |version: &str, _emit: &mut dyn FnMut(String)| {
            attempts.push(version.to_string());
            if version == "2.0.0" {
                Err("fake health-check failure".to_string())
            } else {
                Ok(())
            }
        };

        let error = activate_staged_and_verify(
            root.path(),
            "2.0.0",
            Some("1.0.0"),
            &mut |line| log.push(line),
            &mut launch_and_wait,
        )
        .unwrap_err();

        assert!(error.contains("restaurada 1.0.0"));
        assert_eq!(
            attempts,
            vec!["2.0.0".to_string(), "1.0.0".to_string()]
        );
        assert_eq!(active_version(root.path()).as_deref(), Some("1.0.0"));
        assert!(!pending_update_path(root.path()).exists());
        assert!(!failed_stage.exists());
        assert!(log.iter().any(|line| line.contains("revierto")));
    }

    #[test]
    fn download_failure_updates_progress_from_local_http_error() {
        use std::net::TcpListener;

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            stream
                .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnope")
                .unwrap();
        });
        let progress = Arc::new(Mutex::new(UpdateProgress {
            done: true,
            staged_version: Some("1.2.3".to_string()),
            ..UpdateProgress::default()
        }));
        let check = UpdateCheck {
            current: "1.0.0".to_string(),
            latest: "9.8.7".to_string(),
            notes_url: String::new(),
            asset: TargetAsset {
                bundle: "local-test.zip".to_string(),
                url: format!("http://{address}/bundle.zip"),
                sha256: "00".repeat(32),
                size: 4,
                signature: None,
            },
            manifest_signed: false,
        };

        let result = download_and_stage(&check, &progress);
        server.join().unwrap();

        assert!(result.unwrap_err().contains("descarga fallida"));
        let progress = progress.lock().unwrap();
        assert!(!progress.done);
        assert!(progress.error.is_some());
        assert!(progress.stage.contains("Fallo de actualizacion"));
        assert!(progress.staged_version.is_none());
    }

    #[test]
    fn local_http_bundle_is_verified_extracted_and_staged_in_isolated_root() {
        use sha2::{Digest, Sha256};
        use std::io::{Cursor, Write};
        use std::net::TcpListener;

        let version = "8.7.6";
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut cursor);
            let options: zip::write::FileOptions<'_, '_, ()> =
                zip::write::FileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored);
            for (name, contents) in [
                (daemon_file_name(), b"fake daemon".as_slice()),
                (format!("bundeck-cli{}", exe_suffix()), b"fake cli".as_slice()),
                (
                    format!("bundeck-launcher{}", exe_suffix()),
                    b"fake launcher".as_slice(),
                ),
                (
                    format!("bundeck-updater{}", exe_suffix()),
                    b"fake updater".as_slice(),
                ),
                ("web-dist/index.html".to_string(), b"<html/>".as_slice()),
            ] {
                zip.start_file(name, options).unwrap();
                zip.write_all(contents).unwrap();
            }
            zip.finish().unwrap();
        }
        let bundle = cursor.into_inner();
        let bundle_size = bundle.len() as u64;
        let expected_sha256 = hex::encode(Sha256::digest(&bundle));
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 2048];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bundle.len()
            )
            .unwrap();
            stream.write_all(&bundle).unwrap();
        });

        let root = BenchmarkTempDir::new("download-stage");
        let progress = Arc::new(Mutex::new(UpdateProgress::default()));
        let check = UpdateCheck {
            current: "8.7.5".to_string(),
            latest: version.to_string(),
            notes_url: String::new(),
            asset: TargetAsset {
                bundle: format!("bundeck-v{version}-{}.zip", current_target()),
                url: format!("http://{address}/bundle.zip"),
                sha256: expected_sha256,
                size: bundle_size,
                signature: None,
            },
            manifest_signed: false,
        };

        let stage = download_and_stage_at(&check, &progress, root.path()).unwrap();
        server.join().unwrap();

        assert_eq!(stage, versions_dir(root.path()).join(version));
        assert!(staged_update_is_complete(root.path(), version));
        assert_eq!(pending_update_version_at(root.path()).as_deref(), Some(version));
        assert!(stage.join("web-dist").join("index.html").is_file());
        let progress = progress.lock().unwrap();
        assert!(progress.done);
        assert!(progress.error.is_none());
        assert_eq!(progress.staged_version.as_deref(), Some(version));
        drop(progress);

        let temp_zip = std::env::temp_dir().join(format!(
            "bundeck-{version}-{}-{}.zip",
            current_target(),
            std::process::id()
        ));
        assert!(!temp_zip.exists(), "downloaded archive should be cleaned up");
    }

    #[test]
    fn permission_error_recommends_user_install() {
        let root = PathBuf::from(r"C:\Program Files\BunDeck");
        let e = std::io::Error::from_raw_os_error(5);
        let msg = friendly_fs_error(&root, "preparar carpeta de versiones", e);
        assert!(msg.contains("perfil de usuario"), " debe sugerir instalación por usuario: {msg}");
        assert!(msg.contains("Program Files"), " debe mostrar la ruta: {msg}");
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
    fn download_failure_records_error_without_marking_success() {
        let progress = Arc::new(Mutex::new(UpdateProgress {
            done: true,
            staged_version: Some("1.2.3".to_string()),
            ..UpdateProgress::default()
        }));

        record_download_failure(&progress, "leer red: conexión interrumpida");

        let progress = progress.lock().unwrap();
        assert!(!progress.done);
        assert_eq!(
            progress.error.as_deref(),
            Some("leer red: conexión interrumpida")
        );
        assert!(progress.stage.contains("conexión interrumpida"));
        assert!(progress.staged_version.is_none());
    }

    #[test]
    fn signature_roundtrip_fixed_seed() {
        use ed25519_dalek::{Signer, SigningKey};
        let seed = [7u8; 32];
        let sk = SigningKey::from_bytes(&seed);
        let pub_hex = hex::encode(sk.verifying_key().to_bytes());
        let sha = "ab".repeat(32);
        let msg = format!("1.6.0|linux-x64|{sha}");
        let sig_hex = hex::encode(sk.sign(msg.as_bytes()).to_bytes());
        assert!(verify_signature_with_pubkey(
            "1.6.0",
            "linux-x64",
            &sha,
            &sig_hex,
            &pub_hex,
        )
        .is_ok());
        // Otro mensaje no valida con la misma firma.
        assert!(verify_signature_with_pubkey(
            "9.9.9",
            "linux-x64",
            &sha,
            &sig_hex,
            &pub_hex,
        )
        .is_err());
    }

    #[test]
    fn signature_verifies_nodejs_signed_vector() {
        // Vector generado con node:crypto (el firmante real de
        // scripts/build-update-manifest.mjs): la firma ed25519 es estándar
        // (RFC 8032), así que dalek 3 debe verificarla sin doble formato.
        // seed aleatoria -> pubkey derivada con createPublicKey.
        let pub_hex = "0d83ccf6c6ec10c1ff1887a0b32b7d68149c626e47eb70ff3c23aa0264f8af24";
        let sha = "ab".repeat(32);
        let sig_hex = "70bf14ff0325800359fbb4bcde91ba0ebaea62d2fb91ca119249171c769d71351b7db050d0a2d34bb9a57a6eda7568fe36fd8e7c225242e49379178051f11308";
        assert!(verify_signature_with_pubkey("1.99.0", "windows-x64", &sha, sig_hex, pub_hex).is_ok());
        // Mensaje manipulado: debe rechazar.
        assert!(verify_signature_with_pubkey("1.99.1", "windows-x64", &sha, sig_hex, pub_hex).is_err());
    }

    #[test]
    fn extract_bundle_roundtrip() {
        let dir = std::env::temp_dir().join(format!("bundeck-zip-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let zip_path = dir.join("b.zip");
        {
            let f = std::fs::File::create(&zip_path).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts: zip::write::FileOptions<'_, '_, ()> =
                zip::write::FileOptions::default();
            w.start_file("bundeck-daemon", opts).unwrap();
            use std::io::Write;
            w.write_all(b"fake").unwrap();
            w.start_file("web-dist/index.html", opts).unwrap();
            w.write_all(b"<html></html>").unwrap();
            w.finish().unwrap();
        }
        let dest = dir.join("out");
        std::fs::create_dir_all(&dest).unwrap();
        extract_bundle(&zip_path, &dest).unwrap();
        assert!(dest.join("bundeck-daemon").is_file());
        assert!(dest.join("web-dist").join("index.html").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "opt-in throughput benchmark; run with --release -- --ignored --nocapture"]
    fn benchmark_sha256_verification_throughput() {
        use sha2::{Digest, Sha256};
        use std::io::Write;
        use std::time::Instant;

        const CHUNK_BYTES: usize = 1024 * 1024;
        const CHUNK_COUNT: usize = 128;
        let total_bytes = (CHUNK_BYTES * CHUNK_COUNT) as u64;
        let temp = BenchmarkTempDir::new("benchmark-sha256");
        let file_path = temp.path().join("sha256-throughput.bin");
        let mut file = std::fs::File::create(&file_path).expect("create SHA-256 fixture");
        let mut chunk = vec![0u8; CHUNK_BYTES];
        for (index, byte) in chunk.iter_mut().enumerate() {
            *byte = (index.wrapping_mul(31).wrapping_add(17) & 0xff) as u8;
        }

        let mut digest = Sha256::new();
        for _ in 0..CHUNK_COUNT {
            file.write_all(&chunk).expect("write SHA-256 fixture");
            digest.update(&chunk);
        }
        file.sync_all().expect("flush SHA-256 fixture");
        drop(file);
        let expected = hex::encode(digest.finalize());

        let started = Instant::now();
        verify_sha256(&file_path, &expected).expect("verify generated SHA-256 fixture");
        let elapsed = started.elapsed();
        let mebibytes = total_bytes as f64 / (1024.0 * 1024.0);
        let throughput = mebibytes / elapsed.as_secs_f64();

        println!(
            "benchmark_sha256_verification_throughput: {mebibytes:.1} MiB verified in {:.3}s ({throughput:.1} MiB/s, warm filesystem cache)",
            elapsed.as_secs_f64()
        );
    }

    #[test]
    #[ignore = "opt-in throughput benchmark; run with --release -- --ignored --nocapture"]
    fn benchmark_zip_extraction_throughput() {
        use std::io::Write;
        use std::time::Instant;

        const FILE_COUNT: usize = 32;
        const FILE_BYTES: usize = 4 * 1024 * 1024;
        let total_uncompressed_bytes = (FILE_COUNT * FILE_BYTES) as u64;
        let temp = BenchmarkTempDir::new("benchmark-zip-extraction");
        let zip_path = temp.path().join("extraction-throughput.zip");
        let payload: Vec<u8> = (0..FILE_BYTES)
            .map(|index| (index.wrapping_mul(31).wrapping_add(17) & 0xff) as u8)
            .collect();

        {
            let file = std::fs::File::create(&zip_path).expect("create ZIP fixture");
            let mut writer = zip::ZipWriter::new(file);
            let options: zip::write::FileOptions<'_, '_, ()> =
                zip::write::FileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored);
            for index in 0..FILE_COUNT {
                writer
                    .start_file(
                        format!("bundeck-v0.0.0/web-dist/assets/chunk-{index:02}.bin"),
                        options,
                    )
                    .expect("start ZIP fixture entry");
                writer
                    .write_all(&payload)
                    .expect("write ZIP fixture entry");
            }
            let file = writer.finish().expect("finish ZIP fixture");
            file.sync_all().expect("flush ZIP fixture");
        }

        let archive_bytes = std::fs::metadata(&zip_path)
            .expect("stat ZIP fixture")
            .len();
        let destination = temp.path().join("extracted");
        std::fs::create_dir_all(&destination).expect("create extraction destination");

        let started = Instant::now();
        extract_bundle(&zip_path, &destination).expect("extract generated ZIP fixture");
        let elapsed = started.elapsed();

        let extracted_bytes: u64 = (0..FILE_COUNT)
            .map(|index| {
                let path = destination
                    .join("web-dist")
                    .join("assets")
                    .join(format!("chunk-{index:02}.bin"));
                std::fs::metadata(path)
                    .expect("stat extracted fixture entry")
                    .len()
            })
            .sum();
        assert_eq!(extracted_bytes, total_uncompressed_bytes);

        let seconds = elapsed.as_secs_f64();
        let archive_mib = archive_bytes as f64 / (1024.0 * 1024.0);
        let extracted_mib = extracted_bytes as f64 / (1024.0 * 1024.0);
        println!(
            "benchmark_zip_extraction_throughput: {FILE_COUNT} stored entries, {archive_mib:.1} MiB archive, {extracted_mib:.1} MiB extracted in {seconds:.3}s ({:.1} MiB/s uncompressed, warm filesystem cache)",
            extracted_mib / seconds
        );
    }
}
