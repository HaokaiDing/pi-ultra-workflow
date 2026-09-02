/**
 * Offline verification for the slimmed ultra-workflow plugin.
 * Loads the extension through Pi's own loader (real jiti + alias config) and
 * exercises the guard and the planner. Never spawns a child, never hits an LLM.
 */
import { mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Locate the installed pi-coding-agent package without hardcoding a prefix. */
function resolvePiRoot() {
	if (process.env.PI_ROOT) return process.env.PI_ROOT;
	const launcher = execSync("command -v pi", { encoding: "utf8" }).trim();
	let dir = dirname(realpathSync(launcher));
	for (let depth = 0; depth < 8; depth++) {
		if (existsSync(join(dir, "dist", "core", "extensions", "loader.js"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("Cannot locate @earendil-works/pi-coding-agent; set PI_ROOT.");
}

const PI = resolvePiRoot();
const EXT = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = join(tmpdir(), "ultra-workflow-tests");
const PROJ = join(TMP, "static");

rmSync(PROJ, { recursive: true, force: true });
mkdirSync(join(PROJ, "src"), { recursive: true });
mkdirSync(join(PROJ, ".git"), { recursive: true });
mkdirSync(join(PROJ, "scripts"), { recursive: true });
writeFileSync(join(PROJ, "package.json"), "{}\n");
writeFileSync(join(PROJ, "src", "a.ts"), "export const a = 1;\n");
writeFileSync(join(PROJ, ".env"), "SECRET=1\n");
writeFileSync(join(PROJ, "secrets.pem"), "x\n");
writeFileSync(join(PROJ, "scripts", "check.py"), "print(1)\n");

// A directory with no project marker anywhere above it inside the temp root.
// A link that lives inside the workspace but points out of it, plus a benign one.
symlinkSync("/etc", join(PROJ, "escape"), "dir");
symlinkSync(join(PROJ, "src"), join(PROJ, "src-link"), "dir");

const NOMARKER = join(TMP, "nomarker", "deep");
rmSync(join(TMP, "nomarker"), { recursive: true, force: true });
mkdirSync(NOMARKER, { recursive: true });

const results = [];
const record = (name, pass, detail = "") => results.push({ name, pass, detail });

// ---------- 1. Load index.ts through Pi's real loader ----------
const { loadExtensions } = await import(`${PI}/dist/core/extensions/loader.js`);
const loaded = await loadExtensions([join(EXT, "index.ts")], PROJ);
record("index.ts loads with 0 loader errors", loaded.errors.length === 0, JSON.stringify(loaded.errors.map((e) => String(e.error))));

const extension = loaded.extensions[0];
const toolNames = [...(extension?.tools?.keys() ?? [])];
record("registers exactly 1 tool", toolNames.length === 1, `got ${toolNames.length}: ${toolNames.join(",")}`);
record("tool is named Workflow", toolNames[0] === "Workflow", String(toolNames[0]));
const tool = extension?.tools?.get("Workflow")?.definition;
record("tool has a typebox schema", Boolean(tool?.parameters), typeof tool?.parameters);
record("tool runs sequentially", tool?.executionMode === "sequential", String(tool?.executionMode));
record("registers no slash command", (extension?.commands?.size ?? 0) === 0, String(extension?.commands?.size));

// ---------- 2. Planner and workspace rejections (no child is spawned) ----------
const ctx = { cwd: PROJ, hasUI: false };
const task = (id, dependsOn) => ({ id, prompt: `do ${id}`, ...(dependsOn ? { dependsOn } : {}) });
const call = async (input, useCtx = ctx) => {
	try {
		await tool.execute("t1", input, undefined, undefined, useCtx);
		return "ACCEPTED";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
};

const rejections = [
	["single task rejected", { objective: "o", phases: [{ name: "p", tasks: [task("a")] }] }, /adds nothing/],
	["over 8 tasks rejected", { objective: "o", phases: [{ name: "p", tasks: Array.from({ length: 9 }, (_, i) => task(`t${i}`)) }] }, /limit is 8/],
	["duplicate id rejected", { objective: "o", phases: [{ name: "p", tasks: [task("a"), task("a")] }] }, /Duplicate task id/],
	["forward dependency rejected", { objective: "o", phases: [{ name: "p", tasks: [task("a", ["zz"]), task("b")] }] }, /not in an earlier phase/],
	["bad id rejected", { objective: "o", phases: [{ name: "p", tasks: [task("-bad"), task("b")] }] }, /Invalid task id/],
];
for (const [name, input, pattern] of rejections) {
	const message = await call(input);
	record(name, pattern.test(message), message.slice(0, 120));
}

const plan2 = { objective: "o", phases: [{ name: "p", tasks: [task("a"), task("b")] }] };

// A valid plan must refuse to spawn when the host is not Pi: this is the
// anti-recursion guard. It also keeps this verifier from re-executing itself.
const spawnGuard = await call(plan2);
record("non-Pi host cannot spawn children", /is not a Pi entrypoint/.test(spawnGuard), spawnGuard.slice(0, 120));

for (const [name, cwd, pattern] of [
	["Home workspace rejected", homedir(), /Home or an ancestor/],
	["credential dir rejected", join(homedir(), ".pi", "agent"), /protected config or credential/],
	["unmarked dir rejected", NOMARKER, /project marker/],
]) {
	const message = await call(plan2, { cwd, hasUI: false });
	record(name, pattern.test(message), message.slice(0, 120));
}

// ---------- 3. Guard boundaries ----------
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { moduleCache: false });
const guardFactory = await jiti.import(join(EXT, "child-guard.ts"), { default: true });
let handler;
guardFactory({ on: (event, fn) => { if (event === "tool_call") handler = fn; } });
record("guard registers a tool_call handler", typeof handler === "function", typeof handler);

const guardCases = [
	// [label, toolName, input, shellEnv, expectBlocked]
	["read inside workspace", "read", { path: "src/a.ts" }, false, false],
	["grep with default path", "grep", { pattern: "foo" }, false, false],
	["grep in subdir", "grep", { pattern: "foo", path: "src" }, false, false],
	["ls workspace root", "ls", { path: "." }, false, false],
	["read escaping workspace", "read", { path: "../outside" }, false, true],
	["read ssh key via tilde", "read", { path: "~/.ssh/id_rsa" }, false, true],
	["read dotenv", "read", { path: ".env" }, false, true],
	["read pem", "read", { path: "secrets.pem" }, false, true],
	["read .env.example allowed", "read", { path: ".env.example" }, false, false],
	["grep for api_key", "grep", { pattern: "api_key" }, false, true],
	["grep for password", "grep", { pattern: "hardcoded password" }, false, true],
	["write tool", "write", { path: "src/a.ts", content: "x" }, false, true],
	["edit tool", "edit", { path: "src/a.ts" }, false, true],
	["bash without shell grant", "bash", { command: "git log" }, false, true],
	["git log allowed", "bash", { command: "git log --oneline -20" }, true, false],
	["git diff allowed", "bash", { command: "git diff HEAD" }, true, false],
	["git status allowed", "bash", { command: "git status" }, true, false],
	["pytest allowed", "bash", { command: "pytest tests -x -q" }, true, false],
	["rg allowed", "bash", { command: 'rg "TODO" src/' }, true, false],
	["wc allowed", "bash", { command: "wc -l src/a.ts" }, true, false],
	["project script allowed", "bash", { command: "python3 scripts/check.py" }, true, false],
	["git push blocked", "bash", { command: "git push origin main" }, true, true],
	["git commit blocked", "bash", { command: "git commit -m x" }, true, true],
	["git config blocked", "bash", { command: "git config user.name x" }, true, true],
	["rm blocked", "bash", { command: "rm -rf src" }, true, true],
	["cat blocked", "bash", { command: "cat /etc/passwd" }, true, true],
	["curl blocked", "bash", { command: "curl http://example.com" }, true, true],
	["chained command blocked", "bash", { command: "git log; rm -rf /" }, true, true],
	["and-chained blocked", "bash", { command: "git log && rm -rf /" }, true, true],
	["pipe blocked", "bash", { command: "git log | sh" }, true, true],
	["substitution blocked", "bash", { command: "git log $(whoami)" }, true, true],
	["backtick blocked", "bash", { command: "git log `whoami`" }, true, true],
	["redirect blocked", "bash", { command: "git log > out.txt" }, true, true],
	["inline python blocked", "bash", { command: 'python3 -c "import os"' }, true, true],
	["node eval blocked", "bash", { command: "node -e 1+1" }, true, true],
	["find exec blocked", "bash", { command: "find . -exec rm {} +" }, true, true],
	["sh -c blocked", "bash", { command: "sh -c ls" }, true, true],
	["sudo blocked", "bash", { command: "sudo ls" }, true, true],
	["env prefix blocked", "bash", { command: "env FOO=1 git log" }, true, true],
	["traversal arg blocked", "bash", { command: "git diff ../../other" }, true, true],
	["absolute outside path blocked", "bash", { command: "wc -l /etc/hosts" }, true, true],
	["sed inplace blocked", "bash", { command: "sed -i s/a/b/ src/a.ts" }, true, true],
	["powershell without grant", "powershell", { command: "ls" }, false, true],
	["symlink escaping workspace blocked", "read", { path: "escape/hosts" }, false, true],
	["symlink dir escaping workspace blocked", "grep", { pattern: "root", path: "escape" }, false, true],
	["internal symlink still allowed", "read", { path: "src-link/a.ts" }, false, false],
	["shell arg via escaping symlink blocked", "bash", { command: "wc -l escape/hosts" }, true, true],
	["python -m module blocked", "bash", { command: "python3 -m http.server" }, true, true],
	["python -m pip blocked", "bash", { command: "python3 -m pip install x" }, true, true],
	["node --require blocked", "bash", { command: "node --require hook.js app.js" }, true, true],
	["eval with equals blocked", "bash", { command: "node --eval=1+1" }, true, true],
	["pytest -p plugin blocked", "bash", { command: "pytest -p evilplugin tests" }, true, true],
	["aggregated short flags blocked", "bash", { command: "python3 -ic script.py" }, true, true],
	["git exec-path blocked", "bash", { command: "git --exec-path=/tmp log" }, true, true],
	["git global flag before subcommand blocked", "bash", { command: "git --no-pager log" }, true, true],
	["uv no longer allowed", "bash", { command: "uv run script.py" }, true, true],
	["safe aggregated flags allowed", "bash", { command: "pytest -xq tests" }, true, false],
	["head -n allowed", "bash", { command: "head -n 20 src/a.ts" }, true, false],
	["node script allowed", "bash", { command: "node scripts/check.js" }, true, false],
	["npm run allowed", "bash", { command: "npm run test" }, true, false],
	["uppercase env variant blocked", "read", { path: ".ENV" }, false, true],
	["uppercase key variant blocked", "read", { path: "ID_RSA" }, false, true],
	["nested dotenv blocked", "read", { path: "src/.env" }, false, true],
	["nested git dir blocked", "read", { path: ".git/config" }, false, true],
];

for (const [label, toolName, input, shellEnv, expectBlocked] of guardCases) {
	if (shellEnv) process.env.PI_ULTRA_WORKFLOW_SHELL = "1";
	else delete process.env.PI_ULTRA_WORKFLOW_SHELL;
	let verdict;
	try {
		verdict = handler({ toolName, input: { ...input } }, { cwd: PROJ });
	} catch (error) {
		verdict = { block: true, reason: `threw: ${error instanceof Error ? error.message : String(error)}` };
	}
	const blocked = verdict?.block === true;
	record(`guard: ${label}`, blocked === expectBlocked, blocked ? `blocked — ${verdict.reason}`.slice(0, 110) : "allowed");
}

// ---------- 4. Path canonicalization is applied in place ----------
delete process.env.PI_ULTRA_WORKFLOW_SHELL;
const mutable = { path: "src/a.ts" };
handler({ toolName: "read", input: mutable }, { cwd: PROJ });
record("guard leaves a valid relative path usable", typeof mutable.path === "string", mutable.path);

// ---------- Report ----------
const failed = results.filter((r) => !r.pass);
for (const r of results) if (!r.pass) console.log(`FAIL  ${r.name}  → ${r.detail}`);
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length }, null, 1));
process.exit(failed.length === 0 ? 0 : 1);
