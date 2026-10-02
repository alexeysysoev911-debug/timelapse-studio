use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tls_core::render::Cancel;
use tls_core::tools::Tools;

pub struct Dirs {
    pub data: PathBuf,
    pub cache: PathBuf,
    pub logs: PathBuf,
    pub videos: PathBuf,
    pub resources: PathBuf,
}

pub struct AppState {
    pub dirs: Dirs,
    pub tools: Mutex<Option<Result<Tools, String>>>,
    pub job: Mutex<Option<Cancel>>,
}

/// Настройки программы (не проекта).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// system / dark / light
    pub theme: String,
    pub out_dir: PathBuf,
    pub archive_dir: PathBuf,
    pub recent: Vec<PathBuf>,
    pub notify: bool,
    pub prevent_sleep: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "system".into(),
            out_dir: PathBuf::new(),
            archive_dir: PathBuf::new(),
            recent: vec![],
            notify: true,
            prevent_sleep: true,
        }
    }
}

impl AppState {
    pub fn init(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let p = app.path();
        let data = p.app_data_dir()?;
        let cache = p.app_cache_dir()?;
        let logs = p.app_log_dir()?;
        let videos = p
            .video_dir()
            .unwrap_or_else(|_| p.home_dir().unwrap_or_default())
            .join("Timelapse Studio");
        let resources = p.resource_dir().unwrap_or_default();
        for d in [&data, &cache, &logs] {
            std::fs::create_dir_all(d)?;
        }
        cleanup_cache(&cache);
        Ok(AppState {
            dirs: Dirs {
                data,
                cache,
                logs,
                videos,
                resources,
            },
            tools: Mutex::new(None),
            job: Mutex::new(None),
        })
    }

    /// ffmpeg: встроенный (ресурсы программы) → переменная TLS_FFMPEG_DIR → PATH.
    pub fn tools(&self) -> Result<Tools, String> {
        let mut g = self.tools.lock().unwrap();
        if let Some(Ok(t)) = g.as_ref() {
            return Ok(t.clone());
        }
        let bundled = self.dirs.resources.join("ffmpeg");
        let r = Tools::discover(Some(&bundled))
            .or_else(|_| match std::env::var_os("TLS_FFMPEG_DIR") {
                Some(d) => Tools::discover(Some(&PathBuf::from(d))),
                None => Tools::discover(None),
            })
            .map_err(|e| e.to_string());
        match &r {
            Ok(t) => tracing::info!(ffmpeg = %t.ffmpeg.display(), "ffmpeg найден"),
            Err(e) => tracing::error!(%e, "ffmpeg не найден"),
        }
        *g = Some(r.clone());
        r
    }

    pub fn settings_path(&self) -> PathBuf {
        self.dirs.data.join("settings.json")
    }

    pub fn settings(&self) -> Settings {
        std::fs::read(self.settings_path())
            .ok()
            .and_then(|d| serde_json::from_slice(&d).ok())
            .unwrap_or_default()
    }

    pub fn out_dir(&self) -> PathBuf {
        let s = self.settings();
        if s.out_dir.as_os_str().is_empty() {
            self.dirs.videos.clone()
        } else {
            s.out_dir
        }
    }
}

/// Кэш миниатюр/черновиков старше 14 дней удаляем; незавершённые сборки (build-*) — всегда.
fn cleanup_cache(cache: &std::path::Path) {
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(14 * 86400);
    let Ok(rd) = std::fs::read_dir(cache) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t < cutoff)
            .unwrap_or(false);
        if name.starts_with("build-") || name.starts_with("frame-") {
            let _ = std::fs::remove_dir_all(&p).or_else(|_| std::fs::remove_file(&p));
        } else if old {
            let _ = if p.is_dir() {
                std::fs::remove_dir_all(&p)
            } else {
                std::fs::remove_file(&p)
            };
        }
    }
    let _ = cache.join("thumbs").read_dir().map(|rd| {
        for e in rd.flatten() {
            if e.metadata()
                .and_then(|m| m.modified())
                .map(|t| t < cutoff)
                .unwrap_or(false)
            {
                let _ = std::fs::remove_file(e.path());
            }
        }
    });
}
