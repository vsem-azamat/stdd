// PRIVACY.md tells users that installing either published package fetches
// nothing beyond the package itself. Two manifests carry that promise and two
// test files own them — the root package's in repository-config, the bundle's in
// plugin — so the lists they check live here once. A gap added to a copied list
// would otherwise let a script or dependency through on the side nobody edited.

/**
 * Every manifest field npm can install a package from. `workspaces` is here
 * because a manifest declaring it is a workspace root, which changes how npm
 * resolves and installs the tree beneath it; neither published package is one,
 * and neither should quietly become one.
 */
export const INSTALLABLE_FIELDS = Object.freeze([
	"dependencies",
	"optionalDependencies",
	"peerDependencies",
	"bundleDependencies",
	"bundledDependencies",
	"workspaces",
]);

/**
 * The events npm can fire while installing a package: the install itself,
 * `dependencies` when the install changes the dependency tree, the prepare and
 * pack hooks a git-spec install triggers, and the legacy `prepublish`.
 *
 * One more install script needs no key at all: npm synthesizes `node-gyp
 * rebuild` for a package whose root carries `binding.gyp` and declares no
 * install script, which is why callers also assert that file's absence.
 */
const INSTALL_EVENTS = ["install", "dependencies", "prepare", "prepublish", "pack"];

/**
 * Every script key those events can run. npm wraps each event in `pre` and
 * `post` variants, so the names are derived rather than listed: a hand-written
 * list is how `predependencies` came to be missing once already.
 */
export const INSTALL_LIFECYCLE = Object.freeze(
	INSTALL_EVENTS.flatMap((event) => [`pre${event}`, event, `post${event}`]),
);
