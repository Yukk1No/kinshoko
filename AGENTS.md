# Kinshoko

## Branches

Development trunk is `integration/v1`: branch from it and open every PR against it, docs and triage included. `main` only receives v1 when it ships, through PR #71.

Before changing `.github/workflows/`, read `docs/agents/github-actions.md`: the default branch `main` lacks these workflows, which rules out several triggers.

## Agent skills

### Issue tracker

Track issues and specs in GitHub Issues for `Yukk1No/kinshoko`. Before working with issues, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. Before triaging issues, read `docs/agents/triage-labels.md`.

### Domain docs

Use a single root `GLOSSARY.md` and `docs/adr/`. Before exploring the domain or changing code, read `docs/agents/domain.md`.
