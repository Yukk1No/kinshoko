//! 参考组（ReferenceGroups，#66、ADR-0002）：为同一参考目的组织、独立于资料库保存的一组参考组成员。
//!
//! - 每个参考组一个带版本号的 JSON（`format: "kinshoko.reference-group"`），放在应用数据目录的
//!   `reference-groups/` 下，不属于任何资料库；图片及其元数据仍归资料库所有。
//! - 参考组成员按“资料库＋参考图”引用，可跨资料库；各自保存裁切、翻转、旋转、位置、尺寸与缩放
//!   （[`Placement`] 与桌面钉图同义）。透明度、锁定只属于桌面，不进参考组。
//! - 同一张图在不同参考组里是不同的成员，互不影响；同一参考组里两块局部也是两个成员。
//! - 打开参考组得到一组新的桌面钉图（[`ReferenceGroup::pins`]），钉图记得来自哪个成员
//!   （[`GroupMemberRef`]），存回时更新那个成员（[`ReferenceGroups::save_pins`]）。
//! - 成员能否显示由 [`References`] 跨库核对：资料库没登记、不可用、图已删除时标出原因，
//!   成员与布局原样保留。
//! - 永久删除（#67）预览时经参考组用途 port（[`ReferenceGroupUsage`]）查询受影响的参考组。
//!
//! 每次改动先写临时文件并落盘，再改名替换，写到一半断电也不会留下半份。

mod resolve;

use std::collections::BTreeSet;
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::desktop::{
    GroupMemberRef, MAX_SCALE, MIN_SCALE, PinContent, Placement, Region, SavedPin,
};
use crate::library::ReferenceImage;

pub use resolve::{
    DetachedLenses, MemberState, MemberStatus, ReferenceSource, References, UnavailableReason,
    resolve,
};

const FORMAT: &str = "kinshoko.reference-group";
const FORMAT_VERSION: u32 = 1;
const EXTENSION: &str = "json";

/// 参考组的错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupError {
    /// 读写参考组文件失败。
    Io(String),
    /// 没有这个参考组（或已删除）。
    UnknownGroup,
    /// 名称是空的。
    InvalidName,
    /// 没有可以存进参考组的资料库钉图（截图要先收藏）。
    NoMembers,
    /// 文件由更新版本的 Kinshoko 写成，这一版读不懂。
    UnsupportedVersion(u32),
    /// 文件不是合法的参考组。
    Invalid(String),
}

impl fmt::Display for GroupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GroupError::Io(e) => write!(f, "无法读写参考组：{e}"),
            GroupError::UnknownGroup => write!(f, "没有这个参考组，可能已被删除"),
            GroupError::InvalidName => write!(f, "参考组名称不能为空"),
            GroupError::NoMembers => {
                write!(
                    f,
                    "桌面上没有资料库中的钉图；截图要先收藏进资料库才能存进参考组"
                )
            }
            GroupError::UnsupportedVersion(v) => {
                write!(
                    f,
                    "参考组由更新版本的 Kinshoko 保存（格式版本 {v}），请升级后打开"
                )
            }
            GroupError::Invalid(why) => write!(f, "参考组文件已损坏：{why}"),
        }
    }
}

impl std::error::Error for GroupError {}

impl From<io::Error> for GroupError {
    fn from(e: io::Error) -> Self {
        GroupError::Io(e.to_string())
    }
}

/// 参考组成员：参考视图在这个参考组里的一次使用。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GroupMember {
    /// 在参考组内唯一。
    pub id: String,
    pub library_id: String,
    pub image_id: String,
    /// 原图尺寸：局部总能核对是否在图内，资料库不在时也能按原尺寸保留布局。
    pub source_width: u32,
    pub source_height: u32,
    /// 只显示原图的这一块（原图像素）；`None` 为整图。
    pub crop: Option<Region>,
    /// 位置、缩放、翻转与旋转；尺寸由局部与缩放得出。
    pub placement: Placement,
}

impl GroupMember {
    /// 资料库钉图对应的成员；截图钉图为 `None`。
    fn from_pin(id: String, pin: &SavedPin) -> Option<GroupMember> {
        let PinContent::Reference {
            library_id,
            image_id,
            source_width,
            source_height,
        } = &pin.content
        else {
            return None;
        };
        Some(GroupMember {
            id,
            library_id: library_id.clone(),
            image_id: image_id.clone(),
            source_width: *source_width,
            source_height: *source_height,
            crop: pin.crop,
            placement: pin.placement,
        })
    }

    /// 打开成员得到的钉图（不透明、不锁定）。局部超出原图等不合法时为 `Err`。
    fn pin(&self, pin_id: &str, group_id: &str) -> Result<SavedPin, String> {
        let p = &self.placement;
        if !(p.scale.is_finite() && (MIN_SCALE..=MAX_SCALE).contains(&p.scale)) {
            return Err(format!("成员 {} 的缩放不合法", self.id));
        }
        if p.rotation > 3 {
            return Err(format!("成员 {} 的旋转不合法", self.id));
        }
        let image = ReferenceImage {
            id: self.image_id.clone(),
            width: self.source_width,
            height: self.source_height,
            sealed: false,
        };
        let mut pin = SavedPin::reference(pin_id, &self.library_id, &image, self.crop, *p)
            .map_err(|e| format!("成员 {}：{e}", self.id))?;
        pin.member = Some(GroupMemberRef {
            group_id: group_id.to_owned(),
            member_id: self.id.clone(),
        });
        Ok(pin)
    }
}

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
}

impl ReferenceGroup {
    /// 打开参考组：每个成员一个新的桌面钉图，按成员的先后，带着各自的局部与摆放。
    pub fn pins(&self) -> Vec<SavedPin> {
        self.members
            .iter()
            .filter_map(|m| m.pin(&new_id(), &self.id).ok())
            .collect()
    }

    /// 引用到的资料库，按首次出现的先后。
    pub fn library_ids(&self) -> Vec<String> {
        let mut seen = BTreeSet::new();
        self.members
            .iter()
            .filter(|m| seen.insert(m.library_id.as_str()))
            .map(|m| m.library_id.clone())
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
            m.pin("check", &self.id).map_err(GroupError::Invalid)?;
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
        let header: Header =
            serde_json::from_slice(&bytes).map_err(|e| GroupError::Invalid(e.to_string()))?;
        if header.format.as_deref() != Some(FORMAT) {
            return Err(GroupError::Invalid("不是 Kinshoko 参考组".into()));
        }
        match header.format_version {
            Some(FORMAT_VERSION) => {}
            Some(v) if v > FORMAT_VERSION => return Err(GroupError::UnsupportedVersion(v)),
            _ => return Err(GroupError::Invalid("格式版本不对".into())),
        }
        let file: GroupFile =
            serde_json::from_slice(&bytes).map_err(|e| GroupError::Invalid(e.to_string()))?;
        if file.group.id != id {
            return Err(GroupError::Invalid("文件名与参考组身份不符".into()));
        }
        file.group.validate()?;
        Ok(file.group)
    }

    /// 把桌面上的资料库钉图存成新的参考组。截图钉图不进组（要先收藏）；一张也没有时为
    /// [`GroupError::NoMembers`]。
    pub fn create(&self, name: &str, pins: &[SavedPin]) -> Result<ReferenceGroup, GroupError> {
        let name = valid_name(name)?;
        let members: Vec<GroupMember> = pins
            .iter()
            .filter_map(|p| GroupMember::from_pin(new_id(), p))
            .collect();
        if members.is_empty() {
            return Err(GroupError::NoMembers);
        }
        let now = crate::library::now_ms();
        let group = ReferenceGroup {
            id: new_id(),
            name,
            created_at: now,
            updated_at: now,
            members,
        };
        self.write(&group)?;
        Ok(group)
    }

    /// 把桌面钉图存回参考组 `id`：来自这个参考组成员的钉图更新那个成员（局部、位置、尺寸、缩放、
    /// 翻转与旋转）；其他资料库钉图加为新成员；不在桌面上的成员原样保留。截图钉图不进组。
    pub fn save_pins(&self, id: &str, pins: &[SavedPin]) -> Result<ReferenceGroup, GroupError> {
        let mut group = self.get(id)?;
        for pin in pins {
            let existing = pin
                .member
                .as_ref()
                .filter(|m| m.group_id == group.id)
                .and_then(|m| group.members.iter().position(|x| x.id == m.member_id));
            match existing {
                Some(at) => {
                    let member_id = group.members[at].id.clone();
                    if let Some(m) = GroupMember::from_pin(member_id, pin) {
                        group.members[at] = m;
                    }
                }
                None => group.members.extend(GroupMember::from_pin(new_id(), pin)),
            }
        }
        group.updated_at = crate::library::now_ms();
        self.write(&group)?;
        Ok(group)
    }

    /// 从参考组中去掉一个成员。
    pub fn remove_member(&self, id: &str, member_id: &str) -> Result<ReferenceGroup, GroupError> {
        let mut group = self.get(id)?;
        group.members.retain(|m| m.id != member_id);
        group.updated_at = crate::library::now_ms();
        self.write(&group)?;
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

    /// 删除参考组文件。引用的图与资料库不受影响。
    pub fn delete(&self, id: &str) -> Result<(), GroupError> {
        match fs::remove_file(self.path(id)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Err(GroupError::UnknownGroup),
            Err(e) => Err(e.into()),
        }
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
        let file = GroupFile {
            format: FORMAT.to_owned(),
            format_version: FORMAT_VERSION,
            group: group.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&file).map_err(io::Error::other)?;
        let tmp = self.dir.join(format!(".{}.tmp-{}", group.id, new_id()));
        let written = (|| {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(&bytes)?;
            f.sync_all()?;
            fs::rename(&tmp, &path)
        })();
        if written.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        Ok(written?)
    }
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
            for m in &group.members {
                if m.library_id == library_id
                    && image_ids.contains(&m.image_id)
                    && !used.contains(&m.image_id)
                {
                    used.push(m.image_id.clone());
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
