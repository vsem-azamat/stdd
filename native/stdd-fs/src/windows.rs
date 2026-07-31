//! Windows protocol/backend seam.
//!
//! The protocol types compile on Windows, but this bounded slice deliberately
//! exposes no mutation primitives. Probe returns a structured unsupported
//! result until reparse-point rejection, protected DACL creation, stable
//! volume/file IDs, atomic rename, and directory durability are all complete.

use crate::protocol::{ProtocolError, IDENTITY_VERSION};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapKind {
    Directory,
    File,
}

#[derive(Debug)]
pub struct PlatformCap {
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

fn unavailable<T>(operation: &str) -> Result<T, ProtocolError> {
    Err(ProtocolError::unsupported(
        operation,
        "windows-backend-unavailable",
    ))
}

pub fn probe(_root: &PlatformCap) -> Result<ProbeEvidence, ProtocolError> {
    Err(ProtocolError::unsupported(
        "probe",
        "unsupported-capability",
    ))
}

pub fn open_root(_path: &Path) -> Result<PlatformCap, ProtocolError> {
    unavailable("open-root")
}

pub fn observation(_cap: &PlatformCap, operation: &str) -> Result<Observation, ProtocolError> {
    unavailable(operation)
}

pub fn identity(_cap: &PlatformCap, operation: &str) -> Result<Identity, ProtocolError> {
    unavailable(operation)
}

pub fn stat_at(
    _parent: &PlatformCap,
    _name: &str,
    operation: &str,
) -> Result<Observation, ProtocolError> {
    unavailable(operation)
}

pub fn open_child(
    _parent: &PlatformCap,
    _name: &str,
    operation: &str,
) -> Result<PlatformCap, ProtocolError> {
    unavailable(operation)
}

pub fn create_directory(_parent: &PlatformCap, _name: &str) -> Result<PlatformCap, ProtocolError> {
    unavailable("create-directory")
}

pub fn create_file(_parent: &PlatformCap, _name: &str) -> Result<PlatformCap, ProtocolError> {
    unavailable("create-file")
}

pub fn list(
    _parent: &PlatformCap,
    _cursor: Option<i64>,
    _limit: usize,
) -> Result<(Vec<Entry>, Option<i64>), ProtocolError> {
    unavailable("list")
}

pub fn read(_cap: &PlatformCap, _offset: u64, _length: usize) -> Result<Vec<u8>, ProtocolError> {
    unavailable("read")
}

pub fn write(_cap: &PlatformCap, _offset: u64, _bytes: &[u8]) -> Result<usize, ProtocolError> {
    unavailable("write")
}

pub fn truncate(_cap: &PlatformCap, _size: u64) -> Result<(), ProtocolError> {
    unavailable("truncate")
}

pub fn flush(_cap: &PlatformCap, _mode: &str) -> Result<(), ProtocolError> {
    unavailable("flush")
}

pub fn rename(
    _from_parent: &PlatformCap,
    _from: &str,
    _to_parent: &PlatformCap,
    _to: &str,
    _no_replace: bool,
) -> Result<(), ProtocolError> {
    unavailable("rename")
}

pub fn symlink(_parent: &PlatformCap, _name: &str, _target: &str) -> Result<(), ProtocolError> {
    unavailable("symlink")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_types_use_v2_win32_identity() {
        let identity = Identity {
            version: IDENTITY_VERSION,
            platform: "win32".to_string(),
            volume: "1".to_string(),
            file_id: "2".to_string(),
            kind: "file".to_string(),
        };
        assert_eq!(identity.version, 2);
        assert_eq!(identity.platform, "win32");
    }
}
