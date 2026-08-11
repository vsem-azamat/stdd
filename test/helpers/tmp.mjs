import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Fixtures live in os.tmpdir(), which on Linux is usually tmpfs — RAM, not
// disk. A suite that creates them and never removes them costs nothing on a
// single run and everything on the tenth: ten full runs left 7374 directories
// and 7GB resident, after which the native filesystem helper began failing
// writes with EDQUOT and hundreds of unrelated cases went red. Registering
// each fixture for removal keeps the failure from ever being about the
// machine.
const created = [];
let armed = false;

/**
 * Create a fixture directory under os.tmpdir() that is removed when this test
 * process exits. Node's test runner gives each file its own process, so the
 * handler is per-file and runs after every case in it has finished.
 */
export function makeTempDir(prefix) {
	if (!armed) {
		armed = true;
		// 'exit' only — the handler must be synchronous, and a fixture left
		// behind by a crash is the lesser problem.
		process.on("exit", () => {
			for (const directory of created) {
				try {
					fs.rmSync(directory, { recursive: true, force: true });
				} catch {
					// A test that made its fixture unwritable on purpose keeps it.
					// Cleanup is hygiene, never a reason to fail a green run.
				}
			}
		});
	}
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	created.push(directory);
	return directory;
}
