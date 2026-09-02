# pi-ultra-workflow

A small multi-agent workflow tool for [Pi](https://github.com/earendil-works/pi-coding-agent). One `Workflow` tool
fans a task out to a few read-only child agents across sequential phases, then hands their evidence back to
the main agent.

600 lines for the scheduler, 111 for the child boundary. It deliberately has no background mode, no locks and
no resume.

## Why

OpenAI's "Ultra" is not a reasoning effort above `max` — it is `max` plus deciding when to split work across
parallel subagents. Sending `--thinking ultra` does nothing. This plugin supplies the second half: the model
orchestration, with the deterministic phase structure of Claude Code's Dynamic Workflows.

## Install

Requires Pi 0.84+ and a provider that serves the model in `MODEL` (default `openai-codex/gpt-5.6-sol`).

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
- A task's `dependsOn` defaults to every task in the previous phase. Fan-in is not width-limited.
- The last phase of a multi-phase run gets `max` effort plus Fast. Everything else gets `high`.
- `shell: true` grants read-only shell access to that task. Off by default.
- The call blocks until the run finishes and returns one report. Cancel by interrupting the tool call.
- A per-run journal lands in `~/.pi/agent/ultra-workflow/runs/<run-id>.json`.

Defaults: 8 tasks, 4 phases, 3 concurrent, 300 s per task, 250 000 tokens per run.

## Child boundary

Children get `read`, `grep`, `find`, `ls` — and `bash` only when the task asks for it. `child-guard.ts` enforces:

- paths must resolve inside the workspace, and never into `.git`, `.ssh`, `.env`, `*.pem`, `auth.json` and friends
- `grep` patterns that hunt for credentials are refused
- shell commands must be one plain command: no `;`, `&&`, `|`, `` ` ``, `$(...)`, redirection or escapes
- the command must start with one of `git rg ls wc head tail nl stat diff pytest python3 python node cargo npm make jq`,
  and `git` only with a read-only subcommand
- flags that run code from outside the workspace (`-c`, `-e`, `-m`, `-p`, `--require`, `--exec-path`, aggregated
  short forms) are refused

**This is a guard against accidents and against injection from repository content. It is not a sandbox** —
children run as the same user, and they are allowed to run the project's own scripts (`npm run`, `make`,
`python3 script.py`), which is the whole point of `shell: true`.

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

1. `maxTotalTokens` is a dispatch gate plus in-flight accounting, not a hard cap. A task already dispatched
   runs to completion, so the real ceiling is roughly the budget plus one round per concurrent child.
2. Pi ships no web or fetch tool, so children cannot search the web. Literature and web work stays in the
   main agent.
3. The shell allowlist is not a sandbox (see above).
4. Long runs occupy the Pi session, since the call is synchronous.
5. `MODEL` is a constant. Multi-model runs need an edit.

## Tests

No dependencies, no network, no API calls.

```bash
node tests/verify.mjs          # 77 checks: loading, tool contract, planner, guard boundaries
node tests/harness/cli.js      # 28 checks: real spawns via a stub child (~45s, includes a 30s deadline)
```

`tests/harness/cli.js` is named `cli.js` on purpose: the scheduler re-invokes `process.argv[1]` and only
accepts a Pi-looking entrypoint, so the harness gets spawned as the child too and can emit real NDJSON events
without touching a provider. Set `PI_ROOT` if `pi` is not on `PATH`.

## License

MIT
