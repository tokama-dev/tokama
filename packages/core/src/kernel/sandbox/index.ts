// kernel/sandbox: what an agent's commands may touch, in words every AI CLI adapter maps onto
// its own sandbox flags, and whether this machine can run that sandbox. One implementation per OS.
import type { ProcessRunner } from "../process/index.js";
import { BWRAP_BLOCKED_HINT, createLinuxSupport, LINUX_CACHE_DIRS, LINUX_SANDBOX_DOCS_URL, NESTED_BLOCKED_HINT } from "./linux.js";
import { createMacosSupport, MACOS_CACHE_DIRS } from "./macos.js";
import type { SandboxSupport } from "./support.js";

export { CREDENTIAL_PATHS, checkSandboxSpec, isWithin, PACKAGE_REGISTRY_HOSTS, SANDBOX_PLACEHOLDER_PATHS, usableCacheDirs, type NetworkPolicy, type SandboxContext, type SandboxSpec } from "./spec.js";
export type { SandboxCheck, SandboxSupport } from "./support.js";
export { BWRAP_BLOCKED_HINT, LINUX_SANDBOX_DOCS_URL, NESTED_BLOCKED_HINT };

/** The tool caches (`~/`-relative) a build may write on this OS. None where there is no sandbox. */
export function toolCacheDirs(platform: NodeJS.Platform = process.platform): readonly string[] {
  if (platform === "darwin") return MACOS_CACHE_DIRS;
  if (platform === "linux") return LINUX_CACHE_DIRS;
  return [];
}

const WINDOWS_PROBLEM = "Claude Code's sandbox does not run on Windows, so Tokama does not run steps that run commands here.";

/** `env` is the environment the CLI will start with: the programs are looked up in its PATH. */
export function createSandboxSupport(runner: ProcessRunner, platform: NodeJS.Platform = process.platform, env?: Readonly<Record<string, string>>): SandboxSupport {
  if (platform === "darwin") return createMacosSupport();
  if (platform === "linux") return createLinuxSupport(runner, env);
  return { check: async () => ({ ok: false, problem: WINDOWS_PROBLEM }) };
}
