//! Pure, platform-independent normalization used by the Windows backend.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ErrorClass {
    pub code: &'static str,
    pub class: &'static str,
    pub retryable: bool,
}

pub fn full_file_id(bytes: &[u8; 16]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn normalize_sddl(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_uppercase)
        .collect()
}

pub const IO_REPARSE_TAG_SYMLINK: u32 = 0xa000_000c;
pub const SYMLINK_FLAG_RELATIVE: u32 = 1;
const REPARSE_HEADER_BYTES: usize = 8;
const SYMLINK_HEADER_BYTES: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReparseError {
    Truncated,
    UnsupportedTag,
    InvalidLength,
    InvalidFlags,
}

fn u16_at(bytes: &[u8], offset: usize) -> Result<u16, ReparseError> {
    let pair = bytes
        .get(offset..offset + 2)
        .ok_or(ReparseError::Truncated)?;
    Ok(u16::from_le_bytes([pair[0], pair[1]]))
}

fn u32_at(bytes: &[u8], offset: usize) -> Result<u32, ReparseError> {
    let word = bytes
        .get(offset..offset + 4)
        .ok_or(ReparseError::Truncated)?;
    Ok(u32::from_le_bytes([word[0], word[1], word[2], word[3]]))
}

/// Return the exact UTF-16LE bytes stored as the effective substitute target.
pub fn parse_symlink_reparse(bytes: &[u8], max_bytes: usize) -> Result<Vec<u8>, ReparseError> {
    if bytes.len() < REPARSE_HEADER_BYTES + SYMLINK_HEADER_BYTES {
        return Err(ReparseError::Truncated);
    }
    if u32_at(bytes, 0)? != IO_REPARSE_TAG_SYMLINK {
        return Err(ReparseError::UnsupportedTag);
    }
    let data_length = u16_at(bytes, 4)? as usize;
    let data_end = REPARSE_HEADER_BYTES
        .checked_add(data_length)
        .filter(|end| *end <= bytes.len())
        .ok_or(ReparseError::InvalidLength)?;
    if data_length < SYMLINK_HEADER_BYTES {
        return Err(ReparseError::InvalidLength);
    }
    let substitute_offset = u16_at(bytes, 8)? as usize;
    let substitute_length = u16_at(bytes, 10)? as usize;
    let print_offset = u16_at(bytes, 12)? as usize;
    let print_length = u16_at(bytes, 14)? as usize;
    let flags = u32_at(bytes, 16)?;
    if flags & !SYMLINK_FLAG_RELATIVE != 0 {
        return Err(ReparseError::InvalidFlags);
    }
    if substitute_offset & 1 != 0
        || substitute_length & 1 != 0
        || print_offset & 1 != 0
        || print_length & 1 != 0
        || substitute_length > max_bytes
        || print_length > max_bytes
    {
        return Err(ReparseError::InvalidLength);
    }
    let path_start = REPARSE_HEADER_BYTES + SYMLINK_HEADER_BYTES;
    let checked_span = |offset: usize, length: usize| {
        let start = path_start
            .checked_add(offset)
            .ok_or(ReparseError::InvalidLength)?;
        let end = start
            .checked_add(length)
            .filter(|end| *end <= data_end)
            .ok_or(ReparseError::InvalidLength)?;
        Ok::<_, ReparseError>((start, end))
    };
    let (substitute_start, substitute_end) = checked_span(substitute_offset, substitute_length)?;
    let _print_span = checked_span(print_offset, print_length)?;
    Ok(bytes[substitute_start..substitute_end].to_vec())
}

pub fn symlink_target_is_directory(target: &str, observed_kind: Option<&str>) -> bool {
    observed_kind == Some("directory") || target.ends_with(['/', '\\'])
}

pub fn postflight_identity_matches<T: Eq>(before: &T, after: &T) -> bool {
    before == after
}

pub fn symlink_creation_authorized(privilege: bool, developer_mode: bool) -> bool {
    privilege || developer_mode
}

pub fn build_symlink_reparse(
    substitute: &[u16],
    print: &[u16],
    relative: bool,
) -> Result<Vec<u8>, ReparseError> {
    let substitute_bytes = substitute
        .len()
        .checked_mul(2)
        .ok_or(ReparseError::InvalidLength)?;
    let print_bytes = print
        .len()
        .checked_mul(2)
        .ok_or(ReparseError::InvalidLength)?;
    let data_length = SYMLINK_HEADER_BYTES
        .checked_add(substitute_bytes)
        .and_then(|length| length.checked_add(print_bytes))
        .filter(|length| *length <= u16::MAX as usize)
        .ok_or(ReparseError::InvalidLength)?;
    let mut bytes = Vec::with_capacity(REPARSE_HEADER_BYTES + data_length);
    bytes.extend_from_slice(&IO_REPARSE_TAG_SYMLINK.to_le_bytes());
    bytes.extend_from_slice(&(data_length as u16).to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&(substitute_bytes as u16).to_le_bytes());
    bytes.extend_from_slice(&(substitute_bytes as u16).to_le_bytes());
    bytes.extend_from_slice(&(print_bytes as u16).to_le_bytes());
    bytes.extend_from_slice(&(if relative { SYMLINK_FLAG_RELATIVE } else { 0 }).to_le_bytes());
    for unit in substitute.iter().chain(print.iter()) {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    Ok(bytes)
}

pub fn classify_win32(code: u32) -> ErrorClass {
    match code {
        2 | 3 | 123 => ErrorClass {
            code: "not-found",
            class: "not-found",
            retryable: false,
        },
        80 | 145 | 183 => ErrorClass {
            code: "identity-conflict",
            class: "conflict",
            retryable: false,
        },
        681 | 741 | 755 | 1920 | 4390..=4395 => ErrorClass {
            code: "symlink-rejected",
            class: "confinement",
            retryable: false,
        },
        267 => ErrorClass {
            code: "not-directory",
            class: "confinement",
            retryable: false,
        },
        17 => ErrorClass {
            code: "cross-volume",
            class: "unsupported",
            retryable: false,
        },
        5 | 1314 => ErrorClass {
            code: "access-denied",
            class: "access",
            retryable: false,
        },
        1 | 50 | 120 => ErrorClass {
            code: "unsupported-capability",
            class: "unsupported",
            retryable: false,
        },
        32 | 33 | 170 | 995 => ErrorClass {
            code: "os-error",
            class: "io",
            retryable: true,
        },
        _ => ErrorClass {
            code: "os-error",
            class: "io",
            retryable: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_windows_file_ids_have_lossless_protocol_values() {
        let first = [0_u8; 16];
        let mut second = first;
        second[15] = 1;
        assert_eq!(full_file_id(&first), "00000000000000000000000000000000");
        assert_eq!(full_file_id(&second), "00000000000000000000000000000001");
    }

    #[test]
    fn dacl_normalization_is_case_and_whitespace_stable() {
        let left = "O:S-1-5-21 D:P(A;;FA;;;SY)(A;;FA;;;BA)";
        let right = "o:s-1-5-21d:p(a;;fa;;;sy)(a;;fa;;;ba)";
        assert_eq!(normalize_sddl(left), normalize_sddl(right));
        assert_ne!(
            normalize_sddl(left),
            normalize_sddl("O:S-1-5-21D:(A;;FA;;;WD)")
        );
    }

    #[test]
    fn concrete_windows_errors_map_without_posix_errno_reuse() {
        assert_eq!(classify_win32(2).code, "not-found");
        assert_eq!(classify_win32(183).code, "identity-conflict");
        assert_eq!(classify_win32(681).code, "symlink-rejected");
        assert_eq!(classify_win32(267).code, "not-directory");
        assert_eq!(classify_win32(17).code, "cross-volume");
        assert_eq!(classify_win32(50).code, "unsupported-capability");
        assert!(classify_win32(32).retryable);
        assert_eq!(classify_win32(1314).class, "access");
    }

    fn reparse(print: &[u8], tag: u32, flags: u32) -> Vec<u8> {
        let data_length = (SYMLINK_HEADER_BYTES + print.len()) as u16;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&tag.to_le_bytes());
        bytes.extend_from_slice(&data_length.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&(print.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&(print.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&flags.to_le_bytes());
        bytes.extend_from_slice(print);
        bytes
    }

    #[test]
    fn reparse_parser_preserves_escape_target_bytes() {
        let target = b".\0.\0/\0e\0s\0c\0a\0p\0e\0";
        assert_eq!(
            parse_symlink_reparse(
                &reparse(target, IO_REPARSE_TAG_SYMLINK, SYMLINK_FLAG_RELATIVE),
                64 * 1024
            ),
            Ok(target.to_vec())
        );
    }

    #[test]
    fn malformed_and_unrecognized_reparse_points_are_rejected() {
        assert_eq!(
            parse_symlink_reparse(&[0; 7], 64),
            Err(ReparseError::Truncated)
        );
        assert_eq!(
            parse_symlink_reparse(&reparse(b"x\0", 0xa000_0003, 0), 64),
            Err(ReparseError::UnsupportedTag)
        );
        let mut invalid = reparse(b"x\0", IO_REPARSE_TAG_SYMLINK, 2);
        assert_eq!(
            parse_symlink_reparse(&invalid, 64),
            Err(ReparseError::InvalidFlags)
        );
        invalid[16..20].copy_from_slice(&0_u32.to_le_bytes());
        invalid[14..16].copy_from_slice(&3_u16.to_le_bytes());
        assert_eq!(
            parse_symlink_reparse(&invalid, 64),
            Err(ReparseError::InvalidLength)
        );
        let mut invalid_substitute = reparse(b"x\0", IO_REPARSE_TAG_SYMLINK, 0);
        invalid_substitute[8..10].copy_from_slice(&1_u16.to_le_bytes());
        assert_eq!(
            parse_symlink_reparse(&invalid_substitute, 64),
            Err(ReparseError::InvalidLength)
        );
    }

    #[test]
    fn target_kind_selection_is_syntactic_and_never_traverses() {
        assert!(symlink_target_is_directory("child-dir", Some("directory")));
        assert!(symlink_target_is_directory(r"..\external\", None));
        assert!(symlink_target_is_directory("../external/", None));
        assert!(!symlink_target_is_directory(r"..\external", None));
    }

    #[test]
    fn identity_swap_fails_exact_postflight() {
        let before = (7_u64, [0x11_u8; 16], "symlink");
        let same = before;
        let swapped = (7_u64, [0x12_u8; 16], "symlink");
        assert!(postflight_identity_matches(&before, &same));
        assert!(!postflight_identity_matches(&before, &swapped));
    }

    #[test]
    fn privilege_or_developer_mode_authorizes_creation() {
        assert!(symlink_creation_authorized(true, false));
        assert!(symlink_creation_authorized(false, true));
        assert!(!symlink_creation_authorized(false, false));
    }

    #[test]
    fn constructed_reparse_round_trips_effective_target_exactly() {
        let target = [b'.' as u16, b'.' as u16, 0xd800, b'x' as u16];
        let bytes = build_symlink_reparse(&target, &target, true).unwrap();
        let expected: Vec<u8> = target.iter().flat_map(|unit| unit.to_le_bytes()).collect();
        assert_eq!(parse_symlink_reparse(&bytes, 64), Ok(expected));
    }

    #[test]
    fn parser_returns_effective_substitute_not_cosmetic_print_name() {
        let substitute: Vec<u16> = r"..\escape".encode_utf16().collect();
        let print: Vec<u16> = "benign".encode_utf16().collect();
        let bytes = build_symlink_reparse(&substitute, &print, true).unwrap();
        let expected: Vec<u8> = substitute
            .iter()
            .flat_map(|unit| unit.to_le_bytes())
            .collect();
        assert_eq!(parse_symlink_reparse(&bytes, 64), Ok(expected));
    }
}
