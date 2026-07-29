import fs from "node:fs";
import path from "node:path";
import { escapeNonPrintableSingleLine, isPrintableSingleLine } from "../sdk/text.mjs";
import { globToRegExp } from "./lib.mjs";

/**
 * Split a Buffer of NUL-delimited records into per-record Buffers. Git's
 * `-z` output is raw pathname bytes (a path is any byte sequence but NUL),
 * so records must be sliced on the byte, never decoded first.
 */
export function splitNul(buf) {
	const out = [];
	let start = 0;
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] === 0) {
			out.push(buf.subarray(start, i));
			start = i + 1;
		}
	}
	if (start < buf.length) out.push(buf.subarray(start));
	return out;
}

// A git path is arbitrary bytes. Across the review subsystem the byte-exact
// latin1 decode (a bijection: distinct paths never collapse, ASCII structure
// — the `/`, `.md`, directory names a glob keys on — is preserved) is the
// match/dedupe/snapshot key; the UTF-8 view, escaped by displayPath, is what
// a human reads. A glob is source text (Unicode), so it too is encoded to
// its byte form before compiling, or a non-ASCII glob literal (docs/über/**)
// would never match its latin1 pathname.
export const pathForMatch = (buf) => buf.toString("latin1");
export const pathForView = (latin1) => Buffer.from(latin1, "latin1").toString("utf8");
export const latinGlob = (glob) => globToRegExp(Buffer.from(glob, "utf8").toString("latin1"));
export const absPathBuf = (cwd, latin1) =>
	Buffer.concat([Buffer.from(`${cwd}/`), Buffer.from(latin1, "latin1")]);

export function parentPathBuf(absolute) {
	const separator = path.sep.charCodeAt(0);
	const index = absolute.lastIndexOf(separator);
	return index === 0 ? absolute.subarray(0, 1) : absolute.subarray(0, index);
}

export function realPathBuf(value) {
	return fs.realpathSync(value, { encoding: "buffer" });
}

export function bufferPathIsWithin(root, candidate) {
	if (candidate.equals(root)) return true;
	const separator = Buffer.from(path.sep);
	const prefix =
		root.length === separator.length && root.equals(separator) ? root : Buffer.concat([root, separator]);
	return candidate.length > prefix.length && candidate.subarray(0, prefix.length).equals(prefix);
}

// Present a path as a quoted literal whenever it contains syntax or a scalar
// that the shared single-line boundary rejects. Every unsafe scalar is made
// visible, so a filename cannot split, repaint, hide, or reorder the brief.
export function displayPath(p) {
	const escaped = escapeNonPrintableSingleLine(p);
	if (escaped === p && isPrintableSingleLine(p) && !p.includes('"') && !p.includes("\\")) return p;
	let quoted = '"';
	for (const scalar of p) {
		if (scalar === '"' || scalar === "\\") quoted += `\\${scalar}`;
		else quoted += escapeNonPrintableSingleLine(scalar);
	}
	return `${quoted}"`;
}
// The human view of a latin1 (byte-exact) path. A valid-UTF-8 path renders
// as its text; a path that is not valid UTF-8 is shown byte-escaped and
// quoted (`"…\xff.md"`), so distinct invalid byte sequences stay
// distinguishable in the brief instead of both collapsing to U+FFFD.
export function viewPath(latin1) {
	const buf = Buffer.from(latin1, "latin1");
	const utf8 = pathForView(latin1);
	if (Buffer.from(utf8, "utf8").equals(buf)) return displayPath(utf8);
	let out = '"';
	for (const b of buf) {
		if (b === 0x22 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
		else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
		else out += `\\x${b.toString(16).padStart(2, "0")}`;
	}
	return `${out}"`;
}
