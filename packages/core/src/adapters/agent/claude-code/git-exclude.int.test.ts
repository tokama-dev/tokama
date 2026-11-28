import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProcessRunner } from "../../../kernel/process/index.js";
import { placeholderExcludeEnv } from "./git-exclude.js";

let root: string;
let home: string;
let main: string;
let item: string;

const git = (cwd: string, args: string[], env: Record<string, string> = {}) => {
  const run = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trimEnd();
};
const exclude = (cwd: string = item) => placeholderExcludeEnv(cwd, { runner: createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: home } }), home, platform: "linux" });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-exclude-test-")));
  home = join(root, "home");
  main = join(root, "main");
  item = join(root, "item");
  mkdirSync(home);
  mkdirSync(main);
  git(main, ["init", "-q", "-b", "main"]);
  mkdirSync(join(main, ".claude"));
  writeFileSync(join(main, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(main, "a.txt"), "one\n");
  git(main, ["add", "-A"]);
  git(main, ["commit", "-q", "-m", "seed"]);
  git(main, ["worktree", "add", "-q", "-b", "item", item]);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("placeholderExcludeEnv", () => {
  it("makes the agent's git skip the placeholders in the worktree, and only there", async () => {
    const env = await exclude();
    if (env === undefined) throw new Error("no environment");
    // Placeholders as the sandbox shows them to the agent: files git has not seen before.
    for (const name of [".bashrc", ".gitconfig", ".vscode", ".claude/commands", ".claude/agents", ".claude/hooks", ".claude/settings.local.json", ".claude/skills"]) writeFileSync(join(item, name), "");
    writeFileSync(join(item, "work.txt"), "work\n");
    git(item, ["add", "-A"], env);
    expect(git(item, ["status", "--porcelain"], env)).toBe("A  work.txt");
    // Without it git still sees them, and so does the engineer's checkout.
    expect(git(item, ["status", "--porcelain", "-uall"])).toContain("?? .bashrc");
    writeFileSync(join(main, ".bashrc"), "");
    expect(git(main, ["status", "--porcelain"])).toBe("?? .bashrc");
  });

  it("keeps a tracked file in .claude tracked: its change still stages beside an untracked placeholder", async () => {
    const env = await exclude();
    writeFileSync(join(item, ".claude", "settings.json"), '{"a":1}\n');
    expect(git(item, ["status", "--porcelain"], env)).toBe(" M .claude/settings.json");
    writeFileSync(join(item, ".claude", "hooks"), "");
    writeFileSync(join(item, ".claude", "future-path"), "");
    git(item, ["add", "-A"], env);
    expect(git(item, ["status", "--porcelain"], env)).toBe("M  .claude/settings.json");
    // Tokama's own staging has no exclude: a real new file there is committed.
    git(item, ["add", "-A"]);
    expect(git(item, ["status", "--porcelain"])).toContain("A  .claude/future-path");
  });

  it("keeps what the engineer ignores globally ignored: the default file, and a configured one", async () => {
    mkdirSync(join(home, ".config", "git"), { recursive: true });
    writeFileSync(join(home, ".config", "git", "ignore"), ".env\n*.pem");
    writeFileSync(join(item, ".env"), "SECRET=1\n");
    writeFileSync(join(item, "key.pem"), "key\n");
    writeFileSync(join(item, "work.txt"), "work\n");
    const env = await exclude();
    git(item, ["add", "-A"], env);
    expect(git(item, ["status", "--porcelain"], env)).toBe("A  work.txt");

    writeFileSync(join(home, "my-ignore"), "*.log\n");
    git(item, ["config", "--global", "core.excludesFile", "~/my-ignore"]);
    writeFileSync(join(item, "run.log"), "log\n");
    writeFileSync(join(item, "run.txt"), "run\n");
    const configured = await exclude();
    git(item, ["add", "-A"], configured);
    // The configured file replaces the default one, as it does for git itself.
    expect(git(item, ["status", "--porcelain"], configured)).toBe("A  .env\nA  key.pem\nA  run.txt\nA  work.txt");
  });

  it("puts the exclude file in the worktree's git folder, not in the repo's shared folder", async () => {
    const env = await exclude();
    expect(env).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.excludesFile",
      GIT_CONFIG_VALUE_0: join(main, ".git", "worktrees", "item", "tokama-exclude"),
    });
    expect(readFileSync(join(main, ".git", "info", "exclude"), "utf8")).not.toContain(".bashrc");
  });

  it("adds its setting after the ones the environment already carries", async () => {
    const runner = createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: home } });
    const env = await placeholderExcludeEnv(item, { runner, home, platform: "linux", env: { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "1", GIT_CONFIG_KEY_1: "c.d", GIT_CONFIG_VALUE_1: "2" } });
    expect(env).toEqual({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: "core.excludesFile",
      GIT_CONFIG_VALUE_2: join(main, ".git", "worktrees", "item", "tokama-exclude"),
    });
    expect(await placeholderExcludeEnv(item, { runner, home, platform: "linux", env: { GIT_CONFIG_COUNT: "x" } })).toBeUndefined();
  });

  it("gives nothing on another OS, outside a linked worktree, for a git folder that is not there, or for an ignore file that is too large", async () => {
    const runner = createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: home } });
    expect(await placeholderExcludeEnv(item, { runner, home, platform: "darwin" })).toBeUndefined();
    expect(await exclude(main)).toBeUndefined();
    expect(await exclude(join(root, "missing"))).toBeUndefined();
    const stray = join(root, "stray");
    mkdirSync(stray);
    writeFileSync(join(stray, ".git"), "gitdir: ./nowhere\n");
    expect(await exclude(stray)).toBeUndefined();
    mkdirSync(join(home, ".config", "git"), { recursive: true });
    writeFileSync(join(home, ".config", "git", "ignore"), "x\n".repeat(200_000));
    expect(await exclude()).toBeUndefined();
  });
});
