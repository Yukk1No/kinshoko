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
