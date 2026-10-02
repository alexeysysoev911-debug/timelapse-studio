//! Запуск ffmpeg/ffprobe: скрытые окна на Windows, тайм-ауты, кэш возможностей.
use crate::error::{Error, Result};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use wait_timeout::ChildExt;

#[derive(Debug, Clone)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    caps: Arc<Mutex<Option<Capabilities>>>,
}

#[derive(Debug, Clone, Default)]
pub struct Capabilities {
    pub filters: HashSet<String>,
    pub encoders: HashSet<String>,
    pub drawtext_align: bool,
}

impl Capabilities {
    pub fn has_filter(&self, f: &str) -> bool {
        self.filters.contains(f)
    }
}

pub struct Output {
    pub status: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.status == Some(0)
    }
    pub fn stdout_str(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    pub fn stderr_str(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

/// Command без всплывающего консольного окна на Windows.
pub fn hidden_command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c.stdin(Stdio::null());
    c
}

/// Привязка дочернего процесса к «заданию» Windows: если программа закроется или упадёт,
/// система сама завершит все запущенные ffmpeg (никаких «висящих» процессов в диспетчере задач).
#[cfg(windows)]
pub fn bind_child(child: &std::process::Child) {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    static JOB: OnceLock<usize> = OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if h.is_null() {
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            h,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        h as usize
    });
    if job != 0 {
        unsafe {
            AssignProcessToJobObject(job as _, child.as_raw_handle() as _);
        }
    }
}

#[cfg(not(windows))]
pub fn bind_child(_child: &std::process::Child) {}

/// Запуск с тайм-аутом; stdout/stderr читаются в отдельных потоках (нет взаимоблокировки на больших выводах).
pub fn run_with_timeout(mut cmd: Command, timeout: Duration, what: &str) -> Result<Output> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    bind_child(&child);
    let mut so = child.stdout.take().expect("stdout");
    let mut se = child.stderr.take().expect("stderr");
    let to = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = so.read_to_end(&mut b);
        b
    });
    let te = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = se.read_to_end(&mut b);
        b
    });
    let status = match child.wait_timeout(timeout)? {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::Timeout(what.to_string()));
        }
    };
    Ok(Output {
        status: status.code(),
        stdout: to.join().unwrap_or_default(),
        stderr: te.join().unwrap_or_default(),
    })
}

impl Tools {
    pub fn new(ffmpeg: impl Into<PathBuf>, ffprobe: impl Into<PathBuf>) -> Result<Self> {
        let t = Tools {
            ffmpeg: ffmpeg.into(),
            ffprobe: ffprobe.into(),
            caps: Arc::new(Mutex::new(None)),
        };
        for p in [&t.ffmpeg, &t.ffprobe] {
            let mut c = hidden_command(p);
            c.arg("-version");
            let out = run_with_timeout(c, Duration::from_secs(20), "проверка ffmpeg")
                .map_err(|e| Error::ToolMissing(format!("{}: {e}", p.display())))?;
            if !out.ok() {
                return Err(Error::ToolMissing(p.display().to_string()));
            }
        }
        Ok(t)
    }

    /// Ищет ffmpeg рядом с программой (в папке `dir`), затем в PATH.
    pub fn discover(dir: Option<&Path>) -> Result<Self> {
        let exe = |n: &str| {
            if cfg!(windows) {
                format!("{n}.exe")
            } else {
                n.to_string()
            }
        };
        if let Some(d) = dir {
            let f = d.join(exe("ffmpeg"));
            let p = d.join(exe("ffprobe"));
            if f.is_file() && p.is_file() {
                return Tools::new(f, p);
            }
        }
        Tools::new(exe("ffmpeg"), exe("ffprobe"))
    }

    pub fn ffmpeg_cmd(&self) -> Command {
        let mut c = hidden_command(&self.ffmpeg);
        c.arg("-hide_banner").arg("-nostdin");
        c
    }

    pub fn ffprobe_cmd(&self) -> Command {
        let mut c = hidden_command(&self.ffprobe);
        c.arg("-hide_banner");
        c
    }

    /// Список фильтров и кодировщиков, кэшируется на время работы.
    pub fn capabilities(&self) -> Capabilities {
        if let Some(c) = self.caps.lock().unwrap().clone() {
            return c;
        }
        let mut caps = Capabilities::default();
        let mut c = self.ffmpeg_cmd();
        c.arg("-filters");
        if let Ok(o) = run_with_timeout(c, Duration::from_secs(30), "список фильтров")
        {
            for line in o.stdout_str().lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 && parts[0].len() == 3 {
                    caps.filters.insert(parts[1].to_string());
                }
            }
        }
        let mut c = self.ffmpeg_cmd();
        c.args(["-h", "filter=drawtext"]);
        if let Ok(o) = run_with_timeout(c, Duration::from_secs(30), "drawtext") {
            caps.drawtext_align = o.stdout_str().contains("text_align");
        }
        let mut c = self.ffmpeg_cmd();
        c.arg("-encoders");
        if let Ok(o) = run_with_timeout(c, Duration::from_secs(30), "список кодировщиков")
        {
            for line in o.stdout_str().lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 && parts[0].len() == 6 {
                    caps.encoders.insert(parts[1].to_string());
                }
            }
        }
        *self.caps.lock().unwrap() = Some(caps.clone());
        caps
    }
}
