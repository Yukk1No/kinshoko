//! F1 的选区完成动作。原生窗口先固定可见范围和遮挡，再由这里决定参考视图或普通截图。
use image::RgbaImage;

use super::history::PreparedCapture;

use super::{
    CaptureAction, CaptureEntry, CaptureHistory, HistoryError, PinContent, PinVeils, Region,
    SavedPin, ScreenRect, Screenshot,
};
use crate::reference_groups::{ReferenceSource, UnavailableReason};

/// 框选开始时已经画出的单张参考图，所有几何均为屏幕物理像素。
/// 原生 adapter 负责窗口身份、加载状态、可见范围和冻结时的遮挡核对。
#[derive(Debug, Clone)]
pub struct CaptureSurface {
    pub pin: SavedPin,
    pub shown: ScreenRect,
    pub visible: ScreenRect,
    pub covered: Vec<ScreenRect>,
}

impl CaptureSurface {
    /// 选区必须完整位于这张未被遮挡的参考图内；其他情况沿用普通截图。
    pub fn reference_region(&self, selected: ScreenRect) -> Option<Region> {
        if !self.visible.contains(&selected)
            || self
                .covered
                .iter()
                .any(|r| r.intersect(&selected).is_some())
        {
            return None;
        }
        self.pin.reference_region(self.shown, selected)
    }
}

/// 一次 F1 的冻结屏幕与选区。冻结屏幕只在普通截图路径上作为最终内容。
pub struct CaptureSelection<'a> {
    pub screen: &'a Screenshot,
    pub origin: (i32, i32),
    pub region: Region,
    pub references: &'a [CaptureSurface],
}

#[derive(Debug)]
pub enum CaptureOutcome {
    PinReference(SavedPin),
    PinCapture(CaptureEntry),
    CopyReference(RgbaImage),
    CopyCapture(RgbaImage),
}

/// Decoded and encoded selection data. Preparation creates no history files or OS effects.
/// The application can discard this value if authority is revoked before the final commit.
#[derive(Debug)]
pub struct CaptureDraft(PreparedOutcome);

#[derive(Debug)]
enum PreparedOutcome {
    PinReference(SavedPin),
    CopyReference(RgbaImage),
    Screenshot {
        action: CaptureAction,
        shot: Screenshot,
        history: PreparedCapture,
    },
}

impl CaptureDraft {
    /// Pixels to prepare for the OS clipboard, outside the final authority boundary.
    pub fn clipboard_image(&self) -> Option<&RgbaImage> {
        match &self.0 {
            PreparedOutcome::CopyReference(image) => Some(image),
            PreparedOutcome::Screenshot {
                action: CaptureAction::Copy,
                shot,
                ..
            } => Some(&shot.image),
            _ => None,
        }
    }

    /// Persist ordinary history only after the caller revalidates its authority.
    pub fn commit(self, history: &mut CaptureHistory) -> Result<CaptureOutcome, CaptureError> {
        Ok(match self.0 {
            PreparedOutcome::PinReference(pin) => CaptureOutcome::PinReference(pin),
            PreparedOutcome::CopyReference(image) => CaptureOutcome::CopyReference(image),
            PreparedOutcome::Screenshot {
                action,
                shot,
                history: prepared,
            } => {
                let entry = history
                    .add_prepared(prepared)
                    .map_err(CaptureError::History)?;
                match action {
                    CaptureAction::Pin => CaptureOutcome::PinCapture(entry),
                    CaptureAction::Copy => CaptureOutcome::CopyCapture(shot.image),
                }
            }
        })
    }
}

#[derive(Debug)]
pub enum CaptureError {
    EmptySelection,
    SourceUnavailable(UnavailableReason),
    SourceChanged,
    Sealed,
    Pixels(String),
    History(HistoryError),
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptySelection => write!(f, "选区是空的"),
            Self::SourceUnavailable(e) => write!(f, "{e}"),
            Self::SourceChanged => write!(f, "参考图来源已变化，请重新框选"),
            Self::Sealed => write!(f, "参考图已被遮蔽，请重新框选"),
            Self::Pixels(e) => write!(f, "读取参考图失败：{e}"),
            Self::History(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for CaptureError {}

impl CaptureSelection<'_> {
    /// 屏幕上的物理选区，支持位于显示器左侧／上侧的负坐标。
    pub fn screen_rect(&self) -> Result<ScreenRect, CaptureError> {
        Ok(ScreenRect {
            x: i32::try_from(i64::from(self.origin.0) + i64::from(self.region.x))
                .map_err(|_| CaptureError::EmptySelection)?,
            y: i32::try_from(i64::from(self.origin.1) + i64::from(self.region.y))
                .map_err(|_| CaptureError::EmptySelection)?,
            width: self.region.width,
            height: self.region.height,
        })
    }

    /// 完成钉住或复制：两者共用来源与原图选区语义。
    /// 有效库内选区不会写入截图历史；来源失效或重新遮蔽时返回错误，不能降级复用旧屏幕内容。
    /// 普通截图在两个动作中都保存截图历史，与既有 F1 行为一致。
    pub fn finish(
        &self,
        action: CaptureAction,
        pin_id: &str,
        references: &dyn ReferenceSource,
        veils: &PinVeils,
        history: &mut CaptureHistory,
    ) -> Result<CaptureOutcome, CaptureError> {
        self.prepare(action, pin_id, references, veils)?
            .commit(history)
    }

    /// Resolve the original crop or prepare an ordinary screenshot entirely in memory.
    /// No history entry/file or external side effect is created until CaptureDraft::commit.
    pub fn prepare(
        &self,
        action: CaptureAction,
        pin_id: &str,
        references: &dyn ReferenceSource,
        veils: &PinVeils,
    ) -> Result<CaptureDraft, CaptureError> {
        let selected = self.screen_rect()?;
        let mut candidates = self.references.iter().filter_map(|surface| {
            surface
                .reference_region(selected)
                .map(|crop| (surface, crop))
        });
        // 不能由来源登记顺序决定读取哪张原图；只有唯一未遮挡来源才走参考视图。
        let reference = match (candidates.next(), candidates.next()) {
            (Some(reference), None) => Some(reference),
            _ => None,
        };
        if let Some((surface, crop)) = reference {
            let PinContent::Reference {
                library_id,
                image_id,
                source_width,
                source_height,
            } = &surface.pin.content
            else {
                return Err(CaptureError::SourceChanged);
            };
            let image = references
                .image(library_id, image_id)
                .map_err(CaptureError::SourceUnavailable)?;
            if image.width != *source_width || image.height != *source_height {
                return Err(CaptureError::SourceChanged);
            }
            if veils.veiled(&surface.pin, Some(image.sealed)) {
                return Err(CaptureError::Sealed);
            }
            return match action {
                CaptureAction::Pin => SavedPin::reference(
                    pin_id,
                    library_id,
                    &image,
                    Some(crop),
                    surface.pin.placement,
                )
                .map(PreparedOutcome::PinReference)
                .map(CaptureDraft)
                .map_err(|_| CaptureError::SourceChanged),
                CaptureAction::Copy => {
                    let lens = references
                        .lens(library_id)
                        .map_err(CaptureError::SourceUnavailable)?;
                    if lens.library_id() != library_id {
                        return Err(CaptureError::SourceChanged);
                    }
                    // full 与显示管线一致：静态 SDR 原图，特殊声明／动图／HDR 使用原尺寸 SDR 派生图。
                    let display = lens
                        .display(image_id)
                        .map_err(|e| CaptureError::Pixels(e.to_string()))?;
                    let bytes = std::fs::read(display.path)
                        .map_err(|e| CaptureError::Pixels(e.to_string()))?;
                    let pixels = crate::fidelity::render::clipboard_rgba(&bytes)
                        .map_err(CaptureError::Pixels)?;
                    if pixels.dimensions() != (image.width, image.height)
                        || crop
                            .x
                            .checked_add(crop.width)
                            .is_none_or(|x| x > image.width)
                        || crop
                            .y
                            .checked_add(crop.height)
                            .is_none_or(|y| y > image.height)
                    {
                        return Err(CaptureError::SourceChanged);
                    }
                    let mut copied =
                        image::imageops::crop_imm(&pixels, crop.x, crop.y, crop.width, crop.height)
                            .to_image();
                    let placement = surface.pin.placement;
                    // 与参考钉图一致：先翻转，后顺时针旋转；仅方向改变，绝不按屏幕缩放。
                    if placement.flip_h {
                        image::imageops::flip_horizontal_in_place(&mut copied);
                    }
                    if placement.flip_v {
                        image::imageops::flip_vertical_in_place(&mut copied);
                    }
                    copied = match placement.rotation % 4 {
                        1 => image::imageops::rotate90(&copied),
                        2 => image::imageops::rotate180(&copied),
                        3 => image::imageops::rotate270(&copied),
                        _ => copied,
                    };
                    Ok(CaptureDraft(PreparedOutcome::CopyReference(copied)))
                }
            };
        }
        let shot = self
            .screen
            .crop(self.region)
            .ok_or(CaptureError::EmptySelection)?;
        let history = CaptureHistory::prepare(&shot).map_err(CaptureError::History)?;
        Ok(CaptureDraft(PreparedOutcome::Screenshot {
            action,
            shot,
            history,
        }))
    }
}
