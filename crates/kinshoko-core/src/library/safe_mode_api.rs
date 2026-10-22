//! 资料库句柄上的安全模式开关与范围（从 library/mod.rs 原样搬出）。

use super::*;

impl Library {
    /// 安全模式是否开启。
    pub fn safe_mode(&self) -> bool {
        self.inner.safe_mode()
    }

    /// 安全模式范围（#223）。
    pub fn safe_mode_scope(&self) -> SafeModeScope {
        self.inner.safe().scope
    }

    /// 开关安全模式，范围不变。状态变化时推送 [`LibraryEvent::SafeModeChanged`]：已取得的
    /// 浏览结果、计数、词表与详情都要重新读取。
    pub fn set_safe_mode(&self, on: bool) {
        if self.inner.update_safe(|mode| SafeMode { on, ..mode }).on != on {
            self.inner.hub.publish(LibraryEvent::SafeModeChanged {
                library_id: self.inner.info.id.clone(),
                on,
            });
        }
    }

    /// 调整安全模式范围（#223），开关不变。处理方式与开关安全模式相同：范围变了时，可写的句柄
    /// 让列表修订号与词表修订号前进（旧的分页游标作废），并推送 [`LibraryEvent::ListStale`] 与
    /// [`LibraryEvent::VocabularyChanged`]。安全模式关闭时它只改变查找里“R18”的含义，仍照此处理。
    /// 只读打开的句柄不写数据库，只换视角（游标与工作区快照也按视角区分）。
    ///
    /// 视角先换上；写修订号失败时返回错误，视角不回退。刚打开、还没交出结果的句柄用
    /// [`Self::init_safe_mode_scope`]。
    pub fn set_safe_mode_scope(&self, scope: SafeModeScope) -> Result<(), Error> {
        if self
            .inner
            .update_safe(|mode| SafeMode { scope, ..mode })
            .scope
            == scope
            || self.inner.detached
        {
            return Ok(());
        }
        let revision = self.inner.write(|tx| {
            tx.execute("UPDATE list_revision SET value = value + 1", [])?;
            tags::bump_revision(tx)
        })?;
        self.inner.hub.publish(LibraryEvent::VocabularyChanged {
            library_id: self.inner.info.id.clone(),
            revision,
        });
        Ok(())
    }

    /// 给刚打开的句柄设上安全模式范围：只换视角，不写修订号、不推送变化（它还没有交出
    /// 任何结果；游标与工作区快照本来就按视角区分）。
    pub(crate) fn init_safe_mode_scope(&self, scope: SafeModeScope) {
        self.inner.update_safe(|mode| SafeMode { scope, ..mode });
    }
}
