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

export function isReviewInodeIdentity(value) {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).sort().join(",") === "dev,ino,mode,nlink,uid" &&
		["dev", "ino", "uid", "mode", "nlink"].every((field) => /^(?:0|[1-9][0-9]*)$/.test(value[field]))
	);
}

export function sameReviewPrivateState(left, right) {
	if (
		typeof left !== "object" ||
		left === null ||
		typeof right !== "object" ||
		right === null ||
		Object.keys(left).sort().join(",") !== "artifacts,directory,tempRoot,version" ||
		Object.keys(right).sort().join(",") !== "artifacts,directory,tempRoot,version" ||
		left.version !== 1 ||
		right.version !== 1 ||
		!isReviewInodeIdentity(left.tempRoot) ||
		!isReviewInodeIdentity(right.tempRoot) ||
		!isReviewInodeIdentity(left.directory) ||
		!isReviewInodeIdentity(right.directory) ||
		["tempRoot", "directory"].some((identity) =>
			["dev", "ino", "uid", "mode", "nlink"].some(
				(field) => left[identity][field] !== right[identity][field],
			),
		)
	) {
		return false;
	}
	const leftArtifacts = left.artifacts;
	const rightArtifacts = right.artifacts;
	if (
		typeof leftArtifacts !== "object" ||
		leftArtifacts === null ||
		Array.isArray(leftArtifacts) ||
		typeof rightArtifacts !== "object" ||
		rightArtifacts === null ||
		Array.isArray(rightArtifacts)
	) {
		return false;
	}
	const leftNames = Object.keys(leftArtifacts).sort();
	const rightNames = Object.keys(rightArtifacts).sort();
	if (
		leftNames.length !== rightNames.length ||
		leftNames.some((name, index) => name !== rightNames[index])
	) {
		return false;
	}
	return leftNames.every(
		(name) =>
			isReviewInodeIdentity(leftArtifacts[name]) &&
			isReviewInodeIdentity(rightArtifacts[name]) &&
			["dev", "ino", "uid", "mode", "nlink"].every(
				(field) => leftArtifacts[name][field] === rightArtifacts[name][field],
			),
	);
}
