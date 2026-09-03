# pi-ultra-workflow

A small multi-agent workflow tool for [Pi](https://github.com/earendil-works/pi-coding-agent). One `Workflow` tool
fans a task out to a few read-only child agents across sequential phases, then hands their evidence back to
the main agent.

826 lines for the scheduler, 224 for the child boundary. It deliberately has no background mode, no locks and
no resume.

## Why

OpenAI's "Ultra" is not a reasoning effort above `max` — it is `max` plus deciding when to split work across
parallel subagents. Sending `--thinking ultra` does nothing. This plugin supplies the second half: the model
orchestration, with the deterministic phase structure of Claude Code's Dynamic Workflows.

## Install

Requires Pi 0.84+ and a provider that serves the model in `MODEL` (default `openai-codex/gpt-5.6-sol`).
Background delivery needs a TUI session; every other host (`--print`, RPC, JSON) silently gets the foreground,
since those do not outlive the tool call.

```bash
git clone https://github.com/HaokaiDing/pi-ultra-workflow
mkdir -p ~/.pi/agent/extensions
cp -r pi-ultra-workflow ~/.pi/agent/extensions/ultra-workflow
```

Pi discovers `extensions/<dir>/index.ts` automatically and loads TypeScript directly through jiti — there is
nothing to build. `child-guard.ts` is not auto-loaded; the scheduler passes it to each child with `--extension`.

To use a different model, change `MODEL` at the top of `index.ts`. `codex-fast.ts`, if you have it in
`~/.pi/agent/extensions/`, is injected into the synthesis task only; it is optional.

## Use

The main agent calls one tool:

```jsonc
{
  "objective": "why does the retry path drop the last event",
  "phases": [
    { "name": "scout", "tasks": [
      { "id": "queue",  "prompt": "trace the retry queue implementation, cite paths and lines" },
      { "id": "tests",  "prompt": "run the retry tests and report what actually fails", "shell": true }
    ]},
    { "name": "verdict", "tasks": [
      { "id": "answer", "prompt": "name the root cause and the one-line fix" }
    ]}
  ]
}
```

- Phases run in order; tasks inside a phase run concurrently, at most 3 at once.
- Each task is told the objective, its own scope, what its siblings own, and the answer shape to return —
  the four things Anthropic's multi-agent write-up names as the fix for workers duplicating each other's work.
- A task's `dependsOn` defaults to every task in the previous phase. Fan-in is not width-limited.
- The last phase of a multi-phase run defaults to `max` effort plus Fast; everything else defaults to `high`.
  An explicit per-task `effort` overrides the default.
- `shell: true` grants read-only shell access to that task. Off by default.
- **The call returns immediately and the report is delivered when the run finishes.** Start it, then do other
  work — do not poll. Pass `background: false` to block instead. Only a TUI session gets background delivery:
  `hasUI` is also true in RPC, where the client can stop as soon as the turn settles and the report would be
  thrown away, so the run mode is what decides.
- A per-run journal lands in `~/.pi/agent/ultra-workflow/runs/<run-id>.json`.

Defaults: 8 tasks, 4 phases, 3 concurrent, 300 s per task, 80 000 tokens per task, 250 000 per run.

Any project directory works. A marker (`.git`, `package.json`, `pyproject.toml`, `Makefile`, …) at or above the
directory settles it; failing that, any directory nested at least two levels under Home counts, since plenty of
real projects are just a folder of files. Refused: Home itself; a directory that only holds other projects (`Documents`, `Downloads`, …) unless it
carries a marker of its own; credential and config directories (`.ssh`, `.aws`, `.config`, `.docker`, …);
anything under `~/Library`, which holds application and cloud data rather than projects; and — outside Home —
anything without a marker, where an empty `.pi-workflow-root` file opts it in.

## Child boundary

Children get `read`, `grep`, `find`, `ls` — and `bash` only when the task asks for it. `child-guard.ts` enforces:

- paths must resolve inside the workspace, and never into `.git`, `.ssh`, `.env`, `*.pem`, `auth.json` and friends
- `grep` must name a single file: it searches recursively, so a directory scope would return the contents
  of protected files under it. Use `find` to locate candidates first
- a path that does not resolve is refused for the file tools, since Pi retries NFD and curly-quote variants and
  an unresolved name can still open a different, existing file
- `grep` patterns that hunt for credentials are refused
- shell commands must be one plain command: no `;`, `&&`, `|`, `` ` ``, `$(...)`, redirection, escapes or globs
  (glob expansion happens after the check, so `head *.pem` would smuggle a protected name past it)
- the command must start with one of `git rg ls wc head tail nl stat diff pytest python3 python node cargo npm make jq`
- `git` only with a read-only subcommand — `branch` and `tag` are excluded because they write refs
- `npm` and `cargo` only with a listed subcommand, so `npm publish`, `npm install` and `cargo install` are refused
- a `git` revision spec may not point at a protected file (`git show HEAD:.env`)
- flag policy is per command, because the same letter means different things: `python -c` runs code but
  `head -c` counts bytes, `python -m` names a module but `pytest -m` selects a marker, `pytest -p` loads a
  plugin but `git log -p` shows a patch. Refused are the ones that make an interpreter run code named on the
  command line (`python -c/-m`, `node -e/-r/--loader`, `pytest -p/--pyargs`, `rg --pre`, `git --exec-path`,
  `make --eval`) plus clustered short forms hiding those letters
- destination flags (`--output`, `--out-file`, …) are refused outright, and the **value** of any flag gets the
  same path check as a bare argument (`--output=/tmp/x`, `-f/etc/passwd`)

For the file tools, every accepted path is rewritten in place as a canonical absolute path — resolving `~`,
`@`, `file://` URLs, Unicode spaces and symlinks first. Pi's own resolver is idempotent on such a path, so
the file Pi opens is exactly the one that passed the check. This part is tested against escaping symlinks,
URL forms and protected names.

**The shell policy is a coarse filter, and it is not a sandbox.** An independent review enumerated command
forms it still lets through — a bare protected filename (`head id_rsa`), shell quote concatenation
(`head '.''env'`), symlink-following options (`rg --follow`, `ls -LR`), external program hooks
(`git log --textconv`, `git diff --ext-diff`, `make SHELL=…`), and writer options on otherwise-read-only
subcommands (`cargo clippy --fix`). A per-option blocklist cannot close that space: every command has dozens
of options and some of them always reach outside. Closing it properly needs a fixed set of parameterised
command templates instead of free-form commands, which is not implemented yet.

What this means in practice: `shell: true` is appropriate for auditing **your own** code, where the child is
your own agent reading your own repository and reporting back to you. Do not point it at code you do not
trust. The default (`shell: false`) does not have this exposure — those children only get the file tools.

## Design trade-offs

Things this deliberately does not do, because each one costs more than it returns for a 10–30 minute read-only
audit that can simply be re-run:

| Not implemented | Instead |
| --- | --- |
| Background execution | The tool call blocks; interrupt it to cancel |
| Cross-process locks, PID liveness | One run per Pi session, tracked in memory |
| Pause / resume / restart | Re-run it; the journal records what happened |
| State schema versioning | The journal is a log, never an input |
| Concurrency ramp-up | Fixed `min(taskCount, 3)` |
| Overflow artifacts on disk | Oversized answers are trimmed inline and labelled |
| Per-call approval prompts | Children are read-only by construction |

Behavioural choices worth knowing:

- **A failed task is an evidence gap, not a dead run.** Siblings keep going, later phases still run, and the
  report names every gap. Only a wholly failed phase stops the run.
- **Oversized output is trimmed and flagged**, never treated as failure.
- **Deadlines are per task**, so a late phase cannot starve on a budget the first phase spent.

## Known limitations

1. `maxTotalTokens` is a dispatch gate, not a hard cap — concurrent workers all clear it before any of them
   has reported usage. `maxTokensPerTask` (default 80 000) is the enforceable one: a task that reaches it is cut
   off and its partial answer kept. Worst case is roughly the per-task ceiling times the concurrency. Token
   counts sum each response's `totalTokens`, which includes `cacheRead`, so a cached prefix is counted once per
   request — the figure overstates billed cost and errs toward stopping early.
2. Pi ships no web or fetch tool, so children cannot search the web. Literature and web work stays in the
   main agent.
3. The shell policy is a coarse filter with known gaps, not a boundary you can lean on for untrusted code
   (see "Child boundary"). `shell: false` children are unaffected.
4. Long runs occupy the Pi session, since the call is synchronous.
5. `MODEL` is a constant. Multi-model runs need an edit.
6. `git log -p` and `git show` print the contents of files as they exist in history, including ones the
   secret-name rules protect. Do not commit credentials; the guard cannot un-commit them.
7. macOS and Linux only. Process-group kills, `detached` spawning and the path checks are POSIX-shaped, so the
   tool refuses to start on Windows rather than pretending to enforce its boundary there.

## Tests

No dependencies, no network, no API calls.

```bash
node tests/verify.mjs          # 135 checks: loading, tool contract, planner, guard boundaries
node tests/harness/cli.js      # 72 checks: real spawns via a stub child (~85s, includes a 30s deadline)
```

`tests/harness/cli.js` is named `cli.js` on purpose: the scheduler re-invokes `process.argv[1]` and only
accepts a Pi-looking entrypoint, so the harness gets spawned as the child too and can emit real NDJSON events
without touching a provider. Set `PI_ROOT` if `pi` is not on `PATH`.

## License

MIT
