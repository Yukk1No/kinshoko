#!/usr/bin/env bash
# Inventory every git worktree of this repo for a disk cleanup.
# Prints: path | branch | tracked-dirty count | build dirs present.
# Read-only. Skips `du` on purpose: it takes minutes on these trees.
set -u
git worktree list --porcelain | sed -n 's/^worktree //p' | while read -r wt; do
  [ -d "$wt" ] || { echo "$wt | missing (prunable)"; continue; }
  branch=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null)
  dirty=$(git -C "$wt" status --porcelain -uno 2>/dev/null | wc -l)
  big=""
  for x in target src-tauri/target node_modules; do
    [ -d "$wt/$x" ] && big="$big $x"
  done
  echo "$wt | $branch | dirty=$dirty |${big:- -}"
done
df -h "$(git rev-parse --show-toplevel)" | tail -1
