//! Построение команды ffmpeg (чистая функция — полностью покрыта тестами).
//!
//! Принципы, закрывающие ошибки прошлой версии:
//! * каждый клип приводится к целевому размеру/частоте ДО склейки (разные разрешения не ломают сборку);
//! * каждый сегмент обрезается/дополняется до точной длительности (xfade не «съезжает»);
//! * тексты передаются через файлы (`textfile=`, `expansion=none`), файлы лежат в рабочей папке,
//!   ffmpeg запускается с этой папкой как текущей — никакого экранирования путей и символов;
//! * звук приводится к 48 кГц (loudnorm сам по себе поднимает частоту до 192 кГц);
//! * цветовые метки BT.709 (нет сдвига цвета на площадках);
//! * прогресс-бар через overlay с покадровым выражением (drawbox не анимируется по времени).
use crate::probe::MediaInfo;
use crate::project::{FitMode, Project, Speed, Target};
use crate::tools::Capabilities;
use crate::util::{strip_unrenderable, wrap_words};
use std::fmt::Write as _;
use std::path::PathBuf;

pub const COLOR_FILTERS: &[(&str, &str)] = &[
    ("none", ""),
    ("warm", "colortemperature=temperature=4800"),
    ("cool", "colortemperature=temperature=8000"),
    ("vivid", "eq=saturation=1.3:contrast=1.06"),
    (
        "cinema",
        "colorbalance=rs=0.05:bs=-0.05:rm=0.03:bm=-0.03,eq=contrast=1.07:saturation=1.05",
    ),
    ("sharp", "unsharp=5:5:0.8:5:5:0.0"),
];

/// Шумоподавление. hqdn3d — пространственно-временное: убирает «зерно» тёмной камеры;
/// временная часть умеренная, чтобы быстро движущаяся головка принтера не оставляла шлейф.
/// Без hqdn3d (LGPL-сборки) — адаптивное временное усреднение atadenoise.
pub fn denoise_filter(level: &str, caps: &Capabilities) -> Option<&'static str> {
    let hq = caps.has_filter("hqdn3d");
    match level {
        "light" if hq => Some("hqdn3d=3:2.5:3:2.5"),
        "strong" if hq => Some("hqdn3d=6:5:5:4"),
        "light" if caps.has_filter("atadenoise") => Some("atadenoise=s=5"),
        "strong" if caps.has_filter("atadenoise") => Some("atadenoise=s=9"),
        _ => None,
    }
}

/// Чёткость: CAS (Contrast Adaptive Sharpening, AMD FidelityFX) усиливает детали
/// по локальному контрасту — без ореолов и без усиления шума. Нет CAS — классический unsharp.
pub fn sharpen_filter(caps: &Capabilities) -> &'static str {
    if caps.has_filter("cas") {
        "cas=strength=0.6"
    } else {
        "unsharp=5:5:0.7:5:5:0.0"
    }
}

/// Ускорение, при котором читаем только ключевые кадры (часы исходника → минуты сборки).
pub const FAST_LONG_SPEED: f64 = 12.0;

#[derive(Debug, Clone)]
pub struct PreparedClip {
    pub info: MediaInfo,
    pub start: f64,
    /// Длительность после обрезки (в секундах исходника).
    pub dur: f64,
    /// Имя файла трансформаций стабилизации в рабочей папке.
    pub stab_file: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Texts {
    /// Строки плашки сверху вниз: (текст, акцентный цвет?).
    pub info_lines: Vec<(String, bool)>,
    pub hook: String,
    pub channel: String,
}

#[derive(Debug, Clone)]
pub enum WorkFile {
    Write { name: String, data: Vec<u8> },
    Copy { name: String, from: PathBuf },
}

#[derive(Debug, Clone)]
pub struct Plan {
    /// Всё, кроме параметров кодека и выходного файла.
    pub args: Vec<String>,
    pub files: Vec<WorkFile>,
    /// Длительность результата, сек.
    pub total: f64,
    pub speed: f64,
    pub fast_long: bool,
    pub warnings: Vec<String>,
}

pub struct PlanInput<'a> {
    pub project: &'a Project,
    pub clips: &'a [PreparedClip],
    pub photos: &'a [MediaInfo],
    /// (файл, старт трека в секундах)
    pub music: Option<(&'a MediaInfo, f64)>,
    pub watermark: Option<&'a MediaInfo>,
    /// Сетка битов относительно начала ролика.
    pub beats: Option<(f64, f64)>,
    pub texts: &'a Texts,
    pub font: Option<PathBuf>,
    pub caps: &'a Capabilities,
    pub target: &'a Target,
    pub fps: u32,
    /// Черновик: (макс. длительность, масштаб размера)
    pub draft: Option<(f64, f64)>,
    /// false — только видео (кадр предпросмотра).
    pub audio: bool,
    /// Готовая таблица LUT (.cube, сила уже учтена).
    pub lut: Option<String>,
    /// Слои текста, нарисованные интерфейсом (PNG во весь кадр). Если есть — drawtext не используется.
    pub overlay: Option<&'a OverlayImages>,
    /// «Чистый» кадр: без текста, лого, полосы прогресса (подложка живого предпросмотра).
    pub bare: bool,
}

/// PNG-слои во весь кадр формата: постоянный (плашка, ник) и хук (первые секунды).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct OverlayImages {
    pub static_png: Option<Vec<u8>>,
    pub hook_png: Option<Vec<u8>>,
}

fn f(v: f64) -> String {
    // всегда точка, без экспоненты
    let s = format!("{v:.4}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-0" {
        "0".into()
    } else {
        s.to_string()
    }
}

fn even(v: f64) -> u32 {
    (((v.round() as u32) / 2) * 2).max(2)
}

pub fn speed_factor(project: &Project, clips: &[PreparedClip]) -> f64 {
    let src: f64 = clips.iter().map(|c| c.dur).sum();
    match project.speed {
        Speed::None => 1.0,
        Speed::Factor { factor } => factor.max(0.1),
        // «уложить в N секунд» — это предел: короткий исходник не замедляем
        Speed::Target { seconds } => (src / seconds.max(1.0)).max(1.0),
    }
}

fn xfade_len(p: &Project, seg_d: &[f64]) -> f64 {
    if p.transition.kind == "none" || seg_d.len() < 2 {
        return 0.0;
    }
    let min_d = seg_d.iter().cloned().fold(f64::INFINITY, f64::min);
    let xd = p.transition.duration.min(min_d * 0.3);
    if xd < 0.1 {
        0.0
    } else {
        xd
    }
}

/// Ускорение с учётом переходов и фото: «уложить в N секунд» даёт ролик ровно N секунд.
pub fn resolve_speed(p: &Project, clips: &[PreparedClip], photo_sec: f64, n_photos: usize) -> f64 {
    let spd = speed_factor(p, clips);
    if let Speed::Target { seconds } = p.speed {
        let src: f64 = clips.iter().map(|c| c.dur).sum();
        let mut segs: Vec<f64> = clips.iter().map(|c| c.dur / spd).collect();
        segs.extend(std::iter::repeat_n(photo_sec, n_photos));
        let xd = xfade_len(p, &segs);
        let want =
            seconds - photo_sec * n_photos as f64 + xd * (segs.len().saturating_sub(1)) as f64;
        if want > 0.5 {
            return (src / want).max(1.0);
        }
    }
    spd
}

/// Входные параметры клипа. Одинаковы для прохода стабилизации и сборки — иначе кадры не совпадут.
pub fn clip_input_args(c: &PreparedClip, fast_long: bool) -> Vec<String> {
    let mut a = vec![];
    if c.start > 0.0 {
        a.extend(["-ss".into(), f(c.start)]);
    }
    if fast_long {
        a.extend(["-skip_frame".into(), "nokey".into()]);
    }
    a.extend(["-t".into(), f(c.dur.max(0.05))]);
    a.push("-i".into());
    a.push(c.info.path.to_string_lossy().into_owned());
    a
}

pub fn stab_detect_args(c: &PreparedClip, fast_long: bool, trf: &str) -> Vec<String> {
    let mut a = clip_input_args(c, fast_long);
    a.extend([
        "-an".into(),
        "-vf".into(),
        format!("vidstabdetect=shakiness=5:accuracy=9:result={trf}"),
        "-f".into(),
        "null".into(),
        "-".into(),
    ]);
    a
}

fn fit_chain(input: &str, out: &str, tag: &str, w: u32, h: u32, fit: FitMode, blur: f64) -> String {
    match fit {
        FitMode::Blur if blur > 0.0 => {
            // фон считаем в 1/4 размера — в разы быстрее, визуально то же самое
            let (bw, bh) = (even(w as f64 / 4.0), even(h as f64 / 4.0));
            format!(
                "[{input}]split=2[bg{tag}][fg{tag}];\
                 [bg{tag}]scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh},gblur=sigma={s},scale={w}:{h}[bgs{tag}];\
                 [fg{tag}]scale={w}:{h}:force_original_aspect_ratio=decrease:force_divisible_by=2[fgs{tag}];\
                 [bgs{tag}][fgs{tag}]overlay=(W-w)/2:(H-h)/2[{out}]",
                s = f((blur / 4.0).max(0.5))
            )
        }
        FitMode::Fill => format!("[{input}]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}[{out}]"),
        _ => format!(
            "[{input}]scale={w}:{h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black[{out}]"
        ),
    }
}

struct TextCtx<'a> {
    files: &'a mut Vec<WorkFile>,
    font: &'a str,
    align: bool,
    n: usize,
}

impl TextCtx<'_> {
    /// drawtext с текстом из файла; возвращает строку фильтра.
    fn draw(&mut self, text: &str, fs: u32, color: &str, y: &str, extra: &str) -> String {
        let name = format!("text{}.txt", self.n);
        self.n += 1;
        self.files.push(WorkFile::Write {
            name: name.clone(),
            data: text.as_bytes().to_vec(),
        });
        let bb = (fs as f64 * 0.35).round().max(6.0) as u32;
        let mut s = format!(
            "drawtext=fontfile={font}:textfile={name}:expansion=none:fontcolor={color}:fontsize={fs}:\
             line_spacing={ls}:x=(w-text_w)/2:y={y}:box=1:boxcolor=black@0.5:boxborderw={bb}:\
             shadowcolor=black@0.55:shadowx=2:shadowy=2",
            font = self.font,
            ls = (fs as f64 * 0.25).round() as u32
        );
        if self.align && text.contains('\n') {
            s.push_str(":text_align=C");
        }
        s.push_str(extra);
        s
    }
}

pub fn build_plan(inp: &PlanInput) -> Plan {
    let p = inp.project;
    let st = &p.style;
    let mut warnings = vec![];
    let mut files = vec![];
    let scale = inp.draft.map(|d| d.1).unwrap_or(1.0);
    let (w, h) = (
        even(inp.target.width as f64 * scale),
        even(inp.target.height as f64 * scale),
    );
    let fps = inp.fps;
    let n = inp.clips.len();
    let photo_sec = if inp.photos.is_empty() {
        0.0
    } else {
        p.style.photo_seconds
    };
    let n_photos = if photo_sec > 0.0 { inp.photos.len() } else { 0 };
    let spd = resolve_speed(p, inp.clips, photo_sec, n_photos);
    let fast_long = spd >= FAST_LONG_SPEED;
    let caps = inp.caps;

    // ---------- входы ----------
    let mut args: Vec<String> = vec![];
    for c in inp.clips {
        args.extend(clip_input_args(c, fast_long));
    }
    let photo_base = n;
    if photo_sec > 0.0 {
        for ph in inp.photos {
            args.extend([
                "-loop".into(),
                "1".into(),
                "-framerate".into(),
                fps.to_string(),
                "-t".into(),
                f(photo_sec + 1.0),
                "-i".into(),
            ]);
            args.push(ph.path.to_string_lossy().into_owned());
        }
    }
    let mut next = n + n_photos;
    let wm_idx = inp.watermark.map(|wm| {
        args.extend(["-i".into(), wm.path.to_string_lossy().into_owned()]);
        next += 1;
        next - 1
    });
    let music_idx = inp.music.filter(|_| inp.audio).map(|(m, _)| {
        args.extend([
            "-stream_loop".into(),
            "-1".into(),
            "-i".into(),
            m.path.to_string_lossy().into_owned(),
        ]);
        next += 1;
        next - 1
    });

    // ---------- длительности сегментов ----------
    let mut seg_d: Vec<f64> = inp.clips.iter().map(|c| c.dur / spd).collect();
    seg_d.extend(std::iter::repeat_n(photo_sec, n_photos));
    let kind = p.transition.kind.as_str();
    let xd = xfade_len(p, &seg_d);
    if kind != "none" && seg_d.len() > 1 && xd == 0.0 {
        warnings.push("Клипы слишком короткие для переходов — склеиваю без них.".into());
    }
    if let (Some(b), true) = (inp.beats, p.music.beat_sync && inp.draft.is_none()) {
        let k = n.min(seg_d.len());
        crate::beats::align_to_beats(&mut seg_d[..k], xd, b);
    }

    let mut fc = String::new();
    let hdr_ok = caps.has_filter("zscale") && caps.has_filter("tonemap");
    let mut hdr_warned = false;

    // ---------- клипы ----------
    for (i, c) in inp.clips.iter().enumerate() {
        let mut pre: Vec<String> = vec!["setpts=PTS-STARTPTS".into()];
        if let Some(trf) = &c.stab_file {
            pre.push(format!(
                "vidstabtransform=input={trf}:smoothing=20:optzoom=1:interpol=bicubic"
            ));
        }
        if c.info.is_hdr && p.timelapse.hdr_tonemap {
            if hdr_ok {
                pre.push("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv".into());
            } else if !hdr_warned {
                hdr_warned = true;
                warnings.push(
                    "HDR-видео: в этой сборке ffmpeg нет zscale — цвета могут быть блёклыми."
                        .into(),
                );
            }
        }
        pre.push("format=yuv420p".into());
        if p.timelapse.deflicker {
            pre.push("deflicker=size=7:mode=pm".into());
        }
        if p.timelapse.frame_blend && !fast_long && spd >= 1.5 && inp.draft.is_none() {
            let k = (spd.round() as u32).clamp(2, 8);
            pre.push(format!("tmix=frames={k}"));
        }
        if (spd - 1.0).abs() > 1e-6 {
            pre.push(format!("setpts=PTS/{}", f(spd)));
        }
        pre.push(format!("fps={fps}"));
        let _ = write!(fc, "[{i}:v]{}[p{i}];", pre.join(","));
        fc.push_str(&fit_chain(
            &format!("p{i}"),
            &format!("f{i}"),
            &format!("c{i}"),
            w,
            h,
            st.fit,
            st.blur_sigma,
        ));
        let _ = write!(
            fc,
            ";[f{i}]setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=1,trim=duration={},setpts=PTS-STARTPTS,settb=AVTB[s{i}];",
            f(seg_d[i])
        );
    }

    // ---------- фото в конце ----------
    for k in 0..n_photos {
        let idx = photo_base + k;
        let si = n + k;
        let _ = write!(fc, "[{idx}:v]format=yuv420p,fps={fps}[p{si}];");
        fc.push_str(&fit_chain(
            &format!("p{si}"),
            &format!("f{si}"),
            &format!("c{si}"),
            w,
            h,
            st.fit,
            st.blur_sigma,
        ));
        let frames = (photo_sec * fps as f64).round().max(1.0);
        let zoom = if st.photo_zoom && inp.draft.is_none() {
            format!(",scale={sw}:{sh},zoompan=z='1+0.08*on/{frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={w}x{h}:fps={fps}", sw = w * 2, sh = h * 2)
        } else {
            String::new()
        };
        let _ = write!(
            fc,
            ";[f{si}]setsar=1{zoom},setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=1,trim=duration={},setpts=PTS-STARTPTS,settb=AVTB[s{si}];",
            f(seg_d[si])
        );
    }

    // ---------- склейка ----------
    let segs = seg_d.len();
    let total_video: f64 = seg_d.iter().sum::<f64>() - xd * (segs.saturating_sub(1)) as f64;
    if segs == 1 {
        fc.push_str("[s0]null[vcat];");
    } else if xd > 0.0 {
        let mut prev = "s0".to_string();
        let mut offset = 0.0;
        for i in 1..segs {
            offset += seg_d[i - 1] - xd;
            let out = if i == segs - 1 {
                "vcat".to_string()
            } else {
                format!("x{i}")
            };
            let _ = write!(
                fc,
                "[{prev}][s{i}]xfade=transition={kind}:duration={}:offset={}[{out}];",
                f(xd),
                f(offset)
            );
            prev = out;
        }
    } else {
        for i in 0..segs {
            let _ = write!(fc, "[s{i}]");
        }
        let _ = write!(fc, "concat=n={segs}:v=1:a=0[vcat];");
    }
    let mut total = total_video;
    if let Some((max, _)) = inp.draft {
        total = total.min(max);
    }

    // ---------- оформление ----------
    let mut cur = "vcat".to_string();
    let mut step = 0;
    let mut chain = |fc: &mut String, filt: &str, cur: &mut String| {
        step += 1;
        let out = format!("g{step}");
        let _ = write!(fc, "[{cur}]{filt}[{out}];");
        *cur = out;
    };
    // картинка: шумоподавление → автокоррекция → образ (LUT) → чёткость
    match denoise_filter(&st.denoise, caps) {
        Some(dn) => chain(&mut fc, dn, &mut cur),
        None if st.denoise != "off" => {
            warnings.push("В этой сборке ffmpeg нет шумоподавления — пропускаю.".into())
        }
        None => {}
    }
    if st.auto_color && caps.has_filter("normalize") {
        chain(
            &mut fc,
            "normalize=blackpt=black:whitept=white:smoothing=24:independence=0.5:strength=0.6",
            &mut cur,
        );
    }
    if let Some(cube) = &inp.lut {
        files.push(WorkFile::Write {
            name: "look.cube".into(),
            data: cube.as_bytes().to_vec(),
        });
        chain(
            &mut fc,
            "format=gbrp,lut3d=file=look.cube:interp=tetrahedral,format=yuv420p",
            &mut cur,
        );
    }
    if st.sharpen {
        chain(&mut fc, sharpen_filter(caps), &mut cur);
    }

    // слои текста от интерфейса (точно как в предпросмотре, с эмодзи и любыми шрифтами)
    if let (Some(ov), false) = (inp.overlay, inp.bare) {
        if let Some(png) = &ov.static_png {
            files.push(WorkFile::Write {
                name: "overlay_static.png".into(),
                data: png.clone(),
            });
            args.extend(
                [
                    "-loop",
                    "1",
                    "-framerate",
                    &fps.to_string(),
                    "-t",
                    &f(total + 1.0),
                    "-i",
                    "overlay_static.png",
                ]
                .iter()
                .map(|s| s.to_string()),
            );
            let idx = next;
            next += 1;
            let _ = write!(fc, "[{idx}:v]scale={w}:{h},format=rgba[ovs];");
            chain(
                &mut fc,
                "null[ovb];[ovb][ovs]overlay=0:0:format=auto",
                &mut cur,
            );
        }
        let hs = st.hook_seconds.min(total);
        if let (Some(png), true) = (&ov.hook_png, hs > 0.0) {
            files.push(WorkFile::Write {
                name: "overlay_hook.png".into(),
                data: png.clone(),
            });
            args.extend(
                [
                    "-loop",
                    "1",
                    "-framerate",
                    &fps.to_string(),
                    "-t",
                    &f(hs + 0.5),
                    "-i",
                    "overlay_hook.png",
                ]
                .iter()
                .map(|s| s.to_string()),
            );
            let idx = next;
            let _ = write!(
                fc,
                "[{idx}:v]scale={w}:{h},format=rgba,fade=t=out:st={st}:d=0.3:alpha=1[ovh];",
                st = f((hs - 0.3).max(0.0))
            );
            chain(
                &mut fc,
                &format!("null[ovhb];[ovhb][ovh]overlay=0:0:format=auto:eof_action=pass:enable='between(t,0,{})'", f(hs)),
                &mut cur,
            );
        }
    }

    let use_drawtext = inp.overlay.is_none() && !inp.bare;
    let font_name = inp.font.as_ref().filter(|_| use_drawtext).map(|fp| {
        let ext = fp
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("ttf")
            .to_ascii_lowercase();
        let name = format!("font.{ext}");
        files.push(WorkFile::Copy {
            name: name.clone(),
            from: fp.clone(),
        });
        name
    });
    let has_text = !inp.texts.info_lines.is_empty()
        || !inp.texts.hook.trim().is_empty()
        || !inp.texts.channel.trim().is_empty();
    if has_text && use_drawtext && font_name.is_none() {
        warnings.push("Не найден шрифт — текст на видео пропущен.".into());
    }
    if let Some(font) = &font_name {
        let mut tc = TextCtx {
            files: &mut files,
            font,
            align: caps.drawtext_align,
            n: 0,
        };
        let big = w.max(h) as f64;
        let vertical = h > w;
        let accent = format!("0x{}", st.accent_color);
        let clean = |s: &str, warnings: &mut Vec<String>| {
            let (c, removed) = strip_unrenderable(s);
            if removed {
                let m = "Эмодзи и спецсимволы в тексте на видео не поддерживаются шрифтом — они убраны.".to_string();
                if !warnings.contains(&m) {
                    warnings.push(m);
                }
            }
            c
        };

        // плашка с техинфой: сначала меряем блок, потом ставим так, чтобы он целиком влез в кадр
        if !inp.texts.info_lines.is_empty() {
            let mut pos = st.info_pos;
            if vertical && st.safe_zone {
                pos = pos.min(0.62); // ниже — подпись и кнопки TikTok/Reels
            }
            let gap = (h as f64 * 0.01).max(4.0);
            let mut items = vec![];
            let mut block_h = 0.0;
            for (k, (text, is_accent)) in inp.texts.info_lines.iter().enumerate() {
                let fs = (big * if k == 0 { 0.030 } else { 0.023 } * scale)
                    .round()
                    .max(10.0) as u32;
                let text = clean(text, &mut warnings);
                if text.is_empty() {
                    continue;
                }
                let max_chars = ((w as f64 * 0.84) / (fs as f64 * 0.56)).floor() as usize;
                let wrapped = wrap_words(&text, max_chars).join("\n");
                let lines = wrapped.lines().count().max(1) as f64;
                let bb = (fs as f64 * 0.35).round().max(6.0);
                let lh =
                    lines * fs as f64 * 1.2 + (lines - 1.0) * fs as f64 * 0.25 + bb * 2.0 + gap;
                block_h += lh;
                items.push((wrapped, fs, *is_accent, lh, bb));
            }
            let bottom_limit = h as f64 * if vertical && st.safe_zone { 0.80 } else { 0.96 };
            let mut y = (h as f64 * pos)
                .min(bottom_limit - block_h)
                .max(h as f64 * 0.05);
            for (wrapped, fs, is_accent, lh, bb) in items {
                let color = if is_accent { accent.as_str() } else { "white" };
                let d = tc.draw(&wrapped, fs, color, &f((y + bb).round()), "");
                chain(&mut fc, &d, &mut cur);
                y += lh;
            }
        }

        // ник канала
        let ch = clean(inp.texts.channel.trim(), &mut warnings);
        if !ch.is_empty() {
            let fs = ((big * 0.022) * scale).round().max(10.0) as u32;
            let y = if vertical && st.safe_zone {
                0.085
            } else {
                0.045
            };
            let d = tc.draw(&ch, fs, "white", &f((h as f64 * y).round()), "");
            chain(&mut fc, &d, &mut cur);
        }

        // хук в первые секунды
        let hook = clean(inp.texts.hook.trim(), &mut warnings);
        if !hook.is_empty() {
            let hs = st.hook_seconds;
            let mut fs = big * 0.045 * scale;
            let mut lines;
            loop {
                let max_chars = ((w as f64 * 0.86) / (fs * 0.56)).floor() as usize;
                lines = wrap_words(&hook, max_chars);
                if lines.len() <= 3 || fs <= big * 0.028 * scale {
                    break;
                }
                fs *= 0.9;
            }
            let fs = fs.round().max(12.0) as u32;
            let alpha = format!(
                ":alpha='if(lt(t,{a}),1,max(0,({b}-t)/0.3))':enable='between(t,0,{b})'",
                a = f((hs - 0.3).max(0.0)),
                b = f(hs)
            );
            let d = tc.draw(
                &lines.join("\n"),
                fs,
                "white",
                &format!("{}-text_h/2", f((h as f64 * 0.40).round())),
                &alpha,
            );
            chain(&mut fc, &d, &mut cur);
        }
    }

    // водяной знак
    if let Some(idx) = wm_idx {
        let ww = even((w as f64 * st.watermark_scale).max(24.0));
        let m = (w.min(h) as f64 * 0.04).round() as u32;
        let top = if h > w && st.safe_zone {
            (h as f64 * 0.075).round() as u32
        } else {
            m
        };
        let pos = match st.watermark_corner.as_str() {
            "tl" => format!("{m}:{top}"),
            "bl" => format!("{m}:H-h-{m}"),
            "br" => format!("W-w-{m}:H-h-{m}"),
            _ => format!("W-w-{m}:{top}"),
        };
        step += 1;
        let out = format!("g{step}");
        let _ = write!(
            fc,
            "[{idx}:v]scale={ww}:-2,format=rgba[wm];[{cur}][wm]overlay={pos}:format=auto[{out}];"
        );
        cur = out;
    }

    // прогресс-бар (overlay с покадровым x)
    if st.progress_bar && total > 0.0 && !inp.bare {
        let bh = ((h as f64 * 0.008).round() as u32).max(4);
        step += 1;
        let out = format!("g{step}");
        let _ = write!(
            fc,
            "color=c=0x{c}@0.95:s={w}x{bh}:r={fps}:d={d}[bar];[{cur}][bar]overlay=x='-W+W*t/{t}':y=H-{bh}:eval=frame:shortest=0:eof_action=pass[{out}];",
            c = st.accent_color,
            d = f(total + 1.0),
            t = f(total)
        );
        cur = out;
    }

    // бесшовный луп: начало ролика проявляется поверх концовки
    if st.seamless_loop && inp.draft.is_none() && !inp.bare {
        let d = (total * 0.3).min(0.6);
        if d > 0.05 {
            step += 1;
            let out = format!("g{step}");
            let _ = write!(
                fc,
                "[{cur}]split=2[la][lb];[lb]trim=0:{d},setpts=PTS-STARTPTS,format=yuva420p,fade=t=in:st=0:d={d}:alpha=1,setpts=PTS+({s})/TB[lh];[la][lh]overlay=eof_action=pass[{out}];",
                d = f(d),
                s = f(total - d)
            );
            cur = out;
        }
    }

    if inp.audio {
        // Метки BT.709 ставим на сами кадры (setparams): ffmpeg 7.1+ берёт цветовые свойства
        // энкодера из фильтров и игнорирует -colorspace, если кадры «unknown».
        let _ = write!(
            fc,
            "[{cur}]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1,\
             setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv[vout];"
        );
    } else {
        // кадр предпросмотра (PNG): полный диапазон RGB — без проблем с диапазоном у MJPEG
        let _ = write!(
            fc,
            "[{cur}]scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24,setsar=1[vout];"
        );
    }

    // ---------- звук ----------
    if inp.audio {
        match (inp.music, music_idx) {
            (Some((_, off)), Some(mi)) => {
                let m = &p.music;
                let mut a = vec![];
                if off > 0.0 {
                    a.push(format!("atrim=start={}", f(off)));
                }
                a.push("asetpts=PTS-STARTPTS".into());
                a.push(format!("volume={}", f(m.volume)));
                if m.loudnorm {
                    a.push("loudnorm=I=-14:TP=-1.5:LRA=11".into());
                }
                a.push("aresample=48000".into());
                a.push("aformat=sample_fmts=fltp:channel_layouts=stereo".into());
                if m.fade_in > 0.0 {
                    a.push(format!(
                        "afade=t=in:st=0:d={}",
                        f(m.fade_in.min(total / 3.0))
                    ));
                }
                if m.fade_out > 0.0 {
                    let fo = m.fade_out.min(total / 2.0);
                    a.push(format!(
                        "afade=t=out:st={}:d={}",
                        f((total - fo).max(0.0)),
                        f(fo)
                    ));
                }
                a.push(format!("atrim=duration={}", f(total)));
                let _ = write!(fc, "[{mi}:a]{}[aout]", a.join(","));
            }
            _ => {
                let _ = write!(
                    fc,
                    "anullsrc=r=48000:cl=stereo,atrim=duration={}[aout]",
                    f(total)
                );
            }
        }
    }
    let fc = fc.trim_end_matches(';').to_string();
    // Windows ограничивает командную строку 32 767 символами: длинный граф (десятки клипов)
    // передаём файлом в рабочей папке.
    if fc.len() > 6000 {
        files.push(WorkFile::Write {
            name: "graph.txt".into(),
            data: fc.into_bytes(),
        });
        args.extend(["-filter_complex_script".into(), "graph.txt".into()]);
    } else {
        args.extend(["-filter_complex".into(), fc]);
    }
    args.extend(["-map".into(), "[vout]".into()]);
    if inp.audio {
        args.extend(["-map".into(), "[aout]".into()]);
    }
    args.extend(["-t".into(), f(total)]);
    args.extend(["-r".into(), fps.to_string()]);
    if inp.audio {
        args.extend(
            [
                "-colorspace",
                "bt709",
                "-color_primaries",
                "bt709",
                "-color_trc",
                "bt709",
                "-color_range",
                "tv",
            ]
            .iter()
            .map(|s| s.to_string()),
        );
    }
    if inp.audio {
        args.extend(
            ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]
                .iter()
                .map(|s| s.to_string()),
        );
    }

    Plan {
        args,
        files,
        total,
        speed: spd,
        fast_long,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::MediaKind;

    fn info(path: &str, w: u32, h: u32, dur: f64) -> MediaInfo {
        MediaInfo {
            path: path.into(),
            kind: MediaKind::Video,
            duration: dur,
            width: w,
            height: h,
            fps: 30.0,
            has_video: true,
            has_audio: false,
            is_hdr: false,
            pix_fmt: "yuv420p".into(),
            codec: "h264".into(),
            size_bytes: 1,
        }
    }

    fn plan_with(p: &Project, texts: &Texts) -> Plan {
        let caps = Capabilities {
            drawtext_align: true,
            ..Default::default()
        };
        plan_with_caps(p, texts, &caps)
    }

    fn plan_with_caps(p: &Project, texts: &Texts, caps: &Capabilities) -> Plan {
        let clips = vec![
            PreparedClip {
                info: info("C:\\Видео\\a, b's [1].mp4", 1920, 1080, 10.0),
                start: 0.0,
                dur: 10.0,
                stab_file: None,
            },
            PreparedClip {
                info: info("b.mp4", 1080, 1920, 10.0),
                start: 2.0,
                dur: 6.0,
                stab_file: None,
            },
        ];
        let t = Target::vertical();
        build_plan(&PlanInput {
            project: p,
            clips: &clips,
            photos: &[],
            music: None,
            watermark: None,
            beats: None,
            texts,
            font: Some("C:\\Windows\\Fonts\\segoeuib.ttf".into()),
            caps,
            target: &t,
            fps: 30,
            draft: None,
            audio: true,
            lut: None,
            overlay: None,
            bare: false,
        })
    }

    fn filtergraph(plan: &Plan) -> &str {
        let i = plan
            .args
            .iter()
            .position(|a| a == "-filter_complex")
            .unwrap();
        &plan.args[i + 1]
    }

    #[test]
    fn denoise_and_cas_sharpen_order_and_fallbacks() {
        let mut p = Project::default();
        p.speed = Speed::None;
        p.style.denoise = "light".into();
        p.style.auto_color = true;
        p.style.sharpen = true;
        let mut caps = Capabilities {
            drawtext_align: true,
            ..Default::default()
        };
        for f in ["hqdn3d", "cas", "normalize", "atadenoise"] {
            caps.filters.insert(f.into());
        }
        let plan = plan_with_caps(&p, &Texts::default(), &caps);
        let fc = filtergraph(&plan);
        let (dn, nm, cs) = (
            fc.find("hqdn3d=3:2.5:3:2.5").expect(fc),
            fc.find("normalize=").expect(fc),
            fc.find("cas=strength=0.6").expect(fc),
        );
        // сначала чистим шум, потом цвет, резкость — последней (иначе усилили бы шум)
        assert!(dn < nm && nm < cs, "{fc}");
        assert!(!fc.contains("unsharp"), "{fc}");

        p.style.denoise = "strong".into();
        assert!(
            filtergraph(&plan_with_caps(&p, &Texts::default(), &caps)).contains("hqdn3d=6:5:5:4")
        );

        // LGPL-сборка без hqdn3d и cas
        caps.filters.remove("hqdn3d");
        caps.filters.remove("cas");
        let plan = plan_with_caps(&p, &Texts::default(), &caps);
        let fc = filtergraph(&plan);
        assert!(
            fc.contains("atadenoise=s=9") && fc.contains("unsharp=5:5:0.7"),
            "{fc}"
        );
        assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);

        // нет ни одного шумодава — предупреждение, сборка не падает
        caps.filters.remove("atadenoise");
        let plan = plan_with_caps(&p, &Texts::default(), &caps);
        assert!(!filtergraph(&plan).contains("denoise") && !filtergraph(&plan).contains("hqdn3d"));
        assert!(plan.warnings.iter().any(|w| w.contains("шумоподавления")));

        // выключено — ничего лишнего
        p.style.denoise = "off".into();
        p.style.sharpen = false;
        let fc = filtergraph(&plan_with_caps(&p, &Texts::default(), &caps)).to_string();
        assert!(!fc.contains("hqdn3d") && !fc.contains("atadenoise") && !fc.contains("cas="));
    }

    #[test]
    fn user_text_and_paths_never_enter_filtergraph() {
        let mut p = Project::default();
        p.speed = Speed::None;
        let texts = Texts {
            info_lines: vec![("Принтер: 100%, 'x' [y]; z\\w".into(), false)],
            hook: "Хук: 12,5 ч".into(),
            channel: "@ch".into(),
        };
        let plan = plan_with(&p, &texts);
        let fc = &plan.args[plan
            .args
            .iter()
            .position(|a| a == "-filter_complex")
            .unwrap()
            + 1];
        assert!(
            !fc.contains("Принтер") && !fc.contains("Хук") && !fc.contains("Fonts"),
            "{fc}"
        );
        assert!(
            fc.contains("textfile=text0.txt")
                && fc.contains("expansion=none")
                && fc.contains("fontfile=font.ttf")
        );
        // текст сохранён без искажений (запятые на месте)
        let t0 = plan.files.iter().find_map(|f| match f {
            WorkFile::Write { name, data } if name == "text0.txt" => {
                Some(String::from_utf8(data.clone()).unwrap())
            }
            _ => None,
        });
        assert_eq!(t0.unwrap(), "Принтер: 100%, 'x' [y]; z\\w");
        // путь с запятой/кавычкой — отдельный аргумент, а не часть графа
        assert!(plan.args.iter().any(|a| a == "C:\\Видео\\a, b's [1].mp4"));
    }

    #[test]
    fn every_clip_is_scaled_before_join() {
        let p = Project::default();
        let plan = plan_with(&p, &Texts::default());
        let fc = &plan.args[plan
            .args
            .iter()
            .position(|a| a == "-filter_complex")
            .unwrap()
            + 1];
        let join = fc.find("xfade").or_else(|| fc.find("concat")).unwrap();
        for i in 0..2 {
            let s = fc.find(&format!("[s{i}]")).unwrap();
            assert!(s < join);
        }
        assert!(fc.contains("aresample=48000") || fc.contains("anullsrc=r=48000"));
        assert!(fc.contains("out_color_matrix=bt709"));
    }

    #[test]
    fn target_seconds_is_exact_with_transitions() {
        let mut p = Project::default();
        p.speed = Speed::Target { seconds: 10.0 };
        p.transition.kind = "fade".into();
        let plan = plan_with(&p, &Texts::default());
        assert!((plan.total - 10.0).abs() < 1e-6, "{}", plan.total);
    }

    #[test]
    fn number_formatting_is_locale_free() {
        assert_eq!(f(1.5), "1.5");
        assert_eq!(f(2.0), "2");
        assert_eq!(f(0.00001), "0");
        assert_eq!(f(1e-12), "0");
    }
}
