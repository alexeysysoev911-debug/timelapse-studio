//! Выбор видеокодировщика: GPU проверяется «боем» на кадре нормального размера.
use crate::project::{Codec, Export, Hardware, Quality};
use crate::tools::{run_with_timeout, Tools};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

static WORKS: LazyLock<Mutex<HashMap<String, bool>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Backend {
    Cpu,
    Nvenc,
    Qsv,
    Amf,
}

impl Backend {
    pub fn label(&self) -> &'static str {
        match self {
            Backend::Cpu => "Процессор",
            Backend::Nvenc => "NVIDIA NVENC",
            Backend::Qsv => "Intel Quick Sync",
            Backend::Amf => "AMD AMF",
        }
    }
}

pub fn encoder_name(b: Backend, codec: Codec) -> &'static str {
    match (b, codec) {
        (Backend::Cpu, Codec::H264) => "libx264",
        (Backend::Cpu, Codec::Hevc) => "libx265",
        (Backend::Nvenc, Codec::H264) => "h264_nvenc",
        (Backend::Nvenc, Codec::Hevc) => "hevc_nvenc",
        (Backend::Qsv, Codec::H264) => "h264_qsv",
        (Backend::Qsv, Codec::Hevc) => "hevc_qsv",
        (Backend::Amf, Codec::H264) => "h264_amf",
        (Backend::Amf, Codec::Hevc) => "hevc_amf",
    }
}

/// Реально ли работает кодировщик. Тест — 256x256: у NVENC есть минимальный размер кадра,
/// на 64x64 он падает даже на исправной карте (ошибка прошлой версии).
pub fn encoder_works(tools: &Tools, name: &str) -> bool {
    if let Some(v) = WORKS.lock().unwrap().get(name) {
        return *v;
    }
    let ok = tools.capabilities().encoders.contains(name) && {
        let mut c = tools.ffmpeg_cmd();
        c.args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=256x256:rate=30:duration=0.5",
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            name,
            "-f",
            "null",
            "-",
        ]);
        run_with_timeout(c, Duration::from_secs(40), "проверка кодировщика")
            .map(|o| o.ok())
            .unwrap_or(false)
    };
    WORKS.lock().unwrap().insert(name.to_string(), ok);
    ok
}

pub fn pick_backend(tools: &Tools, ex: &Export) -> Backend {
    let want = match ex.hardware {
        Hardware::Cpu => return Backend::Cpu,
        Hardware::Nvenc => vec![Backend::Nvenc],
        Hardware::Qsv => vec![Backend::Qsv],
        Hardware::Amf => vec![Backend::Amf],
        Hardware::Auto => vec![Backend::Nvenc, Backend::Qsv, Backend::Amf],
    };
    want.into_iter()
        .find(|b| encoder_works(tools, encoder_name(*b, ex.codec)))
        .unwrap_or(Backend::Cpu)
}

/// Аргументы кодирования видео (без входов/фильтров).
pub fn video_args(b: Backend, ex: &Export, draft: bool) -> Vec<String> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    if draft {
        return s(&[
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "30",
            "-pix_fmt",
            "yuv420p",
        ]);
    }
    let q = ex.quality;
    let pick = |h: &'static str, m: &'static str, l: &'static str| match q {
        Quality::High => h,
        Quality::Balanced => m,
        Quality::Small => l,
    };
    let name = encoder_name(b, ex.codec);
    let mut a = s(&["-c:v", name]);
    match b {
        Backend::Cpu => {
            let crf = match ex.codec {
                Codec::H264 => pick("18", "21", "25"),
                Codec::Hevc => pick("20", "23", "27"),
            };
            a.extend(s(&["-preset", pick("slow", "medium", "fast"), "-crf", crf]));
            if ex.codec == Codec::H264 {
                a.extend(s(&["-profile:v", "high"]));
            } else {
                a.extend(s(&["-x265-params", "log-level=error"]));
            }
        }
        Backend::Nvenc => a.extend(s(&[
            "-preset",
            pick("p6", "p5", "p3"),
            "-tune",
            "hq",
            "-rc",
            "vbr",
            "-cq",
            pick("19", "23", "28"),
            "-b:v",
            "0",
        ])),
        Backend::Qsv => a.extend(s(&[
            "-preset",
            pick("slow", "medium", "faster"),
            "-global_quality",
            pick("19", "23", "28"),
        ])),
        Backend::Amf => a.extend(s(&[
            "-quality",
            pick("quality", "balanced", "speed"),
            "-rc",
            "cqp",
            "-qp_i",
            pick("18", "22", "27"),
            "-qp_p",
            pick("20", "24", "29"),
        ])),
    }
    if ex.codec == Codec::Hevc {
        a.extend(s(&["-tag:v", "hvc1"]));
    }
    // ключевой кадр раз в 2 с — быстрая перемотка, нормальная работа площадок
    let gop = (ex.fps * 2).to_string();
    a.extend(s(&["-g", &gop, "-pix_fmt", "yuv420p"]));
    a
}
