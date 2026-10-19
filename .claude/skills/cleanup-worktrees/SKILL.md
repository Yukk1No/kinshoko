---
name: cleanup-worktrees
description: Free disk taken by this repo's worktrees. Use when the disk is nearly full, or the user asks to clean up worktrees, build output, or idle sessions.
---

# Cleanup Worktrees

The disk goes to **build output**, not to worktrees themselves: each worktree's `target/` (Cargo workspace at the repo root, often tens of GB) and `node_modules/`. A source checkout is tens of MB. So the lever is deleting build output in **idle** worktrees; it regenerates on the next build, and code, branches and sessions stay untouched.

Two app-side routes look like cleanup but rarely free anything here:

- `clean_up_worktrees` only takes sessions inactive for 30+ days; sessions in this repo are usually younger.
- Archiving a session moves its worktree into the app's reuse pool ("kept ready"), still on disk.

## Steps

1. **Inventory.** Run `bash .claude/skills/cleanup-worktrees/inventory.sh` from any worktree. It lists every registered worktree (Claude's under `.claude/worktrees/`, Codex's under `~/.codex/worktrees/`, ad-hoc ones in Temp) with branch, tracked-dirty count and which build dirs exist, then the free space. Done when you have the table and the starting free space.
2. **Find what is live.** `list_sessions` (limit ~80); a worktree is live when a session with `isRunning: true` has it as `cwd`. Re-check right before deleting: sessions start and take pool worktrees any time.
3. **Pick idle worktrees.** Idle means all of:
   - no running session on it;
   - `dirty=0` (tracked changes only; untracked build output is what we delete);
   - not the main checkout and not the worktree you are running in.
   Done when every row with build dirs is marked idle or kept, with the reason.
4. **Confirm with the user.** Show the delete list and the kept list with reasons (running / dirty / main / current). Name the biggest kept one so they can decide on it (commit or drop its changes, then clean it next time). Wait for a yes.
5. **Delete** in the background, one literal worktree path per loop item. Inside the loop, re-run `git status --porcelain -uno` and skip a worktree that turned dirty since the inventory. The rm safety check refuses an unguarded variable target, so write it as `rm -rf "${d:?}/${x:?}"` for `x` in `target src-tauri/target node_modules`, echoing ok/FAIL per dir. A FAIL usually means a process holds a file; report it, leave it.
6. **Verify.** `df -h` again; report before → after, and every FAIL.
