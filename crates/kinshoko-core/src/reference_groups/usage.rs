//! 永久删除预览（#67）经参考组用途 port 查询哪些参考组用到了将删除的图。

use serde::Serialize;
use ts_rs::TS;

use super::{GroupError, ReferenceGroups};

/// 永久删除预览（#67）：某个参考组用到了将删除的哪些图。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GroupUsage {
    pub group_id: String,
    pub name: String,
    /// 被用到的参考图（去重、按成员先后）。
    pub image_ids: Vec<String>,
}

/// 参考组用途 port：Library 在永久删除预览时查询哪些参考组用到了这些图（#42、#67）。
pub trait ReferenceGroupUsage {
    fn groups_using(
        &self,
        library_id: &str,
        image_ids: &[String],
    ) -> Result<Vec<GroupUsage>, GroupError>;
}

impl ReferenceGroupUsage for ReferenceGroups {
    /// 用到 `library_id` 中这些图的参考组。读不懂的参考组无法核对，按报错处理而不是当作没用到。
    fn groups_using(
        &self,
        library_id: &str,
        image_ids: &[String],
    ) -> Result<Vec<GroupUsage>, GroupError> {
        let mut out = Vec::new();
        for summary in self.list()? {
            if summary.problem.is_some() {
                return Err(GroupError::Invalid(format!(
                    "无法核对参考组“{}”：{}",
                    summary.name,
                    summary.problem.unwrap_or_default()
                )));
            }
            if !summary.library_ids.iter().any(|l| l == library_id) {
                continue;
            }
            let group = self.get(&summary.id)?;
            let mut used: Vec<String> = Vec::new();
            for (library, image) in group
                .members
                .iter()
                .filter_map(|m| m.source.library_image())
            {
                if library == library_id
                    && image_ids.iter().any(|i| i == image)
                    && !used.iter().any(|u| u == image)
                {
                    used.push(image.to_owned());
                }
            }
            if !used.is_empty() {
                out.push(GroupUsage {
                    group_id: group.id,
                    name: group.name,
                    image_ids: used,
                });
            }
        }
        Ok(out)
    }
}
