//! 显示器描述与“显示器变没变”。平台适配器读系统，这里只比较。

use kinshoko_core::desktop::ScreenRect;
use kinshoko_core::desktop::frame::Monitor;

/// 一台显示器。
#[derive(Debug, Clone, PartialEq)]
pub struct Display {
    /// 系统给的设备名（Windows 上是 `\\.\DISPLAY1` 这类），在显示器插拔之前稳定。
    pub id: String,
    /// 物理像素矩形。
    pub rect: ScreenRect,
    /// 缩放比例，1.0 为 100%。
    pub scale: f64,
    /// 这台显示器当前的颜色配置文件（ICC 字节）；没有设或读不到为 None。
    pub profile: Option<Vec<u8>>,
}

impl Display {
    /// `frame` 的几何与命中用的形状。
    pub fn monitor(&self) -> Monitor {
        Monitor {
            rect: self.rect,
            scale: self.scale,
        }
    }
}

/// 系统报的 DPI（96 为 100%）换成缩放比例。
pub fn scale_from_dpi(dpi: u32) -> f64 {
    f64::from(dpi) / 96.0
}

/// 比较用的显示器布局：配置文件按路径认，不必每次读文件。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Layout {
    pub id: String,
    pub rect: ScreenRect,
    pub scale: f64,
    pub profile: Option<String>,
}

/// 记住上一次的布局，报告变化。
#[derive(Debug, Default)]
pub(crate) struct DisplayWatch {
    last: Option<Vec<Layout>>,
}

impl DisplayWatch {
    /// 记下现在的布局；与上一次不同时返回真。第一次只记下，不算变化。顺序不同不算变化。
    pub fn update(&mut self, mut now: Vec<Layout>) -> bool {
        now.sort_by(|a, b| a.id.cmp(&b.id));
        let changed = self.last.as_ref().is_some_and(|last| *last != now);
        self.last = Some(now);
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(id: &str, x: i32, scale: f64, profile: Option<&str>) -> Layout {
        Layout {
            id: id.into(),
            rect: ScreenRect {
                x,
                y: 0,
                width: 2560,
                height: 1440,
            },
            scale,
            profile: profile.map(Into::into),
        }
    }

    #[test]
    fn dpi_to_scale() {
        assert_eq!(scale_from_dpi(96), 1.0);
        assert_eq!(scale_from_dpi(120), 1.25);
        assert_eq!(scale_from_dpi(144), 1.5);
        assert_eq!(scale_from_dpi(192), 2.0);
    }

    #[test]
    fn first_snapshot_is_the_baseline() {
        let mut w = DisplayWatch::default();
        assert!(!w.update(vec![layout("A", 0, 1.0, None)]));
        assert!(!w.update(vec![layout("A", 0, 1.0, None)]));
    }

    #[test]
    fn plugging_a_display_in_or_out_is_a_change() {
        let mut w = DisplayWatch::default();
        w.update(vec![layout("A", 0, 1.0, None)]);
        assert!(w.update(vec![
            layout("A", 0, 1.0, None),
            layout("B", 2560, 1.5, None)
        ]));
        assert!(!w.update(vec![
            layout("B", 2560, 1.5, None),
            layout("A", 0, 1.0, None)
        ]));
        assert!(w.update(vec![layout("B", 2560, 1.5, None)]));
    }

    #[test]
    fn moving_rescaling_or_changing_the_profile_is_a_change() {
        let mut w = DisplayWatch::default();
        w.update(vec![layout("A", 0, 1.0, Some("sRGB.icm"))]);
        assert!(w.update(vec![layout("A", -2560, 1.0, Some("sRGB.icm"))]));
        assert!(w.update(vec![layout("A", -2560, 1.25, Some("sRGB.icm"))]));
        assert!(w.update(vec![layout("A", -2560, 1.25, Some("calibrated.icm"))]));
        assert!(w.update(vec![layout("A", -2560, 1.25, None)]));
    }

    #[test]
    fn display_gives_frame_its_monitor() {
        let d = Display {
            id: "A".into(),
            rect: layout("A", 10, 1.5, None).rect,
            scale: 1.5,
            profile: None,
        };
        assert_eq!(
            d.monitor(),
            Monitor {
                rect: d.rect,
                scale: 1.5
            }
        );
    }
}
