# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `Yukk1No/kinshoko`. Use the `gh` CLI from this repository, or pass `--repo Yukk1No/kinshoko` explicitly. Verify the target with `git remote -v` before mutations.

In Git Bash on Windows, run `git show <ref>:<path>` as `MSYS_NO_PATHCONV=1 git show <ref>:<path>`; without it MSYS rewrites the `<ref>:<path>` argument as a Windows path and git cannot find the file.

## Operations

- Create issues with `gh issue create`; put multiline bodies in a temporary file and use `--body-file`.
- Read issues with `gh issue view <number> --comments`.
- List issues with `gh issue list --state open --json number,title,body,labels` and relevant filters.
- Append comments with `gh issue comment <number>`; use `--body-file` for multiline text.
- Apply or remove labels with `gh issue edit <number> --add-label <label>` or `--remove-label <label>`.
- Close issues with `gh issue close <number>` after recording the outcome.
- In a PR body, write `Closes #N` for each issue the PR finishes: `.github/workflows/close-issues.yml` closes it when the PR merges into `integration/v1`, where GitHub's own auto-close does not apply. Write `Refs #N` for an issue that stays open, such as one awaiting the maintainer's confirmation on a beta.
- A skill's instruction to publish to the tracker means creating a GitHub issue.
- A skill's instruction to fetch a ticket means reading its issue and comments.

## Milestones and versions

Versions follow SemVer: `x.y.Z` for bug-fix releases, `x.Y.0` for features and quality-of-life improvements, `X.0.0` for changes that break existing data or habits. A milestone is a scheduled release, named after its version (`v1.0` ships as `1.0.0` through PR #71).

- Create a milestone only once the maintainer schedules work into it; patch milestones such as `v1.0.1` appear only for a fix that cannot wait for the next feature release.
- An open issue without a milestone is backlog: new ideas and QOL requests land there as `needs-triage` and wait until the maintainer schedules them. Leave the milestone empty unless the maintainer names one.
- Milestones are orthogonal to the triage labels: the label says how ready the issue is, the milestone says which release it belongs to.
- Capability directions that are not yet issues live in [`docs/discovery/roadmap.md`](../discovery/roadmap.md).

## Pull requests as a triage surface

**PRs as a request surface: no.**

If explicitly enabled here later, use the corresponding `gh pr` operations. GitHub issues and pull requests share one number space; resolve an ambiguous number before operating on it.

## Wayfinding operations

- Map: an issue labelled `wayfinder:map`, containing Notes, Decisions-so-far and Fog.
- Child ticket: a sub-issue labelled `wayfinder:<type>` (`research`, `prototype`, `grilling` or `task`). When sub-issues are unavailable, link it in the map's task list and add `Part of #<map>` to the child.
- Blocking: use GitHub native issue dependencies via `gh api`; dependency endpoints require database issue IDs, not issue numbers or node IDs. If unavailable, record `Blocked by: #<number>` in the child body.
- Frontier: open children with no open blockers and no assignee, in map order.
- Claim: assign the ticket to the driving developer before work.
- Resolve: comment with the answer, close the child, and append a concise answer plus link to the map's Decisions-so-far.
