# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `Yukk1No/kinshoko`. Use the `gh` CLI from this repository, or pass `--repo Yukk1No/kinshoko` explicitly. Verify the target with `git remote -v` before mutations.

## Operations

- Create issues with `gh issue create`; put multiline bodies in a temporary file and use `--body-file`.
- Read issues with `gh issue view <number> --comments`.
- List issues with `gh issue list --state open --json number,title,body,labels` and relevant filters.
- Append comments with `gh issue comment <number>`; use `--body-file` for multiline text.
- Apply or remove labels with `gh issue edit <number> --add-label <label>` or `--remove-label <label>`.
- Close issues with `gh issue close <number>` after recording the outcome.
- A skill's instruction to publish to the tracker means creating a GitHub issue.
- A skill's instruction to fetch a ticket means reading its issue and comments.

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
