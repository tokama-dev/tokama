// Claude Code's sandbox on Linux binds `/dev/null` over the files it protects (`.bashrc`,
// `.gitconfig`, ...) and makes them first when they are missing. When a call is killed before its
// own cleanup they stay in the worktree as empty files, and `add -A` would commit them.
import { lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Git } from "../../kernel/git/index.js";
import { SANDBOX_PLACEHOLDER_PATHS } from "../../kernel/sandbox/index.js";

/**
 * Removes the placeholders a killed sandboxed call left in the worktree: a path from
 * `SANDBOX_PLACEHOLDER_PATHS` that git lists as untracked and that is an empty regular file.
 * A tracked file, a file with content, a link or a folder is never touched. Linux only. Run it
 * while no agent call is running in the worktree: a mount point that goes while its bubblewrap
 * runs takes the protection with it. Returns how many were removed; failures are skipped, since
 * the next run tries again.
 */
export async function removeSandboxPlaceholders(git: Git, worktreePath: string, platform: NodeJS.Platform = process.platform): Promise<number> {
  if (platform !== "linux") return 0;
  const status = await git.status(worktreePath);
  if (!status.ok) return 0;
  let removed = 0;
  for (const { index, worktree, path } of status.value) {
    if (index !== "?" || worktree !== "?" || !SANDBOX_PLACEHOLDER_PATHS.includes(path)) continue;
    const file = join(worktreePath, ...path.split("/"));
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size !== 0) continue;
      await unlink(file);
      removed++;
    } catch {
      // Gone already, or not ours to remove.
    }
  }
  return removed;
}
