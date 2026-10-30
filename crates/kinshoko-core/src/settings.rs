//! 应用壳设置：本设备上与具体资料库无关的偏好（开机自启、全局快捷键、安全模式、相近标签来源标记、
//! 诊断开关、运行日志与更新通道）。
//!
//! 保存在数据根目录（`data_dirs`）的 `settings.json`。后续的设置（钉图、模型选择、诊断开关等）
//! 在 [`SettingsSnapshot`] 上加带默认值的字段即可；不认识的字段原样保留，旧版本打开新版本
//! 写的文件不会丢掉它们。
//!
//! 例外：界面缩放（`ui_scale`）只属于这台电脑的屏幕，单独存放，不进这里，也就不进程序设置备份。

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::app_shell::{UpdateChannel, app_info};
use crate::diagnostics::run_log_default_for_version;
use crate::library::SafeModeScope;
use crate::tagging::{Device, catalog};

const FILE_NAME: &str = "settings.json";
const BROKEN_FILE_NAME: &str = "settings.broken.json";
const FORMAT_VERSION: u32 = 1;
/// 详情面板可拖到的宽度范围（#157），单位 CSS 像素。没保存过时界面用 320。
const INSPECTOR_WIDTH: std::ops::RangeInclusive<u32> = 280..=560;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ViewerBackground {
    Dark,
    Mid,
    Light,
    Checker,
}

/// 详情面板与查看器里标签的外观（#160）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TagStyle {
    /// 模型标签按可信度分三档底色（默认）。
    #[default]
    Bands,
    /// 详情面板按出处分组，模型标签底边一条可信度刻度。
    Grouped,
}

/// 标签外观与可信度分档（#160）。阈值按两位小数保存，必须满足 `0 ≤ low < high ≤ 1`。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct TagDisplay {
    pub style: TagStyle,
    /// 高档下限：可信度不低于它的模型标签归高档。
    pub high: f32,
    /// 低档上限：可信度低于它的模型标签归低档。
    pub low: f32,
    /// 低档标签加虚线外框；默认开（维护者验收决定），关掉后只把字变浅。
    pub low_outline: bool,
}

impl Default for TagDisplay {
    /// 默认阈值来自维护者测试库的 13,837 个模型标签：0.80 / 0.40 让高、中、低三档大约各占三分之一。
    fn default() -> Self {
        TagDisplay {
            style: TagStyle::Bands,
            high: 0.8,
            low: 0.4,
            low_outline: true,
        }
    }
}

impl TagDisplay {
    fn thresholds_valid(&self) -> bool {
        (0.0..=1.0).contains(&self.low) && (0.0..=1.0).contains(&self.high) && self.low < self.high
    }
}

/// 可以绑定全局快捷键的动作。默认键沿用 Snipaste 的习惯。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ShortcutAction {
    /// 框选屏幕区域截图。
    Capture,
    /// 把剪贴板里的图片钉到桌面。
    PinClipboard,
    /// 把全部钉图收到屏幕边缘，再按一次回到原位。
    HideAllPins,
}

impl ShortcutAction {
    pub const ALL: [ShortcutAction; 3] = [
        ShortcutAction::Capture,
        ShortcutAction::PinClipboard,
        ShortcutAction::HideAllPins,
    ];

    /// 设置界面和提示里的动作名称。
    pub fn label(self) -> &'static str {
        match self {
            ShortcutAction::Capture => "截图",
            ShortcutAction::PinClipboard => "钉剪贴板",
            ShortcutAction::HideAllPins => "收起全部钉图",
        }
    }

    fn default_accelerator(self) -> &'static str {
        match self {
            ShortcutAction::Capture => "F1",
            ShortcutAction::PinClipboard => "F3",
            ShortcutAction::HideAllPins => "F4",
        }
    }
}

/// 磁盘上的格式。字段都有默认值，缺了就按新安装处理。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsSnapshot {
    version: u32,
    autostart: bool,
    /// 每个动作的快捷键；`None` 表示画师清除了绑定。没写到的动作用默认键。
    shortcuts: BTreeMap<ShortcutAction, Option<String>>,
    /// 旧版本保存的打标模型（模型 key）。读取时换算成硬件档；画师再选硬件档时清掉。
    tagging_model: Option<String>,
    /// 画师选的打标硬件档；`None` 为按本机条件自动选择（旧版本的 `tagging_model` 见上）。
    tagging_device: Option<Device>,
    /// 安全模式（#60）：新安装默认开启。
    safe_mode: bool,
    /// 安全模式范围（#223）：没写过时为默认的“敏感及以上”，老用户升级后行为不变。
    safe_mode_scope: SafeModeScope,
    /// 在查找条件里标出相近标签来自内置还是个人近似对应表（#56），默认不显示。
    show_approx_source: bool,
    /// 诊断开关“强制 sRGB”（ADR-0005）：WebView2 把显示器当作 sRGB，不按显示器配置文件做色彩管理。
    /// WebView2 环境在进程启动时建好，所以重启后才生效。
    force_srgb: bool,
    viewer_background: Option<ViewerBackground>,
    /// 切换安全模式时保留当前选择和详情面板；默认关闭，切换即清空选择。
    keep_selection_on_safe_mode: bool,
    /// 增强钉图边缘（#239）：钉图阴影外再加一圈浅色细线，在深色画布上也分得清；默认关闭。
    pin_edge_contrast: bool,
    /// 运行日志（#219）：只写本机，由画师决定是否导出；没选过时为空，按当前构建的版本号决定。
    run_log: Option<bool>,
    /// 旧版的“使用日志”（#70），已并入运行日志：开过的读作开启运行日志，再保存时去掉。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    usage_log: bool,
    /// 标签外观与可信度分档（#160）。
    tag_display: TagDisplay,
    /// 主窗口详情面板的宽度（#157）；没拖过时为空。
    inspector_width: Option<u32>,
    /// 更新通道（#204）；没选过时为空，按当前构建的版本号决定。
    update_channel: Option<UpdateChannel>,
    /// 新版本写入、本版本不认识的字段。
    #[serde(flatten)]
    unknown: serde_json::Map<String, serde_json::Value>,
}

impl Default for SettingsSnapshot {
    fn default() -> Self {
        SettingsSnapshot {
            version: FORMAT_VERSION,
            autostart: true,
            shortcuts: BTreeMap::new(),
            tagging_model: None,
            tagging_device: None,
            safe_mode: true,
            safe_mode_scope: SafeModeScope::default(),
            show_approx_source: false,
            force_srgb: false,
            viewer_background: None,
            keep_selection_on_safe_mode: false,
            pin_edge_contrast: false,
            run_log: None,
            usage_log: false,
            tag_display: TagDisplay::default(),
            inspector_width: None,
            update_channel: None,
            unknown: serde_json::Map::new(),
        }
    }
}

/// 本设备的应用壳设置。每次修改都立即写回磁盘。
#[derive(Debug, Clone)]
pub struct AppSettings {
    path: PathBuf,
    file: SettingsSnapshot,
    /// 打开设置时的“强制 sRGB”：本次运行的 WebView2 按它启动，改设置不影响。
    force_srgb_in_effect: bool,
}

#[derive(Debug)]
pub enum SettingsError {
    Io(io::Error),
    /// 标签外观的分档阈值不合要求，没有保存。
    TagThresholds,
}

impl fmt::Display for SettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SettingsError::Io(e) => write!(f, "读写设置文件失败：{e}"),
            SettingsError::TagThresholds => {
                f.write_str("低档上限要小于高档下限，且都在 0 到 1 之间")
            }
        }
    }
}

impl std::error::Error for SettingsError {}

impl From<io::Error> for SettingsError {
    fn from(e: io::Error) -> Self {
        SettingsError::Io(e)
    }
}

impl SettingsSnapshot {
    pub(crate) fn complete_portable(&self) -> Self {
        let mut snapshot = self.clone();
        snapshot
            .viewer_background
            .get_or_insert(ViewerBackground::Mid);
        snapshot
    }
    pub(crate) fn safe_mode(&self) -> bool {
        self.safe_mode
    }
    pub(crate) fn force_srgb(&self) -> bool {
        self.force_srgb
    }
    pub(crate) fn validate(&self) -> Result<(), crate::CommandError> {
        use crate::command_error::ErrorKind;
        if self.version != FORMAT_VERSION {
            return Err(crate::CommandError::new(
                ErrorKind::SettingsPackageIncompatible,
                "设置包由不兼容版本创建，请更新 Kinshoko",
            ));
        }
        let mut used = std::collections::BTreeSet::new();
        for action in ShortcutAction::ALL {
            let accelerator = match self.shortcuts.get(&action) {
                Some(value) => value.as_deref(),
                None => Some(action.default_accelerator()),
            };
            if let Some(accelerator) = accelerator {
                let normalized =
                    crate::shortcuts::normalize(accelerator).map_err(crate::CommandError::from)?;
                if !used.insert(normalized) {
                    return Err(crate::CommandError::new(
                        ErrorKind::SettingsPackageSharedShortcut,
                        "设置包中多个动作使用同一快捷键",
                    ));
                }
            }
        }
        Ok(())
    }
}
impl AppSettings {
    /// 打开 `dir` 下的设置；目录或文件不存在时按新安装的默认值。
    pub fn open(dir: &Path) -> Result<Self, SettingsError> {
        let path = dir.join(FILE_NAME);
        let file = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(file) => file,
                Err(_) => {
                    // 读不懂的设置不能让常驻进程起不来：留一份原样副本备查，按默认值继续。
                    fs::write(dir.join(BROKEN_FILE_NAME), &bytes)?;
                    SettingsSnapshot::default()
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => SettingsSnapshot::default(),
            Err(e) => return Err(e.into()),
        };
        Ok(AppSettings {
            path,
            force_srgb_in_effect: file.force_srgb,
            file,
        })
    }

    pub fn viewer_background(&self) -> Option<ViewerBackground> {
        self.file.viewer_background
    }
    pub fn set_viewer_background(
        &mut self,
        background: ViewerBackground,
    ) -> Result<(), SettingsError> {
        self.update(|f| f.viewer_background = Some(background))
    }
    pub fn migrate_viewer_background(
        &mut self,
        legacy: ViewerBackground,
    ) -> Result<(), SettingsError> {
        if self.file.viewer_background.is_none() {
            self.set_viewer_background(legacy)?;
        }
        Ok(())
    }
    pub fn autostart(&self) -> bool {
        self.file.autostart
    }

    pub fn set_autostart(&mut self, on: bool) -> Result<(), SettingsError> {
        self.update(|f| f.autostart = on)
    }

    /// 画师选的打标硬件档；`None` 表示自动选择。旧版本保存的模型 key 按它所在的硬件档换算
    /// （FP16 条目是显卡，FP32 条目是 CPU），不认识的 key 当作自动。
    pub fn tagging_device(&self) -> Option<Device> {
        self.file.tagging_device.or_else(|| {
            let key = self.file.tagging_model.as_deref()?;
            catalog()
                .into_iter()
                .find(|spec| spec.key == key)
                .map(|spec| spec.device)
        })
    }

    pub fn set_tagging_device(&mut self, device: Option<Device>) -> Result<(), SettingsError> {
        self.update(|f| {
            f.tagging_device = device;
            f.tagging_model = None;
        })
    }

    /// 安全模式是否开启。
    pub fn safe_mode(&self) -> bool {
        self.file.safe_mode
    }

    pub fn set_safe_mode(&mut self, on: bool) -> Result<(), SettingsError> {
        self.update(|f| f.safe_mode = on)
    }

    /// 安全模式范围（#223）。
    pub fn safe_mode_scope(&self) -> SafeModeScope {
        self.file.safe_mode_scope
    }

    pub fn set_safe_mode_scope(&mut self, scope: SafeModeScope) -> Result<(), SettingsError> {
        self.update(|f| f.safe_mode_scope = scope)
    }

    /// 查找条件里是否标出相近标签的来源（内置／个人）。
    pub fn show_approx_source(&self) -> bool {
        self.file.show_approx_source
    }

    pub fn set_show_approx_source(&mut self, on: bool) -> Result<(), SettingsError> {
        self.update(|f| f.show_approx_source = on)
    }

    /// 切换安全模式时是否保留当前选择。
    pub fn keep_selection_on_safe_mode(&self) -> bool {
        self.file.keep_selection_on_safe_mode
    }

    pub fn set_keep_selection_on_safe_mode(&mut self, on: bool) -> Result<(), SettingsError> {
        self.update(|f| f.keep_selection_on_safe_mode = on)
    }

    /// 增强钉图边缘（#239）。
    pub fn pin_edge_contrast(&self) -> bool {
        self.file.pin_edge_contrast
    }

    pub fn set_pin_edge_contrast(&mut self, on: bool) -> Result<(), SettingsError> {
        self.update(|f| f.pin_edge_contrast = on)
    }

    /// 设置里保存的“强制 sRGB”，下次启动时生效。
    pub fn force_srgb(&self) -> bool {
        self.file.force_srgb
    }

    /// 本次运行实际采用的“强制 sRGB”（启动时读到的值）。
    pub fn force_srgb_in_effect(&self) -> bool {
        self.force_srgb_in_effect
    }

    pub fn set_force_srgb(&mut self, on: bool) -> Result<(), SettingsError> {
        self.update(|f| f.force_srgb = on)
    }

    /// 是否记录运行日志。画师选过就按画师的；开过旧版使用日志的算开启；
    /// 都没有时见 [`run_log_default_for_version`]。
    pub fn run_log(&self) -> bool {
        self.file.run_log.unwrap_or_else(|| {
            self.file.usage_log || run_log_default_for_version(&app_info().version)
        })
    }

    pub fn set_run_log(&mut self, on: bool) -> Result<(), SettingsError> {
        self.update(|f| {
            f.run_log = Some(on);
            f.usage_log = false;
        })
    }

    /// 标签外观与可信度分档。文件里的阈值交叉或越界时（例如手改过）按默认阈值，其余照读。
    pub fn tag_display(&self) -> TagDisplay {
        let saved = self.file.tag_display;
        if saved.thresholds_valid() {
            return saved;
        }
        let defaults = TagDisplay::default();
        TagDisplay {
            high: defaults.high,
            low: defaults.low,
            ..saved
        }
    }

    /// 保存标签外观；低档上限不小于高档下限、或阈值不在 0–1 之间时拒绝，原来的设置不变。
    pub fn set_tag_display(&mut self, display: TagDisplay) -> Result<(), SettingsError> {
        if !display.thresholds_valid() {
            return Err(SettingsError::TagThresholds);
        }
        self.update(|f| f.tag_display = display)
    }

    /// 主窗口详情面板的宽度；`None` 表示没拖过。
    pub fn inspector_width(&self) -> Option<u32> {
        self.file.inspector_width
    }

    /// 保存详情面板的宽度，超出 280–560 时停在边界上。
    pub fn set_inspector_width(&mut self, width: u32) -> Result<(), SettingsError> {
        let width = width.clamp(*INSPECTOR_WIDTH.start(), *INSPECTOR_WIDTH.end());
        self.update(|f| f.inspector_width = Some(width))
    }

    /// 检查更新用的通道。画师选过就按画师的；没选过时测试版、候选版构建用测试版通道，
    /// 正式版构建用正式版通道。测试版通道装上正式版后仍留在测试版通道（选择不随版本变）。
    pub fn update_channel(&self) -> UpdateChannel {
        self.file
            .update_channel
            .unwrap_or_else(|| UpdateChannel::default_for_version(&app_info().version))
    }

    pub fn set_update_channel(&mut self, channel: UpdateChannel) -> Result<(), SettingsError> {
        self.update(|f| f.update_channel = Some(channel))
    }

    /// 启动时调用：没选过通道时按当前构建记下默认通道。测试版、候选版构建因此记下测试版通道，
    /// 从测试版通道装上正式版后，新版本读到的仍是测试版通道，不会按正式版的版本号改回正式版通道。
    pub fn remember_update_channel(&mut self) -> Result<(), SettingsError> {
        if self.file.update_channel.is_some() {
            return Ok(());
        }
        let channel = self.update_channel();
        self.set_update_channel(channel)
    }

    /// 动作当前绑定的快捷键；`None` 表示未绑定。
    pub fn shortcut(&self, action: ShortcutAction) -> Option<&str> {
        match self.file.shortcuts.get(&action) {
            Some(bound) => bound.as_deref(),
            None => Some(action.default_accelerator()),
        }
    }

    /// 只由 [`crate::GlobalShortcuts`] 调用：设置里的键要和系统里注册的保持一致。
    pub(crate) fn set_shortcut(
        &mut self,
        action: ShortcutAction,
        accelerator: Option<&str>,
    ) -> Result<(), SettingsError> {
        self.update(|f| {
            f.shortcuts.insert(action, accelerator.map(str::to_owned));
        })
    }

    /// Complete portable settings, including explicit cleared shortcuts and future fields.
    pub fn snapshot(&self) -> SettingsSnapshot {
        self.file.clone()
    }

    pub fn replace(&mut self, snapshot: &SettingsSnapshot) -> Result<(), SettingsError> {
        write_atomically(&self.path, snapshot)?;
        self.file = snapshot.clone();
        Ok(())
    }

    /// 改动先写入磁盘，成功后才生效；写入失败时内存里的设置保持原样。
    fn update(&mut self, change: impl FnOnce(&mut SettingsSnapshot)) -> Result<(), SettingsError> {
        let mut next = self.file.clone();
        change(&mut next);
        next.version = FORMAT_VERSION;
        write_atomically(&self.path, &next)?;
        self.file = next;
        Ok(())
    }
}

/// 先写同目录的临时文件再改名，断电或崩溃时不会留下写了一半的设置。
fn write_atomically(path: &Path, file: &SettingsSnapshot) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let bytes = serde_json::to_vec_pretty(file).map_err(io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    use std::io::Write as _;
    let mut file = fs::File::create(&tmp)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, path)
}
