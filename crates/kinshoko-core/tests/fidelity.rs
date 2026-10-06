//! 还原度管线（#45）：导入时记录色彩描述；缩略图按与 Chromium 相同的色彩声明规则解释，
//! 在线性光 f32 下预乘缩放，按来源分档无损保存；动图与 HDR 原图生成 `sdr` 派生图。
//! 全部通过 `Library` 的对外接口，用临时目录里的真 SQLite 与真文件。

use std::path::{Path, PathBuf};

use image::{ImageEncoder, RgbaImage};
use kinshoko_core::Library;
use kinshoko_core::fidelity::gate::{self, GateSample};
use kinshoko_core::library::{
    ColourDeclaration, ColourDescription, ColourModel, HdrKind, IccKind, ImportOutcome,
    ImportSource,
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
