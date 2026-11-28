import { isAbsolute, join, relative, resolve } from "node:path";
import { err, ok, type Result } from "../result/index.js";

/** Where an agent's commands may write, what they may only read, and which hosts they may reach. */
export interface SandboxSpec {
  /** The one folder commands may write to. Must be the call's working directory. */
  readonly writableRoot: string;
  /** Folders the agent may read but never write. */
  readonly readOnlyRoots: readonly string[];
  readonly network: NetworkPolicy;
}

/**
 * Which hosts commands may reach, and what happens to every other host. `unlisted` is a union so
 * that a way to ask a person can be added later: every backend then fails to compile until it
 * says what it does with the new case.
 */
export interface NetworkPolicy {
  /** Hostnames (`registry.npmjs.org`, `*.example.com`, optional `:port`). Empty: no network. */
  readonly allow: readonly string[];
  readonly unlisted: "deny";
}

/**
 * Hosts of the package registries a build needs. Every host here is also a way for data to leave
 * (`npm publish`), so the list stays short: no code hosts, no private registries.
 */
export const PACKAGE_REGISTRY_HOSTS: readonly string[] = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "api.nuget.org",
  "pypi.org",
  "files.pythonhosted.org",
  "proxy.golang.org",
  "sum.golang.org",
  "index.crates.io",
  "static.crates.io",
  "crates.io",
  "repo.maven.apache.org",
  "repo1.maven.org",
  "plugins.gradle.org",
  "services.gradle.org",
];

/**
 * Paths in the working directory that Claude Code's sandbox on Linux write-protects. A path that
 * is missing gets a placeholder (bubblewrap binds `/dev/null` over it): a character device inside
 * the sandbox, and on the host an empty read-only file that stays if the call is killed before
 * its own cleanup. Relative to the working directory, "/" separators.
 */
export const SANDBOX_PLACEHOLDER_PATHS: readonly string[] = [
  ".bash_profile",
  ".bashrc",
  ".claude/agents",
  ".claude/commands",
  ".claude/hooks",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/skills",
  ".gitconfig",
  ".gitmodules",
  ".idea",
  ".mcp.json",
  ".profile",
  ".ripgreprc",
  ".vscode",
  ".zprofile",
  ".zshrc",
];

/** Files in the home folder that hold logins and keys. Commands may not read them. `~/`-relative. */
export const CREDENTIAL_PATHS: readonly string[] = [
  "~/.ssh",
  "~/.aws",
  "~/.azure",
  "~/.config/gcloud",
  "~/.kube",
  "~/.docker/config.json",
  "~/.config/gh",
  "~/.gnupg",
  "~/.netrc",
  "~/.npmrc",
  "~/.pypirc",
  "~/.cargo/credentials.toml",
  "~/.gem/credentials",
  "~/.git-credentials",
  "~/.config/git/credentials",
  "~/.vault-token",
  "~/.terraform.d/credentials.tfrc.json",
  "~/.claude/.credentials.json",
  "~/.claude.json",
  "~/.codex",
];

const HOST = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/;
// An address, not a name: dotted numbers of any length, or a hex or octal form (`127.1`, `0x7f.1`).
const IP_LITERAL = /^(\*\.)?(0x[0-9a-f]*|\d+)(\.(0x[0-9a-f]*|\d+))*(:\d+)?$/;

/** True when `path` is `root` or inside it. Both absolute. */
export function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel));
}

export interface SandboxContext {
  /** The call's working directory. */
  readonly cwd: string;
  /** Tokama's own folder, absolute: closed to agents. */
  readonly tokamaHome: string;
}

/**
 * Checks a spec and returns it normalized (absolute resolved paths, lower-case hosts), or the
 * plain reason it is refused. A spec that cannot be enforced as written never reaches a CLI.
 */
export function checkSandboxSpec(spec: SandboxSpec, context: SandboxContext): Result<SandboxSpec, string> {
  const paths = [spec.writableRoot, ...spec.readOnlyRoots, context.cwd, context.tokamaHome];
  const relativePath = paths.find((path) => !isAbsolute(path));
  if (relativePath !== undefined) return err(`"${relativePath}" is not an absolute path`);
  const writableRoot = resolve(spec.writableRoot);
  if (writableRoot !== resolve(context.cwd)) return err("the writable folder must be the folder the call runs in");
  const home = resolve(context.tokamaHome);
  if (isWithin(writableRoot, home)) return err("Tokama's own folder is closed to agents, so it cannot be a writable folder");
  const readOnlyRoots: string[] = [];
  for (const root of spec.readOnlyRoots.map((path) => resolve(path))) {
    if (isWithin(root, home) || isWithin(home, root)) return err("Tokama's own folder is closed to agents, so it cannot be a read-only folder");
    if (isWithin(root, writableRoot) || isWithin(writableRoot, root)) return err(`the read-only folder "${root}" overlaps the writable folder`);
    readOnlyRoots.push(root);
  }
  const allow: string[] = [];
  for (const host of spec.network.allow.map((name) => name.toLowerCase())) {
    const port = Number(host.split(":")[1] ?? 1);
    if (!HOST.test(host) || IP_LITERAL.test(host) || port < 1 || port > 65_535) return err(`"${host}" is not a host name this sandbox can allow`);
    allow.push(host);
  }
  return ok({ writableRoot, readOnlyRoots, network: { allow, unlisted: spec.network.unlisted } });
}

/**
 * The cache folders (`~/`-relative) that stay writable: those that are neither on the call's PATH
 * nor hold a PATH folder. A writable PATH folder would let a command plant a program that runs
 * later outside the sandbox. A cache folder inside a PATH folder is kept: it adds nothing to PATH.
 */
export function usableCacheDirs(dirs: readonly string[], pathDirs: readonly string[], home: string): string[] {
  const onPath = pathDirs.filter((dir) => isAbsolute(dir)).map((dir) => resolve(dir));
  return dirs.filter((dir) => {
    const absolute = join(home, dir.slice(2));
    return !onPath.some((pathDir) => isWithin(pathDir, absolute));
  });
}
