//! 外部词表：可作为外部对应的名称与翻译表。

use super::*;

/// 规范化后的比较键：NFKC、小写，空白与下划线折成一个空格，去掉首尾分隔符。
pub(super) fn key(text: &str) -> String {
    let folded = fold(text);
    folded
        .split(|c: char| c == '_' || c.is_whitespace())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// 外部词表：可作为外部对应的名称（如打标模型词表 `selected_tags.csv`、内置近似对应表中的
/// 名称），以及翻译表中各外部名称的各语言名称与别名。克隆代价很小。
#[derive(Debug, Clone, Default)]
pub struct ExternalVocabulary {
    pub(super) inner: Arc<VocabularyIndex>,
}

#[derive(Debug, Default)]
pub(super) struct VocabularyIndex {
    /// 规范化键 → 外部名称。
    pub(super) by_name: HashMap<String, BTreeSet<String>>,
    /// 翻译表中名称或别名的规范化键 → 外部名称 → 这个叫法的语言（不分语言的别名为空）。
    pub(super) by_translation: HashMap<String, BTreeMap<String, Option<String>>>,
    /// 外部名称 → 翻译表中的一项：对上后给标签初始化默认名称。
    pub(super) translations: HashMap<String, TagTranslation>,
    /// 供补对应时联想：(规范化键, 外部名称)，按外部名称排好。
    pub(super) suggest: Vec<(String, String)>,
}

impl ExternalVocabulary {
    /// 由外部名称与翻译表构造。翻译表中的外部名称也算进词表。
    pub fn new(names: impl IntoIterator<Item = String>, translations: &TagTranslations) -> Self {
        let mut index = VocabularyIndex::default();
        let mut all = BTreeSet::new();
        for name in names {
            let name = name.trim().to_owned();
            if !name.is_empty() {
                all.insert(name);
            }
        }
        for entry in &translations.entries {
            let external = entry.external.trim();
            if external.is_empty() {
                continue;
            }
            all.insert(external.to_owned());
            index
                .translations
                .entry(external.to_owned())
                .or_insert_with(|| entry.clone());
            // 名称先于别名：同一叫法既是名称又是别名时取名称的语言。
            let spoken = entry
                .names
                .iter()
                .map(|(lang, name)| (name, Some(lang.clone())))
                .chain(entry.aliases.iter().map(|a| (&a.name, a.lang.clone())));
            for (name, lang) in spoken {
                let k = key(name);
                if !k.is_empty() {
                    index
                        .by_translation
                        .entry(k.clone())
                        .or_default()
                        .entry(external.to_owned())
                        .or_insert(lang);
                    index.suggest.push((k, external.to_owned()));
                }
            }
        }
        for name in all {
            let k = key(&name);
            if k.is_empty() {
                continue;
            }
            index
                .by_name
                .entry(k.clone())
                .or_default()
                .insert(name.clone());
            index.suggest.push((k, name));
        }
        index
            .suggest
            .sort_by(|a, b| (&a.1, &a.0).cmp(&(&b.1, &b.0)));
        index.suggest.dedup();
        ExternalVocabulary {
            inner: Arc::new(index),
        }
    }

    /// 内置近似对应表中出现的全部外部名称。
    pub fn builtin_names(table: &BuiltinApproxTable) -> Vec<String> {
        let mut names: BTreeSet<String> = BTreeSet::new();
        for (a, b) in table.pairs() {
            names.insert(a.to_owned());
            names.insert(b.to_owned());
        }
        names.into_iter().collect()
    }

    /// 读打标模型的词表 `selected_tags.csv`（`name` 列）。
    pub fn read_tags_csv(path: &Path) -> Result<Vec<String>, String> {
        let mut reader = csv::Reader::from_path(path).map_err(|e| e.to_string())?;
        let column = reader
            .headers()
            .map_err(|e| e.to_string())?
            .iter()
            .position(|h| h == "name")
            .ok_or("词表缺少 name 列")?;
        let mut names = Vec::new();
        for record in reader.records() {
            let record = record.map_err(|e| e.to_string())?;
            if let Some(name) = record.get(column) {
                names.push(name.to_owned());
            }
        }
        Ok(names)
    }

    /// 词表中的外部名称个数。
    pub fn len(&self) -> usize {
        self.inner.by_name.values().map(BTreeSet::len).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.by_name.is_empty()
    }

    /// 规范化后与 `text` 相同的外部名称。
    pub fn by_name(&self, text: &str) -> Vec<String> {
        self.inner
            .by_name
            .get(&key(text))
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// 翻译表中名称或别名规范化后与 `text` 相同的外部名称。
    pub fn by_translation(&self, text: &str) -> Vec<String> {
        self.inner
            .by_translation
            .get(&key(text))
            .map(|s| s.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// 对上 `external` 之后，原文 `text` 怎么安置（ADR-0012）。
    pub(super) fn place(&self, text: &str, external: &str) -> Placement {
        if key(text) == key(external) {
            return Placement::Alias;
        }
        match self
            .inner
            .by_translation
            .get(&key(text))
            .and_then(|m| m.get(external))
        {
            Some(Some(lang)) => Placement::Lang(lang.clone()),
            _ => Placement::Keep,
        }
    }

    /// 补对应时的联想：规范化后以 `query` 开头的排前面，其次是包含它的；最多 `limit` 个。
    pub fn suggest(&self, query: &str, limit: usize) -> Vec<String> {
        let q = key(query);
        if q.is_empty() {
            return Vec::new();
        }
        let mut hits: Vec<(bool, usize, &str)> = Vec::new();
        let mut seen = HashSet::new();
        for (k, name) in &self.inner.suggest {
            if k.contains(&q) && seen.insert(name.as_str()) {
                hits.push((!k.starts_with(&q), name.len(), name.as_str()));
            }
        }
        hits.sort();
        hits.into_iter()
            .take(limit)
            .map(|(_, _, n)| n.to_owned())
            .collect()
    }

    /// 匹配一个标签的若干名称：先按外部名称本身，再按翻译表。
    pub(super) fn matches(&self, names: &[String]) -> (Vec<String>, MatchBasis) {
        let collect = |f: &dyn Fn(&str) -> Vec<String>| {
            names
                .iter()
                .flat_map(|n| f(n))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
        };
        let by_name = collect(&|n| self.by_name(n));
        if !by_name.is_empty() {
            return (by_name, MatchBasis::Name);
        }
        (
            collect(&|n| self.by_translation(n)),
            MatchBasis::Translation,
        )
    }
}

/// 对上外部对应后 Eagle 原文的去处。
pub(super) enum Placement {
    /// 与外部名称写法相同：不分语言的别名。
    Alias,
    /// 翻译表中这种语言的名称或别名：该语言的来源名称。
    Lang(String),
    /// 保持按文字判断的语言。
    Keep,
}
