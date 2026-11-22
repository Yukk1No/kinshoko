//! 打开桌面：读桌面状态与参考组（第一次时迁移）、测试用的不落盘桌面、启动时恢复钉图。

use super::*;

impl Desk {
    /// 打开 `dir`（应用数据目录，与 `pins.json` 同级）下的桌面状态。还没有时迁移：现有参考组都算常用，
    /// 文件一个字节都不改；`pins.json` 里的钉图成为一个没有名称的参考组，摆在桌面上。
    /// 钉图要等 [`Self::restore`] 才钉出。
    pub fn open(
        dir: &Path,
        groups: ReferenceGroups,
        history: &mut CaptureHistory,
    ) -> Result<Desk, GroupError> {
        let state_path = state::path(dir);
        let file = match state::load(&state_path)? {
            Loaded::Found(file) => file,
            Loaded::Missing => migrate::migrate(dir, &groups, history, &state_path)?,
        };
        let on_desk = file
            .on_desk
            .as_ref()
            .and_then(|id| groups.get(id).ok())
            .map(Held::saved);
        // 参考组文件不在了（例如被别的程序删掉）：不再记着。读不懂的文件还在，照样记着。
        let listed: BTreeSet<String> = groups.list()?.into_iter().map(|s| s.id).collect();
        let mut favorites = file.favorites;
        favorites.retain(|id| listed.contains(id));
        let mut used_at = file.used_at;
        used_at.retain(|id, _| listed.contains(id));
        Ok(Desk {
            groups,
            state_path,
            on_desk,
            left: Vec::new(),
            pins: Vec::new(),
            favorites,
            used_at,
            trashed_from_desk: BTreeSet::new(),
            untrashed: BTreeSet::new(),
            unpin_after_flush: Vec::new(),
            dirty: false,
            members_changed: false,
        })
    }

    /// 启动时钉出桌面上的参考组：与 [`Self::switch_to`] 得到的一样，再把离开了所有显示器的拉回屏幕。
    pub fn restore(&mut self, history: &mut CaptureHistory, monitors: &[ScreenRect]) -> OpenedPins {
        let mut opened = self.open_pinned(history, |_| true);
        for pin in &mut opened.pins {
            let (x, y) = pull_onto_screen(pin.rect(), monitors);
            if (x, y) != (pin.placement.x, pin.placement.y) {
                pin.placement.x = x;
                pin.placement.y = y;
                self.dirty = true;
            }
        }
        self.pins = opened.pins.clone();
        self.sync_all();
        opened
    }
}
