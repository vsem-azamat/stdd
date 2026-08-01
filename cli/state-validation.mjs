// Structural predicates shared by every durable state document stdd writes:
// the session ledger, the managed-worker metadata, and the install manifest.
import path from "node:path";
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

const REVIEW_PORTABLE_IDENTITY_FIELDS = ["fileId", "kind", "platform", "version", "volume"];
const REVIEW_PORTABLE_OBSERVATION_FIELDS = ["identity", "linkCount", "owner", "permissions"];

function exactObjectFields(value, fields) {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).sort().join(",") === [...fields].sort().join(",")
	);
}

function unsignedDecimal(value) {
	return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}

function normalizedReviewTempRootPath(value, platform) {
	if (typeof value !== "string" || !["linux", "darwin", "win32"].includes(platform)) return null;
	const pathApi = platform === "win32" ? path.win32 : path.posix;
	if (!pathApi.isAbsolute(value)) return null;
	let normalized = pathApi.normalize(value);
	if (platform === "win32") {
		normalized = normalized.replace(/^([a-z]):/u, (_, drive) => `${drive.toUpperCase()}:`);
	}
	return value === normalized ? normalized : null;
}

function isReviewPortableObservation(value, kind, privateRequired = true) {
	if (!exactObjectFields(value, REVIEW_PORTABLE_OBSERVATION_FIELDS)) return false;
	const identity = value.identity;
	if (
		!exactObjectFields(identity, REVIEW_PORTABLE_IDENTITY_FIELDS) ||
		identity.version !== 2 ||
		!["linux", "darwin", "win32"].includes(identity.platform) ||
		identity.kind !== kind ||
		!unsignedDecimal(identity.volume) ||
		!(identity.platform === "win32"
			? typeof identity.fileId === "string" && /^[0-9a-f]{32}$/.test(identity.fileId)
			: unsignedDecimal(identity.fileId)) ||
		!unsignedDecimal(value.linkCount)
	) {
		return false;
	}
	return identity.platform === "win32"
		? typeof value.owner === "string" &&
				/^S-(?:[0-9]+-)+[0-9]+$/.test(value.owner) &&
				(privateRequired
					? /^O:([^:]+)D:P\(A;;FA;;;\1\)\(A;;FA;;;SY\)\(A;;FA;;;BA\)$/.test(value.permissions)
					: value.permissions.startsWith("O:") && value.permissions.includes("D:"))
		: unsignedDecimal(value.owner) && unsignedDecimal(value.permissions);
}

function sameReviewPortableObservation(left, right, kind, privateRequired = true) {
	return (
		isReviewPortableObservation(left, kind, privateRequired) &&
		isReviewPortableObservation(right, kind, privateRequired) &&
		REVIEW_PORTABLE_OBSERVATION_FIELDS.every((field) =>
			field === "identity"
				? REVIEW_PORTABLE_IDENTITY_FIELDS.every(
						(identityField) => left.identity[identityField] === right.identity[identityField],
					)
				: left[field] === right[field],
		)
	);
}

export function sameReviewPrivateState(left, right) {
	const leftFields =
		left?.version === 2
			? "artifacts,directory,tempRoot,tempRootPath,version"
			: "artifacts,directory,tempRoot,version";
	const rightFields =
		right?.version === 2
			? "artifacts,directory,tempRoot,tempRootPath,version"
			: "artifacts,directory,tempRoot,version";
	if (
		typeof left !== "object" ||
		left === null ||
		typeof right !== "object" ||
		right === null ||
		Object.keys(left).sort().join(",") !== leftFields ||
		Object.keys(right).sort().join(",") !== rightFields ||
		left.version !== right.version ||
		![1, 2].includes(left.version) ||
		typeof left.artifacts !== "object" ||
		left.artifacts === null ||
		Array.isArray(left.artifacts) ||
		typeof right.artifacts !== "object" ||
		right.artifacts === null ||
		Array.isArray(right.artifacts)
	) {
		return false;
	}
	if (left.version === 2) {
		if (
			left.tempRoot?.identity?.platform !== right.tempRoot?.identity?.platform ||
			normalizedReviewTempRootPath(left.tempRootPath, left.tempRoot?.identity?.platform) === null ||
			normalizedReviewTempRootPath(right.tempRootPath, right.tempRoot?.identity?.platform) === null ||
			left.tempRootPath !== right.tempRootPath ||
			!sameReviewPortableObservation(left.tempRoot, right.tempRoot, "directory", false) ||
			!sameReviewPortableObservation(left.directory, right.directory, "directory")
		) {
			return false;
		}
	} else if (
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
	const leftDirectoryOwner = left.version === 2 ? left.directory.owner : left.directory.uid;
	const rightDirectoryOwner = right.version === 2 ? right.directory.owner : right.directory.uid;
	const leftNames = Object.keys(leftArtifacts).sort();
	const rightNames = Object.keys(rightArtifacts).sort();
	if (
		leftNames.length !== rightNames.length ||
		leftNames.some((name, index) => name !== rightNames[index])
	) {
		return false;
	}
	return leftNames.every((name) =>
		left.version === 2
			? leftArtifacts[name]?.owner === leftDirectoryOwner &&
				rightArtifacts[name]?.owner === rightDirectoryOwner &&
				sameReviewPortableObservation(leftArtifacts[name], rightArtifacts[name], "file")
			: isReviewInodeIdentity(leftArtifacts[name]) &&
				isReviewInodeIdentity(rightArtifacts[name]) &&
				leftArtifacts[name].uid === leftDirectoryOwner &&
				rightArtifacts[name].uid === rightDirectoryOwner &&
				["dev", "ino", "uid", "mode", "nlink"].every(
					(field) => leftArtifacts[name][field] === rightArtifacts[name][field],
				),
	);
}
