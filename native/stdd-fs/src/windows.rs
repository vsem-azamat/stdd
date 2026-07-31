//! Windows handle-relative filesystem boundary.
//!
//! All Windows FFI and every `unsafe` block in the crate are confined here.
//! Calls either use an owned handle, a bounded UTF-16/buffer allocation whose
//! lifetime spans the call, or an OS-allocated object released with LocalFree.

#![allow(unsafe_code)]

use crate::protocol::{Mutation, ProtocolError, IDENTITY_VERSION};
use crate::windows_model::{classify_win32, full_file_id, normalize_sddl};
use serde::Serialize;
use std::collections::VecDeque;
use std::ffi::{c_void, OsStr, OsString};
use std::io;
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Component, Path, Prefix};
use std::ptr::{null, null_mut};
use std::sync::Mutex;
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{
    NtCreateFile, FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
    FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
};
use windows_sys::Win32::Foundation::{
    GetLastError, LocalFree, RtlNtStatusToDosError, HANDLE, INVALID_HANDLE_VALUE, NTSTATUS,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
    ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1,
    SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    GetSecurityDescriptorControl, GetTokenInformation, TokenUser, ACL, DACL_SECURITY_INFORMATION,
    OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED, TOKEN_QUERY,
    TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FileBasicInfo, FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo,
    FileIdInfo, FileRenameInfo, FileRenameInfoEx, FileStandardInfo, FlushFileBuffers,
    GetFileInformationByHandleEx, GetVolumeInformationByHandleW, ReadFile, SetEndOfFile,
    SetFileInformationByHandle, SetFilePointerEx, WriteFile, DELETE, FILE_APPEND_DATA,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_BASIC_INFO,
    FILE_DELETE_CHILD, FILE_EXECUTE, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_ID_BOTH_DIR_INFO, FILE_ID_INFO, FILE_INFO_BY_HANDLE_CLASS, FILE_LIST_DIRECTORY,
    FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_READ_EA, FILE_RENAME_INFO, FILE_RENAME_INFO_0,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_STANDARD_INFO,
    FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA, OPEN_EXISTING, READ_CONTROL,
    SYNCHRONIZE,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

const SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
const ADMISSION_ACCESS: u32 = DELETE
    | READ_CONTROL
    | SYNCHRONIZE
    | FILE_LIST_DIRECTORY
    | FILE_READ_DATA
    | FILE_WRITE_DATA
    | FILE_APPEND_DATA
    | FILE_READ_EA
    | FILE_WRITE_EA
    | FILE_READ_ATTRIBUTES
    | FILE_WRITE_ATTRIBUTES
    | FILE_EXECUTE
    | FILE_DELETE_CHILD;
const TRAVERSE_ACCESS: u32 = READ_CONTROL
    | SYNCHRONIZE
    | FILE_READ_DATA
    | FILE_READ_EA
    | FILE_READ_ATTRIBUTES
    | FILE_EXECUTE;
const OBSERVE_ACCESS: u32 = READ_CONTROL | SYNCHRONIZE | FILE_READ_ATTRIBUTES;
const LIST_BUFFER_BYTES: usize = 64 * 1024;
const RENAME_REPLACE_IF_EXISTS: u32 = 0x1;
const RENAME_POSIX_SEMANTICS: u32 = 0x2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapKind {
    Directory,
    File,
}

#[derive(Debug)]
pub struct PlatformCap {
    handle: OwnedHandle,
    pub kind: CapKind,
    listing: Mutex<ListState>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct RawIdentity {
    volume: u64,
    file_id: [u8; 16],
    kind: String,
}

#[derive(Debug)]
struct SecuritySnapshot {
    owner_sid: String,
    sddl: String,
    protected: bool,
}

#[derive(Debug, Default)]
struct ListState {
    cursor: i64,
    initialized: bool,
    exhausted: bool,
    pending: VecDeque<String>,
}

struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: this pointer was returned by a LocalAlloc-family API.
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

struct PrivateDescriptor {
    allocation: LocalAllocation,
    owner_sid: String,
    normalized_sddl: String,
}

impl PrivateDescriptor {
    fn pointer(&self) -> PSECURITY_DESCRIPTOR {
        self.allocation.0
    }
}

fn handle(cap: &PlatformCap) -> HANDLE {
    cap.handle.as_raw_handle().cast()
}

fn committed(mut error: ProtocolError) -> ProtocolError {
    error.body.mutation = Mutation::Committed;
    error
}

fn win32_error(operation: &str, code: u32, mutation: Mutation) -> ProtocolError {
    let classified = classify_win32(code);
    ProtocolError::classified_io(
        operation,
        io::Error::from_raw_os_error(code as i32),
        classified.code,
        classified.class,
        mutation,
        classified.retryable,
    )
}

fn last_error(operation: &str, mutation: Mutation) -> ProtocolError {
    // SAFETY: GetLastError has no memory-safety preconditions.
    win32_error(operation, unsafe { GetLastError() }, mutation)
}

fn nt_error(operation: &str, status: NTSTATUS, mutation: Mutation) -> ProtocolError {
    // SAFETY: RtlNtStatusToDosError accepts any NTSTATUS value.
    let code = unsafe { RtlNtStatusToDosError(status) };
    win32_error(operation, code, mutation)
}

fn owned_handle(raw: HANDLE, operation: &str) -> Result<OwnedHandle, ProtocolError> {
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(last_error(operation, Mutation::None));
    }
    // SAFETY: a successful create/open call returned this newly owned handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw.cast()) })
}

fn wide_nul(value: &OsStr, operation: &str) -> Result<Vec<u16>, ProtocolError> {
    let mut wide: Vec<u16> = value.encode_wide().collect();
    if wide.contains(&0) {
        return Err(ProtocolError::invalid(operation, "invalid-nul"));
    }
    wide.push(0);
    Ok(wide)
}

fn query_handle<T: Default>(
    raw: HANDLE,
    class: FILE_INFO_BY_HANDLE_CLASS,
    operation: &str,
) -> Result<T, ProtocolError> {
    let mut value = T::default();
    // SAFETY: value is writable for exactly size_of::<T>(), and raw is live.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            raw,
            class,
            (&mut value as *mut T).cast(),
            size_of::<T>() as u32,
        )
    };
    if ok == 0 {
        return Err(last_error(operation, Mutation::None));
    }
    Ok(value)
}

fn raw_identity(raw: HANDLE, operation: &str) -> Result<RawIdentity, ProtocolError> {
    let id: FILE_ID_INFO = query_handle(raw, FileIdInfo, operation)?;
    let basic: FILE_BASIC_INFO = query_handle(raw, FileBasicInfo, operation)?;
    let standard: FILE_STANDARD_INFO = query_handle(raw, FileStandardInfo, operation)?;
    let kind = if basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        "symlink"
    } else if standard.Directory {
        "directory"
    } else {
        "file"
    };
    Ok(RawIdentity {
        volume: id.VolumeSerialNumber,
        file_id: id.FileId.Identifier,
        kind: kind.to_string(),
    })
}

fn protocol_identity(raw: &RawIdentity) -> Identity {
    Identity {
        version: IDENTITY_VERSION,
        platform: "win32".to_string(),
        volume: raw.volume.to_string(),
        file_id: full_file_id(&raw.file_id),
        kind: raw.kind.clone(),
    }
}

fn utf16_pointer_string(pointer: *const u16, length: usize) -> String {
    if pointer.is_null() || length == 0 {
        return String::new();
    }
    // SAFETY: callers pass an OS-allocated UTF-16 string and its reported
    // length. Some APIs include the trailing NUL in that length.
    let units = unsafe { std::slice::from_raw_parts(pointer, length) };
    let end = units.iter().position(|unit| *unit == 0).unwrap_or(length);
    String::from_utf16_lossy(&units[..end])
}

fn sid_string(sid: PSID, operation: &str) -> Result<String, ProtocolError> {
    let mut pointer = null_mut();
    // SAFETY: sid is owned by a live token/security descriptor for this call;
    // the API allocates pointer with LocalAlloc.
    if unsafe { ConvertSidToStringSidW(sid, &mut pointer) } == 0 {
        return Err(last_error(operation, Mutation::None));
    }
    let allocation = LocalAllocation(pointer.cast());
    let mut length = 0;
    // SAFETY: ConvertSidToStringSidW returned a NUL-terminated UTF-16 string.
    while unsafe { *pointer.add(length) } != 0 {
        length += 1;
    }
    let value = utf16_pointer_string(pointer, length);
    drop(allocation);
    Ok(value)
}

fn descriptor_sddl(
    descriptor: PSECURITY_DESCRIPTOR,
    operation: &str,
) -> Result<String, ProtocolError> {
    let mut pointer = null_mut();
    let mut length = 0;
    // SAFETY: descriptor is live; the API returns a LocalAlloc string.
    if unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            SDDL_REVISION_1,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut pointer,
            &mut length,
        )
    } == 0
    {
        return Err(last_error(operation, Mutation::None));
    }
    let allocation = LocalAllocation(pointer.cast());
    let value = utf16_pointer_string(pointer, length as usize);
    drop(allocation);
    Ok(normalize_sddl(&value))
}

fn security_snapshot(raw: HANDLE, operation: &str) -> Result<SecuritySnapshot, ProtocolError> {
    let mut owner: PSID = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: all output pointers are writable. The returned descriptor owns
    // the owner/DACL storage and remains live until the snapshot is copied.
    let result = unsafe {
        GetSecurityInfo(
            raw,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if result != 0 {
        return Err(win32_error(operation, result, Mutation::None));
    }
    let allocation = LocalAllocation(descriptor);
    let owner_sid = sid_string(owner, operation)?;
    let sddl = descriptor_sddl(descriptor, operation)?;
    let mut control = 0_u16;
    let mut revision = 0_u32;
    // SAFETY: descriptor remains live and the scalar outputs are writable.
    if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
        return Err(last_error(operation, Mutation::None));
    }
    drop(allocation);
    Ok(SecuritySnapshot {
        owner_sid,
        sddl,
        protected: control & SE_DACL_PROTECTED != 0,
    })
}

fn current_sid(operation: &str) -> Result<String, ProtocolError> {
    let mut token = null_mut();
    // SAFETY: both handles/output are valid; token is wrapped immediately.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(last_error(operation, Mutation::None));
    }
    let token = owned_handle(token, operation)?;
    let mut bytes = 0_u32;
    // SAFETY: the null-buffer call obtains the exact required byte count.
    unsafe {
        GetTokenInformation(
            token.as_raw_handle().cast(),
            TokenUser,
            null_mut(),
            0,
            &mut bytes,
        )
    };
    if bytes < size_of::<TOKEN_USER>() as u32 {
        return Err(last_error(operation, Mutation::None));
    }
    let words = (bytes as usize).div_ceil(size_of::<usize>());
    let mut buffer = vec![0_usize; words];
    // SAFETY: the word buffer is aligned and writable for the reported bytes.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle().cast(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            bytes,
            &mut bytes,
        )
    } == 0
    {
        return Err(last_error(operation, Mutation::None));
    }
    // SAFETY: successful TokenUser output begins with TOKEN_USER.
    let user = unsafe { &*(buffer.as_ptr().cast::<TOKEN_USER>()) };
    sid_string(user.User.Sid, operation)
}

fn private_descriptor(operation: &str) -> Result<PrivateDescriptor, ProtocolError> {
    let owner_sid = current_sid(operation)
        .map_err(|_| ProtocolError::unsupported(operation, "private-dacl-unavailable"))?;
    let sddl = format!("O:{owner_sid}D:P(A;;FA;;;{owner_sid})(A;;FA;;;SY)(A;;FA;;;BA)");
    let wide = wide_nul(OsStr::new(&sddl), operation)?;
    let mut descriptor = null_mut();
    // SAFETY: wide is NUL-terminated and descriptor is a writable output.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(ProtocolError::unsupported(
            operation,
            "private-dacl-unavailable",
        ));
    }
    let allocation = LocalAllocation(descriptor);
    let normalized_sddl = descriptor_sddl(descriptor, operation)
        .map_err(|_| ProtocolError::unsupported(operation, "private-dacl-unavailable"))?;
    Ok(PrivateDescriptor {
        allocation,
        owner_sid,
        normalized_sddl,
    })
}

fn observation_for(raw: HANDLE, operation: &str) -> Result<Observation, ProtocolError> {
    let identity = raw_identity(raw, operation)?;
    let basic: FILE_BASIC_INFO = query_handle(raw, FileBasicInfo, operation)?;
    let standard: FILE_STANDARD_INFO = query_handle(raw, FileStandardInfo, operation)?;
    if standard.EndOfFile < 0 {
        return Err(ProtocolError::unsupported(
            operation,
            "unsupported-capability",
        ));
    }
    let security = security_snapshot(raw, operation)?;
    Ok(Observation {
        identity: protocol_identity(&identity),
        owner: security.owner_sid,
        permissions: security.sddl,
        link_count: standard.NumberOfLinks.to_string(),
        size: (standard.EndOfFile as u64).to_string(),
        modified_ns: (i128::from(basic.LastWriteTime) * 100).to_string(),
        changed_ns: (i128::from(basic.ChangeTime) * 100).to_string(),
    })
}

fn admit(handle: OwnedHandle, operation: &str) -> Result<PlatformCap, ProtocolError> {
    let raw = raw_identity(handle.as_raw_handle().cast(), operation)?;
    if raw.kind == "symlink" {
        return Err(ProtocolError::new(
            operation,
            "symlink-rejected",
            "confinement",
            Mutation::None,
        ));
    }
    let kind = match raw.kind.as_str() {
        "directory" => CapKind::Directory,
        "file" => CapKind::File,
        _ => {
            return Err(ProtocolError::unsupported(
                operation,
                "unsupported-file-type",
            ))
        }
    };
    Ok(PlatformCap {
        handle,
        kind,
        listing: Mutex::new(ListState::default()),
    })
}

#[allow(clippy::too_many_arguments)]
fn nt_open(
    parent: HANDLE,
    name: &OsStr,
    kind: Option<CapKind>,
    disposition: u32,
    attributes: u32,
    desired_access: u32,
    security: Option<PSECURITY_DESCRIPTOR>,
    operation: &str,
) -> Result<OwnedHandle, ProtocolError> {
    let mut wide: Vec<u16> = name.encode_wide().collect();
    if wide.is_empty() || wide.contains(&0) || wide.len() > (u16::MAX as usize / 2) {
        return Err(ProtocolError::invalid(operation, "invalid-basename"));
    }
    let unicode = windows_sys::Win32::Foundation::UNICODE_STRING {
        Length: (wide.len() * 2) as u16,
        MaximumLength: (wide.len() * 2) as u16,
        Buffer: wide.as_mut_ptr(),
    };
    let object = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent,
        ObjectName: &unicode,
        Attributes: windows_sys::Win32::Foundation::OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: security
            .unwrap_or(null_mut())
            .cast::<windows_sys::Win32::Security::SECURITY_DESCRIPTOR>(),
        SecurityQualityOfService: null(),
    };
    let mut output = null_mut();
    let mut status_block = IO_STATUS_BLOCK::default();
    let options = FILE_OPEN_REPARSE_POINT
        | FILE_SYNCHRONOUS_IO_NONALERT
        | match kind {
            Some(CapKind::Directory) => FILE_DIRECTORY_FILE,
            Some(CapKind::File) => FILE_NON_DIRECTORY_FILE,
            None => 0,
        };
    // SAFETY: all structures and UTF-16 storage remain live for the call;
    // output receives one owned handle on success.
    let status = unsafe {
        NtCreateFile(
            &mut output,
            desired_access,
            &object,
            &mut status_block,
            null(),
            attributes,
            SHARE_ALL,
            disposition,
            options,
            null(),
            0,
        )
    };
    if status < 0 {
        return Err(nt_error(operation, status, Mutation::None));
    }
    owned_handle(output, operation)
}

fn open_base(
    root: &OsStr,
    desired_access: u32,
    operation: &str,
) -> Result<OwnedHandle, ProtocolError> {
    let wide = wide_nul(root, operation)?;
    // SAFETY: wide is NUL-terminated; no security/template pointers are used.
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            desired_access,
            SHARE_ALL,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    owned_handle(raw, operation)
}

fn split_absolute(path: &Path) -> Result<(OsString, Vec<OsString>), ProtocolError> {
    let mut components = path.components();
    let prefix = match components.next() {
        Some(Component::Prefix(prefix)) => prefix.kind(),
        _ => {
            return Err(ProtocolError::invalid(
                "open-root",
                "absolute-path-required",
            ))
        }
    };
    if components.next() != Some(Component::RootDir) {
        return Err(ProtocolError::invalid(
            "open-root",
            "absolute-path-required",
        ));
    }
    let base = match prefix {
        Prefix::Disk(drive) => OsString::from(format!("{}:\\", drive as char)),
        Prefix::VerbatimDisk(drive) => OsString::from(format!(r"\\?\{}:\", drive as char)),
        Prefix::UNC(server, share) => {
            let mut value = OsString::from(r"\\");
            value.push(server);
            value.push("\\");
            value.push(share);
            value.push("\\");
            value
        }
        Prefix::VerbatimUNC(server, share) => {
            let mut value = OsString::from(r"\\?\UNC\");
            value.push(server);
            value.push("\\");
            value.push(share);
            value.push("\\");
            value
        }
        _ => {
            return Err(ProtocolError::unsupported(
                "open-root",
                "unsupported-path-prefix",
            ))
        }
    };
    let mut names = Vec::new();
    for component in components {
        match component {
            Component::Normal(name) => names.push(name.to_os_string()),
            _ => {
                return Err(ProtocolError::invalid(
                    "open-root",
                    "non-normal-path-component",
                ))
            }
        }
    }
    Ok((base, names))
}

pub fn open_root(path: &Path) -> Result<PlatformCap, ProtocolError> {
    let (base, components) = split_absolute(path)?;
    let base_access = if components.is_empty() {
        ADMISSION_ACCESS
    } else {
        TRAVERSE_ACCESS
    };
    let mut current = admit(open_base(&base, base_access, "open-root")?, "open-root")?;
    if current.kind != CapKind::Directory {
        return Err(ProtocolError::new(
            "open-root",
            "not-directory",
            "confinement",
            Mutation::None,
        ));
    }
    let last_index = components.len().saturating_sub(1);
    for (index, component) in components.into_iter().enumerate() {
        let next = nt_open(
            handle(&current),
            &component,
            Some(CapKind::Directory),
            FILE_OPEN,
            FILE_ATTRIBUTE_NORMAL,
            if index == last_index {
                ADMISSION_ACCESS
            } else {
                TRAVERSE_ACCESS
            },
            None,
            "open-root",
        )?;
        current = admit(next, "open-root")?;
        if current.kind != CapKind::Directory {
            return Err(ProtocolError::new(
                "open-root",
                "not-directory",
                "confinement",
                Mutation::None,
            ));
        }
    }
    Ok(current)
}

pub fn observation(cap: &PlatformCap, operation: &str) -> Result<Observation, ProtocolError> {
    observation_for(handle(cap), operation)
}

pub fn identity(cap: &PlatformCap, operation: &str) -> Result<Identity, ProtocolError> {
    Ok(protocol_identity(&raw_identity(handle(cap), operation)?))
}

fn open_relative_observe(
    parent: &PlatformCap,
    name: &str,
    operation: &str,
) -> Result<OwnedHandle, ProtocolError> {
    nt_open(
        handle(parent),
        OsStr::new(name),
        None,
        FILE_OPEN,
        FILE_ATTRIBUTE_NORMAL,
        OBSERVE_ACCESS,
        None,
        operation,
    )
}

pub fn stat_at(
    parent: &PlatformCap,
    name: &str,
    operation: &str,
) -> Result<Observation, ProtocolError> {
    let child = open_relative_observe(parent, name, operation)?;
    observation_for(child.as_raw_handle().cast(), operation)
}

pub fn open_child(
    parent: &PlatformCap,
    name: &str,
    operation: &str,
) -> Result<PlatformCap, ProtocolError> {
    let child = nt_open(
        handle(parent),
        OsStr::new(name),
        None,
        FILE_OPEN,
        FILE_ATTRIBUTE_NORMAL,
        ADMISSION_ACCESS,
        None,
        operation,
    )?;
    admit(child, operation)
}

fn verify_private(
    raw: HANDLE,
    descriptor: &PrivateDescriptor,
    operation: &str,
) -> Result<RawIdentity, ProtocolError> {
    let identity = raw_identity(raw, operation)?;
    if identity.kind == "symlink" {
        return Err(ProtocolError::new(
            operation,
            "symlink-rejected",
            "confinement",
            Mutation::Committed,
        ));
    }
    let security = security_snapshot(raw, operation).map_err(committed)?;
    if !security.protected
        || security.owner_sid != descriptor.owner_sid
        || security.sddl != descriptor.normalized_sddl
    {
        return Err(ProtocolError::new(
            operation,
            "private-dacl-verification-failed",
            "unsupported",
            Mutation::Committed,
        ));
    }
    Ok(identity)
}

fn create_private(
    parent: &PlatformCap,
    name: &str,
    kind: CapKind,
    operation: &str,
) -> Result<PlatformCap, ProtocolError> {
    let descriptor = private_descriptor(operation)?;
    let created = nt_open(
        handle(parent),
        OsStr::new(name),
        Some(kind),
        FILE_CREATE,
        if kind == CapKind::Directory {
            FILE_ATTRIBUTE_DIRECTORY
        } else {
            FILE_ATTRIBUTE_NORMAL
        },
        ADMISSION_ACCESS,
        Some(descriptor.pointer()),
        operation,
    )?;
    let created_identity = verify_private(created.as_raw_handle().cast(), &descriptor, operation)
        .map_err(committed)?;
    drop(created);
    let reopened = nt_open(
        handle(parent),
        OsStr::new(name),
        Some(kind),
        FILE_OPEN,
        FILE_ATTRIBUTE_NORMAL,
        ADMISSION_ACCESS,
        None,
        operation,
    )
    .map_err(committed)?;
    let reopened_identity = verify_private(reopened.as_raw_handle().cast(), &descriptor, operation)
        .map_err(committed)?;
    if created_identity != reopened_identity {
        return Err(ProtocolError::conflict(
            operation,
            "identity-conflict",
            Mutation::Committed,
        ));
    }
    let cap = admit(reopened, operation).map_err(committed)?;
    if cap.kind != kind {
        return Err(ProtocolError::conflict(
            operation,
            "identity-conflict",
            Mutation::Committed,
        ));
    }
    Ok(cap)
}

pub fn create_directory(
    parent: &PlatformCap,
    name: &str,
    _mode: u32,
) -> Result<PlatformCap, ProtocolError> {
    create_private(parent, name, CapKind::Directory, "create-directory")
}

pub fn create_file(
    parent: &PlatformCap,
    name: &str,
    _mode: u32,
) -> Result<PlatformCap, ProtocolError> {
    create_private(parent, name, CapKind::File, "create-file")
}

fn directory_batch(
    parent: &PlatformCap,
    restart: bool,
) -> Result<Option<VecDeque<String>>, ProtocolError> {
    let words = LIST_BUFFER_BYTES.div_ceil(size_of::<usize>());
    let mut buffer = vec![0_usize; words];
    let class = if restart {
        FileIdBothDirectoryRestartInfo
    } else {
        FileIdBothDirectoryInfo
    };
    // SAFETY: the aligned word buffer is writable for LIST_BUFFER_BYTES.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle(parent),
            class,
            buffer.as_mut_ptr().cast(),
            LIST_BUFFER_BYTES as u32,
        )
    };
    if ok == 0 {
        // SAFETY: GetLastError immediately follows the failed call.
        let code = unsafe { GetLastError() };
        if code == 18 {
            return Ok(None);
        }
        return Err(win32_error("list", code, Mutation::None));
    }
    // SAFETY: buffer remains live and contains at least LIST_BUFFER_BYTES.
    let bytes =
        unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), LIST_BUFFER_BYTES) };
    let mut names = VecDeque::new();
    let mut offset = 0_usize;
    loop {
        if offset + size_of::<FILE_ID_BOTH_DIR_INFO>() > bytes.len() {
            return Err(ProtocolError::new(
                "list",
                "invalid-directory-buffer",
                "io",
                Mutation::None,
            ));
        }
        // SAFETY: bounds were checked; read_unaligned copies the fixed header
        // from the variable-length directory buffer.
        let info = unsafe {
            std::ptr::read_unaligned(bytes.as_ptr().add(offset).cast::<FILE_ID_BOTH_DIR_INFO>())
        };
        let name_offset = offset + offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
        let name_bytes = info.FileNameLength as usize;
        if name_bytes & 1 != 0 || name_offset + name_bytes > bytes.len() {
            return Err(ProtocolError::new(
                "list",
                "invalid-directory-buffer",
                "io",
                Mutation::None,
            ));
        }
        // SAFETY: the byte bounds are checked; read_unaligned avoids any
        // alignment assumption for UTF-16 units in the OS buffer.
        let mut wide = Vec::with_capacity(name_bytes / 2);
        for index in 0..(name_bytes / 2) {
            wide.push(unsafe {
                std::ptr::read_unaligned(bytes.as_ptr().add(name_offset + index * 2).cast::<u16>())
            });
        }
        let name = String::from_utf16(&wide)
            .map_err(|_| ProtocolError::unsupported("list", "non-utf16-name"))?;
        if name != "." && name != ".." {
            names.push_back(name);
        }
        if info.NextEntryOffset == 0 {
            break;
        }
        let next = offset
            .checked_add(info.NextEntryOffset as usize)
            .filter(|next| *next > offset && *next < bytes.len())
            .ok_or_else(|| {
                ProtocolError::new("list", "invalid-directory-buffer", "io", Mutation::None)
            })?;
        offset = next;
    }
    Ok(Some(names))
}

fn refill_listing(
    parent: &PlatformCap,
    state: &mut ListState,
    restart: &mut bool,
) -> Result<(), ProtocolError> {
    while state.pending.is_empty() && !state.exhausted {
        match directory_batch(parent, *restart)? {
            Some(names) => state.pending = names,
            None => state.exhausted = true,
        }
        state.initialized = true;
        *restart = false;
    }
    Ok(())
}

pub fn list(
    parent: &PlatformCap,
    cursor: Option<i64>,
    limit: usize,
) -> Result<(Vec<Entry>, Option<i64>), ProtocolError> {
    let mut state = parent
        .listing
        .lock()
        .map_err(|_| ProtocolError::new("list", "listing-state-poisoned", "io", Mutation::None))?;
    let mut restart = false;
    match cursor {
        None => {
            *state = ListState::default();
            restart = true;
        }
        Some(cursor) if state.initialized && cursor == state.cursor => {}
        Some(_) => return Err(ProtocolError::invalid("list", "invalid-cursor")),
    }
    let mut entries = Vec::new();
    while entries.len() < limit {
        refill_listing(parent, &mut state, &mut restart)?;
        let Some(name) = state.pending.front() else {
            break;
        };
        let observation = stat_at(parent, name, "list")?;
        entries.push(Entry {
            observation,
            name: name.clone(),
        });
        state.pending.pop_front();
        state.cursor += 1;
    }
    refill_listing(parent, &mut state, &mut restart)?;
    let next = (!state.pending.is_empty()).then_some(state.cursor);
    Ok((entries, next))
}

fn seek(raw: HANDLE, offset: u64, operation: &str) -> Result<(), ProtocolError> {
    let mut position = 0_i64;
    // SAFETY: raw is live and the output scalar is writable.
    if unsafe { SetFilePointerEx(raw, offset as i64, &mut position, 0) } == 0 {
        return Err(last_error(operation, Mutation::None));
    }
    if position != offset as i64 {
        return Err(ProtocolError::new(
            operation,
            "invalid-offset",
            "io",
            Mutation::None,
        ));
    }
    Ok(())
}

pub fn read(cap: &PlatformCap, offset: u64, length: usize) -> Result<Vec<u8>, ProtocolError> {
    seek(handle(cap), offset, "read")?;
    let mut bytes = vec![0_u8; length];
    let mut count = 0_u32;
    // SAFETY: the buffer is writable for length bytes and the handle is live.
    if unsafe {
        ReadFile(
            handle(cap),
            bytes.as_mut_ptr(),
            length as u32,
            &mut count,
            null_mut(),
        )
    } == 0
    {
        return Err(last_error("read", Mutation::None));
    }
    bytes.truncate(count as usize);
    Ok(bytes)
}

pub fn write(cap: &PlatformCap, offset: u64, bytes: &[u8]) -> Result<usize, ProtocolError> {
    seek(handle(cap), offset, "write")?;
    let mut count = 0_u32;
    // SAFETY: bytes is readable for its bounded length and the handle is live.
    if unsafe {
        WriteFile(
            handle(cap),
            bytes.as_ptr(),
            bytes.len() as u32,
            &mut count,
            null_mut(),
        )
    } == 0
    {
        return Err(last_error("write", Mutation::Possible));
    }
    Ok(count as usize)
}

pub fn truncate(cap: &PlatformCap, size: u64) -> Result<(), ProtocolError> {
    seek(handle(cap), size, "truncate")?;
    // SAFETY: SetEndOfFile operates on the live writable file handle.
    if unsafe { SetEndOfFile(handle(cap)) } == 0 {
        return Err(last_error("truncate", Mutation::Possible));
    }
    Ok(())
}

pub fn flush(cap: &PlatformCap, _mode: &str) -> Result<(), ProtocolError> {
    // SAFETY: FlushFileBuffers accepts file and directory handles opened with
    // the required rights; probe checks directory support before mutation.
    if unsafe { FlushFileBuffers(handle(cap)) } == 0 {
        return Err(last_error("flush", Mutation::Possible));
    }
    Ok(())
}

fn rename_buffer(
    root: HANDLE,
    name: &str,
    replace: bool,
    extended: bool,
) -> Result<Vec<usize>, ProtocolError> {
    let wide: Vec<u16> = OsStr::new(name).encode_wide().collect();
    let bytes = wide.len() * 2;
    let total = offset_of!(FILE_RENAME_INFO, FileName)
        .checked_add(bytes)
        .ok_or_else(|| ProtocolError::invalid("rename", "invalid-basename"))?;
    let mut storage = vec![0_usize; total.div_ceil(size_of::<usize>())];
    let pointer = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // SAFETY: storage is aligned and large enough for header plus UTF-16 name.
    unsafe {
        (*pointer).Anonymous = if extended {
            FILE_RENAME_INFO_0 {
                Flags: RENAME_POSIX_SEMANTICS | if replace { RENAME_REPLACE_IF_EXISTS } else { 0 },
            }
        } else {
            FILE_RENAME_INFO_0 {
                ReplaceIfExists: replace,
            }
        };
        (*pointer).RootDirectory = root;
        (*pointer).FileNameLength = bytes as u32;
        std::ptr::copy_nonoverlapping(
            wide.as_ptr().cast::<u8>(),
            (pointer.cast::<u8>()).add(offset_of!(FILE_RENAME_INFO, FileName)),
            bytes,
        );
    }
    Ok(storage)
}

fn set_rename(
    source: HANDLE,
    target_parent: HANDLE,
    target: &str,
    replace: bool,
) -> Result<(), ProtocolError> {
    let extended = rename_buffer(target_parent, target, replace, true)?;
    // SAFETY: the aligned buffer contains FILE_RENAME_INFO plus the complete
    // relative UTF-16 basename; source and target-parent handles are live.
    if unsafe {
        SetFileInformationByHandle(
            source,
            FileRenameInfoEx,
            extended.as_ptr().cast(),
            (extended.len() * size_of::<usize>()) as u32,
        )
    } != 0
    {
        return Ok(());
    }
    // SAFETY: GetLastError immediately follows the failed call.
    let extended_error = unsafe { GetLastError() };
    if !matches!(extended_error, 1 | 50 | 87 | 120) {
        return Err(win32_error("rename", extended_error, Mutation::None));
    }
    let legacy = rename_buffer(target_parent, target, replace, false)?;
    // SAFETY: same buffer/handle invariants as the extended attempt.
    if unsafe {
        SetFileInformationByHandle(
            source,
            FileRenameInfo,
            legacy.as_ptr().cast(),
            (legacy.len() * size_of::<usize>()) as u32,
        )
    } == 0
    {
        return Err(last_error("rename", Mutation::None));
    }
    Ok(())
}

pub fn rename(
    from_parent: &PlatformCap,
    from: &str,
    expected: &Identity,
    to_parent: &PlatformCap,
    to: &str,
    no_replace: bool,
) -> Result<(), ProtocolError> {
    let source = open_child(from_parent, from, "rename")?;
    if identity(&source, "rename")? != *expected {
        return Err(ProtocolError::conflict(
            "rename",
            "identity-conflict",
            Mutation::None,
        ));
    }
    set_rename(handle(&source), handle(to_parent), to, !no_replace)
}

pub fn symlink(_parent: &PlatformCap, _name: &str, _target: &str) -> Result<(), ProtocolError> {
    Err(ProtocolError::unsupported(
        "symlink",
        "unsupported-capability",
    ))
}

pub fn probe(root: &PlatformCap) -> Result<ProbeEvidence, ProtocolError> {
    let raw = raw_identity(handle(root), "probe")?;
    let _security_api_evidence = security_snapshot(handle(root), "probe")?;
    let mut filesystem = vec![0_u16; 64];
    let mut serial = 0_u32;
    // SAFETY: root is live and all scalar/UTF-16 output buffers are writable.
    if unsafe {
        GetVolumeInformationByHandleW(
            handle(root),
            null_mut(),
            0,
            &mut serial,
            null_mut(),
            null_mut(),
            filesystem.as_mut_ptr(),
            filesystem.len() as u32,
        )
    } == 0
    {
        return Err(last_error("probe", Mutation::None));
    }
    let length = filesystem
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(filesystem.len());
    let filesystem = String::from_utf16(&filesystem[..length])
        .map_err(|_| ProtocolError::unsupported("probe", "unsupported-capability"))?;
    if !matches!(filesystem.as_str(), "NTFS" | "ReFS") {
        return Err(ProtocolError::unsupported(
            "probe",
            "unsupported-capability",
        ));
    }
    // SAFETY: a successful directory flush proves the volume/handle supports
    // the namespace durability primitive before any policy-visible mutation.
    if unsafe { FlushFileBuffers(handle(root)) } == 0 {
        return Err(last_error("probe", Mutation::None));
    }
    Ok(ProbeEvidence {
        platform: "win32".to_string(),
        filesystem,
        filesystem_id: format!("{}:{serial}", raw.volume),
        primitives: PrimitiveEvidence {
            identity: "volume-serial+FILE_ID_128".to_string(),
            no_follow: "NtCreateFile(RootDirectory,FILE_OPEN_REPARSE_POINT)".to_string(),
            atomic_rename: "SetFileInformationByHandle(FileRenameInfoEx/FileRenameInfo)"
                .to_string(),
            no_replace: "FILE_RENAME_INFO without replace".to_string(),
            file_flush: "FlushFileBuffers".to_string(),
            directory_flush: "FlushFileBuffers".to_string(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admission_rights_and_share_mode_cover_mutation_and_race_safety() {
        assert_ne!(ADMISSION_ACCESS & DELETE, 0);
        assert_ne!(ADMISSION_ACCESS & FILE_READ_DATA, 0);
        assert_ne!(ADMISSION_ACCESS & FILE_WRITE_DATA, 0);
        assert_ne!(ADMISSION_ACCESS & FILE_READ_ATTRIBUTES, 0);
        assert_ne!(ADMISSION_ACCESS & FILE_WRITE_ATTRIBUTES, 0);
        assert_eq!(
            SHARE_ALL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
        );
    }

    #[test]
    fn identity_projection_preserves_full_id_for_internal_comparison() {
        let raw = RawIdentity {
            volume: u64::MAX,
            file_id: [0xa5; 16],
            kind: "file".to_string(),
        };
        let projected = protocol_identity(&raw);
        assert_eq!(projected.version, 2);
        assert_eq!(projected.platform, "win32");
        assert_eq!(projected.volume, u64::MAX.to_string());
        assert_eq!(projected.file_id, "a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5");
        assert_eq!(raw.file_id.len(), 16);
    }

    #[test]
    fn rename_layout_keeps_relative_name_after_fixed_header() {
        assert!(offset_of!(FILE_RENAME_INFO, FileName) >= size_of::<HANDLE>() + size_of::<u32>());
        assert_eq!(RENAME_REPLACE_IF_EXISTS, 1);
        assert_eq!(RENAME_POSIX_SEMANTICS, 2);
    }
}
