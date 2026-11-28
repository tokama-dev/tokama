import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "../../../kernel/clock/index.js";
import { createProcessRunner, type ProcessRunner } from "../../../kernel/process/index.js";
import type { AgentCallRequest, AgentRuntime } from "../../../kernel/ports/index.js";
import { describeAgentRuntimeContract } from "../../../kernel/ports/testing/contracts.js";
import type { AgentCallEvent } from "../../../kernel/schemas/index.js";
import { BWRAP_BLOCKED_HINT, createSandboxSupport, NESTED_BLOCKED_HINT, type SandboxSupport } from "../../../kernel/sandbox/index.js";
import { createClaudeCodeRuntime, type ClaudeCodeOptions } from "./index.js";

// Runs the adapter against testing/fake-claude.ts through the real process runner. Kill cases
// ported from ai-pipeline tests/test_claude_call.py (timeout, stop, background tools).

const SLOW = { timeout: 20_000 };
const FAKE = join(import.meta.dirname, "testing", "fake-claude.ts");
// bubblewrap is not on every CI machine, and the fake CLI starts no sandbox.
const SUPPORTED: SandboxSupport = { check: async () => ({ ok: true }) };
const runtime = (env?: Record<string, string>, extra: Partial<ClaudeCodeOptions> = {}): AgentRuntime =>
  createClaudeCodeRuntime({
    command: [process.execPath, FAKE],
    // A short grace keeps the stop tests fast.
    runner: createProcessRunner({ killGraceMs: 200, drainMs: 500 }),
    sandboxSupport: SUPPORTED,
    ...(env !== undefined && { env }),
    ...extra,
  });

let dir: string;
const tracked: number[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tokama-claude-"));
});
afterEach(() => {
  for (const pid of tracked.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const request = (prompt: string, extra: Partial<AgentCallRequest> = {}): AgentCallRequest => ({
  model: "claude-haiku-5-5",
  prompt,
  cwd: dir,
  timeoutMs: 60_000,
  sandbox: { writableRoot: dir, readOnlyRoots: [], network: { allow: ["registry.npmjs.org"], unlisted: "deny" } },
  ...extra,
});
const withoutSandbox = (prompt: string, extra: Partial<AgentCallRequest> = {}): AgentCallRequest => ({ model: "claude-haiku-5-5", prompt, cwd: dir, timeoutMs: 60_000, ...extra });

async function collect(stream: AsyncIterable<AgentCallEvent>): Promise<AgentCallEvent[]> {
  const events: AgentCallEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function end(events: AgentCallEvent[]): Extract<AgentCallEvent, { type: "end" }> {
  const last = events.at(-1);
  if (last?.type !== "end") throw new Error(`no end event in ${JSON.stringify(events)}`);
  return last;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (isAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} is still running`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describeAgentRuntimeContract("claude-code", () => ({
  runtime: runtime(),
  completing: request("success"),
  failing: request("crash"),
  hanging: request("hang"),
}));

describe("Claude Code runtime", SLOW, () => {
  it("starts with the pid, streams the events, and ends with usage, session id and wall time", async () => {
    const events = await collect(runtime().launch(request("success"), new AbortController().signal));
    const [started] = events;
    expect(started?.type).toBe("started");
    expect(events.map((event) => event.type)).toEqual(["started", "rate_limit", "turn", "text", "tool_call", "tool_result", "turn", "text", "tool_call", "tool_result", "turn", "text", "end"]);
    expect(end(events)).toEqual({
      type: "end",
      outcome: "completed",
      usage: { input: 5440, output: 213, cacheRead: 10831, cacheWrite: 0 },
      modelUsage: { "qwen3-coder:30b": { input: 5440, output: 213, cacheRead: 10831, cacheWrite: 0 } },
      costUsd: expect.closeTo(0.0281862, 6),
      sessionId: "d4bc8b9c-641c-40df-bc38-952463fb9366",
      durationMs: expect.any(Number),
    });
  });

  it("runs in the given cwd with the prompt on stdin, the flags, and the allowlisted environment", async () => {
    const events = await collect(
      runtime({ EXTRA_VAR: "1" }).launch(request("echo", { role: "You review code.", limits: { edit: true, commands: ["npm test:*"], web: false } }), new AbortController().signal),
    );
    const said = events.find((event) => event.type === "text");
    if (said?.type !== "text") throw new Error("no text event");
    const echo = JSON.parse(said.text) as { argv: string[]; cwd: string; env: string[]; settings?: { mode: number; text: string; outside: boolean } };
    expect(echo.cwd).toMatch(new RegExp(`${dir.split("/").at(-1) ?? ""}$`));
    expect(echo.argv).toContain("--model=claude-haiku-5-5");
    expect(echo.argv).toContain("Bash(npm test:*)");
    expect(echo.argv).toContain("--append-system-prompt=You review code.");
    expect(echo.env).toContain("EXTRA_VAR");
    // The hook settings sit in a folder of their own outside the worktree, readable by the user only.
    expect(echo.settings).toMatchObject({ mode: 0o700, outside: true });
    expect(JSON.parse(echo.settings?.text ?? "{}")).toMatchObject({
      hooks: { PreToolUse: [{ matcher: "Bash" }] },
      permissions: { deny: ["Bash(dangerouslyDisableSandbox:true)"] },
      sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: ["registry.npmjs.org"], strictAllowlist: true } },
    });
    expect(echo.env).not.toContain("SSH_AUTH_SOCK");
    expect(echo.env.every((name) => ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM", "EXTRA_VAR", "__CF_USER_TEXT_ENCODING"].includes(name))).toBe(true);
  });

  describe("the exclude for the sandbox's placeholders", () => {
    const envNames = async (extra: Partial<ClaudeCodeOptions>, call: Partial<AgentCallRequest>) => {
      const events = await collect(runtime(undefined, extra).launch(request("echo", { limits: { edit: true, commands: ["npm test:*"], web: false }, ...call, sandbox: { writableRoot: call.cwd ?? dir, readOnlyRoots: [], network: { allow: [], unlisted: "deny" } } }), new AbortController().signal));
      const said = events.find((event) => event.type === "text");
      if (said?.type !== "text") throw new Error("no text event");
      return (JSON.parse(said.text) as { env: string[] }).env;
    };
    // A linked worktree of a repo inside the temp folder; returns its path.
    const linked = () => {
      const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" });
      const main = join(dir, "main");
      mkdirSync(main);
      git(main, "init", "-q", "-b", "main");
      git(main, "commit", "-q", "--allow-empty", "-m", "seed");
      git(main, "worktree", "add", "-q", "-b", "item", join(dir, "item"));
      return { cwd: join(dir, "item"), exclude: join(main, ".git", "worktrees", "item", "tokama-exclude") };
    };

    it("is passed to a sandboxed call in a linked worktree on Linux", SLOW, async () => {
      const { cwd, exclude } = linked();
      expect(await envNames({ platform: "linux" }, { cwd })).toContain("GIT_CONFIG_VALUE_0");
      expect(existsSync(exclude)).toBe(true);
    });

    it("is not passed on macOS, or to a call without the shell", SLOW, async () => {
      const { cwd, exclude } = linked();
      expect(await envNames({ platform: "darwin" }, { cwd })).not.toContain("GIT_CONFIG_COUNT");
      expect(await envNames({ platform: "linux" }, { cwd, limits: { edit: true, commands: [], web: false } })).not.toContain("GIT_CONFIG_COUNT");
      expect(existsSync(exclude)).toBe(false);
    });
  });

  it.each([
    ["logged-out", "auth", "Not logged in · Please run /login"],
    ["quota", "quota", "You've hit your limit · resets 3pm"],
    ["rate-limited", "rate_limit", "API Error: 529 Overloaded. Please try again later."],
  ] as const)("classifies the %s sample as a %s failure", async (prompt, errorKind, error) => {
    const result = end(await collect(runtime().launch(request(prompt), new AbortController().signal)));
    expect(result).toMatchObject({ outcome: "failed", errorKind, error });
    expect(result.sessionId).toEqual(expect.any(String));
  });

  it("reports a crash with stderr when there is no result, and partial usage from the messages", async () => {
    expect(end(await collect(runtime().launch(request("crash"), new AbortController().signal)))).toMatchObject({
      outcome: "failed",
      errorKind: "crash",
      error: "Error: something broke",
    });
    expect(end(await collect(runtime().launch(request("execution-error"), new AbortController().signal)))).toMatchObject({
      outcome: "failed",
      errorKind: "crash",
      usage: { input: 120, output: 30, cacheRead: 1000, cacheWrite: 50 },
    });
  });

  it("tells the person to update a CLI that does not know a flag Tokama passes", async () => {
    expect(end(await collect(runtime().launch(request("unknown-option", { plain: true }), new AbortController().signal)))).toMatchObject({
      outcome: "failed",
      errorKind: "crash",
      error: "Update Claude Code (for example with `claude update`), then try again.",
    });
  });

  it("refuses a plain call that may run commands before anything is spawned", async () => {
    const events = await collect(runtime().launch(request("success", { plain: true, limits: { edit: false, commands: ["npm test:*"], web: false } }), new AbortController().signal));
    expect(events.map((event) => event.type)).toEqual(["end"]);
    expect(end(events)).toMatchObject({ outcome: "failed", errorKind: "crash", error: "a plain call cannot be allowed to run commands" });
  });

  it("reports a CLI that does not start as a crash", async () => {
    const missing = createClaudeCodeRuntime({ command: [join(dir, "no-such-claude")] });
    expect(end(await collect(missing.launch(request("success"), new AbortController().signal)))).toMatchObject({
      outcome: "failed",
      errorKind: "crash",
      error: expect.stringContaining("Claude Code did not start"),
    });
  });

  describe("the version gate for calls with command rules", () => {
    const withCommands = { limits: { edit: false, commands: ["npm test:*"], web: false } };
    const launch = (env: Record<string, string>, extra: Partial<AgentCallRequest>) => collect(runtime(env).launch(request("echo", extra), new AbortController().signal));
    const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    it("refuses a version below 2.1.315 before anything is spawned", async () => {
      const events = await launch({ FAKE_CLAUDE_VERSION: "2.1.314 (Claude Code)" }, withCommands);
      expect(events).toEqual([{ type: "end", outcome: "failed", usage: NO_TOKENS, errorKind: "crash", error: expect.stringMatching(/2\.1\.315.*sandbox.*2\.1\.314/) }]);
    });

    it("runs 2.1.315, with the hook and sandbox settings", async () => {
      const events = await launch({ FAKE_CLAUDE_VERSION: "2.1.315" }, withCommands);
      expect(end(events).outcome).toBe("completed");
      expect(events.find((event) => event.type === "text")).toMatchObject({ text: expect.stringContaining("--settings=") });
    });

    it("does not gate a call without command rules", async () => {
      const events = await launch({ FAKE_CLAUDE_VERSION: "2.1.294" }, { limits: { edit: false, commands: [], web: false } });
      expect(end(events).outcome).toBe("completed");
    });

    it("gives a call without command rules no sandbox settings, no settings file and no support check", async () => {
      let checks = 0;
      const counting: SandboxSupport = { check: async () => (checks++, { ok: true }) };
      const events = await collect(runtime(undefined, { sandboxSupport: counting }).launch(request("echo", { limits: { edit: true, commands: [], web: false } }), new AbortController().signal));
      const said = events.find((event) => event.type === "text");
      if (said?.type !== "text") throw new Error("no text event");
      expect((JSON.parse(said.text) as { settings?: unknown }).settings).toBeUndefined();
      expect(said.text).not.toContain("sandbox");
      expect(checks).toBe(0);
    });

    it.each([
      ["garbage", "printed no version"],
      ["exit-3", "exited with code 3"],
    ])("fails closed when `claude --version` says %s", async (version, why) => {
      const events = await launch({ FAKE_CLAUDE_VERSION: version }, withCommands);
      expect(end(events)).toMatchObject({ outcome: "failed", errorKind: "crash", error: expect.stringContaining(why) });
      expect(events).toHaveLength(1);
    });

    it("fails closed when the CLI does not start", async () => {
      const missing = createClaudeCodeRuntime({ command: [join(dir, "no-such-claude")], sandboxSupport: SUPPORTED });
      const events = await collect(missing.launch(request("echo", withCommands), new AbortController().signal));
      expect(events).toHaveLength(1);
      expect(end(events)).toMatchObject({
        outcome: "failed",
        errorKind: "crash",
        error: expect.stringContaining("could not read the Claude Code version (`claude --version` did not start)"),
      });
    });

    it("probes in the folder of the call, and starts nothing else when the call was cancelled before it started", async () => {
      const base = createProcessRunner({ killGraceMs: 200, drainMs: 500 });
      const seen: Array<{ argv: readonly string[]; cwd: string }> = [];
      const runner: ProcessRunner = {
        run: (run) => {
          seen.push({ argv: "argv" in run.command ? run.command.argv : [], cwd: run.cwd });
          return base.run(run);
        },
      };
      const probed = createClaudeCodeRuntime({ command: [process.execPath, FAKE], runner, sandboxSupport: SUPPORTED });
      const stopped = new AbortController();
      stopped.abort();
      expect(await collect(probed.launch(request("echo", withCommands), stopped.signal))).toEqual([{ type: "end", outcome: "aborted", usage: NO_TOKENS }]);
      expect(seen).toEqual([{ argv: [process.execPath, FAKE, "--version"], cwd: dir }]);
    });
  });

  describe("the sandbox for calls that run commands", () => {
    const withCommands = { limits: { edit: false, commands: ["npm test:*"], web: false } };
    /** A runner that records every argv before starting it. */
    function recording() {
      const base = createProcessRunner({ killGraceMs: 200, drainMs: 500 });
      const seen: string[][] = [];
      const runner: ProcessRunner = {
        run: (run) => {
          seen.push("argv" in run.command ? [...run.command.argv] : []);
          return base.run(run);
        },
      };
      return { runner, seen };
    }
    const launch = (options: Partial<ClaudeCodeOptions>, call: AgentCallRequest) =>
      collect(createClaudeCodeRuntime({ command: [process.execPath, FAKE], sandboxSupport: SUPPORTED, ...options }).launch(call, new AbortController().signal));

    it("refuses a call that runs commands without a sandbox, before any process starts", async () => {
      const { runner, seen } = recording();
      const events = await launch({ runner }, withoutSandbox("echo", withCommands));
      expect(end(events)).toMatchObject({ outcome: "failed", errorKind: "crash", error: expect.stringContaining("did not give this call a sandbox") });
      expect(events).toHaveLength(1);
      expect(seen).toEqual([]);
    });

    it("refuses an invalid sandbox, before any process starts", async () => {
      const { runner, seen } = recording();
      const events = await launch({ runner }, request("echo", { ...withCommands, sandbox: { writableRoot: join(dir, "elsewhere"), readOnlyRoots: [], network: { allow: [], unlisted: "deny" } } }));
      expect(end(events)).toMatchObject({ outcome: "failed", error: expect.stringMatching(/^The sandbox for this step is not valid: .*folder the call runs in/) });
      expect(seen).toEqual([]);
      const home = await launch({ runner, tokamaHome: dir }, request("echo", withCommands));
      expect(end(home)).toMatchObject({ outcome: "failed", error: expect.stringContaining("Tokama's own folder is closed to agents") });
      const host = await launch({ runner }, request("echo", { ...withCommands, sandbox: { writableRoot: dir, readOnlyRoots: [], network: { allow: ["*"], unlisted: "deny" } } }));
      expect(end(host)).toMatchObject({ outcome: "failed", error: expect.stringContaining("not a host name") });
      expect(seen).toEqual([]);
    });

    it("refuses when the machine cannot run the sandbox, and starts no call", async () => {
      const { runner, seen } = recording();
      const unsupported: SandboxSupport = { check: async () => ({ ok: false, problem: "bwrap is missing.", fix: "Install it." }) };
      const events = await launch({ runner, sandboxSupport: unsupported }, request("echo", withCommands));
      expect(end(events)).toMatchObject({ outcome: "failed", errorKind: "crash", error: "bwrap is missing. Install it. Then retry the step." });
      expect(seen).toEqual([[process.execPath, FAKE, "--version"]]);
      const windows: SandboxSupport = { check: async () => ({ ok: false, problem: "No sandbox here." }) };
      expect(end(await launch({ sandboxSupport: windows }, request("echo", withCommands)))).toMatchObject({ error: "No sandbox here." });
    });

    it("refuses the step with the AppArmor fix when bubblewrap starts but is blocked", async () => {
      const { runner, seen } = recording();
      const toolRunner: ProcessRunner = {
        run: async (call) => {
          const blocked = "argv" in call.command && call.command.argv.includes("--unshare-user");
          return { kind: "finished", pid: 2, exitCode: blocked ? 1 : 0, signal: null, timedOut: false, aborted: false, startedAt: 0, endedAt: 0, durationMs: 0 };
        },
      };
      const events = await launch({ runner, sandboxSupport: createSandboxSupport(toolRunner, "linux") }, request("echo", withCommands));
      expect(end(events)).toMatchObject({ outcome: "failed", errorKind: "crash", error: expect.stringContaining("installed but blocked") });
      expect(end(events)).toMatchObject({ error: expect.stringContaining(BWRAP_BLOCKED_HINT) });
      expect(seen).toEqual([[process.execPath, FAKE, "--version"]]);
    });

    it("ends as aborted, not as a refusal, when the call is stopped during the support check", async () => {
      const stopped = new AbortController();
      const slow: SandboxSupport = { check: async () => (stopped.abort(), { ok: false, problem: "not started" }) };
      const events = await collect(createClaudeCodeRuntime({ command: [process.execPath, FAKE], sandboxSupport: slow }).launch(request("echo", withCommands), stopped.signal));
      expect(end(events)).toMatchObject({ outcome: "aborted" });
    });

    it("gives the CLI the sandbox settings, closes the folder holding them, and deletes it after the call", async () => {
      const tokamaHome = join(tmpdir(), "tokama-home-259-sample");
      const events = await launch({ tokamaHome }, request("echo", withCommands));
      const said = events.find((event) => event.type === "text");
      if (said?.type !== "text") throw new Error("no text event");
      const echo = JSON.parse(said.text) as { argv: string[]; settings: { text: string } };
      const settings = JSON.parse(echo.settings.text) as { sandbox: { filesystem: { denyRead: string[]; denyWrite: string[] } } };
      const folder = (echo.argv.find((arg) => arg.startsWith("--settings=")) ?? "").slice("--settings=".length).replace(/\/settings\.json$/, "");
      expect(folder).not.toBe("");
      // The folder is closed to writes; only its two files are closed to reads (Linux would hide a denied folder behind a writable empty one).
      expect(settings.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining([join(folder, "rules.json"), join(folder, "settings.json")]));
      expect(settings.sandbox.filesystem.denyRead).not.toContain(folder);
      expect(settings.sandbox.filesystem.denyWrite).toEqual(expect.arrayContaining([folder, tokamaHome]));
      // An absolute home in a permission rule needs the double slash.
      expect(echo.argv).toEqual(expect.arrayContaining([`Read(/${tokamaHome}/**)`, `Edit(/${tokamaHome}/**)`]));
      expect(existsSync(folder)).toBe(false);
    });

    it("closes the folders it is told to close, such as the engine's", async () => {
      const said = (await launch({ closedDirs: ["/run/user/1000/tokama"] }, request("echo", withCommands))).find((event) => event.type === "text");
      if (said?.type !== "text") throw new Error("no text event");
      const echo = JSON.parse(said.text) as { settings: { text: string } };
      const { filesystem } = (JSON.parse(echo.settings.text) as { sandbox: { filesystem: { denyRead: string[]; denyWrite: string[] } } }).sandbox;
      expect(filesystem.denyRead).toContain("/run/user/1000/tokama");
      expect(filesystem.denyWrite).toContain("/run/user/1000/tokama");
    });

    it("keeps `~/.tokama` for the default home", async () => {
      const said = (await launch({}, request("echo", withCommands))).find((event) => event.type === "text");
      if (said?.type !== "text") throw new Error("no text event");
      const echo = JSON.parse(said.text) as { argv: string[]; settings: { text: string } };
      expect(echo.argv).toContain("Read(~/.tokama/**)");
      expect(JSON.parse(echo.settings.text).sandbox.filesystem.denyWrite).toContain("~/.tokama");
    });

    it("ends a step whose sandbox stopped working, with the reason, and stops the CLI", async () => {
      const events = await launch({}, request("sandbox-stopped", withCommands));
      expect(end(events)).toMatchObject({
        outcome: "failed",
        errorKind: "crash",
        error: expect.stringMatching(/^Claude Code's sandbox stopped working during the step: Sandbox is required \(sandbox\.failIfUnavailable\) and stopped being available in this session: bwrap went away\. Fix that, then retry the step\.$/),
      });
      expect(end(events).error).not.toContain("more detail");
    });

    it("ends a step whose sandbox helper was refused by AppArmor as a sandbox failure, with the Linux hint", async () => {
      const events = await launch({}, request("sandbox-apply-seccomp", withCommands));
      expect(end(events)).toMatchObject({
        outcome: "failed",
        errorKind: "crash",
        error: `Claude Code's sandbox stopped working during the step: apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; caller must provide CAP_SYS_ADMIN). Fix that, then retry the step. ${NESTED_BLOCKED_HINT}`,
      });
    });

    it("does not blame a sandbox for the stderr of a call that has none", async () => {
      const result = end(await launch({}, request("sandbox-start", { limits: { edit: false, commands: [], web: false } })));
      expect(result.outcome).toBe("failed");
      expect(result.error).not.toContain("could not start its sandbox");
    });

    it("explains a CLI that exits at startup because its sandbox cannot start", async () => {
      const result = end(await launch({}, request("sandbox-start", withCommands)));
      expect(result).toMatchObject({ outcome: "failed", errorKind: "crash", error: expect.stringContaining("Claude Code could not start its sandbox: Error: sandbox.failIfUnavailable is set") });
      if (process.platform === "linux") expect(result.error).toContain(BWRAP_BLOCKED_HINT);
      else expect(result.error).not.toContain("tokama.dev/docs/linux-sandbox");
    });
  });

  it("refuses limits it cannot pass safely without starting the CLI", async () => {
    const events = await collect(runtime().launch(request("success", { limits: { edit: false, commands: ["-x"], web: false } }), new AbortController().signal));
    expect(events).toEqual([{ type: "end", outcome: "failed", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, error: expect.any(String), errorKind: "crash" }]);
  });

  it("times out, kills the process group, and reports a timeout", async () => {
    // The timeout runs on a manual clock, advanced once the fake has started its child, so a slow
    // start on CI cannot win the race.
    const clock = manualClock();
    const timed = createClaudeCodeRuntime({ command: [process.execPath, FAKE], runner: createProcessRunner({ clock, killGraceMs: 200, drainMs: 500 }) });
    const events: AgentCallEvent[] = [];
    for await (const event of timed.launch(request("hang-with-child", { timeoutMs: 60_000 }), new AbortController().signal)) {
      events.push(event);
      if (event.type === "text") clock.advance(60_000);
    }
    expect(end(events)).toMatchObject({ outcome: "failed", errorKind: "timeout", sessionId: "44444444-4444-4444-8444-444444444444" });
    const started = events[0];
    const child = events.find((event) => event.type === "text");
    if (started?.type !== "started" || child?.type !== "text") throw new Error("missing events");
    const grandchild = Number(child.text.split(" ")[1]);
    tracked.push(started.pid, grandchild);
    await waitGone(started.pid);
    await waitGone(grandchild);
  });

  it("stops on abort and kills the tools the agent started", async () => {
    const controller = new AbortController();
    const events: AgentCallEvent[] = [];
    for await (const event of runtime().launch(request("hang-with-child"), controller.signal)) {
      events.push(event);
      if (event.type === "text") controller.abort();
    }
    expect(end(events).outcome).toBe("aborted");
    const child = events.find((event) => event.type === "text");
    if (child?.type !== "text") throw new Error("missing child");
    const grandchild = Number(child.text.split(" ")[1]);
    tracked.push(grandchild);
    await waitGone(grandchild);
  });

  it("kills the process group when the caller stops reading", async () => {
    let pid = 0;
    for await (const event of runtime().launch(request("hang"), new AbortController().signal)) {
      if (event.type === "started") {
        pid = event.pid;
        tracked.push(pid);
        break;
      }
    }
    await waitGone(pid);
  });

  /** Runs `prompt` with the stop-after-result grace on a manual clock that a real interval advances. */
  async function withGrace(prompt: string) {
    const clock = manualClock();
    const graced = createClaudeCodeRuntime({ command: [process.execPath, FAKE], clock, resultGraceMs: 10_000, runner: createProcessRunner({ killGraceMs: 200, drainMs: 500 }) });
    const ticker = setInterval(() => clock.advance(1_000), 5);
    try {
      return await collect(graced.launch(request(prompt, { timeoutMs: 600_000 }), new AbortController().signal));
    } finally {
      clearInterval(ticker);
    }
  }

  it("stops a CLI that lingers after a success result, and reports it completed", async () => {
    expect(end(await withGrace("result-then-hang"))).toMatchObject({ outcome: "completed", sessionId: "d4bc8b9c-641c-40df-bc38-952463fb9366" });
  });

  it("stops a CLI that lingers after an error result, and classifies the error, not the stop", async () => {
    expect(end(await withGrace("error-then-hang"))).toMatchObject({ outcome: "failed", errorKind: "auth", error: "Not logged in · Please run /login" });
  });

  it("refuses a request without a timeout, since the runtime owns it", async () => {
    const untimed: AgentCallRequest = { model: "claude-haiku-5-5", prompt: "success", cwd: dir };
    expect(await collect(runtime().launch(untimed, new AbortController().signal))).toEqual([
      { type: "end", outcome: "failed", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, error: "a Claude Code call needs timeoutMs", errorKind: "crash" },
    ]);
  });

  it("sends SIGTERM first on a stop, so Claude Code can stop its own tools", async () => {
    const controller = new AbortController();
    const texts: string[] = [];
    let outcome = "";
    for await (const event of runtime().launch(request("trap-term"), controller.signal)) {
      if (event.type === "text") texts.push(event.text);
      if (event.type === "text" && event.text === "ready") controller.abort();
      if (event.type === "end") outcome = event.outcome;
    }
    expect(texts).toEqual(["ready", "got SIGTERM"]);
    expect(outcome).toBe("aborted");
  });

  it("puts the error subtype in the message and no absolute path", async () => {
    const result = end(await collect(runtime().launch(request("execution-error"), new AbortController().signal)));
    expect(result.error).toBe("error_during_execution");
  });
});
