use serde::Serialize;
use serde_json::{Map, Value};
use std::io;

pub const VERSION: u64 = 1;
pub const IDENTITY_VERSION: u64 = 2;
pub const MAX_LINE_BYTES: usize = 1024 * 1024;
pub const MAX_CHUNK_BYTES: usize = 64 * 1024;
pub const MAX_LIST_ENTRIES: u64 = 1024;

#[derive(Debug)]
pub struct Request {
    pub id: String,
    pub op: String,
    pub fields: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mutation {
    None,
    Possible,
    Committed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub code: String,
    pub class: String,
    pub operation: String,
    pub os_code: Option<i32>,
    pub mutation: Mutation,
    pub retryable: bool,
}

#[derive(Debug)]
pub struct ProtocolError {
    pub body: ErrorBody,
}

impl ProtocolError {
    pub fn new(
        operation: impl Into<String>,
        code: impl Into<String>,
        class: impl Into<String>,
        mutation: Mutation,
    ) -> Self {
        Self {
            body: ErrorBody {
                code: code.into(),
                class: class.into(),
                operation: operation.into(),
                os_code: None,
                mutation,
                retryable: false,
            },
        }
    }

    pub fn invalid(operation: &str, code: &str) -> Self {
        Self::new(operation, code, "invalid-request", Mutation::None)
    }

    pub fn conflict(operation: &str, code: &str, mutation: Mutation) -> Self {
        Self::new(operation, code, "conflict", mutation)
    }

    pub fn unsupported(operation: &str, code: &str) -> Self {
        Self::new(operation, code, "unsupported", Mutation::None)
    }

    pub fn classified_io(
        operation: &str,
        error: io::Error,
        code: &str,
        class: &str,
        mutation: Mutation,
        retryable: bool,
    ) -> Self {
        Self {
            body: ErrorBody {
                code: code.to_string(),
                class: class.to_string(),
                operation: operation.to_string(),
                os_code: error.raw_os_error(),
                mutation,
                retryable,
            },
        }
    }
}

pub fn parse_request(line: &[u8]) -> Result<Request, ProtocolError> {
    let value: Value = serde_json::from_slice(line)
        .map_err(|_| ProtocolError::invalid("request", "invalid-json"))?;
    let mut object = value
        .as_object()
        .cloned()
        .ok_or_else(|| ProtocolError::invalid("request", "invalid-envelope"))?;
    if object.remove("v").and_then(|v| v.as_u64()) != Some(VERSION) {
        return Err(ProtocolError::invalid("request", "protocol-mismatch"));
    }
    let id = object
        .remove("id")
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or_else(|| ProtocolError::invalid("request", "invalid-id"))?;
    if !printable(&id) {
        return Err(ProtocolError::invalid("request", "invalid-id"));
    }
    let op = object
        .remove("op")
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or_else(|| ProtocolError::invalid("request", "invalid-operation"))?;
    if !printable(&op) {
        return Err(ProtocolError::invalid("request", "invalid-operation"));
    }
    Ok(Request {
        id,
        op,
        fields: object,
    })
}

pub fn success(id: &str, result: Value) -> Value {
    serde_json::json!({"v": VERSION, "id": id, "ok": true, "result": result})
}

pub fn failure(id: &str, error: ErrorBody) -> Value {
    serde_json::json!({"v": VERSION, "id": id, "ok": false, "error": error})
}

pub fn exact_fields(
    fields: &Map<String, Value>,
    required: &[&str],
    operation: &str,
) -> Result<(), ProtocolError> {
    if fields.len() != required.len() || !required.iter().all(|name| fields.contains_key(*name)) {
        return Err(ProtocolError::invalid(operation, "invalid-fields"));
    }
    Ok(())
}

pub fn field_string(
    fields: &Map<String, Value>,
    name: &str,
    operation: &str,
) -> Result<String, ProtocolError> {
    fields
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| ProtocolError::invalid(operation, "invalid-field"))
}

pub fn field_u64(
    fields: &Map<String, Value>,
    name: &str,
    operation: &str,
) -> Result<u64, ProtocolError> {
    fields
        .get(name)
        .and_then(Value::as_u64)
        .ok_or_else(|| ProtocolError::invalid(operation, "invalid-field"))
}

pub fn field_mode(
    fields: &Map<String, Value>,
    name: &str,
    allowed: &[u32],
    operation: &str,
) -> Result<u32, ProtocolError> {
    let mode = fields
        .get(name)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| ProtocolError::invalid(operation, "invalid-mode"))?;
    if !allowed.contains(&mode) {
        return Err(ProtocolError::invalid(operation, "invalid-mode"));
    }
    Ok(mode)
}

pub fn require_null(
    fields: &Map<String, Value>,
    name: &str,
    operation: &str,
) -> Result<(), ProtocolError> {
    if fields.get(name) != Some(&Value::Null) {
        return Err(ProtocolError::invalid(operation, "null-required"));
    }
    Ok(())
}

pub fn basename(value: &str, operation: &str) -> Result<(), ProtocolError> {
    #[cfg(windows)]
    if value.contains(':') {
        return Err(ProtocolError::invalid(operation, "invalid-basename"));
    }
    if value.is_empty()
        || value.len() > 255
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || !printable(value)
    {
        return Err(ProtocolError::invalid(operation, "invalid-basename"));
    }
    Ok(())
}

fn denied_format(c: char) -> bool {
    matches!(
        c as u32,
        0x00ad
            | 0x034f
            | 0x061c
            | 0x180e
            | 0x200b
            | 0x200e
            | 0x200f
            | 0x202a..=0x202e
            | 0x2060..=0x206f
            | 0xfeff
            | 0xfff9..=0xfffb
            | 0x1bca0..=0x1bcaf
            | 0x1d173..=0x1d17a
            | 0xe0001
    )
}

pub fn printable(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().all(|c| !c.is_control() && !denied_format(c))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn basenames_reject_escape_and_invisible_text() {
        for name in [
            "",
            ".",
            "..",
            "a/b",
            "a\\b",
            "a\0b",
            "a\u{202e}b",
            "a\u{200b}b",
            &"x".repeat(256),
        ] {
            assert!(basename(name, "test").is_err(), "{name:?}");
        }
        assert!(basename("normal-👩‍💻", "test").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn windows_basenames_reject_alternate_data_stream_syntax() {
        for name in ["file:stream", "file:", ":stream"] {
            assert!(basename(name, "test").is_err(), "{name:?}");
        }
    }

    #[test]
    fn exact_fields_reject_unknown_missing_and_misspelled_names() {
        let exact = json!({"cap":"c1","offset":0,"length":1})
            .as_object()
            .unwrap()
            .clone();
        assert!(exact_fields(&exact, &["cap", "offset", "length"], "read").is_ok());
        for value in [
            json!({"cap":"c1","offset":0}),
            json!({"cap":"c1","offset":0,"lenght":1}),
            json!({"cap":"c1","offset":0,"length":1,"reserved":true}),
        ] {
            assert!(exact_fields(
                value.as_object().unwrap(),
                &["cap", "offset", "length"],
                "read"
            )
            .is_err());
        }
    }
}
