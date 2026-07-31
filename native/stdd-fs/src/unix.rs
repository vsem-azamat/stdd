//! Unix descriptor-relative filesystem boundary.
//!
//! Every `unsafe` block in the crate is confined here. Each block is a thin
//! libc call using a live Rust-owned descriptor and a NUL-checked `CString`.

#![allow(unsafe_code)]

use crate::protocol::{Mutation, ProtocolError, IDENTITY_VERSION};
use serde::Serialize;
use std::ffi::{CStr, CString, OsStr};
use std::fs::{File, Metadata, OpenOptions};
use std::io;
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapKind {
    Directory,
    File,
}

#[derive(Debug)]
pub struct PlatformCap {
    pub file: File,
    pub kind: CapKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub version: u64,
    pub platform: String,
    pub volume: String,
    pub file_id: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub identity: Identity,
    pub owner: String,
    pub permissions: String,
    pub link_count: String,
    pub size: String,
    pub modified_ns: String,
    pub changed_ns: String,
}

#[derive(Debug, Serialize)]
pub struct Entry {
    pub name: String,
    pub observation: Observation,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimitiveEvidence {
    pub identity: String,
    pub no_follow: String,
    pub atomic_rename: String,
    pub no_replace: String,
    pub file_flush: String,
    pub directory_flush: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeEvidence {
    pub platform: String,
    pub filesystem: String,
    pub filesystem_id: String,
    pub primitives: PrimitiveEvidence,
}

fn platform_name() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(target_os = "macos")]
    {
        "darwin"
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        "unix"
    }
}

fn cstring(value: &OsStr, operation: &str) -> Result<CString, ProtocolError> {
    CString::new(value.as_bytes()).map_err(|_| ProtocolError::invalid(operation, "invalid-nul"))
}

fn kind_from_mode(mode: libc::mode_t) -> &'static str {
    match mode & libc::S_IFMT {
        libc::S_IFDIR => "directory",
        libc::S_IFREG => "file",
        libc::S_IFLNK => "symlink",
        _ => "other",
    }
}

fn timestamp_ns(seconds: i64, nanoseconds: i64) -> String {
    (i128::from(seconds) * 1_000_000_000_i128 + i128::from(nanoseconds)).to_string()
}

fn identity_parts(volume: u64, file_id: u64, kind: &str) -> Identity {
    Identity {
        version: IDENTITY_VERSION,
        platform: platform_name().to_string(),
        volume: volume.to_string(),
        file_id: file_id.to_string(),
        kind: kind.to_string(),
    }
}

#[allow(clippy::unnecessary_cast)]
fn observation_from_stat(stat: &libc::stat) -> Observation {
    #[cfg(target_os = "linux")]
    let (modified_seconds, modified_nanos, changed_seconds, changed_nanos) = (
        stat.st_mtime,
        stat.st_mtime_nsec,
        stat.st_ctime,
        stat.st_ctime_nsec,
    );
    #[cfg(target_os = "macos")]
    let (modified_seconds, modified_nanos, changed_seconds, changed_nanos) = (
        stat.st_mtime,
        stat.st_mtime_nsec,
        stat.st_ctime,
        stat.st_ctime_nsec,
    );
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let (modified_seconds, modified_nanos, changed_seconds, changed_nanos) =
        (stat.st_mtime, 0, stat.st_ctime, 0);
    Observation {
        identity: identity_parts(
            stat.st_dev as u64,
            stat.st_ino as u64,
            kind_from_mode(stat.st_mode),
        ),
        owner: stat.st_uid.to_string(),
        permissions: stat.st_mode.to_string(),
        link_count: stat.st_nlink.to_string(),
        size: stat.st_size.to_string(),
        modified_ns: timestamp_ns(modified_seconds as i64, modified_nanos as i64),
        changed_ns: timestamp_ns(changed_seconds as i64, changed_nanos as i64),
    }
}

fn observation_from_metadata(metadata: &Metadata) -> Observation {
    let kind = if metadata.is_dir() {
        "directory"
    } else if metadata.is_file() {
        "file"
    } else {
        "other"
    };
    Observation {
        identity: identity_parts(metadata.dev(), metadata.ino(), kind),
        owner: metadata.uid().to_string(),
        permissions: metadata.mode().to_string(),
        link_count: metadata.nlink().to_string(),
        size: metadata.size().to_string(),
        modified_ns: timestamp_ns(metadata.mtime(), metadata.mtime_nsec()),
        changed_ns: timestamp_ns(metadata.ctime(), metadata.ctime_nsec()),
    }
}

fn io_error(operation: &str, error: io::Error, mutation: Mutation) -> ProtocolError {
    let os_code = error.raw_os_error();
    let (code, class, retryable) = match os_code {
        Some(libc::ENOENT) => ("not-found", "not-found", false),
        Some(libc::EEXIST) | Some(libc::ENOTEMPTY) => ("identity-conflict", "conflict", false),
        Some(libc::ELOOP) => ("symlink-rejected", "confinement", false),
        Some(libc::ENOTDIR) => ("not-directory", "confinement", false),
        Some(libc::EXDEV) => ("cross-volume", "unsupported", false),
        Some(libc::EINTR) | Some(libc::EAGAIN) => ("os-error", "io", true),
        Some(libc::EOPNOTSUPP) | Some(libc::ENOSYS) => {
            ("unsupported-capability", "unsupported", false)
        }
        _ => ("os-error", "io", false),
    };
    ProtocolError::classified_io(operation, error, code, class, mutation, retryable)
}

fn file_from_fd(fd: RawFd, kind: CapKind, operation: &str) -> Result<PlatformCap, ProtocolError> {
    if fd < 0 {
        return Err(io_error(
            operation,
            io::Error::last_os_error(),
            Mutation::None,
        ));
    }
    // SAFETY: a successful syscall returned a new owned descriptor.
    let file = unsafe { File::from_raw_fd(fd) };
    Ok(PlatformCap { file, kind })
}

#[cfg(not(target_os = "macos"))]
pub fn open_root(path: &Path) -> Result<PlatformCap, ProtocolError> {
    let observed = std::fs::symlink_metadata(path)
        .map_err(|error| io_error("open-root", error, Mutation::None))?;
    if observed.file_type().is_symlink() {
        return Err(ProtocolError::new(
            "open-root",
            "symlink-rejected",
            "confinement",
            Mutation::None,
        ));
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|error| io_error("open-root", error, Mutation::None))?;
    let cap = PlatformCap {
        file,
        kind: CapKind::Directory,
    };
    let opened = metadata(&cap, "open-root")?;
    if observed.dev() != opened.dev() || observed.ino() != opened.ino() {
        return Err(ProtocolError::conflict(
            "open-root",
            "identity-conflict",
            Mutation::None,
        ));
    }
    Ok(cap)
}

#[cfg(target_os = "macos")]
pub fn open_root(path: &Path) -> Result<PlatformCap, ProtocolError> {
    use std::path::Component;

    let mut components = path.components();
    if components.next() != Some(Component::RootDir) {
        return Err(ProtocolError::invalid(
            "open-root",
            "absolute-path-required",
        ));
    }
    let root = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open("/")
        .map_err(|error| io_error("open-root", error, Mutation::None))?;
    let mut current = PlatformCap {
        file: root,
        kind: CapKind::Directory,
    };
    for component in components {
        let name = match component {
            Component::Normal(name) => cstring(name, "open-root")?,
            _ => {
                return Err(ProtocolError::invalid(
                    "open-root",
                    "non-normal-path-component",
                ))
            }
        };
        // SAFETY: current is a live directory descriptor and name is one
        // NUL-terminated component. O_NOFOLLOW rejects every reparse hop.
        let fd = unsafe {
            libc::openat(
                current.file.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        current = file_from_fd(fd, CapKind::Directory, "open-root")?;
    }
    Ok(current)
}

pub fn metadata(cap: &PlatformCap, operation: &str) -> Result<Metadata, ProtocolError> {
    cap.file
        .metadata()
        .map_err(|error| io_error(operation, error, Mutation::None))
}

pub fn observation(cap: &PlatformCap, operation: &str) -> Result<Observation, ProtocolError> {
    Ok(observation_from_metadata(&metadata(cap, operation)?))
}

pub fn identity(cap: &PlatformCap, operation: &str) -> Result<Identity, ProtocolError> {
    Ok(observation(cap, operation)?.identity)
}

pub fn preflight_symlink() -> Result<(), ProtocolError> {
    Ok(())
}

pub fn verify_cap_private(cap: &PlatformCap) -> Result<(), ProtocolError> {
    let observed = metadata(cap, "verify-private")?;
    let expected_mode = if cap.kind == CapKind::Directory {
        0o700
    } else {
        0o600
    };
    if observed.uid() != unsafe { libc::geteuid() } || observed.mode() & 0o777 != expected_mode {
        return Err(ProtocolError::new(
            "verify-private",
            "private-permissions-required",
            "access",
            Mutation::None,
        ));
    }
    Ok(())
}

pub fn stat_at(
    parent: &PlatformCap,
    name: &str,
    operation: &str,
) -> Result<Observation, ProtocolError> {
    let encoded_name = cstring(OsStr::new(name), operation)?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: live directory fd, NUL-terminated basename, writable stat.
    let rc = unsafe {
        libc::fstatat(
            parent.file.as_raw_fd(),
            encoded_name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if rc != 0 {
        return Err(io_error(
            operation,
            io::Error::last_os_error(),
            Mutation::None,
        ));
    }
    // SAFETY: successful fstatat initialized the structure.
    Ok(observation_from_stat(unsafe { &stat.assume_init() }))
}

fn open_child_observed(
    parent: &PlatformCap,
    name: &str,
    operation: &str,
    observed: &Observation,
) -> Result<PlatformCap, ProtocolError> {
    if observed.identity.kind == "symlink" {
        return Err(ProtocolError::new(
            operation,
            "symlink-rejected",
            "confinement",
            Mutation::None,
        ));
    }
    let kind = match observed.identity.kind.as_str() {
        "directory" => CapKind::Directory,
        "file" => CapKind::File,
        _ => {
            return Err(ProtocolError::new(
                operation,
                "unsupported-file-type",
                "unsupported",
                Mutation::None,
            ))
        }
    };
    let name = cstring(OsStr::new(name), operation)?;
    let flags = libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | if kind == CapKind::Directory {
            libc::O_RDONLY | libc::O_DIRECTORY
        } else {
            libc::O_RDWR
        };
    // SAFETY: live directory fd and NUL-terminated basename.
    let fd = unsafe { libc::openat(parent.file.as_raw_fd(), name.as_ptr(), flags) };
    let cap = file_from_fd(fd, kind, operation)?;
    if identity(&cap, operation)? != observed.identity {
        return Err(ProtocolError::conflict(
            operation,
            "identity-conflict",
            Mutation::None,
        ));
    }
    Ok(cap)
}

pub fn open_child(
    parent: &PlatformCap,
    name: &str,
    operation: &str,
) -> Result<PlatformCap, ProtocolError> {
    let observed = stat_at(parent, name, operation)?;
    open_child_observed(parent, name, operation, &observed)
}

fn apply_creation_mode(cap: &PlatformCap, mode: u32, operation: &str) -> Result<(), ProtocolError> {
    // SAFETY: cap owns a live descriptor and mode was validated by the protocol.
    if unsafe { libc::fchmod(cap.file.as_raw_fd(), mode as libc::mode_t) } != 0 {
        return Err(io_error(
            operation,
            io::Error::last_os_error(),
            Mutation::Committed,
        ));
    }
    let observed = metadata(cap, operation).map_err(|mut error| {
        error.body.mutation = Mutation::Committed;
        error
    })?;
    if observed.mode() & 0o7777 != mode {
        return Err(ProtocolError::new(
            operation,
            "mode-verification-failed",
            "unsupported",
            Mutation::Committed,
        ));
    }
    Ok(())
}

pub fn set_mode(cap: &PlatformCap, mode: u32) -> Result<Observation, ProtocolError> {
    let operation = "set-mode";
    // SAFETY: cap owns a live descriptor and the protocol admitted only the
    // legacy metadata-v1 permission-bit range (no type or special bits).
    if unsafe { libc::fchmod(cap.file.as_raw_fd(), mode as libc::mode_t) } != 0 {
        return Err(set_mode_syscall_error(io::Error::last_os_error()));
    }
    let observed = observation(cap, operation).map_err(|mut error| {
        error.body.mutation = Mutation::Committed;
        error
    })?;
    let permissions = observed.permissions.parse::<u32>().map_err(|_| {
        ProtocolError::new(
            operation,
            "mode-verification-failed",
            "unsupported",
            Mutation::Committed,
        )
    })?;
    if permissions & 0o7777 != mode {
        return Err(ProtocolError::new(
            operation,
            "mode-verification-failed",
            "unsupported",
            Mutation::Committed,
        ));
    }
    Ok(observed)
}

fn set_mode_syscall_error(error: io::Error) -> ProtocolError {
    io_error("set-mode", error, Mutation::None)
}

struct UmaskGuard(libc::mode_t);

impl Drop for UmaskGuard {
    fn drop(&mut self) {
        // SAFETY: the helper is single-threaded and this restores the value
        // captured immediately before the creation syscall.
        unsafe { libc::umask(self.0) };
    }
}

fn neutralize_creation_umask() -> UmaskGuard {
    // SAFETY: every mode_t is a valid umask; the guard restores it before
    // request processing continues.
    UmaskGuard(unsafe { libc::umask(0) })
}

fn creation_basename() -> Result<String, ProtocolError> {
    let mut nonce = [0_u8; 24];
    let mut source = std::fs::File::open("/dev/urandom")
        .map_err(|error| io_error("create-directory", error, Mutation::None))?;
    source
        .read_exact(&mut nonce)
        .map_err(|error| io_error("create-directory", error, Mutation::None))?;
    let encoded = nonce
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!(".stdd-create-{encoded}"))
}

pub fn create_directory(
    parent: &PlatformCap,
    name: &str,
    mode: u32,
) -> Result<PlatformCap, ProtocolError> {
    match stat_at(parent, name, "create-directory") {
        Ok(_) => {
            return Err(ProtocolError::conflict(
                "create-directory",
                "identity-conflict",
                Mutation::None,
            ));
        }
        Err(error) if error.body.code == "not-found" => {}
        Err(error) => return Err(error),
    }

    let mut temporary = None;
    for _ in 0..16 {
        let candidate = creation_basename()?;
        let candidate_c = cstring(OsStr::new(&candidate), "create-directory")?;
        let umask = neutralize_creation_umask();
        // SAFETY: live directory fd and NUL-terminated basename.
        let rc = unsafe {
            libc::mkdirat(
                parent.file.as_raw_fd(),
                candidate_c.as_ptr(),
                mode as libc::mode_t,
            )
        };
        let error = (rc != 0).then(io::Error::last_os_error);
        drop(umask);
        if rc == 0 {
            temporary = Some(candidate);
            break;
        }
        let error = error.expect("failed mkdirat must capture errno");
        if error.raw_os_error() != Some(libc::EEXIST) {
            return Err(io_error("create-directory", error, Mutation::None));
        }
    }
    let temporary = temporary.ok_or_else(|| {
        ProtocolError::new(
            "create-directory",
            "temporary-name-exhausted",
            "io",
            Mutation::None,
        )
    })?;

    let observed = stat_at(parent, &temporary, "create-directory").map_err(|mut error| {
        error.body.mutation = Mutation::Committed;
        error
    })?;
    let cap = open_child_observed(parent, &temporary, "create-directory", &observed).map_err(
        |mut error| {
            error.body.mutation = Mutation::Committed;
            error
        },
    )?;
    apply_creation_mode(&cap, mode, "create-directory")?;
    let (unexpected, _) = list(&cap, None, 1).map_err(|mut error| {
        error.body.operation = "create-directory".to_string();
        error.body.mutation = Mutation::Committed;
        error
    })?;
    if !unexpected.is_empty() {
        return Err(ProtocolError::conflict(
            "create-directory",
            "created-directory-not-empty",
            Mutation::Committed,
        ));
    }
    let created_identity = identity(&cap, "create-directory").map_err(|mut error| {
        error.body.mutation = Mutation::Committed;
        error
    })?;
    let staged = stat_at(parent, &temporary, "create-directory").map_err(|mut error| {
        error.body.mutation = Mutation::Committed;
        error
    })?;
    if staged.identity != created_identity {
        return Err(ProtocolError::conflict(
            "create-directory",
            "identity-conflict",
            Mutation::Committed,
        ));
    }
    rename(
        parent,
        &temporary,
        &created_identity,
        parent,
        name,
        None,
        true,
    )
    .map_err(|mut error| {
        error.body.operation = "create-directory".to_string();
        error.body.mutation = Mutation::Committed;
        error
    })?;
    let published = stat_at(parent, name, "create-directory").map_err(|mut error| {
        error.body.mutation = Mutation::Committed;
        error
    })?;
    if published.identity != created_identity {
        return Err(ProtocolError::conflict(
            "create-directory",
            "post-create-identity-conflict",
            Mutation::Committed,
        ));
    }
    Ok(cap)
}

pub fn create_file(
    parent: &PlatformCap,
    name: &str,
    mode: u32,
) -> Result<PlatformCap, ProtocolError> {
    let name = cstring(OsStr::new(name), "create-file")?;
    let umask = neutralize_creation_umask();
    // SAFETY: live directory fd, NUL-terminated basename, returned fd owned.
    let fd = unsafe {
        libc::openat(
            parent.file.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            mode as libc::c_uint,
        )
    };
    let error = (fd < 0).then(io::Error::last_os_error);
    drop(umask);
    if let Some(error) = error {
        return Err(io_error("create-file", error, Mutation::None));
    }
    // SAFETY: successful openat returned a new owned descriptor.
    let cap = PlatformCap {
        file: unsafe { File::from_raw_fd(fd) },
        kind: CapKind::File,
    };
    apply_creation_mode(&cap, mode, "create-file")?;
    Ok(cap)
}

pub fn list(
    parent: &PlatformCap,
    cursor: Option<i64>,
    limit: usize,
) -> Result<(Vec<Entry>, Option<i64>), ProtocolError> {
    // SAFETY: dup creates an independently owned descriptor.
    let duplicate = unsafe { libc::dup(parent.file.as_raw_fd()) };
    if duplicate < 0 {
        return Err(io_error("list", io::Error::last_os_error(), Mutation::None));
    }
    // SAFETY: ownership of duplicate passes to DIR* on success.
    let directory = unsafe { libc::fdopendir(duplicate) };
    if directory.is_null() {
        // SAFETY: fdopendir did not take ownership on failure.
        unsafe { libc::close(duplicate) };
        return Err(io_error("list", io::Error::last_os_error(), Mutation::None));
    }
    let result = (|| {
        if let Some(cursor) = cursor {
            // SAFETY: directory is live and cursor came from telldir for this
            // directory capability.
            unsafe { libc::seekdir(directory, cursor as libc::c_long) };
        } else {
            // SAFETY: directory is live; a fresh listing starts at its beginning.
            unsafe { libc::rewinddir(directory) };
        }
        let mut entries = Vec::new();
        while entries.len() < limit {
            // SAFETY: directory remains live through closedir below.
            let entry = unsafe { libc::readdir(directory) };
            if entry.is_null() {
                break;
            }
            // SAFETY: POSIX d_name is NUL-terminated.
            let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            let name = std::str::from_utf8(bytes)
                .map_err(|_| ProtocolError::unsupported("list", "non-utf8-name"))?
                .to_string();
            entries.push(Entry {
                observation: stat_at(parent, &name, "list")?,
                name,
            });
        }
        let next_cursor = if entries.len() == limit {
            // SAFETY: directory remains live through closedir below.
            let cursor = unsafe { libc::telldir(directory) };
            if cursor < 0 {
                return Err(io_error("list", io::Error::last_os_error(), Mutation::None));
            }
            Some(cursor as i64)
        } else {
            None
        };
        Ok::<_, ProtocolError>((entries, next_cursor))
    })();
    // SAFETY: directory is closed exactly once.
    let rc = unsafe { libc::closedir(directory) };
    let page = result?;
    if rc != 0 {
        return Err(io_error("list", io::Error::last_os_error(), Mutation::None));
    }
    Ok(page)
}

pub fn read(cap: &PlatformCap, offset: u64, length: usize) -> Result<Vec<u8>, ProtocolError> {
    let mut bytes = vec![0; length];
    // SAFETY: writable buffer and live descriptor.
    let count = unsafe {
        libc::pread(
            cap.file.as_raw_fd(),
            bytes.as_mut_ptr().cast(),
            bytes.len(),
            offset as libc::off_t,
        )
    };
    if count < 0 {
        return Err(io_error("read", io::Error::last_os_error(), Mutation::None));
    }
    bytes.truncate(count as usize);
    Ok(bytes)
}

pub fn write(cap: &PlatformCap, offset: u64, bytes: &[u8]) -> Result<usize, ProtocolError> {
    // SAFETY: readable buffer and live descriptor.
    let count = unsafe {
        libc::pwrite(
            cap.file.as_raw_fd(),
            bytes.as_ptr().cast(),
            bytes.len(),
            offset as libc::off_t,
        )
    };
    if count < 0 {
        return Err(io_error(
            "write",
            io::Error::last_os_error(),
            Mutation::None,
        ));
    }
    Ok(count as usize)
}

pub fn truncate(cap: &PlatformCap, size: u64) -> Result<(), ProtocolError> {
    // SAFETY: live descriptor; protocol bounds size to off_t.
    let rc = unsafe { libc::ftruncate(cap.file.as_raw_fd(), size as libc::off_t) };
    if rc != 0 {
        return Err(io_error(
            "truncate",
            io::Error::last_os_error(),
            Mutation::None,
        ));
    }
    Ok(())
}

pub fn flush(cap: &PlatformCap, _mode: &str) -> Result<(), ProtocolError> {
    #[cfg(target_os = "macos")]
    {
        return macos_durable_flush(cap.file.as_raw_fd())
            .map_err(|error| io_error("flush", error, Mutation::Possible));
    }
    #[cfg(not(target_os = "macos"))]
    {
        // SAFETY: both calls operate on a live descriptor.
        let rc = unsafe {
            if _mode == "data" && cap.kind == CapKind::File {
                libc::fdatasync(cap.file.as_raw_fd())
            } else {
                libc::fsync(cap.file.as_raw_fd())
            }
        };
        if rc != 0 {
            return Err(io_error(
                "flush",
                io::Error::last_os_error(),
                Mutation::Possible,
            ));
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn macos_durable_flush(fd: RawFd) -> io::Result<()> {
    // SAFETY: the descriptor is live. fsync first commits kernel state; the
    // full-device flush is the strongest documented Darwin durability call.
    if unsafe { libc::fsync(fd) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: F_FULLFSYNC takes no pointer argument and uses the live fd.
    if unsafe { libc::fcntl(fd, libc::F_FULLFSYNC) } == 0 {
        return Ok(());
    }
    let full_error = io::Error::last_os_error();
    if !matches!(
        full_error.raw_os_error(),
        Some(libc::EINVAL) | Some(libc::ENOTSUP)
    ) {
        return Err(full_error);
    }
    // SAFETY: APFS may expose only the ordering barrier for a particular
    // handle class (notably directories). The preceding fsync plus this
    // barrier is the strongest documented sequence available in that case.
    if unsafe { libc::fcntl(fd, libc::F_BARRIERFSYNC) } == 0 {
        return Ok(());
    }
    let barrier_error = io::Error::last_os_error();
    if matches!(
        barrier_error.raw_os_error(),
        Some(libc::EINVAL) | Some(libc::ENOTSUP)
    ) {
        // fsync already succeeded; both stronger optional operations were
        // explicitly unavailable for this handle.
        return Ok(());
    }
    Err(barrier_error)
}

pub fn rename(
    from_parent: &PlatformCap,
    from: &str,
    expected: &Identity,
    to_parent: &PlatformCap,
    to: &str,
    expected_target: Option<&Identity>,
    no_replace: bool,
) -> Result<(), ProtocolError> {
    let from_name = from;
    let to_name = to;
    let from = cstring(OsStr::new(from_name), "rename")?;
    let to = cstring(OsStr::new(to_name), "rename")?;
    // Revalidate at the syscall boundary. Unix has no rename-if-inode-matches
    // primitive, so unpredictable staging names, this immediate check, atomic
    // rename, and the caller's postflight form the strongest available bind.
    if stat_at(from_parent, from_name, "rename")?.identity != *expected {
        return Err(ProtocolError::conflict(
            "rename",
            "identity-conflict",
            Mutation::None,
        ));
    }
    if let Some(expected_target) = expected_target {
        if stat_at(to_parent, to_name, "rename")?.identity != *expected_target {
            return Err(ProtocolError::conflict(
                "rename",
                "identity-conflict",
                Mutation::None,
            ));
        }
    }
    #[cfg(target_os = "linux")]
    let rc = {
        // SAFETY: live directory fds and NUL-terminated basenames.
        unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                from_parent.file.as_raw_fd(),
                from.as_ptr(),
                to_parent.file.as_raw_fd(),
                to.as_ptr(),
                if no_replace {
                    libc::RENAME_NOREPLACE
                } else {
                    0
                },
            ) as i32
        }
    };
    #[cfg(target_os = "macos")]
    let rc = if no_replace {
        // SAFETY: dedicated macOS atomic no-replace primitive.
        unsafe {
            libc::renameatx_np(
                from_parent.file.as_raw_fd(),
                from.as_ptr(),
                to_parent.file.as_raw_fd(),
                to.as_ptr(),
                libc::RENAME_EXCL,
            )
        }
    } else {
        // SAFETY: live directory fds and valid basenames.
        unsafe {
            libc::renameat(
                from_parent.file.as_raw_fd(),
                from.as_ptr(),
                to_parent.file.as_raw_fd(),
                to.as_ptr(),
            )
        }
    };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let rc = {
        if no_replace {
            return Err(ProtocolError::unsupported(
                "rename",
                "no-replace-unavailable",
            ));
        }
        // SAFETY: live directory fds and valid basenames.
        unsafe {
            libc::renameat(
                from_parent.file.as_raw_fd(),
                from.as_ptr(),
                to_parent.file.as_raw_fd(),
                to.as_ptr(),
            )
        }
    };
    if rc != 0 {
        return Err(io_error(
            "rename",
            io::Error::last_os_error(),
            Mutation::None,
        ));
    }
    Ok(())
}

pub fn symlink(parent: &PlatformCap, name: &str, target: &str) -> Result<(), ProtocolError> {
    let name = cstring(OsStr::new(name), "symlink")?;
    let target = cstring(OsStr::new(target), "symlink")?;
    // SAFETY: live directory fd and NUL-terminated strings.
    let rc = unsafe { libc::symlinkat(target.as_ptr(), parent.file.as_raw_fd(), name.as_ptr()) };
    if rc != 0 {
        return Err(io_error(
            "symlink",
            io::Error::last_os_error(),
            Mutation::None,
        ));
    }
    Ok(())
}

pub fn read_link(
    parent: &PlatformCap,
    name: &str,
    expected: &Identity,
    max_bytes: usize,
) -> Result<Vec<u8>, ProtocolError> {
    let operation = "read-link";
    let before = stat_at(parent, name, operation)?.identity;
    if before != *expected {
        return Err(ProtocolError::conflict(
            operation,
            "identity-conflict",
            Mutation::None,
        ));
    }
    if before.kind != "symlink" {
        return Err(ProtocolError::invalid(
            operation,
            "symlink-identity-required",
        ));
    }
    let encoded_name = cstring(OsStr::new(name), operation)?;
    let mut capacity = 256_usize.min(max_bytes.saturating_add(1)).max(1);
    let bytes = loop {
        let mut bytes = vec![0_u8; capacity];
        // SAFETY: parent is a live directory fd, name is NUL-terminated, and
        // bytes is writable for exactly capacity bytes. readlinkat does not
        // follow the final link.
        let count = unsafe {
            libc::readlinkat(
                parent.file.as_raw_fd(),
                encoded_name.as_ptr(),
                bytes.as_mut_ptr().cast(),
                bytes.len(),
            )
        };
        if count < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(io_error(operation, error, Mutation::None));
        }
        let count = count as usize;
        if count < capacity {
            if count > max_bytes {
                return Err(ProtocolError::new(
                    operation,
                    "link-target-too-large",
                    "limit",
                    Mutation::None,
                ));
            }
            bytes.truncate(count);
            break bytes;
        }
        if capacity > max_bytes {
            return Err(ProtocolError::new(
                operation,
                "link-target-too-large",
                "limit",
                Mutation::None,
            ));
        }
        capacity = capacity.saturating_mul(2).min(max_bytes.saturating_add(1));
    };
    let after = stat_at(parent, name, operation)?.identity;
    if after != before {
        return Err(ProtocolError::conflict(
            operation,
            "identity-conflict",
            Mutation::None,
        ));
    }
    Ok(bytes)
}

#[cfg(target_os = "linux")]
fn linux_filesystem_name(filesystem_id: u64) -> Option<&'static str> {
    match filesystem_id {
        0x0000_0000_0000_ef53 => Some("ext"),
        0x0000_0000_0102_1994 => Some("tmpfs"),
        0x0000_0000_5846_5342 => Some("xfs"),
        0x0000_0000_794c_7630 => Some("overlayfs"),
        0x0000_0000_9123_683e => Some("btrfs"),
        _ => None,
    }
}

#[cfg(target_os = "linux")]
pub fn probe(root: &PlatformCap) -> Result<ProbeEvidence, ProtocolError> {
    let mut state = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: root is a live fd and state is writable.
    let rc = unsafe { libc::fstatfs(root.file.as_raw_fd(), state.as_mut_ptr()) };
    if rc != 0 {
        return Err(io_error(
            "probe",
            io::Error::last_os_error(),
            Mutation::None,
        ));
    }
    // SAFETY: successful fstatfs initialized state.
    let filesystem_id = unsafe { state.assume_init().f_type as u64 };
    let filesystem = linux_filesystem_name(filesystem_id)
        .ok_or_else(|| ProtocolError::unsupported("probe", "unsupported-capability"))?;
    let invalid_name = b"stdd-probe\0";
    // SAFETY: this deliberately uses invalid directory descriptors, so a
    // compiled renameat2 syscall can only fail without touching a namespace.
    // ENOSYS distinguishes a kernel without the required primitive.
    let rename_probe = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            -1,
            invalid_name.as_ptr().cast::<libc::c_char>(),
            -1,
            invalid_name.as_ptr().cast::<libc::c_char>(),
            libc::RENAME_NOREPLACE,
        )
    };
    if rename_probe != -1 || io::Error::last_os_error().raw_os_error() != Some(libc::EBADF) {
        return Err(ProtocolError::unsupported(
            "probe",
            "unsupported-capability",
        ));
    }
    Ok(ProbeEvidence {
        platform: "linux".to_string(),
        filesystem: filesystem.to_string(),
        filesystem_id: format!("0x{filesystem_id:x}"),
        primitives: PrimitiveEvidence {
            identity: "dev+ino".to_string(),
            no_follow: "openat(O_NOFOLLOW)+readlinkat(identity-postflight)".to_string(),
            atomic_rename: "renameat2".to_string(),
            no_replace: "renameat2(RENAME_NOREPLACE)".to_string(),
            file_flush: "fsync/fdatasync".to_string(),
            directory_flush: "fsync".to_string(),
        },
    })
}

#[cfg(target_os = "macos")]
fn macos_filesystem_supported(filesystem: &str) -> bool {
    filesystem == "apfs"
}

#[cfg(target_os = "macos")]
pub fn probe(root: &PlatformCap) -> Result<ProbeEvidence, ProtocolError> {
    let mut state = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: root is a live fd and state is writable.
    let rc = unsafe { libc::fstatfs(root.file.as_raw_fd(), state.as_mut_ptr()) };
    if rc != 0 {
        return Err(io_error(
            "probe",
            io::Error::last_os_error(),
            Mutation::None,
        ));
    }
    // SAFETY: successful fstatfs initialized state and f_fstypename is NUL-terminated.
    let state = unsafe { state.assume_init() };
    let filesystem = unsafe { CStr::from_ptr(state.f_fstypename.as_ptr()) }
        .to_str()
        .map_err(|_| ProtocolError::unsupported("probe", "unsupported-capability"))?;
    if !macos_filesystem_supported(filesystem) {
        return Err(ProtocolError::unsupported(
            "probe",
            "unsupported-capability",
        ));
    }
    let invalid_name = b"stdd-probe\0";
    // SAFETY: deliberately invalid descriptors make this a non-mutating API
    // availability check. A supported renameatx_np reports EBADF.
    let rename_probe = unsafe {
        libc::renameatx_np(
            -1,
            invalid_name.as_ptr().cast(),
            -1,
            invalid_name.as_ptr().cast(),
            libc::RENAME_EXCL,
        )
    };
    if rename_probe != -1 || io::Error::last_os_error().raw_os_error() != Some(libc::EBADF) {
        return Err(ProtocolError::unsupported(
            "probe",
            "unsupported-capability",
        ));
    }
    macos_durable_flush(root.file.as_raw_fd())
        .map_err(|error| io_error("probe", error, Mutation::None))?;
    Ok(ProbeEvidence {
        platform: "darwin".to_string(),
        filesystem: filesystem.to_string(),
        filesystem_id: filesystem.to_string(),
        primitives: PrimitiveEvidence {
            identity: "dev+ino".to_string(),
            no_follow: "openat(O_NOFOLLOW)+readlinkat(identity-postflight)".to_string(),
            atomic_rename: "renameat".to_string(),
            no_replace: "renameatx_np(RENAME_EXCL)".to_string(),
            file_flush: "fsync+fcntl(F_FULLFSYNC/F_BARRIERFSYNC)".to_string(),
            directory_flush: "fsync+fcntl(F_FULLFSYNC/F_BARRIERFSYNC)".to_string(),
        },
    })
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn probe(_root: &PlatformCap) -> Result<ProbeEvidence, ProtocolError> {
    Err(ProtocolError::unsupported(
        "probe",
        "unsupported-capability",
    ))
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;

    #[test]
    fn set_mode_syscall_failure_is_non_mutating() {
        let error = super::set_mode_syscall_error(std::io::Error::from_raw_os_error(libc::EACCES));
        assert!(matches!(error.body.mutation, super::Mutation::None));
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_probe_allowlist_uses_exact_filesystem_magic_values() {
        use super::linux_filesystem_name;
        assert_eq!(linux_filesystem_name(0xef53), Some("ext"));
        assert_eq!(linux_filesystem_name(0x0102_1994), Some("tmpfs"));
        assert_eq!(linux_filesystem_name(0x5846_5342), Some("xfs"));
        assert_eq!(linux_filesystem_name(0x794c_7630), Some("overlayfs"));
        assert_eq!(linux_filesystem_name(0x9123_683e), Some("btrfs"));
        assert_eq!(linux_filesystem_name(0), None);
    }

    #[cfg(unix)]
    #[test]
    fn creation_modes_are_exact_despite_restrictive_umask() {
        let root = std::env::temp_dir().join(format!(
            "stdd-fs-mode-parent-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let canonical_root = root.canonicalize().unwrap();
        let status = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                "umask 0777; exec \"$1\" --exact unix::tests::creation_modes_umask_child",
                "sh",
            ])
            .arg(std::env::current_exe().unwrap())
            .env("STDD_FS_UMASK_CHILD", "1")
            .env("STDD_FS_UMASK_ROOT", &canonical_root)
            .status()
            .unwrap();
        fs::remove_dir_all(root).unwrap();
        assert!(status.success());
    }

    #[cfg(unix)]
    #[test]
    fn creation_modes_umask_child() {
        if std::env::var_os("STDD_FS_UMASK_CHILD").is_none() {
            return;
        }

        let root = std::path::PathBuf::from(std::env::var_os("STDD_FS_UMASK_ROOT").unwrap());
        let held = super::open_root(&root).unwrap();
        for mode in [0o700, 0o755] {
            let name = format!("dir-{mode:o}");
            let cap = super::create_directory(&held, &name, mode).unwrap();
            assert_eq!(super::metadata(&cap, "test").unwrap().mode() & 0o7777, mode);
        }
        for mode in [0o600, 0o644, 0o755] {
            let name = format!("file-{mode:o}");
            let cap = super::create_file(&held, &name, mode).unwrap();
            assert_eq!(super::metadata(&cap, "test").unwrap().mode() & 0o7777, mode);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_probe_and_durability_constants_are_exact() {
        assert!(super::macos_filesystem_supported("apfs"));
        assert!(!super::macos_filesystem_supported("hfs"));
        assert_eq!(libc::RENAME_EXCL, 0x4);
        assert_eq!(libc::F_FULLFSYNC, 51);
        assert_eq!(libc::F_BARRIERFSYNC, 85);
    }
}
