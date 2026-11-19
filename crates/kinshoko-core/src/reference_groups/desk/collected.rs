//! 收藏截图后，参考组成员与桌面上的钉图改连到参考图。

use super::{Collected, Desk, Held};
use crate::desktop::{CaptureHistory, CollectedCapture, GroupMemberRef, PinContent};
use crate::reference_groups::GroupError;

impl Desk {
    /// 截图历史条目 `capture_id` 收藏成了 `collected`：与它关联的组内截图成员（包括桌面上的）改为
    /// 引用那张参考图；桌面上显示它的钉图改为参考图钉图。
    pub fn collected(
        &mut self,
        history: &mut CaptureHistory,
        capture_id: &str,
        collected: &CollectedCapture,
    ) -> Result<Collected, GroupError> {
        // 先落盘：改连读写的是参考组文件。
        self.flush()?;
        let report = self.groups.relink_collected(history, capture_id, collected);
        let Some(desk) = self.desk_id() else {
            return Ok(Collected {
                report,
                converted: Vec::new(),
            });
        };
        let mine: Vec<&GroupMemberRef> = report
            .relinked
            .iter()
            .filter(|m| m.group_id == desk)
            .collect();
        let mut converted = Vec::new();
        if !mine.is_empty() {
            let group = self.groups.get(&desk)?;
            for pin in &mut self.pins {
                let Some(member) = pin.member.as_ref().filter(|m| mine.contains(m)) else {
                    continue;
                };
                let Some(old) = pin.capture_id().map(str::to_owned) else {
                    continue;
                };
                let Some(m) = group.members.iter().find(|m| m.id == member.member_id) else {
                    continue;
                };
                pin.content = PinContent::Reference {
                    library_id: collected.library_id.clone(),
                    image_id: collected.image_id.clone(),
                    source_width: m.source_width,
                    source_height: m.source_height,
                };
                history.unpin(&old);
                converted.push(pin.clone());
            }
            self.on_desk = Some(Held::saved(group));
        }
        Ok(Collected { report, converted })
    }
}
