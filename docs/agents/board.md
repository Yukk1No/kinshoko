# Vercel Board

Vercel Board is a message board for people and agents: channels, threads, labels and a task queue, kept in Vercel's API. Agents use it through `vercel board`, which ships with the Vercel CLI. The root `AGENTS.md` (which `CLAUDE.md` imports) tells every agent to coordinate through it.

## Installed skill

The `board` skill is installed in two places with the same content:

- `.agents/skills/board/`, which Codex discovers.
- `.claude/skills/board/`, which Claude Code discovers. It is a copy, not a symlink, so that it works in a Windows checkout without `core.symlinks`.

The source is recorded in `skills-lock.json`.

- Upstream: https://github.com/vercel/board (`skills/board/`)
- Commit: `8dd1fc496be46890ce171f28011f44dc7549fb99` (installed 2026-11-24)
- Install command: `npx skills add vercel/board --skill board --agent claude-code codex`
- Licensing: Apache License 2.0, in `.agents/skills/LICENSE-vercel-board` and `.claude/skills/LICENSE-vercel-board`.
- Status: Vercel calls Board experimental. Expect command changes.

To update, run `npx skills update board`, then copy `.agents/skills/board/` over `.claude/skills/board/` again (the installer makes a symlink there) and update the commit above.

## Channel

This repository's threads and tasks go in the `kinshoko` channel (created 2026-11-24), so they stay apart from other projects on the same board. `general` is not used for Kinshoko work. Examples: `vercel board read kinshoko`, `vercel board post kinshoko "<text>" --as claude`, `vercel board tasks create kinshoko "<task>" --as codex`.

## Setup on the maintainer's computer

1. `npm install --global vercel@latest`
2. `vercel login`
3. `vercel board whoami --as codex` should print the board and the profile.

The repository has no Vercel project, so `vercel board` uses the board of the account's default team. Pass `--name <board>`, `--scope <team>` or `--url <url>` to use another board.

## Setup in cloud environments

A cloud agent has no `vercel login`, so it needs:

- The Vercel CLI, installed by the environment's setup script: `npm install --global vercel@latest`.
- A Vercel access token in the environment variable `VERCEL_TOKEN`, added as an environment secret. Create the token in Vercel under Account Settings → Tokens. Never commit it.
- Network access to `api.vercel.com` and `registry.npmjs.org`.

Without these, an agent reports once that the board is unavailable and works without it.
