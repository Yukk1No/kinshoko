//! 资料库的标签接口：标签决定、词表、名称、外部对应、分组与个人近似对应表。

use super::*;

impl Library {
    /// 装上翻译表（ADR-0003 的首次初始化）：之后首次进库的外部名称按它取得各语言的初始名称与
    /// 别名；库里仍尚未翻译的标签现在就按它补上。已有名称的标签、画师加的别名与人工标签决定
    /// 不受影响。核心资料库本身不带翻译表，应用壳在打开每个资料库时装上随软件分发的
    /// [`TagTranslations::bundled`]。
    pub fn set_translations(&self, table: TagTranslations) -> Result<(), Error> {
        *self
            .inner
            .translations
            .write()
            .unwrap_or_else(|e| e.into_inner()) = tags::index(table);
        tags::apply_translations(&self.inner)
    }

    /// Install initial names for future tags without changing any existing label.
    /// Application attachment uses this while legacy name provenance awaits migration.
    pub fn use_translations_for_new_tags(&self, table: TagTranslations) {
        *self
            .inner
            .translations
            .write()
            .unwrap_or_else(|e| e.into_inner()) = tags::index(table);
    }

    /// 对若干参考图批量应用标签编辑（添加、否决、清除人工标签决定）。
    pub fn edit_tags(&self, image_ids: &[String], edits: &[TagEdit]) -> Result<(), Error> {
        tags::edit_tags(&self.inner, image_ids, edits)
    }

    /// 一张参考图的有效标签及出处、被否决的标签，名称按界面语言 `lang`。
    pub fn image_tags(&self, image_id: &str, lang: &str) -> Result<ImageTags, Error> {
        tags::image_tags(&self.inner, image_id, lang)
    }

    /// 用 `source` 这一层的标签事实替换参考图在该层的旧事实。
    /// 不碰其他来源，也不碰人工标签决定（#42“按来源分层”）。
    pub fn replace_source_tags(
        &self,
        source: &FactSource,
        image_id: &str,
        tags: &[SourceTag],
    ) -> Result<(), Error> {
        tags::replace_source_tags(&self.inner, source, image_id, tags)
    }

    /// 用 `source` 这一层的分级建议替换参考图在该层的旧建议；`None` 表示这一层没有建议。
    pub fn replace_source_rating(
        &self,
        source: &FactSource,
        image_id: &str,
        fact: Option<RatingFact>,
    ) -> Result<(), Error> {
        rating::replace_source_rating(&self.inner, source, image_id, fact)
    }

    /// 一张参考图的内容分级（自动与有效）。
    pub fn image_rating(&self, image_id: &str) -> Result<ImageRating, Error> {
        rating::image_rating(&self.inner, image_id)
    }

    /// 模型来源 `source` 还没打过标的参考图（不含回收站中的），新导入的在前，最多 `limit` 张。
    pub fn images_to_tag(&self, source: &FactSource, limit: u32) -> Result<Vec<String>, Error> {
        rating::images_to_tag(&self.inner, source, limit)
    }

    /// 记下模型来源 `source` 对一张参考图的打标结果；之后它不再是待打标的图。
    pub fn finish_tagging(
        &self,
        source: &FactSource,
        image_id: &str,
        outcome: TaggingOutcome,
    ) -> Result<(), Error> {
        rating::finish_tagging(&self.inner, source, image_id, outcome)
    }

    // Only identities are recorded for name provenance. Hidden labels remain private to the library.
    pub(crate) fn catalog_existing_tag_ids(&self) -> Result<Vec<String>, Error> {
        let conn = self.inner.readers.get();
        let mut statement = conn.prepare("SELECT id FROM tag")?;
        Ok(statement
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?)
    }

    /// 标签词表快照：标签、各语言名称、别名、命名空间、外部对应与计数。
    pub fn vocabulary(&self) -> Result<Vocabulary, Error> {
        tags::vocabulary(&self.inner)
    }

    /// 当前的词表修订号：可见词表变化时前进，安全模式另计。供缓存核对快照是否过期。
    pub fn vocabulary_revision(&self) -> Result<i64, Error> {
        tags::revision(&self.inner)
    }

    /// 给标签设置某种语言的名称（改名）。
    pub fn rename_tag(&self, tag_id: &str, lang: &str, name: &str) -> Result<(), Error> {
        tags::rename_tag(&self.inner, tag_id, lang, name)
    }

    /// 改标签某个来源名称的语言（纠正按文字判断的误判）；`und` 表示未注明语言。
    pub fn set_source_name_lang(&self, tag_id: &str, name: &str, lang: &str) -> Result<(), Error> {
        tags::set_source_name_lang(&self.inner, tag_id, name, lang)
    }

    pub fn add_tag_alias(&self, tag_id: &str, alias: &TagAlias) -> Result<(), Error> {
        tags::add_tag_alias(&self.inner, tag_id, alias)
    }

    pub fn remove_tag_alias(&self, tag_id: &str, alias: &str) -> Result<(), Error> {
        tags::remove_tag_alias(&self.inner, tag_id, alias)
    }

    /// 给标签补上外部对应。一个外部名称只能对应一个标签。
    pub fn add_tag_external(&self, tag_id: &str, external: &str) -> Result<(), Error> {
        tags::add_tag_external(&self.inner, tag_id, external)
    }

    pub fn remove_tag_external(&self, tag_id: &str, external: &str) -> Result<(), Error> {
        tags::remove_tag_external(&self.inner, tag_id, external)
    }

    /// 迁入向导：把还没有外部对应的 Eagle 标签按名称与翻译表精确匹配到 `vocabulary`
    /// 并写入外部对应（规范化后只对上一个、且没被别的标签占用的才写），返回已对上与没对上的
    /// Eagle 标签。安全模式开启时不列出只出现在被封印图上的标签。
    pub fn map_eagle_tags(
        &self,
        vocabulary: &ExternalVocabulary,
        lang: &str,
    ) -> Result<EagleTagMapping, Error> {
        eagle_tags::map_eagle_tags(&self.inner, vocabulary, lang)
    }

    /// 迁入向导：画师给一个标签补上外部对应。输入规范化后在词表中只对上一个名称时写词表的写法，
    /// 否则原样写入。
    pub fn map_tag_external(
        &self,
        tag_id: &str,
        input: &str,
        vocabulary: &ExternalVocabulary,
    ) -> Result<MappedExternal, Error> {
        eagle_tags::map_tag_external(&self.inner, tag_id, input, vocabulary)
    }

    /// 建立标签分组，排在最后。给出 `namespace` 时分组列出该命名空间的全部标签。
    pub fn create_tag_group(
        &self,
        name: &str,
        namespace: Option<TagNamespace>,
    ) -> Result<String, Error> {
        tags::create_tag_group(&self.inner, name, namespace)
    }

    pub fn rename_tag_group(&self, group_id: &str, name: &str) -> Result<(), Error> {
        tags::rename_tag_group(&self.inner, group_id, name)
    }

    /// 设置画师整理的分组的成员及顺序。
    pub fn set_tag_group_tags(&self, group_id: &str, tag_ids: &[String]) -> Result<(), Error> {
        tags::set_tag_group_tags(&self.inner, group_id, tag_ids)
    }

    /// 把标签加进画师整理的分组，排在最后；已在分组里的不动。安全模式开启时，只在被封印的图上
    /// 出现的标签当作不存在（[`Error::UnknownTag`]）。
    pub fn add_to_tag_group(&self, group_id: &str, tag_ids: &[String]) -> Result<(), Error> {
        tags::add_to_tag_group(&self.inner, group_id, tag_ids)
    }

    /// 把标签移出画师整理的分组。浏览视角看不见的成员不受影响（与 `set_tag_group_tags` 不同，
    /// 界面整理分组时用它）。
    pub fn remove_from_tag_group(&self, group_id: &str, tag_ids: &[String]) -> Result<(), Error> {
        tags::remove_from_tag_group(&self.inner, group_id, tag_ids)
    }

    /// 按给出的顺序排列标签分组。
    pub fn order_tag_groups(&self, group_ids: &[String]) -> Result<(), Error> {
        tags::order_tag_groups(&self.inner, group_ids)
    }

    pub fn delete_tag_group(&self, group_id: &str) -> Result<(), Error> {
        tags::delete_tag_group(&self.inner, group_id)
    }

    /// 在个人近似对应表中记下 `a` 与 `b` 相近或不相近（无方向）。同一对已有记录时改为这次的判断。
    /// “以后都不展开”记不相近，“＋”记相近。
    pub fn set_tag_approx(&self, a: &str, b: &str, relation: ApproxRelation) -> Result<(), Error> {
        tags::set_tag_approx(&self.inner, a, b, relation)
    }

    /// 删除个人近似对应表中 `a` 与 `b` 这一对（无方向）；之后按内置近似对应表。
    pub fn remove_tag_approx(&self, a: &str, b: &str) -> Result<(), Error> {
        tags::remove_tag_approx(&self.inner, a, b)
    }

    /// 个人近似对应表的全部条目，最近记下的在前，名称按界面语言 `lang`。
    pub fn personal_approx(&self, lang: &str) -> Result<Vec<PersonalApproxEntry>, Error> {
        tags::personal_approx(&self.inner, lang)
    }

    /// Legacy group configuration for application migration. It carries only local member
    /// identities, never hidden image names/counts, and never changes the Library's safe mode.
    pub fn tag_group_definitions(&self) -> Result<Vec<TagGroupDefinition>, Error> {
        tags::tag_group_definitions(&self.inner)
    }

    /// 侧栏的标签分组及计数，名称按界面语言 `lang`。
    pub fn tag_groups(&self, lang: &str) -> Result<Vec<TagGroupView>, Error> {
        tags::tag_groups(&self.inner, lang)
    }
}
