import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Boundary for Workflow child agents. This is a guard against accidents and
 * against prompt injection in repository content, not a sandbox: the child runs
 * as the same user. Pi's `--tools` allowlist is the first line; this is the second.
 *
 * The rule that makes it work: every accepted path is rewritten in place as a
 * canonical absolute path. Pi's own resolver is idempotent on those, so what Pi
 * opens is exactly what passed the check here.
 */

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

// `.git` is listed for its config remote URLs, which can carry tokens. Only paths
// pointing into it are refused; a plain grep of the repository root still works.
const SECRET_SEGMENTS = new Set([".git", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".pi", ".codex"]);
const SECRET_FILES = new Set([
	".envrc", ".git-credentials", ".netrc", ".npmrc", ".pypirc",
	"auth.json", "credentials", "credentials.json", "models.json",
	"id_dsa", "id_ecdsa", "id_ed25519", "id_rsa",
]);
const SAFE_ENV_FILES = new Set([".env.example", ".env.sample", ".env.template"]);
const CREDENTIAL_PATTERN = /\b(api[_-]?keys?|secrets?|passwords?|passwd|tokens?|credentials?|private[_-]?keys?|bearer)\b/i;

// Mirrors Pi's own normalisation (dist/utils/paths.js): the guard has to see the
// same path Pi will open, or the check means nothing.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

// Compound commands, substitution, redirection, escapes — and globs, whose
// expansion happens after this check and would smuggle protected filenames past
// the secret-name test. Children already have grep/find/ls for pattern matching.
const SHELL_METACHARACTERS = /[;&|`$(){}<>\n\r\\*?[\]]/;
const ALLOWED_COMMANDS = new Set([
	"git", "rg", "ls", "wc", "head", "tail", "nl", "stat", "diff",
	"pytest", "python3", "python", "node", "cargo", "npm", "make", "jq",
]);
// `branch` and `tag` are writers despite reading like queries.
const GIT_READONLY = new Set(["blame", "describe", "diff", "log", "ls-files", "rev-parse", "shortlog", "show", "status"]);
// Commands whose first argument decides whether anything is installed, published
// or executed. Anything not listed here is refused.
const SUBCOMMAND_ALLOWLIST: Record<string, Set<string>> = {
	// `view` and `outdated` query the registry, which would hand a child the network
	// access Pi otherwise denies it. Build and test commands may still fetch
	// dependencies — that is inherent to running the project's own tooling.
	npm: new Set(["run", "test", "ls"]),
	cargo: new Set(["build", "check", "clippy", "run", "test", "tree", "metadata"]),
};

// Destination flags, dangerous whatever the command.
const BANNED_FLAGS = /^--(output|output-dir|out-dir|out-file)(=|$)/;

// Everything else is per-command: `-c` executes code for python but counts bytes
// for head, `-m` selects a module for python but a marker for pytest, `-p` loads a
// plugin for pytest but shows a patch for git. A single global blocklist would
// either miss the dangerous ones or break the ordinary ones.
const COMMAND_BANNED_FLAGS: Record<string, RegExp> = {
	python: /^-[cm]$|^--(command|module)(=|$)/,
	python3: /^-[cm]$|^--(command|module)(=|$)/,
	node: /^-[epr]$|^--(eval|print|require|import|loader|experimental-loader|experimental-import|experimental-network-imports)(=|$)/,
	pytest: /^-p$|^--(plugin|pyargs)(=|$)/,
	rg: /^--(pre|pre-glob|hostname-bin)(=|$)/,
	git: /^--exec-path(=|$)/,
	make: /^--eval(=|$)/,
};
// Clustered short flags can hide a dangerous letter, but only for the commands
// where those letters mean "execute".
const CLUSTERED_RISK: Record<string, RegExp> = {
	python: /[cm]/,
	python3: /[cm]/,
	node: /[epr]/,
	pytest: /p/,
};
const CLUSTERED_SHORT_FLAG = /^-[a-z]{2,}$/i;

function isSecretName(name: string): boolean {
	const lower = name.toLowerCase();
	if (SECRET_SEGMENTS.has(lower) || SECRET_FILES.has(lower)) return true;
	if (lower.endsWith(".pem") || lower.endsWith(".key")) return true;
	return lower === ".env" || (lower.startsWith(".env.") && !SAFE_ENV_FILES.has(lower));
}

/** Apply exactly the transforms Pi applies before it opens a path. */
function normalizeLikePi(rawPath: string): string {
	let candidate = rawPath.replace(UNICODE_SPACES, " ");
	if (candidate.startsWith("@")) candidate = candidate.slice(1);
	if (candidate === "~") return homedir();
	if (candidate.startsWith(`~${sep}`)) return join(homedir(), candidate.slice(2));
	if (/^file:\/\//i.test(candidate)) {
		try {
			return fileURLToPath(candidate);
		} catch {
			return candidate;
		}
	}
	return candidate;
}

/**
 * `requireResolve` separates the two callers. A file tool's path is about to be
 * opened by Pi, which retries NFD and curly-quote variants, so a name that does
 * not resolve must be refused outright. A shell argument is different: plenty of
 * legitimate ones never exist on disk — a git revision spec, an output file, a
 * directory pytest will create — so there the lexical containment check stands.
 */
function checkPath(rawPath: string, root: string, requireResolve: boolean): { problem?: string; target: string } {
	const normalized = normalizeLikePi(rawPath);
	let target = isAbsolute(normalized) ? resolve(normalized) : resolve(root, normalized);
	// Resolve symlinks: a link that lives in the workspace must not be a way out of
	// it. A path that does not resolve is refused rather than checked lexically —
	// Pi's read tool retries NFD and curly-quote variants, so an unresolved name can
	// still open a different, existing file that this check never saw.
	try {
		target = realpathSync.native(target);
	} catch {
		if (requireResolve) return { problem: `path does not resolve: ${rawPath}`, target };
	}
	const rel = relative(root, target);
	if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
		return { problem: `path leaves the workspace: ${rawPath}`, target };
	}
	if (rel.split(sep).some(isSecretName)) return { problem: `path is protected: ${rawPath}`, target };
	return { target };
}

/** The value carried by `--flag=value` or a clustered `-fvalue`. */
function flagValue(token: string): string | undefined {
	const equals = token.indexOf("=");
	if (equals > 0) return token.slice(equals + 1);
	const clustered = /^-[A-Za-z](.+)$/.exec(token);
	return clustered?.[1];
}

function checkCommand(command: string, root: string): string | undefined {
	const trimmed = command.trim();
	if (!trimmed) return "empty command";
	if (SHELL_METACHARACTERS.test(trimmed)) {
		return "compound commands, substitution, redirection, escapes and globs are not allowed; run one plain command";
	}
	const [head, ...rest] = trimmed.split(/\s+/);
	if (!ALLOWED_COMMANDS.has(head)) {
		return `"${head}" is not in the read-only command allowlist (${[...ALLOWED_COMMANDS].sort().join(", ")})`;
	}
	if (head === "git" && !GIT_READONLY.has(rest[0] ?? "")) {
		return `git must start with a read-only subcommand (${[...GIT_READONLY].join(", ")})`;
	}
	const subcommands = SUBCOMMAND_ALLOWLIST[head];
	if (subcommands && !subcommands.has(rest[0] ?? "")) {
		return `${head} subcommand must be one of ${[...subcommands].join(", ")}`;
	}
	const commandFlags = COMMAND_BANNED_FLAGS[head];
	const clusteredRisk = CLUSTERED_RISK[head];
	for (const token of rest) {
		if (BANNED_FLAGS.test(token)) return `flag "${token}" writes outside the workspace`;
		if (commandFlags?.test(token)) return `flag "${token}" makes ${head} run code from outside the workspace`;
		if (clusteredRisk && CLUSTERED_SHORT_FLAG.test(token) && clusteredRisk.test(token.slice(1))) {
			return `clustered flag "${token}" may make ${head} execute code`;
		}
		// A revision spec such as `HEAD:.env` reads a protected file out of history.
		const colon = token.indexOf(":");
		if (colon >= 0 && !token.startsWith("-")) {
			const revisionPath = token.slice(colon + 1);
			if (revisionPath.split("/").some(isSecretName)) return `revision path is protected: ${token}`;
		}
		// Options carry paths too, so their values get the same treatment. Every
		// candidate is checked, with no shape test first: a bare `plain.txt` looks
		// like nothing special and can still be a symlink pointing out of the
		// workspace. Names that are not paths at all resolve inside the workspace and
		// pass harmlessly.
		const candidate = token.startsWith("-") ? flagValue(token) : token;
		if (candidate === undefined) continue;
		if (candidate.includes("..")) return `path traversal in "${token}"`;
		const { problem } = checkPath(candidate.replace(/^["']|["']$/g, ""), root, false);
		if (problem) return problem;
	}
	return undefined;
}

export default function childGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => {
		let root = resolve(ctx.cwd);
		try {
			root = realpathSync.native(root);
		} catch {
			return { block: true, reason: `Workspace does not resolve: ${ctx.cwd}` };
		}

		if (event.toolName === "bash" || event.toolName === "powershell") {
			if (process.env.PI_ULTRA_WORKFLOW_SHELL !== "1") {
				return { block: true, reason: "This workflow task has no shell access." };
			}
			const command = (event.input as { command?: unknown }).command;
			if (typeof command !== "string") return { block: true, reason: "Shell command must be a string." };
			const problem = checkCommand(command, root);
			return problem ? { block: true, reason: problem } : undefined;
		}

		if (!READ_TOOLS.has(event.toolName)) {
			return { block: true, reason: `Workflow children cannot use "${event.toolName}".` };
		}

		const input = event.input as { path?: unknown; pattern?: unknown };
		if (event.toolName === "grep" && typeof input.pattern === "string" && CREDENTIAL_PATTERN.test(input.pattern)) {
			return { block: true, reason: "Searching for credentials is not allowed." };
		}
		// `grep` searches recursively, so checking only the search root would let a
		// generic pattern return the contents of a protected descendant. Its scope is
		// therefore restricted to a single file. `find` and `ls` list names without
		// reading contents, so they may still default to the workspace root.
		if (input.path === undefined) {
			return event.toolName === "grep"
				? { block: true, reason: "grep must name a single file; use find to locate candidates first." }
				: undefined;
		}
		if (typeof input.path !== "string") return { block: true, reason: "Tool path must be a string." };
		const { problem, target } = checkPath(input.path, root, true);
		if (problem) return { block: true, reason: problem };
		if (event.toolName === "grep") {
			let directory = false;
			try {
				directory = statSync(target).isDirectory();
			} catch {
				return { block: true, reason: `grep target does not resolve: ${input.path}` };
			}
			if (directory) {
				return { block: true, reason: "grep must name a single file, since a directory search would read protected files under it; use find to locate candidates first." };
			}
		}
		// Hand Pi the canonical path that just passed, so no later normalisation
		// step can turn it into a different file.
		input.path = target;
		return undefined;
	});
}
