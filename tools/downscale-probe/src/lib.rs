//! 线性光与编码值空间缩小的对比探测程序（#48）。
//!
//! 每个样本按两种缩小比例各成一组；一组里两种算法的缩略图并排显示，左右与组的顺序都随机。
//! 缩略图由应用的还原度管线（`kinshoko_core::fidelity::render_sdr`）生成，只换缩小所在的空间。

pub mod report;
pub mod samples;

use kinshoko_core::fidelity::{self, Downscale, SdrDerivative};

use crate::samples::{Rng, Sample, SampleKind};

/// 参与比较的两种缩小算法。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Algorithm {
    LinearLight,
    EncodedValue,
}

impl Algorithm {
    /// 报告里的名字。
    pub fn key(self) -> &'static str {
        match self {
            Algorithm::LinearLight => "linear-light",
            Algorithm::EncodedValue => "encoded-value",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Algorithm::LinearLight => "线性光",
            Algorithm::EncodedValue => "编码值空间",
        }
    }

    fn downscale(self) -> Downscale {
        match self {
            Algorithm::LinearLight => Downscale::LinearLight,
            Algorithm::EncodedValue => Downscale::EncodedValue,
        }
    }
}

/// 缩小比例：原图宽度除以 `divisor`（核查“尚未验证”一节实验 6 的 1/3 与 1/7.5）。
#[derive(Debug, Clone, Copy)]
pub struct Scale {
    pub label: &'static str,
    pub divisor: f64,
}

pub const SCALES: [Scale; 2] = [
    Scale {
        label: "1/3",
        divisor: 3.0,
    },
    Scale {
        label: "1/7.5",
        divisor: 7.5,
    },
];

/// 并排显示的一组。
#[derive(Debug, Clone)]
pub struct Group {
    /// 从 1 起的组号，即显示顺序。
    pub number: usize,
    pub sample_id: String,
    pub sample_kind: SampleKind,
    pub description: String,
    pub scale: &'static str,
    pub left: Algorithm,
    pub right: Algorithm,
    pub left_image: SdrDerivative,
    pub right_image: SdrDerivative,
    /// 原图字节（供画师对照，不进报告）。
    pub original: std::sync::Arc<Vec<u8>>,
}

impl Group {
    pub fn algorithm(&self, side: report::Choice) -> Option<Algorithm> {
        match side {
            report::Choice::Left => Some(self.left),
            report::Choice::Right => Some(self.right),
            report::Choice::Same => None,
        }
    }
}

/// 一次探测的全部分组。
#[derive(Debug, Clone)]
pub struct Plan {
    pub seed: u64,
    pub groups: Vec<Group>,
}

impl Plan {
    /// 生成每个样本、每种比例的两种缩略图，按 `seed` 打乱顺序与左右。
    /// `progress(已生成组数, 总组数)`。
    pub fn prepare(
        samples: &[Sample],
        seed: u64,
        mut progress: impl FnMut(usize, usize),
    ) -> Result<Plan, String> {
        let mut rng = Rng::new(seed);
        let total = samples.len() * SCALES.len();
        let mut groups = Vec::with_capacity(total);
        for sample in samples {
            let width = image::ImageReader::new(std::io::Cursor::new(&sample.bytes))
                .with_guessed_format()
                .map_err(|e| e.to_string())?
                .into_dimensions()
                .map_err(|e| format!("{}：{e}", sample.id))?
                .0;
            let original = std::sync::Arc::new(sample.bytes.clone());
            for scale in SCALES {
                progress(groups.len(), total);
                let max_width = ((width as f64 / scale.divisor).round() as u32).max(1);
                let render = |a: Algorithm| {
                    fidelity::render_sdr(&sample.bytes, max_width, a.downscale())
                        .map_err(|e| format!("{}：{e}", sample.id))
                };
                let (left, right) = if rng.next_u64() & 1 == 0 {
                    (Algorithm::LinearLight, Algorithm::EncodedValue)
                } else {
                    (Algorithm::EncodedValue, Algorithm::LinearLight)
                };
                groups.push(Group {
                    number: 0,
                    sample_id: sample.id.clone(),
                    sample_kind: sample.kind,
                    description: sample.description.clone(),
                    scale: scale.label,
                    left,
                    right,
                    left_image: render(left)?,
                    right_image: render(right)?,
                    original: original.clone(),
                });
            }
        }
        // Fisher–Yates。
        for i in (1..groups.len()).rev() {
            let j = rng.below(i + 1);
            groups.swap(i, j);
        }
        for (i, g) in groups.iter_mut().enumerate() {
            g.number = i + 1;
        }
        progress(total, total);
        Ok(Plan { seed, groups })
    }
}
