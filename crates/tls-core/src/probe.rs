//! Анализ медиафайлов через ffprobe (JSON) + проверка реального декодирования.
use crate::error::{Error, Result};
use crate::tools::{run_with_timeout, Tools};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const VIDEO_EXT: &[&str] = &[
    "mp4", "mov", "mkv", "avi", "m4v", "webm", "ts", "mts", "m2ts", "wmv", "flv", "3gp",
];
pub const AUDIO_EXT: &[&str] = &["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma"];
pub const IMAGE_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Video,
    Audio,
    Image,
    Unknown,
}

pub fn kind_by_ext(p: &Path) -> MediaKind {
    let e = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if VIDEO_EXT.contains(&e.as_str()) {
        MediaKind::Video
    } else if AUDIO_EXT.contains(&e.as_str()) {
        MediaKind::Audio
    } else if IMAGE_EXT.contains(&e.as_str()) {
        MediaKind::Image
    } else {
        MediaKind::Unknown
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MediaInfo {
    pub path: PathBuf,
    pub kind: MediaKind,
    /// Длительность, сек (0 для картинок).
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_video: bool,
    pub has_audio: bool,
    pub is_hdr: bool,
    pub pix_fmt: String,
    pub codec: String,
    pub size_bytes: u64,
}

#[derive(Deserialize)]
struct FfJson {
    #[serde(default)]
    streams: Vec<FfStream>,
    format: Option<FfFormat>,
}
#[derive(Deserialize)]
struct FfStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    pix_fmt: Option<String>,
    color_transfer: Option<String>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    duration: Option<String>,
    #[serde(default)]
    disposition: Option<serde_json::Value>,
}
#[derive(Deserialize)]
struct FfFormat {
    duration: Option<String>,
}

fn parse_rate(s: &Option<String>) -> f64 {
    let s = match s {
        Some(s) => s,
        None => return 0.0,
    };
    let mut it = s.split('/');
    let n: f64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
    let d: f64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(1.0);
    if d > 0.0 && n.is_finite() {
        n / d
    } else {
        0.0
    }
}

fn parse_f(s: &Option<String>) -> f64 {
    s.as_deref()
        .and_then(|x| x.trim().replace(',', ".").parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(0.0)
}

pub fn probe(tools: &Tools, path: &Path) -> Result<MediaInfo> {
    let unreadable = |reason: &str| Error::Unreadable {
        path: path.display().to_string(),
        reason: reason.to_string(),
    };
    let meta = std::fs::metadata(path).map_err(|_| unreadable("файл не найден"))?;
    if meta.len() == 0 {
        return Err(unreadable("пустой файл"));
    }
    let mut c = tools.ffprobe_cmd();
    c.args([
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
    ])
    .arg(path);
    let out = run_with_timeout(c, Duration::from_secs(45), "чтение свойств файла")?;
    if !out.ok() {
        return Err(unreadable("формат не распознан"));
    }
    let j: FfJson =
        serde_json::from_slice(&out.stdout).map_err(|_| unreadable("ответ ffprobe не разобран"))?;
    let by_ext = kind_by_ext(path);
    // обложки альбомов (attached_pic) — не видео
    let is_cover = |s: &FfStream| {
        s.disposition
            .as_ref()
            .and_then(|d| d.get("attached_pic"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            == 1
    };
    let v = j
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video") && !is_cover(s));
    let a = j
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("audio"));
    let mut info = MediaInfo {
        path: path.to_path_buf(),
        kind: by_ext,
        duration: j
            .format
            .as_ref()
            .map(|f| parse_f(&f.duration))
            .unwrap_or(0.0),
        width: v.and_then(|s| s.width).unwrap_or(0),
        height: v.and_then(|s| s.height).unwrap_or(0),
        fps: 0.0,
        has_video: v.is_some(),
        has_audio: a.is_some(),
        is_hdr: false,
        pix_fmt: v.and_then(|s| s.pix_fmt.clone()).unwrap_or_default(),
        codec: v
            .or(a)
            .and_then(|s| s.codec_name.clone())
            .unwrap_or_default(),
        size_bytes: meta.len(),
    };
    if let Some(v) = v {
        let mut fps = parse_rate(&v.avg_frame_rate);
        if !(1.0..=1000.0).contains(&fps) {
            fps = parse_rate(&v.r_frame_rate);
        }
        info.fps = if (1.0..=1000.0).contains(&fps) {
            fps
        } else {
            30.0
        };
        if info.duration <= 0.0 {
            info.duration = parse_f(&v.duration);
        }
        let tr = v.color_transfer.as_deref().unwrap_or("");
        info.is_hdr = tr == "smpte2084" || tr == "arib-std-b67";
    }
    if info.kind == MediaKind::Unknown {
        info.kind = if info.has_video && info.duration > 0.5 {
            MediaKind::Video
        } else if info.has_video {
            MediaKind::Image
        } else if info.has_audio {
            MediaKind::Audio
        } else {
            MediaKind::Unknown
        };
    }
    match info.kind {
        MediaKind::Video | MediaKind::Image if !info.has_video || info.width == 0 => {
            return Err(unreadable("нет видеопотока"))
        }
        MediaKind::Audio if !info.has_audio => return Err(unreadable("нет звуковой дорожки")),
        _ => {}
    }
    if info.kind == MediaKind::Image {
        info.duration = 0.0;
    }
    // Расширению доверять нельзя (3 байта в .png ffprobe тоже назовёт png) — проверяем декодирование.
    let stream = if info.kind == MediaKind::Audio {
        "a:0"
    } else {
        "v:0"
    };
    if !decodes(tools, path, stream) {
        return Err(unreadable("данные повреждены — кадры не декодируются"));
    }
    if info.kind == MediaKind::Video && info.duration <= 0.0 {
        info.duration = count_duration(tools, path, info.fps).unwrap_or(0.0);
        if info.duration <= 0.0 {
            return Err(unreadable("не удалось определить длительность"));
        }
    }
    Ok(info)
}

/// true, если первые кадры потока реально декодируются.
pub fn decodes(tools: &Tools, path: &Path, stream: &str) -> bool {
    let mut c = tools.ffmpeg_cmd();
    c.args(["-v", "error", "-xerror", "-i"]).arg(path).args([
        "-map",
        &format!("0:{stream}"),
        "-frames:v",
        "2",
        "-t",
        "1",
        "-f",
        "null",
        "-",
    ]);
    match run_with_timeout(c, Duration::from_secs(60), "проверка декодирования")
    {
        Ok(o) => o.ok(),
        Err(_) => false,
    }
}

fn count_duration(tools: &Tools, path: &Path, fps: f64) -> Option<f64> {
    let mut c = tools.ffprobe_cmd();
    c.args([
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-count_packets",
        "-show_entries",
        "stream=nb_read_packets",
        "-of",
        "csv=p=0",
    ])
    .arg(path);
    let o = run_with_timeout(c, Duration::from_secs(120), "подсчёт кадров").ok()?;
    let n: f64 = o.stdout_str().trim().parse().ok()?;
    if n > 0.0 && fps > 0.0 {
        Some(n / fps)
    } else {
        None
    }
}

/// Миниатюра кадра (jpg) — для интерфейса.
pub fn thumbnail(tools: &Tools, path: &Path, at: f64, width: u32, out: &Path) -> Result<()> {
    let mut c = tools.ffmpeg_cmd();
    c.args(["-v", "error", "-y"]);
    if at > 0.0 {
        c.args(["-ss", &format!("{at:.3}")]);
    }
    c.arg("-i")
        .arg(path)
        .args([
            "-frames:v",
            "1",
            "-vf",
            &format!("scale={width}:-2"),
            "-q:v",
            "4",
        ])
        .arg(out);
    let o = run_with_timeout(c, Duration::from_secs(60), "миниатюра")?;
    if o.ok() && out.is_file() {
        Ok(())
    } else {
        Err(Error::Unreadable {
            path: path.display().to_string(),
            reason: "не удалось получить кадр".into(),
        })
    }
}
