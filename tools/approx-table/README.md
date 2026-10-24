# 内置近似对应表生成脚本

生成 [`data/builtin-approx-table.json`](../../data/README.md)。对应 [#55](https://github.com/Yukk1No/kinshoko/issues/55)。只用 Python 标准库（3.9 及以上）。

## 流程

1. **候选**：从固定版本的 PixAI v1.0 词表（与 `tools/tagger-probe` 同一仓库、同一修订，校验 SHA-256）生成四类相近候选。
2. **审核**：LLM agent 逐条审核候选，在 [`review.tsv`](review.tsv) 中写下接受或拒绝及一句理由。
3. **入表**：只有接受的候选写进数据文件。每条候选都必须有审核记录，审核记录也必须都对应现有候选，否则生成失败。

```bash
cd tools/approx-table
python approx_table.py pending   # 列出尚未审核的候选（结论与理由两列留空），审核后追加到 review.tsv
python approx_table.py build     # 写 data/builtin-approx-table.json
python approx_table.py check     # 确认数据文件与词表、审核记录一致（可放进 CI）
python -m unittest               # 测试
```

第一次运行会把词表（约 0.8 MB）下载到 `.cache/`。也可以用 `--vocab <selected_tags.csv>` 指定本地文件，哈希不符时拒绝使用。

重复运行结果逐字节相同；内容变化时表版本自动加一。

## 候选怎么生成

词表 `selected_tags.csv` 的 `count` 列在这个修订中全是 0，没有共现数据；文本向量需要额外下载模型。所以首批候选按以下规则生成，求全不求准，由审核把关：

| 类别 | 成员 | 候选规则 |
|---|---|---|
| 发色 `hair_color` | `<颜色>_hair`；以及多色类标签（`multicolored_hair`、`two-tone_hair` 等） | 每种颜色取一个典型 sRGB 值，换算到 CIELAB，明度权重减半后取最近的 3 种颜色；有彩色另取色环上相邻的颜色。多色类标签组内两两成为候选 |
| 瞳色 `eye_color` | `<颜色>_eyes`；以及 `multicolored_eyes`、`heterochromia` 等 | 同发色 |
| 发型 `hairstyle` | 名称含马尾、双马尾、辫子、发髻、钻头卷等词，或以 `_cut` 结尾；排除食物、物品、动作等同名词和鬓发、刘海、呆毛 | 变体与基本形：一个标签的词恰好比另一个多一个（`high_ponytail`～`ponytail`） |
| 刘海 `bangs` | 名称含 `bangs` 的标签（`colored_bangs` 是颜色，不算） | 变体与基本形；另加只差一个修饰词的兄弟（`blunt_bangs`～`parted_bangs`），因为词表里没有单独的 `bangs` |

颜色典型值、类别成员与排除名单都在 `approx_table.py` 开头附近，改动后重跑 `pending` 审核新增候选，删掉不再是候选的审核记录。

## 审核记录

`review.tsv` 为 UTF-8 TSV，`#` 开头的行是注释。列：`category`、`a`、`b`（按字母序）、`verdict`（`accept` 或 `reject`）、`reason`。判断标准写在文件开头。
