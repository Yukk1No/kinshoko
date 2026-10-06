//! 打标子进程 adapter 与子进程一侧的循环（ADR-0004）。
//!
//! 主进程以子命令启动同一个 exe（[`ProcessTagger`]），经标准输入输出逐行交换 JSON：
//! 第一行是请求（探测本机条件，或加载模型），之后每行一张图。子进程崩溃、显存溢出或卡住
//! 只影响子进程：主进程按超时结束它，报告 [`TagFailure`]，由调度决定重启。
//! 标准输出里不是协议的行（例如运行库的日志）一律忽略。

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::port::{Device, DeviceInfo, PreparedModel, RawTag, TagFailure, Tagger, TaggerSession};

/// 主进程 → 子进程的第一行。
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
enum Hello {
    Probe,
    Load {
        onnx: PathBuf,
        tags: PathBuf,
        device: Device,
    },
}

/// 主进程 → 子进程：打一张图。
#[derive(Debug, Serialize, Deserialize)]
struct Request {
    image: PathBuf,
}

/// 子进程 → 主进程。
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Reply {
    Probe {
        info: DeviceInfo,
    },
    Ready,
    Tags {
        tags: Vec<RawTag>,
    },
    BadImage {
        reason: String,
    },
    #[serde(rename_all = "camelCase")]
    Fatal {
        reason: String,
        device_lost: bool,
    },
}

/// 子进程里推理失败的种类。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    /// 这张图无法打标；继续处理下一张。
    BadImage(String),
    /// 显卡被重置或显存溢出；子进程随即退出。
    DeviceLost(String),
    /// 其他无法继续的错误；子进程随即退出。
    Fatal(String),
}

/// 子进程里的推理后端（应用壳用 ONNX Runtime 实现）。
pub trait Backend {
    fn probe(&mut self) -> DeviceInfo;
    fn load(
        &mut self,
        onnx: &Path,
        tags_csv: &Path,
        device: Device,
    ) -> Result<Box<dyn Engine>, EngineError>;
}

/// 加载好模型的推理引擎。
pub trait Engine {
    fn tag(&mut self, image: &Path) -> Result<Vec<RawTag>, EngineError>;
}

fn send(out: &mut impl Write, reply: &Reply) -> bool {
    serde_json::to_writer(&mut *out, reply).is_ok()
        && out.write_all(b"\n").is_ok()
        && out.flush().is_ok()
}

fn fatal(err: EngineError) -> Reply {
    match err {
        EngineError::DeviceLost(reason) => Reply::Fatal {
            reason,
            device_lost: true,
        },
        EngineError::BadImage(reason) | EngineError::Fatal(reason) => Reply::Fatal {
            reason,
            device_lost: false,
        },
    }
}

/// 子进程的主循环：读请求、推理、写结果。标准输入关闭时正常结束；返回进程退出码。
pub fn serve(backend: &mut dyn Backend, input: impl BufRead, mut output: impl Write) -> i32 {
    let mut lines = input.lines();
    let hello = match lines.next() {
        Some(Ok(line)) => serde_json::from_str::<Hello>(&line),
        _ => return 0,
    };
    let mut engine = match hello {
        Ok(Hello::Probe) => {
            send(
                &mut output,
                &Reply::Probe {
                    info: backend.probe(),
                },
            );
            return 0;
        }
        Ok(Hello::Load { onnx, tags, device }) => match backend.load(&onnx, &tags, device) {
            Ok(engine) => engine,
            Err(e) => {
                send(&mut output, &fatal(e));
                return 1;
            }
        },
        Err(e) => {
            send(
                &mut output,
                &fatal(EngineError::Fatal(format!("无法理解的请求：{e}"))),
            );
            return 2;
        }
    };
    if !send(&mut output, &Reply::Ready) {
        return 0;
    }
    for line in lines {
        let Ok(line) = line else { return 0 };
        let Ok(request) = serde_json::from_str::<Request>(&line) else {
            continue;
        };
        let reply = match engine.tag(&request.image) {
            Ok(tags) => Reply::Tags { tags },
            Err(EngineError::BadImage(reason)) => Reply::BadImage { reason },
            Err(e) => {
                send(&mut output, &fatal(e));
                return 1;
            }
        };
        if !send(&mut output, &reply) {
            return 0;
        }
    }
    0
}

/// 以子命令启动打标子进程的 adapter。
#[derive(Debug, Clone)]
pub struct ProcessTagger {
    exe: PathBuf,
    args: Vec<String>,
    envs: Vec<(String, String)>,
    /// 等待加载模型的上限（DirectML 首次编译图较慢）。
    pub load_timeout: Duration,
    /// 单张图的上限；超过时结束子进程（显存超额时 Windows 换页，一张要一分钟）。
    pub image_timeout: Duration,
}

impl ProcessTagger {
    /// `exe args…` 启动子进程，例如当前 exe 加子命令 `tagger`。
    pub fn new(exe: PathBuf, args: Vec<String>) -> ProcessTagger {
        ProcessTagger {
            exe,
            args,
            envs: Vec::new(),
            load_timeout: Duration::from_secs(300),
            image_timeout: Duration::from_secs(90),
        }
    }

    pub fn env(mut self, key: &str, value: &str) -> ProcessTagger {
        self.envs.push((key.to_owned(), value.to_owned()));
        self
    }

    fn spawn(&self, hello: &Hello) -> Result<Running, String> {
        let mut cmd = Command::new(&self.exe);
        cmd.args(&self.args)
            .envs(self.envs.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW：发布版是窗口程序，子进程不要弹出控制台。
            cmd.creation_flags(0x0800_0000);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("无法启动打标子进程：{e}"))?;
        let stdout = child.stdout.take().expect("已设为管道");
        let stdin = child.stdin.take().expect("已设为管道");
        let (tx, rx) = channel();
        std::thread::Builder::new()
            .name("kinshoko-tagger-reader".into())
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if let Ok(reply) = serde_json::from_str::<Reply>(&line)
                        && tx.send(reply).is_err()
                    {
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let mut running = Running {
            child,
            stdin,
            replies: rx,
        };
        running
            .write(hello)
            .map_err(|e| format!("无法与打标子进程通信：{e}"))?;
        Ok(running)
    }
}

struct Running {
    child: Child,
    stdin: ChildStdin,
    replies: Receiver<Reply>,
}

impl Running {
    fn write(&mut self, msg: &impl Serialize) -> std::io::Result<()> {
        serde_json::to_writer(&mut self.stdin, msg)?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()
    }

    fn recv(&mut self, timeout: Duration) -> Result<Reply, TagFailure> {
        match self.replies.recv_timeout(timeout) {
            Ok(Reply::Fatal {
                reason,
                device_lost: true,
            }) => Err(TagFailure::DeviceLost(reason)),
            Ok(Reply::Fatal { reason, .. }) => Err(TagFailure::Crashed(reason)),
            Ok(reply) => Ok(reply),
            Err(RecvTimeoutError::Timeout) => {
                self.kill();
                Err(TagFailure::Crashed(format!(
                    "超过 {} 秒没有响应，已结束",
                    timeout.as_secs()
                )))
            }
            Err(RecvTimeoutError::Disconnected) => {
                let status = self.child.wait().map(|s| s.to_string());
                Err(TagFailure::Crashed(format!(
                    "子进程已退出（{}）",
                    status.unwrap_or_else(|e| e.to_string())
                )))
            }
        }
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        // 结束子进程即归还显存；不等它自己收尾。
        self.kill();
    }
}

impl Tagger for ProcessTagger {
    fn probe(&self) -> DeviceInfo {
        let info = self.spawn(&Hello::Probe).ok().and_then(|mut running| {
            match running.recv(Duration::from_secs(30)) {
                Ok(Reply::Probe { info }) => Some(info),
                _ => None,
            }
        });
        // 探测失败时不知道有没有独显：按没有独显、内存不限处理，至少能走 CPU 档。
        info.unwrap_or(DeviceInfo {
            gpu: None,
            available_ram: u64::MAX,
        })
    }

    fn start(
        &self,
        model: &PreparedModel,
        device: Device,
    ) -> Result<Box<dyn TaggerSession>, TagFailure> {
        let mut running = self
            .spawn(&Hello::Load {
                onnx: model.onnx.clone(),
                tags: model.tags_csv.clone(),
                device,
            })
            .map_err(TagFailure::Crashed)?;
        match running.recv(self.load_timeout)? {
            Reply::Ready => Ok(Box::new(ProcessSession {
                running,
                image_timeout: self.image_timeout,
            })),
            other => Err(TagFailure::Crashed(format!("意外的回复：{other:?}"))),
        }
    }
}

struct ProcessSession {
    running: Running,
    image_timeout: Duration,
}

impl TaggerSession for ProcessSession {
    fn tag(&mut self, image: &Path) -> Result<Vec<RawTag>, TagFailure> {
        self.running
            .write(&Request {
                image: image.to_path_buf(),
            })
            .map_err(|e| TagFailure::Crashed(format!("无法与打标子进程通信：{e}")))?;
        match self.running.recv(self.image_timeout)? {
            Reply::Tags { tags } => Ok(tags),
            Reply::BadImage { reason } => Err(TagFailure::BadImage(reason)),
            other => Err(TagFailure::Crashed(format!("意外的回复：{other:?}"))),
        }
    }
}
