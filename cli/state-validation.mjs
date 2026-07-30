// Structural predicates shared by every durable state document stdd writes:
// the session ledger, the managed-worker metadata, and the install manifest.
import { isPrintableSingleLine } from "../sdk/text.mjs";

export const MANIFEST_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function isPlainLedgerRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isLedgerStringArray(value) {
	return Array.isArray(value) && value.every(isPrintableSingleLine);
}
