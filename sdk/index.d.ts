export interface StddCapabilities {
	subagents: boolean;
	crossCli: boolean;
	worktrees: boolean;
}

export interface StddConfig {
	forbiddenArtifacts: string[];
	canonicalDocs: string[];
	temporalPhrases: string[];
	readiness: { required: Array<{ path: string; hint?: string }> };
	contentRules: Array<{
		name: string;
		files: string;
		forbid?: string;
		require?: string;
		message?: string;
		newFilesOnly?: boolean;
	}>;
	capabilities: StddCapabilities;
	review: { via: "subagent" | "codex" | "claude"; maxRounds: number };
	baseRef?: string;
	redPattern?: string | null;
	branchPattern?: string | null;
}

export type StddConfigInput = Partial<Omit<StddConfig, "capabilities" | "review">> & {
	capabilities?: Partial<StddCapabilities>;
	review?: Partial<StddConfig["review"]>;
};

export type DeepReadonly<T> =
	T extends ReadonlyArray<infer Item>
		? ReadonlyArray<DeepReadonly<Item>>
		: T extends object
			? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
			: T;

export const STDD_VERSION: string;
export const DEFAULT_CONFIG: DeepReadonly<StddConfig>;
export function assertSkillName(name: string, label?: string): string;
export function resolveRepoPath(root: string, relative: string, label?: string): string;
export function resolveWritableRepoPath(root: string, relative: string, label?: string): string;
export function deriveLoopState(
	events: Array<Record<string, unknown>>,
	currentSnapshot: string,
	nonDocChanged?: boolean,
): {
	lastRedIdx: number;
	redEvent: Record<string, unknown> | null;
	redLegacy: boolean;
	recordedVerify: Record<string, unknown> | null;
	verifyEvent: Record<string, unknown> | null;
	verifyStale: boolean;
	implementationObserved: boolean;
	loop: {
		red: Record<string, unknown> & { done: boolean };
		impl: { done: boolean };
		verify: Record<string, unknown> & { done: boolean; stale?: boolean };
	};
};
export function mergeConfig(config: StddConfigInput): StddConfig;
export function extractDocPaths(content: string): string[];
export function parseLedger(text: string): Array<Record<string, unknown>>;
export function parsePlan(text: string): {
	items: Array<{
		line: number;
		checked: boolean;
		text: string;
		red: string | null;
		review: boolean;
	}>;
	deferred: string[];
	mode: "inline" | "delegated" | null;
};
export function sha256(content: string | Uint8Array): string;
