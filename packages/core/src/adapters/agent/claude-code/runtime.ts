import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { systemClock, type Clock, type TimerHandle } from "../../../kernel/clock/index.js";
import { replaceTextSync } from "../../../kernel/fs-safe/index.js";
import { buildEnv, createProcessRunner, type ProcessRunner, type RunResult } from "../../../kernel/process/index.js";
import type { AgentCallRequest, AgentRuntime } from "../../../kernel/ports/index.js";
import { checkSandboxSpec, createSandboxSupport, NESTED_BLOCKED_HINT, toolCacheDirs, usableCacheDirs, type SandboxSpec, type SandboxSupport } from "../../../kernel/sandbox/index.js";
import type { AgentCallErrorKind, AgentCallEvent, TokenUsage } from "../../../kernel/schemas/index.js";
import { buildArgs, DEFAULT_TOKAMA_HOME, userMessage, usesShell } from "./args.js";
import { placeholderExcludeEnv } from "./git-exclude.js";
import { hookSettings } from "./permission-hook.js";
import { mentionsSandbox, sandboxSettings, sandboxStartProblem } from "./sandbox.js";
import { classifyFailure, createStreamParser, type StreamParser, type StreamState } from "./stream.js";
import { CLAUDE_CODE_COMMAND } from "./command.js";
import { readClaudeVersion, shellCallsProblem } from "./version.js";

export interface ClaudeCodeOptions {
  /** argv that starts the CLI. Default: `[CLAUDE_CODE_COMMAND]`, found on the allowlisted PATH. */
  readonly command?: readonly [string, ...string[]];
  /** Variables added to the allowlisted environment, e.g. for local-model routing. */
  readonly env?: Readonly<Record<string, string>>;
  readonly runner?: ProcessRunner;
  /** Timers for the stop after a result. Default: the system clock. */
  readonly clock?: Clock;
  /** How long the CLI may keep running after it reported its result. Default: 10 s. */
  readonly resultGraceMs?: number;
  /** argv of the command-policy hook, before the rules file. Default: this Node running hook.js. */
  readonly hookCommand?: readonly [string, ...string[]];
  /** Tokama's own folder, absolute: closed to the agent's commands and file tools. Default: `~/.tokama`. */
  readonly tokamaHome?: string;
  /** Other absolute folders closed to the agent's commands, e.g. the engine's socket and token folder. */
  readonly closedDirs?: readonly string[];
  /** Whether this machine can run Claude Code's sandbox. Default: checked for this OS through `runner`. */
  readonly sandboxSupport?: SandboxSupport;
  /** The OS the sandbox is checked and set up for. Default: this one. */
  readonly platform?: NodeJS.Platform;
}

const NO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const STDERR_LINES = 20;
const ERROR_CHARS = 1_000;
const RESULT_GRACE_MS = 10_000;

/**
 * Drives `claude -p` headless: one call per launch, stream-json in and out. Every request needs
 * `timeoutMs`: the runtime owns the call's timeout and reports it as a run failure. Run it under
 * the execution slice's `agentCliGuardDefaults`, whose timeout is only a backstop.
 */
export function createClaudeCodeRuntime(options: ClaudeCodeOptions = {}): AgentRuntime {
  const command = options.command ?? [CLAUDE_CODE_COMMAND];
  const runner = options.runner ?? createProcessRunner();
  const clock = options.clock ?? systemClock;
  const resultGraceMs = options.resultGraceMs ?? RESULT_GRACE_MS;
  const hookCommand = options.hookCommand ?? [process.execPath, fileURLToPath(new URL("./hook.js", import.meta.url))];
  const platform = options.platform ?? process.platform;
  const sandboxSupport = options.sandboxSupport ?? createSandboxSupport(runner, platform, options.env);
  // The PATH and home the CLI will start with: no cache folder may hold a PATH folder.
  const childEnv = buildEnv(process.env, options.env);
  const pathDirs = (childEnv["PATH"] ?? "").split(delimiter);
  const home = childEnv["HOME"] ?? homedir();
  // A relative path in a permission rule or sandbox list would mean the call's folder.
  const customHome = options.tokamaHome === undefined ? undefined : resolve(options.tokamaHome);
  const tokamaHomeDir = customHome ?? join(home, ".tokama");
  const closedDirs = (options.closedDirs ?? []).map((dir) => resolve(dir));
  const refused = (error: string): EndEvent => ({ type: "end", outcome: "failed", usage: NO_TOKENS, error, errorKind: "crash" });

  return {
    async *launch(request, signal) {
      if (request.timeoutMs === undefined) {
        yield { type: "end", outcome: "failed", usage: NO_TOKENS, error: "a Claude Code call needs timeoutMs", errorKind: "crash" };
        return;
      }
      const timeoutMs = request.timeoutMs;
      // A call that runs commands runs them inside Claude Code's sandbox, or not at all. Calls
      // without the shell have no hook and no sandbox, and need none of these checks.
      let sandbox: SandboxPlan | undefined;
      if (usesShell(request)) {
        if (request.sandbox === undefined) {
          yield refused("Tokama did not give this call a sandbox, so it will not run commands. This is a Tokama bug; please report it.");
          return;
        }
        const checked = checkSandboxSpec(request.sandbox, { cwd: request.cwd, tokamaHome: tokamaHomeDir });
        if (!checked.ok) {
          yield refused(`The sandbox for this step is not valid: ${checked.error}.`);
          return;
        }
        // The version is read on every call: the runtime outlives updates and downgrades of the CLI.
        // An older one ignores or rejects the hook's `onFailure`, so a hook that cannot start would
        // let a command run unchecked, and it lacks the sandbox settings used below.
        const read = await readClaudeVersion({ command, runner, signal, cwd: request.cwd, ...(options.env !== undefined && { env: options.env }) });
        if (read.kind === "aborted") {
          yield { type: "end", outcome: "aborted", usage: NO_TOKENS };
          return;
        }
        const problem = shellCallsProblem(read.kind === "version" ? read.version : undefined, read.kind === "unknown" ? read.why : undefined);
        if (problem !== undefined) {
          yield refused(problem);
          return;
        }
        const support = await sandboxSupport.check(signal);
        if (signal.aborted) {
          yield { type: "end", outcome: "aborted", usage: NO_TOKENS };
          return;
        }
        if (!support.ok) {
          yield refused([support.problem, support.fix, support.fix === undefined ? undefined : "Then retry the step."].filter((part) => part !== undefined).join(" "));
          return;
        }
        sandbox = { spec: checked.value, tokamaHome: customHome ?? DEFAULT_TOKAMA_HOME, closedDirs, cacheDirs: usableCacheDirs(toolCacheDirs(), pathDirs, home) };
      }
      let callDir: string | undefined;
      try {
        callDir = sandbox === undefined ? undefined : writeHookFiles(request, hookCommand, sandbox);
      } catch (error) {
        yield refused(`could not write the call's settings: ${String(error)}`);
        return;
      }
      const args = buildArgs(request, callDir === undefined ? undefined : join(callDir, SETTINGS_FILE), customHome);
      if (!args.ok) {
        if (callDir !== undefined) rmSync(callDir, { recursive: true, force: true });
        yield { type: "end", outcome: "failed", usage: NO_TOKENS, error: args.error, errorKind: "crash" };
        return;
      }
      // The agent's git skips the placeholders the sandbox makes in the worktree.
      const excludeEnv = callDir === undefined ? undefined : await placeholderExcludeEnv(request.cwd, { runner, home, platform, ...(options.env !== undefined && { env: options.env }) });
      const runEnv = excludeEnv === undefined ? options.env : { ...options.env, ...excludeEnv };
      // Stops the call when the caller stops reading, and shortly after a result if the CLI
      // lingers, so the process tree never outlives the call.
      const stop = new AbortController();
      let grace: TimerHandle | undefined;
      const events = eventQueue();
      const parser = createStreamParser(request.cwd);
      const stderr: string[] = [];
      let sandboxStopped = false;
      const onLine = (line: string) => {
        parser.line(line).forEach(events.push);
        const state = parser.state();
        if (grace === undefined && state.result !== undefined) grace = clock.setTimeout(() => stop.abort(), resultGraceMs);
        // Once the sandbox has stopped working every command is refused: the step cannot go on.
        if (!sandboxStopped && state.sandboxFailure !== undefined) {
          sandboxStopped = true;
          stop.abort();
        }
      };
      const run = runner
        .run({
          command: { argv: [...command, ...args.value] },
          cwd: request.cwd,
          ...(runEnv !== undefined && { env: runEnv }),
          stdin: userMessage(request.prompt),
          timeoutMs,
          signal: AbortSignal.any([signal, stop.signal]),
          onSpawn: (pid) => events.push({ type: "started", pid }),
          stdout: { onLine },
          stderr: {
            onLine: (line) => {
              stderr.push(line);
              if (stderr.length > STDERR_LINES) stderr.shift();
            },
          },
        })
        .then(
          (result) => endEvent(result, parser, stderr.join("\n"), signal, timeoutMs, callDir !== undefined),
          (error: unknown) => failed(parser.state(), `the call failed: ${String(error)}`, "crash"),
        )
        .then((end) => {
          events.push(end);
          events.close();
        });
      try {
        yield* events;
      } finally {
        stop.abort();
        await run;
        if (grace !== undefined) clock.clearTimeout(grace);
        if (callDir !== undefined) rmSync(callDir, { recursive: true, force: true });
      }
    },
  };
}

const RULES_FILE = "rules.json";
const SETTINGS_FILE = "settings.json";
const CALL_FILES = [RULES_FILE, SETTINGS_FILE] as const;

/** What the sandbox part of a call's settings is made from, once the call is allowed to run commands. */
interface SandboxPlan {
  readonly spec: SandboxSpec;
  readonly tokamaHome: string;
  readonly closedDirs: readonly string[];
  readonly cacheDirs: readonly string[];
}

/**
 * Writes the hook's settings with the sandbox settings, and the step's command rules, to a new
 * folder outside the worktree, readable by the user only, so the agent cannot change them. The
 * folder is also closed to the sandboxed commands (under its real path too: the temp folder may
 * be reached through a link). Returns the folder.
 */
function writeHookFiles(request: AgentCallRequest, hookCommand: readonly string[], sandbox: SandboxPlan): string {
  const dir = mkdtempSync(join(tmpdir(), "tokama-claude-call-"));
  chmodSync(dir, 0o700);
  const rules = join(dir, RULES_FILE);
  try {
    const callDirs = [...new Set([dir, realpathSync(dir)])];
    const { permissions, sandbox: sandboxPart } = sandboxSettings(sandbox.spec, {
      callDirs,
      callFiles: callDirs.flatMap((callDir) => CALL_FILES.map((name) => join(callDir, name))),
      tokamaHome: sandbox.tokamaHome,
      closedDirs: sandbox.closedDirs,
      cacheDirs: sandbox.cacheDirs,
    });
    const settings = { ...(hookSettings([...hookCommand, rules]) as object), permissions, sandbox: sandboxPart };
    // The record needs a text for every name in CALL_FILES, so no file is written without being closed to reads.
    const texts: Record<(typeof CALL_FILES)[number], string> = {
      [RULES_FILE]: JSON.stringify({ commands: request.limits?.commands ?? [] }),
      [SETTINGS_FILE]: JSON.stringify(settings),
    };
    for (const name of CALL_FILES) {
      const written = replaceTextSync(join(dir, name), texts[name], 0o600);
      if (!written.ok) throw new Error(written.error.message);
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

type EndEvent = Extract<AgentCallEvent, { type: "end" }>;

const UPDATE_CLAUDE = "Update Claude Code (for example with `claude update`), then try again.";

function endEvent(result: RunResult, parser: StreamParser, stderr: string, signal: AbortSignal, timeoutMs: number, sandboxed: boolean): EndEvent {
  const state = parser.state();
  if (result.kind === "not-started") {
    if (result.reason === "aborted") return { type: "end", outcome: "aborted", usage: NO_TOKENS };
    return failed(state, `Claude Code did not start: ${parser.scrub(result.message)}`, "crash");
  }
  const { durationMs } = result;
  // Commands were refused: the step did not do its work, whatever the agent said after that.
  if (state.sandboxFailure !== undefined) {
    // The helper that failed only exists on Linux, where AppArmor is the usual reason.
    const hint = state.sandboxFailure.startsWith("apply-seccomp:") ? ` ${NESTED_BLOCKED_HINT}` : "";
    return failed(state, `Claude Code's sandbox stopped working during the step: ${parser.scrub(state.sandboxFailure)}. Fix that, then retry the step.${hint}`, "crash", durationMs);
  }
  // A result that arrived first wins over a stop or timeout that came after it.
  if (state.result !== undefined) {
    if (!state.result.isError) return { type: "end", outcome: "completed", ...ending(state), durationMs };
    const subtype = state.result.subtype !== undefined && state.result.subtype !== "success" ? state.result.subtype : undefined;
    const words = state.result.text || state.assistantError?.text || stderr.trim();
    const said = subtype === undefined ? words || "Claude Code reported an error" : words ? `${words} (${subtype})` : subtype;
    return failed(state, parser.scrub(said), classifyFailure(state, stderr), durationMs);
  }
  if (result.aborted || signal.aborted) return { type: "end", outcome: "aborted", ...ending(state), durationMs };
  if (result.timedOut) return failed(state, `timed out after ${timeoutMs} ms`, "timeout", durationMs);
  // With `failIfUnavailable` the CLI exits at startup, before any result, when the sandbox cannot start.
  if (sandboxed && mentionsSandbox(stderr)) return failed(state, sandboxStartProblem(parser.scrub(stderr), process.platform), "crash", durationMs);
  // A CLI too old for a flag Tokama passes (`--safe-mode`, `--restricted`) exits at once with this on stderr.
  if (/unknown option/i.test(stderr)) return failed(state, UPDATE_CLAUDE, "crash", durationMs);
  const exit = result.exitCode !== null ? `exit code ${result.exitCode}` : `signal ${result.signal ?? "unknown"}`;
  const said = state.assistantError?.text || stderr.trim() || `Claude Code ended without a result (${exit})`;
  return failed(state, parser.scrub(said), classifyFailure(state, stderr), durationMs);
}

function failed(state: StreamState, error: string, errorKind: AgentCallErrorKind, durationMs?: number): EndEvent {
  return {
    type: "end",
    outcome: "failed",
    ...ending(state),
    error: error.slice(0, ERROR_CHARS),
    errorKind,
    ...(durationMs !== undefined && { durationMs }),
  };
}

function ending(state: StreamState) {
  return {
    usage: state.usage,
    ...(state.modelUsage !== undefined && { modelUsage: state.modelUsage }),
    ...(state.costUsd !== undefined && { costUsd: state.costUsd }),
    ...(state.sessionId !== undefined && { sessionId: state.sessionId }),
  };
}

/** Events pushed from process callbacks, read by the async generator in order. */
function eventQueue() {
  const items: AgentCallEvent[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  return {
    push: (event: AgentCallEvent) => {
      items.push(event);
      notify();
    },
    close: () => {
      closed = true;
      notify();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = items.shift();
        if (next !== undefined) yield next;
        else if (closed) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}
