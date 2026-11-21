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
            persist: true,
            members_changed: false,
        })
    }

    /// 打不开 `dir` 下的桌面状态时（[`Self::open`] 出错）用的一张空桌：没有常用，参考组都按用过的时间分段，
    /// 可以照常切换、钉图；参考组文件照常写，`desk.json` 不写，下次启动再试着打开（或迁移）。
    pub fn unsaved(dir: &Path, groups: ReferenceGroups) -> Desk {
        Desk {
            groups,
            state_path: state::path(dir),
            on_desk: None,
            left: Vec::new(),
            pins: Vec::new(),
            favorites: Vec::new(),
            used_at: Default::default(),
            trashed_from_desk: BTreeSet::new(),
            untrashed: BTreeSet::new(),
            unpin_after_flush: Vec::new(),
            dirty: false,
            persist: false,
            members_changed: false,
        }
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
