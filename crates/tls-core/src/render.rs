//! Исполнение плана: рабочая папка, прогресс, отмена, запись через .part.
use crate::error::{explain_ffmpeg_failure, Error, Result};
use crate::graph::{Plan, WorkFile};
use crate::tools::Tools;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Токен отмены — общий для всех процессов одной сборки.
#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst)
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

pub fn materialize(files: &[WorkFile], dir: &Path) -> Result<()> {
    for wf in files {
        match wf {
            WorkFile::Write { name, data } => std::fs::write(dir.join(name), data)?,
            WorkFile::Copy { name, from } => {
                std::fs::copy(from, dir.join(name))?;
            }
        }
    }
    Ok(())
}

/// Запуск ffmpeg с прогрессом. `progress(доля 0..1)`. Лог (без повторов) — в `log`.
pub fn run_ffmpeg(
    tools: &Tools,
    args: &[String],
    workdir: &Path,
    total: f64,
    cancel: &Cancel,
    progress: &(dyn Fn(f64) + Sync),
    log: &(dyn Fn(String) + Sync),
) -> Result<()> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let mut cmd = tools.ffmpeg_cmd();
    cmd.args([
        "-y",
        "-v",
        "error",
        "-stats_period",
        "0.5",
        "-progress",
        "pipe:1",
        "-nostats",
    ])
    .args(args);
    cmd.current_dir(workdir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    tracing::debug!(?args, "ffmpeg");
    let mut child = cmd
        .spawn()
        .map_err(|e| Error::ToolMissing(format!("{}: {e}", tools.ffmpeg.display())))?;
    crate::tools::bind_child(&child);
    let stdout = child.stdout.take().expect("stdout");
    let stderr = child.stderr.take().expect("stderr");
    let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));

    let ok = std::thread::scope(|s| {
        let tail2 = tail.clone();
        s.spawn(move || {
            let mut last = String::new();
            let mut dup = 0u32;
            for line in BufReader::new(stderr).lines().map_while(|l| l.ok()) {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                if line == last {
                    dup += 1; // ffmpeg может повторять одну ошибку тысячи раз — не копим
                    continue;
                }
                if dup > 0 {
                    log(format!("↳ повторилось ещё {dup} раз"));
                    dup = 0;
                }
                log(line.clone());
                let mut t = tail2.lock().unwrap();
                t.push_back(line.clone());
                if t.len() > 40 {
                    t.pop_front();
                }
                last = line;
            }
        });
        s.spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
                if let Some(v) = line
                    .strip_prefix("out_time_us=")
                    .or_else(|| line.strip_prefix("out_time_ms="))
                {
                    if let Ok(us) = v.trim().parse::<f64>() {
                        if total > 0.0 {
                            progress((us / 1e6 / total).clamp(0.0, 1.0));
                        }
                    }
                }
            }
        });
        // ожидание с опросом отмены
        loop {
            match child.try_wait() {
                Ok(Some(st)) => break st.success(),
                Ok(None) => {
                    if cancel.is_cancelled() {
                        let _ = child.kill();
                        let _ = child.wait();
                        break false;
                    }
                    std::thread::sleep(Duration::from_millis(150));
                }
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break false;
                }
            }
        }
    });
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    if ok {
        progress(1.0);
        Ok(())
    } else {
        let log: Vec<String> = tail.lock().unwrap().iter().cloned().collect();
        Err(Error::Ffmpeg {
            summary: explain_ffmpeg_failure(&log),
            log,
        })
    }
}

/// Рендер плана в файл `out`. Пишет в `out.part`, переименовывает только после успеха.
#[allow(clippy::too_many_arguments)]
pub fn render_plan(
    tools: &Tools,
    plan: &Plan,
    codec_args: &[String],
    workdir: &Path,
    out: &Path,
    cancel: &Cancel,
    progress: &(dyn Fn(f64) + Sync),
    log: &(dyn Fn(String) + Sync),
) -> Result<PathBuf> {
    materialize(&plan.files, workdir)?;
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let part = out.with_extension("mp4.part");
    let _ = std::fs::remove_file(&part);
    let mut args = plan.args.clone();
    args.extend(codec_args.iter().cloned());
    args.extend([
        "-movflags".into(),
        "+faststart".into(),
        "-f".into(),
        "mp4".into(),
    ]);
    args.push(part.to_string_lossy().into_owned());
    let r = run_ffmpeg(tools, &args, workdir, plan.total, cancel, progress, log);
    match r {
        Ok(()) => {
            if !part.is_file() || std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0) == 0 {
                let _ = std::fs::remove_file(&part);
                return Err(Error::Ffmpeg {
                    summary: "Видеодвижок не создал файл.".into(),
                    log: vec![],
                });
            }
            crate::util::rename_retry(&part, out)?;
            Ok(out.to_path_buf())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

/// Кадр-обложка из концовки ролика.
pub fn make_cover(tools: &Tools, video: &Path) -> Result<PathBuf> {
    let cover = video.with_extension("jpg");
    let mut c = tools.ffmpeg_cmd();
    c.args(["-v", "error", "-y", "-sseof", "-0.6", "-i"])
        .arg(video)
        .args(["-frames:v", "1", "-q:v", "2"])
        .arg(&cover);
    let o = crate::tools::run_with_timeout(c, Duration::from_secs(60), "обложка")?;
    if o.ok() && cover.is_file() {
        Ok(cover)
    } else {
        Err(Error::Ffmpeg {
            summary: "Не удалось сделать обложку".into(),
            log: vec![o.stderr_str()],
        })
    }
}
