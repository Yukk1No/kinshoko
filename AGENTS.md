# Kinshoko

## Branches

Development trunk is `main`: branch from it and open every PR against it, docs and triage included. Keep `main` releasable: a feature that spans several PRs stays out of sight in the app until its last PR lands. A fix to a shipped version that cannot wait for the next release goes to the maintenance branch `maint/<major>.<minor>` (created from that version's tag when first needed; the 1.0.0 tag predates this branch model, so before `maint/1.0` can release, copy `.github/workflows/` and `scripts/release/` from `main` into it through a PR) and is then merged back into `main`. `integration/v1` is archived; do not branch from or merge into it.

Before publishing a release (beta, rc or final), work through the “每次发布” section of `docs/validation/release-checklist.md` item by item.

Before changing `.github/workflows/`, read `docs/agents/github-actions.md`.

## Agent skills

### Interface design

Use the project-local Impeccable skill for UI design, implementation, review, and refinement. Before these tasks, read `.agents/skills/impeccable/SKILL.md` and follow its relevant playbook. Installation and usage notes are in `docs/agents/impeccable.md`.

### Issue tracker

Track issues and specs in GitHub Issues for `Yukk1No/kinshoko`. Before working with issues, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. Before triaging issues, read `docs/agents/triage-labels.md`.

### Domain docs

Use a single root `GLOSSARY.md` and `docs/adr/`. Before exploring the domain or changing code, read `docs/agents/domain.md`.
