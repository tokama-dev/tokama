// Inside Claude Code's Linux sandbox the placeholders it makes (`.bashrc`, `.gitconfig`, ...) are
// character devices, and `git add -A` stops on the first one. The agent's git gets an exclude file
// that lists them, through its environment: the repo's own `info/exclude` is shared by every
// worktree and the engineer's checkout, so it cannot hold them.
import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { hasCode } from "../../../kernel/errno/index.js";
import { replaceTextSync } from "../../../kernel/fs-safe/index.js";
import type { ProcessRunner } from "../../../kernel/process/index.js";
import { SANDBOX_PLACEHOLDER_PATHS } from "../../../kernel/sandbox/index.js";

const EXCLUDE_FILE = "tokama-exclude";
/** An ignore file larger than this is not copied: the exclude is left out instead of cut. */
const MAX_IGNORE_BYTES = 256 * 1024;

export interface PlaceholderExcludeOptions {
  readonly runner: ProcessRunner;
  /** The home folder the agent starts with: git's default global ignore file is under it. */
  readonly home: string;
  /** Variables the runner adds to its allowlisted environment. */
  readonly env?: Readonly<Record<string, string>>;
  readonly platform?: NodeJS.Platform;
}

/**
 * The environment that makes the agent's git skip the placeholders in `cwd`, a linked worktree:
 * its `core.excludesFile` is a file in the worktree's own git folder (removed with the worktree).
 * One file is all git reads, so it starts with the engineer's own excludes file (`core.excludesFile`
 * or `~/.config/git/ignore`) and the placeholders follow: what the engineer ignores stays ignored.
 * Undefined, and nothing changed, anywhere else, or when any step fails: the call goes on without
 * it. Linux only.
 */
export async function placeholderExcludeEnv(cwd: string, options: PlaceholderExcludeOptions): Promise<Record<string, string> | undefined> {
  if ((options.platform ?? process.platform) !== "linux") return undefined;
  try {
    const dotGit = join(cwd, ".git");
    if (!lstatSync(dotGit).isFile()) return undefined;
    const pointer = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (pointer?.[1] === undefined) return undefined;
    const file = join(resolve(cwd, pointer[1].trim()), EXCLUDE_FILE);
    if (!lstatSync(dirname(file)).isDirectory()) return undefined;
    const own = await ownExcludes(cwd, options);
    if (own === undefined) return undefined;
    // The whole `.claude/` folder, so a path the sandbox adds there later is covered too. An
    // exclude never hides a tracked file: a tracked `.claude/settings.json` still shows and stages.
    const lines = [...new Set(SANDBOX_PLACEHOLDER_PATHS.map((path) => (path.startsWith(".claude/") ? "/.claude/" : `/${path}`)))].join("\n");
    const written = replaceTextSync(file, `${own === "" || own.endsWith("\n") ? own : `${own}\n`}${lines}\n`, 0o644);
    if (!written.ok) return undefined;
    // Added after any setting the caller's environment already carries.
    const given = options.env?.["GIT_CONFIG_COUNT"];
    const index = given === undefined ? 0 : Number(given);
    if (!Number.isSafeInteger(index) || index < 0) return undefined;
    return { GIT_CONFIG_COUNT: String(index + 1), [`GIT_CONFIG_KEY_${index}`]: "core.excludesFile", [`GIT_CONFIG_VALUE_${index}`]: file };
  } catch {
    return undefined;
  }
}

/** The text of the excludes file git uses for `cwd` now: "" when there is none, undefined when it cannot be read whole. */
async function ownExcludes(cwd: string, options: PlaceholderExcludeOptions): Promise<string | undefined> {
  let configured = "";
  const run = await options.runner.run({
    command: { argv: ["git", "config", "--path", "--get", "core.excludesFile"] },
    cwd,
    ...(options.env !== undefined && { env: options.env }),
    timeoutMs: 10_000,
    stdout: {
      onLine: (line) => {
        if (configured === "") configured = line.trim();
      },
    },
  });
  // Exit 1 is "not set"; anything else (no git, a broken config) means this cannot be known.
  if (run.kind !== "finished" || (run.exitCode !== 0 && run.exitCode !== 1)) return undefined;
  const path = configured === "" ? join(options.home, ".config", "git", "ignore") : isAbsolute(configured) ? configured : resolve(cwd, configured);
  try {
    const info = statSync(path);
    return info.isFile() && info.size <= MAX_IGNORE_BYTES ? readFileSync(path, "utf8") : undefined;
  } catch (error) {
    return hasCode(error, "ENOENT") ? "" : undefined;
  }
}
