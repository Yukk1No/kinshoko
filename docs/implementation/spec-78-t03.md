# #78 T03：全局显示名称偏好（#82）

本单覆盖故事 19、20、21、22、23、24、27。名称偏好按统一标签身份与语言保存；显示名称、默认名称、显式偏好和其他叫法各有独立字段与动作。没有偏好的已采用目录规则的标签随默认更新；恢复默认删除该语言的偏好。旧库尚未选择时保留旧显示。保存显式偏好本身是明确选择，会在已对应的各库生效，之后打开另一库不会用旧文字覆盖该选择。

本单从 `f6705880e51b493d7e84b4b74cd0d2c38e851b37` 创建独立分支。核心实现为 `87c20f4`；正式消费者刷新为 `1922819`；原生命令权限修复为 `7113d30c17a403caef612a5279f85ad710e0b1a0`；无译名标签选择器修复为 `7385d0440b2fe842055e42c13b926b573f3220fb`。本单合入 T01 的 `0ca342e10709a47558ade50de1cd648e5647e10c`、T14 的 `20bded04927fdb6ffec2c292d22654003034740f`，并合入仅增加实施记录的 `4c09af319ab2205b161a2db539f1bebb3230fdad`。#42／#71 及其历史验收没有改写。

## 公开契约

[`TagCatalog`](../../crates/kinshoko-core/src/tag_catalog.rs) 与其 [`names` 子模块](../../crates/kinshoko-core/src/tag_catalog/names.rs) 承担持久规则，核心不依赖 Tauri。

- `CatalogTag.names` 是解析显式偏好后的共享名称；`default_names` 与 `name_preferences` 分别返回默认及显式覆盖，别名和外部对应独立。不会用文字相等推断偏好。
- `set_name_preference(id, LocalizedName)` 保存 `(统一身份, 语言)`，即使文字等于当前默认；选择该身份的共享名称规则，并推进目录修订。两个旧库的原名称不同也采用这一明确选择。后接入或纠正到该身份的对应尊重已有选择。
- `reset_name_preference(id, lang)` 删除该语言覆盖，其他语言继续保存。已明确采用的对应仍遵循目录默认。
- `update_name_defaults(table)` 更新有明确 Danbooru 外部对应的一般标签默认，显式偏好不变。被替换的名称成为可移除别名。
- `install_name_defaults(table)` 为当前目录及后续新标签安装默认。每库首次接入只登记既有标签 ID（含安全模式隐藏的 ID）；旧标签继续 `pending`，后续新标签采用目录规则。不会在登记时把旧文字变成偏好。
- `add_alias`／`remove_alias` 单独管理查找叫法，不改变显示偏好。移除记录在重开和重装内置表后保留；明确重新添加可撤回移除。
- `follow_catalog_names(library, local_id)` 为 T04 提供明确选择跟随默认的公开动作；本单未替旧库选择迁移策略。
- `search_vocabulary`、`image_tags`、`tag_groups` 和 `CatalogInspection::display_label` 使用解析后的名称。保持库内 ID、分组成员、计数和逐图人工决定。Pending 显示仍用旧主要文字；明确采用后不再用本地旧别名覆盖共享删除动作。

目录修订独立于库内词表修订。Tauri 名称动作使查找缓存失效，并发出词表变化事件；标签面板、查找、侧栏分组、统一身份检查和个人近似对应名称刷新。T07 可直接使用解析后的 `CatalogTag.names` 与 `CatalogInspection::search_vocabulary`，无需再次实现偏好规则。T07 的轻量修订读取接口由其后续增量补入。

## 正式界面与原型来源

直接读取并改编固定原型 `bd8aea44c4a311571ee3c07382cb7755f87f3153:prototype/reference-browser/src/components/SettingsDialog.tsx` 的设置 fieldset／legend／明确动作结构，以及 `InfoPanel.tsx` 的标签和来源表达。名称字段分离来自已接受的 [`prototype/spec78-alignment/tag-name-model.html`](../../prototype/spec78-alignment/tag-name-model.html)；该保存 HTML 内的历史“未确认”文字不改变 #78 后续确认的范围。T01 正式布局在集成后用于本单原生检查。

正式 [`TagNamePanel`](../../src/library/TagNamePanel.tsx) 提供可搜索标签选择器，只渲染一个编辑器，选项限制为 80 个；可筛选当前语言已保存偏好。标签当前显示、名称来源、该语言默认、显式保存／恢复默认、别名增删分别展示。无译名标签也可选择并按外部名称定位。正式 [`names` IPC](../../src-tauri/src/library/names.rs) 过滤当前安全视角，响应边界复核模式代次；前端模式变化清空旧数据并丢弃迟到结果。

新增 `edit_tag_name` 已核对四处契约：前端 `plugin:library|edit_tag_name`、`generate_handler![names::edit_tag_name]`、`build.rs` 的 inline-plugin command 列表，以及 `capabilities/default.json` 的 `library:default`。别名兼容入口沿用已有登记。

## 翻译输入与原文件保全

从根编排的独立 `translation-input` 副本接入三个已接受输入。快照 v2 将两个确认用语放在别名中；本单明确提升为默认并重新生成 v3：

| 外部对应 | 默认名称 | 保留的可删除旧别名 |
| --- | --- | --- |
| `long_hair_between_eyes` | 两眼间长发 | 长眼间发 |
| `parted_hair` | 分缝发型 | 分发 |

`translations.tsv` 与 `review.tsv` 同步记录该默认修正；未照抄错误旧主要名称。生成器用固定离线词表，SHA256 为 `A9455CBF0A910D4A3890739F2F70BD986278F4594285EF1049121A03896E2A6D`，build／check 一致，13 项工具测试通过。

[原输入最终哈希记录](evidence/spec78-t03/translation-source-hashes.json) 对原 dirty tree 的三份文件再次逐字节核对，全部未变：

- `data/builtin-translation-table.json`：`C74A5F5B7688687B5A4F8F7D37FDFDAF7D4DBDC1C376FDD37B29A8A61B411DCC`
- `tools/translation-table/review.tsv`：`CB27038E670AD23717747E988BCB4842D0EF8197F25A7E076313A77E8A8EE1F4`
- `tools/translation-table/translations.tsv`：`B89B905F88A167BA040FED5EF59C20EECDA5100D73D6FD1367E7D2F562A7EED0`

## 独立红绿验证

新核心测试 [`tag_names.rs`](../../crates/kinshoko-core/tests/tag_names.rs) 使用公开接口、两份真实 SQLite 资料库及真实 PNG，没有私表断言。先观察失败，再逐项实现；前端行为测试仅补充控件、事件和代次边界。日志原件在本工作树 `work/e2e/`，固定副本见 [本单证据目录](evidence/spec78-t03)。

| 场景 | 实现前的失败 | 通过证据 |
| --- | --- | --- |
| 跨库、语言独立、重开后偏好 | `set_name_preference` 不存在 | `t03-preference-green.txt` |
| 默认升级、等于默认的显式偏好、恢复默认、旧别名删除 | defaults／reset／remove 动作不存在 | `t03-defaults-green.txt` |
| 已接受中文默认 | 实际“长眼间发”，预期“两眼间长发” | `t03-approved-input-green.txt` |
| 别名独立且跨库查找 | `add_alias` 不存在 | `t03-alias-green.txt` |
| Pending 上的明确全局偏好 | 实际“分发”，预期“自然分缝” | `t03-explicit-choice-green.txt` |
| 新标签默认、隐藏旧标签保持 Pending | install／follow 动作不存在 | `t03-installed-defaults-green.txt`、`t03-provenance-green.txt` |
| 后续纠正采用既有明确选择 | 实际“分开的头发”，预期“自然分缝” | `t03-corrected-preference-green.txt` |
| 分组采用名称且保留成员、计数 | `tag_groups` 不存在 | `t03-group-labels-green.txt` |
| 正式偏好控件与模式代次 | 名称组件不存在 | `t03-panel-green.txt` |
| 大目录只编辑选中标签 | 实际渲染 150 个编辑器，预期 1 个 | `t03-panel-scale-green.txt` |
| 身份检查及个人近似表刷新 | 词表事件后仍显示旧名称 | `t03-consumer-refresh-green.txt` |
| 无译名标签选择器 | 找不到保存偏好控件 | `t03-untranslated-selector-green.txt` |
| 原生正式命令 | “library.edit_tag_name not allowed. Command not found” | `t03-native-permission-fix.txt` |

## 环境、命令与回归

2026-10-08（Asia/Shanghai），Windows `10.0.26300.0`、Rust `1.95.0 (59807616e 2026-04-14)`、Node `v22.15.0`、WebView2／EdgeDriver `154.0.4258.62`、tauri-driver `2.1.0`。所有 Cargo 结果使用本工作树独立 `target` 与并发 2；只读 node_modules junction 复用依赖，Vite/Vitest cache 放在本树 `work/vitest-cache`。

```powershell
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target'
$env:CARGO_BUILD_JOBS = '2'
cargo test --workspace --locked -j2
cargo test -p kinshoko-core --test tag_names --test tag_catalog --test eagle_deleted_content --locked -j2
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -j2 -- -D warnings
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run --config work/vitest.config.ts
node node_modules/vite/bin/vite.js build --config work/vitest.config.ts
python -m unittest discover -s tools/translation-table
python tools/translation-table/translation_table.py check --vocab <固定离线词表>
$env:TAURI_CONFIG = '{"identifier":"dev.kinshoko.spec78t03test"}'
cargo build -p kinshoko --features tauri/custom-protocol --locked -j2
node e2e/tag-names.mjs target/debug/kinshoko.exe <匹配的msedgedriver.exe> C:/Users/yuk1no/.cargo/bin/tauri-driver.exe
```

| 检查范围 | 结果与对应版本 |
| --- | --- |
| Rust 完整工作区 | 544 通过、0 失败、5 项既有 ignored；`bb839da` 阶段的产品代码；之后消费者刷新、测试克隆修正及权限登记另验 |
| 新名称核心／目录兼容 | 8／11 通过；T14 合并后再次通过 |
| T14 与本单公共接口 | `eagle_deleted_content` 11 通过、2 项其故障注入子入口 ignored；合并后通过 |
| 最终正式前端 | 26 文件、225 测试通过；`7385d04`，包括无译名选择器 |
| 最终 TypeScript／Vite | 通过；`7385d04` |
| Rust 格式／全工作区 all-targets clippy | T14 合并后通过，包含 Tauri；后续仅前端选择器与文档变化 |
| 翻译生成器／工具测试 | 离线 build／check 一致、13 测试通过；三个原输入哈希最终一致 |
| 独立原生构建与正式应用 | 构建通过、15 项断言通过；准确源码及后续限制见下 |

## 原生正式应用证据

通过运行目录：`C:/Users/yuk1no/.codex/worktrees/spec78-t02-tag-identity/kinshoko/work/e2e/tag-names-1791473617790/`，含两份真实资料库、隔离数据、截图和结果。固定结果为 [result.json](evidence/spec78-t03/result.json)，原始失败及截图另存为 [native-command-permission-red.json](evidence/spec78-t03/native-command-permission-red.json)／[失败界面](evidence/spec78-t03/native-command-permission-red.png)。真实失败没有计为通过；生产权限修复提交后重新构建并完整重跑。

通过运行的产品与脚本源码均为 `7113d30c17a403caef612a5279f85ad710e0b1a0`，tree 为 `4b03344fd8a162278aa7f567a433a0960ad2a203`。[逐文件源码、嵌入 dist 与二进制清单](evidence/spec78-t03/native-source.json) 固定其来源。二进制 SHA256 为 `336B3731D435D0E696D5CB07A3E35DD2F1749B8A0B2F10AAA0DD67BAF5FC42EF`；原件另保存在本树 `work/e2e/nativeproof/t03-7113d30/kinshoko.exe`。匹配 driver 的 SHA256 为 `0F4600639201CCD2E84C72C3977AC33C67E19152E197C89EB16A6591D1FBE9F7`。

identifier 为 `dev.kinshoko.spec78t03test`，WebDriver 4450／4451，APPDATA／LOCALAPPDATA／应用数据／WebView profile 均在本次运行目录，设置 `KINSHOKO_SKIP_AUTOSTART=1`。脚本退出时只清理本次应用路径和 driver 子进程；退出后 CIM 确认应用与两种 driver 均已结束，桌面预约已释放。

步骤与 15 项断言：用公开 IPC 建两库、导入 PNG、建立不同本地 ID 并明确对应；在正式设置控件保存等于默认的中文偏好，再分别保存英文、中文偏好；通过正式库选择器和标签面板确认两库显示；输入旧别名与偏好文字执行正式查找；完整重启核对两个语言；用控件恢复中文默认、删旧别名、加“中间发缝”，再次核对两库显示与查找；第三次完整重启检查内置表重装后旧别名仍删除、正式查找结果为零。默认“两眼间长发”同时在正式目录中验证。

已检查截图：[偏好与默认分离](evidence/spec78-t03/formal-name-preferences.png)、[第一库正式查找](evidence/spec78-t03/formal-first-library-search.png)、[恢复默认与独立别名](evidence/spec78-t03/formal-default-and-aliases.png)、[删旧别名后的查找](evidence/spec78-t03/formal-removed-alias-search.png)。

原生结果不冒充后续版本验证。T14 在此次原生运行后合入；合并只发生独立 IPC 类型 import 冲突，已同时保留两种类型，并补验核心、Tauri all-targets、全前端及构建。之后无译名选择器有独立 RED→GREEN 与最终全前端检查；该新边界未再占用桌面运行原生。清理脚本去除一个重复配置键不改产品。

## 未验证

开发者实际安装环境的真机验收未执行，状态为未验证。开发者需要用真实旧库检查 Pending 保留、明确选择、不同语言、默认升级和重开；自动 WebDriver 不替代该验收。T04 的迁移选择 UI、备份恢复和跨设备同步不属于本单。Windows 10／11 发布组合、安装包及大词表交互性能的真机测量未在本单宣称通过。
