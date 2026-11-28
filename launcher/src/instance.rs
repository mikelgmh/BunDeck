//! Single-instance coordination for the BunDeck launcher.
//!
//! Windows uses one stable, per-session named mutex and a small metadata file
//! in the user's application-data directory. Unix uses a per-user lock file
//! guarded by `flock`; the kernel releases that lock if the owner exits
//! unexpectedly, and the next owner overwrites stale PID metadata. Neither
//! lock identity depends on the executable path, so dev and production builds
//! coordinate with one another.

use std::fmt;
#[cfg(any(windows, unix))]
use std::path::PathBuf;

#[cfg(windows)]
const INSTANCE_MUTEX_NAME: &str = r"Local\BunDeck.Launcher.SingleInstance";

/// Build mode reported by an instance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstanceMode {
    Development,
    Production,
}

impl InstanceMode {
    /// Stable text representation used in metadata.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Development => "development",
            Self::Production => "production",
        }
    }

    fn current() -> Self {
        if std::env::var("DEV_MODE").as_deref() == Ok("true") {
            Self::Development
        } else {
            Self::Production
        }
    }
}

/// Public metadata for the process which currently owns the instance lock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstanceMetadata {
    pub pid: u32,
    pub mode: InstanceMode,
}

#[cfg(not(any(windows, unix)))]
static PORTABLE_INSTANCE: std::sync::Mutex<Option<InstanceMetadata>> =
    std::sync::Mutex::new(None);

impl InstanceMetadata {
    /// Metadata describing this process, suitable for publishing when it owns
    /// the lock.
    pub fn current_process() -> Self {
        Self {
            pid: std::process::id(),
            mode: InstanceMode::current(),
        }
    }
}

/// A held single-instance lock.
///
/// The lock is acquired non-blockingly. If another launcher owns it,
/// [`InstanceLock::is_owner`] is false and [`InstanceLock::existing_instance`]
/// reports its PID and mode when metadata is available.
pub struct InstanceLock {
    owner: bool,
    existing: Option<InstanceMetadata>,
    #[cfg(windows)]
    handle: windows::Win32::Foundation::HANDLE,
    #[cfg(windows)]
    metadata_path: PathBuf,
    #[cfg(unix)]
    file: std::fs::File,
    #[cfg(not(any(windows, unix)))]
    portable_owner: bool,
    // A Windows mutex is owned by the thread that creates it. Keep this guard
    // on that thread so ReleaseMutex is not accidentally called elsewhere.
    #[cfg(windows)]
    _not_send_or_sync: std::marker::PhantomData<std::rc::Rc<()>>,
}

impl InstanceLock {
    /// Acquire BunDeck's stable launcher instance lock.
    ///
    /// This does not block if another process already owns the lock.
    pub fn acquire() -> Result<Self, InstanceLockError> {
        #[cfg(windows)]
        {
            Self::acquire_named(INSTANCE_MUTEX_NAME)
        }
        #[cfg(unix)]
        {
            Self::acquire_file(metadata_path())
        }
        #[cfg(not(any(windows, unix)))]
        {
            Self::acquire_portable()
        }
    }

    /// Whether this process owns the lock and should proceed with startup.
    pub fn is_owner(&self) -> bool {
        self.owner
    }

    /// Metadata for the already-running launcher, if this process is not the
    /// owner and the current instance has published its metadata.
    pub fn existing_instance(&self) -> Option<&InstanceMetadata> {
        self.existing.as_ref()
    }

    #[cfg(windows)]
    fn acquire_named(name: &str) -> Result<Self, InstanceLockError> {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Foundation::CloseHandle;

        let name_wide: Vec<u16> = std::ffi::OsStr::new(name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let handle = unsafe { win32::CreateMutexW(std::ptr::null(), 1, name_wide.as_ptr()) };
        if handle.0.is_null() {
            let code = unsafe { win32::GetLastError() };
            return Err(InstanceLockError::new(format!(
                "CreateMutexW failed with Windows error {code}"
            )));
        }

        // ERROR_ALREADY_EXISTS means this process opened an existing mutex;
        // CreateMutexW ignores initial_owner in that case.
        let owner = unsafe { win32::GetLastError() } != win32::ERROR_ALREADY_EXISTS;
        let metadata_path = metadata_path(name);
        if owner {
            // Clear stale metadata from a process which exited unexpectedly.
            let _ = std::fs::remove_file(&metadata_path);
            if let Err(error) = write_metadata(&metadata_path, &InstanceMetadata::current_process()) {
                unsafe {
                    let _ = win32::ReleaseMutex(handle);
                    let _ = CloseHandle(handle);
                }
                return Err(error);
            }
        }

        let existing = if owner {
            None
        } else {
            read_metadata_with_retry(&metadata_path)
        };

        Ok(Self {
            owner,
            existing,
            handle,
            metadata_path,
            _not_send_or_sync: std::marker::PhantomData,
        })
    }

    #[cfg(unix)]
    fn acquire_file(path: PathBuf) -> Result<Self, InstanceLockError> {
        use std::fs::OpenOptions;
        use std::os::fd::AsRawFd;

        let parent = path
            .parent()
            .ok_or_else(|| InstanceLockError::new("instance lock path has no parent".into()))?;
        std::fs::create_dir_all(parent).map_err(|error| {
            InstanceLockError::new(format!("could not create instance lock directory: {error}"))
        })?;
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&path)
            .map_err(|error| {
                InstanceLockError::new(format!("could not open instance lock file: {error}"))
            })?;

        let lock_result = unsafe {
            unix_lock::flock(
                file.as_raw_fd(),
                unix_lock::LOCK_EX | unix_lock::LOCK_NB,
            )
        };
        if lock_result == 0 {
            write_file_metadata(&mut file, &InstanceMetadata::current_process())?;
            Ok(Self {
                owner: true,
                existing: None,
                file,
            })
        } else {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::WouldBlock {
                return Err(InstanceLockError::new(format!(
                    "could not acquire instance lock: {error}"
                )));
            }
            let existing = read_file_metadata_with_retry(&path);
            Ok(Self {
                owner: false,
                existing,
                file,
            })
        }
    }

    #[cfg(not(any(windows, unix)))]
    fn acquire_portable() -> Result<Self, InstanceLockError> {
        let mut current = PORTABLE_INSTANCE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if current.is_none() {
            *current = Some(InstanceMetadata::current_process());
            Ok(Self {
                owner: true,
                existing: None,
                portable_owner: true,
            })
        } else {
            Ok(Self {
                owner: false,
                existing: current.clone(),
                portable_owner: false,
            })
        }
    }
}

#[cfg(windows)]
impl Drop for InstanceLock {
    fn drop(&mut self) {
        use windows::Win32::Foundation::CloseHandle;

        if self.owner {
            remove_metadata_if_owned(&self.metadata_path);
            unsafe {
                let _ = win32::ReleaseMutex(self.handle);
            }
        }
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

#[cfg(unix)]
impl Drop for InstanceLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;

        let _ = unsafe { unix_lock::flock(self.file.as_raw_fd(), unix_lock::LOCK_UN) };
    }
}

#[cfg(not(any(windows, unix)))]
impl Drop for InstanceLock {
    fn drop(&mut self) {
        if self.portable_owner {
            let mut current = PORTABLE_INSTANCE
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            *current = None;
        }
    }
}

#[cfg(windows)]
mod win32 {
    use windows::Win32::Foundation::HANDLE;

    pub const ERROR_ALREADY_EXISTS: u32 = 183;
    pub const STILL_ACTIVE: u32 = 259;
    // SYNCHRONIZE (para esperar) + PROCESS_QUERY_LIMITED_INFORMATION (para
    // consultar la salida sin necesitar permisos de depuración).
    pub const SYNCHRONIZE: u32 = 0x0010_0000;
    pub const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        pub fn CreateMutexW(
            mutex_attributes: *const std::ffi::c_void,
            initial_owner: i32,
            name: *const u16,
        ) -> HANDLE;
        pub fn GetLastError() -> u32;
        pub fn ReleaseMutex(mutex: HANDLE) -> i32;
        pub fn OpenProcess(desired_access: u32, inherit: i32, pid: u32) -> HANDLE;
        pub fn GetExitCodeProcess(process: HANDLE, exit_code: *mut u32) -> i32;
    }
}

/// ¿Sigue vivo el proceso `pid`? En Windows abre el proceso sin privilegios
/// especiales: si no se puede abrir por PID inexistente está muerto; si se
/// abre pero su exit code ya no es STILL_ACTIVE, también. Un fallo de acceso
/// (proceso de otro usuario) se considera vivo para no matar PIDs ajenos.
#[cfg(windows)]
pub fn is_process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    unsafe {
        let handle = win32::OpenProcess(
            win32::SYNCHRONIZE | win32::PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        );
        if handle.0.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = win32::GetExitCodeProcess(handle, &mut code as *mut u32);
        // NOLINT: CloseHandle ya está importado donde se usa; aquí solo lectura.
        windows::Win32::Foundation::CloseHandle(handle).ok();
        ok != 0 && code == win32::STILL_ACTIVE
    }
}

/// ¿Sigue vivo el proceso `pid`? (Unix: kill(pid, 0)).
/// OJO: pid 0 no es "el proceso 0" sino el grupo de procesos: kill(0,0)
/// tiene éxito siempre y diría "vivo". Se trata como muerto.
#[cfg(unix)]
pub fn is_process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    unix_lock::is_process_alive(pid)
}

#[cfg(unix)]
mod unix_lock {
    pub const LOCK_EX: i32 = 2;
    pub const LOCK_NB: i32 = 4;
    pub const LOCK_UN: i32 = 8;

    #[link(name = "c")]
    unsafe extern "C" {
        pub fn flock(fd: i32, operation: i32) -> i32;
        fn kill(pid: i32, signal: i32) -> i32;
    }

    pub fn is_process_alive(pid: u32) -> bool {
        let Ok(pid) = i32::try_from(pid) else {
            return false;
        };
        let result = unsafe { kill(pid, 0) };
        result == 0
            || std::io::Error::last_os_error().kind() == std::io::ErrorKind::PermissionDenied
    }
}

#[cfg(windows)]
fn metadata_path(mutex_name: &str) -> PathBuf {
    let directory = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("BunDeck");
    let key = mutex_name
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    directory.join(format!("instance-{key}.txt"))
}

#[cfg(unix)]
fn metadata_path() -> PathBuf {
    if let Some(runtime_dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(runtime_dir)
            .join("bundeck")
            .join("launcher-instance.lock");
    }
    if let Some(state_dir) = std::env::var_os("XDG_STATE_HOME") {
        return PathBuf::from(state_dir)
            .join("bundeck")
            .join("launcher-instance.lock");
    }
    if let Some(home_dir) = std::env::var_os("HOME") {
        return PathBuf::from(home_dir)
            .join(".local")
            .join("state")
            .join("bundeck")
            .join("launcher-instance.lock");
    }

    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown-user".into());
    std::env::temp_dir()
        .join(format!("bundeck-{user}"))
        .join("launcher-instance.lock")
}

#[cfg(windows)]
fn write_metadata(
    path: &std::path::Path,
    metadata: &InstanceMetadata,
) -> Result<(), InstanceLockError> {
    let parent = path
        .parent()
        .ok_or_else(|| InstanceLockError::new("instance metadata path has no parent".into()))?;
    std::fs::create_dir_all(parent).map_err(|error| {
        InstanceLockError::new(format!("could not create instance metadata directory: {error}"))
    })?;

    let temporary = path.with_extension(format!("{}.tmp", metadata.pid));
    let contents = format!("{}\n{}\n", metadata.pid, metadata.mode.as_str());
    std::fs::write(&temporary, contents).map_err(|error| {
        InstanceLockError::new(format!("could not write instance metadata: {error}"))
    })?;
    // Only the mutex owner writes this file. Removing an old record first
    // avoids Windows rename's refusal to replace an existing destination.
    let _ = std::fs::remove_file(path);
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(InstanceLockError::new(format!(
            "could not publish instance metadata: {error}"
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn write_file_metadata(
    file: &mut std::fs::File,
    metadata: &InstanceMetadata,
) -> Result<(), InstanceLockError> {
    use std::io::{Seek, SeekFrom, Write};

    file.set_len(0).map_err(|error| {
        InstanceLockError::new(format!("could not clear instance metadata: {error}"))
    })?;
    file.seek(SeekFrom::Start(0)).map_err(|error| {
        InstanceLockError::new(format!("could not seek instance metadata: {error}"))
    })?;
    write!(file, "{}\n{}\n", metadata.pid, metadata.mode.as_str()).map_err(|error| {
        InstanceLockError::new(format!("could not write instance metadata: {error}"))
    })?;
    file.sync_data().map_err(|error| {
        InstanceLockError::new(format!("could not flush instance metadata: {error}"))
    })
}

#[cfg(windows)]
fn read_metadata(path: &std::path::Path) -> Option<InstanceMetadata> {
    let contents = std::fs::read_to_string(path).ok()?;
    parse_metadata(&contents)
}

fn parse_metadata(contents: &str) -> Option<InstanceMetadata> {
    let mut lines = contents.lines();
    let pid = lines.next()?.parse().ok()?;
    let mode = match lines.next()? {
        "development" => InstanceMode::Development,
        "production" => InstanceMode::Production,
        _ => return None,
    };
    Some(InstanceMetadata { pid, mode })
}

#[cfg(unix)]
fn read_file_metadata_with_retry(path: &std::path::Path) -> Option<InstanceMetadata> {
    for _ in 0..50 {
        if let Ok(contents) = std::fs::read_to_string(path) {
            if let Some(metadata) = parse_metadata(&contents) {
                if unix_lock::is_process_alive(metadata.pid) {
                    return Some(metadata);
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    None
}

#[cfg(windows)]
fn read_metadata_with_retry(path: &std::path::Path) -> Option<InstanceMetadata> {
    for _ in 0..50 {
        if let Some(metadata) = read_metadata(path) {
            // Sin chequeo de vida, un fichero stale de un crash mostraba un
            // diálogo "ya hay instancia (PID muerto)" y el taskkill posterior
            // podía alcanzar a un PID reutilizado por otro programa.
            if is_process_alive(metadata.pid) {
                return Some(metadata);
            }
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    None
}

#[cfg(windows)]
fn remove_metadata_if_owned(path: &std::path::Path) {
    if read_metadata(path).is_some_and(|metadata| metadata.pid == std::process::id()) {
        let _ = std::fs::remove_file(path);
    }
}

/// Failure to create the underlying instance lock or publish owner metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceLockError {
    message: String,
}

impl InstanceLockError {
    #[cfg(any(windows, unix))]
    fn new(message: String) -> Self {
        Self { message }
    }
}

impl fmt::Display for InstanceLockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for InstanceLockError {}

#[cfg(test)]
mod tests {
    use super::{InstanceLock, InstanceMode};

    #[test]
    fn process_liveness_basics() {
        // El proceso propio vive; el PID 0 y el máximo no.
        assert!(super::is_process_alive(std::process::id()));
        assert!(!super::is_process_alive(0));
        assert!(!super::is_process_alive(u32::MAX));
    }

    #[cfg(windows)]
    #[test]
    fn stale_metadata_is_ignored() {
        let dir = std::env::temp_dir().join(format!(
            "bundeck-instance-stale-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("instance-stale.txt");
        // PID casi seguro muerto: antes se mostraba el diálogo "ya hay
        // instancia" y el taskkill podía alcanzar un PID reutilizado.
        std::fs::write(&path, "4294967295\nproduction\n").unwrap();
        assert!(!super::is_process_alive(u32::MAX));
        assert!(super::read_metadata_with_retry(&path).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn reports_ownership_and_existing_process_then_releases() {
        let name = test_mutex_name();
        let first = InstanceLock::acquire_named(&name);
        let first = first.expect("first lock should be acquired");
        assert!(first.is_owner());
        assert!(first.existing_instance().is_none());

        let second = InstanceLock::acquire_named(&name)
            .expect("opening an existing lock should succeed");
        assert!(!second.is_owner());
        let existing = second
            .existing_instance()
            .expect("owner metadata should be available");
        assert_eq!(existing.pid, std::process::id());
        assert_eq!(existing.mode, current_test_mode());

        drop(second);
        drop(first);

        let reacquired = InstanceLock::acquire_named(&name)
            .expect("lock should be available after drop");
        assert!(reacquired.is_owner());
    }

    #[cfg(windows)]
    #[test]
    fn windows_mutex_coordinates_with_a_second_process() {
        let name = test_mutex_name();
        let first = InstanceLock::acquire_named(&name).expect("first mutex should be acquired");
        assert!(first.is_owner());

        let child = std::process::Command::new(
            std::env::current_exe().expect("test executable path should be available"),
        )
        .arg("--exact")
        .arg("instance::tests::child_observes_windows_mutex")
        .arg("--nocapture")
        .env("BUNDECK_INSTANCE_TEST_MUTEX", &name)
        .env("BUNDECK_INSTANCE_TEST_PARENT_PID", std::process::id().to_string())
        .output()
        .expect("spawn child test process");
        assert!(
            child.status.success(),
            "child test failed: {}",
            String::from_utf8_lossy(&child.stderr)
        );
        assert!(
            String::from_utf8_lossy(&child.stdout).contains("running 1 test"),
            "child process did not execute the lock assertion: {}",
            String::from_utf8_lossy(&child.stdout)
        );

        drop(first);
        let reacquired =
            InstanceLock::acquire_named(&name).expect("mutex should release after owner exits");
        assert!(reacquired.is_owner());
    }

    #[cfg(windows)]
    #[test]
    fn child_observes_windows_mutex() {
        let Ok(name) = std::env::var("BUNDECK_INSTANCE_TEST_MUTEX") else {
            return;
        };
        let parent_pid: u32 = std::env::var("BUNDECK_INSTANCE_TEST_PARENT_PID")
            .expect("parent PID should be passed to child")
            .parse()
            .expect("parent PID should be numeric");
        let lock = InstanceLock::acquire_named(&name).expect("child mutex attempt");
        assert!(!lock.is_owner());
        assert_eq!(
            lock.existing_instance().map(|metadata| metadata.pid),
            Some(parent_pid)
        );
    }

    #[cfg(unix)]
    #[test]
    fn file_lock_reports_ownership_and_releases() {
        let path = test_lock_path();
        let first =
            InstanceLock::acquire_file(path.clone()).expect("first lock should be acquired");
        assert!(first.is_owner());
        assert!(first.existing_instance().is_none());

        let second = InstanceLock::acquire_file(path.clone())
            .expect("opening an existing lock should succeed");
        assert!(!second.is_owner());
        let existing = second
            .existing_instance()
            .expect("owner metadata should be available");
        assert_eq!(existing.pid, std::process::id());
        assert_eq!(existing.mode, current_test_mode());

        let child = std::process::Command::new(
            std::env::current_exe().expect("test executable path should be available"),
        )
        .arg("--exact")
        .arg("instance::tests::child_observes_parent_instance")
        .arg("--nocapture")
        .env("BUNDECK_INSTANCE_TEST_PATH", &path)
        .env("BUNDECK_INSTANCE_TEST_PARENT_PID", std::process::id().to_string())
        .output()
        .expect("spawn child test process");
        assert!(
            child.status.success(),
            "child test failed: {}",
            String::from_utf8_lossy(&child.stderr)
        );
        assert!(
            String::from_utf8_lossy(&child.stdout).contains("running 1 test"),
            "child process did not execute the lock assertion: {}",
            String::from_utf8_lossy(&child.stdout)
        );

        drop(second);
        drop(first);

        let reacquired =
            InstanceLock::acquire_file(path.clone()).expect("lock should release on drop");
        assert!(reacquired.is_owner());
        drop(reacquired);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(path.parent().expect("test lock has a parent"));
    }

    #[cfg(unix)]
    #[test]
    fn child_observes_parent_instance() {
        let Ok(path) = std::env::var("BUNDECK_INSTANCE_TEST_PATH") else {
            return;
        };
        let parent_pid: u32 = std::env::var("BUNDECK_INSTANCE_TEST_PARENT_PID")
            .expect("parent PID should be passed to child")
            .parse()
            .expect("parent PID should be numeric");
        let lock = InstanceLock::acquire_file(path.into()).expect("child lock attempt");
        assert!(!lock.is_owner());
        assert_eq!(
            lock.existing_instance().map(|metadata| metadata.pid),
            Some(parent_pid)
        );
    }

    #[cfg(unix)]
    #[test]
    fn stale_pid_metadata_does_not_block_a_new_owner() {
        let path = test_lock_path();
        std::fs::create_dir_all(path.parent().expect("test lock has a parent"))
            .expect("create test directory");
        std::fs::write(&path, "4294967295\nproduction\n").expect("write stale metadata");
        assert!(!super::unix_lock::is_process_alive(u32::MAX));

        let lock =
            InstanceLock::acquire_file(path.clone()).expect("stale file should be recoverable");
        assert!(lock.is_owner());
        let published = std::fs::read_to_string(&path).expect("read current metadata");
        assert!(published.starts_with(&format!("{}\n", std::process::id())));
        drop(lock);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(path.parent().expect("test lock has a parent"));
    }

    #[cfg(any(windows, unix))]
    fn current_test_mode() -> InstanceMode {
        if std::env::var("DEV_MODE").as_deref() == Ok("true") {
            InstanceMode::Development
        } else {
            InstanceMode::Production
        }
    }

    #[cfg(windows)]
    fn test_mutex_name() -> String {
        static NEXT_ID: std::sync::atomic::AtomicU64 =
            std::sync::atomic::AtomicU64::new(0);
        format!(
            "Local\\BunDeck.InstanceLock.Test.{}.{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        )
    }

    #[cfg(unix)]
    fn test_lock_path() -> std::path::PathBuf {
        static NEXT_ID: std::sync::atomic::AtomicU64 =
            std::sync::atomic::AtomicU64::new(0);
        std::env::temp_dir()
            .join(format!("bundeck-instance-test-{}", std::process::id()))
            .join(format!(
                "lock-{}.txt",
                NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ))
    }
}
