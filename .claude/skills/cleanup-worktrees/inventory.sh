#!/usr/bin/env bash
# Inventory every git worktree of this repo for a disk cleanup.
# Prints: path | branch | tracked-dirty count | build dirs present,
# then free space for each filesystem holding a worktree.
# Read-only. Skips `du` on purpose: it takes minutes on these trees.
set -u
paths=()
while read -r wt; do
  paths+=("$wt")
  [ -d "$wt" ] || { echo "$wt | missing (prunable)"; continue; }
  branch=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null)
  if ! status=$(git -C "$wt" status --porcelain -uno 2>/dev/null); then
    echo "$wt | ${branch:-?} | dirty=UNKNOWN (git status failed; keep it) |"
    continue
  fi
  dirty=$(printf '%s' "$status" | grep -c .)
  # Build dirs sit beside each tracked manifest; the set differs per branch.
  big=""
  for d in $(git -C "$wt" ls-files -- '*Cargo.toml' 'Cargo.toml' | xargs -r -n1 dirname | sort -u); do
    [ -d "$wt/$d/target" ] && r="$d/target" && big="$big ${r#./}"
  done
  for d in $(git -C "$wt" ls-files -- '*package.json' 'package.json' | xargs -r -n1 dirname | sort -u); do
    [ -d "$wt/$d/node_modules" ] && r="$d/node_modules" && big="$big ${r#./}"
  done
  echo "$wt | $branch | dirty=$dirty |${big:- -}"
done < <(git worktree list --porcelain | sed -n 's/^worktree //p')
echo
# One line per filesystem; on Windows reduce each path to its drive root.
for p in "${paths[@]}"; do
  [ -d "$p" ] || continue
  if command -v cygpath >/dev/null; then p="$(cygpath -m "$p" | cut -c1-2)/"; fi
  df -h "$p" | tail -1
done | sort -u
