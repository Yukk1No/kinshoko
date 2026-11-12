# Kinshoko

## Branches

Development trunk is `main`: branch from it and open every PR against it, docs and triage included. Keep `main` releasable: a feature that spans several PRs stays out of sight in the app until its last PR lands. A fix to a shipped version that cannot wait for the next release goes to the maintenance branch `maint/<major>.<minor>` (created from that version's tag when first needed; the 1.0.0 tag predates this branch model, so before `maint/1.0` can release, copy `.github/workflows/` and `scripts/release/` from `main` into it through a PR) and is then merged back into `main`. `integration/v1` is archived; do not branch from or merge into it.

Before publishing a release (beta, rc or final), work through the “每次发布” section of `docs/validation/release-checklist.md` item by item.

Before changing `.github/workflows/`, read `docs/agents/github-actions.md`.

## Checks

To report whether checks pass, use `npm run check` (`--rust` adds the Rust checks; usage at the top of `scripts/check.mjs`). Its exit code covers every step. A test run piped into `tail` or `grep` reports that tool's exit code instead, so read such output only for detail.

## Runtime baseline

The frontend runs only in WebView2 on Windows; the baseline is Chromium 131.
Use features within the baseline directly: no fallbacks, vendor prefixes or feature detection. Newer features go behind `@supports` or feature detection and only enhance.
When using modern-web-guidance, judge its fallbacks against this baseline.
Change this number together with `build.target` in `vite.config.ts` and the CI runner image.

## Interface text

Text the artist sees goes into `src/i18n/locales` (Rust-drawn tray, dialog and pin text into `src-tauri/src/ui_text.rs`), and a Rust failure shown in the interface is an error code (`ErrorKind`); Chinese that only reaches logs carries `// 不上界面：<reason>` on the line above its item. The CI job “写死的界面文字” fails on any other Chinese line.

Before writing or reviewing interface copy (text in the app, prototypes, design notes), read `design/ui-system/interface-text-rules.md`: plain, everyday Chinese with neutral verbs.

## Agent skills

### Interface design

Use the project-local Impeccable skill for UI design, implementation, review, and refinement. Before these tasks, read `.agents/skills/impeccable/SKILL.md` and follow its relevant playbook. Installation and usage notes are in `docs/agents/impeccable.md`. Before changing the interface, also read `design/ui-system/README.md` and the files its table lists for the task, such as `visual-and-motion.md` for transitions.

### Issue tracker

Track issues and specs in GitHub Issues for `Yukk1No/kinshoko`. Before working with issues, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. Before triaging issues, read `docs/agents/triage-labels.md`.

### Domain docs

Use a single root `GLOSSARY.md` and `docs/adr/`. Before exploring the domain or changing code, read `docs/agents/domain.md`.
