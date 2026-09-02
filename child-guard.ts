import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Boundary for Workflow child agents. This is a guard against accidents and
 * prompt injection in repository content, not a sandbox: the child runs as the
 * same user. Pi's `--tools` allowlist is the first line; this hook is the second.
 */

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

// `.git` is here for its config remote URLs, which can carry tokens. Only paths
// pointing into it are refused; a plain grep of the repository root still works,
// which is what the removed directory pre-scan used to break.
const SECRET_SEGMENTS = new Set([".git", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".pi", ".codex"]);
const SECRET_FILES = new Set([
	".envrc", ".git-credentials", ".netrc", ".npmrc", ".pypirc",
	"auth.json", "credentials", "credentials.json", "models.json",
	"id_dsa", "id_ecdsa", "id_ed25519", "id_rsa",
]);
const SAFE_ENV_FILES = new Set([".env.example", ".env.sample", ".env.template"]);
const CREDENTIAL_PATTERN = /\b(api[_-]?keys?|secrets?|passwords?|passwd|tokens?|credentials?|private[_-]?keys?|bearer)\b/i;

// Compound commands, command substitution, redirection and escapes are refused
// outright; that single rule removes most of the ways an allowlist gets bypassed.
const SHELL_METACHARACTERS = /[;&|`$(){}<>\n\r\\]/;
const ALLOWED_COMMANDS = new Set([
	"git", "rg", "ls", "wc", "head", "tail", "nl", "stat", "diff",
	"pytest", "python3", "python", "node", "cargo", "npm", "make", "jq",
]);
const GIT_READONLY = new Set(["blame", "branch", "describe", "diff", "log", "ls-files", "rev-parse", "shortlog", "show", "status", "tag"]);
// The line to hold: a child may run code that lives in the workspace, never code
// named on the command line (-c, -e) and never code from outside it (-m, -p,
// --require, --exec-path). `=value` and aggregated short forms are covered too.
const BANNED_FLAGS = /^--?(c|e|m|p|exec|execdir|delete|ok|eval|module|require|import|plugin|exec-path|inplace|in-place)(=|$)/;
const AGGREGATED_SHORT_FLAGS = /^-[a-z]{2,}$/i;

function isSecretName(name: string): boolean {
	const lower = name.toLowerCase();
	if (SECRET_SEGMENTS.has(lower) || SECRET_FILES.has(lower)) return true;
	if (lower.endsWith(".pem") || lower.endsWith(".key")) return true;
	return lower === ".env" || (lower.startsWith(".env.") && !SAFE_ENV_FILES.has(lower));
}

function checkPath(rawPath: string, root: string): string | undefined {
	let candidate = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	if (candidate === "~" || candidate.startsWith(`~${sep}`)) candidate = join(homedir(), candidate.slice(1));
	let target = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
	// Resolve symlinks: a link that lives in the workspace must not be a way out of it.
	try {
		target = realpathSync.native(target);
	} catch {
		// The path does not exist yet; the lexical form is all there is to check.
	}
	const rel = relative(root, target);
	if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) return `path leaves the workspace: ${rawPath}`;
	if (rel.split(sep).some(isSecretName)) return `path is protected: ${rawPath}`;
	return undefined;
}

function checkCommand(command: string, root: string): string | undefined {
	const trimmed = command.trim();
	if (!trimmed) return "empty command";
	if (SHELL_METACHARACTERS.test(trimmed)) {
		return "compound commands, substitution, redirection and escapes are not allowed; run one plain command";
	}
	const tokens = trimmed.split(/\s+/);
	const [head, ...rest] = tokens;
	if (!ALLOWED_COMMANDS.has(head)) {
		return `"${head}" is not in the read-only command allowlist (${[...ALLOWED_COMMANDS].sort().join(", ")})`;
	}
	if (head === "git" && !GIT_READONLY.has(rest[0] ?? "")) {
		return `git must start with a read-only subcommand (${[...GIT_READONLY].join(", ")})`;
	}
	for (const token of rest) {
		if (BANNED_FLAGS.test(token)) return `flag "${token}" can execute code from outside the workspace`;
		if (AGGREGATED_SHORT_FLAGS.test(token) && /[cemp]/i.test(token)) return `aggregated flag "${token}" may execute code`;
		if (token.startsWith("-")) continue;
		if (token.includes("..")) return `path traversal in "${token}"`;
		if (token.includes("/") || token.startsWith(".")) {
			const problem = checkPath(token.replace(/^["']|["']$/g, ""), root);
			if (problem) return problem;
		}
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
		// `grep`, `find` and `ls` default to the workspace root when path is absent.
		if (input.path === undefined) return undefined;
		if (typeof input.path !== "string") return { block: true, reason: "Tool path must be a string." };
		const problem = checkPath(input.path, root);
		return problem ? { block: true, reason: problem } : undefined;
	});
}
