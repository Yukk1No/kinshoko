# Impeccable

Impeccable is installed for this project in `.agents/skills/impeccable/`. Codex discovers this directory automatically, and implicit invocation uses the upstream skill description. The root `AGENTS.md` also directs interface work to the skill.

## Usage

Mention `$impeccable` with a task, for example `$impeccable shape 资料库浏览界面` or `$impeccable audit <target>`. The installed skill contains the command-specific playbooks.

On Windows, run the bundled launcher from the project root:

```powershell
& '.\.agents\skills\impeccable\scripts\impeccable.cmd' context
```

The launcher downloads and verifies the pinned engine when needed, then caches it under `%USERPROFILE%\.impeccable\bin\`. Product-context initialization (`$impeccable init`) is a separate design workflow; it should use the project's existing discovery documents and glossary.

## Screenshots

Take screenshots you check yourself at `scale` 0.5, or zoom into the region in question. Take full-resolution screenshots only for images sent to the maintainer.

## Source and maintenance

- Upstream: https://github.com/pbakaus/impeccable
- Commit: `c74755d920985f7a92cef691ca970ba95f90126e`
- Skill version: `4.4.0`
- Engine version: `0.1.9`
- Distribution: upstream `.agents/skills/impeccable/`, copied with the Codex skill installer.
- Licensing: upstream `LICENSE` and `NOTICE.md` are included in the installed skill directory.

Keep the vendored skill files together when updating. Check the upstream installation instructions for changes to the distribution layout and update this source record after replacing the skill.
