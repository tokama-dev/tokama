# claude-code

AI CLI adapter (`claudeCodeAdapter`, in `adapter.ts`, the one export `composition.ts` wires): the CLI's name, login and update commands, minimum version, runtime, health check, launch description, plan windows and session-log reader as one object the engine loops over.

AgentRuntime adapter: runs one headless `claude -p` call per launch through the kernel process runner, stream-json in and out.
Maps the step's tool limits onto Claude Code's own permission flags (never a skip-permissions flag), parses the stream into typed events, and classifies failures (quota, rate limit, auth, crash, timeout).
Also reads the plan windows (the `limits` list, with weekly limits scoped to one model and their share, or else the older fixed windows): Claude Code's own `get_usage` answer from an idle restricted session (version-checked), else the `cachedUsageUtilization` key of `~/.claude.json`, read-only.
Also reads Claude Code's session logs (`~/.claude/projects/**/*.jsonl`) for the usage of every Claude Code call on this machine: only the model, the four token counts, the time and the message id of assistant messages, through fs-safe (real folders only, no links, size caps), from where the last read of each log ended. Message text, tool inputs and tool outputs are dropped as each line is parsed; project folder names leave the reader only as hashes.
Calls that run commands need Claude Code 2.1.315 or newer, checked with `claude --version` before each such call, and run inside Claude Code's own sandbox, switched on in the per-call settings file (never in the user's own settings). The call must carry a `SandboxSpec` and the machine must be able to run the sandbox (on Linux `bwrap` and `socat`), or the call is refused before anything starts. Commands write the working directory, the main repo's shared git data when the working directory is a linked worktree (objects, refs and index, so `git commit` works; the CLI keeps `hooks/` and `config` closed, checked by the real-CLI test), the temp folder and a short list of tool caches (never a folder on the PATH; a cache can hold code that later runs outside the sandbox), cannot read well-known secret files or Tokama's own folder, and reach only the hosts of the spec, with every other host refused in every permission mode. No setting, option or retry runs a command outside the sandbox: the unsandboxed retry is switched off, denied by a rule, and denied by the command hook. If the sandbox cannot start, or stops working during the step, the step fails with that reason.
On Linux the sandbox write-protects `.bashrc`, `.gitconfig`, `.idea` and a few more paths in the working directory by binding `/dev/null` over them, which makes the missing ones: character devices inside the sandbox, where `git add -A` stops on the first. For a linked worktree the call's environment sets `core.excludesFile` (`GIT_CONFIG_*`) to a `tokama-exclude` file in the worktree's own git folder, so the agent's git skips them; the file starts with the engineer's own excludes file (git reads only one), so what they ignore stays ignored. The repo's shared `info/exclude` is not used: it also applies to the engineer's checkout. The worktrees slice removes what a killed call left on the host before it stages.

What limits each tool:

| Tool | Files | Network |
| --- | --- | --- |
| Bash and its children | the sandbox | the sandbox: the spec's hosts only |
| Read, Edit, Write | `--restricted` and the permission rules (working directory only, Tokama's folder denied); not the sandbox | none |
| WebFetch, WebSearch | none | not the sandbox and not the host list: any website, only when the step has web turned on |

Calls without commands start no sandbox and write no settings file.
Must not read Claude Code's credentials or any other of its files, and must not send anything itself: the CLI does the network calls.
Tests run against `testing/fake-claude.ts`, which replays recorded stream-json samples; `TOKAMA_REAL_CLAUDE=1` adds one call to the real CLI.
