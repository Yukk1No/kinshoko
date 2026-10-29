//! 原生钉图的逐帧核对与平台层验收（#283）：用 `frame::plan` 与 pin-render 驱动测试钉图，经 pin-shell
//! 上屏，DXGI 桌面复制逐帧核对；量换窗等待、界面线程每条消息的处理时间、焦点、穿透、全屏判定。
//! 开发工具，不进发布包。用法见 README。
//!
//! 工具直接调 Win32 读系统状态、发真实输入：`unsafe` 块只读写本函数持有的缓冲区和本进程的窗口，
//! 不像应用代码那样逐处写 SAFETY 说明；会碰别的进程的只有 SendInput 与 WindowFromPoint 这类查询。

mod app;
mod follow;
mod grab;
mod input;
mod modes;
mod rect;
mod selftest;
mod sys;
mod verify;

use app::{App, Options};

fn parse() -> Result<(Options, Vec<String>), String> {
    let mut o = Options {
        count: 1,
        ..Default::default()
    };
    let mut rest = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut value = |name: &str| args.next().ok_or(format!("{name} 后面要一个值"));
        match a.as_str() {
            "--selftest" => o.selftest = Some(value("--selftest")?.into()),
            "--verify" => o.verify = true,
            "--naive" => o.naive = true,
            "--present-first" => o.present_first = true,
            "--count" => o.count = value("--count")?.parse().map_err(|_| "--count 要数字")?,
            "--hold" => o.hold_ms = Some(value("--hold")?.parse().map_err(|_| "--hold 要毫秒")?),
            "--fill" => o.fill = true,
            "--input-test" => o.input_test = true,
            "--region-test" => o.region_test = true,
            "--scale" => o.scale = Some(value("--scale")?.parse().map_err(|_| "--scale 要数字")?),
            "--device-loss" | "--info" => rest.push(a),
            "--key-sink" => {
                let s: u32 = value("--key-sink")?
                    .parse()
                    .map_err(|_| "--key-sink 要秒数")?;
                input::key_sink(s);
                std::process::exit(0);
            }
            s => return Err(format!("不认识的选项 {s}，用法见 README")),
        }
    }
    Ok((o, rest))
}

fn run() -> Result<bool, String> {
    // `--app <提交记录> <报告>`：核对真实应用里的原生钉图，工具自己不建平台层与渲染层。
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let [mode, trace, report] = &args[..]
        && mode == "--app"
    {
        return follow::follow(&follow::Follow {
            trace: trace.into(),
            report: report.into(),
        });
    }
    // `--grab <x> <y> <宽> <高> <out.png>`：桌面复制拍一块屏幕，给探针核对像素。
    if let [mode, x, y, w, h, out] = &args[..]
        && mode == "--grab"
    {
        let n = |v: &str| v.parse::<i32>().map_err(|_| format!("--grab 要整数：{v}"));
        grab::grab(rect::Rect::new(n(x)?, n(y)?, n(w)?, n(h)?), out.as_ref())?;
        return Ok(true);
    }
    let (opts, rest) = parse()?;
    if rest.iter().any(|a| a == "--info") {
        let mem = (sys::private_mb(), sys::vram_mb());
        let r = pin_render::Renderer::new().map_err(|e| e.to_string())?;
        println!(
            "{}；刷新 {:.2} ms；QUNS {}；建设备前 私有 {:.0} MB、显存 {:.0} MB；之后 私有 {:.0} MB、显存 {:.0} MB",
            r.describe(),
            sys::refresh_ms(),
            sys::quns(),
            mem.0,
            mem.1,
            sys::private_mb(),
            sys::vram_mb()
        );
        return Ok(true);
    }
    let mut app = App::new(opts.clone())?;
    let before = (sys::private_mb(), sys::vram_mb());
    for k in 0..opts.count {
        app.add_pin(k)?;
    }
    println!(
        "设备与 {} 张钉图：私有 {:.0} → {:.0} MB，显存 {:.0} → {:.0} MB",
        app.pins.len(),
        before.0,
        sys::private_mb(),
        before.1,
        sys::vram_mb()
    );
    if let Some(report) = opts.selftest.clone() {
        return selftest::selftest(&mut app, &report);
    }
    if let Some(ms) = opts.hold_ms {
        return modes::hold(&mut app, ms);
    }
    if opts.input_test {
        return input::input_test(&mut app);
    }
    if opts.region_test {
        modes::region_test(&mut app)?;
        return Ok(true);
    }
    if rest.iter().any(|a| a == "--device-loss") {
        return modes::device_loss(&mut app);
    }
    Err("没有指定模式，用法见 README".into())
}

fn main() {
    match run() {
        Ok(true) => {}
        Ok(false) => {
            eprintln!("验收不通过");
            std::process::exit(2);
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
