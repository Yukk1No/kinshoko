# Kinshoko

## Branches

Development trunk is `integration/v1`: branch from it and open every PR against it, docs and triage included. `main` only receives v1 when it ships, through PR #71.

Before publishing a release (beta, rc or final), work through the “每次发布” section of `docs/validation/release-checklist.md` item by item.

Before changing `.github/workflows/`, read `docs/agents/github-actions.md`: the default branch `main` lacks these workflows, which rules out several triggers.

## Agent skills

### Interface design

Use the project-local Impeccable skill for UI design, implementation, review, and refinement. Before these tasks, read `.agents/skills/impeccable/SKILL.md` and follow its relevant playbook. Installation and usage notes are in `docs/agents/impeccable.md`.

### Issue tracker

Track issues and specs in GitHub Issues for `Yukk1No/kinshoko`. Before working with issues, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. Before triaging issues, read `docs/agents/triage-labels.md`.

### Domain docs

Use a single root `GLOSSARY.md` and `docs/adr/`. Before exploring the domain or changing code, read `docs/agents/domain.md`.
