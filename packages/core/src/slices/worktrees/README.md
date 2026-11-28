# worktrees

One worktree and branch per item and repo: `tokama/<short id>` from the base branch, in `<repo>/<worktree folder>/<short id>`, with the folder in the repo's git exclude.
Removes a finished item's worktree after its commit; `discardWorktree` removes a kept one with its branch. `stageItem` fixes the tree before the checks; `commitItem` commits exactly that tree with a short `tokama: <title>` subject (72 characters at most), the full request as the body, and a `Tokama-Item: <id>` trailer as the last paragraph.
On Linux `stageItem` first removes the placeholders a killed Claude Code sandbox call left in the worktree (`removeSandboxPlaceholders`): a listed path that is untracked and an empty regular file. Nothing else is touched.
`treeDiff` reads the change between two trees for the engineer to approve: files, line counts and hunks, cut to fit one API reply.
`worktreeSnapshot` is the loop guards' `snapshot()`. Records hold no absolute paths: a worktree's folder is relative to its repo.
Finish actions on a done item's commit: `mergeItem` (only into the base branch the engineer's checkout is on, only with no uncommitted changes, fast-forward or conflict-free, never a stash), `pushItem` (only while origin points where it did at Start, see `remote.ts`), `openPullRequest` and `ghStatus` through the engineer's `gh` CLI, run outside the repo.
Try checks uses a throwaway detached worktree in `<repo>/<worktree folder>/try-<8 hex>` (`trial.ts`): the folder is walked part by part from the repo's real path and refused when any part is a link, `createTrialWorktree` adds it and `removeTrialWorktree` removes it, and only a path named `try-<8 hex>` that git lists as detached, in a folder inside the repo.
Every git call goes through the kernel's hardened wrapper. Must not run the setup command or checks (verification does), or run any finish action without the engineer's command.
