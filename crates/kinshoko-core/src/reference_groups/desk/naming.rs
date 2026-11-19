//! 改名、收藏与取消收藏（界面写“收藏”，#588 11-19 晚；`desk.json` 里仍叫 `favorites`）。

use super::{Desk, blank};
use crate::reference_groups::{GroupError, ReferenceGroup};

impl Desk {
    /// 改名。名称可以为空（回到“未命名”）。
    pub fn rename(&mut self, id: &str, name: &str) -> Result<ReferenceGroup, GroupError> {
        if let Some(held) = self.on_desk.as_mut().filter(|h| h.group.id == id) {
            held.group.name = name.trim().to_owned();
            self.dirty = true;
            self.flush()?;
            return Ok(self
                .on_desk
                .as_ref()
                .map_or_else(blank, |h| h.group.clone()));
        }
        self.flush()?;
        let mut group = self.groups.get(id)?;
        group.name = name.trim().to_owned();
        group.updated_at = crate::library::now_ms();
        self.groups.commit(&group, &[])?;
        Ok(group)
    }

    /// 设为常用（排在常用的最后）或取消常用。参考组不在时报错。
    pub fn set_favorite(&mut self, id: &str, favorite: bool) -> Result<(), GroupError> {
        let known = self.desk_id().as_deref() == Some(id)
            || self.left.iter().any(|h| h.group.id == id)
            || self.groups.get(id).is_ok();
        if !known {
            return Err(GroupError::UnknownGroup);
        }
        let before = self.favorites.clone();
        self.favorites.retain(|x| x != id);
        if favorite {
            match before.iter().position(|x| x == id) {
                // 已经是常用的不挪位置。
                Some(at) => self.favorites.insert(at, id.to_owned()),
                None => self.favorites.push(id.to_owned()),
            }
        }
        if let Err(e) = self.save_state() {
            self.favorites = before;
            return Err(e.into());
        }
        Ok(())
    }
}
