//! 诊断（#70）：“强制 sRGB”开关的 WebView2 启动参数，以及给画师导出的诊断日志。
//! 诊断日志只含硬件、系统与显示器的色彩状态，不含文件名、路径与图片。

use kinshoko_core::diagnostics::{
    AppFacts, CanvasBuffer, CapabilityCheck, DisplayColourMode, DisplayFacts, RuntimeCapabilities,
    SystemFacts, report, report_with_runtime, webview_browser_args,
};

/// Tauri（wry）不传启动参数时 WebView2 默认带的参数；自己传参数时要保留。
const WRY_DEFAULT: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

#[test]
fn without_forcing_srgb_webview2_starts_with_the_tauri_defaults_only() {
    assert_eq!(webview_browser_args(false), WRY_DEFAULT);
}

#[test]
fn forcing_srgb_keeps_the_tauri_defaults_and_adds_the_chromium_colour_profile_switch() {
    assert_eq!(
        webview_browser_args(true),
        format!("{WRY_DEFAULT} --force-color-profile=srgb")
    );
}

fn app() -> AppFacts {
    AppFacts {
        version: "0.1.0".into(),
        force_srgb: true,
        force_srgb_in_effect: false,
        usage_log: false,
    }
}

fn display(name: &str, mode: DisplayColourMode, icc: Option<Vec<u8>>) -> DisplayFacts {
    DisplayFacts {
        name: name.into(),
        primary: true,
        width: 2560,
        height: 1440,
        scale: 1.25,
        colour_mode: mode,
        bits_per_channel: Some(8),
        icc,
    }
}

fn system(displays: Vec<DisplayFacts>) -> SystemFacts {
    SystemFacts {
        windows: "Windows 11 Pro 25H2（26200.9550）".into(),
        cpu: "Intel(R) Core(TM) i5-10400F CPU @ 2.90GHz".into(),
        memory_bytes: 17 * 1024 * 1024 * 1024,
        gpus: vec!["AMD Radeon RX 6500 XT".into()],
        webview2: Some("154.0.4258.53".into()),
        displays,
    }
}

const GENERATED_AT: u64 = 1_791_331_200; // 2026-10-07 00:00:00 UTC

#[test]
fn a_system_report_does_not_infer_renderer_support_from_windows_or_webview_version() {
    let text = report(&app(), &system(Vec::new()), GENERATED_AT);
    assert!(text.contains("[运行时能力]"), "{text}");
    assert!(text.contains("本窗口未执行能力检查"), "{text}");
}

#[test]
fn a_missing_pin_canvas_has_a_specific_reason_without_claiming_a_colour_result() {
    let runtime = RuntimeCapabilities {
        image_decode: CapabilityCheck::Available,
        canvas_2d: CapabilityCheck::Missing,
        canvas_buffer: CanvasBuffer::Unavailable,
    };
    let text = report_with_runtime(&app(), &system(Vec::new()), GENERATED_AT, Some(&runtime));
    assert!(text.contains("无法建立二维画布，钉图无法显示"), "{text}");
    assert!(text.contains("不代表色彩门槛通过"), "{text}");
    assert!(!runtime.assess().problems.is_empty());
}

#[test]
fn the_report_lists_hardware_webview2_and_each_displays_colour_state() {
    let text = report(
        &app(),
        &system(vec![
            display("DELL U2723QE", DisplayColourMode::Sdr, None),
            display("LG HDR 4K", DisplayColourMode::Hdr, None),
        ]),
        GENERATED_AT,
    );

    for expected in [
        "Kinshoko 0.1.0",
        "2026-10-07 00:00:00 UTC",
        "Windows 11 Pro 25H2（26200.9550）",
        "i5-10400F",
        "17.0 GB",
        "AMD Radeon RX 6500 XT",
        "WebView2：154.0.4258.53",
        "DELL U2723QE",
        "2560×1440",
        "125%",
        "SDR",
        "LG HDR 4K",
        "HDR",
        "无配置文件",
        "强制 sRGB：已开启，重启后生效",
        "使用日志：关闭",
    ] {
        assert!(
            text.contains(expected),
            "缺少“{expected}”：
{text}"
        );
    }
}

/// Windows 自带的 sRGB 配置文件（ICC v2.1，矩阵＋曲线）。
const WINDOWS_SRGB: &str = r"C:\Windows\System32\spool\drivers\color\sRGB Color Space Profile.icm";

#[test]
fn a_display_profile_is_described_by_its_name_version_and_kind_never_by_its_file() {
    let Ok(icc) = std::fs::read(WINDOWS_SRGB) else {
        return; // 不是 Windows：没有系统配置文件可读。
    };
    let text = report(
        &app(),
        &system(vec![display("屏幕", DisplayColourMode::Sdr, Some(icc))]),
        GENERATED_AT,
    );
    assert!(text.contains("sRGB IEC61966-2.1"), "{text}");
    assert!(text.contains("ICC 2.1"), "{text}");
    assert!(text.contains("矩阵"), "{text}");
    assert!(!text.contains("Color Space Profile.icm"), "{text}");
}

#[test]
fn an_unreadable_display_profile_is_reported_as_such() {
    let text = report(
        &app(),
        &system(vec![display(
            "屏幕",
            DisplayColourMode::Sdr,
            Some(b"bad".to_vec()),
        )]),
        GENERATED_AT,
    );
    assert!(text.contains("无法解析"), "{text}");
}

#[test]
fn paths_and_image_file_names_reported_by_the_system_never_reach_the_report() {
    let mut sys = system(vec![display(
        r"C:\Users\画师\Pictures\秘密参考.png",
        DisplayColourMode::AutoColourManagement,
        None,
    )]);
    sys.gpus = vec![
        r"\\nas\share\参考\pose.jpg".into(),
        "/home/artist/ref.webp".into(),
    ];
    sys.cpu = "Intel D:\\私人\\a.txt i7".into();
    sys.webview2 = Some("file:///C:/Users/画师/x.png".into());

    let text = report(&app(), &sys, GENERATED_AT);

    for leaked in [
        "画师",
        "Pictures",
        "秘密参考",
        "nas",
        "share",
        "pose",
        "artist",
        "ref.webp",
        "私人",
        "a.txt",
        "file:",
    ] {
        assert!(!text.contains(leaked), "报告泄露了“{leaked}”：\n{text}");
    }
    assert!(text.contains("<路径>"), "{text}");
    assert!(text.contains("自动色彩管理"), "{text}");
}
