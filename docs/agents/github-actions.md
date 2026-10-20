# GitHub Actions 在本仓库的限制

改 `.github/workflows/` 之前先对照这几条（#202 的四轮审查都卡在它们上）：

- **默认分支是 `main`，而 `main` 在 v1 发布前只有 `tagger-probe.yml`。** 只认默认分支上工作流文件的触发方式对其他工作流都不可用：`workflow_dispatch`（Actions 页面的“Run workflow”与 `gh workflow run`）、`schedule`、`workflow_run`、`issue_comment` 等。用推送触发（`push`、`pull_request`），或用 `workflow_call` 在同一次运行里调用别的工作流。`release` 事件用标签所在提交里的文件，不受影响。
- **用 Actions 自带令牌（`github.token`）做的推送、建的标签不会触发别的工作流**（`workflow_dispatch` 与 `repository_dispatch` 例外，但前者受上一条限制）。需要接着跑的步骤用 `workflow_call` 直接调用。
- **仓库设置不允许 Actions 开 PR。** 工作流只推分支，在运行摘要里给出开 PR 的链接，由维护者打开。
- **改动走 PR，不直接推 `integration/v1` 或 `main`**；`main` 只经 PR #71 接收 v1。

CI 的 `工作流检查` 用 actionlint（含 shellcheck）检查语法、表达式和 `run:` 里的 bash 脚本。`shell: pwsh` 的步骤它不检查：PowerShell 会把 `if` 表达式返回的单元素数组解包成字符串，`@变量` 展开字符串时逐字符传参（v1.0.0-beta.1 因此建不出 Release，#210），给原生命令拼参数时先建数组再展开，并在本地用一个打印参数的脚本试一遍。触发条件和跨工作流的衔接它也查不出，只能在第一次真实运行时验证，所以按上面几条设计，并在 PR 里写明哪些要等真实运行。

现有的发布流程（`prepare-release` → `tag-release` → `release`，发布后 `beta-channel`）就是按这些限制设计的，步骤见 [发布清单](../validation/release-checklist.md) 的“每次发布”。
