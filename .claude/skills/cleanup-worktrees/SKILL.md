---
name: cleanup-worktrees
description: Free disk taken by this repo's worktrees. Use when the disk is nearly full, or the user asks to clean up worktrees, build output, or idle sessions.
---

# Cleanup Worktrees

The disk goes to **build output**, not to worktrees themselves: each worktree's Cargo `target/` dirs (often tens of GB) and `node_modules/`. Where they sit differs per branch (repo root, `src-tauri/`, `tools/*/`, `prototype/*/`), so the inventory derives them from the tracked `Cargo.toml` / `package.json` files. A source checkout is tens of MB. So the lever is deleting build output in **idle** worktrees; it regenerates on the next build, and code, branches and sessions stay untouched.

Two app-side routes look like cleanup but rarely free anything here:

- `clean_up_worktrees` only takes sessions inactive for 30+ days; sessions in this repo are usually younger.
- Archiving a session moves its worktree into the app's reuse pool ("kept ready"), still on disk.

## Steps

1. **Inventory.** Run `bash .claude/skills/cleanup-worktrees/inventory.sh` from any worktree. It lists every registered worktree (Claude's under `.claude/worktrees/`, Codex's under `~/.codex/worktrees/`, ad-hoc ones in Temp) with branch, tracked-dirty count and which build dirs exist, then free space per drive. Done when you have the table and the starting free space of every drive involved.
2. **Find what is live.** `list_sessions` (limit ~80); a worktree is live when a session with `isRunning: true` has it as `cwd`. Sessions start and take pool worktrees any time, so step 5 checks again.
3. **Pick idle worktrees.** Idle means all of:
   - no running session on it;
   - `dirty=0` (tracked changes only; untracked build output is what we delete); `dirty=UNKNOWN` means git could not inspect it, so keep it;
   - not the main checkout and not the worktree you are running in.
   Done when every row with build dirs is marked idle or kept, with the reason.
4. **Confirm with the user.** Show the delete list and the kept list with reasons (running / dirty / main / current). Name the biggest kept one so they can decide on it (commit or drop its changes, then clean it next time). Wait for a yes.
5. **Delete** one worktree per background command, so liveness is fresh for each:
   - right before launching it, `list_sessions` again and drop the worktree if a session on it is now running;
   - inside the command, re-run `git status --porcelain -uno` and skip the worktree if it fails or turned dirty;
   - remove exactly the build dirs its inventory row listed. The rm safety check refuses an unguarded variable target, so write `rm -rf "${d:?}/${x:?}"`, echoing ok/FAIL per dir. A FAIL usually means a process holds a file; report it, leave it.
6. **Verify.** Re-run the inventory; report each drive's free space before → after, every skip, and every FAIL.
