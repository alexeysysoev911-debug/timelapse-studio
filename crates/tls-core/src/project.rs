//! Модель проекта (сохраняется в .tlsproj как JSON со схемой версий).
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const SCHEMA_VERSION: u32 = 1;

/// Допустимые уровни шумоподавления.
pub const DENOISE_LEVELS: &[&str] = &["off", "light", "strong"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Project {
    pub schema: u32,
    /// Идентификатор в библиотеке проектов (пусто — ещё не сохранён в библиотеку).
    pub id: String,
    pub name: String,
    pub clips: Vec<Clip>,
    pub end_photos: Vec<PathBuf>,
    pub music: Music,
    pub speed: Speed,
    pub timelapse: TimelapseFx,
    pub transition: Transition,
    pub style: Style,
    pub info: Info,
    pub targets: Vec<Target>,
    pub export: Export,
    pub after: AfterAction,
}

impl Default for Project {
    fn default() -> Self {
        Project {
            schema: SCHEMA_VERSION,
            id: String::new(),
            name: "Новый проект".into(),
            clips: vec![],
            end_photos: vec![],
            music: Music::default(),
            speed: Speed::Target { seconds: 20.0 },
            timelapse: TimelapseFx::default(),
            transition: Transition::default(),
            style: Style::default(),
            info: Info::default(),
            targets: vec![Target::vertical(), Target::landscape()],
            export: Export::default(),
            after: AfterAction::Keep,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Clip {
    pub id: String,
    pub path: PathBuf,
    pub enabled: bool,
    /// Обрезка, сек от начала файла.
    pub trim_start: f64,
    /// Конец (сек от начала файла); None — до конца.
    pub trim_end: Option<f64>,
}

impl Default for Clip {
    fn default() -> Self {
        Clip {
            id: String::new(),
            path: PathBuf::new(),
            enabled: true,
            trim_start: 0.0,
            trim_end: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Music {
    /// Выбранные треки. Пусто — тишина. Несколько — берётся случайный.
    pub tracks: Vec<PathBuf>,
    /// Старт трека, сек; None — случайное место.
    pub offset: Option<f64>,
    pub volume: f64,
    pub loudnorm: bool,
    pub fade_in: f64,
    pub fade_out: f64,
    pub beat_sync: bool,
}

impl Default for Music {
    fn default() -> Self {
        Music {
            tracks: vec![],
            offset: Some(0.0),
            volume: 1.0,
            loudnorm: true,
            fade_in: 0.3,
            fade_out: 1.5,
            beat_sync: true,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum Speed {
    None,
    Factor { factor: f64 },
    Target { seconds: f64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct TimelapseFx {
    /// Убрать мерцание яркости (deflicker).
    pub deflicker: bool,
    /// Стабилизация (vidstab, двухпроходная).
    pub stabilize: bool,
    /// Смешивание кадров при ускорении — плавное движение вместо «рваного».
    pub frame_blend: bool,
    /// HDR (iPhone и т.п.) → SDR без «выцветания».
    pub hdr_tonemap: bool,
}

impl Default for TimelapseFx {
    fn default() -> Self {
        TimelapseFx {
            deflicker: false,
            stabilize: false,
            frame_blend: false,
            hdr_tonemap: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Transition {
    /// none / fade / dissolve / slideleft / slideup / wipeleft / circleopen / zoomin
    pub kind: String,
    pub duration: f64,
}

impl Default for Transition {
    fn default() -> Self {
        Transition {
            kind: "fade".into(),
            duration: 0.4,
        }
    }
}

pub const TRANSITIONS: &[&str] = &[
    "none",
    "fade",
    "dissolve",
    "slideleft",
    "slideup",
    "wipeleft",
    "circleopen",
    "zoomin",
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FitMode {
    /// Размытый фон из того же кадра.
    Blur,
    /// Обрезать по центру, заполнив кадр.
    Fill,
    /// Чёрные поля.
    Black,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Style {
    pub fit: FitMode,
    pub blur_sigma: f64,
    /// Устаревшее поле (версии до 3.1): переносится в `look` при загрузке.
    pub color_filter: String,
    /// Цветовой «образ» (LUT): none / vivid / warm_film / ... (см. looks::LOOKS)
    pub look: String,
    /// Сила образа 0..1.
    pub look_strength: f64,
    /// Автокоррекция уровней и баланса.
    pub auto_color: bool,
    /// Повышение чёткости (CAS — умная резкость без ореолов).
    pub sharpen: bool,
    /// Шумоподавление: off / light / strong.
    pub denoise: String,
    /// Шрифт плашки и ника (id встроенного шрифта).
    pub font_family: String,
    /// Шрифт хука.
    pub hook_font_family: String,
    pub info_overlay: bool,
    /// Положение плашки (0..1 высоты кадра — верх плашки).
    pub info_pos: f64,
    pub show_time: bool,
    pub hook_text: String,
    pub hook_seconds: f64,
    pub channel_text: String,
    pub watermark: Option<PathBuf>,
    /// tl / tr / bl / br
    pub watermark_corner: String,
    pub watermark_scale: f64,
    pub progress_bar: bool,
    pub seamless_loop: bool,
    pub safe_zone: bool,
    /// Плавный наезд камеры на финальное фото.
    pub photo_zoom: bool,
    pub photo_seconds: f64,
    /// Путь к шрифту; None — встроенный/системный.
    pub font: Option<PathBuf>,
    pub accent_color: String,
}

impl Default for Style {
    fn default() -> Self {
        Style {
            fit: FitMode::Blur,
            blur_sigma: 25.0,
            color_filter: "none".into(),
            look: "none".into(),
            look_strength: 1.0,
            auto_color: false,
            sharpen: false,
            denoise: "off".into(),
            font_family: "montserrat".into(),
            hook_font_family: "unbounded".into(),
            info_overlay: true,
            info_pos: 0.78,
            show_time: true,
            hook_text: String::new(),
            hook_seconds: 2.5,
            channel_text: String::new(),
            watermark: None,
            watermark_corner: "tr".into(),
            watermark_scale: 0.16,
            progress_bar: false,
            seamless_loop: false,
            safe_zone: true,
            photo_zoom: true,
            photo_seconds: 1.5,
            font: None,
            accent_color: "FFC857".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Info {
    /// 3dprint / craft / art / cooking / build / other
    pub profile: String,
    /// Модель принтера / название работы.
    pub title: String,
    /// Пусто — определить из имён файлов.
    pub material: String,
    pub layer: String,
}

impl Default for Info {
    fn default() -> Self {
        Info {
            profile: "3dprint".into(),
            title: String::new(),
            material: String::new(),
            layer: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Target {
    pub id: String,
    pub enabled: bool,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub out_dir: PathBuf,
}

impl Default for Target {
    fn default() -> Self {
        Target::vertical()
    }
}

impl Target {
    pub fn vertical() -> Self {
        Target {
            id: "vertical".into(),
            enabled: true,
            label: "TikTok / Reels / Shorts".into(),
            width: 1080,
            height: 1920,
            out_dir: PathBuf::new(),
        }
    }
    pub fn landscape() -> Self {
        Target {
            id: "landscape".into(),
            enabled: true,
            label: "Telegram / YouTube".into(),
            width: 1920,
            height: 1080,
            out_dir: PathBuf::new(),
        }
    }
    pub fn is_vertical(&self) -> bool {
        self.height > self.width
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Codec {
    H264,
    Hevc,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Quality {
    High,
    Balanced,
    Small,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Hardware {
    Auto,
    Cpu,
    Nvenc,
    Qsv,
    Amf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Export {
    pub codec: Codec,
    pub quality: Quality,
    pub fps: u32,
    pub hardware: Hardware,
    pub parallel: bool,
    pub cover: bool,
    pub description: bool,
}

impl Default for Export {
    fn default() -> Self {
        Export {
            codec: Codec::H264,
            quality: Quality::Balanced,
            fps: 30,
            hardware: Hardware::Auto,
            parallel: true,
            cover: true,
            description: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum AfterAction {
    Keep,
    Archive {
        dir: PathBuf,
    },
    /// В Корзину — не безвозвратно.
    Trash,
}

impl Project {
    /// Нормализация значений из любых (в т.ч. старых или повреждённых) проектов.
    pub fn sanitize(&mut self) {
        let clamp =
            |v: f64, lo: f64, hi: f64, def: f64| if v.is_finite() { v.clamp(lo, hi) } else { def };
        self.schema = SCHEMA_VERSION;
        self.music.volume = clamp(self.music.volume, 0.0, 3.0, 1.0);
        self.music.fade_in = clamp(self.music.fade_in, 0.0, 5.0, 0.3);
        self.music.fade_out = clamp(self.music.fade_out, 0.0, 10.0, 1.5);
        if let Some(o) = self.music.offset {
            self.music.offset = Some(clamp(o, 0.0, 36000.0, 0.0));
        }
        self.speed = match self.speed {
            Speed::Factor { factor } => Speed::Factor {
                factor: clamp(factor, 0.1, 10000.0, 1.0),
            },
            Speed::Target { seconds } => Speed::Target {
                seconds: clamp(seconds, 1.0, 3600.0, 20.0),
            },
            Speed::None => Speed::None,
        };
        if !TRANSITIONS.contains(&self.transition.kind.as_str()) {
            self.transition.kind = "fade".into();
        }
        self.transition.duration = clamp(self.transition.duration, 0.1, 2.0, 0.4);
        let s = &mut self.style;
        s.blur_sigma = clamp(s.blur_sigma, 0.0, 100.0, 25.0);
        s.info_pos = clamp(s.info_pos, 0.05, 0.95, 0.78);
        s.hook_seconds = clamp(s.hook_seconds, 0.5, 10.0, 2.5);
        s.watermark_scale = clamp(s.watermark_scale, 0.03, 0.6, 0.16);
        s.photo_seconds = clamp(s.photo_seconds, 0.0, 10.0, 1.5);
        if !["tl", "tr", "bl", "br"].contains(&s.watermark_corner.as_str()) {
            s.watermark_corner = "tr".into();
        }
        if !(s.accent_color.len() == 6 && s.accent_color.chars().all(|c| c.is_ascii_hexdigit())) {
            s.accent_color = "FFC857".into();
        }
        // перенос фильтров версий до 3.1 в LUT-образы
        match s.color_filter.as_str() {
            "warm" if s.look == "none" => s.look = "warm_film".into(),
            "cool" if s.look == "none" => s.look = "cool_tech".into(),
            "vivid" if s.look == "none" => s.look = "vivid".into(),
            "cinema" if s.look == "none" => s.look = "teal_orange".into(),
            "sharp" => s.sharpen = true,
            _ => {}
        }
        s.color_filter = "none".into();
        if !crate::looks::LOOKS.iter().any(|(k, _)| *k == s.look) {
            s.look = "none".into();
        }
        s.look_strength = clamp(s.look_strength, 0.0, 1.0, 1.0);
        if !DENOISE_LEVELS.contains(&s.denoise.as_str()) {
            s.denoise = "off".into();
        }
        for f in [&mut s.font_family, &mut s.hook_font_family] {
            if !crate::looks::FONTS.iter().any(|(k, _, _)| *k == f.as_str()) {
                *f = "montserrat".into();
            }
        }
        for c in &mut self.clips {
            c.trim_start = clamp(c.trim_start, 0.0, 1e7, 0.0);
            if let Some(e) = c.trim_end {
                c.trim_end = if e.is_finite() && e > c.trim_start {
                    Some(e)
                } else {
                    None
                };
            }
        }
        for t in &mut self.targets {
            // чётные размеры, разумные пределы
            t.width = (t.width.clamp(144, 4096) / 2) * 2;
            t.height = (t.height.clamp(144, 4096) / 2) * 2;
        }
        if ![24, 25, 30, 50, 60].contains(&self.export.fps) {
            self.export.fps = 30;
        }
    }

    pub fn load(path: &std::path::Path) -> crate::Result<Project> {
        let data = std::fs::read(path)?;
        let mut p: Project = serde_json::from_slice(&data)?;
        if p.schema > SCHEMA_VERSION {
            return Err(crate::Error::Invalid(
                "проект создан более новой версией программы".into(),
            ));
        }
        p.sanitize();
        Ok(p)
    }

    pub fn save(&self, path: &std::path::Path) -> crate::Result<()> {
        Ok(crate::util::atomic_write(
            path,
            &serde_json::to_vec_pretty(self)?,
        )?)
    }
}
