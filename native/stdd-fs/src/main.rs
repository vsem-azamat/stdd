#![deny(unsafe_code)]

mod protocol;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(any(windows, test))]
mod windows_model;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use protocol::{
    basename, exact_fields, failure, field_mode, field_string, field_u64, parse_request,
    require_null, success, Mutation, ProtocolError, Request, IDENTITY_VERSION, MAX_CHUNK_BYTES,
    MAX_LINE_BYTES, MAX_LINK_TARGET_BYTES, MAX_LIST_ENTRIES,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::path::Path;
#[cfg(unix)]
use unix::{CapKind, Identity, PlatformCap};
#[cfg(windows)]
use windows as unix;
#[cfg(windows)]
use windows::{CapKind, Identity, PlatformCap};

struct Session {
    caps: HashMap<String, PlatformCap>,
    probed_volumes: HashSet<String>,
    next_cap: u64,
}

impl Session {
    fn new() -> Self {
        Self {
            caps: HashMap::new(),
            probed_volumes: HashSet::new(),
            next_cap: 1,
        }
    }

    fn insert(&mut self, cap: PlatformCap, operation: &str) -> Result<Value, ProtocolError> {
        let observation = unix::observation(&cap, operation)?;
        let id = format!("c{}", self.next_cap);
        self.next_cap += 1;
        self.caps.insert(id.clone(), cap);
        Ok(json!({"cap": id, "observation": observation}))
    }

    fn cap(&self, id: &str, operation: &str) -> Result<&PlatformCap, ProtocolError> {
        self.caps
            .get(id)
            .ok_or_else(|| ProtocolError::invalid(operation, "unknown-capability"))
    }

    fn directory(&self, id: &str, operation: &str) -> Result<&PlatformCap, ProtocolError> {
        let cap = self.cap(id, operation)?;
        if cap.kind != CapKind::Directory {
            return Err(ProtocolError::invalid(
                operation,
                "not-directory-capability",
            ));
        }
        Ok(cap)
    }

    fn file(&self, id: &str, operation: &str) -> Result<&PlatformCap, ProtocolError> {
        let cap = self.cap(id, operation)?;
        if cap.kind != CapKind::File {
            return Err(ProtocolError::invalid(operation, "not-file-capability"));
        }
        Ok(cap)
    }

    fn require_probed(&self, cap: &PlatformCap, operation: &str) -> Result<(), ProtocolError> {
        let volume = unix::identity(cap, operation)?.volume;
        if !self.probed_volumes.contains(&volume) {
            return Err(ProtocolError::unsupported(operation, "probe-required"));
        }
        Ok(())
    }

    fn handle(&mut self, request: &Request) -> Result<Value, ProtocolError> {
        match request.op.as_str() {
            "hello" => {
                exact_fields(&request.fields, &[], "hello")?;
                Ok(json!({
                    "protocol": 1,
                    "helper": "stdd-fs",
                    "maxLineBytes": MAX_LINE_BYTES,
                    "maxChunkBytes": MAX_CHUNK_BYTES
                }))
            }
            "probe" => {
                exact_fields(&request.fields, &["root"], "probe")?;
                let root = field_string(&request.fields, "root", "probe")?;
                let held = self.directory(&root, "probe")?;
                let evidence = unix::probe(held)?;
                let volume = unix::identity(held, "probe")?.volume;
                self.probed_volumes.insert(volume);
                Ok(json!(evidence))
            }
            "preflight-symlink" => {
                exact_fields(&request.fields, &["root"], "preflight-symlink")?;
                let root = field_string(&request.fields, "root", "preflight-symlink")?;
                let held = self.directory(&root, "preflight-symlink")?;
                self.require_probed(held, "preflight-symlink")?;
                unix::preflight_symlink()?;
                Ok(json!({}))
            }
            "verify-private" => {
                exact_fields(&request.fields, &["cap"], "verify-private")?;
                let cap = field_string(&request.fields, "cap", "verify-private")?;
                let held = self.cap(&cap, "verify-private")?;
                self.require_probed(held, "verify-private")?;
                unix::verify_cap_private(held)?;
                Ok(json!({}))
            }
            "open-root" => {
                exact_fields(&request.fields, &["path"], "open-root")?;
                let path = field_string(&request.fields, "path", "open-root")?;
                if !Path::new(&path).is_absolute() {
                    return Err(ProtocolError::invalid(
                        "open-root",
                        "absolute-path-required",
                    ));
                }
                self.insert(unix::open_root(Path::new(&path))?, "open-root")
            }
            "open-child" => {
                exact_fields(&request.fields, &["parent", "name"], "open-child")?;
                let parent = field_string(&request.fields, "parent", "open-child")?;
                let name = field_string(&request.fields, "name", "open-child")?;
                basename(&name, "open-child")?;
                let cap =
                    unix::open_child(self.directory(&parent, "open-child")?, &name, "open-child")?;
                self.insert(cap, "open-child")
            }
            "create-directory" => {
                exact_fields(
                    &request.fields,
                    &["parent", "name", "mode", "expected"],
                    "create-directory",
                )?;
                require_null(&request.fields, "expected", "create-directory")?;
                let mode =
                    field_mode(&request.fields, "mode", &[0o700, 0o755], "create-directory")?;
                let parent = field_string(&request.fields, "parent", "create-directory")?;
                let name = field_string(&request.fields, "name", "create-directory")?;
                basename(&name, "create-directory")?;
                let held = self.directory(&parent, "create-directory")?;
                self.require_probed(held, "create-directory")?;
                let cap = unix::create_directory(held, &name, mode)?;
                self.insert(cap, "create-directory").map_err(|mut error| {
                    error.body.mutation = Mutation::Committed;
                    error
                })
            }
            "create-file" => {
                exact_fields(
                    &request.fields,
                    &["parent", "name", "mode", "expected"],
                    "create-file",
                )?;
                require_null(&request.fields, "expected", "create-file")?;
                let mode = field_mode(
                    &request.fields,
                    "mode",
                    &[0o600, 0o644, 0o755],
                    "create-file",
                )?;
                let parent = field_string(&request.fields, "parent", "create-file")?;
                let name = field_string(&request.fields, "name", "create-file")?;
                basename(&name, "create-file")?;
                let held = self.directory(&parent, "create-file")?;
                self.require_probed(held, "create-file")?;
                let cap = unix::create_file(held, &name, mode)?;
                self.insert(cap, "create-file").map_err(|mut error| {
                    error.body.mutation = Mutation::Committed;
                    error
                })
            }
            "stat" => self.stat(request),
            "list" => self.list(request),
            "read" => {
                exact_fields(&request.fields, &["cap", "offset", "length"], "read")?;
                let cap = field_string(&request.fields, "cap", "read")?;
                let offset = field_u64(&request.fields, "offset", "read")?;
                let length = field_u64(&request.fields, "length", "read")?;
                if length > MAX_CHUNK_BYTES as u64 {
                    return Err(ProtocolError::invalid("read", "chunk-too-large"));
                }
                if offset > i64::MAX as u64 || offset.saturating_add(length) > i64::MAX as u64 {
                    return Err(ProtocolError::invalid("read", "invalid-offset"));
                }
                let bytes = unix::read(self.file(&cap, "read")?, offset, length as usize)?;
                Ok(json!({"data": BASE64.encode(&bytes), "eof": bytes.len() < length as usize}))
            }
            "read-link" => {
                exact_fields(
                    &request.fields,
                    &["parent", "name", "expected"],
                    "read-link",
                )?;
                let parent = field_string(&request.fields, "parent", "read-link")?;
                let name = field_string(&request.fields, "name", "read-link")?;
                basename(&name, "read-link")?;
                let expected = request
                    .fields
                    .get("expected")
                    .ok_or_else(|| {
                        ProtocolError::invalid("read-link", "expected-identity-required")
                    })
                    .and_then(|value| parse_identity(value, "read-link"))?;
                if expected.kind != "symlink" {
                    return Err(ProtocolError::invalid(
                        "read-link",
                        "symlink-identity-required",
                    ));
                }
                let bytes = unix::read_link(
                    self.directory(&parent, "read-link")?,
                    &name,
                    &expected,
                    MAX_LINK_TARGET_BYTES,
                )?;
                Ok(json!({"data": BASE64.encode(bytes)}))
            }
            "write" => {
                exact_fields(
                    &request.fields,
                    &["cap", "offset", "data", "expected"],
                    "write",
                )?;
                let cap = field_string(&request.fields, "cap", "write")?;
                let offset = field_u64(&request.fields, "offset", "write")?;
                if offset > i64::MAX as u64 {
                    return Err(ProtocolError::invalid("write", "invalid-offset"));
                }
                self.check_expected_cap(&cap, request.fields.get("expected"), "write")?;
                let held = self.file(&cap, "write")?;
                self.require_probed(held, "write")?;
                let encoded = field_string(&request.fields, "data", "write")?;
                let bytes = BASE64
                    .decode(encoded)
                    .map_err(|_| ProtocolError::invalid("write", "invalid-base64"))?;
                if bytes.len() > MAX_CHUNK_BYTES {
                    return Err(ProtocolError::invalid("write", "chunk-too-large"));
                }
                if offset.saturating_add(bytes.len() as u64) > i64::MAX as u64 {
                    return Err(ProtocolError::invalid("write", "invalid-offset"));
                }
                let written = unix::write(held, offset, &bytes)?;
                Ok(json!({"written": written}))
            }
            "truncate" => {
                exact_fields(&request.fields, &["cap", "size", "expected"], "truncate")?;
                let cap = field_string(&request.fields, "cap", "truncate")?;
                let size = field_u64(&request.fields, "size", "truncate")?;
                if size > i64::MAX as u64 {
                    return Err(ProtocolError::invalid("truncate", "invalid-size"));
                }
                self.check_expected_cap(&cap, request.fields.get("expected"), "truncate")?;
                let held = self.file(&cap, "truncate")?;
                self.require_probed(held, "truncate")?;
                unix::truncate(held, size)?;
                Ok(json!({}))
            }
            "set-mode" => {
                exact_fields(&request.fields, &["cap", "mode", "expected"], "set-mode")?;
                let cap = field_string(&request.fields, "cap", "set-mode")?;
                let raw_mode = request
                    .fields
                    .get("mode")
                    .and_then(Value::as_u64)
                    .filter(|mode| *mode <= 0o777)
                    .ok_or_else(|| ProtocolError::invalid("set-mode", "invalid-mode"))?;
                let expected = request
                    .fields
                    .get("expected")
                    .ok_or_else(|| ProtocolError::invalid("set-mode", "expected-identity-required"))
                    .and_then(|value| parse_identity(value, "set-mode"))?;
                if expected.kind != "file" {
                    return Err(ProtocolError::invalid("set-mode", "file-identity-required"));
                }
                self.check_expected_cap(&cap, request.fields.get("expected"), "set-mode")?;
                let held = self.file(&cap, "set-mode")?;
                self.require_probed(held, "set-mode")?;
                let observation = unix::set_mode(held, raw_mode as u32)?;
                if observation.identity != expected {
                    return Err(ProtocolError::conflict(
                        "set-mode",
                        "postflight-identity-conflict",
                        Mutation::Committed,
                    ));
                }
                Ok(json!({"observation": observation}))
            }
            "flush" => {
                exact_fields(&request.fields, &["cap", "mode", "expected"], "flush")?;
                let cap = field_string(&request.fields, "cap", "flush")?;
                let mode = field_string(&request.fields, "mode", "flush")?;
                if !matches!(mode.as_str(), "data" | "all" | "namespace") {
                    return Err(ProtocolError::invalid("flush", "invalid-flush-mode"));
                }
                self.check_expected_cap(&cap, request.fields.get("expected"), "flush")?;
                let held = self.cap(&cap, "flush")?;
                if mode == "namespace" && held.kind != CapKind::Directory {
                    return Err(ProtocolError::invalid("flush", "not-directory-capability"));
                }
                if mode != "namespace" && held.kind != CapKind::File {
                    return Err(ProtocolError::invalid("flush", "not-file-capability"));
                }
                self.require_probed(held, "flush")?;
                unix::flush(held, &mode)?;
                Ok(json!({}))
            }
            "rename" => self.rename(request),
            "symlink" => {
                exact_fields(
                    &request.fields,
                    &["parent", "name", "target", "expected"],
                    "symlink",
                )?;
                require_null(&request.fields, "expected", "symlink")?;
                let parent = field_string(&request.fields, "parent", "symlink")?;
                let name = field_string(&request.fields, "name", "symlink")?;
                let target = field_string(&request.fields, "target", "symlink")?;
                basename(&name, "symlink")?;
                if target.contains('\0') {
                    return Err(ProtocolError::invalid("symlink", "invalid-target"));
                }
                let held = self.directory(&parent, "symlink")?;
                self.require_probed(held, "symlink")?;
                unix::symlink(held, &name, &target)?;
                let observation = unix::stat_at(held, &name, "symlink").map_err(|mut error| {
                    error.body.mutation = Mutation::Committed;
                    error
                })?;
                Ok(json!({"observation": observation}))
            }
            "close" => {
                exact_fields(&request.fields, &["cap"], "close")?;
                let cap = field_string(&request.fields, "cap", "close")?;
                if self.caps.remove(&cap).is_none() {
                    return Err(ProtocolError::invalid("close", "unknown-capability"));
                }
                Ok(json!({}))
            }
            _ => Err(ProtocolError::invalid(&request.op, "unknown-operation")),
        }
    }

    fn stat(&self, request: &Request) -> Result<Value, ProtocolError> {
        if request.fields.contains_key("cap") {
            exact_fields(&request.fields, &["cap"], "stat")?;
            let cap = field_string(&request.fields, "cap", "stat")?;
            return Ok(json!({"observation": unix::observation(self.cap(&cap, "stat")?, "stat")?}));
        }
        exact_fields(&request.fields, &["parent", "name"], "stat")?;
        let parent = field_string(&request.fields, "parent", "stat")?;
        let name = field_string(&request.fields, "name", "stat")?;
        basename(&name, "stat")?;
        let observation = unix::stat_at(self.directory(&parent, "stat")?, &name, "stat")?;
        Ok(json!({"observation": observation}))
    }

    fn list(&self, request: &Request) -> Result<Value, ProtocolError> {
        exact_fields(&request.fields, &["cap", "cursor", "limit"], "list")?;
        let cap = field_string(&request.fields, "cap", "list")?;
        let limit = field_u64(&request.fields, "limit", "list")?;
        if limit == 0 || limit > MAX_LIST_ENTRIES {
            return Err(ProtocolError::invalid("list", "invalid-limit"));
        }
        let cursor = match request.fields.get("cursor") {
            Some(Value::Null) => None,
            Some(Value::String(value)) => {
                let parsed = value
                    .parse::<i64>()
                    .map_err(|_| ProtocolError::invalid("list", "invalid-cursor"))?;
                if parsed < 0 || parsed.to_string() != *value {
                    return Err(ProtocolError::invalid("list", "invalid-cursor"));
                }
                Some(parsed)
            }
            _ => return Err(ProtocolError::invalid("list", "invalid-cursor")),
        };
        let (entries, next_cursor) =
            unix::list(self.directory(&cap, "list")?, cursor, limit as usize)?;
        let next_cursor = next_cursor.map(|value| value.to_string());
        Ok(json!({"entries": entries, "cursor": next_cursor}))
    }

    fn check_expected_cap(
        &self,
        cap: &str,
        expected: Option<&Value>,
        operation: &str,
    ) -> Result<(), ProtocolError> {
        let expected = expected
            .ok_or_else(|| ProtocolError::invalid(operation, "expected-identity-required"))
            .and_then(|value| parse_identity(value, operation))?;
        let actual = unix::identity(self.cap(cap, operation)?, operation)?;
        if expected != actual {
            return Err(ProtocolError::conflict(
                operation,
                "identity-conflict",
                Mutation::None,
            ));
        }
        Ok(())
    }

    fn rename(&self, request: &Request) -> Result<Value, ProtocolError> {
        let replace = field_string(&request.fields, "replace", "rename")?;
        let required = match replace.as_str() {
            "never" => vec![
                "fromParent",
                "from",
                "expected",
                "toParent",
                "to",
                "replace",
            ],
            "any" | "expected" => vec![
                "fromParent",
                "from",
                "expected",
                "toParent",
                "to",
                "replace",
                "expectedTarget",
            ],
            _ => return Err(ProtocolError::invalid("rename", "invalid-replace-mode")),
        };
        exact_fields(&request.fields, &required, "rename")?;
        let from_parent = field_string(&request.fields, "fromParent", "rename")?;
        let from = field_string(&request.fields, "from", "rename")?;
        let to_parent = field_string(&request.fields, "toParent", "rename")?;
        let to = field_string(&request.fields, "to", "rename")?;
        basename(&from, "rename")?;
        basename(&to, "rename")?;
        let from_dir = self.directory(&from_parent, "rename")?;
        let to_dir = self.directory(&to_parent, "rename")?;
        self.require_probed(from_dir, "rename")?;
        self.require_probed(to_dir, "rename")?;
        if unix::identity(from_dir, "rename")?.volume != unix::identity(to_dir, "rename")?.volume {
            return Err(ProtocolError::unsupported("rename", "cross-volume"));
        }
        let source_expected = request
            .fields
            .get("expected")
            .ok_or_else(|| ProtocolError::invalid("rename", "expected-identity-required"))
            .and_then(|value| parse_identity(value, "rename"))?;
        let source_actual = unix::stat_at(from_dir, &from, "rename")?.identity;
        if source_actual != source_expected {
            return Err(ProtocolError::conflict(
                "rename",
                "identity-conflict",
                Mutation::None,
            ));
        }
        let target_expected = match replace.as_str() {
            "any" => {
                require_null(&request.fields, "expectedTarget", "rename")?;
                None
            }
            "expected" => {
                let target_expected = request
                    .fields
                    .get("expectedTarget")
                    .ok_or_else(|| ProtocolError::invalid("rename", "expected-target-required"))
                    .and_then(|value| parse_identity(value, "rename"))?;
                let target_actual = unix::stat_at(to_dir, &to, "rename")?.identity;
                if target_actual != target_expected {
                    return Err(ProtocolError::conflict(
                        "rename",
                        "identity-conflict",
                        Mutation::None,
                    ));
                }
                Some(target_expected)
            }
            "never" => None,
            _ => unreachable!(),
        };
        unix::rename(
            from_dir,
            &from,
            &source_expected,
            to_dir,
            &to,
            target_expected.as_ref(),
            replace == "never",
        )?;
        let observation = unix::stat_at(to_dir, &to, "rename").map_err(|mut error| {
            error.body.mutation = Mutation::Committed;
            error
        })?;
        if observation.identity != source_expected {
            return Err(ProtocolError::conflict(
                "rename",
                "post-rename-identity-conflict",
                Mutation::Committed,
            ));
        }
        Ok(json!({"observation": observation}))
    }
}

fn expected_platform() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(target_os = "macos")]
    {
        "darwin"
    }
    #[cfg(windows)]
    {
        "win32"
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        "unsupported"
    }
}

fn parse_identity(value: &Value, operation: &str) -> Result<Identity, ProtocolError> {
    let object = value
        .as_object()
        .ok_or_else(|| ProtocolError::invalid(operation, "invalid-identity"))?;
    if object.len() != 5 {
        return Err(ProtocolError::invalid(operation, "invalid-identity"));
    }
    let version = object
        .get("version")
        .and_then(Value::as_u64)
        .filter(|version| *version == IDENTITY_VERSION)
        .ok_or_else(|| ProtocolError::invalid(operation, "invalid-identity"))?;
    let platform = object
        .get("platform")
        .and_then(Value::as_str)
        .filter(|platform| *platform == expected_platform())
        .ok_or_else(|| ProtocolError::invalid(operation, "foreign-identity"))?
        .to_string();
    let decimal = |name: &str| -> Result<String, ProtocolError> {
        let text = object
            .get(name)
            .and_then(Value::as_str)
            .ok_or_else(|| ProtocolError::invalid(operation, "invalid-identity"))?;
        let parsed = text
            .parse::<u64>()
            .map_err(|_| ProtocolError::invalid(operation, "invalid-identity"))?;
        if parsed.to_string() != text {
            return Err(ProtocolError::invalid(operation, "invalid-identity"));
        }
        Ok(text.to_string())
    };
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .filter(|kind| matches!(*kind, "directory" | "file" | "symlink" | "other"))
        .ok_or_else(|| ProtocolError::invalid(operation, "invalid-identity"))?
        .to_string();
    let file_id = if platform == "win32" {
        object
            .get("fileId")
            .and_then(Value::as_str)
            .filter(|value| {
                value.len() == 32
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            })
            .ok_or_else(|| ProtocolError::invalid(operation, "invalid-identity"))?
            .to_string()
    } else {
        decimal("fileId")?
    };
    Ok(Identity {
        version,
        platform,
        volume: decimal("volume")?,
        file_id,
        kind,
    })
}

fn response_id(line: &[u8]) -> String {
    serde_json::from_slice::<Value>(line)
        .ok()
        .and_then(|value| value.get("id")?.as_str().map(str::to_owned))
        .filter(|id| protocol::printable(id))
        .unwrap_or_else(|| "invalid-request".to_string())
}

fn write_response(writer: &mut impl Write, value: &Value) -> io::Result<()> {
    let encoded = serde_json::to_vec(value)?;
    writer.write_all(&encoded)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn bounded_response(id: &str, operation: &str, value: Value) -> Value {
    match serde_json::to_vec(&value) {
        Ok(encoded) if encoded.len() < MAX_LINE_BYTES => value,
        _ => failure(
            id,
            ProtocolError::new(operation, "response-too-large", "limit", Mutation::None).body,
        ),
    }
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
    let mut session = Session::new();
    loop {
        let mut line = Vec::new();
        let count = reader
            .by_ref()
            .take((MAX_LINE_BYTES + 2) as u64)
            .read_until(b'\n', &mut line)?;
        if count == 0 {
            break;
        }
        if line.len() > MAX_LINE_BYTES || !line.ends_with(b"\n") {
            let error = ProtocolError::invalid("request", "line-too-large");
            write_response(&mut writer, &failure("invalid-request", error.body))?;
            break;
        }
        line.pop();
        if line.ends_with(b"\r") {
            line.pop();
        }
        let id = response_id(&line);
        let response = match parse_request(&line) {
            Ok(request) => match session.handle(&request) {
                Ok(result) => {
                    bounded_response(&request.id, &request.op, success(&request.id, result))
                }
                Err(error) => failure(&request.id, error.body),
            },
            Err(error) => failure(&id, error.body),
        };
        write_response(&mut writer, &response)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    use std::fs;
    #[cfg(target_os = "linux")]
    use std::os::unix::ffi::OsStrExt;
    #[cfg(target_os = "linux")]
    use std::time::{SystemTime, UNIX_EPOCH};

    fn request(value: Value) -> Request {
        parse_request(format!("{value}").as_bytes()).unwrap()
    }

    #[cfg(target_os = "linux")]
    fn create_test_file(session: &mut Session, root: &str, id: &str, name: &str) -> Value {
        session
            .handle(&request(json!({
                "v":1,"id":id,"op":"create-file",
                "parent":root,"name":name,"mode":0o600,"expected":null
            })))
            .unwrap()
    }

    #[test]
    fn hello_and_open_root_reject_unknown_fields() {
        let mut session = Session::new();
        for value in [
            json!({"v":1,"id":"1","op":"hello","unknown":true}),
            json!({"v":1,"id":"2","op":"open-root","path":"/","paht":"/"}),
        ] {
            let parsed = request(value);
            let error = session.handle(&parsed).unwrap_err();
            assert_eq!(error.body.code, "invalid-fields");
            assert!(matches!(error.body.mutation, Mutation::None));
        }
    }

    #[test]
    fn identities_reject_wrong_version_platform_and_fields() {
        let file_id = if expected_platform() == "win32" {
            "00000000000000000000000000000002"
        } else {
            "2"
        };
        let valid = json!({
            "version": 2,
            "platform": expected_platform(),
            "volume": "1",
            "fileId": file_id,
            "kind": "file"
        });
        assert!(parse_identity(&valid, "test").is_ok());
        let mut wrong_version = valid.clone();
        wrong_version["version"] = json!(1);
        let mut wrong_platform = valid.clone();
        wrong_platform["platform"] = json!("foreign");
        let mut extra_field = valid.clone();
        extra_field["device"] = json!("1");
        let mut noncanonical_decimal = valid.clone();
        noncanonical_decimal["volume"] = json!("01");
        for invalid in [
            wrong_version,
            wrong_platform,
            extra_field,
            noncanonical_decimal,
        ] {
            assert!(parse_identity(&invalid, "test").is_err());
        }
    }

    #[test]
    fn creation_requires_exact_mode_and_explicit_null_expected_before_mutation() {
        let mut session = Session::new();
        for value in [
            json!({"v":1,"id":"1","op":"create-file","parent":"c1","name":"x"}),
            json!({"v":1,"id":"2","op":"create-directory","parent":"c1","name":"x","mode":0o700,"expected":{}}),
            json!({"v":1,"id":"3","op":"create-directory","parent":"c1","name":"x","mode":"0700","expected":null}),
            json!({"v":1,"id":"4","op":"create-directory","parent":"c1","name":"x","mode":0o750,"expected":null}),
            json!({"v":1,"id":"5","op":"create-file","parent":"c1","name":"x","mode":0o640,"expected":null}),
            json!({"v":1,"id":"6","op":"create-file","parent":"c1","name":"x","mode":0o600,"expected":null,"unknown":true}),
            json!({"v":1,"id":"7","op":"create-file","parent":"c1","name":"x","mdoe":0o600,"expected":null}),
            json!({"v":1,"id":"3","op":"symlink","parent":"c1","name":"x","target":"y","expected":false}),
        ] {
            let error = session.handle(&request(value)).unwrap_err();
            assert!(matches!(error.body.mutation, Mutation::None));
        }
    }

    #[test]
    fn read_link_requires_exact_fields_and_a_symlink_identity() {
        let mut session = Session::new();
        let file_id = if expected_platform() == "win32" {
            "00000000000000000000000000000001"
        } else {
            "1"
        };
        let file_identity = json!({
            "version":2,"platform":expected_platform(),"volume":"1",
            "fileId":file_id,"kind":"file"
        });
        for value in [
            json!({"v":1,"id":"1","op":"read-link","parent":"c1","name":"x"}),
            json!({"v":1,"id":"2","op":"read-link","parent":"c1","name":"x","expected":file_identity}),
            json!({"v":1,"id":"3","op":"read-link","parent":"c1","name":"../x","expected":null}),
        ] {
            let error = session.handle(&request(value)).unwrap_err();
            assert!(matches!(error.body.mutation, Mutation::None));
            assert_eq!(error.body.class, "invalid-request");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[allow(clippy::redundant_closure_call)] // closure guarantees cleanup after fallible assertions
    fn read_link_returns_lossless_target_bytes_and_binds_identity() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root_path = std::env::temp_dir().join(format!(
            "stdd-fs-read-link-test-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir(&root_path).unwrap();
        let target = std::ffi::OsStr::from_bytes(b"../escape/\xff\x80target");
        std::os::unix::fs::symlink(target, root_path.join("link")).unwrap();
        let result = (|| {
            let mut session = Session::new();
            let root = session.handle(&request(json!({
                "v":1,"id":"1","op":"open-root","path":root_path
            })))?;
            let root_cap = root["cap"].as_str().unwrap();
            let stat = session.handle(&request(json!({
                "v":1,"id":"2","op":"stat","parent":root_cap,"name":"link"
            })))?;
            let expected = stat["observation"]["identity"].clone();
            let read = session.handle(&request(json!({
                "v":1,"id":"3","op":"read-link","parent":root_cap,
                "name":"link","expected":expected
            })))?;
            assert_eq!(
                BASE64.decode(read["data"].as_str().unwrap()).unwrap(),
                target.as_bytes()
            );

            std::os::unix::fs::symlink("replacement", root_path.join("replacement-link")).unwrap();
            fs::rename(root_path.join("replacement-link"), root_path.join("link")).unwrap();
            let error = session
                .handle(&request(json!({
                    "v":1,"id":"4","op":"read-link","parent":root_cap,
                    "name":"link","expected":expected
                })))
                .unwrap_err();
            assert_eq!(error.body.code, "identity-conflict");
            assert!(matches!(error.body.mutation, Mutation::None));
            Ok::<(), ProtocolError>(())
        })();
        let _ = fs::remove_file(root_path.join("link"));
        let _ = fs::remove_dir(&root_path);
        result.unwrap();
    }

    #[test]
    fn every_operation_rejects_unknown_request_fields() {
        let mut session = Session::new();
        let cases = [
            json!({"v":1,"id":"1","op":"hello","unknown":true}),
            json!({"v":1,"id":"2","op":"probe","root":"c1","unknown":true}),
            json!({"v":1,"id":"2a","op":"preflight-symlink","root":"c1","unknown":true}),
            json!({"v":1,"id":"2b","op":"verify-private","cap":"c1","unknown":true}),
            json!({"v":1,"id":"3","op":"open-root","path":"/","unknown":true}),
            json!({"v":1,"id":"4","op":"open-child","parent":"c1","name":"x","unknown":true}),
            json!({"v":1,"id":"5","op":"create-directory","parent":"c1","name":"x","mode":0o700,"expected":null,"unknown":true}),
            json!({"v":1,"id":"6","op":"create-file","parent":"c1","name":"x","mode":0o600,"expected":null,"unknown":true}),
            json!({"v":1,"id":"7","op":"stat","cap":"c1","unknown":true}),
            json!({"v":1,"id":"8","op":"list","cap":"c1","cursor":null,"limit":1,"unknown":true}),
            json!({"v":1,"id":"9","op":"read","cap":"c1","offset":0,"length":1,"unknown":true}),
            json!({"v":1,"id":"9a","op":"read-link","parent":"c1","name":"x","expected":{},"unknown":true}),
            json!({"v":1,"id":"10","op":"write","cap":"c1","offset":0,"data":"","expected":{},"unknown":true}),
            json!({"v":1,"id":"11","op":"truncate","cap":"c1","size":0,"expected":{},"unknown":true}),
            json!({"v":1,"id":"12","op":"flush","cap":"c1","mode":"all","expected":{},"unknown":true}),
            json!({"v":1,"id":"12a","op":"set-mode","cap":"c1","mode":0o664,"expected":{},"unknown":true}),
            json!({"v":1,"id":"13","op":"rename","fromParent":"c1","from":"a","expected":{},"toParent":"c1","to":"b","replace":"never","unknown":true}),
            json!({"v":1,"id":"14","op":"symlink","parent":"c1","name":"x","target":"y","expected":null,"unknown":true}),
            json!({"v":1,"id":"15","op":"close","cap":"c1","unknown":true}),
        ];
        for value in cases {
            let parsed = request(value);
            let error = session.handle(&parsed).unwrap_err();
            assert_eq!(error.body.code, "invalid-fields", "{}", parsed.op);
            assert!(matches!(error.body.mutation, Mutation::None));
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rename_backend_rechecks_source_and_expected_target_at_the_syscall_boundary() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root_path = std::env::temp_dir().join(format!(
            "stdd-fs-rename-boundary-test-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir(&root_path).unwrap();
        fs::write(root_path.join("source"), b"source").unwrap();
        fs::write(root_path.join("target"), b"target").unwrap();
        let root = unix::open_root(&root_path).unwrap();

        let source_expected = unix::stat_at(&root, "source", "test").unwrap().identity;
        let target_expected = unix::stat_at(&root, "target", "test").unwrap().identity;
        fs::rename(root_path.join("source"), root_path.join("held-source")).unwrap();
        fs::write(root_path.join("source"), b"replacement").unwrap();
        let source_error = unix::rename(
            &root,
            "source",
            &source_expected,
            &root,
            "target",
            Some(&target_expected),
            false,
        )
        .unwrap_err();
        assert_eq!(source_error.body.code, "identity-conflict");
        assert!(matches!(source_error.body.mutation, Mutation::None));
        assert_eq!(fs::read(root_path.join("source")).unwrap(), b"replacement");
        assert_eq!(fs::read(root_path.join("target")).unwrap(), b"target");

        fs::remove_file(root_path.join("source")).unwrap();
        fs::write(root_path.join("source"), b"publish").unwrap();
        let source_expected = unix::stat_at(&root, "source", "test").unwrap().identity;
        fs::rename(root_path.join("target"), root_path.join("held-target")).unwrap();
        fs::write(root_path.join("target"), b"competing").unwrap();
        let target_error = unix::rename(
            &root,
            "source",
            &source_expected,
            &root,
            "target",
            Some(&target_expected),
            false,
        )
        .unwrap_err();
        assert_eq!(target_error.body.code, "identity-conflict");
        assert!(matches!(target_error.body.mutation, Mutation::None));
        assert_eq!(fs::read(root_path.join("source")).unwrap(), b"publish");
        assert_eq!(fs::read(root_path.join("target")).unwrap(), b"competing");

        fs::remove_dir_all(root_path).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[allow(clippy::redundant_closure_call)] // closure guarantees cleanup after fallible assertions
    fn observations_and_all_rename_modes_bind_exact_identities() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root_path =
            std::env::temp_dir().join(format!("stdd-fs-rust-test-{}-{suffix}", std::process::id()));
        fs::create_dir(&root_path).unwrap();
        let result = (|| {
            let mut session = Session::new();
            let root = session
                .handle(&request(json!({
                    "v":1,"id":"1","op":"open-root","path":root_path
                })))
                .unwrap();
            let root_cap = root["cap"].as_str().unwrap();
            let observation = root["observation"].as_object().unwrap();
            assert_eq!(observation.len(), 7);
            assert_eq!(observation["identity"]["version"], 2);
            assert_eq!(observation["identity"]["platform"], "linux");
            for field in [
                "owner",
                "permissions",
                "linkCount",
                "size",
                "modifiedNs",
                "changedNs",
            ] {
                assert!(observation[field].as_str().is_some(), "{field}");
            }
            session
                .handle(&request(json!({
                    "v":1,"id":"2","op":"probe","root":root_cap
                })))
                .unwrap();
            let legacy = create_test_file(&mut session, root_cap, "2a", "legacy-mode");
            let legacy_identity = legacy["observation"]["identity"].clone();
            let changed = session
                .handle(&request(json!({
                    "v":1,"id":"2b","op":"set-mode","cap":legacy["cap"],
                    "mode":0o664,"expected":legacy_identity
                })))
                .unwrap();
            assert_eq!(
                changed["observation"]["identity"],
                legacy["observation"]["identity"]
            );
            assert_eq!(
                changed["observation"]["permissions"]
                    .as_str()
                    .unwrap()
                    .parse::<u32>()
                    .unwrap()
                    & 0o7777,
                0o664
            );
            let wrong_identity = create_test_file(&mut session, root_cap, "2c", "wrong-mode-id")
                ["observation"]["identity"]
                .clone();
            let conflict = session
                .handle(&request(json!({
                    "v":1,"id":"2d","op":"set-mode","cap":legacy["cap"],
                    "mode":0o600,"expected":wrong_identity
                })))
                .unwrap_err();
            assert_eq!(conflict.body.code, "identity-conflict");
            assert!(matches!(conflict.body.mutation, Mutation::None));
            for mode in [0o1000, 0o10664] {
                let invalid = session
                    .handle(&request(json!({
                        "v":1,"id":"2e","op":"set-mode","cap":legacy["cap"],
                        "mode":mode,"expected":legacy["observation"]["identity"]
                    })))
                    .unwrap_err();
                assert_eq!(invalid.body.code, "invalid-mode");
                assert!(matches!(invalid.body.mutation, Mutation::None));
            }
            let invalid_type = session
                .handle(&request(json!({
                    "v":1,"id":"2f","op":"set-mode","cap":legacy["cap"],
                    "mode":"0664","expected":legacy["observation"]["identity"]
                })))
                .unwrap_err();
            assert_eq!(invalid_type.body.code, "invalid-mode");
            assert!(matches!(invalid_type.body.mutation, Mutation::None));
            let blocked = create_test_file(&mut session, root_cap, "3", "blocked");
            let occupied = create_test_file(&mut session, root_cap, "4", "occupied");
            let blocked_identity = blocked["observation"]["identity"].clone();
            let never_error = session
                .handle(&request(json!({
                    "v":1,"id":"5","op":"rename",
                    "fromParent":root_cap,"from":"blocked","expected":blocked_identity,
                    "toParent":root_cap,"to":"occupied","replace":"never"
                })))
                .unwrap_err();
            assert_eq!(never_error.body.code, "identity-conflict");
            assert!(matches!(never_error.body.mutation, Mutation::None));

            let expected_source = create_test_file(&mut session, root_cap, "6", "expected-source");
            let expected_target = create_test_file(&mut session, root_cap, "7", "expected-target");
            let expected_source_identity = expected_source["observation"]["identity"].clone();
            let expected_target_identity = expected_target["observation"]["identity"].clone();
            let expected_result = session
                .handle(&request(json!({
                    "v":1,"id":"8","op":"rename",
                    "fromParent":root_cap,"from":"expected-source",
                    "expected":expected_source_identity,
                    "toParent":root_cap,"to":"expected-target","replace":"expected",
                    "expectedTarget":expected_target_identity
                })))
                .unwrap();
            assert_eq!(
                expected_result["observation"]["identity"],
                expected_source["observation"]["identity"]
            );

            let any_source = create_test_file(&mut session, root_cap, "9", "any-source");
            let any_identity = any_source["observation"]["identity"].clone();
            let any_result = session
                .handle(&request(json!({
                    "v":1,"id":"10","op":"rename",
                    "fromParent":root_cap,"from":"any-source","expected":any_identity,
                    "toParent":root_cap,"to":"occupied","replace":"any",
                    "expectedTarget":null
                })))
                .unwrap();
            assert_eq!(
                any_result["observation"]["identity"],
                any_source["observation"]["identity"]
            );
            assert!(occupied["observation"]["identity"].is_object());
            Ok::<(), ()>(())
        })();
        fs::remove_dir_all(&root_path).unwrap();
        result.unwrap();
    }
}
