//! 打标调度的后台循环：选档、下载与准备模型、逐张打标并写入、出错后重试（从 scheduler.rs 原样搬出）。
use super::*;

impl Worker {
    pub(super) fn run(mut self) {
        loop {
            let (stop, paused) = {
                let c = self.shared.control();
                (c.stop, c.paused)
            };
            if stop {
                break;
            }
            if paused {
                self.end_session();
                self.shared.set(TaggingStatus::Paused);
                let c = self.shared.control();
                if c.paused && !c.stop {
                    drop(self.shared.wake.wait(c));
                }
                continue;
            }
            if self.yields() {
                self.end_session();
                self.shared.set(TaggingStatus::YieldedToFullScreen);
                self.shared.sleep(self.config.poll_interval);
                continue;
            }
            self.step();
        }
        self.end_session();
    }

    /// 加载模型（显卡档首次可能要几分钟）期间在另一个线程盯着前台：要让出时立即结束正在加载的子进程，
    /// 不等加载完（#212）。返回值丢弃即停止盯着。
    fn watch_foreground_while_loading(&self) -> Option<impl Drop> {
        struct Watch(Arc<AtomicBool>);
        impl Drop for Watch {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Relaxed);
            }
        }
        let check = self.config.foreground.clone()?;
        let (shared, poll) = (self.shared.clone(), self.config.poll_interval);
        let done = Arc::new(AtomicBool::new(false));
        let seen = done.clone();
        std::thread::Builder::new()
            .name("kinshoko-tagging-foreground".into())
            .spawn(move || {
                while !seen.load(Ordering::Relaxed) {
                    if check.yields() {
                        shared.stop_session();
                        return;
                    }
                    std::thread::sleep(poll);
                }
            })
            .ok()?;
        Some(Watch(done))
    }

    /// 有全屏程序或演示模式，要让出（#212）。
    fn yields(&self) -> bool {
        self.config.foreground.as_ref().is_some_and(|f| f.yields())
    }

    /// 结束会话（打标子进程），归还显存。
    fn end_session(&mut self) {
        self.shared.set_stopper(None);
        self.session = None;
    }

    /// 显卡档在用的显卡名称；CPU 档为空。
    fn gpu_name(&self, device: Device) -> Option<String> {
        if device != Device::DirectMl {
            return None;
        }
        self.device_info
            .as_ref()
            .and_then(|info| info.gpu.as_ref())
            .map(|gpu| gpu.name.clone())
    }

    fn gpu_usable(&self) -> bool {
        self.gpu_failures < self.config.max_gpu_failures
    }

    /// 画师选了硬件档时只看这一档的模型；自动时按顺序取本机条件满足的第一个。
    fn choose(&mut self) -> Result<Choice, String> {
        let info = self
            .device_info
            .get_or_insert_with(|| self.tagger.probe())
            .clone();
        let preferred = self.shared.control().preferred;
        let mut reasons = Vec::new();
        let candidates = self
            .config
            .models
            .iter()
            .filter(|spec| preferred.is_none_or(|device| spec.device == device));
        for spec in candidates {
            let unusable = match spec.device {
                Device::DirectMl => match &info.gpu {
                    None => Some("没有独立显卡".to_owned()),
                    Some(_) if !self.gpu_usable() => Some("显卡多次出错，本次不再使用".to_owned()),
                    Some(gpu) if gpu.vram_budget < vram_wanted(spec) => Some(format!(
                        "{} 的显存额度不够（需要约 {}）",
                        gpu.name,
                        gigabytes(vram_wanted(spec))
                    )),
                    Some(_) => None,
                },
                Device::Cpu => (spec.ram_need != 0
                    && info.available_ram < spec.ram_need + RAM_MARGIN)
                    .then(|| {
                        format!(
                            "可用内存不够（需要约 {}）",
                            gigabytes(spec.ram_need + RAM_MARGIN)
                        )
                    }),
            };
            match unusable {
                Some(reason) => reasons.push(reason),
                None => {
                    return Ok(Choice {
                        spec: spec.clone(),
                        fallback: (!reasons.is_empty()).then(|| reasons.join("；")),
                    });
                }
            }
        }
        Err(if reasons.is_empty() {
            "没有可用的打标模型".into()
        } else {
            reasons.join("；")
        })
    }

    fn step(&mut self) {
        let Choice { spec, fallback } = match self.choose() {
            Ok(choice) => choice,
            Err(reason) => {
                self.end_session();
                self.shared.set(TaggingStatus::NoDevice { reason });
                // 内存可能稍后够用，重新探测。
                self.device_info = None;
                self.shared.sleep(self.config.retry_delay);
                return;
            }
        };
        if self.chosen.as_ref().is_some_and(|key| *key != spec.key) {
            // 自动档换到了另一个模型（例如显卡不可用退到 CPU）：它的下载要画师重新确认。
            self.shared.control().download = false;
        }
        self.chosen = Some(spec.key.clone());
        let Some(model) = self.model(&spec, fallback) else {
            return;
        };
        let source = FactSource::model(&spec.source);
        let ids = match self.library.images_to_tag(&source, BATCH) {
            Ok(ids) => ids,
            Err(e) => return self.fail(format!("读取待打标的图失败：{e}")),
        };
        if ids.is_empty() {
            self.end_session();
            self.shared.set(TaggingStatus::Idle {
                model: spec.label.clone(),
                device: spec.device,
                gpu: self.gpu_name(spec.device),
                tagged: self.tagged,
            });
            self.shared.sleep(self.config.poll_interval);
            return;
        }
        for id in ids {
            if self.shared.interrupted() || self.yields() {
                return;
            }
            if !self.tag_one(&model, &source, &id) {
                return;
            }
        }
    }

    /// 模型就绪时返回；否则显示需要下载或下载进度，返回 `None`。
    fn model(&mut self, spec: &ModelSpec, fallback: Option<String>) -> Option<PreparedModel> {
        if let Some(model) = self.store.ready(spec) {
            return Some(model);
        }
        self.end_session();
        let control = self.shared.control();
        if control.paused || control.stop {
            return None;
        }
        let (confirmed, cancelled) = (control.download, control.cancelled);
        if confirmed {
            // 之前的暂停或取消已经生效；这一次下载重新开始计。
            self.shared.cancel.store(false, Ordering::Relaxed);
        }
        drop(control);
        if !confirmed {
            self.shared.set(TaggingStatus::NeedsDownload {
                model: spec.label.clone(),
                size: spec.download_size(),
                downloaded: self.store.downloaded(spec),
                fallback,
                cancelled,
            });
            self.shared.sleep(self.config.poll_interval);
            return None;
        }
        let shared = self.shared.clone();
        let label = spec.label.clone();
        let mut progress = |stage: PrepareStage| {
            shared.set(match stage {
                PrepareStage::Downloading { downloaded, total } => TaggingStatus::Downloading {
                    model: label.clone(),
                    downloaded,
                    total,
                },
                PrepareStage::Verifying => TaggingStatus::Preparing {
                    model: label.clone(),
                },
            })
        };
        match self.store.prepare(spec, &mut progress, &self.shared.cancel) {
            Ok(model) => Some(model),
            // 暂停、取消或停止打断了下载：不算出错，由主循环转到对应的状态。同时出的真错误（例如校验不过）
            // 留到下一次下载时再报。
            Err(_) if self.shared.cancel.load(Ordering::Relaxed) => None,
            Err(reason) => {
                self.fail(reason);
                None
            }
        }
    }

    fn fail(&mut self, reason: String) {
        self.end_session();
        self.shared.set(TaggingStatus::Failed { reason });
        self.shared.sleep(self.config.retry_delay);
    }

    /// 打一张图并写入。返回 `false` 表示这一批要中止（会话失效等）。
    fn tag_one(&mut self, model: &PreparedModel, source: &FactSource, id: &str) -> bool {
        let spec = &model.spec;
        let path = match self.library.original_to_tag(id) {
            Ok(path) => path,
            // 图在此期间被删除了。
            Err(LibraryError::UnknownImage) => return true,
            Err(e) => {
                self.fail(format!("读取原图位置失败：{e}"));
                return false;
            }
        };
        if self
            .session
            .as_ref()
            .is_none_or(|(key, _)| *key != spec.key)
        {
            self.end_session();
            let shared = self.shared.clone();
            let watch = self.watch_foreground_while_loading();
            let started = self.tagger.start(model, spec.device, &move |stopper| {
                shared.register_stopper(stopper)
            });
            drop(watch);
            match started {
                Ok(session) => {
                    self.session = Some((spec.key.clone(), session));
                }
                Err(_) if self.shared.interrupted() || self.yields() => {
                    // 加载中画师暂停（或关闭资料库）结束了子进程：不算出错，恢复后重新开始。
                    self.end_session();
                    return false;
                }
                Err(failure) => {
                    if spec.device == Device::DirectMl {
                        self.gpu_failures += 1;
                    }
                    self.fail(format!("无法开始打标：{failure}"));
                    return false;
                }
            }
            // 加载刚完成时画师暂停了或全屏程序出现了：开关可能已被按过，这里确保会话结束。
            if self.shared.interrupted() || self.yields() {
                self.end_session();
                return false;
            }
        }
        self.shared.set(TaggingStatus::Running {
            model: spec.label.clone(),
            device: spec.device,
            gpu: self.gpu_name(spec.device),
            tagged: self.tagged,
        });
        let (_, session) = self.session.as_mut().expect("会话已开始");
        let result = session.tag(&path);
        let written = match result {
            Ok(raw) => {
                let s = interpret(spec, &raw);
                // Only publication joins the application's final side-effect boundary.
                // Inference and model loading above must never hold it.
                let gate = self.config.publication_gate.clone();
                let publication = gate
                    .as_ref()
                    .map(|gate| gate.lock().unwrap_or_else(|error| error.into_inner()));
                if self.shared.interrupted() {
                    drop(publication);
                    self.end_session();
                    return false;
                }
                self.crashes.remove(id);
                self.tagged += 1;
                self.library
                    .replace_source_tags(source, id, &s.tags)
                    .and_then(|()| self.library.replace_source_rating(source, id, s.rating))
                    .and_then(|()| {
                        self.library
                            .finish_tagging(source, id, TaggingOutcome::Done)
                    })
            }
            Err(TagFailure::BadImage(reason)) => {
                self.library
                    .finish_tagging(source, id, TaggingOutcome::Failed(reason))
            }
            Err(_) if self.shared.interrupted() => {
                // 画师暂停（或停止）时结束了会话：这张不算出错，恢复后重打。
                self.end_session();
                return false;
            }
            Err(failure) => {
                // 会话已失效：结束它，稍后重启。
                self.end_session();
                if matches!(failure, TagFailure::DeviceLost(_)) && spec.device == Device::DirectMl {
                    // 输入尺寸固定，显卡重置或显存溢出不怪这张图：记在显卡头上，多次后退到 CPU 档。
                    self.gpu_failures += 1;
                    self.fail(failure.to_string());
                    return false;
                }
                let crashes = self.crashes.entry(id.to_owned()).or_default();
                *crashes += 1;
                if *crashes >= self.config.max_crashes_per_image {
                    self.crashes.remove(id);
                    let reason = format!("打标子进程在这张图上反复出错：{failure}");
                    let _ = self
                        .library
                        .finish_tagging(source, id, TaggingOutcome::Failed(reason));
                }
                self.fail(failure.to_string());
                return false;
            }
        };
        match written {
            Ok(()) | Err(LibraryError::UnknownImage) => true,
            Err(e) => {
                self.fail(format!("写入标签建议失败：{e}"));
                false
            }
        }
    }
}

/// 显卡档要求的显存额度：比峰值估计多 25%。
fn vram_wanted(spec: &ModelSpec) -> u64 {
    spec.vram_need / 4 * 5
}

/// 给画师看的大小，例如 `2.3 GB`。
fn gigabytes(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1e9)
}
