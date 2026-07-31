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
    }
}
