//! 备份范围（#8 的 Q43）：默认本设备登记的全部资料库与参考组；按库缩小时一次算清关联参考组、
//! 完整外库与继续延伸的依赖，循环关联只走一遍。只看登记表与参考组引用了哪些库，不碰存储。

use std::collections::{BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::RegisteredLibrary;
use crate::reference_groups::GroupSummary;

/// 画师选的备份范围。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum ScopeSelection {
    /// 本设备登记的全部资料库与全部参考组（默认）。
    #[default]
    All,
    /// 只备份这些资料库及引用它们的参考组。`include_linked` 为真时，参考组还引用的其他资料库
    /// 整库补选，并继续延伸；为假时不补选，列为未覆盖。
    #[serde(rename_all = "camelCase")]
    Libraries {
        ids: Vec<String>,
        include_linked: bool,
    },
}

/// 范围里的一个资料库或参考组。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScopeItem {
    pub id: String,
    pub name: String,
}

/// 范围是怎么算出来的，逐步说明。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum ScopeStep {
    /// 参考组引用了范围里的资料库，一起带上。
    #[serde(rename_all = "camelCase")]
    LinkedGroup { library_id: String, group_id: String },
    /// 带上的参考组还引用另一个资料库，整库补选。
    #[serde(rename_all = "camelCase")]
    AddedLibrary { group_id: String, library_id: String },
}

/// 这次备份没覆盖的内容。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum Uncovered {
    /// 参考组引用的资料库不在这次备份里。`library_name` 为 `None` 表示本设备没有登记这个库。
    #[serde(rename_all = "camelCase")]
    Library {
        group: ScopeItem,
        library_id: String,
        library_name: Option<String>,
    },
    /// 读不懂的参考组文件，无法备份。
    #[serde(rename_all = "camelCase")]
    UnreadableGroup { group: ScopeItem, problem: String },
}

/// 算好的备份范围。资料库按登记顺序，参考组按名称。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BackupScope {
    pub libraries: Vec<ScopeItem>,
    pub groups: Vec<ScopeItem>,
    pub steps: Vec<ScopeStep>,
    pub uncovered: Vec<Uncovered>,
}

/// 按选择算出备份范围。
pub fn compute_scope(
    libraries: &[RegisteredLibrary],
    groups: &[GroupSummary],
    selection: &ScopeSelection,
) -> BackupScope {
    let registered = |id: &str| libraries.iter().find(|l| l.id == id);
    let item = |g: &GroupSummary| ScopeItem {
        id: g.id.clone(),
        name: g.name.clone(),
    };
    let mut readable: Vec<&GroupSummary> = Vec::new();
    let mut uncovered = Vec::new();
    for g in groups {
        match &g.problem {
            Some(problem) => uncovered.push(Uncovered::UnreadableGroup {
                group: item(g),
                problem: problem.clone(),
            }),
            None => readable.push(g),
        }
    }
    readable.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));

    let mut chosen: BTreeSet<String> = BTreeSet::new();
    let mut taken: BTreeSet<String> = BTreeSet::new();
    let mut steps = Vec::new();
    match selection {
        ScopeSelection::All => {
            chosen.extend(libraries.iter().map(|l| l.id.clone()));
            taken.extend(readable.iter().map(|g| g.id.clone()));
        }
        ScopeSelection::Libraries {
            ids,
            include_linked,
        } => {
            let mut frontier: VecDeque<String> = VecDeque::new();
            for id in ids {
                if registered(id).is_some() && chosen.insert(id.clone()) {
                    frontier.push_back(id.clone());
                }
            }
            while let Some(lib) = frontier.pop_front() {
                for g in &readable {
                    if !g.library_ids.contains(&lib) || !taken.insert(g.id.clone()) {
                        continue;
                    }
                    steps.push(ScopeStep::LinkedGroup {
                        library_id: lib.clone(),
                        group_id: g.id.clone(),
                    });
                    if !include_linked {
                        continue;
                    }
                    for other in &g.library_ids {
                        if registered(other).is_some() && chosen.insert(other.clone()) {
                            steps.push(ScopeStep::AddedLibrary {
                                group_id: g.id.clone(),
                                library_id: other.clone(),
                            });
                            frontier.push_back(other.clone());
                        }
                    }
                }
            }
        }
    }

    for g in readable.iter().filter(|g| taken.contains(&g.id)) {
        for lib in &g.library_ids {
            if !chosen.contains(lib) {
                uncovered.push(Uncovered::Library {
                    group: item(g),
                    library_id: lib.clone(),
                    library_name: registered(lib).map(|l| l.name.clone()),
                });
            }
        }
    }

    BackupScope {
        libraries: libraries
            .iter()
            .filter(|l| chosen.contains(&l.id))
            .map(|l| ScopeItem {
                id: l.id.clone(),
                name: l.name.clone(),
            })
            .collect(),
        groups: readable
            .iter()
            .filter(|g| taken.contains(&g.id))
            .map(|g| item(g))
            .collect(),
        steps,
        uncovered,
    }
}
