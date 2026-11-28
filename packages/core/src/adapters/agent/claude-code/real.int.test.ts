import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonLine } from "../../../kernel/json-line/index.js";
import { createProcessRunner, type ProcessRunner } from "../../../kernel/process/index.js";
import type { AgentCallEvent } from "../../../kernel/schemas/index.js";
import { createClaudeCodeRuntime } from "./index.js";
import { hookSettings } from "./permission-hook.js";

// One call to the real `claude` CLI, on the user's own login. Opt in with TOKAMA_REAL_CLAUDE=1;
// it costs a few cents and never runs in CI. It checks the permissions for real: an edit inside
// the working directory and a command with a rule work; an edit outside it, a command without a
// rule (also a read-only one such as `whoami`, which only Tokama's hook denies) and reading a file
// outside it with `cat` are denied. Commands run in Claude Code's sandbox: a write outside the
// working directory or into the call's settings folder fails with the OS error, and only the
// allowed registry host answers.

const enabled = process.env["TOKAMA_REAL_CLAUDE"] === "1";

// What a probe step runs inside the sandbox: a write, a read, and a read of a well-known secret folder.
const PROBE = `const fs = require("fs");
const os = require("os");
const path = require("path");
const [kind, target] = process.argv.slice(2);
try {
  if (kind === "write") fs.writeFileSync(target, "x");
  else if (kind === "append") fs.appendFileSync(target, "# probe\\n");
  else if (kind === "read") fs.readFileSync(target);
  else if (kind === "list" || kind === "list-ssh") {
    console.log("listed " + fs.readdirSync(kind === "list" ? target : path.join(os.homedir(), ".ssh")).length);
    process.exit(0);
  }
  console.log("done");
} catch (error) {
  console.error(String(error));
  process.exit(1);
}
`;

describe.skipIf(!enabled)("Claude Code runtime against the real CLI", () => {
  it("runs one guarded call and returns its events, usage and session id", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "tokama-real-claude-"));
    // The call runs in a linked worktree, as every item does: git writes the shared `.git` from it.
    const main = join(root, "main");
    const repo = join(root, "repo");
    mkdirSync(main);
    writeFileSync(join(main, "notes.txt"), "the word is gecko\n");
    writeFileSync(join(main, "probe.js"), PROBE);
    writeFileSync(join(root, "secret.txt"), "the secret is agama\n");
    // Tokama's own folder, closed to commands. It belongs to the test, so the result does not depend on the host's `~/.tokama` or `~/.ssh`.
    const tokamaHome = join(root, "tokama-home");
    mkdirSync(tokamaHome);
    writeFileSync(join(tokamaHome, "planted.txt"), "planted\n");
    const git = (cwd: string, ...args: string[]) => {
      const run = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
      if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
      return run.stdout.trim();
    };
    git(main, "init", "-q", "-b", "main");
    git(main, "config", "user.name", "Test");
    git(main, "config", "user.email", "test@example.com");
    // The agent's own commit reads the repo's config, not a signing setup of whoever runs the test.
    git(main, "config", "commit.gpgsign", "false");
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "seed");
    git(main, "worktree", "add", "-q", "-b", "item", repo);
    // The CLI's raw lines, to print what the events leave out (cost, denials).
    const raw: string[] = [];
    const base = createProcessRunner();
    // The folder of the call's settings is only known once the CLI starts: the prompt names it by
    // a placeholder, filled in on the way to the CLI.
    const CALL_DIR = "<CALL_DIR>";
    let callDir = "";
    const runner: ProcessRunner = {
      run: (request) => {
        const settings = "argv" in request.command ? request.command.argv.find((arg) => arg.startsWith("--settings=")) : undefined;
        if (settings !== undefined) callDir = dirname(settings.slice("--settings=".length));
        // Only the call itself prints stream-json. The probes before it (`claude --version`, and on
        // Linux `bwrap --version` and `socat -V`) print text through the same runner.
        const isCall = "argv" in request.command && request.command.argv.includes("--output-format=stream-json");
        return base.run({
          ...request,
          ...(request.stdin !== undefined && callDir !== "" && { stdin: request.stdin.replaceAll(CALL_DIR, callDir) }),
          stdout: {
            onLine: (line) => {
              if (isCall) raw.push(line);
              request.stdout?.onLine?.(line);
            },
          },
        });
      },
    };
    try {
      const events: AgentCallEvent[] = [];
      const prompt = [
        "Do all 22 steps in order, each with exactly one tool call. A step that is denied or fails is expected: do not retry it, do not stop, and go on to the next step. Never skip a step:",
        "1. Read notes.txt.",
        "2. Create inside.txt containing the word from notes.txt.",
        "3. Create ../outside.txt containing the same word.",
        "4. Run the shell command `touch made-by-touch`.",
        "5. Run the shell command `mkdir made-by-mkdir`.",
        "6. Run the shell command `whoami`.",
        "7. Run the shell command `cat ../secret.txt`.",
        "8. Run the shell command `node probe.js write ../outside-by-node`.",
        `9. Run the shell command \`node probe.js write ${CALL_DIR}/x\`.`,
        `10. Run the shell command \`node probe.js read ${CALL_DIR}/rules.json\`.`,
        "11. Run the shell command `node probe.js list-ssh`.",
        `12. Run the shell command \`node probe.js list ${tokamaHome}\`.`,
        `13. Run the shell command \`node probe.js write ${tokamaHome}/x\`.`,
        "14. Run the shell command `curl --noproxy '*' -sS https://example.com`.",
        "15. Run the shell command `curl -sS https://example.com`.",
        "16. Run the shell command `curl -sSI https://registry.npmjs.org/`.",
        "17. Run the shell command `git status`.",
        "18. Run the shell command `git add -A`.",
        "19. Run the shell command `git commit -m probe`.",
        "20. Run the shell command `node probe.js write ../main/.git/hooks/x`.",
        "21. Run the shell command `node probe.js append ../main/.git/config`.",
        "22. Run the shell command `git config --get core.excludesFile`.",
        "Use the shell and file tools only: never WebFetch or WebSearch.",
        "Then reply with one line: which steps worked.",
      ].join("\n");
      // The hook runs from source here; the engine runs the built hook.js.
      const hookCommand: [string, ...string[]] = [process.execPath, "--import", join(import.meta.dirname, "testing", "resolve-ts.ts"), join(import.meta.dirname, "hook.ts")];
      const runtime = createClaudeCodeRuntime({ runner, hookCommand, tokamaHome });
      for await (const event of runtime.launch(
        {
          model: "haiku",
          prompt,
          cwd: repo,
          role: "You are terse.",
          // The web tools are on: they must not widen what a command can reach.
          limits: { edit: true, commands: ["touch:*", "curl:*", "node:*", "git status:*", "git add:*", "git commit:*", "git config --get:*"], web: true },
          timeoutMs: 240_000,
          sandbox: { writableRoot: repo, readOnlyRoots: [], network: { allow: ["registry.npmjs.org"], unlisted: "deny" } },
        },
        new AbortController().signal,
      )) {
        events.push(event);
      }
      // A line that is not a JSON object is skipped, as the runtime's parser skips it.
      const lines = raw.flatMap((line) => {
        const json = parseJsonLine(line);
        return json.ok && typeof json.value === "object" && json.value !== null && !Array.isArray(json.value) ? [json.value as Record<string, unknown>] : [];
      });
      expect(lines.some((line) => line["type"] === "result")).toBe(true);
      // Plain text may be skipped, but a broken JSON line from the CLI is a failure, not a skip.
      expect(raw.filter((line) => line.trimStart().startsWith("{") && !parseJsonLine(line).ok)).toEqual([]);
      const result = lines.find((line) => line["type"] === "result");
      const rateLimits = lines.filter((line) => line["type"] === "rate_limit_event");
      console.log(JSON.stringify({ events, cost: result?.["total_cost_usd"], denials: result?.["permission_denials"], rateLimits }, null, 2));

      const end = events.at(-1);
      if (end?.type !== "end") throw new Error("no end event");
      expect(events[0]?.type).toBe("started");
      expect(end.outcome).toBe("completed");
      expect(end.sessionId).toEqual(expect.any(String));
      expect(end.usage.output).toBeGreaterThan(0);
      expect(end.usage.input + end.usage.cacheRead + end.usage.cacheWrite).toBeGreaterThan(0);
      expect(existsSync(join(repo, "inside.txt"))).toBe(true);
      expect(existsSync(join(root, "outside.txt"))).toBe(false);
      expect(existsSync(join(repo, "made-by-touch"))).toBe(true);
      expect(existsSync(join(repo, "made-by-mkdir"))).toBe(false);
      // Each shell command's tool result: an error for the denied ones.
      const commandIds = new Map<string, string>();
      const results = new Map<string, { failed: boolean; text: string }>();
      const leaving: string[] = [];
      for (const line of lines) {
        const content = ((line["message"] as { content?: unknown } | undefined)?.content ?? []) as Array<Record<string, unknown>>;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          const input = block["input"] as { command?: string; dangerouslyDisableSandbox?: unknown } | undefined;
          if (block["type"] === "tool_use" && block["name"] === "Bash" && input?.command) commandIds.set(input.command, String(block["id"]));
          if (block["type"] === "tool_use" && input?.dangerouslyDisableSandbox === true) leaving.push(String(block["id"]));
          if (block["type"] === "tool_result") {
            const body = block["content"];
            const text = typeof body === "string" ? body : Array.isArray(body) ? body.map((part: { text?: string }) => part.text ?? "").join("\n") : "";
            results.set(String(block["tool_use_id"]), { failed: block["is_error"] === true, text });
          }
        }
      }
      const resultOf = (command: string) => results.get(commandIds.get(command.replaceAll(CALL_DIR, callDir)) ?? "");
      const failedCommand = (command: string) => resultOf(command)?.failed;
      expect(failedCommand("touch made-by-touch")).toBe(false);
      expect(failedCommand("whoami")).toBe(true);
      expect(failedCommand("cat ../secret.txt")).toBe(true);
      // The hook is still the second layer: a command without a rule is denied by Tokama's own text.
      expect(resultOf("whoami")?.text).toContain("Tokama:");
      // A file absent proves nothing alone: Tokama's hook or Claude Code's own checks might have
      // stopped the command first. The sandbox's own error shows the command ran and was stopped.
      // (`touch ../x` never gets that far: Claude Code's own path check denies it first, so the
      // probe script goes through `node`, whose paths Claude Code cannot see.)
      // A denied file is refused with EPERM on macOS and EACCES on Linux; a write to a read-only mount is EROFS.
      const sandboxStopped = /EPERM|EROFS|EACCES|Operation not permitted|Read-only file system|permission denied/;
      const probes = ["node probe.js write ../outside-by-node", `node probe.js write ${CALL_DIR}/x`, `node probe.js read ${CALL_DIR}/rules.json`];
      // A folder closed to reads is refused on macOS. Linux replaces it with an empty, writable scratch
      // folder: a listing shows nothing (never ENOENT, as the folder is there) and a write seems to
      // work, so a write into it proves nothing and is checked on the host instead.
      const linux = process.platform === "linux";
      const hostSsh = (() => {
        try {
          return readdirSync(join(homedir(), ".ssh")).length;
        } catch {
          return -1;
        }
      })();
      const listings = [`node probe.js list ${tokamaHome}`, ...(linux && hostSsh <= 0 ? [] : ["node probe.js list-ssh"])];
      if (linux && hostSsh <= 0) console.log("~/.ssh is missing or empty on this host, so its probe proves nothing here and is skipped");
      for (const command of [...probes, `node probe.js write ${tokamaHome}/x`, ...listings]) {
        const text = resultOf(command)?.text;
        if (linux && command.includes("write") && command.includes(tokamaHome)) continue;
        expect(text, command).toMatch(linux && listings.includes(command) ? /^listed 0$/m : sandboxStopped);
        expect(text, command).not.toMatch(/Tokama:|don't ask mode/);
      }
      // Nothing changed in Tokama's folder, whatever the sandbox said.
      expect(existsSync(join(tokamaHome, "x"))).toBe(false);
      expect(readFileSync(join(tokamaHome, "planted.txt"), "utf8")).toBe("planted\n");
      expect(existsSync(join(root, "outside-by-node"))).toBe(false);
      // The web tools being on does not open hosts to commands.
      expect(resultOf("curl --noproxy '*' -sS https://example.com")?.text).toMatch(/Could not resolve host/);
      expect(failedCommand("curl -sS https://example.com")).toBe(true);
      // The allowed registry answers, so an allowlist that blocks everything cannot pass.
      expect(failedCommand("curl -sSI https://registry.npmjs.org/")).toBe(false);
      expect(resultOf("curl -sSI https://registry.npmjs.org/")?.text).toContain("HTTP/");
      // Git works in the linked worktree: its locks and objects live in the shared `.git`.
      for (const command of ["git status", "git add -A", "git commit -m probe"]) expect(failedCommand(command), command).toBe(false);
      expect(git(repo, "log", "--format=%s")).toBe("probe\nseed");
      // On Linux the agent's git skips the sandbox's placeholders: Claude Code must pass the
      // exclude settings on to the shell for that.
      if (process.platform === "linux") {
        expect(resultOf("git config --get core.excludesFile")?.text).toContain("tokama-exclude");
      }
      // The main checkout's shared git data is writable for git itself, but not its hooks or config,
      // which would run code outside the sandbox the next time git runs there.
      for (const command of ["node probe.js write ../main/.git/hooks/x", "node probe.js append ../main/.git/config"]) {
        expect(resultOf(command)?.text, command).toMatch(sandboxStopped);
        expect(resultOf(command)?.text, command).not.toMatch(/Tokama:|don't ask mode/);
      }
      expect(existsSync(join(main, ".git", "hooks", "x"))).toBe(false);
      expect(readFileSync(join(main, ".git", "config"), "utf8")).not.toContain("# probe");
      // The raw refusal texts, kept as fixtures for what shows a blocked attempt later. They are
      // the macOS texts: Linux words them differently and must not overwrite them.
      if (process.platform === "darwin") {
        const folder = join(import.meta.dirname, "testing", "fixtures", "refusals");
        const scrub = (text: string) => [callDir, root, realpathSync(root), homedir()].reduce((out, path, i) => (path === "" ? out : out.replaceAll(path, ["<call-dir>", "<root>", "<root>", "~"][i] ?? "")), text.replaceAll("/private/var/", "/var/"));
        mkdirSync(folder, { recursive: true });
        for (const [name, command] of [
          ["blocked-host", "curl -sS https://example.com"],
          ["write-outside", "node probe.js write ../outside-by-node"],
          ["secret-read", "node probe.js list-ssh"],
        ] as const) {
          writeFileSync(join(folder, `${name}.txt`), `${scrub(resultOf(command)?.text ?? "")}\n`);
        }
      }
      // No attempt to leave the sandbox got through.
      for (const id of leaving) expect([...results.entries()].find(([key]) => key === id)?.[1].failed).toBe(true);
      expect(JSON.stringify(events)).not.toContain("agama");
      expect(events).toContainEqual(expect.objectContaining({ type: "tool_call", name: "Write", kind: "edit", input: expect.objectContaining({ file_path: "inside.txt" }) }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks a command when the hook script is missing, with either guard alone, and runs it with neither", { timeout: 360_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "tokama-real-claude-hook-"));
    try {
      const run = (name: string, settings: unknown) => {
        const dir = join(root, name);
        mkdirSync(dir);
        writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
        spawnSync("claude", ["-p", "--model", "haiku", "--settings", "settings.json", "--allowedTools", "Bash", "--permission-mode", "dontAsk", "Run exactly this bash command and nothing else: echo HOOKTEST > marker.txt"], { cwd: dir, encoding: "utf8", timeout: 100_000 });
        return existsSync(join(dir, "marker.txt"));
      };
      const missing = ["/nonexistent/tokama-engine", "/nonexistent/hook.js", "/nonexistent/rules.json"];
      type Settings = { hooks: { PreToolUse: Array<{ hooks: Array<Record<string, unknown>> }> } };
      const hookOf = (settings: Settings) => settings.hooks.PreToolUse[0]?.hooks[0] ?? {};
      expect(run("guarded", hookSettings(missing))).toBe(false);
      // Without onFailure, the shell's exit 2 alone blocks: this is what a Claude Code that ignores onFailure gets.
      const shellOnly = hookSettings(missing) as Settings;
      delete hookOf(shellOnly)["onFailure"];
      expect(run("shell-only", shellOnly)).toBe(false);
      // The control: with neither guard the hook fails open, so a missing marker above is the guards' work.
      const open = hookSettings(missing) as Settings;
      delete hookOf(open)["onFailure"];
      const command = String(hookOf(open)["command"]);
      const guard = "; [ $? -eq 42 ] || exit 2";
      expect(command.endsWith(guard)).toBe(true);
      hookOf(open)["command"] = command.slice(0, -guard.length);
      expect(run("open", open)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
