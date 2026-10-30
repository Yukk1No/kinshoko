//! 参考组（ReferenceGroups，#66、ADR-0002）：为同一参考目的组织、独立于资料库保存的一组参考组成员。
//!
//! - 每个参考组一个带版本号的 JSON（`format: "kinshoko.reference-group"`），放在应用数据目录的
//!   `reference-groups/` 下，不属于任何资料库；资料库中的图片及其元数据仍归资料库所有。
//! - 参考组成员按“资料库＋参考图”引用，可跨资料库；也可以是参考组自带的截图（#270，
//!   [`MemberSource::Capture`]）：截图文件复制到 `reference-groups/<参考组>.captures/` 下，不进任何
//!   资料库，没有成员再用它时删除。各自保存裁切、翻转、旋转、位置、尺寸与缩放
//!   （[`Placement`](crate::desktop::Placement) 与桌面钉图同义）。透明度、锁定只属于桌面，不进参考组。
//! - 同一张图在不同参考组里是不同的成员，互不影响；同一参考组里两块局部也是两个成员。
//! - 打开参考组得到一组新的桌面钉图（[`ReferenceGroups::open_pins`]；组内截图放回截图历史后
//!   钉成截图钉图），钉图记得来自哪个成员（[`GroupMemberRef`](crate::desktop::GroupMemberRef)），存回时更新那个成员
//!   （[`ReferenceGroups::save_pins`]）。
//! - 成员能否显示由 [`References`] 跨库核对：资料库没登记、不可用、图已删除时标出原因，
//!   成员与布局原样保留。
//! - 永久删除（#67）预览时经参考组用途 port（[`ReferenceGroupUsage`]）查询受影响的参考组。
//! - 参考组包（#68）：[`ReferenceGroups::export_package`] 连同所用原图与整理信息快照导出，
//!   [`ReferenceGroups::import_package`] 在别处导入后另存为新的参考组（见 [`package`] 模块）。
//!
//! 每次改动先写临时文件并落盘，再改名替换，写到一半断电也不会留下半份。

mod captures;
mod error;
mod member;
mod merge;
mod package;
mod packages;
mod resolve;
mod usage;

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::desktop::SavedPin;

use captures::write_atomically;
use merge::{assign, merge};

pub use captures::{CaptureFiles, OpenedPins, RelinkFailure, RelinkReport};
pub use error::GroupError;
pub use member::{GroupCapture, GroupMember, MemberSource};
pub use package::{
    PACKAGE_EXTENSION, PackageImage, PackageManifest, PackageProvenance, read_package,
};
pub use packages::{PackageCapture, PackageImport};
pub use resolve::{
    DetachedLenses, MemberState, MemberStatus, ReferenceGroupView, ReferenceSource, References,
    UnavailableReason, resolve,
};
pub use usage::{GroupUsage, ReferenceGroupUsage};

const FORMAT: &str = "kinshoko.reference-group";
const FORMAT_VERSION: u32 = 1;
/// 有组内截图成员的参考组按这一版写：旧版本读到时提示升级，而不是“已损坏”。
/// 只引用资料库的参考组仍按 [`FORMAT_VERSION`] 写，格式不变。
const CAPTURE_FORMAT_VERSION: u32 = 2;
const EXTENSION: &str = "json";
/// 参考组 `<id>` 自带的截图放在 `<id>.captures/` 下。
const CAPTURES_EXTENSION: &str = "captures";

/// 一个参考组。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReferenceGroup {
    pub id: String,
    pub name: String,
    /// 毫秒时间戳。
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    pub members: Vec<GroupMember>,
    /// 从参考组包导入时，来自哪个包（#68）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub imported_from_package: Option<PackageProvenance>,
    /// 从备份恢复出来的副本记下原参考组与备份快照（#69）；不是恢复出来的为 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub restored_from: Option<RestoredFrom>,
}

/// 恢复出的参考组来自哪个参考组、哪个备份快照。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RestoredFrom {
    pub group_id: String,
    pub backup_id: String,
}

impl ReferenceGroup {
    /// 资料库成员的桌面钉图：每个成员一个新钉图，按成员的先后，带着各自的局部与摆放。
    /// 组内截图要先放回截图历史，见 [`ReferenceGroups::open_pins`]。
    pub fn pins(&self) -> Vec<SavedPin> {
        self.members
            .iter()
            .filter(|m| m.library_id().is_some())
            .filter_map(|m| m.pin(&new_id(), &self.id, "").ok())
            .collect()
    }

    /// 引用到的资料库，按首次出现的先后。
    pub fn library_ids(&self) -> Vec<String> {
        let mut seen = BTreeSet::new();
        self.members
            .iter()
            .filter_map(GroupMember::library_id)
            .filter(|library| seen.insert(*library))
            .map(str::to_owned)
            .collect()
    }

    /// 成员用到的组内截图文件名。
    fn capture_files(&self) -> BTreeSet<&str> {
        self.members
            .iter()
            .filter_map(|m| match &m.source {
                MemberSource::Capture { capture_file } => Some(capture_file.as_str()),
                MemberSource::Library { .. } => None,
            })
            .collect()
    }

    fn validate(&self) -> Result<(), GroupError> {
        if self.name.trim().is_empty() {
            return Err(GroupError::Invalid("没有名称".into()));
        }
        let mut ids = BTreeSet::new();
        for m in &self.members {
            if !ids.insert(m.id.as_str()) {
                return Err(GroupError::Invalid(format!("成员 {} 重复", m.id)));
            }
            m.pin("check", &self.id, "check")
                .map_err(GroupError::Invalid)?;
        }
        Ok(())
    }
}

/// 参考组列表里的一项。读不懂的文件也列出来并说明原因，不悄悄消失。
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GroupSummary {
    pub id: String,
    pub name: String,
    pub member_count: usize,
    /// 引用到的资料库。
    pub library_ids: Vec<String>,
    #[ts(type = "number")]
    pub updated_at: i64,
    /// 这个文件读不懂时的原因；能打开时为 `None`。
    pub problem: Option<String>,
}

/// 磁盘上的参考组文件。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupFile {
    format: String,
    format_version: u32,
    #[serde(flatten)]
    group: ReferenceGroup,
}

/// 只读格式与版本，先于完整解析：新版本写的文件按版本报错，而不是“已损坏”。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    format: Option<String>,
    format_version: Option<u32>,
}

/// 本设备的参考组。每个参考组一个文件，可在线程间共享；应用壳把改动串行化（放在锁里）。
/// 句柄只是目录位置，可以复制：耗时的参考组包导出、导入（只新建文件）不必一直占着锁。
#[derive(Clone)]
pub struct ReferenceGroups {
    dir: PathBuf,
}

impl ReferenceGroups {
    /// 参考组都放在 `dir` 下（应用数据目录的 `reference-groups/`）；没有时建立。
    pub fn open(dir: &Path) -> Result<ReferenceGroups, GroupError> {
        fs::create_dir_all(dir)?;
        Ok(ReferenceGroups {
            dir: dir.to_path_buf(),
        })
    }

    pub(crate) fn restore_journal_dir(&self) -> PathBuf {
        self.dir.join("restore-transactions")
    }

    /// Only a fully staged content-restore batch publishes these already allocated identities.
    /// 连同它自带的截图（`captures`，#270）一起发布。
    pub(crate) fn publish_restored(
        &self,
        group: &ReferenceGroup,
        captures: &CaptureFiles,
    ) -> Result<(), GroupError> {
        if group.restored_from.is_none() || self.path(&group.id)?.exists() {
            return Err(GroupError::Invalid(
                "恢复身份已存在，未覆盖现有参考组".into(),
            ));
        }
        self.publish_with_captures(group, captures)
    }

    /// 全部参考组，按最近保存的在前。
    pub fn list(&self) -> Result<Vec<GroupSummary>, GroupError> {
        let mut out = Vec::new();
        for entry in fs::read_dir(&self.dir)? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some(EXTENSION) {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            out.push(match self.get(id) {
                Ok(g) => GroupSummary {
                    member_count: g.members.len(),
                    library_ids: g.library_ids(),
                    id: g.id,
                    name: g.name,
                    updated_at: g.updated_at,
                    problem: None,
                },
                Err(e) => GroupSummary {
                    id: id.to_owned(),
                    name: id.to_owned(),
                    member_count: 0,
                    library_ids: Vec::new(),
                    updated_at: 0,
                    problem: Some(e.to_string()),
                },
            });
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.name.cmp(&b.name)));
        Ok(out)
    }

    pub fn get(&self, id: &str) -> Result<ReferenceGroup, GroupError> {
        let path = self.path(id)?;
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(GroupError::UnknownGroup),
            Err(e) => return Err(e.into()),
        };
        let group = parse(&bytes)?;
        if group.id != id {
            return Err(GroupError::Invalid("文件名与参考组身份不符".into()));
        }
        Ok(group)
    }

    /// 备份的快照入口（#69）：参考组文件的原样字节。读不懂的参考组也照样交出。
    pub fn snapshot(&self, id: &str) -> Result<Vec<u8>, GroupError> {
        match fs::read(self.path(id)?) {
            Ok(b) => Ok(b),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Err(GroupError::UnknownGroup),
            Err(e) => Err(e.into()),
        }
    }

    /// 固定快照里实际引用的资料库；备份据此核对执行前的范围，调用方不解析组文件格式。
    pub fn snapshot_libraries(snapshot: &[u8]) -> Result<Vec<String>, GroupError> {
        Ok(parse(snapshot)?.library_ids())
    }

    /// 备份的恢复入口（#69）：把快照字节恢复成独立的新参考组。新的参考组身份，记下
    /// `restored_from`；成员引用的资料库按 `libraries`（原身份 → 恢复出的身份）改连，不在其中的
    /// 原样保留。成员、局部与摆放不变；不覆盖任何现有参考组。
    pub fn restore(
        &self,
        snapshot: &[u8],
        libraries: &std::collections::HashMap<String, String>,
        from: RestoredFrom,
    ) -> Result<ReferenceGroup, GroupError> {
        let mut group = parse(snapshot)?;
        group.id = new_id();
        group.restored_from = Some(from);
        for m in &mut group.members {
            if let MemberSource::Library { library_id, .. } = &mut m.source
                && let Some(new) = libraries.get(library_id)
            {
                *library_id = new.clone();
            }
        }
        self.write(&group)?;
        Ok(group)
    }

    /// 把桌面上的资料库钉图存成新的参考组。截图钉图不进组（要先收藏）；一张也没有时为
    /// [`GroupError::NoMembers`]。存进去的钉图记下自己成了哪个成员（[`SavedPin::member`]），
    /// 之后存回时更新那个成员。
    pub fn create(&self, name: &str, pins: &mut [SavedPin]) -> Result<ReferenceGroup, GroupError> {
        self.create_with_captures(name, pins, &[])
    }

    /// 同 [`Self::create`]，`captures` 中的截图钉图只存在参考组里（#270）：截图文件复制进这个参考组。
    pub fn create_with_captures(
        &self,
        name: &str,
        pins: &mut [SavedPin],
        captures: &[GroupCapture],
    ) -> Result<ReferenceGroup, GroupError> {
        let name = valid_name(name)?;
        let now = crate::library::now_ms();
        let mut group = ReferenceGroup {
            id: new_id(),
            name,
            created_at: now,
            updated_at: now,
            members: Vec::new(),
            imported_from_package: None,
            restored_from: None,
        };
        let merged = merge(&mut group, pins, captures);
        if group.members.is_empty() {
            return Err(GroupError::NoMembers);
        }
        self.commit(&group, &merged.copies)?;
        assign(pins, merged.assigned);
        Ok(group)
    }

    /// 把桌面钉图存进参考组 `id`：来自这个参考组成员的钉图更新那个成员（局部、位置、尺寸、缩放、
    /// 翻转与旋转）；其他资料库钉图（包括来自别的参考组的）加为新成员；不在桌面上的成员原样保留。
    /// 来自组内截图成员的截图钉图更新那个成员；其他截图钉图不进组。收藏后改连参考图的钉图让成员
    /// 改为引用资料库，组内那份截图随之删除。存进去的钉图之后记得这个参考组里的成员。
    pub fn save_pins(&self, id: &str, pins: &mut [SavedPin]) -> Result<ReferenceGroup, GroupError> {
        self.save_pins_with_captures(id, pins, &[])
    }

    /// 同 [`Self::save_pins`]，`captures` 中的截图钉图只存在参考组里（#270），加为新成员。
    pub fn save_pins_with_captures(
        &self,
        id: &str,
        pins: &mut [SavedPin],
        captures: &[GroupCapture],
    ) -> Result<ReferenceGroup, GroupError> {
        let mut group = self.get(id)?;
        let merged = merge(&mut group, pins, captures);
        group.updated_at = crate::library::now_ms();
        self.commit(&group, &merged.copies)?;
        assign(pins, merged.assigned);
        Ok(group)
    }

    /// 从参考组中去掉一个成员。它是组内截图时，截图文件随之删除。
    pub fn remove_member(&self, id: &str, member_id: &str) -> Result<ReferenceGroup, GroupError> {
        let mut group = self.get(id)?;
        group.members.retain(|m| m.id != member_id);
        group.updated_at = crate::library::now_ms();
        self.commit(&group, &[])?;
        Ok(group)
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<ReferenceGroup, GroupError> {
        let name = valid_name(name)?;
        let mut group = self.get(id)?;
        group.name = name;
        group.updated_at = crate::library::now_ms();
        self.write(&group)?;
        Ok(group)
    }

    /// 删除参考组文件和它自带的截图。引用的图与资料库不受影响。
    pub fn delete(&self, id: &str) -> Result<(), GroupError> {
        match fs::remove_file(self.path(id)?) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(GroupError::UnknownGroup),
            Err(e) => return Err(e.into()),
        }
        // 删不掉（例如被别的程序占用）只留下孤立文件；参考组已经删除，不再报错。
        let _ = fs::remove_dir_all(self.captures_dir(id)?);
        Ok(())
    }

    fn path(&self, id: &str) -> Result<PathBuf, GroupError> {
        // 身份只用于文件名：不接受能跳出目录的字符。
        if id.is_empty()
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(GroupError::UnknownGroup);
        }
        Ok(self.dir.join(format!("{id}.{EXTENSION}")))
    }

    fn write(&self, group: &ReferenceGroup) -> Result<(), GroupError> {
        let path = self.path(&group.id)?;
        let has_captures = group.members.iter().any(|m| m.library_id().is_none());
        let file = GroupFile {
            format: FORMAT.to_owned(),
            format_version: if has_captures {
                CAPTURE_FORMAT_VERSION
            } else {
                FORMAT_VERSION
            },
            group: group.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&file).map_err(io::Error::other)?;
        Ok(write_atomically(&path, &bytes)?)
    }
}

/// 读参考组文件内容：先核对格式与版本，新版本写的文件按版本报错，而不是“已损坏”。
pub fn parse(bytes: &[u8]) -> Result<ReferenceGroup, GroupError> {
    let header: Header =
        serde_json::from_slice(bytes).map_err(|e| GroupError::Invalid(e.to_string()))?;
    if header.format.as_deref() != Some(FORMAT) {
        return Err(GroupError::Invalid("不是 Kinshoko 参考组".into()));
    }
    match header.format_version {
        Some(FORMAT_VERSION | CAPTURE_FORMAT_VERSION) => {}
        Some(v) if v > CAPTURE_FORMAT_VERSION => return Err(GroupError::UnsupportedVersion(v)),
        _ => return Err(GroupError::Invalid("格式版本不对".into())),
    }
    let file: GroupFile =
        serde_json::from_slice(bytes).map_err(|e| GroupError::Invalid(e.to_string()))?;
    file.group.validate()?;
    Ok(file.group)
}

fn valid_name(name: &str) -> Result<String, GroupError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(GroupError::InvalidName);
    }
    Ok(name.to_owned())
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
