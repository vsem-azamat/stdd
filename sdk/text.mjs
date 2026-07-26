/** Shared boundary for identifiers and inline text that may reach logs or generated files. */
const CONTROL_OR_SEPARATOR = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;

// Fixed instead of `\p{Cf}`: join controls, variation selectors, emoji tags,
// and visible script formatting remain valid ordinary Unicode.
const INVISIBLE_FORMAT_CONTROL =
	/(?:\u00ad|\u034f|\u180e|\u200b|[\u2060-\u206f]|\ufeff|[\ufff9-\ufffb]|[\u{1bca0}-\u{1bcaf}]|[\u{1d173}-\u{1d17a}]|\u{e0001})/u;

export function isPrintableSingleLine(value) {
	return (
		typeof value === "string" &&
		value.trim() !== "" &&
		!CONTROL_OR_SEPARATOR.test(value) &&
		!INVISIBLE_FORMAT_CONTROL.test(value)
	);
}

export function assertPrintableSingleLine(value, label = "value") {
	if (!isPrintableSingleLine(value)) {
		throw new TypeError(`${label} must be a non-empty single printable line`);
	}
	return value;
}
