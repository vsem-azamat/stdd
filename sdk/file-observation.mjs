export function sameFileIdentity(left, right) {
	return left?.dev === right?.dev && left?.ino === right?.ino;
}

export function sameFileObservation(left, right) {
	return ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(
		(field) =>
			typeof left?.[field] === "bigint" &&
			typeof right?.[field] === "bigint" &&
			left[field] === right[field],
	);
}
