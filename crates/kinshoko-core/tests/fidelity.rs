//! 还原度管线（#45）：导入时记录色彩描述；缩略图按与 Chromium 相同的色彩声明规则解释，
//! 在线性光 f32 下预乘缩放，按来源分档无损保存；动图与 HDR 原图生成 `sdr` 派生图。
//! 全部通过 `Library` 的对外接口，用临时目录里的真 SQLite 与真文件。

use std::path::{Path, PathBuf};

use image::{ImageEncoder, RgbaImage};
use kinshoko_core::Library;
use kinshoko_core::fidelity::gate::{self, GateSample};
use kinshoko_core::library::{
    BrowseQuery, ColourDeclaration, ColourDescription, ColourModel, HdrKind, IccKind,
    ImportOutcome, ImportSource,
};

fn import_one(library: &Library, path: &Path) -> String {
    let report = library
        .import(ImportSource {
            paths: vec![path.to_path_buf()],
        })
        .wait();
    match &report.items[0].outcome {
        ImportOutcome::Imported { image_id } => image_id.clone(),
        other => panic!("{} 未导入：{other:?}", path.display()),
    }
}

fn write(path: &Path, bytes: &[u8]) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
    path.to_path_buf()
}

fn png_rgba(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
    let img = RgbaImage::from_fn(w, h, |x, y| image::Rgba(f(x, y)));
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgba8)
        .unwrap();
    out
}

#[test]
fn an_untagged_png_is_recorded_as_plain_srgb_with_its_alpha() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    let path = write(
        &dir.path().join("in/a.png"),
        &png_rgba(8, 4, |x, _| [200, 10, 10, x as u8 * 30]),
    );

    let id = import_one(&library, &path);

    assert_eq!(
        library.colour(&id).unwrap(),
        ColourDescription {
            format: "png".into(),
            bit_depth: 8,
            colour_model: ColourModel::Rgb,
            declaration: ColourDeclaration::None,
            icc: None,
            cicp: None,
            alpha: true,
            orientation: 1,
            hdr: None,
            hdr_metadata: false,
            animated: false,
        }
    );
}

fn gate_samples() -> &'static [GateSample] {
    static SAMPLES: std::sync::OnceLock<Vec<GateSample>> = std::sync::OnceLock::new();
    SAMPLES.get_or_init(gate::samples)
}

fn gate_sample(name: &str) -> &'static GateSample {
    gate_samples()
        .iter()
        .find(|s| s.file_name == name)
        .unwrap_or_else(|| panic!("没有样本 {name}"))
}

/// 把门槛样本写进临时目录并导入，返回参考图 id。
fn import_sample(library: &Library, dir: &Path, sample: &GateSample) -> String {
    let path = write(&dir.join("samples").join(&sample.file_name), &sample.bytes);
    import_one(library, &path)
}

#[test]
#[allow(clippy::type_complexity)] // 表格式的用例，一行一个样本。
fn import_records_how_each_gate_sample_declares_its_colour() {
    use ColourDeclaration as D;
    use ColourModel as M;
    // (样本, 格式, 位深, 颜色模型, 生效的声明, ICC 类型与版本, alpha, 方向, HDR, 动图)
    let expected: &[(
        &str,
        &str,
        u8,
        M,
        D,
        Option<(IccKind, &str)>,
        bool,
        u8,
        Option<HdrKind>,
        bool,
    )] = &[
        (
            "p3-v4.jpg",
            "jpeg",
            8,
            M::Rgb,
            D::Icc,
            Some((IccKind::Matrix, "4.4")),
            false,
            1,
            None,
            false,
        ),
        (
            "p3-v2.jpg",
            "jpeg",
            8,
            M::Rgb,
            D::Icc,
            Some((IccKind::Matrix, "2.1")),
            false,
            1,
            None,
            false,
        ),
        (
            "lut-a2b0.png",
            "png",
            8,
            M::Rgb,
            D::Icc,
            Some((IccKind::Lut, "4.4")),
            false,
            1,
            None,
            false,
        ),
        (
            "icc-mismatch.jpg",
            "jpeg",
            8,
            M::Rgb,
            D::None,
            Some((IccKind::Lut, "4.4")),
            false,
            1,
            None,
            false,
        ),
        (
            "cmyk-profile.jpg",
            "jpeg",
            8,
            M::Cmyk,
            D::Icc,
            Some((IccKind::Lut, "4.4")),
            false,
            1,
            None,
            false,
        ),
        (
            "ycck-profile.jpg",
            "jpeg",
            8,
            M::Cmyk,
            D::Icc,
            Some((IccKind::Lut, "4.4")),
            false,
            1,
            None,
            false,
        ),
        (
            "cmyk-naive.jpg",
            "jpeg",
            8,
            M::Cmyk,
            D::None,
            None,
            false,
            1,
            None,
            false,
        ),
        (
            "gama-18.png",
            "png",
            8,
            M::Rgb,
            D::Gamma,
            None,
            false,
            1,
            None,
            false,
        ),
        (
            "gama-chrm-p3.png",
            "png",
            8,
            M::Rgb,
            D::GammaChromaticities,
            None,
            false,
            1,
            None,
            false,
        ),
        (
            "srgb-vs-gama.png",
            "png",
            8,
            M::Rgb,
            D::Srgb,
            None,
            false,
            1,
            None,
            false,
        ),
        (
            "cicp-p3.png",
            "png",
            8,
            M::Rgb,
            D::Cicp,
            None,
            false,
            1,
            None,
            false,
        ),
        (
            "cicp-over-iccp.png",
            "png",
            8,
            M::Rgb,
            D::Cicp,
            Some((IccKind::Matrix, "4.4")),
            false,
            1,
            None,
            false,
        ),
        (
            "png16-p3.png",
            "png",
            16,
            M::Rgb,
            D::Icc,
            Some((IccKind::Matrix, "4.4")),
            false,
            1,
            None,
            false,
        ),
        (
            "gray-gamma22.jpg",
            "jpeg",
            8,
            M::Gray,
            D::Icc,
            Some((IccKind::Gray, "4.4")),
            false,
            1,
            None,
            false,
        ),
        (
            "alpha-edge.webp",
            "webp",
            8,
            M::Rgb,
            D::None,
            None,
            true,
            1,
            None,
            false,
        ),
        (
            "orientation-6.jpg",
            "jpeg",
            8,
            M::Rgb,
            D::None,
            None,
            false,
            6,
            None,
            false,
        ),
        (
            "orientation-6.png",
            "png",
            8,
            M::Rgb,
            D::None,
            None,
            false,
            6,
            None,
            false,
        ),
        (
            "animated.gif",
            "gif",
            8,
            M::Rgb,
            D::None,
            None,
            false,
            1,
            None,
            true,
        ),
        (
            "animated.png",
            "png",
            8,
            M::Rgb,
            D::None,
            None,
            false,
            1,
            None,
            true,
        ),
        (
            "animated.webp",
            "webp",
            8,
            M::Rgb,
            D::None,
            None,
            false,
            1,
            None,
            true,
        ),
        (
            "gain-map.jpg",
            "jpeg",
            8,
            M::Rgb,
            D::None,
            None,
            false,
            1,
            Some(HdrKind::GainMap),
            false,
        ),
        (
            "pq.png",
            "png",
            16,
            M::Rgb,
            D::Cicp,
            None,
            false,
            1,
            Some(HdrKind::Pq),
            false,
        ),
        (
            "hlg.png",
            "png",
            16,
            M::Rgb,
            D::Cicp,
            None,
            false,
            1,
            Some(HdrKind::Hlg),
            false,
        ),
    ];
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    let mut ids = std::collections::HashMap::new();

    for &(name, format, bit_depth, model, declaration, icc, alpha, orientation, hdr, animated) in
        expected
    {
        let id = import_sample(&library, dir.path(), gate_sample(name));
        let d = library.colour(&id).unwrap();
        ids.insert(name, id);
        let actual = (
            d.format.as_str(),
            d.bit_depth,
            d.colour_model,
            d.declaration,
            d.icc.as_ref().map(|i| (i.kind, i.version.as_str())),
            d.alpha,
            d.orientation,
            d.hdr,
            d.animated,
        );
        assert_eq!(
            actual,
            (
                format,
                bit_depth,
                model,
                declaration,
                icc,
                alpha,
                orientation,
                hdr,
                animated
            ),
            "{name}"
        );
        assert_eq!(
            d.needs_sdr_derivative(),
            animated || hdr.is_some(),
            "{name}"
        );
    }

    // 只有 PQ／HLG 样本带 cLLI。
    let d = library.colour(&ids["pq.png"]).unwrap();
    assert!(d.hdr_metadata);
    assert_eq!(d.cicp.map(|c| (c.primaries, c.transfer)), Some((9, 16)));
    assert!(!library.colour(&ids["cicp-p3.png"]).unwrap().hdr_metadata);
    // ICC 哈希是配置文件字节的 SHA-256：同一配置文件的两张图哈希相同。
    let (a, b) = (&ids["p3-v4.jpg"], &ids["png16-p3.png"]);
    assert_eq!(
        library.colour(a).unwrap().icc.unwrap().sha256,
        library.colour(b).unwrap().icc.unwrap().sha256
    );
}

/// CIEDE2000 色差（Sharma 2005 的公式）。
fn delta_e2000(lab1: [f32; 3], lab2: [f32; 3]) -> f64 {
    let [l1, a1, b1] = lab1.map(f64::from);
    let [l2, a2, b2] = lab2.map(f64::from);
    let c1 = (a1 * a1 + b1 * b1).sqrt();
    let c2 = (a2 * a2 + b2 * b2).sqrt();
    let c_bar = (c1 + c2) / 2.0;
    let g = 0.5 * (1.0 - (c_bar.powi(7) / (c_bar.powi(7) + 25f64.powi(7))).sqrt());
    let (a1p, a2p) = ((1.0 + g) * a1, (1.0 + g) * a2);
    let (c1p, c2p) = ((a1p * a1p + b1 * b1).sqrt(), (a2p * a2p + b2 * b2).sqrt());
    let hue = |b: f64, a: f64| {
        if a == 0.0 && b == 0.0 {
            0.0
        } else {
            let h = b.atan2(a).to_degrees();
            if h < 0.0 { h + 360.0 } else { h }
        }
    };
    let (h1p, h2p) = (hue(b1, a1p), hue(b2, a2p));
    let dl = l2 - l1;
    let dc = c2p - c1p;
    let dh = if c1p * c2p == 0.0 {
        0.0
    } else if (h2p - h1p).abs() <= 180.0 {
        h2p - h1p
    } else if h2p - h1p > 180.0 {
        h2p - h1p - 360.0
    } else {
        h2p - h1p + 360.0
    };
    let d_h = 2.0 * (c1p * c2p).sqrt() * (dh.to_radians() / 2.0).sin();
    let l_bar = (l1 + l2) / 2.0;
    let c_bar_p = (c1p + c2p) / 2.0;
    let h_bar = if c1p * c2p == 0.0 {
        h1p + h2p
    } else if (h1p - h2p).abs() <= 180.0 {
        (h1p + h2p) / 2.0
    } else if h1p + h2p < 360.0 {
        (h1p + h2p + 360.0) / 2.0
    } else {
        (h1p + h2p - 360.0) / 2.0
    };
    let t = 1.0 - 0.17 * (h_bar - 30.0).to_radians().cos()
        + 0.24 * (2.0 * h_bar).to_radians().cos()
        + 0.32 * (3.0 * h_bar + 6.0).to_radians().cos()
        - 0.20 * (4.0 * h_bar - 63.0).to_radians().cos();
    let d_theta = 30.0 * (-((h_bar - 275.0) / 25.0).powi(2)).exp();
    let r_c = 2.0 * (c_bar_p.powi(7) / (c_bar_p.powi(7) + 25f64.powi(7))).sqrt();
    let s_l = 1.0 + 0.015 * (l_bar - 50.0).powi(2) / (20.0 + (l_bar - 50.0).powi(2)).sqrt();
    let s_c = 1.0 + 0.045 * c_bar_p;
    let s_h = 1.0 + 0.015 * c_bar_p * t;
    let r_t = -(2.0 * d_theta.to_radians()).sin() * r_c;
    ((dl / s_l).powi(2) + (dc / s_c).powi(2) + (d_h / s_h).powi(2) + r_t * (dc / s_c) * (d_h / s_h))
        .sqrt()
}

#[test]
fn delta_e2000_matches_the_published_test_data() {
    // Sharma, Wu, Dalal (2005) 表 1 的第 1、7、17 组。
    let cases = [
        ([50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425),
        ([50.0, 0.0, 0.0], [50.0, -1.0, 2.0], 2.3669),
        ([50.0, 2.5, 0.0], [73.0, 25.0, -18.0], 27.1492),
    ];
    for (a, b, expected) in cases {
        assert!((delta_e2000(a, b) - expected).abs() < 1e-3, "{a:?} {b:?}");
    }
}

/// 一张派生图文件：像素（0～1）与它嵌入的 ICC（没有则 sRGB）。
struct Decoded {
    image: image::Rgba32FImage,
    profile: moxcms::ColorProfile,
}

fn decode_derivative(path: &Path) -> Decoded {
    use image::ImageDecoder;
    let bytes = std::fs::read(path).unwrap();
    let mut decoder = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format()
        .unwrap()
        .into_decoder()
        .unwrap();
    let profile = match decoder.icc_profile().unwrap() {
        Some(icc) => moxcms::ColorProfile::new_from_slice(&icc).unwrap(),
        None => moxcms::ColorProfile::new_srgb(),
    };
    let image = image::DynamicImage::from_decoder(decoder)
        .unwrap()
        .to_rgba32f();
    Decoded { image, profile }
}

impl Decoded {
    /// 原图坐标中的色块在派生图里的平均 Lab 与 alpha。
    fn patch(&self, p: &gate::Patch, original_width: u32) -> ([f32; 3], f32) {
        let scale = self.image.width() as f64 / original_width as f64;
        let x0 = (p.x as f64 * scale).ceil() as u32;
        let y0 = (p.y as f64 * scale).ceil() as u32;
        let x1 = ((p.x + p.width) as f64 * scale).floor() as u32;
        let y1 = ((p.y + p.height) as f64 * scale).floor() as u32;
        let mut sum = [0f64; 4];
        let mut n = 0.0;
        for y in y0..y1 {
            for x in x0..x1 {
                let px = self.image.get_pixel(x, y).0;
                for c in 0..4 {
                    sum[c] += px[c] as f64;
                }
                n += 1.0;
            }
        }
        assert!(n > 0.0, "色块在派生图中为空");
        let mean = sum.map(|s| (s / n) as f32);
        (lab_of(&self.profile, [mean[0], mean[1], mean[2]]), mean[3])
    }
}

/// 设备 RGB 经配置文件到 CIE Lab（D50）。
fn lab_of(profile: &moxcms::ColorProfile, rgb: [f32; 3]) -> [f32; 3] {
    let mut wide = moxcms::ColorProfile::new_bt2020();
    let one = moxcms::curve_from_gamma(1.0);
    wide.red_trc = Some(one.clone());
    wide.green_trc = Some(one.clone());
    wide.blue_trc = Some(one);
    wide.cicp = None;
    let transform = profile
        .create_transform_f32(
            moxcms::Layout::Rgb,
            &wide,
            moxcms::Layout::Rgb,
            moxcms::TransformOptions::default(),
        )
        .unwrap();
    let mut lin = [0f32; 3];
    transform.transform(&rgb, &mut lin).unwrap();
    let m = wide.rgb_to_xyz_matrix();
    let xyz = [0, 1, 2].map(|r| (0..3).map(|c| m.v[r][c] * lin[c] as f64).sum::<f64>());
    let f = |t: f64| {
        if t > 216.0 / 24389.0 {
            t.cbrt()
        } else {
            (24389.0 / 27.0 * t + 16.0) / 116.0
        }
    };
    let [fx, fy, fz] = [xyz[0] / 0.9642, xyz[1], xyz[2] / 0.8249].map(f);
    [
        (116.0 * fy - 16.0) as f32,
        (500.0 * (fx - fy)) as f32,
        (200.0 * (fy - fz)) as f32,
    ]
}

fn card_width(library: &Library, id: &str) -> u32 {
    library
        .browse(&BrowseQuery {
            scope: Default::default(),
            conditions: Default::default(),
            cursor: None,
            limit: 1000,
            thumbnail_px: 128,
        })
        .unwrap()
        .cards
        .into_iter()
        .find(|c| c.id == id)
        .unwrap()
        .width
}

#[test]
fn every_gated_sample_keeps_its_colour_in_the_thumbnail() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    let mut failures = Vec::new();
    for sample in gate_samples().iter().filter(|s| s.gated) {
        let id = import_sample(&library, dir.path(), sample);
        let width = card_width(&library, &id);
        let thumb = decode_derivative(&library.thumbnail(&id, 128).unwrap());
        assert_eq!(thumb.image.width(), 128, "{}", sample.file_name);
        for (i, p) in sample.patches.iter().enumerate() {
            let (lab, alpha) = thumb.patch(p, width);
            let de = delta_e2000(lab, p.lab);
            if de >= 1.0 || (alpha - p.alpha).abs() > 0.02 {
                failures.push(format!(
                    "{} 色块 {i}：ΔE2000 = {de:.2}（期望 {:?}，实际 {lab:?}），alpha {alpha:.3}／{:.3}",
                    sample.file_name, p.lab, p.alpha
                ));
            }
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

/// 派生图文件的格式、位深与嵌入的 ICC。
fn container_of(path: &Path) -> (image::ImageFormat, image::ColorType, Option<Vec<u8>>) {
    use image::ImageDecoder;
    let reader = image::ImageReader::open(path)
        .unwrap()
        .with_guessed_format()
        .unwrap();
    let format = reader.format().unwrap();
    let mut decoder = reader.into_decoder().unwrap();
    (format, decoder.color_type(), decoder.icc_profile().unwrap())
}

#[test]
#[allow(clippy::type_complexity)] // 表格式的用例，一行一个样本。
fn thumbnails_are_stored_losslessly_in_a_tier_chosen_by_the_source() {
    use image::ColorType as C;
    use image::ImageFormat as F;
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    let p3_icc = |name: &str| {
        image::ImageReader::new(std::io::Cursor::new(&gate_sample(name).bytes))
            .with_guessed_format()
            .unwrap()
            .into_decoder()
            .map(|mut d| image::ImageDecoder::icc_profile(&mut d).unwrap())
            .unwrap()
    };
    let display_p3 = {
        // 转换到 Display P3 的派生图带同一份 Display P3 配置文件。
        let thumb = library
            .thumbnail(
                &import_sample(&library, dir.path(), gate_sample("lut-a2b0.png")),
                128,
            )
            .unwrap();
        container_of(&thumb).2.expect("带 ICC")
    };
    let display_p3_profile = moxcms::ColorProfile::new_from_slice(&display_p3).unwrap();
    assert!(display_p3_profile.lut_a_to_b_perceptual.is_none());

    // (样本, 格式, 颜色类型, ICC：None＝不带, Some(None)＝Display P3, Some(Some(b))＝原 ICC)
    let cases: Vec<(&str, F, C, Option<Option<Vec<u8>>>)> = vec![
        ("orientation-1.jpg", F::WebP, C::Rgb8, None),
        ("alpha-edge.png", F::WebP, C::Rgba8, None),
        ("srgb-vs-gama.png", F::WebP, C::Rgb8, None),
        ("animated.gif", F::WebP, C::Rgb8, None),
        ("p3-v4.jpg", F::WebP, C::Rgb8, Some(p3_icc("p3-v4.jpg"))),
        (
            "adobe-rgb.jpg",
            F::WebP,
            C::Rgb8,
            Some(p3_icc("adobe-rgb.jpg")),
        ),
        (
            "png16-p3.png",
            F::Png,
            C::Rgb16,
            Some(p3_icc("png16-p3.png")),
        ),
        ("png16-gray-ramp.png", F::Png, C::Rgb16, None),
        ("cmyk-profile.jpg", F::Png, C::Rgb16, Some(None)),
        ("gama-18.png", F::Png, C::Rgb16, Some(None)),
        ("cicp-p3.png", F::Png, C::Rgb16, Some(None)),
        ("gray-gamma22.jpg", F::Png, C::Rgb16, Some(None)),
        ("pq.png", F::Png, C::Rgb16, Some(None)),
    ];
    for (name, format, color, icc) in cases {
        let id = import_sample(&library, dir.path(), gate_sample(name));
        let (f, c, embedded) = container_of(&library.thumbnail(&id, 128).unwrap());
        let expected_icc = match icc {
            None => None,
            Some(None) => Some(display_p3.clone()),
            Some(Some(bytes)) => Some(bytes),
        };
        assert_eq!((f, c), (format, color), "{name}");
        assert_eq!(embedded, expected_icc, "{name}");
    }
}

#[test]
fn hdr_originals_get_an_sdr_thumbnail_with_reference_white_near_sdr_white() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    for name in ["pq.png", "hlg.png"] {
        let id = import_sample(&library, dir.path(), gate_sample(name));
        let path = library.thumbnail(&id, 128).unwrap();
        // 派生图是带 Display P3 ICC 的普通 PNG，没有 cICP（不会被当作 HDR 显示）。
        let bytes = std::fs::read(&path).unwrap();
        assert!(!bytes.windows(4).any(|w| w == b"cICP"), "{name}");
        let thumb = decode_derivative(&path);
        // 色块：0＝203 尼特白，2＝1000 尼特白，3＝20 尼特灰。
        let at = |block: u32| {
            let (bw, bh) = (thumb.image.width() / 4, thumb.image.height() / 2);
            let (x, y) = ((block % 4) * bw + bw / 2, (block / 4) * bh + bh / 2);
            lab_of(&thumb.profile, {
                let p = thumb.image.get_pixel(x, y).0;
                [p[0], p[1], p[2]]
            })[0]
        };
        let (reference, peak, dim) = (at(0), at(2), at(3));
        assert!(
            (90.0..99.5).contains(&reference),
            "{name} 参考白 L* = {reference}"
        );
        assert!(peak > reference && peak <= 100.5, "{name} 峰值 L* = {peak}");
        assert!(dim < reference * 0.6, "{name} 暗部 L* = {dim}");
    }
}

#[test]
fn an_animated_original_shows_its_first_frame_as_a_still_thumbnail() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    for name in ["animated.gif", "animated.png", "animated.webp"] {
        let id = import_sample(&library, dir.path(), gate_sample(name));
        let bytes = std::fs::read(library.thumbnail(&id, 128).unwrap()).unwrap();
        // 静止的无损 WebP：没有 ANIM 块。首帧色块的颜色由色彩门槛测试覆盖。
        assert!(!bytes.windows(4).any(|w| w == b"ANIM"), "{name}");
        assert!(!bytes.windows(4).any(|w| w == b"acTL"), "{name}");
    }
}

#[test]
fn downscaling_averages_light_linearly_and_keeps_transparent_edges_clean() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    // 左半边：1 px 黑白竖线；右半边：不透明红色，旁边是全透明的黑。
    let path = write(
        &dir.path().join("in/lines.png"),
        &png_rgba(512, 64, |x, _| {
            if x < 256 {
                if x % 2 == 0 {
                    [0, 0, 0, 255]
                } else {
                    [255, 255, 255, 255]
                }
            } else if x < 384 {
                [255, 0, 0, 255]
            } else {
                [0, 0, 0, 0]
            }
        }),
    );
    let id = import_one(&library, &path);
    let thumb = image::open(library.thumbnail(&id, 128).unwrap())
        .unwrap()
        .to_rgba8();
    assert_eq!(thumb.dimensions(), (128, 16));

    // 线性光平均：一半白光 → sRGB 编码约 188；在编码值上平均会得到约 128。
    let grey = thumb.get_pixel(32, 8).0;
    assert!((185..=191).contains(&grey[0]), "线条区 {grey:?}");

    // 预乘 alpha：红色与透明交界处只变透明，不变暗、不带黑边。
    for x in 90..100 {
        let p = thumb.get_pixel(x, 8).0;
        if p[3] > 8 {
            assert!(p[0] >= 250 && p[1] <= 4 && p[2] <= 4, "x = {x}: {p:?}");
        }
    }
}

#[test]
fn thumbnails_of_an_older_pipeline_version_are_removed_and_rebuilt() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lib");
    let library = Library::create(&root, "库").unwrap();
    let id = import_sample(&library, dir.path(), gate_sample("p3-v4.jpg"));
    let current = library.thumbnail(&id, 128).unwrap();
    drop(library);

    // #44 的 v0 管线留下的缓存（同一原图、同一档位）。
    let stale = root.join("cache/thumbs/v0/ab/abcdef-128.webp");
    std::fs::create_dir_all(stale.parent().unwrap()).unwrap();
    std::fs::write(&stale, b"old").unwrap();
    std::fs::remove_file(&current).unwrap();

    let reopened = Library::open(&root).unwrap();
    let rebuilt = reopened.thumbnail(&id, 128).unwrap();
    assert_eq!(rebuilt, current);
    assert!(rebuilt.is_file());
    assert!(!rebuilt.to_string_lossy().contains("v0"));
    // 旧版本目录在后台删除。
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while root.join("cache/thumbs/v0").exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "旧缩略图目录没有被删除"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[test]
fn the_gate_run_imports_every_sample_into_a_fresh_library_with_fixed_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let run = gate::prepare(&dir.path().join("gate")).unwrap();

    assert_eq!(run.items.len(), gate_samples().len());
    for (item, sample) in run.items.iter().zip(gate_samples()) {
        assert_eq!(item.sample.file_name, sample.file_name);
        // 每次生成的字节相同，哈希可以写进验收约定。
        assert_eq!(item.sample.bytes, sample.bytes, "{}", sample.file_name);
        assert_eq!(
            std::fs::read(run.samples_dir.join(&sample.file_name)).unwrap(),
            sample.bytes
        );
        assert_eq!(
            std::fs::read(run.library.original_path(&item.image_id).unwrap()).unwrap(),
            sample.bytes
        );
        // 色块都落在转正后的原图里。
        for p in &item.sample.patches {
            assert!(p.x + p.width <= item.width && p.y + p.height <= item.height);
        }
    }
    let mut names: Vec<_> = run.items.iter().map(|i| &i.sample.file_name).collect();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), run.items.len());
}
