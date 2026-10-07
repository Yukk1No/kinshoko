# 随软件分发的数据

## `builtin-approx-table.json`：内置近似对应表

由 [`tools/approx-table`](../tools/approx-table/README.md) 生成，不要手改。core crate 可以用 `include_str!` 嵌入。

```json
{
  "format": "kinshoko.builtin-approx-table",
  "format_version": 1,
  "table_version": 1,
  "vocabulary": {"name": "PixAI Tagger v1.0 (…)", "url": "https://huggingface.co/…/selected_tags.csv", "sha256": "…"},
  "categories": ["hair_color", "eye_color", "hairstyle", "bangs"],
  "pairs": [
    {"category": "eye_color", "a": "aqua_eyes", "b": "blue_eyes"}
  ]
}
```

| 字段 | 含义 |
|---|---|
| `format` | 固定为 `kinshoko.builtin-approx-table`，读取时先核对 |
| `format_version` | 文件结构的版本。结构变化（增删字段、改字段含义）才加一；读取方遇到不认识的版本应拒绝读取 |
| `table_version` | 表内容的版本，整数，从 1 开始。`pairs`、`categories` 或 `vocabulary` 有任何变化，生成脚本自动加一；内容不变则重跑也不变 |
| `vocabulary` | 生成时所用外部词表的名称、固定修订的下载地址与 SHA-256 |
| `categories` | 本表覆盖的类别：发色、瞳色、发型、刘海 |
| `pairs` | 相近的两个外部名称。无方向：查 `a` 时展开 `b`，查 `b` 时也展开 `a`。同一对只出现一次，`a` 按字母序小于 `b`；先按 `categories` 的顺序、再按 `a`、`b` 排序 |

约定：

- 表中只有外部名称（PixAI 词表中的名称，即标签的外部对应），不含资料库内的标签身份（`tag_id`）。查找时由外部对应找到库内标签；没有外部对应的标签不参与内置近似对应表。
- 相近关系不传递：表中有 `aqua_eyes`～`blue_eyes` 和 `blue_eyes`～`purple_eyes`，不表示 `aqua_eyes`～`purple_eyes`。
- 个人近似对应表优先于本表；本表更新不改动个人近似对应表中的条目。
- 文件为 UTF-8、LF 换行，每对占一行，便于审阅差异。

## `builtin-translation-table.json`：内置翻译表

由 [`tools/translation-table`](../tools/translation-table/README.md) 生成，不要手改。core crate 用 `include_str!` 嵌入（`TagTranslations::bundled()`）。

```json
{
  "format": "kinshoko.builtin-translation-table",
  "format_version": 1,
  "table_version": 1,
  "vocabulary": {"name": "PixAI Tagger v1.0 (…)", "url": "https://huggingface.co/…/selected_tags.csv", "sha256": "…"},
  "languages": ["zh-CN"],
  "entries": [
    {"external": "blue_eyes", "names": {"zh-CN": "蓝瞳"}, "aliases": [{"name": "蓝眼睛", "lang": "zh-CN"}]}
  ]
}
```

| 字段 | 含义 |
|---|---|
| `format` | 固定为 `kinshoko.builtin-translation-table`，读取时先核对 |
| `format_version` | 文件结构的版本；读取方遇到不认识的版本应拒绝读取 |
| `table_version` | 表内容的版本，整数，从 1 开始；`entries`、`languages` 或 `vocabulary` 有变化时生成脚本自动加一 |
| `vocabulary` | 生成时所用外部词表的名称、固定修订的下载地址与 SHA-256 |
| `languages` | 表中提供名称的语言；首版只有简体中文 `zh-CN` |
| `entries` | 每个外部名称一条：各语言名称与别名，按 `external` 排序，每条占一行 |

覆盖：PixAI v1.0 词表中按频率前 3000 个一般标签，弃用 4 个，共 2996 条。角色、作品、作者、元数据与分级标签不在表中。

使用规则（ADR-0003）：

- 外部名称首次进库时，按本表取得各语言的初始名称与别名；表中没有的外部名称照常进库，界面标明尚未翻译。
- 初始名称已是同命名空间另一个标签的名称时，外部对应落在那个标签上，不另建标签。
- 之后名称、别名属于画师的整理数据：重打标、本表更新都不改动画师已有的名称、别名与人工标签决定。
- 本表更新（或首次装上本表）时，库里仍尚未翻译（没有任何语言名称）的标签按新表补上初始名称与别名，这是它们的首次初始化；与库内其他标签冲突的名称或别名跳过，留给画师处理。
- 一个文字只是一个条目的名称或别名。
