//! Полная сборка проекта: проверка входов → музыка/бит → стабилизация → рендер форматов →
//! обложки/описания → действие с исходниками (только если ВСЕ форматы собрались).
use crate::encoder::{pick_backend, video_args, Backend};
use crate::error::{Error, Result};
use crate::graph::{
    build_plan, speed_factor, stab_detect_args, PlanInput, PreparedClip, Texts, FAST_LONG_SPEED,
};
use crate::probe::{probe, MediaInfo};
use crate::project::{AfterAction, Project, Target};
use crate::render::{make_cover, render_plan, run_ffmpeg, Cancel};
use crate::tools::Tools;
use crate::util::{
    aspect_label, fmt_duration_ru, free_space, parse_duration_from_name, parse_specs,
    sanitize_filename, unique_path, ReservedPath,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Stage { text: String },
    Progress { value: f64 },
    Log { line: String },
    Warning { text: String },
}

#[derive(Debug, Clone, Default)]
pub struct BuildOptions {
    pub cache_dir: PathBuf,
    /// Папка по умолчанию, если у формата не задана своя.
    pub default_out_dir: PathBuf,
    pub font: Option<PathBuf>,
    /// Черновик: первые N секунд, половинное разрешение, только первый формат.
    pub draft_seconds: Option<f64>,
    /// Зерно случайности (выбор трека/места) — для воспроизводимости тестов.
    pub seed: Option<u64>,
    /// Встроенные ресурсы программы (музыка, LUT, шрифты).
    pub resources: crate::looks::Resources,
    /// Слои текста от интерфейса: id формата → PNG.
    pub overlays: std::collections::HashMap<String, crate::graph::OverlayImages>,
}

/// Шрифт: явно заданный → свой файл пользователя → встроенный выбранный → системный.
fn pick_font(opts: &BuildOptions, p: &Project) -> Option<PathBuf> {
    opts.font
        .clone()
        .filter(|f| f.is_file())
        .or_else(|| p.style.font.clone().filter(|f| f.is_file()))
        .or_else(|| opts.resources.font_file(&p.style.font_family))
        .or_else(find_system_font)
}

/// Таблица LUT выбранного образа с учётом силы.
fn lut_for(opts: &BuildOptions, p: &Project, warnings: &mut Vec<String>) -> Option<String> {
    if p.style.look == "none" || p.style.look_strength <= 0.001 {
        return None;
    }
    let Some(file) = opts.resources.lut_file(&p.style.look) else {
        warnings.push("Файл цветового образа не найден — собираю без него.".into());
        return None;
    };
    match std::fs::read_to_string(&file)
        .map_err(Error::from)
        .and_then(|src| crate::looks::blend_cube(&src, p.style.look_strength))
    {
        Ok(c) => Some(c),
        Err(e) => {
            warnings.push(format!("Цветовой образ не применён: {e}"));
            None
        }
    }
}

#[derive(Debug, Serialize)]
pub struct OutputResult {
    pub target_id: String,
    pub label: String,
    pub path: Option<PathBuf>,
    pub cover: Option<PathBuf>,
    pub description: Option<String>,
    pub error: Option<crate::Error>,
}

#[derive(Debug, Serialize)]
pub struct BuildReport {
    pub outputs: Vec<OutputResult>,
    pub warnings: Vec<String>,
    pub backend: Backend,
    pub duration: f64,
    pub speed: f64,
    pub music: Option<PathBuf>,
    pub after: Option<String>,
    pub all_ok: bool,
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

pub const PROFILE_TAGS: &[(&str, &str, &[&str])] = &[
    (
        "3dprint",
        "печати",
        &[
            "#3dprinting",
            "#3dprint",
            "#timelapse",
            "#3дпечать",
            "#3dprinter",
            "#diy",
        ],
    ),
    (
        "craft",
        "работы",
        &[
            "#рукоделие",
            "#handmade",
            "#diy",
            "#timelapse",
            "#творчество",
        ],
    ),
    (
        "art",
        "работы",
        &["#рисование", "#art", "#speedpaint", "#timelapse", "#арт"],
    ),
    (
        "cooking",
        "готовки",
        &[
            "#кулинария",
            "#рецепты",
            "#готовимдома",
            "#timelapse",
            "#food",
        ],
    ),
    (
        "build",
        "работ",
        &[
            "#стройка",
            "#ремонт",
            "#своимируками",
            "#timelapse",
            "#construction",
        ],
    ),
    (
        "other",
        "процесса",
        &["#timelapse", "#таймлапс", "#процесс"],
    ),
];

fn profile(p: &str) -> (&'static str, &'static [&'static str]) {
    let e = PROFILE_TAGS
        .iter()
        .find(|(k, _, _)| *k == p)
        .unwrap_or(&PROFILE_TAGS[0]);
    (e.1, e.2)
}

/// Текстовая информация ролика (используется и в превью, и в сборке).
#[derive(Debug, Clone, Serialize, Default)]
pub struct ClipInfoText {
    pub title: String,
    pub material: Option<String>,
    pub layer: Option<String>,
    pub specs: String,
    pub time: String,
}

pub fn info_text(project: &Project, clip_paths: &[&Path]) -> ClipInfoText {
    let i = &project.info;
    let (mut mat, mut layer) = (
        Some(i.material.trim().to_uppercase()).filter(|s| !s.is_empty()),
        Some(i.layer.trim().to_string()).filter(|s| !s.is_empty()),
    );
    // материал/слой — из первого клипа, где они есть в имени
    for p in clip_paths {
        let (m, l) = parse_specs(p);
        if mat.is_none() {
            mat = m;
        }
        if layer.is_none() {
            layer = l;
        }
    }
    let is3d = i.profile == "3dprint";
    let specs = match (&mat, &layer, is3d) {
        (Some(m), Some(l), true) => format!("{m} · слой {l} мм"),
        (Some(m), None, true) => m.clone(),
        _ => String::new(),
    };
    let secs: u64 = clip_paths.iter().map(|p| parse_duration_from_name(p)).sum();
    let time = if secs > 0 {
        format!("{} {}", fmt_duration_ru(secs), profile(&i.profile).0)
    } else {
        String::new()
    };
    ClipInfoText {
        title: i.title.trim().to_string(),
        material: if is3d { mat } else { None },
        layer,
        specs,
        time,
    }
}

pub fn texts_for(project: &Project, it: &ClipInfoText) -> Texts {
    let st = &project.style;
    let mut lines = vec![];
    if st.info_overlay {
        if !it.title.is_empty() {
            lines.push((it.title.clone(), false));
        }
        if !it.specs.is_empty() {
            lines.push((it.specs.clone(), true));
        }
        if st.show_time && !it.time.is_empty() {
            lines.push((it.time.clone(), false));
        }
    }
    let ch = st.channel_text.trim();
    let channel = if ch.is_empty() {
        String::new()
    } else if ch.starts_with('@') {
        ch.to_string()
    } else {
        format!("@{ch}")
    };
    Texts {
        info_lines: lines,
        hook: st.hook_text.clone(),
        channel,
    }
}

pub fn description(project: &Project, it: &ClipInfoText) -> String {
    let (_, tags) = profile(&project.info.profile);
    let mut out = vec![];
    let head = if !it.time.is_empty() {
        format!("⏱ {}", it.time)
    } else {
        String::new()
    };
    let title = it.title.clone();
    let first = match (head.is_empty(), title.is_empty()) {
        (false, false) if project.info.profile == "3dprint" => format!("{head} на {title}"),
        (false, false) => format!("{head} — {title}"),
        (false, true) => head,
        (true, false) => title,
        (true, true) => "Таймлапс".into(),
    };
    out.push(first);
    if !it.specs.is_empty() {
        out.push(format!("Материал: {}", it.specs));
    }
    let ch = project.style.channel_text.trim();
    if !ch.is_empty() {
        out.push(String::new());
        out.push(if ch.starts_with('@') {
            ch.to_string()
        } else {
            format!("@{ch}")
        });
    }
    let mut t: Vec<String> = tags.iter().map(|s| s.to_string()).collect();
    if let Some(m) = &it.material {
        t.push(format!(
            "#{}",
            m.to_lowercase().replace('+', "plus").replace('-', "")
        ));
    }
    if project.info.profile == "3dprint" {
        if let Some(brand) = it.title.split_whitespace().next() {
            let b: String = brand
                .chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>()
                .to_lowercase();
            if b.len() > 1 && !t.contains(&format!("#{b}")) {
                t.push(format!("#{b}"));
            }
        }
    }
    out.push(String::new());
    out.push(t.join(" "));
    out.join("\n")
}

/// Системный шрифт с кириллицей (если пользователь не выбрал свой и нет встроенного).
pub fn find_system_font() -> Option<PathBuf> {
    let c: &[&str] = if cfg!(windows) {
        &[
            r"C:\Windows\Fonts\segoeuib.ttf",
            r"C:\Windows\Fonts\arialbd.ttf",
            r"C:\Windows\Fonts\arial.ttf",
        ]
    } else if cfg!(target_os = "macos") {
        &[
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/Library/Fonts/Arial Bold.ttf",
        ]
    } else {
        &[
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        ]
    };
    c.iter().map(PathBuf::from).find(|p| p.is_file())
}

/// Проверка и подготовка клипов. Битые пропускаются с предупреждением.
pub fn prepare_clips(
    tools: &Tools,
    project: &Project,
    warn: &mut Vec<String>,
    cancel: &Cancel,
) -> Result<Vec<PreparedClip>> {
    let mut out = vec![];
    for c in project.clips.iter().filter(|c| c.enabled) {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let name = c
            .path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        match probe(tools, &c.path) {
            Ok(info) if info.kind == crate::probe::MediaKind::Video => {
                let end = c
                    .trim_end
                    .map(|e| e.min(info.duration))
                    .unwrap_or(info.duration);
                let dur = end - c.trim_start;
                if dur < 0.1 {
                    warn.push(format!(
                        "«{name}»: после обрезки ничего не осталось — пропускаю."
                    ));
                    continue;
                }
                out.push(PreparedClip {
                    info,
                    start: c.trim_start,
                    dur,
                    stab_file: None,
                });
            }
            Ok(_) => warn.push(format!("«{name}» — не видео, пропускаю.")),
            Err(e) => warn.push(format!("«{name}» пропущен: {e}")),
        }
    }
    if out.is_empty() {
        return Err(Error::NoClips);
    }
    Ok(out)
}

fn stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H-%M").to_string()
}

pub fn build(
    tools: &Tools,
    project: &Project,
    opts: &BuildOptions,
    cancel: &Cancel,
    on: &(dyn Fn(Event) + Sync),
) -> Result<BuildReport> {
    let mut project = project.clone();
    project.sanitize();
    let p = &project;
    let draft = opts.draft_seconds;
    let stage = |t: &str| {
        on(Event::Stage {
            text: t.to_string(),
        })
    };
    let mut warnings: Vec<String> = vec![];
    let mut rng = Rng(opts.seed.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(7)
            | 1
    }));

    let mut targets: Vec<Target> = p.targets.iter().filter(|t| t.enabled).cloned().collect();
    if targets.is_empty() {
        return Err(Error::NoTargets);
    }
    if draft.is_some() {
        targets.truncate(1);
    }

    stage("Проверка файлов");
    let mut clips = prepare_clips(tools, p, &mut warnings, cancel)?;
    let mut photos: Vec<MediaInfo> = vec![];
    for ph in &p.end_photos {
        match probe(tools, ph) {
            Ok(i) if i.has_video => photos.push(i),
            _ => warnings.push(format!(
                "Фото «{}» не читается — пропускаю.",
                ph.file_name().unwrap_or_default().to_string_lossy()
            )),
        }
    }
    let watermark = match &p.style.watermark {
        Some(wp) => match probe(tools, wp) {
            Ok(i) if i.has_video => Some(i),
            _ => {
                warnings.push("Файл водяного знака не читается — соберу без него.".into());
                None
            }
        },
        None => None,
    };

    // ---- музыка ----
    let spd = speed_factor(p, &clips);
    let est_total = clips.iter().map(|c| c.dur).sum::<f64>() / spd
        + p.style.photo_seconds * photos.len() as f64;
    let mut tracks = p.music.tracks.clone();
    for i in (1..tracks.len()).rev() {
        let j = (rng.next() % (i as u64 + 1)) as usize;
        tracks.swap(i, j);
    }
    let mut music: Option<(MediaInfo, f64)> = None;
    for t in &tracks {
        match probe(tools, &opts.resources.resolve(t)) {
            Ok(i) if i.has_audio && i.duration > 1.0 => {
                let off = match p.music.offset {
                    Some(o) if o < i.duration - 1.0 => o,
                    Some(_) => 0.0,
                    None => {
                        let room = i.duration - est_total - 2.0;
                        if room > 0.0 {
                            (rng.unit() * room * 10.0).round() / 10.0
                        } else {
                            0.0
                        }
                    }
                };
                music = Some((i, off));
                break;
            }
            _ => warnings.push(format!(
                "Трек «{}» не читается — беру другой.",
                t.file_name().unwrap_or_default().to_string_lossy()
            )),
        }
    }
    if music.is_none() && !p.music.tracks.is_empty() {
        warnings.push("Ни один трек не читается — ролик будет без музыки.".into());
    }
    let beats = match (
        &music,
        p.music.beat_sync && draft.is_none() && p.transition.kind != "none",
    ) {
        (Some((m, off)), true) => {
            stage("Анализ ритма музыки");
            crate::beats::detect(tools, &m.path, *off, 60.0).map(|(t0, per)| (t0 - off, per))
        }
        _ => None,
    };
    if let Some((_, per)) = beats {
        on(Event::Log {
            line: format!("Бит: ~{} BPM — переходы в такт", (60.0 / per).round()),
        });
    }

    // ---- тексты ----
    let paths: Vec<&Path> = clips.iter().map(|c| c.info.path.as_path()).collect();
    let it = info_text(p, &paths);
    let texts = texts_for(p, &it);
    let font = pick_font(opts, p);
    let lut = lut_for(opts, p, &mut warnings);

    // ---- место на диске ----
    if draft.is_none() {
        for t in &targets {
            let dir = out_dir(t, opts);
            let need = (est_total * 16.0 / 8.0 * 1.3) as u64 + 50; // ~16 Мбит/с + запас, МБ
            if let Some(free) = free_space(&dir) {
                let free_mb = free / 1_000_000;
                if free_mb < need {
                    return Err(Error::DiskSpace {
                        need_mb: need,
                        free_mb,
                    });
                }
            }
        }
    }

    std::fs::create_dir_all(&opts.cache_dir)?;
    let work = tempfile::Builder::new()
        .prefix("build-")
        .tempdir_in(&opts.cache_dir)?;

    // ---- стабилизация (проход 1) ----
    let fast_long = spd >= FAST_LONG_SPEED;
    if p.timelapse.stabilize && draft.is_none() {
        if tools.capabilities().has_filter("vidstabdetect") {
            let n = clips.len();
            for (i, c) in clips.iter_mut().enumerate() {
                stage(&format!("Стабилизация: анализ клипа {}/{}", i + 1, n));
                let trf = format!("stab{i}.trf");
                let args = stab_detect_args(c, fast_long, &trf);
                let prog = |v: f64| {
                    on(Event::Progress {
                        value: (i as f64 + v) / n as f64 * 0.3,
                    })
                };
                let log = |l: String| on(Event::Log { line: l });
                run_ffmpeg(tools, &args, work.path(), c.dur, cancel, &prog, &log)?;
                c.stab_file = Some(trf);
            }
        } else {
            warnings.push("В этой сборке ffmpeg нет стабилизации (vidstab) — пропускаю.".into());
        }
    }

    let backend = if draft.is_some() {
        Backend::Cpu
    } else {
        pick_backend(tools, &p.export)
    };
    on(Event::Log {
        line: format!("Кодирование: {}", backend.label()),
    });
    let base_prog = if p.timelapse.stabilize && draft.is_none() {
        0.3
    } else {
        0.0
    };

    let name_stem = {
        let mut s = it.title.clone();
        if let Some(m) = &it.material {
            s = format!("{s} {m}");
        }
        sanitize_filename(format!("{} {}", s.trim(), stamp()).trim())
    };

    for w in &warnings {
        on(Event::Warning { text: w.clone() });
    }

    // ---- рендер форматов ----
    let caps = tools.capabilities();
    let n_t = targets.len();
    let shares = Mutex::new(vec![0.0f64; n_t]);
    let plan_warnings = Mutex::new(Vec::<String>::new());
    let total_dur = Mutex::new(0.0f64);
    let render_one = |k: usize, t: &Target| -> Result<PathBuf> {
        let sub = work.path().join(format!("t{k}"));
        std::fs::create_dir_all(&sub)?;
        let plan = build_plan(&PlanInput {
            project: p,
            clips: &clips,
            photos: &photos,
            music: music.as_ref().map(|(m, o)| (m, *o)),
            watermark: watermark.as_ref(),
            beats,
            texts: &texts,
            font: font.clone(),
            caps: &caps,
            target: t,
            fps: p.export.fps,
            draft: draft.map(|d| (d, 0.5)),
            audio: true,
            lut: lut.clone(),
            overlay: opts.overlays.get(&t.id),
            bare: false,
        });
        // стабилизационные файлы лежат в общей рабочей папке — копируем в папку формата
        for c in &clips {
            if let Some(trf) = &c.stab_file {
                std::fs::copy(work.path().join(trf), sub.join(trf))?;
            }
        }
        {
            let mut pw = plan_warnings.lock().unwrap();
            for w in &plan.warnings {
                if !pw.contains(w) {
                    pw.push(w.clone());
                }
            }
            *total_dur.lock().unwrap() = plan.total;
        }
        // `_reserved` держит имя занятым до конца сборки этого формата.
        let (out, _reserved) = if draft.is_some() {
            (
                opts.cache_dir.join(format!("draft-{}.mp4", rng_name())),
                None,
            )
        } else {
            let dir = out_dir(t, opts);
            std::fs::create_dir_all(&dir)?;
            let suffix = if n_t > 1 {
                format!(" {}", aspect_label(t.width, t.height))
            } else {
                String::new()
            };
            let r = ReservedPath::new(&dir, &format!("{name_stem}{suffix}"), "mp4");
            (r.path.clone(), Some(r))
        };
        stage(&format!("Сборка: {}", t.label));
        on(Event::Log {
            line: format!(
                "→ {} ({}×{}, ускорение ×{:.1})",
                t.label, t.width, t.height, plan.speed
            ),
        });
        if plan.fast_long {
            on(Event::Log { line: "Большое ускорение: читаю только ключевые кадры — длинные видео собираются в разы быстрее".into() });
        }
        let codec = video_args(backend, &p.export, draft.is_some());
        let prog = |v: f64| {
            let mut s = shares.lock().unwrap();
            s[k] = v;
            let avg = s.iter().sum::<f64>() / n_t as f64;
            on(Event::Progress {
                value: base_prog + (1.0 - base_prog) * avg * 0.97,
            });
        };
        let log = |l: String| on(Event::Log { line: l });
        render_plan(tools, &plan, &codec, &sub, &out, cancel, &prog, &log)
    };

    let results: Vec<Result<PathBuf>> = if p.export.parallel && n_t > 1 && draft.is_none() {
        std::thread::scope(|s| {
            let hs: Vec<_> = targets
                .iter()
                .enumerate()
                .map(|(k, t)| s.spawn(move || render_one(k, t)))
                .collect();
            // паника в потоке = ошибка формата, а не «успех» (ошибка прошлой версии: исходники удалялись)
            hs.into_iter()
                .map(|h| {
                    h.join()
                        .unwrap_or_else(|_| Err(Error::Invalid("внутренняя ошибка рендера".into())))
                })
                .collect()
        })
    } else {
        let mut v = vec![];
        for (k, t) in targets.iter().enumerate() {
            if cancel.is_cancelled() {
                v.push(Err(Error::Cancelled));
                continue;
            }
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| render_one(k, t)))
                .unwrap_or_else(|_| Err(Error::Invalid("внутренняя ошибка рендера".into())));
            v.push(r);
        }
        v
    };
    for w in plan_warnings.into_inner().unwrap() {
        on(Event::Warning { text: w.clone() });
        warnings.push(w);
    }
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }

    // ---- обложки, описания ----
    stage("Завершение");
    let desc = description(p, &it);
    let mut outputs = vec![];
    for (t, r) in targets.iter().zip(results) {
        match r {
            Ok(path) => {
                let cover = if p.export.cover && draft.is_none() {
                    make_cover(tools, &path)
                        .map_err(|e| warnings.push(e.to_string()))
                        .ok()
                } else {
                    None
                };
                let description = if p.export.description && draft.is_none() {
                    let txt = path.with_extension("txt");
                    match crate::util::atomic_write(&txt, desc.as_bytes()) {
                        Ok(()) => Some(desc.clone()),
                        Err(e) => {
                            warnings.push(format!("Не удалось записать описание: {e}"));
                            None
                        }
                    }
                } else {
                    None
                };
                outputs.push(OutputResult {
                    target_id: t.id.clone(),
                    label: t.label.clone(),
                    path: Some(path),
                    cover,
                    description,
                    error: None,
                });
            }
            Err(e) => {
                on(Event::Log {
                    line: format!("✗ {}: {e}", t.label),
                });
                outputs.push(OutputResult {
                    target_id: t.id.clone(),
                    label: t.label.clone(),
                    path: None,
                    cover: None,
                    description: None,
                    error: Some(e),
                });
            }
        }
    }
    let all_ok = outputs
        .iter()
        .all(|o| o.error.is_none() && o.path.as_ref().is_some_and(|p| p.is_file()));

    // ---- исходники ----
    let mut after = None;
    if all_ok && draft.is_none() {
        let srcs: Vec<PathBuf> = clips.iter().map(|c| c.info.path.clone()).collect();
        match &p.after {
            AfterAction::Keep => {}
            AfterAction::Archive { dir } => 'arch: {
                let dest = dir.join(stamp());
                if let Err(e) = std::fs::create_dir_all(&dest) {
                    // ролики уже готовы — не превращаем успех в ошибку из-за папки архива
                    warnings.push(format!(
                        "Папка архива недоступна ({}): исходники оставлены на месте. {e}",
                        dir.display()
                    ));
                    break 'arch;
                }
                let mut moved = 0;
                for s in &srcs {
                    let name = s
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned();
                    let (stem, ext) = match name.rsplit_once('.') {
                        Some((a, b)) => (a.to_string(), b.to_string()),
                        None => (name.clone(), String::new()),
                    };
                    let target = unique_path(&dest, &stem, &ext);
                    if crate::util::rename_retry(s, &target).is_err() {
                        // другой диск — копируем и удаляем только после успешного копирования
                        if std::fs::copy(s, &target).is_ok()
                            && std::fs::metadata(&target).map(|m| m.len()).ok()
                                == std::fs::metadata(s).map(|m| m.len()).ok()
                        {
                            let _ = std::fs::remove_file(s);
                        } else {
                            warnings.push(format!("Не удалось перенести «{name}» в архив."));
                            continue;
                        }
                    }
                    moved += 1;
                }
                after = Some(format!(
                    "Исходники ({moved}) перенесены в архив: {}",
                    dest.display()
                ));
            }
            AfterAction::Trash => match trash::delete_all(&srcs) {
                Ok(()) => after = Some(format!("Исходники ({}) отправлены в Корзину", srcs.len())),
                Err(e) => warnings.push(format!("Не удалось отправить в Корзину: {e}")),
            },
        }
    } else if !all_ok && !matches!(p.after, AfterAction::Keep) && draft.is_none() {
        warnings.push("Не все форматы собрались — исходники оставлены на месте.".into());
    }
    on(Event::Progress { value: 1.0 });
    let duration = *total_dur.lock().unwrap();
    Ok(BuildReport {
        outputs,
        warnings,
        backend,
        duration,
        speed: spd,
        music: music.map(|m| m.0.path),
        after,
        all_ok,
    })
}

/// Удаляет старые файлы `prefix*suffix` в папке, оставляя `keep` самых новых.
fn prune_files(dir: &Path, prefix: &str, suffix: &str, keep: usize) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = rd
        .filter_map(|e| e.ok())
        .filter(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n.starts_with(prefix) && n.ends_with(suffix)
        })
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            m.is_file()
                .then(|| (m.modified().unwrap_or(std::time::UNIX_EPOCH), e.path()))
        })
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by_key(|f| std::cmp::Reverse(f.0));
    for (_, p) in files.into_iter().skip(keep) {
        let _ = std::fs::remove_file(p);
    }
}

fn rng_name() -> String {
    format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    )
}

fn out_dir(t: &Target, opts: &BuildOptions) -> PathBuf {
    if t.out_dir.as_os_str().is_empty() {
        opts.default_out_dir.clone()
    } else {
        t.out_dir.clone()
    }
}

/// Параметры кадра предпросмотра.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct PreviewOptions {
    /// Момент ролика, сек (по умолчанию — середина показа хука).
    pub at: Option<f64>,
    /// «Чистый» кадр без текста/лого/полосы — подложка живого предпросмотра.
    pub bare: bool,
    /// Подменить образ (например, "none" для сравнения «до»).
    pub look_override: Option<String>,
    /// Масштаб относительно размера формата (по умолчанию 0.5).
    pub scale: Option<f64>,
}

/// Кадр будущего ролика (без музыки и стабилизации) — быстрый предпросмотр.
pub fn preview_frame(
    tools: &Tools,
    project: &Project,
    opts: &BuildOptions,
    target_id: &str,
    po: &PreviewOptions,
) -> Result<(PathBuf, Vec<String>)> {
    let mut project = project.clone();
    project.sanitize();
    if let Some(l) = &po.look_override {
        project.style.look = l.clone();
    }
    let p = &project;
    let target = p
        .targets
        .iter()
        .find(|t| t.id == target_id)
        .or_else(|| p.targets.first())
        .cloned()
        .ok_or(Error::NoTargets)?;
    let mut warnings = vec![];
    let cancel = Cancel::new();
    let clips = prepare_clips(tools, p, &mut warnings, &cancel)?;
    let photos: Vec<MediaInfo> = p
        .end_photos
        .iter()
        .filter_map(|ph| probe(tools, ph).ok())
        .collect();
    let watermark = if po.bare {
        None
    } else {
        p.style
            .watermark
            .as_ref()
            .and_then(|w| probe(tools, w).ok())
    };
    let paths: Vec<&Path> = clips.iter().map(|c| c.info.path.as_path()).collect();
    let it = info_text(p, &paths);
    let texts = if po.bare {
        Texts::default()
    } else {
        texts_for(p, &it)
    };
    let font = pick_font(opts, p);
    let lut = lut_for(opts, p, &mut warnings);
    let caps = tools.capabilities();
    let mut pp = p.clone();
    pp.style.photo_zoom = false;
    let plan = build_plan(&PlanInput {
        project: &pp,
        clips: &clips,
        photos: &photos,
        music: None,
        watermark: watermark.as_ref(),
        beats: None,
        texts: &texts,
        font,
        caps: &caps,
        target: &target,
        fps: p.export.fps,
        draft: Some((f64::MAX, po.scale.unwrap_or(0.5).clamp(0.1, 1.0))),
        audio: false,
        lut,
        overlay: if po.bare {
            None
        } else {
            opts.overlays.get(&target.id)
        },
        bare: po.bare,
    });
    warnings.extend(plan.warnings.iter().cloned());
    std::fs::create_dir_all(&opts.cache_dir)?;
    let work = tempfile::Builder::new()
        .prefix("frame-")
        .tempdir_in(&opts.cache_dir)?;
    crate::render::materialize(&plan.files, work.path())?;
    let t = po
        .at
        .unwrap_or_else(|| (p.style.hook_seconds * 0.5).min(plan.total * 0.3))
        .clamp(0.0, (plan.total - 0.05).max(0.0));
    prune_files(&opts.cache_dir, "frame-", ".png", 16);
    let out = opts.cache_dir.join(format!("frame-{}.png", rng_name()));
    let mut args = plan.args.clone();
    args.extend([
        "-ss".into(),
        format!("{t:.3}"),
        "-frames:v".into(),
        "1".into(),
        "-update".into(),
        "1".into(),
    ]);
    args.push(out.to_string_lossy().into_owned());
    run_ffmpeg(tools, &args, work.path(), 0.0, &cancel, &|_| {}, &|_| {})?;
    if !out.is_file() {
        return Err(Error::Ffmpeg {
            summary: "Не удалось отрисовать кадр".into(),
            log: vec![],
        });
    }
    Ok((out, warnings))
}

/// Миниатюры всех образов на одном кадре (для выбора фильтра «как в Instagram»).
pub fn look_thumbnails(
    tools: &Tools,
    base: &Path,
    res: &crate::looks::Resources,
    out_dir: &Path,
    width: u32,
) -> Result<Vec<(String, PathBuf)>> {
    std::fs::create_dir_all(out_dir)?;
    // предыдущие наборы миниатюр больше не нужны интерфейсу (держим 2 набора)
    prune_files(out_dir, "", ".png", crate::looks::LOOKS.len() * 2);
    let stem = base
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("frame")
        .to_string();
    let mut out = vec![];
    for (id, _) in crate::looks::LOOKS {
        let dst = out_dir.join(format!("{stem}-{id}.png"));
        if !dst.is_file() {
            let mut c = tools.ffmpeg_cmd();
            c.args(["-v", "error", "-y", "-i"]).arg(base);
            let vf = match res.lut_file(id) {
                Some(f) => {
                    // файл LUT по имени, ffmpeg запускается в папке LUT — без экранирования путей
                    c.current_dir(f.parent().unwrap_or(Path::new(".")));
                    format!(
                        "scale={width}:-2,format=gbrp,lut3d=file={}:interp=tetrahedral",
                        f.file_name().unwrap_or_default().to_string_lossy()
                    )
                }
                None => format!("scale={width}:-2"),
            };
            c.args(["-vf", &vf, "-frames:v", "1", "-update", "1"])
                .arg(&dst);
            let o = crate::tools::run_with_timeout(
                c,
                std::time::Duration::from_secs(30),
                "миниатюра образа",
            )?;
            if !o.ok() {
                continue;
            }
        }
        out.push((id.to_string(), dst));
    }
    Ok(out)
}
