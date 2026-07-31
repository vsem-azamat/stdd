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
        stat.st_mtimespec.tv_sec,
        stat.st_mtimespec.tv_nsec,
        stat.st_ctimespec.tv_sec,
        stat.st_ctimespec.tv_nsec,
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

pub fn stat_at(
    parent: &PlatformCap,
    name: &str,
    operation: &str,
) -> Result<Observation, ProtocolError> {
    let name = cstring(OsStr::new(name), operation)?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: live directory fd, NUL-terminated basename, writable stat.
    let rc = unsafe {
        libc::fstatat(
            parent.file.as_raw_fd(),
            name.as_ptr(),
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

pub fn create_directory(parent: &PlatformCap, name: &str) -> Result<PlatformCap, ProtocolError> {
    let name_c = cstring(OsStr::new(name), "create-directory")?;
    // SAFETY: live directory fd and NUL-terminated basename.
    let rc = unsafe { libc::mkdirat(parent.file.as_raw_fd(), name_c.as_ptr(), 0o700) };
    if rc != 0 {
        return Err(io_error(
            "create-directory",
            io::Error::last_os_error(),
            Mutation::None,
        ));
    }
    let observed = stat_at(parent, name, "create-directory").map_err(|mut error| {
        error.body.mutation = Mutation::Committed;
        error
    })?;
    open_child_observed(parent, name, "create-directory", &observed).map_err(|mut error| {
        error.body.mutation = Mutation::Committed;
        error
    })
}

pub fn create_file(parent: &PlatformCap, name: &str) -> Result<PlatformCap, ProtocolError> {
    let name = cstring(OsStr::new(name), "create-file")?;
    // SAFETY: live directory fd, NUL-terminated basename, returned fd owned.
    let fd = unsafe {
        libc::openat(
            parent.file.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    file_from_fd(fd, CapKind::File, "create-file")
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

pub fn flush(cap: &PlatformCap, mode: &str) -> Result<(), ProtocolError> {
    // SAFETY: both calls operate on a live descriptor.
    let rc = unsafe {
        if mode == "data" && cap.kind == CapKind::File {
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

pub fn rename(
    from_parent: &PlatformCap,
    from: &str,
    to_parent: &PlatformCap,
    to: &str,
    no_replace: bool,
) -> Result<(), ProtocolError> {
    let from = cstring(OsStr::new(from), "rename")?;
    let to = cstring(OsStr::new(to), "rename")?;
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
    let filesystem = match filesystem_id {
        0x0000_0000_0000_ef53 => "ext",
        0x0000_0000_0102_1994 => "tmpfs",
        0x0000_0000_5846_5342 => "xfs",
        0x0000_0000_794c_7630 => "overlayfs",
        0x0000_0000_9123_683e => "btrfs",
        _ => {
            return Err(ProtocolError::unsupported(
                "probe",
                "unsupported-capability",
            ))
        }
    };
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
            no_follow: "openat(O_NOFOLLOW)".to_string(),
            atomic_rename: "renameat2".to_string(),
            no_replace: "renameat2(RENAME_NOREPLACE)".to_string(),
            file_flush: "fsync/fdatasync".to_string(),
            directory_flush: "fsync".to_string(),
        },
    })
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
    if filesystem != "apfs" {
        return Err(ProtocolError::unsupported(
            "probe",
            "unsupported-capability",
        ));
    }
    Ok(ProbeEvidence {
        platform: "darwin".to_string(),
        filesystem: filesystem.to_string(),
        filesystem_id: filesystem.to_string(),
        primitives: PrimitiveEvidence {
            identity: "dev+ino".to_string(),
            no_follow: "openat(O_NOFOLLOW)".to_string(),
            atomic_rename: "renameat".to_string(),
            no_replace: "renameatx_np(RENAME_EXCL)".to_string(),
            file_flush: "fsync/fdatasync".to_string(),
            directory_flush: "fsync".to_string(),
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
