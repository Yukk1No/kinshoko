# 内置翻译表生成脚本

生成 [`data/builtin-translation-table.json`](../../data/README.md)：外部名称（打标模型输出的 Danbooru 名称）首次进库时的简体中文初始名称与别名。对应 [#76](https://github.com/Yukk1No/kinshoko/issues/76) Core3 / [#77](https://github.com/Yukk1No/kinshoko/issues/77) C1，规则见 [ADR-0003](../../docs/adr/0003-tag-identity-and-approximate-search.md)。只用 Python 标准库（3.9 及以上）。

## 流程

与[内置近似对应表](../approx-table/README.md)相同：脚本出候选，LLM 翻译并审核，脚本合并并校验。

1. **候选**：从固定版本的 PixAI v1.0 词表 `selected_tags.csv`（与 `ModelSpec.tags_sha256` 固定的同一文件，校验 SHA-256）按频率取前 3000 个一般标签。
2. **翻译**：LLM agent 分批写出每个候选的简体中文名称与别名，用画师平常的说法（`blue_eyes` → 蓝瞳，别名蓝眼睛、蓝色眼睛）。
3. **审核**：另做一遍逐条审核，改掉错误或别扭的译名，把多义、拿不准或不适合作为参考图标签的条目弃用。结论写在 [`translations.tsv`](translations.tsv) 的 `review` 列。
4. **入表**：未弃用的条目写进数据文件；同时生成 [`review.tsv`](review.tsv) 审核样本给维护者抽查。

```bash
cd tools/translation-table
python translation_table.py pending   # 列出还没有译名的候选，翻译后追加到 translations.tsv
python translation_table.py build     # 写 data/builtin-translation-table.json 与 review.tsv
python translation_table.py check     # 确认两者与词表、译名记录一致（可放进 CI）
python -m unittest                    # 测试
```

第一次运行会把词表（约 0.8 MB）下载到 `.cache/`。也可以用 `--vocab <selected_tags.csv>` 指定本地文件，哈希不符时拒绝使用。重复运行结果逐字节相同；内容变化时表版本自动加一。

## 候选怎么选

- **只取一般标签**（`category` 为 0）。角色、作品、作者的中文名各地叫法不一、容易错，元数据与分级不是画师找图用的，都不进表；它们进库时照常保留外部名称并标明尚未翻译。
- **频率信号用词表自身的顺序**。PixAI 沿用 WD tagger 的 `selected_tags.csv` 格式：同一类别内按 Danbooru 投稿数从多到少排列。这个修订的 `count` 列全是 0，也不去另外抓 Danbooru 的计数，所以文件顺序就是频率顺序。前 3000 个约占一般标签的五分之一，覆盖模型绝大多数实际输出。
- **纯数字**（年份）不是候选。

## 译名记录 `translations.tsv`

UTF-8 TSV，`#` 开头的行是注释。列：`external`、`name`（简体中文显示名）、`aliases`（别名，以 `|` 分隔）、`review`。行尾的空列可以省略。

| `review` | 含义 |
|---|---|
| 空 | 审核通过，未改动 |
| `改：原译 → 新译，理由` | 审核改过 |
| `弃：理由` | 弃用；名称与别名留空，标签进库后保持尚未翻译 |

一个文字只能是一个条目的名称或别名，否则画师输入它时对不上唯一的标签；`build` 会检查。

首版（表版本 1）：3000 个候选，2996 条入表，审核改过 139 条、弃用 4 条。

## 怎么抽查

打开 `review.tsv`：审核改过与弃用的条目全部列出，未改动的条目按频率每 25 个抽一个（`rank` 是频率名次）。看译名是不是画师平常的说法、别名能不能用来找到它。发现问题改 `translations.tsv` 对应行（`review` 写“改：……”），再运行 `build`；内容变了表版本自动加一。
