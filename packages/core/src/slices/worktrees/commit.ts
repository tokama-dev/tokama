// The item's commit on its branch, in two parts around the checks:
// - `stageItem` before the checks: stages every change and fixes the tree (`write-tree`);
// - `commitItem` after they pass: commits exactly that tree on the base commit (`commit-tree`)
//   and moves the branch only if it still points at the base commit.
// Files a check writes after the tree was fixed never reach the commit. Every call goes through
// the hardened git wrapper (no hooks, no signing). Message: a short `tokama: <title>` subject, the
// item's full request, and a `Tokama-Item: <id>` trailer as the last paragraph.
import type { Git } from "../../kernel/git/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import type { ItemId } from "../../kernel/schemas/index.js";
import { cutText } from "../../kernel/text/index.js";
import { removeSandboxPlaceholders } from "./placeholders.js";
import type { ItemWorktree } from "./worktree.js";

export type CommitErrorReason = "nothing-to-commit" | "git";

export interface CommitError {
  readonly reason: CommitErrorReason;
  readonly message: string;
}

const SUBJECT_MAX = 72;
const SUBJECT_PREFIX = "tokama: ";

/**
 * The commit message: a one-line subject, the full request, and the item trailer. The title and
 * the request are the engineer's text and reach git as data only, so neither can add a trailer:
 * - the subject is folded onto one line, so it has no paragraphs;
 * - the request keeps its lines but loses control characters, and ours is the last paragraph, the
 *   only one `git interpret-trailers` reads;
 * - a request line that starts with `---`, or is a scissors line (`# ---- >8 ----`, whatever its
 *   comment character), gets a leading space, because git ignores the text after such a line and
 *   reads no trailers there.
 */
export function commitMessage(itemId: ItemId, title: string, text: string): string {
  const oneLine = title.replace(/[\s\p{Cc}]+/gu, " ").trim();
  let subject = cutSubject(`${SUBJECT_PREFIX}${oneLine === "" ? itemId : oneLine}`);
  // A title that is one huge character cluster leaves nothing but the cut mark.
  if (subject === `${SUBJECT_PREFIX.trimEnd()}…`) subject = `${SUBJECT_PREFIX}${itemId}`;
  const request = text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\p{Cc}]/gu, (c) => (c === "\n" ? c : ""))
    .replace(/^\n+/, "")
    .trimEnd()
    .replace(/^(?=---|.* -{24} >8 -{24}$)/gm, " ");
  return `${subject}\n\n${request === "" ? "" : `${request}\n\n`}Tokama-Item: ${itemId}\n`;
}

/** At most SUBJECT_MAX characters, cut between graphemes, `…` when cut; no space before the `…`. */
function cutSubject(line: string): string {
  const cut = cutText(line, SUBJECT_MAX);
  // No space before the mark.
  return cut === line ? line : cut.replace(/\s+(?=…$)/, "");
}

const gitFailure = (error: { readonly message: string }): Result<never, CommitError> => err({ reason: "git", message: error.message });

/**
 * Stages every change in the worktree; returns the tree id to commit once the checks pass. On
 * Linux it first removes the placeholders a killed sandboxed call left behind.
 */
export async function stageItem(git: Git, worktreePath: string): Promise<Result<string, CommitError>> {
  await removeSandboxPlaceholders(git, worktreePath);
  const added = await git.addAll(worktreePath);
  if (!added.ok) return gitFailure(added.error);
  const tree = await git.writeTree(worktreePath);
  return tree.ok ? ok(tree.value) : gitFailure(tree.error);
}

/** Commits `tree` (from `stageItem`) on the item branch, parent the base commit; returns the commit id. */
export async function commitItem(
  git: Git,
  worktreePath: string,
  worktree: Pick<ItemWorktree, "branch" | "baseCommit">,
  item: { readonly id: ItemId; readonly title: string; readonly text: string; readonly tree: string },
): Promise<Result<string, CommitError>> {
  const baseTree = await git.revParse(worktreePath, `${worktree.baseCommit}^{tree}`);
  if (!baseTree.ok) return gitFailure(baseTree.error);
  if (baseTree.value === item.tree) return err({ reason: "nothing-to-commit", message: "the staged tree has no changes" });
  const commit = await git.commitTree(worktreePath, item.tree, worktree.baseCommit, commitMessage(item.id, item.title, item.text));
  if (!commit.ok) return gitFailure(commit.error);
  // Refused if anything moved the branch since the item started.
  const moved = await git.updateRef(worktreePath, `refs/heads/${worktree.branch}`, commit.value, worktree.baseCommit);
  return moved.ok ? ok(commit.value) : gitFailure(moved.error);
}
