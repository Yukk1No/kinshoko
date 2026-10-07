//! 样本：构造的线稿（每台机器上逐字节相同）与公开样本（pixiv 清单里全年龄的线稿，按哈希校验）。
//!
//! 样本只在内存里带字节和清单 id，不带文件名或路径，报告因而无从写出它们。

use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use image::ImageEncoder;
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleKind {
    /// 程序生成的线稿。
    Constructed,
    /// 公开样本清单（`docs/validation/sample-manifest.pixiv.json`）里的作品。
    Public,
}

impl SampleKind {
    pub fn key(self) -> &'static str {
        match self {
            SampleKind::Constructed => "constructed",
            SampleKind::Public => "public",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Sample {
    /// 构造样本的名字，或清单 id（`pixiv-<作品>-p<页>`）。
    pub id: String,
    pub kind: SampleKind,
    /// 给画师看的一句说明。
    pub description: String,
    pub bytes: Vec<u8>,
}

// ---------------------------------------------------------------------------
// 构造的线稿

const W: u32 = 1800;
const H: u32 = 1200;

type Rgb = [f32; 3];

const WHITE: Rgb = [1.0, 1.0, 1.0];
const BLACK: Rgb = [0.0, 0.0, 0.0];

fn rgb(r: u8, g: u8, b: u8) -> Rgb {
    [r, g, b].map(|v| v as f32 / 255.0)
}

/// 简单的画布：编码值上按覆盖率叠加（与绘画软件的普通图层相同），笔画内部取最大覆盖率，
/// 折线的接头因而不会叠深。
struct Canvas {
    px: Vec<Rgb>,
    mask: Vec<f32>,
}

/// 折线上的一个点：坐标与该处线宽（像素）。
#[derive(Clone, Copy)]
struct Pt {
    x: f32,
    y: f32,
    w: f32,
}

fn pt(x: f32, y: f32, w: f32) -> Pt {
    Pt { x, y, w }
}

impl Canvas {
    fn new(bg: Rgb) -> Self {
        Canvas {
            px: vec![bg; (W * H) as usize],
            mask: vec![0.0; (W * H) as usize],
        }
    }

    fn fill_rect(&mut self, x0: u32, y0: u32, x1: u32, y1: u32, c: Rgb) {
        for y in y0..y1.min(H) {
            for x in x0..x1.min(W) {
                self.px[(y * W + x) as usize] = c;
            }
        }
    }

    /// 画一条折线（各点线宽可不同，线宽在段内线性变化），颜色 `c`。
    fn stroke(&mut self, points: &[Pt], c: Rgb) {
        let (mut bx0, mut by0, mut bx1, mut by1) = (W as i32, H as i32, 0i32, 0i32);
        for seg in points.windows(2) {
            let (a, b) = (seg[0], seg[1]);
            let r = a.w.max(b.w) / 2.0 + 1.0;
            let x0 = (a.x.min(b.x) - r).floor().max(0.0) as i32;
            let y0 = (a.y.min(b.y) - r).floor().max(0.0) as i32;
            let x1 = ((a.x.max(b.x) + r).ceil() as i32).min(W as i32 - 1);
            let y1 = ((a.y.max(b.y) + r).ceil() as i32).min(H as i32 - 1);
            if x0 > x1 || y0 > y1 {
                continue;
            }
            (bx0, by0, bx1, by1) = (bx0.min(x0), by0.min(y0), bx1.max(x1), by1.max(y1));
            let (dx, dy) = (b.x - a.x, b.y - a.y);
            let len2 = (dx * dx + dy * dy).max(1e-6);
            for y in y0..=y1 {
                for x in x0..=x1 {
                    let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
                    let t = (((px - a.x) * dx + (py - a.y) * dy) / len2).clamp(0.0, 1.0);
                    let (qx, qy) = (a.x + t * dx - px, a.y + t * dy - py);
                    let d = (qx * qx + qy * qy).sqrt();
                    let w = a.w + (b.w - a.w) * t;
                    let cov = (w / 2.0 + 0.5 - d).clamp(0.0, w.min(1.0));
                    let m = &mut self.mask[(y as u32 * W + x as u32) as usize];
                    *m = m.max(cov);
                }
            }
        }
        if bx0 > bx1 {
            return;
        }
        for y in by0..=by1 {
            for x in bx0..=bx1 {
                let i = (y as u32 * W + x as u32) as usize;
                let m = std::mem::take(&mut self.mask[i]);
                if m > 0.0 {
                    let p = &mut self.px[i];
                    for k in 0..3 {
                        p[k] += (c[k] - p[k]) * m;
                    }
                }
            }
        }
    }

    fn line(&mut self, x0: f32, y0: f32, x1: f32, y1: f32, w: f32, c: Rgb) {
        self.stroke(&[pt(x0, y0, w), pt(x1, y1, w)], c);
    }

    fn circle(&mut self, cx: f32, cy: f32, r: f32, w: f32, c: Rgb) {
        let n = ((r * 0.6) as usize).clamp(24, 400);
        let points: Vec<Pt> = (0..=n)
            .map(|i| {
                let a = i as f32 / n as f32 * std::f32::consts::TAU;
                pt(cx + r * a.cos(), cy + r * a.sin(), w)
            })
            .collect();
        self.stroke(&points, c);
    }

    fn png(&self) -> Vec<u8> {
        let data: Vec<u8> = self
            .px
            .iter()
            .flat_map(|p| p.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8))
            .collect();
        let mut out = Vec::new();
        image::codecs::png::PngEncoder::new(&mut out)
            .write_image(&data, W, H, image::ExtendedColorType::Rgb8)
            .expect("PNG 编码不会失败");
        out
    }
}

/// 可重复的伪随机数（splitmix64）。
pub(crate) struct Rng(u64);

impl Rng {
    pub(crate) fn new(seed: u64) -> Self {
        Rng(seed)
    }

    pub(crate) fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// [0, 1)
    pub(crate) fn unit(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }

    pub(crate) fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
}

const WIDTHS: [f32; 8] = [0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0];

/// 一组不同线宽、不同角度的直线与同心圆，画在 `canvas` 的 (x0, y0) 起、宽 `w`、高 `h` 的区域。
fn widths_block(canvas: &mut Canvas, x0: f32, y0: f32, w: f32, h: f32, c: Rgb) {
    let row = h / WIDTHS.len() as f32;
    for (i, &lw) in WIDTHS.iter().enumerate() {
        let y = y0 + row * (i as f32 + 0.5);
        // 水平、微斜、30°、45°、接近垂直的短线。
        canvas.line(x0, y, x0 + w * 0.3, y, lw, c);
        canvas.line(
            x0 + w * 0.32,
            y - row * 0.3,
            x0 + w * 0.5,
            y + row * 0.05,
            lw,
            c,
        );
        let len = row * 0.8;
        for (k, deg) in [30f32, 45.0, 88.0].iter().enumerate() {
            let a = deg.to_radians();
            let sx = x0 + w * (0.55 + 0.1 * k as f32);
            canvas.line(
                sx,
                y + len / 2.0 * a.sin(),
                sx + len * a.cos(),
                y - len / 2.0 * a.sin(),
                lw,
                c,
            );
        }
        canvas.circle(x0 + w * 0.9, y, row * 0.35, lw, c);
    }
}

/// 一笔带压感的草图线：两端收尖，中段最粗。
fn pen_stroke(canvas: &mut Canvas, rng: &mut Rng, x: f32, y: f32, len: f32, width: f32, c: Rgb) {
    let n = 24;
    let mut angle = rng.unit() * std::f32::consts::TAU;
    let bend = (rng.unit() - 0.5) * 0.12;
    let step = len / n as f32;
    let (mut px, mut py) = (x, y);
    let mut points = Vec::with_capacity(n + 1);
    for i in 0..=n {
        let t = i as f32 / n as f32;
        let pressure = (std::f32::consts::PI * t).sin().powf(0.6);
        points.push(pt(px, py, (width * pressure).max(0.2)));
        angle += bend;
        px += step * angle.cos();
        py += step * angle.sin();
    }
    canvas.stroke(&points, c);
}

/// 构造的线稿样本，1800×1200，sRGB（不带色彩声明）。
pub fn constructed() -> Vec<Sample> {
    let mut out = Vec::new();

    // 黑线宽梯度：0.5～6 px、各种角度、同心圆。
    let mut c = Canvas::new(WHITE);
    widths_block(&mut c, 40.0, 30.0, 1720.0, 1140.0, BLACK);
    out.push(Sample {
        id: "constructed-line-widths".into(),
        kind: SampleKind::Constructed,
        description: "白底黑线：线宽 0.5～6 px，水平、斜线、近垂直与圆".into(),
        bytes: c.png(),
    });

    // 排线、交叉排线与网点。
    let mut c = Canvas::new(WHITE);
    for (k, gap) in [2.0f32, 3.0, 4.0, 6.0, 8.0].iter().enumerate() {
        let x0 = 40.0 + k as f32 * 345.0;
        let mut y = 40.0;
        while y < 560.0 {
            c.line(x0, y, x0 + 300.0, y + 60.0, 1.0, BLACK);
            y += gap;
        }
        // 交叉排线。
        let mut x = x0;
        while x < x0 + 300.0 {
            c.line(x, 640.0, x + 40.0, 860.0, 1.0, BLACK);
            c.line(x + 40.0, 640.0, x, 860.0, 1.0, BLACK);
            x += gap * 2.0;
        }
        // 网点：6 px 间距，覆盖率随列增加。
        let r = 0.6 + k as f32 * 0.55;
        let mut y = 900.0;
        while y < 1170.0 {
            let mut x = x0;
            while x < x0 + 300.0 {
                c.circle(x, y, r * 0.5, r, BLACK);
                x += 6.0;
            }
            y += 6.0;
        }
    }
    out.push(Sample {
        id: "constructed-hatching".into(),
        kind: SampleKind::Constructed,
        description: "排线（间距 2～8 px）、交叉排线与网点".into(),
        bytes: c.png(),
    });

    // 彩色线稿：在白底、浅肤色与中间蓝色块上画红、蓝、褐线。
    let mut c = Canvas::new(WHITE);
    c.fill_rect(600, 0, 1200, H, rgb(250, 225, 205));
    c.fill_rect(1200, 0, W, H, rgb(120, 150, 200));
    for (k, colour) in [rgb(200, 40, 40), rgb(40, 60, 200), rgb(110, 60, 30)]
        .into_iter()
        .enumerate()
    {
        for band in 0..3 {
            widths_block(
                &mut c,
                band as f32 * 600.0 + 20.0,
                20.0 + k as f32 * 390.0,
                560.0,
                370.0,
                colour,
            );
        }
    }
    out.push(Sample {
        id: "constructed-colour-lines".into(),
        kind: SampleKind::Constructed,
        description: "彩色线（红、蓝、褐）画在白底、浅肤色与蓝色块上".into(),
        bytes: c.png(),
    });

    // 深色底上的浅线：高光、发丝。
    let mut c = Canvas::new(BLACK);
    c.fill_rect(900, 0, W, H, rgb(30, 35, 70));
    widths_block(&mut c, 30.0, 30.0, 840.0, 1140.0, WHITE);
    widths_block(&mut c, 930.0, 30.0, 840.0, 1140.0, rgb(255, 240, 200));
    out.push(Sample {
        id: "constructed-light-lines".into(),
        kind: SampleKind::Constructed,
        description: "黑底与深蓝底上的白线、浅黄线（高光、发丝）".into(),
        bytes: c.png(),
    });

    // 草图：大量两端收尖的细笔画。
    let mut c = Canvas::new(WHITE);
    let mut rng = Rng::new(48);
    for i in 0..700 {
        let x = 60.0 + rng.unit() * 1680.0;
        let y = 60.0 + rng.unit() * 1080.0;
        let len = 40.0 + rng.unit() * 260.0;
        let width = if i % 5 == 0 {
            3.5
        } else {
            0.8 + rng.unit() * 1.6
        };
        let colour = if i % 7 == 0 { rgb(70, 70, 80) } else { BLACK };
        pen_stroke(&mut c, &mut rng, x, y, len, width, colour);
    }
    out.push(Sample {
        id: "constructed-sketch".into(),
        kind: SampleKind::Constructed,
        description: "草图：两端收尖的细笔画，线宽约 0.8～3.5 px".into(),
        bytes: c.png(),
    });

    out
}

// ---------------------------------------------------------------------------
// 公开样本

const PIXIV_MANIFEST: &str = include_str!("../../../docs/validation/sample-manifest.pixiv.json");
const PIXIV_HEADERS: [(&str, &str); 2] = [
    ("Referer", "https://www.pixiv.net/"),
    ("User-Agent", "Mozilla/5.0"),
];

#[derive(Deserialize)]
struct Manifest {
    samples: Vec<RawEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSource {
    kind: String,
    artwork_id: Option<String>,
    page: Option<u32>,
}

#[derive(Deserialize)]
struct RawEntry {
    id: String,
    source: RawSource,
    sha256: String,
    coverage: Vec<String>,
    rating: String,
}

/// 清单里的一个公开样本。
#[derive(Debug, Clone)]
pub struct PublicEntry {
    pub id: String,
    pub artwork_id: String,
    pub page: u32,
    pub sha256: String,
}

/// 清单里全年龄（`general`）且覆盖线稿（`lineart`）的样本。
pub fn public_entries() -> Vec<PublicEntry> {
    let manifest: Manifest = serde_json::from_str(PIXIV_MANIFEST).expect("内嵌清单可解析");
    manifest
        .samples
        .into_iter()
        .filter(|e| {
            e.rating == "general"
                && e.coverage.iter().any(|c| c == "lineart")
                && e.source.kind == "pixiv"
        })
        .filter_map(|e| {
            Some(PublicEntry {
                id: e.id,
                artwork_id: e.source.artwork_id?,
                page: e.source.page.unwrap_or(0),
                sha256: e.sha256,
            })
        })
        .collect()
}

fn sha256(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

fn public_sample(e: &PublicEntry, bytes: Vec<u8>) -> Sample {
    Sample {
        id: e.id.clone(),
        kind: SampleKind::Public,
        description: "公开样本（pixiv）中的线稿".into(),
        bytes,
    }
}

/// 在本机文件夹里按 pixiv 文件名（`<作品>_p<页>.*`）找公开样本，哈希不符的不用（开发用）。
pub fn public_from_dir(dir: &Path) -> Vec<Sample> {
    let files: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .collect();
    let mut out = Vec::new();
    for e in public_entries() {
        let prefix = format!("{}_p{}.", e.artwork_id, e.page);
        let found = files.iter().find(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with(&prefix))
        });
        if let Some(bytes) = found.and_then(|p| fs::read(p).ok())
            && sha256(&bytes) == e.sha256
        {
            out.push(public_sample(&e, bytes));
        }
    }
    out
}

/// 下载公开样本到缓存文件夹（已下载且哈希一致的不重复下载）。`progress(已处理, 总数)`；
/// 下载失败的跳过，返回失败的清单 id。
pub fn fetch_public(
    cache: &Path,
    mut progress: impl FnMut(usize, usize),
) -> (Vec<Sample>, Vec<String>) {
    let entries = public_entries();
    let _ = fs::create_dir_all(cache);
    let mut out = Vec::new();
    let mut failed = Vec::new();
    for (i, e) in entries.iter().enumerate() {
        progress(i, entries.len());
        // 缓存按清单 id 命名，不保留 pixiv 的文件名。
        let path = cache.join(&e.id);
        let cached = fs::read(&path).ok().filter(|b| sha256(b) == e.sha256);
        let bytes = match cached {
            Some(b) => Some(b),
            None => match download(e) {
                Ok(b) => {
                    let _ = fs::write(&path, &b);
                    Some(b)
                }
                Err(_) => None,
            },
        };
        match bytes {
            Some(b) => out.push(public_sample(e, b)),
            None => failed.push(e.id.clone()),
        }
    }
    progress(entries.len(), entries.len());
    (out, failed)
}

fn get(url: &str) -> ureq::Request {
    ureq::get(url)
        .timeout(Duration::from_secs(60))
        .set(PIXIV_HEADERS[0].0, PIXIV_HEADERS[0].1)
        .set(PIXIV_HEADERS[1].0, PIXIV_HEADERS[1].1)
}

fn download(e: &PublicEntry) -> Result<Vec<u8>, String> {
    let pages: serde_json::Value = get(&format!(
        "https://www.pixiv.net/ajax/illust/{}/pages",
        e.artwork_id
    ))
    .call()
    .map_err(|e| e.to_string())?
    .into_json()
    .map_err(|e| e.to_string())?;
    let url = pages["body"][e.page as usize]["urls"]["original"]
        .as_str()
        .ok_or("没有原图地址")?
        .to_string();
    std::thread::sleep(Duration::from_millis(1200));
    let mut data = Vec::new();
    get(&url)
        .call()
        .map_err(|e| e.to_string())?
        .into_reader()
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(1200));
    if sha256(&data) != e.sha256 {
        return Err("哈希与清单不一致".into());
    }
    Ok(data)
}
